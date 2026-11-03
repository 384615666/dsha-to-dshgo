// Unified import job entry (P2 M3): run / resume / cancel over the existing
// modules. The experimental scripts call THIS entry; there is no separate
// "test-only success path".
//
// Order (per the task):
//   instance lock → journal (new or restored + recovery judgment)
//   → approved plan content gate → G6 snapshot (workspace unit)
//   → beginImport → attachments published FIRST → sessions created and
//   read back → workspace attach/order → target verification → DONE
//   or, on failure/cancel, reverse-order compensation + workspace recovery
//   → ROLLED_BACK / ROLLBACK_PENDING.
//
// Duplicate handling (idempotency): an existing target id is NEVER appended
// to. The existing log is compared semantically: identical content → skipped
// (reused); identical prefix plus user additions → 'imported-with-new-messages'
// (preserved, skipped); divergence → conflict (group skipped).
//
// A restored non-terminal journal is NEVER auto-replayed: without an explicit
// recovery judgment the entry returns RECOVERY_REQUIRED with the open intents
// and target facts for the caller to judge.

import { ImportJournal } from './journal.js'
import { acquireJobLock, peekJobLock } from './lock.js'
import { captureTargetPreState, verifyTargetRestored, rollbackBatch, readWorkspaceRegistryView } from './g6.js'
import { restoreWorkspaceUnit } from './workspace-recovery.js'
import { importSessionViaA } from './writer-a.js'
import { compareReadback } from './readback.js'
import { collectAttachmentDependencies, planAttachmentPublication, publishAttachments } from './attachments.js'

// Stable PUBLIC error classification: only known-safe codes from this
// module's own coded() errors pass through; everything else (raw storage
// errors, foreign exception names/stages) maps to a generic category. A
// code string is safe only if it is uppercase/underscore/digit — runtime
// markers (hex, chat fragments) can never match.
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/
function publicErrorCode(error, prefix = 'RUNTIME') {
  const raw = error?.code
  if (typeof raw === 'string' && SAFE_CODE_RE.test(raw)) return raw
  return `${prefix}_FAILURE`
}

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

/**
 * Classify an existing target session against the candidate.
 * @returns {Promise<{ kind: 'absent'|'identical'|'prefix-extended'|'conflict', detail?: object }>}
 */
export async function classifyExistingSession(persistence, candidate) {
  const snap = await persistence.stat(candidate.header.id)
  if (!snap) return { kind: 'absent' }
  const read = await persistence.open(candidate.header.id, 'read')
  let events
  let header
  try {
    header = read.header
    events = (await read.read()).events
  } finally {
    await read.close()
  }
  const cmp = compareReadback(
    { header: candidate.header, events: candidate.events, inheritedEventCount: candidate.inheritedEventCount ?? 0 },
    { header, events, inheritedEventCount: null },
  )
  if (cmp.headerMatch && cmp.eventsMatch) return { kind: 'identical' }
  // prefix check: target events start with every candidate event and has extras
  const candidateEvents = candidate.events
  const isPrefix = events.length > candidateEvents.length
    && candidateEvents.every((ev, i) => JSON.stringify(ev) === JSON.stringify(events[i]))
  if (isPrefix) return { kind: 'prefix-extended', extraEvents: events.length - candidateEvents.length }
  return { kind: 'conflict', detail: { headerMatch: cmp.headerMatch, eventsMatch: cmp.eventsMatch, eventCount: events.length } }
}

/**
 * Run or resume an import job.
 * @param {object} params
 * @param {string} params.jobDir - private job directory (journal + snapshot).
 * @param {string} params.instanceLockDir - SHARED instance-level lock dir.
 * @param {string} params.instanceFingerprint
 * @param {string} params.sourceDigest
 * @param {object} params.approvedPlan - the frozen, user-approved plan object.
 * @param {object} params.target - { persistence, workspaceRegistry, attachments?, attachmentRoot?, workspaceUnitProvider }
 * @param {object[]} params.sessions - [{ id, header, events, inheritedEventCount,
 *   workspace?: { path, title } }] — verified candidates, mappings APPLIED.
 * @param {(object) => Promise<Uint8Array>} [params.readAttachmentSource]
 * @param {(object) => Promise<boolean>} [params.attachmentExists]
 * @param {Function} [params.withdrawSession] - protected adapter for rollback.
 * @param {AbortSignal} [params.signal]
 * @param {boolean} [params.allowUnprotected] - isolated-lab only.
 * @param {object} [params.inspect] - optional inspect report for classify().
 * @param {object} [params.recoveredJudgment] - explicit recovery decision:
 *   { resolveOpenIntents: 'rollback' } is the ONLY accepted automatic action.
 * @returns {Promise<object>} sanitized result.
 */
export async function runImportJob(params) {
  const {
    jobDir, instanceLockDir, instanceFingerprint, sourceDigest, approvedPlan,
    target, sessions = [], readAttachmentSource, attachmentExists,
    withdrawSession, signal, allowUnprotected = false, recoveredJudgment,
  } = params
  const persistence = target?.persistence
  const workspaceRegistry = target?.workspaceRegistry
  if (!persistence) throw coded('IMPORT_TARGET_INVALID', 'a sessionPersistence is required')
  if (!approvedPlan?.digest) throw coded('IMPORT_PLAN_MISSING', 'the approved plan object is required')
  if (allowUnprotected !== true && typeof target?.workspaceUnitProvider !== 'function') {
    // R1: the default (production) job requires the full G6 capability set —
    // a missing formal workspace provider must never silently degrade.
    throw coded('IMPORT_CAPABILITY_MISSING', 'production jobs require a formal workspaceUnitProvider (the isolated-lab mode is an explicit allowUnprotected opt-in)')
  }

  const lock = acquireJobLock(instanceLockDir, { instanceFingerprint })
  const report = { status: 'running', sessions: [], attachments: { published: 0, reused: 0 }, warnings: [], recovery: null }
  let journal = null
  let executionSessions = sessions
  try {
    const journalFile = `${jobDir}/journal.json`
    const binding = { instanceFingerprint, sourceDigest }
    journal = ImportJournal.load(journalFile, binding)
    if (journal) {
      if (journal.recovered) {
        // Nothing could have been written before IMPORTING: a restored
        // PLANNED/SNAPSHOT_READY journal with no recorded actions is a fresh
        // prepared job, safe to continue. Anything else needs a judgment.
        const noWritesYet = journal.state.actions.length === 0
          && (journal.state.batchState === 'PLANNED' || journal.state.batchState === 'SNAPSHOT_READY')
        if (noWritesYet) {
          journal.acknowledgeRecovery()
        } else {
        const openIntents = journal.state.actions.filter(a => a.stage === 'intent')
        report.recovery = {
          batchState: journal.state.batchState,
          openIntents: openIntents.map(a => ({ seq: a.seq, type: a.type, sessionId: a.sessionId ?? null, key: a.key ?? null })),
          snapshotDigest: journal.state.snapshot?.digest ?? null,
        }
        if (recoveredJudgment?.resolveOpenIntents !== 'rollback') {
          journal.acknowledgeRecovery()
          report.status = 'RECOVERY_REQUIRED'
          return report
        }
        journal.acknowledgeRecovery()
        }
      }
    } else {
      journal = ImportJournal.init(journalFile, binding, { requirePlanApproval: true })
    }

    if (journal.state.batchState === 'DONE') {
      // F3: the strict dual-ID validation applies HERE too — a mismatched
      // candidate must never be used to verify a missing approved session.
      for (const session of sessions) {
        if (session.id !== session.header?.id) {
          throw coded('IMPORT_PLAN_BINDING', `candidate identity mismatch: metadata id ${session.id} != header.id ${session.header?.id} — refusing before any check`)
        }
      }
      // R4: the re-verification set comes from the PERSISTED journal (the
      // committed planned creates), never from the caller's session list —
      // a shorter caller list must not shrink the check. Sessions must exist
      // with identical content; absent/diverged → RECOVERY_REQUIRED.
      const committed = journal.state.snapshot?.ownership?.plannedCreates?.map(x => x.id) ?? []
      if (committed.length === 0) {
        report.status = 'ALREADY_DONE' // a persisted no-write batch has nothing to re-check
        return report
      }
      const byId = new Map(sessions.map(s => [s.id, s]))
      for (const id of committed) {
        const candidate = byId.get(id)
        if (!candidate) {
          report.status = 'RECOVERY_REQUIRED'
          report.recovery = { batchState: 'DONE', targetDiscrepancy: id, classification: 'candidate-missing' }
          return report
        }
        const cls = await classifyExistingSession(persistence, candidate)
        report.sessions.push({ id, classification: cls.kind, extraEvents: cls.extraEvents ?? 0 })
        if (cls.kind !== 'identical') {
          report.status = 'RECOVERY_REQUIRED'
          report.recovery = { batchState: 'DONE', targetDiscrepancy: id, classification: cls.kind }
          return report
        }
      }
      report.status = 'ALREADY_DONE'
      return report
    }

    // Reconcile state for a resumed journal.
    if (journal.state.batchState === 'PLANNED' || journal.state.batchState === 'NEW') {
      if (journal.state.batchState === 'NEW') journal.transitionBatch('PLANNED')
    }

    // ---- duplicate classification BEFORE any target write. Existing ids are
    // never appended to: the caller re-plans the remaining subset (identical
    // content is reused, an extended prefix is preserved, divergence is a
    // conflict). This keeps the approved plan's selected set equal to the
    // snapshot's planned creates.
    if (!journal.state.snapshot) {
      const existing = []
      for (const session of sessions) {
        const cls = await classifyExistingSession(persistence, session)
        report.sessions.push({ id: session.id, classification: cls.kind, extraEvents: cls.extraEvents ?? 0 })
        if (cls.kind !== 'absent') existing.push({ id: session.id, classification: cls.kind, detail: cls.detail ?? null })
      }
      if (existing.length > 0) {
        report.existing = existing
        report.status = existing.some(e => e.classification === 'conflict') ? 'CONFLICT' : 'REPLAN_REQUIRED'
        return report
      }
    }

    // ---- R1: derive the ONLY execution set from the approved plan, BEFORE
    // any target side effect. Candidate identity is STRICT: metadata id and
    // header.id must be EQUAL (no OR matching — a mismatched header could
    // smuggle an unapproved id into the target).
    const approvedSelected = new Set(approvedPlan.selected ?? [])
    const approvedExcluded = new Set((approvedPlan.excluded ?? []).map(e => e.id))
    const execution = []
    for (const session of sessions) {
      if (session.id !== session.header?.id) {
        throw coded('IMPORT_PLAN_BINDING', `candidate identity mismatch: metadata id ${session.id} != header.id ${session.header?.id} — refusing before any write`)
      }
      const inPlan = approvedSelected.has(session.id)
      const excluded = approvedExcluded.has(session.id)
      if (inPlan && excluded) throw coded('IMPORT_PLAN_BINDING', `session ${session.id} is both selected and excluded in the approved plan`)
      if (inPlan) execution.push(session)
    }
    for (const id of approvedSelected) {
      if (!sessions.some(s => s.id === id)) {
        throw coded('IMPORT_PLAN_BINDING', `approved plan selects ${id} but no candidate for it was supplied`)
      }
    }
    executionSessions = execution
    report.execution = { selected: [...approvedSelected], imported: execution.map(s => s.id) }

    // ---- snapshot: restore from the journal when resuming, else capture.
    let snapshot = journal.state.snapshot
    if (!snapshot) {
      snapshot = await captureTargetPreState({
        persistence,
        workspaceRegistry,
        plannedSessionIds: execution.map(s => s.id),
        workspaceUnitProvider: target.workspaceUnitProvider,
        snapshotDir: jobDir,
      })
      journal.setSnapshot(snapshot)
      if (journal.state.batchState === 'PLANNED') journal.transitionBatch('SNAPSHOT_READY')
    } else if (journal.state.batchState === 'PLANNED') {
      journal.transitionBatch('SNAPSHOT_READY')
    }

    if (journal.state.batchState === 'ROLLING_BACK' || journal.state.batchState === 'ROLLBACK_PENDING') {
      return await rollbackAndReport({ journal, snapshot, sessions: executionSessions, target, withdrawSession, allowUnprotected, report, jobDir })
    }

    // ---- approved plan content gate + start.
    if (journal.state.batchState === 'SNAPSHOT_READY') {
      const started = journal.beginImport(approvedPlan)
      // R1: a no-write plan returns BEFORE any create/publish/attach call.
      if (started.noWrites) {
        report.status = 'NO_WRITES'
        report.journal = { batchState: journal.state.batchState }
        return report
      }
    } else if (journal.state.batchState === 'IMPORTING') {
      // Resumed mid-import with the recovery judgment already acknowledged:
      // the open intents were judged to be rollback work, so compensate.
      journal.transitionBatch('ROLLING_BACK')
      return await rollbackAndReport({ journal, snapshot, sessions: executionSessions, target, withdrawSession, allowUnprotected, report, jobDir })
    } else {
      throw coded('IMPORT_STATE_UNSUPPORTED', `cannot run from batch state ${journal.state.batchState}`)
    }

    // ---- attachments FIRST (approved sessions are absent at this point).
    const graph = collectAttachmentDependencies(execution)
    for (const invalid of graph.invalid) {
      report.warnings.push({ sessionId: invalid.sessionId, code: invalid.code, message: invalid.message })
    }
    // R3: a session with an INVALID/missing attachment dependency is not
    // completely importable — unless the approved plan explicitly allows a
    // degradation, it must not be imported (and DONE must not mask it).
    const blockedSessions = new Set(graph.invalid.map(x => x.sessionId))
    const importable = execution.filter(s => !blockedSessions.has(s.id))
    for (const id of blockedSessions) {
      report.warnings.push({ sessionId: id, code: 'SESSION_BLOCKED_ATTACHMENT', message: 'session blocked by an invalid attachment dependency' })
    }
    if (importable.length === 0 && blockedSessions.size > 0) {
      report.status = 'ATTACHMENT_BLOCKED'
      return report
    }
    const toImport = importable
    if (graph.objects.length > 0) {
      if (!target.attachments || !target.attachmentRoot || typeof readAttachmentSource !== 'function') {
        throw coded('ATTACHMENT_UNSUPPORTED', 'sessions reference attachments but no attachment store/source is configured')
      }
      const planned = await planAttachmentPublication({
        objects: graph.objects,
        exists: attachmentExists ?? (async () => false),
        readSource: readAttachmentSource,
      })
      const published = await publishAttachments({
        store: target.attachments,
        attachmentRoot: target.attachmentRoot,
        planned,
        journal,
        signal,
      })
      report.attachments = { published: published.published.length, reused: published.reused.length }
    }

    // ---- sessions through the A writer (readback verified per session).
    const imported = []
    for (const session of toImport) {
      signal?.throwIfAborted()
      journal.session(session.id, 'writing')
      const seq = journal.intent({ type: 'session.import', sessionId: session.id })
      const result = await importSessionViaA(persistence, {
        header: session.header,
        events: session.events,
        inheritedEventCount: session.inheritedEventCount ?? 0,
      })
      journal.confirm(seq, { revision: result.revision, cwd: session.header.cwd })
      journal.session(session.id, 'readback-verified')
      imported.push({ session, result })
    }

    // ---- workspace attachment (attachment-before-session is preserved; the
    // workspace metadata follows the created sessions).
    const afterBatchWorkspaces = []
    for (const { session } of imported) {
      if (!session.workspace) continue // committed after verification (R4)
      let ws = workspaceRegistry?.get
        ? workspaceRegistry.list().find(w => w.path === session.workspace.path)
        : undefined
      if (!ws) {
        const wdir = session.workspace.path
        const createSeq = journal.intent({ type: 'workspace.create', workspacePath: wdir })
        ws = await workspaceRegistry.create(wdir, session.workspace.title ?? 'DSHA 导入')
        journal.confirm(createSeq, { workspaceId: ws.id, title: ws.title, path: ws.path })
      }
      const attachSeq = journal.intent({ type: 'session.attach', workspaceId: ws.id, sessionId: session.id })
      await ws.attachSession(session.id)
      journal.confirm(attachSeq, { title: ws.title, path: ws.path })
      afterBatchWorkspaces.push({ id: ws.id, sessionIds: [...ws.sessionIds] })
      journal.session(session.id, 'attached')
    }

    // ---- target verification → commits → DONE.
    signal?.throwIfAborted()
    journal.transitionBatch('VERIFYING_TARGET')
    const allowedNewWorkspaceIds = new Set(journal.state.actions
      .filter(a => a.type === 'workspace.create' && a.stage === 'done' && a.outcome?.workspaceId)
      .map(a => a.outcome.workspaceId))
    const verification = await verifyImportOutcome({
      persistence,
      workspaceRegistry,
      snapshot,
      plannedSessionIds: importable.map(s => s.id),
      allowedNewWorkspaceIds,
    })
    journal.recordVerification(verification)
    report.verification = verification
    if (!verification.ok) {
      // The target does not match this batch's expectation (concurrent
      // changes or a partial failure): nothing is committed past this point.
      report.status = 'VERIFY_FAILED'
      return report
    }
    // Verification passed: NOW commit every session (workspace-mapped ones
    // from 'attached', unmapped ones from 'readback-verified' with the
    // recorded skip reason).
    for (const session of importable) {
      const entry = journal.state.sessions[session.id]
      if (!entry) continue
      if (entry.state === 'attached') journal.session(session.id, 'committed')
      else if (entry.state === 'readback-verified') journal.session(session.id, 'committed', { skipReason: 'no workspace mapping planned (verified)' })
    }
    journal.transitionBatch('DONE')
    report.status = importable.length > 0 ? 'DONE' : 'NO_WRITES'
    report.journal = { batchState: journal.state.batchState, digest: journal.state.digest ?? null }
    return report
  } catch (error) {
    const cancelled = error?.name === 'AbortError' || signal?.aborted === true
    report.status = cancelled ? 'CANCELLED' : 'FAILED'
    // F8/R1: public reports NEVER echo raw lower-layer messages OR raw
    // code/name/stage fields — any of them can carry source fragments (chat
    // text, tool params, credential payloads) from damaged logs or storage
    // errors. Publish only a whitelist-classified code plus a FIXED category
    // line; the raw code/name/stage and detailed evidence live in the
    // private journal.
    report.error = {
      code: publicErrorCode(error),
      message: 'import failed — details in the private journal (public text withheld)',
      publicTextWithheld: true,
    }
    report.errorCodeRaw = undefined // raw code stays OUT of the public report
    // Failure/cancel: compensate through the rollback path when a journal and
    // snapshot exist and we already moved into writing.
    if (journal && journal.state.snapshot && ['IMPORTING', 'VERIFYING_TARGET'].includes(journal.state.batchState)) {
      try {
        journal.transitionBatch('ROLLING_BACK')
        const rolled = await rollbackAndReport({ journal, snapshot: journal.state.snapshot, sessions, target, withdrawSession, allowUnprotected, report, jobDir })
        if (cancelled) {
          // F2: cancel status from the AGGREGATED verdict (action + workspace
          // + final verification), matching the persisted journal terminal.
          rolled.status = rolled.rollback?.outcome === 'complete' ? 'CANCELLED' : 'CANCELLED_ROLLBACK_PENDING'
        }
        return rolled
      } catch (rollbackError) {
        report.rollbackError = {
          code: publicErrorCode(rollbackError, 'ROLLBACK'),
          message: 'rollback compensation failed — details in the private journal (public text withheld)',
          publicTextWithheld: true,
        }
        if (cancelled) report.status = 'CANCELLED_ROLLBACK_INCOMPLETE'
      }
    }
    return report
  } finally {
    // Explicit lifecycle: release the instance lock (guard-busy is retryable).
    try { lock.release() } catch (error) {
      report.lockReleaseError = error.code ?? error.message
    }
  }
}

/**
 * Post-import verification: every planned session exists, every PRE-EXISTING
 * workspace still has its title/path/members and archive/pin state, and the
 * only new registrations are the ones this batch created.
 */
async function verifyImportOutcome({ persistence, workspaceRegistry, snapshot, plannedSessionIds, allowedNewWorkspaceIds }) {
  const diffs = []
  for (const id of plannedSessionIds) {
    if (!(await persistence.stat(id))) diffs.push(`batch session ${id} is missing`)
  }
  if (workspaceRegistry && snapshot) {
    const view = readWorkspaceRegistryView(workspaceRegistry)
    const byId = new Map(view.workspaces.map(w => [w.id, w]))
    for (const before of snapshot.workspaces) {
      const w = byId.get(before.id)
      if (!w) { diffs.push(`pre-existing workspace ${before.id} disappeared`); continue }
      if (w.title !== before.title) diffs.push(`workspace ${before.id} title changed`)
      if (w.path !== before.path) diffs.push(`workspace ${before.id} path changed`)
      for (const sid of before.sessionIds) {
        if (!w.sessionIds.includes(sid)) diffs.push(`workspace ${before.id} lost pre-existing member ${sid}`)
      }
    }
    const archived = new Set(view.archivedSessionIds)
    const pinned = new Set(view.pinnedSessionIds)
    for (const sid of snapshot.archivedSessionIds) if (!archived.has(sid)) diffs.push(`pre-existing archive state lost for ${sid}`)
    for (const sid of snapshot.pinnedSessionIds) if (!pinned.has(sid)) diffs.push(`pre-existing pin lost for ${sid}`)
    for (const id of view.workspaceIds) {
      if (!snapshot.workspaceIds.includes(id) && !allowedNewWorkspaceIds.has(id)) {
        diffs.push(`unexpected new workspace ${id}`)
      }
    }
  }
  return { ok: diffs.length === 0, diffs }
}

async function rollbackAndReport({ journal, snapshot, sessions, target, withdrawSession, allowUnprotected, report, jobDir }) {
  void jobDir
  const before = readWorkspaceRegistryView(target.workspaceRegistry)
  const rb = await rollbackBatch({
    actions: journal.actionsReversed(),
    snapshot,
    plannedSessionIds: sessions.map(s => s.id),
    workspaceRegistry: target.workspaceRegistry,
    persistence: target.persistence,
    withdrawSession,
    journal,
    allowUnprotected,
  })
  // R2: afterBatch is built from THIS BATCH's CONFIRMED action outcomes —
  // never from the current registry, which may contain user changes made
  // after our writes. Fields the batch never touched carry the snapshot's
  // before-value (they are not ours to compensate).
  const afterBatch = buildAfterBatchFromActions({ journal, snapshot, before, current: readWorkspaceRegistryView(target.workspaceRegistry) })
  let workspaceRestore = null
  if (target.workspaceRegistry && snapshot) {
    workspaceRestore = await restoreWorkspaceUnit({
      workspaceRegistry: target.workspaceRegistry,
      snapshot,
      afterBatch,
    })
  }
  // F2: the FINAL target verification runs AFTER the workspace recovery —
  // the action layer's verification predates it and cannot substitute.
  const finalVerification = await verifyTargetRestored({
    persistence: target.persistence,
    workspaceRegistry: target.workspaceRegistry,
    snapshot,
    plannedSessionIds: sessions.map(s => s.id),
  })
  // F2: ONE aggregated verdict over action + workspace + final verification.
  const allComplete = rb.outcome === 'complete'
    && (!workspaceRestore || workspaceRestore.outcome === 'complete')
    && finalVerification.ok
  const aggregated = allComplete ? 'complete' : (rb.failures.length > 0 ? 'failed' : 'pending')
  report.rollback = {
    outcome: aggregated,
    actionOutcome: rb.outcome,
    workspaceOutcome: workspaceRestore?.outcome ?? 'skipped',
    finalVerification,
    conflicts: rb.conflicts.length,
    failures: rb.failures.length,
    workspace: workspaceRestore ? { outcome: workspaceRestore.outcome, pending: workspaceRestore.pending.length, gaps: workspaceRestore.capabilityGaps.length } : null,
  }
  // F2: the aggregated verdict (with its parts) is PERSISTED — the action
  // layer's earlier recordRollback is superseded by this final one.
  journal.recordRollback({
    outcome: aggregated,
    verification: finalVerification,
    conflicts: rb.conflicts,
    failures: rb.failures,
    compensated: rb.compensated,
    actionOutcome: rb.outcome,
    workspaceOutcome: workspaceRestore?.outcome ?? 'skipped',
  })
  if (allComplete) {
    journal.transitionBatch('ROLLED_BACK')
    report.status = 'ROLLED_BACK'
  } else {
    if (journal.state.batchState === 'ROLLING_BACK') journal.transitionBatch('ROLLBACK_PENDING')
    report.status = 'ROLLBACK_PENDING'
  }
  void before
  return report
}

/**
 * R2: derive the batch's after-state from the CONFIRMED journal actions, not
 * from a fresh registry read. For every workspace the batch touched, start
 * from the snapshot's before-value and apply exactly the confirmed changes;
 * untouched workspaces keep the snapshot values verbatim. User changes that
 * happened after our writes therefore have NO permission in the recovery.
 */
function buildAfterBatchFromActions({ journal, snapshot, before, current }) {
  void current
  const view = {
    workspaceIds: [...snapshot.workspaceIds],
    workspaces: snapshot.workspaces.map(w => ({ ...w, sessionIds: [...w.sessionIds] })),
    archivedSessionIds: [...snapshot.archivedSessionIds],
    pinnedSessionIds: [...snapshot.pinnedSessionIds],
  }
  const byId = new Map(view.workspaces.map(w => [w.id, w]))
  const findOrRecord = id => byId.get(id) ?? (byId.set(id, {
    id,
    path: null,
    title: null,
    createdAt: null,
    updatedAt: null,
    sessionIds: [],
  }), byId.get(id))
  for (const action of journal.state.actions) {
    if (action.stage !== 'done') continue
    if (action.type === 'workspace.create') {
      const id = action.outcome?.workspaceId
      if (!id) continue
      view.workspaceIds = [id, ...view.workspaceIds.filter(x => x !== id)]
      const record = findOrRecord(id)
      record.path = action.outcome.path ?? record.path
      record.title = action.outcome.title ?? record.title
    } else if (action.type === 'session.attach') {
      const id = action.workspaceId
      if (!id) continue
      const record = findOrRecord(id)
      if (action.sessionId && !record.sessionIds.includes(action.sessionId)) record.sessionIds.unshift(action.sessionId)
    } else if (action.type === 'session.detach') {
      const id = action.workspaceId
      if (!id) continue
      const record = findOrRecord(id)
      record.sessionIds = record.sessionIds.filter(x => x !== action.sessionId)
    }
  }
  // Entities that only exist in `before` (pre-existing) but were NOT in the
  // durable order at snapshot time are impossible: the snapshot IS the
  // before. Keep the snapshot's order for pre-existing ids; created ids go
  // first (registry.create prepends).
  const snapshotOrder = new Set(snapshot.workspaceIds)
  const createdOrder = view.workspaceIds.filter(id => !snapshotOrder.has(id))
  view.workspaceIds = [...createdOrder, ...snapshot.workspaceIds]
  view.workspaces = view.workspaceIds.map(id => byId.get(id)).filter(Boolean)
  return view
}

/** Lightweight lock/job inspection for the UI (no writes). */
export function inspectJob({ instanceLockDir }) {
  return peekJobLock(instanceLockDir)
}
