// Workspace recovery adapter (P2 M1.5/M1.6).
//
// Restores the workspace unit's metadata AFTER the action-level compensation:
// durable order, entities (registration/title), visible members, archive and
// pin sets. Every field is compensated with a THREE-WAY rule — snapshot
// (before) / afterBatch (the state our own batch left) / current:
//
//   restore only when current === afterBatch AND snapshot !== afterBatch
//
// i.e. only changes that are provably OUR batch's, still exactly as we left
// them. A user edit after our batch (current !== afterBatch) is preserved and
// reported as `pending`, never overwritten. Registration re-creation goes
// through registry.create(path, title) (the real path), and every mutation
// goes through the registry's own methods — the active JSON unit is never
// overwritten directly.
//
// Capability gap (recorded, not hidden): createdAt/updatedAt are stamped by
// the registry on mutation. A re-created registration or a renamed title gets
// a NEW updatedAt, and a re-created registration gets a new createdAt; those
// fields cannot be restored through the public interface, so the result
// carries `capabilityGaps` and equality excludes them explicitly.

import { readWorkspaceRegistryView } from './g6.js'

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

const setOf = arr => new Set(arr ?? [])
const has = (view, id) => view.workspaces.find(w => w.id === id)

/**
 * @param {object} params
 * @param {object} params.workspaceRegistry - target workspaceRegistry.
 * @param {object} params.snapshot - the G6 before-state (captured).
 * @param {object} params.afterBatch - registry view right after OUR batch.
 * @param {boolean} [params.dryRun] - compute the plan without mutating.
 * @returns {Promise<{ outcome: 'complete'|'pending'|'failed', changed: string[],
 *   pending: object[], failures: string[], capabilityGaps: string[],
 *   verification: { ok: boolean, diffs: string[] } }>}
 */
export async function restoreWorkspaceUnit({ workspaceRegistry, snapshot, afterBatch, dryRun = false }) {
  if (!workspaceRegistry) throw coded('WORKSPACE_RECOVERY_INVALID', 'a workspace registry is required')
  if (!snapshot?.workspaces || !afterBatch?.workspaces) throw coded('WORKSPACE_RECOVERY_INVALID', 'snapshot and afterBatch views are required')
  const changed = []
  const pending = []
  const failures = []
  const recreated = new Map() // snapshot id -> new durable id
  const capabilityGaps = [
    'createdAt/updatedAt are registry-stamped and cannot be restored through the public interface',
  ]
  const currentBefore = readWorkspaceRegistryView(workspaceRegistry)
  const current = currentBefore
  const snapById = new Map(snapshot.workspaces.map(w => [w.id, w]))
  const afterById = new Map(afterBatch.workspaces.map(w => [w.id, w]))
  const curById = new Map(current.workspaces.map(w => [w.id, w]))

  // --- 1) registrations: recreate ours that were deleted, delete ours that
  // were created, preserve anything the user changed.
  for (const [id, before] of snapById) {
    if (curById.has(id)) continue
    // Present in the snapshot, absent now, and our after-state also lacked
    // it → OUR deletion (current === after). A workspace that reappeared
    // after our batch (current present) is handled by the loop below.
    if (afterById.has(id)) {
      pending.push({ field: 'registration', workspaceId: id, reason: 'workspace disappeared after the batch — preserved' })
      continue
    }
    // Recreate through the real path. If the directory is gone, this cannot
    // be restored.
    if (dryRun) { changed.push(`registration:${id}:recreate`); continue }
    try {
      const w = await workspaceRegistry.create(before.path, before.title)
      if (w.id !== id) {
        // The public registry assigns a NEW durable id on re-creation; the
        // content is restored but the identity cannot be. Recorded as a
        // capability gap and a pending outcome — never passed off as a full
        // identity restore.
        recreated.set(id, w.id)
        capabilityGaps.push(`registration ${id} was re-created with a new durable id ${w.id} (registry assigns ids; the old id cannot be restored)`)
        pending.push({ field: 'registration-id', workspaceId: id, newWorkspaceId: w.id, reason: 're-created registration has a new durable id; content restored, identity differs' })
        changed.push(`registration:${id}:recreate:new-id`)
      } else {
        changed.push(`registration:${id}:recreate`)
      }
    } catch (error) {
      failures.push(`registration:${id}: ${error.message}`)
    }
  }
  for (const [id, cur] of curById) {
    if (snapById.has(id)) continue
    const after = afterById.get(id)
    if (!after) {
      pending.push({ field: 'registration', workspaceId: id, reason: 'workspace appeared outside this batch — preserved' })
      continue
    }
    // Full known after-state must match: title AND members. A user rename or
    // membership change after our create preserves the registration.
    if (cur.title !== after.title) {
      pending.push({ field: 'registration', workspaceId: id, reason: `new workspace title changed after the batch ("${after.title}" -> "${cur.title}") — preserved` })
      continue
    }
    if (JSON.stringify(cur.sessionIds) !== JSON.stringify(after.sessionIds)) {
      pending.push({ field: 'registration', workspaceId: id, reason: 'new workspace membership changed after the batch — preserved' })
      continue
    }
    if (dryRun) { changed.push(`registration:${id}:delete`); continue }
    try {
      await workspaceRegistry.delete(id)
      changed.push(`registration:${id}:delete`)
    } catch (error) {
      failures.push(`registration:${id}: ${error.message}`)
    }
  }

  // --- 2) per-entity title + visible members (three-way).
  for (const [id, before] of snapById) {
    const cur = workspaceRegistry.get(recreated.get(id) ?? id)
    const after = afterById.get(id)
    if (!cur) { failures.push(`entity:${id}: not present after recovery`); continue }
    if (!after) continue
    // Title: ours only if it still equals our after-state.
    if (cur.title !== after.title && before.title !== after.title) {
      pending.push({ field: 'title', workspaceId: id, reason: 'title changed after the batch — preserved' })
    } else if (cur.title === after.title && before.title !== after.title) {
      if (!dryRun) await cur.setTitle(before.title)
      changed.push(`title:${id}`)
    }
    // Members: every session in the before OR after visible sets. Restored
    // membership must also restore the snapshot's ORDER within the common
    // prefix (the registry exposes insertSessionBefore for hand ordering).
    const sessionUniverse = new Set([...before.sessionIds, ...after.sessionIds])
    for (const sid of sessionUniverse) {
      const snapHas = before.sessionIds.includes(sid)
      const afterHas = after.sessionIds.includes(sid)
      const curHas = cur.sessionIds.includes(sid)
      if (curHas !== afterHas) {
        pending.push({ field: 'member', workspaceId: id, sessionId: sid, reason: 'membership changed after the batch — preserved' })
        continue
      }
      if (snapHas === afterHas) continue
      if (snapHas && !curHas) {
        if (!dryRun) await cur.attachSession(sid)
        changed.push(`member:${id}:${sid}:attach`)
      } else if (!snapHas && curHas) {
        if (!dryRun) await cur.detachSession(sid)
        changed.push(`member:${id}:${sid}:detach`)
      }
    }
    // ORDER: after membership converges, restore the snapshot's relative
    // order for sessions present in both. The registry's sessionIds are
    // newest-first, so walking the snapshot order from the tail and inserting
    // each before the previous snapshot entry reproduces it.
    if (!dryRun) {
      const sharedBefore = before.sessionIds.filter(sid => cur.sessionIds.includes(sid))
      const needsOrder = sharedBefore.length > 1
        && sharedBefore.some((sid, i) => cur.sessionIds[i] !== sid)
      if (needsOrder) {
        for (let i = sharedBefore.length - 1; i >= 0; i--) {
          const sid = sharedBefore[i]
          const anchor = i + 1 < sharedBefore.length ? sharedBefore[i + 1] : undefined
          try {
            if (anchor !== undefined) await cur.insertSessionBefore(sid, anchor)
            else await cur.insertSessionBefore(sid, undefined)
          } catch (error) {
            failures.push(`member-order:${id}:${sid}: ${error.message}`)
          }
        }
        changed.push(`member-order:${id}`)
      }
    }
  }

  // --- 3) durable order (only when current order is exactly our after-order).
  // Compare against the PRE-RECOVERY order: our own registration re-creation
  // legitimately changes the order, but that change is ours.
  if (JSON.stringify(currentBefore.workspaceIds) === JSON.stringify(afterBatch.workspaceIds)
    && JSON.stringify(currentBefore.workspaceIds) !== JSON.stringify(snapshot.workspaceIds)) {
    const live = new Set(readWorkspaceRegistryView(workspaceRegistry).workspaceIds)
    const targetOrder = snapshot.workspaceIds.map(id => recreated.get(id) ?? id).filter(id => live.has(id))
    if (!dryRun) {
      // insertBefore walks the target order from the tail: each call makes
      // the id land immediately before the next one (or append at the end).
      for (let i = targetOrder.length - 1; i >= 0; i--) {
        const id = targetOrder[i]
        const before = i === targetOrder.length - 1 ? undefined : targetOrder[i + 1]
        await workspaceRegistry.insertBefore(id, before)
      }
    }
    changed.push('order')
  } else if (JSON.stringify(currentBefore.workspaceIds) !== JSON.stringify(snapshot.workspaceIds)) {
    pending.push({ field: 'order', reason: 'durable order changed after the batch — preserved' })
  }

  // --- 4) archive/pin sets, per session, restoring only our own flips.
  const archiveNow = setOf(readWorkspaceRegistryView(workspaceRegistry).archivedSessionIds)
  const pinNow = setOf(readWorkspaceRegistryView(workspaceRegistry).pinnedSessionIds)
  const archiveAfter = setOf(afterBatch.archivedSessionIds)
  const pinAfter = setOf(afterBatch.pinnedSessionIds)
  for (const sid of new Set([...snapshot.archivedSessionIds, ...archiveNow])) {
    const want = snapshot.archivedSessionIds.includes(sid)
    const aft = archiveAfter.has(sid)
    const cur = archiveNow.has(sid)
    if (cur !== aft) {
      pending.push({ field: 'archive', sessionId: sid, reason: 'archive state changed after the batch — preserved' })
      continue
    }
    if (want !== aft) {
      if (!dryRun) {
        if (want) await workspaceRegistry.archiveSession(sid)
        else await workspaceRegistry.unarchiveSession(sid)
      }
      changed.push(`archive:${sid}:${want}`)
    }
  }
  // Pins are restored AFTER archives (archive clears the pin in one write).
  const pinNow2 = setOf(readWorkspaceRegistryView(workspaceRegistry).pinnedSessionIds)
  for (const sid of new Set([...snapshot.pinnedSessionIds, ...pinNow2])) {
    const want = snapshot.pinnedSessionIds.includes(sid)
    const aft = pinAfter.has(sid)
    const cur = pinNow2.has(sid)
    if (cur !== aft) {
      pending.push({ field: 'pin', sessionId: sid, reason: 'pin state changed after the batch — preserved' })
      continue
    }
    if (want !== aft) {
      if (!dryRun) {
        if (want) await workspaceRegistry.pinSession(sid)
        else await workspaceRegistry.unpinSession(sid)
      }
      changed.push(`pin:${sid}:${want}`)
    }
  }

  const verification = dryRun ? { ok: true, diffs: [] } : verifyWorkspaceUnit({ workspaceRegistry, snapshot, idMap: recreated })
  const outcome = failures.length > 0 ? 'failed' : (pending.length > 0 || !verification.ok ? 'pending' : 'complete')
  return { outcome, changed, pending, failures, capabilityGaps, verification }
}

/**
 * Compare the CURRENT registry view against the snapshot's restorable fields
 * (createdAt/updatedAt deliberately excluded — see capabilityGaps).
 */
export function verifyWorkspaceUnit({ workspaceRegistry, snapshot, idMap = new Map() }) {
  const current = readWorkspaceRegistryView(workspaceRegistry)
  const diffs = []
  const expectedOrder = snapshot.workspaceIds.map(id => idMap.get(id) ?? id)
  if (JSON.stringify(current.workspaceIds) !== JSON.stringify(expectedOrder)) {
    diffs.push(`workspace order differs: ${JSON.stringify(expectedOrder)} -> ${JSON.stringify(current.workspaceIds)}`)
  }
  if (JSON.stringify([...current.archivedSessionIds].sort()) !== JSON.stringify([...snapshot.archivedSessionIds].sort())) {
    diffs.push('archive set differs')
  }
  if (JSON.stringify([...current.pinnedSessionIds].sort()) !== JSON.stringify([...snapshot.pinnedSessionIds].sort())) {
    diffs.push('pin set differs')
  }
  const byId = new Map(current.workspaces.map(w => [w.id, w]))
  for (const before of snapshot.workspaces) {
    const effId = idMap.get(before.id) ?? before.id
    const w = byId.get(effId)
    if (!w) { diffs.push(`workspace ${before.id} is missing`); continue }
    if (w.title !== before.title) diffs.push(`workspace ${before.id} title differs`)
    if (w.path !== before.path) diffs.push(`workspace ${before.id} path differs`)
    if (JSON.stringify(w.sessionIds) !== JSON.stringify(before.sessionIds)) {
      diffs.push(`workspace ${before.id} members differ (order included)`)
    }
  }
  return { ok: diffs.length === 0, diffs }
}
