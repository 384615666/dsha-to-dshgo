// G6: import-preceding target snapshot + restorable rollback point (plan §8).
//
// G6 is a MANDATORY gate before the first object publication, workspace
// change or session create — "hide the import" cannot replace it. The
// snapshot (workspace unit pre-state + light session pre-state + ownership
// manifest with pre-create non-existence proofs) is PERSISTED INTO the job
// journal and bound by digest; IMPORTING refuses without a verified
// snapshot. Rollback compensates in REVERSE action order through the
// target's real interfaces and a backend-specific session withdrawal
// adapter. Every compensation is a THREE-WAY check — before (snapshot) /
// after our write (journal outcome, incl. revision and membership) / current
// target state: only objects proven OURS and UNCHANGED since our write are
// withdrawn or reverted automatically. Concurrent user modifications are
// PRESERVED and the batch lands in a persisted ROLLBACK_PENDING with the
// conflict reasons — never an overwriting "success". Every rollback verdict
// (complete/pending/failed) is persisted with its verification evidence.
//
// The SessionPersistence service has NO delete: session withdrawal is the
// MEASURED backend-specific adapter, never an assumed API. Revision equality
// does NOT prove exclusivity (write-ownership churn leaves the revision
// unchanged) — rollback additionally proves no active owner before moving
// anything.

import { createHash } from 'node:crypto'

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** The snapshot digest binding (content fields only — never the digest itself). */
export function computeSnapshotDigest(snapshot) {
  return digest({
    workspaces: snapshot.workspaces,
    workspaceIds: snapshot.workspaceIds,
    archivedSessionIds: snapshot.archivedSessionIds,
    pinnedSessionIds: snapshot.pinnedSessionIds,
    sessions: snapshot.sessions,
    ownership: snapshot.ownership,
  })
}

/**
 * Capture the target pre-state for a planned import batch.
 * @param {object} params
 * @param {object} params.persistence - target sessionPersistence (list/stat).
 * @param {object} [params.workspaceRegistry] - target workspaceRegistry.
 * @param {string[]} params.plannedSessionIds - ids this batch intends to
 *   create (pre-existence proof is captured per id).
 * @param {string[]} [params.relatedSessionIds] - pre-existing ids the batch
 *   may touch (light pre-state; the restore verification checks they
 *   SURVIVE the batch).
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
  // batch must not run (writer-a refuses per id as well; the gate is the
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

  snapshot.digest = computeSnapshotDigest(snapshot)
  return snapshot
}

/**
 * Verify the target against the snapshot: workspace unit (order/members/
 * title/archive/pin), every SNAPSHOT-KNOWN session — pre-existing ones must
 * still EXIST and keep their revision; planned ones must be gone — so a
 * vanished pre-existing session can never yield a false "restored".
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
      diffs.push(`archive set changed: ${JSON.stringify(snapshot.archivedSessionIds)} -> ${JSON.stringify(workspaceRegistry.archivedSessionIds)}`)
    }
    if (JSON.stringify(workspaceRegistry.pinnedSessionIds) !== JSON.stringify(snapshot.pinnedSessionIds)) {
      diffs.push(`pin set changed: ${JSON.stringify(snapshot.pinnedSessionIds)} -> ${JSON.stringify(workspaceRegistry.pinnedSessionIds)}`)
    }
  }
  // EVERY snapshot-known session: pre-existing ones must SURVIVE (existence
  // and revision); planned ones must be gone.
  for (const [id, pre] of Object.entries(snapshot.sessions ?? {})) {
    const snap = await persistence.stat(id)
    if (pre.exists) {
      if (!snap) {
        diffs.push(`pre-existing session ${id} DISAPPEARED from the target`)
      } else if (pre.revision && snap.revision && snap.revision !== pre.revision) {
        diffs.push(`pre-existing session ${id} revision changed since the snapshot`)
      }
    } else if (snap && plannedSessionIds.includes(id)) {
      diffs.push(`batch session ${id} is still visible on the target`)
    }
  }
  return { ok: diffs.length === 0, diffs }
}

/**
 * Prove (at this instant) that no OTHER write owner holds the session. The
 * measured probe is the service's own exclusivity rule: a second write open
 * is refused with SessionAlreadyOwnedError while an owner exists. Returns
 * false when an owner is present or the probe fails.
 */
async function probeExclusive(persistence, id) {
  if (!persistence || typeof persistence.open !== 'function') return false
  let probe = null
  try {
    probe = await persistence.open(id, 'write')
    return true
  } catch (error) {
    if (/already owned|SessionAlreadyOwned/i.test(`${error?.name ?? ''} ${error?.message ?? ''}`)) return false
    throw error
  } finally {
    try { await probe?.close?.() } catch { /* probe handle */ }
  }
}

/**
 * Roll the batch back by compensating the recorded actions in REVERSE order,
 * with THREE-WAY ownership protection (before snapshot / our write outcome /
 * current target state):
 *   - only ids in the ownership manifest are ever withdrawn;
 *   - a session whose revision changed after our write is PRESERVED;
 *   - a session with an ACTIVE WRITE OWNER is never moved (revision
 *     equality does not prove exclusivity);
 *   - intents without confirmed outcomes are result-unknown;
 *   - a workspace whose title/path changed, or that gained foreign members,
 *     keeps its registration;
 *   - pin/archive compensation restores the WHOLE pre-batch membership and
 *     preserves any user change made after our action.
 * Every verdict is persisted through the journal.
 * @returns {Promise<{ outcome: 'complete'|'pending'|'failed', conflicts: object[],
 *   compensated: string[], failures: string[], verification: object }>}
 */
export async function rollbackBatch({ actions, snapshot, plannedSessionIds, workspaceRegistry, persistence, journal, withdrawSession, assertNoActiveOwner }) {
  const owned = new Set(snapshot.ownership.plannedCreates.map(x => x.id))
  const compensated = []
  const conflicts = []
  const failures = []
  let pending = false

  const conflict = (action, reason) => {
    pending = true
    conflicts.push({ action: `${action.type}${action.sessionId ? `:${action.sessionId}` : ''}${action.workspaceId ? `:${action.workspaceId}` : ''}`, reason })
  }

  // ADDITIVE membership restore (pin ∧ archive): the official registry's
  // archive REMOVES the pin in the same durable write, so compensating one
  // boolean is not enough — restore the WHOLE desired membership, in an
  // order that respects the coupling, then verify convergence.
  const restoreMembership = async (action) => {
    const id = action.sessionId
    const wantPinned = snapshot.pinnedSessionIds.includes(id)
    const wantArchived = snapshot.archivedSessionIds.includes(id)
    const after = action.outcome?.membershipAfter
    if (!after || typeof after.pinned !== 'boolean' || typeof after.archived !== 'boolean') {
      conflict(action, 'outcome carries no membership evidence (pinned/archived after our write) — manual judgment required')
      return
    }
    const curPinned = workspaceRegistry.pinnedSessionIds.includes(id)
    const curArchived = workspaceRegistry.archivedSessionIds.includes(id)
    if (curPinned !== after.pinned || curArchived !== after.archived) {
      // The user changed pin/archive after our action — preserve it.
      conflict(action, `membership changed after our ${action.type} (our after pinned=${after.pinned} archived=${after.archived}; current pinned=${curPinned} archived=${curArchived}) — user state preserved`)
      return
    }
    // Current still equals our after: rebuild the pre-batch membership.
    // Archive first (it clears the pin), then pin.
    if (wantArchived && !workspaceRegistry.archivedSessionIds.includes(id)) {
      await workspaceRegistry.archiveSession(id)
    } else if (!wantArchived && workspaceRegistry.archivedSessionIds.includes(id)) {
      await workspaceRegistry.unarchiveSession(id)
    }
    if (wantPinned && !workspaceRegistry.pinnedSessionIds.includes(id)) {
      await workspaceRegistry.pinSession(id)
    } else if (!wantPinned && workspaceRegistry.pinnedSessionIds.includes(id)) {
      await workspaceRegistry.unpinSession(id)
    }
    const finalPinned = workspaceRegistry.pinnedSessionIds.includes(id)
    const finalArchived = workspaceRegistry.archivedSessionIds.includes(id)
    if (finalPinned !== wantPinned || finalArchived !== wantArchived) {
      conflict(action, `membership restore did not converge (wanted pinned=${wantPinned} archived=${wantArchived}; got pinned=${finalPinned} archived=${finalArchived})`)
      return
    }
    compensated.push(`${action.type}:${id}`)
  }

  for (const action of actions) {
    const label = `${action.type}${action.sessionId ? `:${action.sessionId}` : ''}${action.workspaceId ? `:${action.workspaceId}` : ''}`
    try {
      if (action.stage !== 'done') {
        conflict(action, 'intent recorded without a confirmed outcome — result unknown, manual judgment required')
        continue
      }
      if (action.type === 'session.import') {
        if (!owned.has(action.sessionId)) {
          conflict(action, 'action attributes an import to an id that is NOT in this batch ownership manifest — refusing to withdraw')
          continue
        }
        const cur = await persistence.stat(action.sessionId)
        if (!cur) {
          compensated.push(`${label} (already absent)`)
          continue
        }
        const after = action.outcome?.revision ?? null
        if (!after) {
          conflict(action, 'outcome carries no revision evidence — cannot prove the session is unchanged since our write')
          continue
        }
        if (cur.revision !== after) {
          conflict(action, `session changed after our write (write-after revision ${after}, current ${cur.revision}) — user additions preserved, withdrawal withheld`)
          continue
        }
        // Active-owner exclusion: revision equality does NOT prove nobody
        // holds a write handle. Only withdraw when exclusivity is provable.
        const exclusive = typeof assertNoActiveOwner === 'function'
          ? await assertNoActiveOwner(action.sessionId)
          : await probeExclusive(persistence, action.sessionId)
        if (!exclusive) {
          conflict(action, 'an active write owner holds this session (ownership churn leaves the revision unchanged) — withdrawal withheld')
          continue
        }
        await withdrawSession(action.sessionId)
        compensated.push(label)
      } else if (action.type === 'session.attach') {
        const ws = workspaceRegistry?.get(action.workspaceId)
        if (!ws) {
          compensated.push(`${label} (workspace already absent)`)
          continue
        }
        if (!ws.sessionIds.includes(action.sessionId)) {
          compensated.push(`${label} (already detached)`)
          continue
        }
        // Three-way: the attach is ours only when the workspace still looks
        // like the state our own action left.
        const after = action.outcome ?? {}
        if (after.title !== undefined && ws.title !== after.title) {
          conflict(action, `workspace title changed after our attach (our after "${after.title}", current "${ws.title}") — detach withheld`)
          continue
        }
        if (after.path !== undefined && ws.path !== after.path) {
          conflict(action, 'workspace path changed after our attach — detach withheld')
          continue
        }
        await ws.detachSession(action.sessionId)
        compensated.push(label)
      } else if (action.type === 'workspace.create') {
        if (!workspaceRegistry) continue
        const wsId = action.outcome?.workspaceId ?? action.workspaceId
        if (!wsId) {
          conflict(action, 'workspace.create intent has no confirmed workspace id — result unknown, manual judgment required')
          continue
        }
        if (snapshot.workspaceIds.includes(wsId)) {
          conflict(action, 'action claims a workspace creation for an id that existed before this batch — refusing to delete')
          continue
        }
        const w = workspaceRegistry.get(wsId)
        if (!w) {
          compensated.push(`${label} (already absent)`)
          continue
        }
        const foreign = w.sessionIds.filter(id => !plannedSessionIds.includes(id))
        if (foreign.length > 0) {
          conflict(action, `workspace gained members not owned by this batch (${foreign.join(', ')}) — registration preserved`)
          continue
        }
        // Three-way field protection: a user-edited title (or path) means
        // the registration is in use — preserve it.
        const after = action.outcome ?? {}
        if (after.title !== undefined && w.title !== after.title) {
          conflict(action, `workspace title changed after our creation (our after "${after.title}", current "${w.title}") — registration preserved`)
          continue
        }
        if (after.path !== undefined && w.path !== after.path) {
          conflict(action, 'workspace path changed after our creation — registration preserved')
          continue
        }
        await workspaceRegistry.delete(wsId)
        compensated.push(label)
      } else if (action.type === 'session.pin' || action.type === 'session.unpin' || action.type === 'session.archive' || action.type === 'session.unarchive') {
        if (!workspaceRegistry) continue
        await restoreMembership(action)
      } else {
        conflict(action, 'unknown action type — manual judgment required')
      }
    } catch (error) {
      failures.push(`${label}: ${error.message}`)
      pending = true
    }
  }

  const verification = await verifyTargetRestored({ persistence, workspaceRegistry, snapshot, plannedSessionIds })
  const outcome = failures.length > 0 ? 'failed' : (pending || !verification.ok ? 'pending' : 'complete')
  // EVERY branch persists its verdict — a failed compensation cannot exist
  // only in a return value; the job stays resumable (ROLLBACK_PENDING).
  if (journal) {
    journal.recordRollback({ outcome, verification, conflicts, failures, compensated })
  }
  return { outcome, conflicts, compensated, failures, verification }
}
