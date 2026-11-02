// Persistent import job journal (plan §8): the durable state machine that
// makes every write recoverable. The journal is atomically persisted (temp
// file + fsync + rename), bound to ONE target instance fingerprint and ONE
// source digest, and records every ownership-relevant action in order so the
// G6 rollback can compensate in reverse. One import job at a time per target
// instance — the caller enforces the lock; a journal found mid-import after a
// crash requires a recovery check and never auto-replays.
//
// States (batch): NEW → PLANNED → SNAPSHOT_READY → IMPORTING →
// VERIFYING_TARGET → DONE | ROLLING_BACK → ROLLED_BACK | FAILED
// Per session: planned → snapshot-ready → writing → readback-verified →
// attached → committed | rolled-back | failed

import fs from 'node:fs'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export const BATCH_STATES = ['NEW', 'PLANNED', 'SNAPSHOT_READY', 'IMPORTING', 'VERIFYING_TARGET', 'DONE', 'ROLLING_BACK', 'ROLLED_BACK', 'FAILED']

// Legal transitions (anything else is a journaling bug and must refuse).
const BATCH_TRANSITIONS = {
  NEW: ['PLANNED'],
  PLANNED: ['SNAPSHOT_READY', 'FAILED'],
  SNAPSHOT_READY: ['IMPORTING', 'ROLLING_BACK', 'FAILED'],
  IMPORTING: ['VERIFYING_TARGET', 'ROLLING_BACK', 'FAILED'],
  VERIFYING_TARGET: ['DONE', 'ROLLING_BACK', 'FAILED'],
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
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
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, json)
    // fsync BEFORE rename: the rename must never land ahead of the content.
    try { fs.fsyncSync(fd) } catch { /* best effort on platforms without fsync */ }
    closeSync(fd)
    renameSync(tmp, file)
  } catch (error) {
    try { closeSync(fd) } catch { /* already closed */ }
    throw error
  }
}

export class ImportJournal {
  /**
   * @param {string} file - journal file path (inside the job's private dir).
   * @param {object} binding - { instanceFingerprint, sourceDigest } — both
   *   must match on load; a mismatch means the journal belongs to another
   *   target/source and must NOT be replayed.
   */
  constructor(file, binding) {
    this.file = file
    this.state = {
      version: 1,
      binding: { instanceFingerprint: binding.instanceFingerprint, sourceDigest: binding.sourceDigest },
      batchState: 'NEW',
      sessions: {},   // sessionId -> { state }
      actions: [],    // ordered ownership-relevant actions for reverse compensation
      history: [],    // [{ at, from, to }]
      recovered: false,
    }
    this.persist()
  }

  persist() {
    persistAtomically(this.file, this.state)
  }

  /**
   * Load an existing journal; validates the binding and flags crash state
   * (`recovered === true` means a prior run did NOT finish — the caller must
   * run the recovery check; never auto-replay unjudged writes).
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
    const journal = new ImportJournal(file, binding)
    journal.state = raw
    journal.state.recovered = !['NEW', 'DONE', 'ROLLED_BACK'].includes(raw.batchState)
    return journal
  }

  transitionBatch(to) {
    const from = this.state.batchState
    if (!BATCH_TRANSITIONS[from]?.includes(to)) {
      throw new Error(`illegal batch journal transition ${from} -> ${to}`)
    }
    this.state.batchState = to
    this.state.history.push({ at: new Date().toISOString(), from, to })
    this.persist()
  }

  session(sessionId, to) {
    const entry = this.state.sessions[sessionId] ??= { state: 'planned' }
    if (!SESSION_TRANSITIONS[entry.state]?.includes(to)) {
      throw new Error(`illegal session journal transition ${sessionId}: ${entry.state} -> ${to}`)
    }
    entry.state = to
    this.persist()
  }

  /** Record an ownership-relevant action IN ORDER (rollback reads this). */
  action(action) {
    this.state.actions.push({ at: new Date().toISOString(), ...action })
    this.persist()
  }

  /** Reverse-order view of the recorded actions. */
  actionsReversed() {
    return [...this.state.actions].reverse()
  }
}
