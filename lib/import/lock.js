// Per-target-instance import job lock (plan §8: "same instance runs one
// import job at a time"). The lock is a job-directory file created with
// O_EXCL, stamped with the target instance fingerprint, the owning pid and
// the acquisition time. A second job on the same instance refuses with
// IMPORT_JOB_LOCKED and the holder's details.
//
// A crashed job leaves its lock behind. Reclaiming it is an EXPLICIT,
// recorded decision (`breakStaleLock`) — never an automatic timeout inside
// acquire: the lock only proves mutual exclusion, not that the previous job
// finished, and its journal may still need a recovery judgment.

import fs from 'node:fs'
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

export const LOCK_FILE = 'import-job.lock'

/**
 * @param {string} dir - the job directory (already private, 0700).
 * @param {object} options
 * @param {string} options.instanceFingerprint - the target instance identity.
 * @param {number} [options.staleAfterMs] - only used by breakStaleLock.
 * @returns {{ release: () => void, file: string, holder: object }}
 */
export function acquireJobLock(dir, { instanceFingerprint }) {
  if (typeof instanceFingerprint !== 'string' || instanceFingerprint === '') {
    throw coded('IMPORT_LOCK_INVALID', 'instance fingerprint is required to lock an import job')
  }
  const file = join(dir, LOCK_FILE)
  let fd
  try {
    fd = openSync(file, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      let holder = null
      try { holder = JSON.parse(readFileSync(file, 'utf8')) } catch { holder = null }
      if (holder?.instanceFingerprint && holder.instanceFingerprint !== instanceFingerprint) {
        throw coded('IMPORT_JOB_LOCKED', `another target instance (${holder.instanceFingerprint}) holds the import lock`, { holder })
      }
      throw coded('IMPORT_JOB_LOCKED', 'an import job is already running for this target instance', { holder })
    }
    throw error
  }
  const holder = { instanceFingerprint, pid: process.pid, at: new Date().toISOString() }
  try {
    writeSync(fd, JSON.stringify(holder))
    try { fsyncFd(fd) } catch { /* the lock is advisory; content is small */ }
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
      try { unlinkSync(file) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    },
  }
}

function fsyncFd(fd) {
  try { fs.fsyncSync(fd) } catch (error) {
    if (error?.code !== 'ENOSYS' && error?.code !== 'EPERM') throw error
  }
}

/** Inspect the lock without acquiring it. */
export function peekJobLock(dir) {
  const file = join(dir, LOCK_FILE)
  try {
    const holder = JSON.parse(readFileSync(file, 'utf8'))
    const st = statSync(file)
    return { held: true, holder, ageMs: Date.now() - st.mtimeMs, file }
  } catch (error) {
    if (error?.code === 'ENOENT') return { held: false, file }
    throw error
  }
}

/**
 * Explicitly reclaim a lock left by a crashed job. Callers must have judged
 * the journal recovery state first; this only removes the stale file.
 * @returns {{ broken: true, holder: object|null }}
 */
export function breakStaleLock(dir, { instanceFingerprint, olderThanMs = 0 } = {}) {
  const peeked = peekJobLock(dir)
  if (!peeked.held) return { broken: false, holder: null }
  if (instanceFingerprint && peeked.holder?.instanceFingerprint && peeked.holder.instanceFingerprint !== instanceFingerprint) {
    throw coded('IMPORT_JOB_LOCKED', 'the stale lock belongs to a different target instance — refusing to break it', { holder: peeked.holder })
  }
  if (peeked.ageMs < olderThanMs) {
    throw coded('IMPORT_JOB_LOCKED', `the lock is only ${Math.round(peeked.ageMs / 1000)}s old (threshold ${Math.round(olderThanMs / 1000)}s)`, { holder: peeked.holder })
  }
  unlinkSync(peeked.file)
  return { broken: true, holder: peeked.holder }
}
