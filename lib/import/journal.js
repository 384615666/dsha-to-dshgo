// Persistent import job journal (plan §8): the durable state machine that
// makes every write recoverable. The journal is atomically persisted (temp
// file + fsync + rename), bound to ONE target instance fingerprint and ONE
// source digest, and records every ownership-relevant action as an
// INTENT (persisted BEFORE the side effect) confirmed by an OUTCOME
// (persisted after) — so a crash between the two leaves a judgeable
// "result unknown" record instead of a silent gap.
//
// Durability phases are distinguished:
//   - failures BEFORE the atomic replace leave the previous record intact and
//     revert the in-memory state;
//   - a failure AFTER the replace (directory-entry fsync) leaves the new
//     record on disk but its durability unknown — the journal adopts the disk
//     state, marks `durabilityUnknown`, refuses further transitions, and
//     requires an explicit re-check (`resolveDurabilityUnknown`) before the
//     job continues. It is never silently reverted to a state the disk no
//     longer holds.
//
// States (batch): NEW → PLANNED → SNAPSHOT_READY → IMPORTING →
// VERIFYING_TARGET → DONE | ROLLING_BACK → ROLLED_BACK | ROLLBACK_PENDING
// | FAILED. IMPORTING requires a persisted G6 snapshot bound to the journal;
// DONE requires every planned session committed with no open intents and a
// recorded successful verification; ROLLED_BACK requires a recorded
// completed rollback verification.

import fs from 'node:fs'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { computeSnapshotDigest } from './g6.js'
import { validatePlanContent, loadPlan } from './plan.js'

export const BATCH_STATES = ['NEW', 'PLANNED', 'SNAPSHOT_READY', 'IMPORTING', 'VERIFYING_TARGET', 'DONE', 'ROLLING_BACK', 'ROLLED_BACK', 'ROLLBACK_PENDING', 'FAILED']

const BATCH_TRANSITIONS = {
  NEW: ['PLANNED', 'FAILED'],
  PLANNED: ['SNAPSHOT_READY', 'FAILED'],
  SNAPSHOT_READY: ['IMPORTING', 'ROLLING_BACK', 'FAILED'],
  IMPORTING: ['VERIFYING_TARGET', 'ROLLING_BACK', 'ROLLBACK_PENDING', 'FAILED'],
  VERIFYING_TARGET: ['DONE', 'ROLLING_BACK', 'ROLLBACK_PENDING', 'FAILED'],
  ROLLING_BACK: ['ROLLED_BACK', 'ROLLBACK_PENDING', 'FAILED'],
  ROLLBACK_PENDING: ['ROLLING_BACK', 'FAILED'],
  FAILED: [],
  DONE: [],
  ROLLED_BACK: [],
}

const SESSION_TRANSITIONS = {
  planned: ['snapshot-ready', 'writing', 'readback-verified', 'attached', 'committed', 'rolled-back', 'failed'],
  'snapshot-ready': ['writing', 'readback-verified', 'attached', 'committed', 'rolled-back', 'failed'],
  writing: ['readback-verified', 'attached', 'committed', 'rolled-back', 'failed'],
  'readback-verified': ['attached', 'committed', 'rolled-back', 'failed'],
  attached: ['committed', 'rolled-back', 'failed'],
  committed: ['rolled-back'],
  'rolled-back': [],
  failed: [],
}

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

/**
 * Approved-plan gate, shared by assertApprovedPlan() and beginImport():
 * the plan's ACTUAL content must hash to the approved digest, its source and
 * target must match the journal binding, a bound plan file (if recorded) must
 * still hold that version, and the selected/excluded set must match the
 * persisted plan. Nothing here trusts a plan object's own digest field.
 */
function assertApprovedPlanAgainst(journal, plan) {
  const approved = journal.state.approvedPlan
  if (!approved?.digest) {
    throw coded('JOURNAL_PLAN_MISMATCH', 'no approved plan is bound to this journal — the preview was never confirmed')
  }
  const { digest } = validatePlanContent(plan)
  if (digest !== approved.digest) {
    throw coded('JOURNAL_PLAN_MISMATCH', 'the plan being executed is not the approved version (content digest differs) — re-plan and re-confirm')
  }
  if (plan.sourceDigest !== journal.state.binding.sourceDigest) {
    throw coded('JOURNAL_PLAN_BINDING', 'the plan was produced from a different source backup than this journal')
  }
  if (plan.target?.instanceFingerprint !== journal.state.binding.instanceFingerprint) {
    throw coded('JOURNAL_PLAN_BINDING', 'the plan targets a different instance than this journal')
  }
  // A file recorded at approval time must STILL hold the approved version —
  // a re-planned file that replaced it invalidates the confirmation.
  if (approved.file) {
    let onDisk
    try {
      onDisk = loadPlan(approved.file, {
        sourceDigest: journal.state.binding.sourceDigest,
        instanceFingerprint: journal.state.binding.instanceFingerprint,
      })
    } catch (error) {
      if (error?.code === 'PLAN_MISSING') {
        throw coded('JOURNAL_PLAN_MISMATCH', 'the approved plan file is missing — re-plan and re-confirm')
      }
      throw error
    }
    if (onDisk.digest !== approved.digest) {
      throw coded('JOURNAL_PLAN_MISMATCH', 'the bound plan file no longer holds the approved version — re-plan and re-confirm')
    }
  }
  // The plan's session set must agree with the persisted G6 plan.
  const planned = journal.state.snapshot?.ownership?.plannedCreates?.map(x => x.id)
  if (Array.isArray(planned) && planned.length > 0) {
    const selected = new Set(plan.selected ?? [])
    const excluded = new Set((plan.excluded ?? []).map(e => e.id))
    for (const id of selected) {
      if (!planned.includes(id)) throw coded('JOURNAL_PLAN_BINDING', `selected session ${id} is not in the persisted plan`)
    }
    for (const id of planned) {
      if (!selected.has(id) && !excluded.has(id)) throw coded('JOURNAL_PLAN_BINDING', `planned session ${id} is neither selected nor excluded`)
    }
  }
  return { digest }
}

// Verified platform limitation for DIRECTORY-entry fsync. File-content fsync
// is always strict. Only the listed (OS, error) pairs degrade, each with
// evidence recorded in the returned channel: Windows refuses directory
// fsync with EPERM (measured on this target); capability-less platforms
// report ENOSYS.
function dirFsyncUnsupported(error) {
  const code = error?.code
  if (process.platform === 'win32') return ['EPERM', 'EISDIR', 'EINVAL', 'EBUSY'].includes(code)
  return code === 'ENOSYS'
}

function persistAtomically(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const json = JSON.stringify(value, null, 1)
  const fd = openSync(tmp, 'w', 0o600)
  let replaced = false
  try {
    writeSync(fd, json)
    try {
      fs.fsyncSync(fd)
    } catch (error) {
      // A real I/O failure must abort BEFORE the atomic replace — the
      // previous record stays authoritative.
      if (error?.code !== 'ENOSYS') throw error
    }
    closeSync(fd)
    renameSync(tmp, file)
    replaced = true
    // Directory-entry durability where the platform supports it.
    let dfd
    try {
      dfd = openSync(dirname(file), 'r')
    } catch (error) {
      if (dirFsyncUnsupported(error)) return { directoryFsync: 'unsupported' }
      throw error
    }
    try {
      try {
        fs.fsyncSync(dfd)
      } catch (error) {
        if (dirFsyncUnsupported(error)) return { directoryFsync: 'unsupported' }
        // Post-replace I/O failure: the new content is on disk but its
        // directory entry durability is UNKNOWN — mark for the caller.
        error.replaced = true
        throw error
      }
    } finally {
      closeSync(dfd)
    }
    return { directoryFsync: 'synced' }
  } catch (error) {
    try { closeSync(fd) } catch { /* already closed */ }
    if (replaced && error && !error.replaced) error.replaced = true
    throw error
  }
}

export class ImportJournal {
  /**
   * Internal. Use {@link ImportJournal.init} (new job) or
   * {@link ImportJournal.load} (restore) — loading must never take the
   * persisting constructor path.
   */
  constructor(file, binding, state = null, options = {}) {
    this.file = file
    this.state = state ?? {
      version: 2,
      binding: { instanceFingerprint: binding.instanceFingerprint, sourceDigest: binding.sourceDigest },
      gates: { requirePlanApproval: options.requirePlanApproval === true },
      batchState: 'NEW',
      snapshot: null,
      approvedPlan: null,
      sessions: {},
      actions: [],
      conflicts: [],
      history: [],
    }
  }

  /** Derived on every load — never persisted as its own field. */
  get recovered() {
    return !['NEW', 'DONE', 'ROLLED_BACK'].includes(this.state.batchState)
  }

  get durabilityUnknown() {
    return this.state.durabilityUnknown ?? null
  }

  /** Create a NEW journal; refuses to overwrite an existing one. */
  static init(file, binding, options = {}) {
    if (existsSync(file)) {
      throw coded('JOURNAL_ALREADY_EXISTS', 'journal already exists — init refuses to overwrite an existing job record')
    }
    const journal = new ImportJournal(file, binding, null, options)
    journal.persist()
    return journal
  }

  /**
   * Restore a journal FROM DISK WITHOUT WRITING. Validates the binding and
   * record shape; `recovered` flags a mid-import reload for the caller's
   * recovery check (never auto-replay).
   */
  static load(file, binding) {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw?.binding?.instanceFingerprint !== binding.instanceFingerprint
      || raw?.binding?.sourceDigest !== binding.sourceDigest) {
      throw coded('JOURNAL_BINDING_MISMATCH', 'journal belongs to a different target instance or source digest — never replay it')
    }
    if (!BATCH_STATES.includes(raw.batchState) || !Array.isArray(raw.actions) || typeof raw.binding !== 'object') {
      throw coded('JOURNAL_MALFORMED', 'journal record is malformed — refusing to restore')
    }
    if (raw.snapshot && computeSnapshotDigest(raw.snapshot) !== raw.snapshot.digest) {
      throw coded('JOURNAL_MALFORMED', 'journal snapshot does not match its digest — refusing to restore')
    }
    const journal = new ImportJournal(file, binding, raw)
    // Conservative admission: a RESTORED non-terminal record always requires
    // an explicit recovery check before any mutation — whether or not the
    // durability seal marker itself managed to persist.
    journal.needsRecoveryCheck = !['NEW', 'DONE', 'ROLLED_BACK'].includes(raw.batchState) || Boolean(raw.durabilityUnknown)
    return journal
  }

  /**
   * Apply an in-memory mutation, persist atomically, and revert the memory
   * on PRE-replace failures. A POST-replace failure (durability unknown)
   * adopts the disk state instead of pretending the write never happened.
   */
  mutate(fn) {
    const previous = JSON.parse(JSON.stringify(this.state))
    let result
    try {
      result = fn(this.state)
      this.persist()
    } catch (error) {
      if (error && error.replaced) {
        // The rename landed: the DISK holds the new record. Re-read it,
        // mark the durability gap, and seal the job until an explicit check.
        let disk = null
        try { disk = JSON.parse(readFileSync(this.file, 'utf8')) } catch { disk = null }
        if (disk) this.state = disk
        this.state.durabilityUnknown = {
          at: new Date().toISOString(),
          phase: 'directory-fsync',
          code: error.code ?? null,
        }
        // The seal marker write is BEST EFFORT; conservative admission does
        // NOT depend on it: any restored non-terminal record requires an
        // explicit recovery check regardless (see needsRecoveryCheck).
        try { this.persist() } catch { /* the in-process seal still holds; reload also re-verifies */ }
        this.needsRecoveryCheck = true
        throw coded('JOURNAL_DURABILITY_UNKNOWN', 'journal replacement is durability-unknown: content was renamed into place but the directory entry could not be synced — reload and verify before continuing', { causeCode: error.code ?? null })
      }
      this.state = previous
      throw error
    }
    return result
  }

  /**
   * Every mutator refuses while the journal is sealed OR while a RESTORED
   * non-terminal record has not passed an explicit recovery check. The
   * recovery requirement is derived from the durable state itself (not from
   * an I/O-dependent marker), so a failed seal write can never let a new
   * process advance unchecked.
   */
  requireHealthy() {
    if (this.state.durabilityUnknown) {
      throw coded('JOURNAL_DURABILITY_UNKNOWN', 'journal is sealed pending a durability re-check (acknowledgeRecovery)')
    }
    if (this.needsRecoveryCheck) {
      throw coded('JOURNAL_RECOVERY_REQUIRED', 'this journal was restored mid-job — an explicit recovery check (acknowledgeRecovery) is required before any change')
    }
  }

  /**
   * Full validation of a disk record: binding (instance AND source digest),
   * structure, and — when present — the snapshot digest. Returns the parsed
   * record; throws on any mismatch. Never mutates.
   */
  readAndValidateDisk() {
    const raw = JSON.parse(readFileSync(this.file, 'utf8'))
    if (raw?.binding?.instanceFingerprint !== this.state.binding.instanceFingerprint
      || raw?.binding?.sourceDigest !== this.state.binding.sourceDigest) {
      throw coded('JOURNAL_BINDING_MISMATCH', 'disk journal does not belong to this job (instance fingerprint or source digest differs)')
    }
    if (!BATCH_STATES.includes(raw.batchState) || !Array.isArray(raw.actions) || typeof raw.binding !== 'object') {
      throw coded('JOURNAL_MALFORMED', 'disk journal is malformed — refusing to restore')
    }
    if (raw.snapshot && computeSnapshotDigest(raw.snapshot) !== raw.snapshot.digest) {
      throw coded('JOURNAL_MALFORMED', 'disk journal snapshot does not match its digest — refusing to restore')
    }
    return raw
  }

  /**
   * Explicit recovery check. Re-reads and fully validates the disk record
   * (both binding fields, structure, snapshot digest), adopts it, records
   * the check, and clears the seal + recovery requirement. The caller must
   * still judge open intents — this acknowledges the record, it does NOT
   * replay or judge anything.
   */
  acknowledgeRecovery() {
    const raw = this.readAndValidateDisk()
    this.state = raw
    this.mutate(state => {
      delete state.durabilityUnknown
      state.recoveryAcknowledged = {
        at: new Date().toISOString(),
        batchState: state.batchState,
        openIntents: state.actions.filter(a => a.stage === 'intent').length,
        snapshotDigest: state.snapshot?.digest ?? null,
      }
    })
    this.needsRecoveryCheck = false
    return this.state
  }

  /** Backwards-compatible alias for the recovery check. */
  resolveDurabilityUnknown() {
    return this.acknowledgeRecovery()
  }

  persist() {
    persistAtomically(this.file, this.state)
  }

  /** Bind the G6 snapshot INTO the journal (digest re-verified on IMPORTING). */
  setSnapshot(snapshot) {
    this.requireHealthy()
    this.mutate(state => {
      state.snapshot = snapshot
    })
  }

  /**
   * Bind the USER-APPROVED plan version. This is the confirmation boundary:
   * the approved digest is persisted in the journal and re-checked when the
   * job is loaded/started — a re-planned (different-digest) preview is not
   * the version the user confirmed.
   */
  approvePlan({ digest, file }) {
    this.requireHealthy()
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      throw coded('JOURNAL_PLAN_INVALID', 'an approved plan digest (sha256 hex) is required')
    }
    this.mutate(state => {
      state.approvedPlan = { digest, file: file ?? null, approvedAt: new Date().toISOString() }
    })
  }

  /**
   * Full self-validation of a plan OBJECT in memory: content must produce the
   * digest it claims, and the source/target binding must be present.
   */
  static validatePlanContent(plan) {
    return validatePlanContent(plan)
  }

  /**
   * Load-time/start-time check: the plan being executed must be the APPROVED
   * version — verified against its ACTUAL CONTENT, its source/target binding
   * and the journal's planned session set. A stored digest string is never
   * trusted on its own, and a file replaced after approval is caught too.
   */
  assertApprovedPlan(plan) {
    this.requireHealthy()
    assertApprovedPlanAgainst(this, plan)
    return true
  }

  get requiresPlanApproval() {
    return this.state.gates?.requirePlanApproval === true
  }

  /**
   * The single production entry for starting a write. With plan approval
   * required, the actual plan object is validated here and the same version
   * is recorded as the importing version; the raw transitionBatch('IMPORTING')
   * refuses in that mode (there is no approved-content check without a plan).
   */
  beginImport(plan) {
    this.requireHealthy()
    if (!this.requiresPlanApproval) {
      this.transitionBatch('IMPORTING')
      return { approved: false, digest: null }
    }
    const { digest } = assertApprovedPlanAgainst(this, plan)
    this.mutate(state => {
      const from = state.batchState
      if (from !== 'SNAPSHOT_READY') {
        throw new Error(`illegal batch journal transition ${from} -> IMPORTING`)
      }
      if (!state.snapshot) throw new Error('IMPORTING requires a persisted G6 snapshot bound to this journal')
      if (computeSnapshotDigest(state.snapshot) !== state.snapshot.digest) {
        throw new Error('the persisted G6 snapshot does not match its digest — refusing IMPORTING')
      }
      state.importingPlan = { digest, at: new Date().toISOString() }
      state.batchState = 'IMPORTING'
      state.history.push({ at: new Date().toISOString(), from, to: 'IMPORTING' })
    })
    return { approved: true, digest }
  }

  transitionBatch(to) {
    this.requireHealthy()
    return this.mutate(state => {
      const from = state.batchState
      if (!BATCH_TRANSITIONS[from]?.includes(to)) {
        throw new Error(`illegal batch journal transition ${from} -> ${to}`)
      }
      if (to === 'IMPORTING') {
        if (!state.snapshot) {
          throw new Error('IMPORTING requires a persisted G6 snapshot bound to this journal')
        }
        if (computeSnapshotDigest(state.snapshot) !== state.snapshot.digest) {
          throw new Error('the persisted G6 snapshot does not match its digest — refusing IMPORTING')
        }
        if (state.gates?.requirePlanApproval === true) {
          // The raw transition may not bypass the approved-content check:
          // beginImport(plan) records the verified version first.
          if (!state.importingPlan?.digest) {
            throw coded('JOURNAL_PLAN_MISMATCH', 'IMPORTING requires beginImport(plan) so the approved plan CONTENT is verified')
          }
          if (state.importingPlan.digest !== state.approvedPlan?.digest) {
            throw coded('JOURNAL_PLAN_MISMATCH', 'the importing plan version is not the approved one')
          }
        }
      }
      if (to === 'DONE') {
        // Terminal success must be EARNED against the COMPLETE persisted
        // plan — not merely against whichever session entries happened to be
        // created. A planned id that never got a state entry is UNFINISHED.
        const planned = state.snapshot?.ownership?.plannedCreates?.map(x => x.id)
        if (!Array.isArray(planned) || planned.length === 0) {
          throw new Error('DONE requires a persisted plan (snapshot.ownership.plannedCreates)')
        }
        const excluded = new Map((state.partial?.excluded ?? []).map(e => [e.id, e]))
        const unfinished = planned.filter(id => {
          const st = state.sessions[id]?.state
          if (st === 'committed') return false
          // An explicitly recorded exclusion (with a reason) is a decision,
          // not a silent gap.
          return !(excluded.has(id) && excluded.get(id).reason)
        })
        if (unfinished.length > 0) {
          throw new Error(`DONE refused: planned sessions not committed: ${unfinished.join(', ')}`)
        }
        for (const id of excluded.keys()) {
          if (!planned.includes(id)) throw new Error(`DONE refused: exclusion ${id} is not in the persisted plan`)
        }
        const open = state.actions.filter(a => a.stage === 'intent')
        if (open.length > 0) {
          throw new Error(`DONE refused: ${open.length} unconfirmed action intent(s) remain`)
        }
        if (!state.verification?.ok) {
          throw new Error('DONE refused: no recorded successful target verification')
        }
        if (excluded.size > 0) {
          // A partial batch is NOT a full success — record it as such.
          state.outcome = 'PARTIAL'
          state.partialExcluded = [...excluded.values()]
        } else {
          state.outcome = 'DONE'
        }
      }
      if (to === 'ROLLED_BACK') {
        if (!state.rollback?.verification?.ok || state.rollback.outcome !== 'complete') {
          throw new Error('ROLLED_BACK refused: no recorded completed rollback verification')
        }
        const open = state.actions.filter(a => a.stage === 'intent')
        if (open.length > 0) {
          throw new Error(`ROLLED_BACK refused: ${open.length} unconfirmed action intent(s) remain`)
        }
      }
      state.batchState = to
      state.history.push({ at: new Date().toISOString(), from, to })
    })
  }

  /** Record an explicit partial decision (excluded planned ids + reasons). */
  recordPartial(excluded) {
    this.requireHealthy()
    if (!Array.isArray(excluded) || excluded.some(e => !e?.id || !e?.reason)) {
      throw new Error('recordPartial requires [{id, reason}] with a reason for every exclusion')
    }
    this.mutate(state => {
      state.partial = { at: new Date().toISOString(), excluded: excluded.map(e => ({ id: e.id, reason: e.reason })) }
    })
  }

  /** Record the target verification evidence DONE depends on. */
  recordVerification(result) {
    this.requireHealthy()
    this.mutate(state => {
      state.verification = { at: new Date().toISOString(), ok: result?.ok === true, diffs: result?.diffs ?? [] }
    })
  }

  /**
   * Record a rollback verdict (complete / pending / failed) WITH its
   * conflicts and failures — persisted for every branch, so a restart can
   * judge the compensation outcome. A failed verdict keeps the job resumable
   * (ROLLBACK_PENDING), never a silent return-value-only failure.
   */
  recordRollback({ outcome, verification, conflicts = [], failures = [], compensated = [] }) {
    this.requireHealthy()
    this.mutate(state => {
      state.rollback = {
        at: new Date().toISOString(),
        outcome,
        verification: verification ? { ok: verification.ok === true, diffs: verification.diffs ?? [] } : null,
        failures,
        compensated,
      }
      if (conflicts.length > 0) {
        state.conflicts.push(...conflicts.map(c => ({ at: new Date().toISOString(), ...c })))
      }
      if (outcome !== 'complete' && state.batchState === 'ROLLING_BACK') {
        state.batchState = 'ROLLBACK_PENDING'
        state.history.push({ at: new Date().toISOString(), from: 'ROLLING_BACK', to: 'ROLLBACK_PENDING' })
      }
    })
  }

  /** Record an INTENT before performing the side effect (returns action seq). */
  intent(action) {
    this.requireHealthy()
    return this.mutate(state => {
      const seq = state.actions.length + 1
      state.actions.push({ seq, at: new Date().toISOString(), stage: 'intent', ...action })
      return seq
    })
  }

  /** Confirm an intent AFTER the side effect with its actual outcome. */
  confirm(seq, outcome = {}) {
    this.requireHealthy()
    this.mutate(state => {
      const action = state.actions.find(x => x.seq === seq)
      if (!action || action.stage !== 'intent') {
        throw new Error(`action ${seq} is not an open intent`)
      }
      action.stage = 'done'
      action.outcome = { at: new Date().toISOString(), ...outcome }
    })
  }

  session(sessionId, to, { skipReason } = {}) {
    this.requireHealthy()
    return this.mutate(state => {
      const entry = state.sessions[sessionId] ??= { state: 'planned' }
      if (!SESSION_TRANSITIONS[entry.state]?.includes(to)) {
        throw new Error(`illegal session journal transition ${sessionId}: ${entry.state} -> ${to}`)
      }
      if (to === 'committed') {
        if (!['readback-verified', 'attached'].includes(entry.state)) {
          throw new Error(`session ${sessionId} cannot commit from ${entry.state}: readback/attachment evidence is missing`)
        }
        if (!['VERIFYING_TARGET'].includes(state.batchState)) {
          throw new Error(`session ${sessionId} cannot commit while the batch is ${state.batchState} — evidence is judged in VERIFYING_TARGET`)
        }
        const unresolved = state.actions.filter(a => a.sessionId === sessionId && a.stage === 'intent')
        if (unresolved.length > 0) {
          throw new Error(`session ${sessionId} has ${unresolved.length} unconfirmed action intents — judge them before commit`)
        }
        if (entry.state === 'readback-verified' && !skipReason) {
          throw new Error(`session ${sessionId} commits from readback-verified without an attachment — record the verified skipReason`)
        }
        if (skipReason) entry.skip = { step: 'attach', reason: skipReason }
      }
      entry.state = to
    })
  }

  /** Persist rollback conflicts (§8: pending states keep their reasons). */
  recordConflicts(conflicts) {
    this.requireHealthy()
    this.mutate(state => {
      state.conflicts.push(...conflicts.map(c => ({ at: new Date().toISOString(), ...c })))
    })
  }

  /** Reverse-order view of the recorded actions. */
  actionsReversed() {
    return [...this.state.actions].reverse()
  }
}
