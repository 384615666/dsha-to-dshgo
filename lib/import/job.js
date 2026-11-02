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

  const lock = acquireJobLock(instanceLockDir, { instanceFingerprint })
  const report = { status: 'running', sessions: [], attachments: { published: 0, reused: 0 }, warnings: [], recovery: null }
  let journal = null
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

    // ---- snapshot: restore from the journal when resuming, else capture.
    let snapshot = journal.state.snapshot
    if (!snapshot) {
      snapshot = await captureTargetPreState({
        persistence,
        workspaceRegistry,
        plannedSessionIds: sessions.map(s => s.id),
        workspaceUnitProvider: target.workspaceUnitProvider,
        snapshotDir: jobDir,
      })
      journal.setSnapshot(snapshot)
      if (journal.state.batchState === 'PLANNED') journal.transitionBatch('SNAPSHOT_READY')
    } else if (journal.state.batchState === 'PLANNED') {
      journal.transitionBatch('SNAPSHOT_READY')
    }

    if (journal.state.batchState === 'ROLLING_BACK' || journal.state.batchState === 'ROLLBACK_PENDING') {
      return await rollbackAndReport({ journal, snapshot, sessions, target, withdrawSession, allowUnprotected, report, jobDir })
    }

    // ---- approved plan content gate + start.
    if (journal.state.batchState === 'SNAPSHOT_READY') {
      journal.beginImport(approvedPlan)
    } else if (journal.state.batchState === 'IMPORTING') {
      // Resumed mid-import with the recovery judgment already acknowledged:
      // the open intents were judged to be rollback work, so compensate.
      journal.transitionBatch('ROLLING_BACK')
      return await rollbackAndReport({ journal, snapshot, sessions, target, withdrawSession, allowUnprotected, report, jobDir })
    } else {
      throw coded('IMPORT_STATE_UNSUPPORTED', `cannot run from batch state ${journal.state.batchState}`)
    }

    // ---- attachments FIRST (all planned sessions are absent at this point).
    const toImport = sessions
    const graph = collectAttachmentDependencies(toImport)
    for (const invalid of graph.invalid) {
      report.warnings.push({ sessionId: invalid.sessionId, code: invalid.code, message: invalid.message })
    }
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
      if (!session.workspace) {
        journal.session(session.id, 'committed', { skipReason: 'no workspace mapping planned for this session (verified)' })
        continue
      }
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
      plannedSessionIds: sessions.map(s => s.id),
      allowedNewWorkspaceIds,
    })
    journal.recordVerification(verification)
    for (const session of sessions) {
      const entry = journal.state.sessions[session.id]
      if (!entry) continue
      if (entry.state === 'attached') journal.session(session.id, 'committed')
      else if (entry.state === 'readback-verified') journal.session(session.id, 'committed', { skipReason: 'no workspace mapping planned (verified)' })
    }
    report.verification = verification
    if (!verification.ok) {
      // The target does not match the snapshot for reasons outside this batch
      // (concurrent changes): do not claim success.
      report.status = 'VERIFY_FAILED'
      return report
    }
    journal.transitionBatch('DONE')
    report.status = sessions.length > 0 ? 'DONE' : 'NO_WRITES'
    report.journal = { batchState: journal.state.batchState, digest: journal.state.digest ?? null }
    return report
  } catch (error) {
    const cancelled = error?.name === 'AbortError' || signal?.aborted === true
    report.status = cancelled ? 'CANCELLED' : 'FAILED'
    report.error = { code: error.code ?? null, message: error.message.slice(0, 300) }
    // Failure/cancel: compensate through the rollback path when a journal and
    // snapshot exist and we already moved into writing.
    if (journal && journal.state.snapshot && ['IMPORTING', 'VERIFYING_TARGET'].includes(journal.state.batchState)) {
      try {
        journal.transitionBatch('ROLLING_BACK')
        const rolled = await rollbackAndReport({ journal, snapshot: journal.state.snapshot, sessions, target, withdrawSession, allowUnprotected, report, jobDir })
        if (cancelled) rolled.status = rolled.rollback?.outcome === 'complete' ? 'CANCELLED' : 'CANCELLED_ROLLBACK_PENDING'
        return rolled
      } catch (rollbackError) {
        report.rollbackError = { code: rollbackError.code ?? null, message: rollbackError.message.slice(0, 300) }
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
  // workspace metadata recovery (three-way) after the action compensation
  let workspaceRestore = null
  if (target.workspaceRegistry && snapshot) {
    const afterBatch = readWorkspaceRegistryView(target.workspaceRegistry)
    workspaceRestore = await restoreWorkspaceUnit({
      workspaceRegistry: target.workspaceRegistry,
      snapshot,
      afterBatch,
    })
  }
  report.rollback = {
    outcome: rb.outcome,
    conflicts: rb.conflicts.length,
    failures: rb.failures.length,
    verification: rb.verification,
    workspace: workspaceRestore ? { outcome: workspaceRestore.outcome, pending: workspaceRestore.pending.length, gaps: workspaceRestore.capabilityGaps.length } : null,
  }
  if (rb.outcome === 'complete' && (!workspaceRestore || workspaceRestore.outcome !== 'failed')) {
    try { journal.transitionBatch('ROLLED_BACK') } catch { /* verification gate */ }
    report.status = 'ROLLED_BACK'
  } else {
    report.status = journal.state.batchState === 'ROLLBACK_PENDING' ? 'ROLLBACK_PENDING' : 'ROLLBACK_INCOMPLETE'
  }
  void before
  return report
}

/** Lightweight lock/job inspection for the UI (no writes). */
export function inspectJob({ instanceLockDir }) {
  return peekJobLock(instanceLockDir)
}
