// B-path publication adapter (P2 M4): place an already verified canonical v4
// log at the target backend's OWN locate() path, with no overwrite and no
// source lock copying.
//
// B1 decision context: the target's public SessionPersistence has no locate
// in the abstract contract, but the concrete jsonl backend exposes one and it
// must be bound to the isolated root (never derived by prefix substitution).
// This module refuses to run without a locate capability and never
// re-implements projectKey/encodeSegment.
//
// Safety:
//   - the id must be ABSENT from the target (stat/list) and unowned;
//   - the destination is created with O_EXCL (an existing file is refused,
//     never overwritten), then fsynced, then the directory entry is synced
//     where supported;
//   - readback goes through the target's open(id,'read'); the appended-message
//     capability is exercised separately (append + readback delta) by the
//     caller/matrix, not assumed.
//
// SessionPersistence has no delete/transaction: the publication primitive is
// the measured backend behavior, not an assumed generic API.

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { compareReadback } from './readback.js'

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

function dirFsyncUnsupported(error) {
  const code = error?.code
  if (process.platform === 'win32') return ['EPERM', 'EISDIR', 'EINVAL', 'EBUSY'].includes(code)
  return code === 'ENOSYS'
}

// writeSync may legitimately return fewer bytes than requested. Ignoring the
// count leaves a short file; the caller must loop until every byte is out.
function writeAll(fd, bytes) {
  const buffer = Buffer.from(bytes)
  let offset = 0
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset)
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw coded('B_IO', `short write made no progress at ${offset}/${buffer.length}`)
    }
    offset += written
  }
  return buffer.length
}

// Sync one directory entry. Returns whether the platform supported it; only
// the measured platform limitations degrade. ANY other failure (EIO, ENOSPC,
// EACCES, ...) is a real I/O error and must surface as B_IO so the caller
// never mistakes unknown durability for success.
function fsyncDirectory(dir) {
  let dfd
  try {
    dfd = fs.openSync(dir, 'r')
  } catch (error) {
    if (dirFsyncUnsupported(error)) {
      return { ok: false, reason: `directory-open-unsupported:${error.code}` }
    }
    throw coded('B_IO', `log directory open failed: ${error?.code ?? error?.message}`)
  }
  try {
    try {
      fs.fsyncSync(dfd)
      return { ok: true }
    } catch (error) {
      if (dirFsyncUnsupported(error)) return { ok: false, reason: `directory-fsync-unsupported:${error.code}` }
      throw coded('B_IO', `log directory fsync failed: ${error?.code ?? error?.message}`)
    }
  } finally {
    fs.closeSync(dfd)
  }
}

// Withdraw a just-linked canonical file ONLY when it still holds exactly our
// staged bytes. If another writer materialized or replaced it, leave the file
// alone — it is no longer ours to remove.
function removeIfStillOurs(dest, wanted) {
  try {
    const current = fs.readFileSync(dest)
    if (current.length === wanted.length && current.equals(wanted)) {
      fs.unlinkSync(dest)
      return true
    }
  } catch { /* missing or unreadable: nothing to withdraw */ }
  return false
}

/** Whether the concrete backend reports an unmaterialized in-process create. */
function hasPendingSession(persistence, id) {
  try {
    return typeof persistence?.hasPendingSession === 'function' && persistence.hasPendingSession(id) === true
  } catch {
    return false
  }
}

/** Whether this concrete instance exposes the B1 locate capability. */
export function hasLocateCapability(persistence) {
  return typeof persistence?.locate === 'function'
}

/**
 * Publish one verified canonical v4 session log through the B path.
 * @param {object} params
 * @param {object} params.persistence - target sessionPersistence (locate/open/stat).
 * @param {string} params.sessionsRoot - the backend's configured root.
 * @param {object} params.candidate - { header, events, inheritedEventCount }.
 * @param {Uint8Array} params.bytes - the exact canonical log bytes (header line
 *   + one JSON event per line, zstd-compressed according to the backend).
 * @returns {Promise<{ id, path, readback, steps }>}
 */
export async function publishSessionViaB({ persistence, sessionsRoot, candidate, bytes }) {
  const { header, events } = candidate
  if (!hasLocateCapability(persistence)) {
    throw coded('B_UNAVAILABLE_LOCATE', 'the target backend exposes no locate capability — B is unavailable')
  }
  if (!header?.id || Number(header.version) !== 4) throw coded('B_CANDIDATE_INVALID', 'B publishes only canonical v4 candidates')
  const id = header.id
  let existing
  try {
    existing = await persistence.stat(id)
  } catch (error) {
    // A namespace entry exists but cannot be read as a session: it is NOT
    // absent, so exclusive publication must refuse instead of overwriting.
    throw coded('B_ID_CONFLICT', 'the target namespace for this id already exists and cannot be verified as absent — refusing', { causeName: error?.name ?? 'Error' })
  }
  if (existing) {
    throw coded('B_ID_CONFLICT', `target already has session ${id} — B never overwrites or appends`)
  }
  // A created-but-not-yet-materialized session lives only in the backend's
  // in-process tracker; stat/disk checks cannot see it. Refuse when the
  // service already owns the id in this process.
  if (typeof persistence.hasPendingSession === 'function' && persistence.hasPendingSession(id)) {
    throw coded('B_ID_CONFLICT', 'the target service already owns this session in-process (pending create) — refusing')
  }
  let visible = null
  try {
    visible = await persistence.open(id, 'read')
  } catch (error) {
    if (error?.name !== 'SessionPersistenceNotFoundError') {
      throw coded('B_ID_CONFLICT', 'the target namespace cannot be verified as absent — refusing', { causeName: error?.name ?? 'Error' })
    }
  }
  if (visible) {
    try { await visible.close() } catch { /* observation only */ }
    throw coded('B_ID_CONFLICT', 'the target service already exposes this session in-process — refusing')
  }
  const located = persistence.locate({ cwd: header.cwd, id })
  const root = resolve(sessionsRoot)
  const dest = resolve(located.path)
  if (dest === root || !dest.startsWith(root + sep)) {
    throw coded('B_PATH_UNSAFE', 'the backend locate path escaped the configured sessions root')
  }
  const dir = dirname(dest)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const steps = {}
  // Private, NON-canonical staging path in the same directory. The canonical
  // name must never exist until the complete, fsynced bytes can be published
  // in one atomic namespace operation — a short write or process exit here
  // leaves only an ignored temp entry, never a readable half session.
  const temp = join(dir, `.migrate-${basename(dest)}.${randomUUID()}.tmp`)
  let fd
  let published = false
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    writeAll(fd, bytes)
    try {
      fs.fsyncSync(fd)
    } catch (error) {
      if (error?.code === 'ENOSYS') throw coded('B_UNSUPPORTED', 'the platform cannot fsync the published log')
      throw coded('B_IO', `log file fsync failed: ${error?.code ?? error?.message}`)
    }
    fs.closeSync(fd)
    fd = undefined
    // Content proof BEFORE the namespace becomes visible: the staged file must
    // be the exact candidate bytes (this also catches a short writer that
    // reported success).
    const staged = fs.readFileSync(temp)
    const wanted = Buffer.from(bytes)
    if (staged.length !== wanted.length || !staged.equals(wanted)) {
      throw coded('B_IO', `staged publication bytes do not match the candidate (${staged.length} != ${wanted.length})`)
    }
    // Atomic no-overwrite publication: link() creates the canonical name in
    // ONE namespace operation and fails EEXIST instead of replacing. rename()
    // is deliberately NOT used (it overwrites on POSIX).
    try {
      fs.linkSync(temp, dest)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw coded('B_ID_CONFLICT', 'the destination generation already exists — refusing to overwrite')
      }
      if (['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EACCES', 'EXDEV'].includes(error?.code)) {
        throw coded('B_UNSUPPORTED', `this filesystem cannot publish atomically without overwrite (hard link: ${error?.code})`)
      }
      throw coded('B_IO', `atomic publication failed: ${error?.code ?? error?.message}`)
    }
    published = true
    steps.publish = { ok: true, atomicLink: true, exclusiveCreate: true, stagedBytes: wanted.length }
    let dirSync
    try {
      dirSync = fsyncDirectory(dir)
    } catch (error) {
      if (error?.code === 'B_IO') {
        // The canonical name IS published already; only the directory-entry
        // durability is unknown. Preserve that recovery fact (and never
        // unlink the published file) while reporting the real I/O failure.
        error.published = true
        error.path = dest
        error.publishOutcome = 'published-directory-durability-unknown'
      }
      throw error
    }
    if (!dirSync.ok) steps.publish.directorySync = dirSync.reason
  } catch (error) {
    try { if (fd !== undefined) fs.closeSync(fd) } catch { /* closed */ }
    try { fs.unlinkSync(temp) } catch { /* nothing to clean */ }
    if (typeof error?.code === 'string' && error.code.startsWith('B_')) throw error
    throw coded('B_IO', `log publication failed: ${error?.code ?? error?.message}`)
  } finally {
    if (published) {
      // The canonical name is the durable publication; the temp name is only
      // this process's staging handle.
      try { fs.unlinkSync(temp) } catch { /* best-effort */ }
    }
  }

  // Official readback through the target instance. The inherited cut comes
  // from the READ HANDLE itself (the authoritative persisted value), not null.
  const read = await persistence.open(id, 'read')
  let readback
  try {
    const slice = await read.read()
    readback = {
      header: read.header,
      events: slice.events,
      inheritedEventCount: typeof read.inheritedEventCount === 'number' ? read.inheritedEventCount : null,
    }
  } finally {
    await read.close()
  }
  const cmp = compareReadback(
    { header, events, inheritedEventCount: candidate.inheritedEventCount ?? 0 },
    readback,
  )
  steps.readback = { ok: cmp.ok, headerMatch: cmp.headerMatch, eventsMatch: cmp.eventsMatch, eventCount: readback.events.length }
  if (!cmp.ok) {
    // A pending create turns the in-process read into a header-only view even
    // though the complete file was linked. Withdraw our just-published file
    // (only while it is byte-identical to the staged bytes) and report the
    // ownership conflict instead of a content mismatch.
    if (hasPendingSession(persistence, id)) {
      const withdrawn = removeIfStillOurs(dest, Buffer.from(bytes))
      throw coded('B_ID_CONFLICT', 'the target service claimed this id during publication — the staged file was withdrawn', { withdrawn })
    }
    throw coded('B_READBACK_MISMATCH', 'B readback does not match the verified candidate', { firstHeaderDiff: cmp.firstHeaderDiff, firstEventDiff: cmp.firstEventDiff })
  }
  const list = await persistence.list()
  steps.list = { ok: list.some(x => x.header.id === id) }
  // Ownership/writability probe (no content change). If another in-process
  // owner claimed the id during publication, withdraw an untouched file and
  // report the conflict; never leave a file that a pending create believes it
  // owns.
  let probe = null
  try {
    probe = await persistence.open(id, 'write')
    steps.writeOpen = { ok: probe?.access === 'write' }
  } catch (error) {
    if (error?.name === 'SessionAlreadyOwnedError') {
      const withdrawn = removeIfStillOurs(dest, Buffer.from(bytes))
      throw coded('B_ID_CONFLICT', 'another service owner claimed this id during publication', { withdrawn })
    }
    throw error
  } finally {
    try { await probe?.close?.() } catch { /* probe */ }
  }
  return { id, path: dest, readback, steps }
}

/**
 * Exercise the appended-message capability on a B-published session and
 * verify the readback delta. Returns the appended event count.
 */
export async function verifyAppendCapability({ persistence, id, makeEvents, expectedEvents }) {
  const handle = await persistence.open(id, 'write')
  try {
    await handle.append(makeEvents)
    await handle.flush()
  } finally {
    await handle.close()
  }
  const read = await persistence.open(id, 'read')
  let events
  try { events = (await read.read()).events } finally { await read.close() }
  if (events.length !== expectedEvents + makeEvents.length) {
    throw coded('B_APPEND_MISMATCH', `append readback ${events.length} != ${expectedEvents + makeEvents.length}`)
  }
  return makeEvents.length
}
