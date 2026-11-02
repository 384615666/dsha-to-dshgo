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
import fs from 'node:fs'
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

function codedG6(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

// Verified platform limitation for DIRECTORY-entry fsync (same rule as the
// journal): file-content fsync is ALWAYS strict; only a platform that cannot
// fsync a directory handle degrades, and the degradation is recorded.
function dirFsyncUnsupported(error) {
  const code = error?.code
  if (process.platform === 'win32') return ['EPERM', 'EISDIR', 'EINVAL', 'EBUSY'].includes(code)
  return code === 'ENOSYS'
}

/**
 * Durably publish a snapshot file: temp write → file fsync → atomic rename →
 * directory fsync where supported. Real I/O failures abort the capture; a
 * FILE fsync the platform does not implement (ENOSYS) is reported as an
 * unsupported capability and also refuses (no best-effort pass). Returns the
 * recorded durability channel.
 */
function publishSnapshotFile(dir, name, bytes) {
  const tmp = join(dir, `${name}.tmp`)
  const dest = join(dir, name)
  let fd
  try {
    fd = openSync(tmp, 'w', 0o600)
    writeSync(fd, bytes)
    try {
      fs.fsyncSync(fd)
    } catch (error) {
      if (error?.code === 'ENOSYS') {
        throw codedG6('G6_SNAPSHOT_UNSUPPORTED', 'the platform cannot fsync the snapshot file — refusing a non-durable backup')
      }
      throw codedG6('G6_SNAPSHOT_IO', `snapshot file fsync failed: ${error?.code ?? error?.message}`)
    }
    closeSync(fd)
    fd = undefined
    renameSync(tmp, dest)
  } catch (error) {
    try { if (fd !== undefined) closeSync(fd) } catch { /* closed */ }
    try { unlinkSync(tmp) } catch { /* nothing to clean */ }
    if (typeof error?.code === 'string' && error.code.startsWith('G6_')) throw error
    throw codedG6('G6_SNAPSHOT_IO', `snapshot publication failed: ${error?.code ?? error?.message}`)
  }
  let directory = 'synced'
  let dfd
  try {
    dfd = openSync(dir, 'r')
  } catch (error) {
    if (dirFsyncUnsupported(error)) return { file: 'synced', directory: 'unsupported-platform' }
    throw codedG6('G6_SNAPSHOT_IO', `snapshot directory open failed: ${error?.code ?? error?.message}`)
  }
  try {
    try {
      fs.fsyncSync(dfd)
    } catch (error) {
      if (dirFsyncUnsupported(error)) directory = 'unsupported-platform'
      else throw codedG6('G6_SNAPSHOT_IO', `snapshot directory fsync failed: ${error?.code ?? error?.message}`)
    }
  } finally {
    closeSync(dfd)
  }
  return { file: 'synced', directory }
}

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
    workspaceUnitDigest: snapshot.workspaceUnit?.digest ?? null,
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
export async function captureTargetPreState({
  persistence,
  workspaceRegistry,
  plannedSessionIds,
  relatedSessionIds = [],
  workspaceUnitProvider,
  snapshotDir,
  captureAttempts = 3,
  captureRetryDelayMs = 25,
}) {
  if (typeof workspaceUnitProvider === 'function' && !snapshotDir) {
    throw codedG6('G6_SNAPSHOT_INVALID', 'a workspace unit provider requires a private snapshot directory')
  }
  const ids = [...new Set([...plannedSessionIds, ...relatedSessionIds])]

  const registryView = () => {
    if (!workspaceRegistry) return { workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }
    return {
      workspaceIds: [...workspaceRegistry.list().map(w => w.id)],
      workspaces: workspaceRegistry.list().map(w => ({
        id: w.id,
        path: w.path,
        title: w.title,
        // Full supported entity fields (plan §8 item 1): the durable record
        // snapshot, not just the display projections.
        createdAt: w.createdAt ?? null,
        updatedAt: w.updatedAt ?? null,
        sessionIds: [...w.sessionIds],
      })),
      archivedSessionIds: [...workspaceRegistry.archivedSessionIds],
      pinnedSessionIds: [...workspaceRegistry.pinnedSessionIds],
    }
  }
  const sessionView = async () => {
    const out = {}
    for (const id of ids) {
      const snap = await persistence.stat(id)
      out[id] = snap
        ? { exists: true, revision: snap.revision ?? null, formatStatus: snap.formatStatus ?? null }
        : { exists: false }
    }
    return out
  }
  const readUnit = async () => {
    if (typeof workspaceUnitProvider !== 'function') return null
    const unit = await workspaceUnitProvider()
    if (!unit || !(unit.bytes instanceof Uint8Array)) {
      throw codedG6('G6_SNAPSHOT_INVALID', 'the workspace unit provider returned no bytes')
    }
    if (unit.bytes.length > 5 * 1024 * 1024) {
      throw codedG6('G6_SNAPSHOT_INVALID', `the workspace storage unit (${unit.bytes.length} B) exceeds the 5 MiB snapshot budget`)
    }
    return {
      bytes: unit.bytes,
      digest: createHash('sha256').update(unit.bytes).digest('hex'),
      unitDigest: unit.digest ?? null,
    }
  }

  // STABLE PRE-STATE: the registry view and the on-disk unit copy must come
  // from the SAME moment. Both are read TWICE, interleaved; any difference
  // means a concurrent workspace operation happened during capture, so the
  // attempt is discarded and retried. Publishing a mixed snapshot (entity
  // fields from before, unit bytes from after) is refused with a stable
  // error after the bounded retries — the single-import lock cannot stop
  // ordinary user/service workspace operations.
  let view
  let sessions
  let unit
  for (let attempt = 1; attempt <= captureAttempts; attempt++) {
    const viewA = registryView()
    const unitA = await readUnit()
    const sessionsA = await sessionView()
    const viewB = registryView()
    const unitB = await readUnit()
    const sessionsB = await sessionView()
    const stable = JSON.stringify(viewA) === JSON.stringify(viewB)
      && JSON.stringify(sessionsA) === JSON.stringify(sessionsB)
      && (unitA?.digest ?? null) === (unitB?.digest ?? null)
    if (stable) {
      view = viewB
      sessions = sessionsB
      unit = unitB ?? unitA
      break
    }
    if (attempt < captureAttempts && captureRetryDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, captureRetryDelayMs))
    }
  }
  if (!view) {
    throw codedG6('G6_SNAPSHOT_UNSTABLE', 'the target workspace/session state changed during capture — refusing to publish a mixed pre-state snapshot')
  }

  const snapshot = {
    capturedAt: new Date().toISOString(),
    workspaces: view.workspaces,
    workspaceIds: view.workspaceIds,
    archivedSessionIds: view.archivedSessionIds,
    pinnedSessionIds: view.pinnedSessionIds,
    sessions,
    ownership: { plannedCreates: [] },
  }

  // Disk copy of the workspace storage unit, DURABLY published: temp file →
  // file fsync → atomic rename → directory fsync where the platform supports
  // it. A read-back hash alone is not a persistence proof, so any real
  // write/sync error aborts the snapshot (IMPORTING can never admit a
  // non-durable backup); ENOSYS on the FILE is reported as an unsupported
  // capability and also refuses.
  if (unit) {
    mkdirSync(snapshotDir, { recursive: true, mode: 0o700 })
    const file = 'workspace-unit.json'
    const durability = publishSnapshotFile(snapshotDir, file, unit.bytes)
    snapshot.workspaceUnit = {
      file,
      bytes: unit.bytes.length,
      digest: unit.digest,
      unitDigest: unit.unitDigest,
      durability,
    }
  }

  // Ownership manifest: EVERY planned create gets a pre-create non-existence
  // proof. A planned id that already exists is an ownership conflict — the
  // batch must not run (writer-a refuses per id as well; the gate is the
  // plan-level proof).
  for (const id of plannedSessionIds) {
    const pre = snapshot.sessions[id]
    if (pre?.exists) {
      throw codedG6('G6_OWNERSHIP_CONFLICT', `planned import id ${id} already exists on the target — ownership conflict, batch refused`)
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
export async function rollbackBatch({ actions, snapshot, plannedSessionIds, workspaceRegistry, persistence, journal, withdrawSession, assertNoActiveOwner, allowUnprotected = false }) {
  const owned = new Set(snapshot.ownership.plannedCreates.map(x => x.id))
  const compensated = []
  const conflicts = []
  const failures = []
  let pending = false

  const conflict = (action, reason) => {
    pending = true
    conflicts.push({ action: `${action.type}${action.sessionId ? `:${action.sessionId}` : ''}${action.workspaceId ? `:${action.workspaceId}` : ''}`, reason })
  }

  // ADDITIVE membership restore (pin ∧ archive), GROUPED PER SESSION: a
  // batch may touch the same session's membership more than once (unpin then
  // archive). Compensating each action against the whole-batch before-state
  // made the second reverse step mistake OUR OWN restore for a user change.
  // The group is restored ONCE from the LATEST action's after-evidence, and a
  // retry that finds the pre-batch state already in place counts as
  // compensated (never as an external modification). The official registry's
  // archive REMOVES the pin in the same durable write, so the restore keeps
  // the coupling order: archive state first, then pin state.
  const restoreMembershipGroup = async (group) => {
    const id = group[0].sessionId
    const last = group.reduce((a, b) => (a.seq > b.seq ? a : b))
    const wantPinned = snapshot.pinnedSessionIds.includes(id)
    const wantArchived = snapshot.archivedSessionIds.includes(id)
    const openIntent = group.find(a => a.stage !== 'done')
    if (openIntent) {
      conflict(openIntent, 'intent recorded without a confirmed outcome — result unknown, manual judgment required')
      return
    }
    const after = last.outcome?.membershipAfter
    if (!after || typeof after.pinned !== 'boolean' || typeof after.archived !== 'boolean') {
      conflict(last, 'outcome carries no membership evidence (pinned/archived after our write) — manual judgment required')
      return
    }
    const curPinned = workspaceRegistry.pinnedSessionIds.includes(id)
    const curArchived = workspaceRegistry.archivedSessionIds.includes(id)
    // Idempotent retry: the pre-batch membership is already in place.
    if (curPinned === wantPinned && curArchived === wantArchived) {
      for (const a of group) compensated.push(`${a.type}:${id}`)
      return
    }
    if (curPinned !== after.pinned || curArchived !== after.archived) {
      // A genuine user change happened after our LAST action.
      conflict(last, `membership changed after our ${last.type} (our after pinned=${after.pinned} archived=${after.archived}; current pinned=${curPinned} archived=${curArchived}) — user state preserved`)
      return
    }
    // Current still equals our final after: rebuild the pre-batch membership.
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
      conflict(last, `membership restore did not converge (wanted pinned=${wantPinned} archived=${wantArchived}; got pinned=${finalPinned} archived=${finalArchived})`)
      return
    }
    for (const a of group) compensated.push(`${a.type}:${id}`)
  }

  // Group every membership action by session so it is compensated exactly once.
  const MEMBERSHIP_TYPES = new Set(['session.pin', 'session.unpin', 'session.archive', 'session.unarchive'])
  const membershipGroups = new Map()
  for (const action of actions) {
    if (!MEMBERSHIP_TYPES.has(action.type)) continue
    const list = membershipGroups.get(action.sessionId) ?? []
    list.push(action)
    membershipGroups.set(action.sessionId, list)
  }
  const membershipHandled = new Set()

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
        // Active-owner exclusion. A PROTECTED adapter (withdraw.protected)
        // holds the write lease across the move itself — no probe→close gap.
        // The instantaneous probe is an ISOLATED-LAB path only: production
        // callers must not fall back to it (allowUnprotected is explicit).
        if (withdrawSession?.protected === true) {
          try {
            await withdrawSession(action.sessionId, {
              expectedRevision: after,
              cwd: action.outcome?.cwd,
            })
          } catch (error) {
            if (error?.code === 'WITHDRAW_NOT_SAFE') {
              conflict(action, error.message)
              continue
            }
            throw error
          }
          compensated.push(label)
          continue
        }
        if (!allowUnprotected) {
          conflict(action, 'unprotected withdrawal adapter (open→close probe) is not admissible in production — supply a protected adapter that holds exclusivity across the move')
          continue
        }
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
        if (membershipHandled.has(action.sessionId)) continue
        membershipHandled.add(action.sessionId)
        await restoreMembershipGroup(membershipGroups.get(action.sessionId) ?? [action])
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
