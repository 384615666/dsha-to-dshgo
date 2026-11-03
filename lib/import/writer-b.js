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
import { dirname, resolve, sep } from 'node:path'
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
  const located = persistence.locate({ cwd: header.cwd, id })
  const root = resolve(sessionsRoot)
  const dest = resolve(located.path)
  if (dest === root || !dest.startsWith(root + sep)) {
    throw coded('B_PATH_UNSAFE', 'the backend locate path escaped the configured sessions root')
  }
  fs.mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  const steps = {}
  let fd
  try {
    fd = fs.openSync(dest, 'wx', 0o600) // O_EXCL: never overwrite an existing generation
  } catch (error) {
    if (error?.code === 'EEXIST') throw coded('B_ID_CONFLICT', 'the destination generation already exists — refusing to overwrite')
    throw error
  }
  try {
    fs.writeSync(fd, bytes)
    try { fs.fsyncSync(fd) } catch (error) {
      if (error?.code === 'ENOSYS') throw coded('B_UNSUPPORTED', 'the platform cannot fsync the published log')
      throw coded('B_IO', `log file fsync failed: ${error?.code ?? error?.message}`)
    }
    fs.closeSync(fd)
    fd = undefined
  } catch (error) {
    try { if (fd !== undefined) fs.closeSync(fd) } catch { /* closed */ }
    try { fs.unlinkSync(dest) } catch { /* nothing to clean */ }
    if (typeof error?.code === 'string' && error.code.startsWith('B_')) throw error
    throw coded('B_IO', `log publication failed: ${error?.code ?? error?.message}`)
  }
  try {
    const dfd = fs.openSync(dirname(dest), 'r')
    try {
      try { fs.fsyncSync(dfd) } catch (error) {
        if (!dirFsyncUnsupported(error)) throw coded('B_IO', `log directory fsync failed: ${error?.code ?? error?.message}`)
      }
    } finally { fs.closeSync(dfd) }
  } catch (error) {
    if (error?.code === 'B_IO') throw error
    // directory open unsupported: recorded limitation
  }
  steps.publish = { ok: true, exclusiveCreate: true }

  // Official readback through the target instance.
  const read = await persistence.open(id, 'read')
  let readback
  try {
    const slice = await read.read()
    readback = { header: read.header, events: slice.events }
  } finally {
    await read.close()
  }
  const cmp = compareReadback(
    { header, events, inheritedEventCount: candidate.inheritedEventCount ?? 0 },
    { header: readback.header, events: readback.events, inheritedEventCount: null },
  )
  steps.readback = { ok: cmp.ok, headerMatch: cmp.headerMatch, eventsMatch: cmp.eventsMatch, eventCount: readback.events.length }
  if (!cmp.ok) {
    throw coded('B_READBACK_MISMATCH', 'B readback does not match the verified candidate', { firstHeaderDiff: cmp.firstHeaderDiff, firstEventDiff: cmp.firstEventDiff })
  }
  const list = await persistence.list()
  steps.list = { ok: list.some(x => x.header.id === id) }
  // Ownership/writability probe (no content change).
  let probe = null
  try {
    probe = await persistence.open(id, 'write')
    steps.writeOpen = { ok: probe?.access === 'write' }
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
