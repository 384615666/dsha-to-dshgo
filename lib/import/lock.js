// Per-target-instance import job lock (plan §8: "same instance runs one
// import job at a time").
//
// The lock lives in an INSTANCE-LEVEL shared lock directory, NOT inside a
// job's private directory: every job of the same target must contend for the
// same file, otherwise two jobs in different directories would both "hold"
// a lock. Callers pass that shared directory (the host derives it from the
// instance identity and uses the SAME path for every job).
//
// Each acquisition writes a unique owner/generation identity. release() and
// breakStaleLock() re-read the file and only remove it when the on-disk
// identity still matches the one they own — an old handle can never delete a
// newer generation's lock.
//
// A crashed job leaves its lock behind. Reclaiming it is an EXPLICIT,
// recorded decision (breakStaleLock) — never an automatic timeout inside
// acquire: the lock only proves mutual exclusion, not that the previous job
// finished, and its journal may still need a recovery judgment.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

export const LOCK_FILE = 'import-job.lock'

function readHolder(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return { unreadable: true }
  }
}

/**
 * @param {string} instanceLockDir - the SHARED, instance-level lock directory
 *   (the same path for every job of this target).
 * @param {object} options
 * @param {string} options.instanceFingerprint - the target instance identity.
 * @returns {{ release: () => void, file: string, holder: object }}
 */
export function acquireJobLock(instanceLockDir, { instanceFingerprint }) {
  if (typeof instanceFingerprint !== 'string' || instanceFingerprint === '') {
    throw coded('IMPORT_LOCK_INVALID', 'instance fingerprint is required to lock an import job')
  }
  mkdirSync(instanceLockDir, { recursive: true, mode: 0o700 })
  const file = join(instanceLockDir, LOCK_FILE)
  const holder = {
    instanceFingerprint,
    ownerId: randomUUID(),
    generation: randomUUID(),
    pid: process.pid,
    at: new Date().toISOString(),
  }
  let fd
  try {
    fd = openSync(file, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const current = readHolder(file)
      if (current?.instanceFingerprint && current.instanceFingerprint !== instanceFingerprint) {
        throw coded('IMPORT_JOB_LOCKED', `another target instance (${current.instanceFingerprint}) holds the import lock`, { holder: current })
      }
      throw coded('IMPORT_JOB_LOCKED', 'an import job is already running for this target instance', { holder: current })
    }
    throw error
  }
  try {
    writeSync(fd, JSON.stringify(holder))
    try { fs.fsyncSync(fd) } catch (error) {
      if (error?.code !== 'ENOSYS' && error?.code !== 'EPERM') throw error
    }
  } finally {
    closeSync(fd)
  }
  let released = false
  return {
    file,
    holder,
    release() {
      if (released) return
      released = true
      const current = readHolder(file)
      if (!current || current.ownerId !== holder.ownerId || current.generation !== holder.generation) {
        // A newer generation (or no lock at all) — never delete someone else's.
        return
      }
      try { unlinkSync(file) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    },
  }
}

/** Inspect the lock without acquiring it. */
export function peekJobLock(instanceLockDir) {
  const file = join(instanceLockDir, LOCK_FILE)
  const holder = readHolder(file)
  if (!holder) return { held: false, file }
  let ageMs = null
  try { ageMs = Date.now() - statSync(file).mtimeMs } catch { ageMs = null }
  return { held: true, holder, ageMs, file }
}

/**
 * Explicitly reclaim a lock left by a crashed job. Callers must have judged
 * the journal recovery state first; this only removes the observed stale
 * file, and only when its identity still matches what was observed.
 * @returns {{ broken: boolean, holder: object|null }}
 */
export function breakStaleLock(instanceLockDir, { instanceFingerprint, olderThanMs = 0 } = {}) {
  const peeked = peekJobLock(instanceLockDir)
  if (!peeked.held) return { broken: false, holder: null }
  if (instanceFingerprint && peeked.holder?.instanceFingerprint && peeked.holder.instanceFingerprint !== instanceFingerprint) {
    throw coded('IMPORT_JOB_LOCKED', 'the stale lock belongs to a different target instance — refusing to break it', { holder: peeked.holder })
  }
  if (peeked.ageMs != null && peeked.ageMs < olderThanMs) {
    throw coded('IMPORT_JOB_LOCKED', `the lock is only ${Math.round(peeked.ageMs / 1000)}s old (threshold ${Math.round(olderThanMs / 1000)}s)`, { holder: peeked.holder })
  }
  const observed = peeked.holder
  const current = readHolder(peeked.file)
  if (!current || current.ownerId !== observed.ownerId || current.generation !== observed.generation) {
    throw coded('IMPORT_JOB_LOCKED', 'the lock changed while breaking it — refusing to remove an unverified generation', { holder: current })
  }
  unlinkSync(peeked.file)
  return { broken: true, holder: observed }
}
