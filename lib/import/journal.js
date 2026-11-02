// Persistent import job journal (plan §8): the durable state machine that
// makes every write recoverable. The journal is atomically persisted (temp
// file + fsync + rename), bound to ONE target instance fingerprint and ONE
// source digest, and records every ownership-relevant action as an
// INTENT (persisted BEFORE the side effect) confirmed by an OUTCOME
// (persisted after) — so a crash between the two leaves a judgeable
// "result unknown" record instead of a silent gap. One import job at a time
// per target instance; a journal reloaded mid-import flags recovery and is
// never auto-replayed.
//
// Durability scope: FILE content fsync failures are real errors and abort the
// transition; only a platform that does not implement fsync at all (ENOSYS)
// is a documented degradation. Parent-directory entry fsync is enforced where
// the OS allows opening directories (Linux/Android/PRoot target); Windows
// refusing a directory handle is recorded as a platform limitation, not
// silently treated as durability.
//
// States (batch): NEW → PLANNED → SNAPSHOT_READY → IMPORTING →
// VERIFYING_TARGET → DONE | ROLLING_BACK → ROLLED_BACK | ROLLBACK_PENDING
// | FAILED. IMPORTING requires a persisted G6 snapshot bound to the journal
// (digest re-verified from disk). Per session: planned → snapshot-ready →
// writing → readback-verified → attached → committed (commit requires the
// batch to be VERIFYING_TARGET, evidence states, and no unconfirmed intents;
// a skipped step needs an explicit recorded reason).

import fs from 'node:fs'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { computeSnapshotDigest } from './g6.js'

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

function persistAtomically(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const json = JSON.stringify(value, null, 1)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, json)
    try {
      fs.fsyncSync(fd)
    } catch (error) {
      // A real I/O failure (EIO…) must abort the transition — the caller
      // must never observe "advanced" state without durable content. Only a
      // platform without fsync at all degrades, explicitly.
      if (error?.code !== 'ENOSYS') throw error
    }
    closeSync(fd)
    renameSync(tmp, file)
    // Directory-entry durability where supported; on Windows opening a
    // directory fails (EPERM/EISDIR) — a recorded platform limitation.
    let dfd
    try {
      dfd = openSync(dirname(file), 'r')
    } catch (error) {
      if (!['ENOSYS', 'EISDIR', 'EPERM', 'EINVAL', 'EBUSY'].includes(error?.code)) throw error
      void dfd
      return
    }
    try {
      try { fs.fsyncSync(dfd) } catch (error) {
        // Windows refuses directory fsync with EPERM (verified on this
        // target); other platforms without the capability give ENOSYS. Both
        // are the documented directory-entry durability limitation — the
        // FILE content fsync above stays strict.
        if (!['ENOSYS', 'EPERM'].includes(error?.code)) throw error
      }
    } finally {
      closeSync(dfd)
    }
  } catch (error) {
    try { closeSync(fd) } catch { /* already closed */ }
    throw error
  }
}

export class ImportJournal {
  /**
   * Internal. Use {@link ImportJournal.init} (new job) or
   * {@link ImportJournal.load} (restore) — loading must never take the
   * persisting constructor path.
   */
  constructor(file, binding, state = null) {
    this.file = file
    this.state = state ?? {
      version: 1,
      binding: { instanceFingerprint: binding.instanceFingerprint, sourceDigest: binding.sourceDigest },
      batchState: 'NEW',
      snapshot: null,
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

  /** Create a NEW journal; refuses to overwrite an existing one. */
  static init(file, binding) {
    if (existsSync(file)) {
      const e = new Error('journal already exists — init refuses to overwrite an existing job record')
      e.code = 'JOURNAL_ALREADY_EXISTS'
      throw e
    }
    const journal = new ImportJournal(file, binding)
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
      const e = new Error('journal belongs to a different target instance or source digest — never replay it')
      e.code = 'JOURNAL_BINDING_MISMATCH'
      throw e
    }
    if (!BATCH_STATES.includes(raw.batchState) || !Array.isArray(raw.actions) || typeof raw.binding !== 'object') {
      const e = new Error('journal record is malformed — refusing to restore')
      e.code = 'JOURNAL_MALFORMED'
      throw e
    }
    return new ImportJournal(file, binding, raw)
  }

  /**
   * Every mutator: apply in memory, persist atomically; a persistence
   * failure REVERTS the in-memory state and rethrows — the caller must treat
   * the transition as not having happened (the disk keeps the previous valid
   * record).
   */
  mutate(fn) {
    const previous = JSON.parse(JSON.stringify(this.state))
    let result
    try {
      result = fn(this.state)
      this.persist()
    } catch (error) {
      this.state = previous
      throw error
    }
    return result
  }

  persist() {
    persistAtomically(this.file, this.state)
  }

  /** Bind the G6 snapshot INTO the journal (digest re-verified on IMPORTING). */
  setSnapshot(snapshot) {
    this.mutate(state => {
      state.snapshot = snapshot
    })
  }

  transitionBatch(to) {
    return this.mutate(state => {
      const from = state.batchState
      if (!BATCH_TRANSITIONS[from]?.includes(to)) {
        throw new Error(`illegal batch journal transition ${from} -> ${to}`)
      }
      if (to === 'IMPORTING') {
        // The gate: a persisted snapshot must exist AND its stored content
        // must still match its own digest (tamper/corruption refuses).
        if (!state.snapshot) {
          throw new Error('IMPORTING requires a persisted G6 snapshot bound to this journal')
        }
        if (computeSnapshotDigest(state.snapshot) !== state.snapshot.digest) {
          throw new Error('the persisted G6 snapshot does not match its digest — refusing IMPORTING')
        }
      }
      state.batchState = to
      state.history.push({ at: new Date().toISOString(), from, to })
    })
  }

  /**
   * Record an INTENT before performing the side effect. Returns the action
   * seq — pass it to confirm() after the effect completed.
   */
  intent(action) {
    return this.mutate(state => {
      const seq = state.actions.length + 1
      state.actions.push({ seq, at: new Date().toISOString(), stage: 'intent', ...action })
      return seq
    })
  }

  /** Confirm an intent AFTER the side effect with its actual outcome. */
  confirm(seq, outcome = {}) {
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
    return this.mutate(state => {
      const entry = state.sessions[sessionId] ??= { state: 'planned' }
      if (!SESSION_TRANSITIONS[entry.state]?.includes(to)) {
        throw new Error(`illegal session journal transition ${sessionId}: ${entry.state} -> ${to}`)
      }
      if (to === 'committed') {
        // The gate chain: readback AND attachment evidence (or an explicitly
        // recorded verified skip), the batch judging them, and no open
        // intents left for this session.
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
    this.mutate(state => {
      state.conflicts.push(...conflicts.map(c => ({ at: new Date().toISOString(), ...c })))
    })
  }

  /** Reverse-order view of the recorded actions. */
  actionsReversed() {
    return [...this.state.actions].reverse()
  }
}
