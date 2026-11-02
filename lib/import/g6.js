// G6: import-preceding target snapshot + restorable rollback point (plan §8).
//
// G6 is a MANDATORY gate before the first object publication, workspace
// change or session create — "hide the import" cannot replace it. Three
// things go into the job's private rollback directory, digested and durable:
//   1. the COMPLETE pre-state of the touched workspace unit (durable order,
//      members, titles, archive/pin sets),
//   2. the LIGHT pre-state of the relevant session objects (existence,
//      revision, formatStatus — never full chat history),
//   3. the OWNERSHIP manifest of the batch's intended new objects, each with
//      a pre-create non-existence proof.
//
// Rollback compensates in REVERSE action order through the target's real
// interfaces (workspace detach/delete, archive/pin restoration) and a
// backend-specific session withdrawal adapter (the SessionPersistence service
// has NO delete — withdrawal is the measured adapter, not an assumed API).
// After compensation, the target must match the snapshot (workspace order/
// members/archive/pin + batch session visibility); any discrepancy is
// ROLLBACK_PENDING, never reported success.

import { createHash } from 'node:crypto'

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Capture the target pre-state for a planned import batch.
 * @param {object} params
 * @param {object} params.persistence - target sessionPersistence (list/stat).
 * @param {object} [params.workspaceRegistry] - target workspaceRegistry.
 * @param {string[]} params.plannedSessionIds - ids this batch intends to
 *   create (pre-existence proof is captured per id).
 * @param {string[]} [params.relatedSessionIds] - ids the batch may touch
 *   (light pre-state only).
 * @returns {object} snapshot { digest, workspaces, workspaceIds,
 *   archivedSessionIds, pinnedSessionIds, sessions, ownership }
 */
export async function captureTargetPreState({ persistence, workspaceRegistry, plannedSessionIds, relatedSessionIds = [] }) {
  const snapshot = { capturedAt: new Date().toISOString(), workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], sessions: {}, ownership: { plannedCreates: [] } }

  if (workspaceRegistry) {
    snapshot.workspaceIds = [...workspaceRegistry.list().map(w => w.id)]
    snapshot.workspaces = workspaceRegistry.list().map(w => ({
      id: w.id,
      path: w.path,
      title: w.title,
      sessionIds: [...w.sessionIds],
    }))
    snapshot.archivedSessionIds = [...workspaceRegistry.archivedSessionIds]
    snapshot.pinnedSessionIds = [...workspaceRegistry.pinnedSessionIds]
  }

  // Light pre-state for planned + related ids (existence/revision only).
  const ids = [...new Set([...plannedSessionIds, ...relatedSessionIds])]
  for (const id of ids) {
    const snap = await persistence.stat(id)
    snapshot.sessions[id] = snap
      ? { exists: true, revision: snap.revision ?? null, formatStatus: snap.formatStatus ?? null }
      : { exists: false }
  }

  // Ownership manifest: EVERY planned create gets a pre-create non-existence
  // proof. A planned id that already exists is an ownership conflict — the
  // batch must not run (writer-a refuses per id as well, but the gate is the
  // plan-level proof).
  for (const id of plannedSessionIds) {
    const pre = snapshot.sessions[id]
    if (pre?.exists) {
      const e = new Error(`planned import id ${id} already exists on the target — ownership conflict, batch refused`)
      e.code = 'G6_OWNERSHIP_CONFLICT'
      throw e
    }
    snapshot.ownership.plannedCreates.push({ id, preExisting: false })
  }

  snapshot.digest = digest({
    workspaces: snapshot.workspaces,
    workspaceIds: snapshot.workspaceIds,
    archivedSessionIds: snapshot.archivedSessionIds,
    pinnedSessionIds: snapshot.pinnedSessionIds,
    sessions: snapshot.sessions,
    ownership: snapshot.ownership,
  })
  return snapshot
}

/**
 * Verify the target matches the snapshot (workspace unit + batch visibility).
 * @returns {{ ok: boolean, diffs: string[] }}
 */
export async function verifyTargetRestored({ persistence, workspaceRegistry, snapshot, plannedSessionIds }) {
  const diffs = []
  if (workspaceRegistry) {
    const nowOrder = workspaceRegistry.list().map(w => w.id)
    if (JSON.stringify(nowOrder) !== JSON.stringify(snapshot.workspaceIds)) {
      diffs.push(`workspace durable order changed: ${JSON.stringify(snapshot.workspaceIds)} -> ${JSON.stringify(nowOrder)}`)
    }
    const now = new Map(workspaceRegistry.list().map(w => [w.id, w]))
    for (const before of snapshot.workspaces) {
      const w = now.get(before.id)
      if (!w) {
        diffs.push(`workspace ${before.id} disappeared`)
        continue
      }
      if (JSON.stringify(w.sessionIds) !== JSON.stringify(before.sessionIds)) {
        diffs.push(`workspace ${before.id} members changed: ${JSON.stringify(before.sessionIds)} -> ${JSON.stringify(w.sessionIds)}`)
      }
      if (w.title !== before.title) diffs.push(`workspace ${before.id} title changed`)
    }
    if (JSON.stringify(workspaceRegistry.archivedSessionIds) !== JSON.stringify(snapshot.archivedSessionIds)) {
      diffs.push('archive set changed')
    }
    if (JSON.stringify(workspaceRegistry.pinnedSessionIds) !== JSON.stringify(snapshot.pinnedSessionIds)) {
      diffs.push('pin set changed')
    }
  }
  // Batch sessions must be invisible again.
  for (const id of plannedSessionIds) {
    const snap = await persistence.stat(id)
    if (snap) diffs.push(`batch session ${id} is still visible on the target`)
  }
  return { ok: diffs.length === 0, diffs }
}

/**
 * Roll the batch back by compensating the recorded actions in REVERSE order.
 * @param {object} params
 * @param {object[]} params.actions - journal actionsReversed().
 * @param {object} params.snapshot - captureTargetPreState() result.
 * @param {string[]} params.plannedSessionIds - this batch's session ids.
 * @param {object} [params.workspaceRegistry]
 * @param {object} params.persistence
 * @param {(id: string) => Promise<void>} params.withdrawSession - BACKEND-
 *   SPECIFIC withdrawal adapter (moves/removes the session object out of the
 *   active namespace). The persistence service has no delete; this adapter is
 *   the measured mechanism for the concrete backend, never an assumed API.
 * @returns {Promise<{ ok: boolean, verification: object, compensated: string[] }>}
 */
export async function rollbackBatch({ actions, snapshot, plannedSessionIds, workspaceRegistry, persistence, withdrawSession }) {
  const compensated = []
  const failures = []
  for (const action of actions) {
    try {
      if (action.type === 'session.attach') {
        // Detach through the workspace's own interface.
        const ws = workspaceRegistry?.get(action.workspaceId)
        if (ws) await ws.detachSession(action.sessionId)
      } else if (action.type === 'workspace.create') {
        // Remove the registration created by this batch (retains the
        // directory; the directory belongs to the caller's project space).
        if (workspaceRegistry && snapshot.workspaces.every(w => w.id !== action.workspaceId)) {
          await workspaceRegistry.delete(action.workspaceId)
        }
      } else if (action.type === 'session.import') {
        // Pre-withdrawal proof: the object must be ours (pre-state said
        // absent) and not live.
        if (typeof withdrawSession !== 'function') {
          throw new Error('no session withdrawal adapter for this backend — rollback cannot withdraw created sessions')
        }
        await withdrawSession(action.sessionId)
      } else if (action.type === 'session.archive' || action.type === 'session.unarchive' || action.type === 'session.pin' || action.type === 'session.unpin') {
        // Restore ONLY memberships this batch flipped, per snapshot. All
        // registry operations enqueue asynchronously — each is awaited so
        // the final verification cannot race a pending write.
        if (!workspaceRegistry) break
        const id = action.sessionId
        const wantArchived = snapshot.archivedSessionIds.includes(id)
        const isArchived = workspaceRegistry.archivedSessionIds.includes(id)
        if (wantArchived && !isArchived) await workspaceRegistry.archiveSession(id)
        if (!wantArchived && isArchived) await workspaceRegistry.unarchiveSession(id)
        const wantPinned = snapshot.pinnedSessionIds.includes(id)
        const isPinned = workspaceRegistry.pinnedSessionIds.includes(id)
        if (wantPinned && !isPinned) await workspaceRegistry.pinSession(id)
        if (!wantPinned && isPinned) await workspaceRegistry.unpinSession(id)
      }
      compensated.push(action.type + (action.sessionId ? `:${action.sessionId}` : '') + (action.workspaceId ? `:${action.workspaceId}` : ''))
    } catch (error) {
      failures.push(`${action.type}: ${error.message}`)
    }
  }
  const verification = await verifyTargetRestored({ persistence, workspaceRegistry, snapshot, plannedSessionIds })
  return { ok: verification.ok && failures.length === 0, verification, compensated, failures }
}
