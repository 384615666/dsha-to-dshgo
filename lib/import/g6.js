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
//
// Attachment objects follow the same rule: the store has no delete API, so an
// object recorded as created by this batch is MOVED into the job's quarantine
// (recoverable) only after content identity and an absence of remaining
// references are proven; reused/shared and unprovable objects are preserved
// and the batch stays PENDING with evidence. The final verification checks
// that kept objects are still present/unchanged and moved objects are gone.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { collectAttachmentDependencies } from './attachments.js'

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

// ---------------------------------------------------------------------------
// ATTACHMENT-OBJECT COMPENSATION
//
// The official AttachmentStore has host-path accessors and readers but NO
// delete API, and a content-addressed object may be shared by other sessions.
// Compensation therefore MOVES an object that is proven OURS and UNCHANGED out
// of the active store into the job's quarantine (recoverable, never deleted),
// and only after proving that no remaining session references it. Every
// uncertain case preserves the object and lands the batch in PENDING with the
// reason persisted.
// ---------------------------------------------------------------------------

export const ATTACHMENT_QUARANTINE_SUBDIR = 'attachments'

export function attachmentQuarantineName(kind, digest, name) {
  return `object-${createHash('sha256').update(`${kind}:${digest}:${name ?? ''}`).digest('hex').slice(0, 32)}`
}

/** The dependency-graph identity of the object an action published. */
export function attachmentKeyOf(action) {
  if (typeof action?.key === 'string' && action.key !== '') return action.key
  const ref = action?.outcome?.ref ?? null
  const kind = action?.kind ?? (ref?.mediaType ? 'image' : 'file')
  if (typeof action?.digest !== 'string' || action.digest === '') return null
  if (kind === 'file') return ref?.name ? `file:${action.digest}:${ref.name}` : `file:${action.digest}`
  return `image:${action.digest}`
}

/** Official host path of the object, from the recorded evidence or the accessor. */
function attachmentHostPathOf(action, store) {
  const outcome = action?.outcome ?? {}
  if (typeof outcome.hostPath === 'string' && outcome.hostPath !== '') return resolve(outcome.hostPath)
  const ref = outcome.ref
  if (!ref || !store) return null
  try {
    if (action.kind === 'image' && typeof store.imageHostPath === 'function') return store.imageHostPath(ref) ?? null
    if (action.kind !== 'image' && typeof store.fileHostPath === 'function') return store.fileHostPath(ref) ?? null
  } catch { /* no projection available */ }
  return null
}

/**
 * Digest/length of the object as the OFFICIAL store reads it (raw file read is
 * only the evidence fallback when the reader is unavailable). Returns null when
 * the bytes cannot be proven.
 */
async function readObjectFacts(store, action, file) {
  const ref = action?.outcome?.ref ?? null
  if (store && ref) {
    try {
      if (action.kind === 'image' && typeof store.readImage === 'function') {
        const stored = await store.readImage(ref)
        const bytes = Buffer.from(stored.data)
        return { digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, via: 'readImage' }
      }
      if (action.kind !== 'image' && typeof store.readFileStream === 'function') {
        const hash = createHash('sha256')
        let total = 0
        for await (const chunk of store.readFileStream(ref)) { hash.update(chunk); total += chunk.length }
        return { digest: hash.digest('hex'), bytes: total, via: 'readFileStream' }
      }
    } catch {
      return null
    }
  }
  if (!file) return null
  try {
    const bytes = readFileSync(file)
    return { digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, via: 'host-file' }
  } catch {
    return null
  }
}

function isInsideRoot(root, file) {
  if (!root) return true
  const r = resolve(root)
  const f = resolve(file)
  return f !== r && f.startsWith(r + sep)
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
 * Canonical registry view used by capture, verification and the workspace
 * recovery adapter: durable order, archive/pin sets and every entity's
 * supported fields (including the VISIBLE sessionIds).
 */
export function readWorkspaceRegistryView(workspaceRegistry) {
  if (!workspaceRegistry) return { workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }
  return {
    workspaceIds: [...workspaceRegistry.list().map(w => w.id)],
    workspaces: workspaceRegistry.list().map(w => ({
      id: w.id,
      path: w.path,
      title: w.title,
      createdAt: w.createdAt ?? null,
      updatedAt: w.updatedAt ?? null,
      sessionIds: [...w.sessionIds],
    })),
    archivedSessionIds: [...workspaceRegistry.archivedSessionIds],
    pinnedSessionIds: [...workspaceRegistry.pinnedSessionIds],
  }
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

  const registryView = () => readWorkspaceRegistryView(workspaceRegistry)
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
    // CROSS-LAYER contract: the provider must also project the workspace
    // entities AS STORED in these very bytes. Comparing the registry view
    // with that projection catches "storage committed, entity projection not
    // yet switched" — two individually stable views that disagree.
    const projection = unit.projection
    if (!projection || typeof projection !== 'object') {
      throw codedG6('G6_SNAPSHOT_INVALID', 'the workspace unit provider must return the committed entity projection (projection) alongside the bytes')
    }
    return {
      bytes: unit.bytes,
      digest: createHash('sha256').update(unit.bytes).digest('hex'),
      unitDigest: unit.digest ?? null,
      projection,
      unitName: unit.unitName ?? null,
      unitVersion: unit.unitVersion ?? null,
    }
  }
  const normalizeWorkspaces = (workspaces, workspaceIds, archivedSessionIds, pinnedSessionIds) => JSON.stringify({
    workspaceIds,
    archivedSessionIds,
    pinnedSessionIds,
    workspaces: Object.fromEntries([...workspaces]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map(w => [w.id, {
        path: w.path ?? null,
        title: w.title ?? null,
        sessionIds: [...(w.sessionIds ?? [])],
        createdAt: w.createdAt ?? null,
        updatedAt: w.updatedAt ?? null,
      }])),
  })
  // Cross-layer equality, allowing the documented filtering: the registry's
  // VISIBLE sessionIds may hide persisted candidates (cwd/target validation),
  // so visibility must be a SUBSET of the persisted unit records — never an
  // invented member. All other fields and the global sets must agree.
  const crossLayerConsistent = (view, projection) => {
    if (!projection || typeof projection !== 'object') return false
    if (JSON.stringify(view.workspaceIds) !== JSON.stringify(projection.workspaceIds ?? [])) return false
    if (JSON.stringify(view.archivedSessionIds) !== JSON.stringify(projection.archivedSessionIds ?? [])) return false
    if (JSON.stringify(view.pinnedSessionIds) !== JSON.stringify(projection.pinnedSessionIds ?? [])) return false
    for (const w of view.workspaces) {
      const stored = projection.workspaces?.[w.id]
      if (!stored) return false
      if ((stored.path ?? null) !== (w.path ?? null)) return false
      if ((stored.title ?? null) !== (w.title ?? null)) return false
      if ((stored.createdAt ?? null) !== (w.createdAt ?? null)) return false
      if ((stored.updatedAt ?? null) !== (w.updatedAt ?? null)) return false
      const persisted = new Set(stored.sessionIds ?? [])
      for (const id of w.sessionIds) if (!persisted.has(id)) return false
    }
    return true
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
      // Each side being individually stable is NOT enough: the storage
      // projection and the registry view must describe the same committed
      // version (a pending mutation can leave storage ahead of the entity).
      && (!unitB || crossLayerConsistent(viewB, unitB.projection))
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
  // Keep BOTH member views: the registry's visible set and the persisted
  // candidate set from the storage unit. Filtering may legitimately hide
  // candidates; the raw records are never silently dropped.
  if (unit) {
    snapshot.workspaces = snapshot.workspaces.map(w => ({
      ...w,
      persistedSessionIds: [...(unit.projection.workspaces?.[w.id]?.sessionIds ?? [])],
    }))
    snapshot.workspaceUnitSchema = {
      unitName: unit.unitName ?? null,
      unitVersion: unit.unitVersion ?? null,
    }
  }

  // Disk copy of the workspace storage unit, DURABLY published: temp file →
  // file fsync → atomic rename → directory fsync where the platform supports
  // it. A read-back hash alone is not a persistence proof, so any real
  // write/sync error aborts the snapshot (IMPORTING can never admit a
  // non-durable backup); ENOSYS on the FILE is reported as an unsupported
  // capability and also refuses.
  if (unit) {
    mkdirSync(snapshotDir, { recursive: true, mode: 0o700 })
    // CONTENT-ADDRESSED, IMMUTABLE copies: a new capture can never overwrite
    // a copy an existing journal already references. A failed later capture
    // leaves the old object intact; any partial new object stays unreferenced.
    const file = `workspace-unit.${unit.digest.slice(0, 32)}.json`
    const dest = join(snapshotDir, file)
    let durability
    if (existsSync(dest)) {
      const existing = readFileSync(dest)
      if (createHash('sha256').update(existing).digest('hex') !== unit.digest) {
        throw codedG6('G6_SNAPSHOT_IO', 'a content-addressed snapshot object exists with different bytes — refusing to overwrite')
      }
      durability = { file: 'existing', directory: 'existing' }
    } else {
      durability = publishSnapshotFile(snapshotDir, file, unit.bytes)
    }
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
 *
 * `attachmentChecks` (optional) additionally proves the ATTACHMENT-OBJECT
 * layer: every object the batch did not own must still exist with its recorded
 * digest/length (shared objects were never disturbed), and every object the
 * compensation moved out must be absent from the active store.
 * @returns {{ ok: boolean, diffs: string[], attachments?: object }}
 */
export async function verifyTargetRestored({ persistence, workspaceRegistry, snapshot, plannedSessionIds, plannedExpectation = 'absent', attachmentChecks = [], attachments = null, attachmentRoot = null }) {
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
    } else if (plannedSessionIds.includes(id)) {
      if (plannedExpectation === 'absent' && snap) {
        diffs.push(`batch session ${id} is still visible on the target`)
      } else if (plannedExpectation === 'present' && !snap) {
        diffs.push(`batch session ${id} is missing from the target`)
      }
    }
  }
  // ATTACHMENT OBJECTS: visibility/existence after compensation.
  const attachmentReport = { checked: 0, skipped: 0 }
  for (const check of attachmentChecks) {
    const action = check.action ?? null
    const key = check.key ?? (action ? attachmentKeyOf(action) : null)
    const file = check.hostPath ?? (action ? attachmentHostPathOf(action, attachments) : null)
    const digest = check.digest ?? action?.digest ?? null
    if (!file || !digest) { attachmentReport.skipped += 1; continue }
    attachmentReport.checked += 1
    if (!isInsideRoot(attachmentRoot, file)) {
      diffs.push(`attachment object ${key ?? '?'} resolves outside the attachment root`)
      continue
    }
    const present = existsSync(file)
    if (check.expect === 'absent') {
      if (present) diffs.push(`attachment object still present after rollback: ${key ?? file}`)
      continue
    }
    if (!present) {
      diffs.push(`attachment object disappeared: ${key ?? file}`)
      continue
    }
    const facts = await readObjectFacts(attachments, action, file)
    if (!facts) {
      diffs.push(`attachment object could not be read back: ${key ?? file}`)
      continue
    }
    if (facts.digest !== digest) diffs.push(`attachment object content changed: ${key ?? file}`)
    else if (action?.outcome?.bytes != null && facts.bytes !== action.outcome.bytes) diffs.push(`attachment object length changed: ${key ?? file}`)
  }
  return { ok: diffs.length === 0, diffs, attachments: attachmentReport }
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
 *     preserves any user change made after our action;
 *   - an ATTACHMENT object is moved to the job's quarantine only when the
 *     batch recorded it as created by us, its bytes still match the recorded
 *     digest, and no remaining session references it. Reused/shared objects are
 *     never touched; anything unprovable is preserved and the batch stays
 *     PENDING with the reason.
 * Every verdict is persisted through the journal.
 *
 * Attachment parameters (all optional; without them the attachment layer is
 * judged conservatively — every created object is preserved as PENDING):
 *   attachments            — the target AttachmentStore (host-path/reader API).
 *   attachmentRoot         — its real v1 root; recorded/derived paths must be
 *                            inside it.
 *   attachmentQuarantineDir— job-private directory objects are moved into.
 *   attachmentReferenceScan— optional () => Promise<string[]> of keys still
 *                            referenced; defaults to a bounded scan of the
 *                            target sessions through `persistence.list/open`.
 *   attachmentScanBudget   — { sessions, events } bounds for that default scan;
 *                            exceeding it is treated as "unproven" (preserve).
 * @returns {Promise<{ outcome: 'complete'|'pending'|'failed', conflicts: object[],
 *   compensated: string[], failures: string[], verification: object,
 *   attachmentChecks: object[] }>}
 */
export async function rollbackBatch({
  actions,
  snapshot,
  plannedSessionIds,
  workspaceRegistry,
  persistence,
  journal,
  withdrawSession,
  assertNoActiveOwner,
  allowUnprotected = false,
  attachments = null,
  attachmentRoot = null,
  attachmentQuarantineDir = null,
  attachmentReferenceScan = null,
  attachmentScanBudget = { sessions: 64, events: 20_000 },
}) {
  const owned = new Set(snapshot.ownership.plannedCreates.map(x => x.id))
  const compensated = []
  const conflicts = []
  const failures = []
  const attachmentChecks = []
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

  // -------------------------------------------------------------------------
  // ATTACHMENT-OBJECT COMPENSATION (see the module-level note).
  // -------------------------------------------------------------------------
  const attachmentQuarantine = attachmentQuarantineDir ? resolve(attachmentQuarantineDir) : null
  let referenceScanCache = null
  // Keys still referenced by a REMAINING session. The default scan reads the
  // target's own sessions through the official list/open API and is bounded:
  // an unbounded/failed scan is "unproven", never "unreferenced".
  const referencedAttachmentKeys = async () => {
    if (referenceScanCache) return referenceScanCache
    referenceScanCache = { ok: false, keys: new Set(), reason: 'unavailable' }
    if (typeof attachmentReferenceScan === 'function') {
      try {
        const keys = await attachmentReferenceScan()
        referenceScanCache = { ok: true, keys: new Set(Array.isArray(keys) ? keys : []) }
      } catch (error) {
        referenceScanCache = { ok: false, keys: new Set(), reason: `custom scan failed (${error?.code ?? error?.name ?? 'error'})` }
      }
      return referenceScanCache
    }
    if (!persistence || typeof persistence.list !== 'function' || typeof persistence.open !== 'function') {
      return referenceScanCache
    }
    const maxSessions = Number.isSafeInteger(attachmentScanBudget?.sessions) ? attachmentScanBudget.sessions : 64
    const maxEvents = Number.isSafeInteger(attachmentScanBudget?.events) ? attachmentScanBudget.events : 20_000
    const keys = new Set()
    let sessions = 0
    let events = 0
    let reason = null
    try {
      for (const snapshotEntry of await persistence.list()) {
        const id = snapshotEntry?.header?.id
        if (typeof id !== 'string' || id === '') continue
        if (sessions >= maxSessions) { reason = `session budget (${maxSessions}) exceeded`; break }
        sessions += 1
        let handle
        try {
          handle = await persistence.open(id, 'read')
        } catch { reason = `session ${id} could not be opened for the reference scan`; break }
        try {
          const readEvents = (await handle.read()).events ?? []
          events += readEvents.length
          if (events > maxEvents) { reason = `event budget (${maxEvents}) exceeded`; break }
          for (const object of collectAttachmentDependencies([{ id, events: readEvents }]).objects) keys.add(object.key)
        } finally {
          try { await handle.close() } catch { /* read handle */ }
        }
      }
    } catch (error) {
      reason = `reference scan failed (${error?.code ?? error?.name ?? 'error'})`
    }
    if (reason) referenceScanCache = { ok: false, keys: new Set(), reason }
    else referenceScanCache = { ok: true, keys }
    return referenceScanCache
  }

  /**
   * Compensate ONE confirmed attachment publication. Returns nothing; the
   * verdict is recorded through the shared helpers (compensated / conflict).
   */
  const compensateAttachment = async (action) => {
    const label = `${action.type}:${action.key ?? action.digest ?? 'object'}`
    const outcome = action.outcome ?? {}
    const key = attachmentKeyOf(action)
    const ownership = typeof outcome.ownership === 'string' ? outcome.ownership : 'unknown'
    // Reused/shared objects were never ours: never touched, and their survival
    // is part of the verification.
    if (ownership === 'reused') {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null, reason: 'shared object not owned by this batch' })
      compensated.push(`${label} (reused — not owned by this batch)`)
      return
    }
    // Publication rejected/nothing stored: no object to compensate.
    if (ownership === 'rejected') {
      compensated.push(`${label} (publication rejected — nothing stored)`)
      return
    }
    if (!attachments) {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
      conflict(action, 'attachment store adapter is unavailable — object preserved, manual judgment required')
      return
    }
    const file = attachmentHostPathOf(action, attachments)
    if (!file) {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
      conflict(action, 'no recorded attachment host path and no official accessor — object preserved')
      return
    }
    if (!isInsideRoot(attachmentRoot, file)) {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
      conflict(action, 'the attachment object resolves outside the configured attachment root — preserved')
      return
    }
    if (!existsSync(file)) {
      // Idempotent retry: a previous pass already moved it (or the store
      // deduplicated it away). Nothing to compensate.
      compensated.push(`${label} (already absent)`)
      return
    }
    // OWNERSHIP: only objects this batch recorded as created (or created with
    // unverifiable ownership evidence) may be moved; 'unknown' cannot prove the
    // object is ours, but it also cannot prove it is not — the compensation is
    // withheld and preserved as pending with evidence.
    if (ownership === 'unknown') {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
      conflict(action, 'publication outcome is result-unknown (store call may not have completed) — object preserved')
      return
    }
    // CONTENT: the object must still be exactly what this batch published.
    let facts = null
    try {
      facts = await readObjectFacts(attachments, action, file)
    } catch { facts = null }
    if (!facts) {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
      conflict(action, 'attachment object bytes could not be read back — preserved')
      return
    }
    if (facts.digest !== action.digest) {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
      conflict(action, 'attachment object content no longer matches the recorded digest — preserved')
      return
    }
    // REFERENCE: a content-addressed object can be referenced by another
    // session (user action during the batch, or a retry's own leftovers).
    const scan = await referencedAttachmentKeys()
    if (!scan.ok) {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
      conflict(action, `attachment reference check unavailable (${scan.reason}) — object preserved`)
      return
    }
    if (key && scan.keys.has(key)) {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
      conflict(action, 'attachment object is still referenced by another session — preserved')
      return
    }
    if (!attachmentQuarantine) {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
      conflict(action, 'no attachment quarantine directory was supplied — object preserved')
      return
    }
    // MOVE (never delete): the object leaves the active store and stays
    // recoverable beside its ownership record.
    const name = attachmentQuarantineName(action.kind ?? 'file', action.digest, outcome.ref?.name ?? action.name ?? null)
    const dest = join(attachmentQuarantine, ATTACHMENT_QUARANTINE_SUBDIR, name)
    if (existsSync(dest)) {
      attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
      conflict(action, 'the attachment quarantine already holds an object for this digest — manual judgment required')
      return
    }
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
    try {
      renameSync(file, dest)
    } catch (error) {
      if (error?.code === 'EXDEV') {
        attachmentChecks.push({ key, action, expect: 'present', digest: action.digest ?? null })
        conflict(action, 'the attachment object cannot be moved onto the quarantine device — preserved')
        return
      }
      throw error
    }
    writeFileSync(`${dest}.owner.json`, JSON.stringify({
      key,
      kind: action.kind ?? null,
      digest: action.digest,
      attachmentId: outcome.attachmentId ?? null,
      ref: outcome.ref ?? null,
      ownership,
      sourcePath: file,
      quarantinedAt: new Date().toISOString(),
    }), { mode: 0o600 })
    attachmentChecks.push({ key, action, expect: 'absent', digest: action.digest ?? null })
    compensated.push(`${label} (moved to quarantine)`)
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
        // Active-owner exclusion. A PROTECTED adapter (withdraw.protected)
        // holds the write lease across the move itself — no probe→close gap.
        // The instantaneous probe is an ISOLATED-LAB path only: production
        // callers must not fall back to it (allowUnprotected is explicit).
        if (withdrawSession?.protected === true) {
          try {
            const recordedCwd = action.outcome?.cwd
            await withdrawSession(action.sessionId, {
              expectedRevision: after,
              cwd: recordedCwd,
              // A session created WITHOUT a cwd lives under the measured
              // `_no-cwd` projection; the adapter admits only that exact
              // layout. Old journals without the evidence fall back to it and
              // are refused safely when the layout does not match.
              cwdMode: action.outcome?.cwdMode ?? (recordedCwd === undefined ? 'no-cwd' : 'cwd'),
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
      } else if (action.type === 'attachment.publish') {
        await compensateAttachment(action)
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

  const verification = await verifyTargetRestored({
    persistence,
    workspaceRegistry,
    snapshot,
    plannedSessionIds,
    attachmentChecks,
    attachments,
    attachmentRoot,
  })
  const outcome = failures.length > 0 ? 'failed' : (pending || !verification.ok ? 'pending' : 'complete')
  // EVERY branch persists its verdict — a failed compensation cannot exist
  // only in a return value; the job stays resumable (ROLLBACK_PENDING).
  if (journal) {
    journal.recordRollback({ outcome, verification, conflicts, failures, compensated })
  }
  return { outcome, conflicts, compensated, failures, verification, attachmentChecks }
}
