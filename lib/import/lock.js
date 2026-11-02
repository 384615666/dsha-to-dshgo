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
const GUARD_DIR = 'import-job.lock.guard'
const GUARD_STALE_MS = 30_000

function sleepSync(ms) {
  // Synchronous backoff; Atomics.wait on a private cell is the portable way
  // to sleep without a busy loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Cross-process critical section for the lock's lifecycle: acquire, release
 * and stale-reclaim all run INSIDE this guard, so the observe→compare→remove
 * sequence cannot be interleaved by another reclaimer or acquirer. `mkdirSync`
 * is the atomic primitive (POSIX and Windows): the directory exists exactly
 * once. A guard left by a dead process is only reclaimed after the documented
 * stale threshold, and only by a caller that passes `guardStaleMs: 0`
 * explicitly (controlled maintenance), never silently per operation.
 */
function withGuard(instanceLockDir, fn, { guardStaleMs = GUARD_STALE_MS, timeoutMs = 10_000 } = {}) {
  const guard = join(instanceLockDir, GUARD_DIR)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(guard, { mode: 0o700 })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let ageMs = null
      try { ageMs = Date.now() - statSync(guard).mtimeMs } catch { ageMs = null }
      if (guardStaleMs === 0 && ageMs != null) {
        // explicit maintenance call: reclaim the abandoned guard
        try { fs.rmdirSync(guard) } catch { /* raced */ }
        continue
      }
      if (ageMs != null && ageMs > guardStaleMs) {
        throw coded('IMPORT_LOCK_BUSY', `the lock guard has been held for ${Math.round(ageMs / 1000)}s (stale threshold ${Math.round(guardStaleMs / 1000)}s) — explicit maintenance is required`)
      }
      if (Date.now() >= deadline) {
        throw coded('IMPORT_LOCK_BUSY', 'timed out waiting for the lock guard — another process is mid-operation')
      }
      sleepSync(10)
    }
  }
  try {
    return fn()
  } finally {
    try { fs.rmdirSync(guard) } catch { /* already removed */ }
  }
}

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
  // Observation and creation share the guard: no reclaimer can remove the
  // file between "does it exist" and "create it".
  withGuard(instanceLockDir, () => {
    if (readHolder(file)) {
      const current = readHolder(file)
      if (current?.instanceFingerprint && current.instanceFingerprint !== instanceFingerprint) {
        throw coded('IMPORT_JOB_LOCKED', `another target instance (${current.instanceFingerprint}) holds the import lock`, { holder: current })
      }
      throw coded('IMPORT_JOB_LOCKED', 'an import job is already running for this target instance', { holder: current })
    }
    let fd
    try {
      fd = openSync(file, 'wx', 0o600)
      writeSync(fd, JSON.stringify(holder))
      try { fs.fsyncSync(fd) } catch (error) {
        if (error?.code !== 'ENOSYS' && error?.code !== 'EPERM') throw error
      }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  })
  let released = false
  return {
    file,
    holder,
    release() {
      if (released) return
      released = true
      // The identity check and the removal run inside the guard: no other
      // acquire/release/break can interleave between them.
      withGuard(instanceLockDir, () => {
        const current = readHolder(file)
        if (!current || current.ownerId !== holder.ownerId || current.generation !== holder.generation) {
          // A newer generation (or no lock at all) — never delete someone else's.
          return
        }
        try { unlinkSync(file) } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      })
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
 * the journal recovery state first. The whole observe→compare→remove sequence
 * runs inside the instance guard, so two reclaimers cannot interleave and an
 * old observation can never delete a newer generation's lock.
 * `hooks.beforeUnlink` is a TEST SEAM that runs inside the guard.
 * @returns {{ broken: boolean, holder: object|null }}
 */
export function breakStaleLock(instanceLockDir, { instanceFingerprint, olderThanMs = 0, hooks = {} } = {}) {
  return withGuard(instanceLockDir, () => {
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
    if (typeof hooks.beforeUnlink === 'function') hooks.beforeUnlink(observed)
    // Re-verify immediately before removal (inside the guard): still the
    // observed generation. With the guard held no other lock operation can
    // have replaced it, and a replacement can only appear after we release.
    const final = readHolder(peeked.file)
    if (!final || final.ownerId !== observed.ownerId || final.generation !== observed.generation) {
      throw coded('IMPORT_JOB_LOCKED', 'the lock changed before removal — refusing to remove an unverified generation', { holder: final })
    }
    unlinkSync(peeked.file)
    return { broken: true, holder: observed }
  })
}
