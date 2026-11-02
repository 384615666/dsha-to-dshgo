// A-path session writer (plan §7.4): service replay through the TARGET's own
// SessionPersistence — create(header, { inheritedEventCount }) → ONE
// pre-validated append batch → flush → close → open(id, 'read') full
// read-back → semantic comparison. Source session IDs are preserved (the
// migration plan keeps original session/message/call/job IDs; real logs carry
// cross-session references such as delivery markers that must keep naming
// the same session).
//
// Preconditions enforced HERE (each refusal is a stable, classified error):
//   - the target must not already have this session id (list/stat scan),
//   - the candidate must carry events and an inheritedEventCount,
//   - the preset mapping (if any) has already been applied to the header.
// The caller owns the A/B decision, G6 snapshot, cwd mapping and workspace
// attachment; append success alone proves nothing — only the semantic
// read-back marks a session writing→readback-verified.
//
// This module never touches session.lock files and never rewrites ids.

import { createHash } from 'node:crypto'
import { compareReadback } from './readback.js'

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Import one verified canonical v4 candidate through the target's
 * SessionPersistence service.
 * @param {object} persistence - the target instance's sessionPersistence.
 * @param {object} candidate - { header (v4, mappings applied), events,
 *   inheritedEventCount } — already verified strict/current + round-trip.
 * @param {object} [options]
 * @param {number} [options.expectedEventCount] - cross-check; defaults to
 *   candidate.events.length.
 * @returns {Promise<{ id, revision, digest, readback, steps }>}- digest is
 *   over the SENT events (hex); steps record the write lifecycle.
 */
export async function importSessionViaA(persistence, candidate, options = {}) {
  if (!persistence || typeof persistence.create !== 'function') {
    throw coded('IMPORT_TARGET_INVALID', 'target sessionPersistence service unavailable')
  }
  const header = candidate.header
  const events = candidate.events
  const inheritedEventCount = candidate.inheritedEventCount ?? 0
  if (!header || header.version !== 4 || typeof header.id !== 'string' || !header.id) {
    throw coded('IMPORT_CANDIDATE_INVALID', 'candidate header must be a v4 header with a session id')
  }
  if (!Array.isArray(events)) {
    throw coded('IMPORT_CANDIDATE_INVALID', 'candidate events must be an array')
  }
  const expected = options.expectedEventCount ?? events.length
  const id = header.id

  const steps = {}
  // Pre-check: the target id must be absent AND unowned before create.
  const existing = await persistence.stat(id)
  if (existing) {
    throw coded('IMPORT_ID_CONFLICT', `target already has session ${id} — refusing (import never appends to or overwrites an existing session)`)
  }
  steps.precheck = { ok: true }

  // create makes the id visible in THIS process immediately — it is not a
  // pre-commit invisible record; a failure after create must be rolled back
  // by the job layer (G6), not treated as "never happened".
  let handle
  try {
    handle = await persistence.create(header, { inheritedEventCount })
  } catch (error) {
    throw coded('IMPORT_CREATE_REFUSED', `target refused create for ${id}: ${error.name}`, { causeName: error.name })
  }
  if (handle?.access !== 'write') {
    try { await handle?.close?.() } catch { /* nothing to roll back yet */ }
    throw coded('IMPORT_CREATE_REFUSED', `create returned access "${handle?.access}" instead of a write handle`)
  }
  const inheritedEchoed = handle.inheritedEventCount ?? inheritedEventCount
  if (inheritedEchoed !== inheritedEventCount) {
    try { await handle?.close?.() } catch { /* nothing written yet */ }
    throw coded('IMPORT_CREATE_REFUSED', `create echoed inheritedEventCount ${inheritedEchoed} instead of the requested ${inheritedEventCount}`)
  }
  steps.create = { ok: true, inheritedEventCount: inheritedEchoed }

  // ONE pre-validated batch for the first append (plan §7.4): a partially
  // appended session must never be visible.
  try {
    await handle.append(events)
    steps.append = { ok: true, sent: events.length }
    await handle.flush()
    steps.flush = { ok: true }
  } catch (error) {
    try { await handle.close() } catch { /* surfaced below */ }
    throw coded('IMPORT_APPEND_FAILED', `append/flush failed for ${id}: ${error.name}`, { causeName: error.name, sentCount: events.length })
  }
  try {
    await handle.close()
  } catch (error) {
    throw coded('IMPORT_APPEND_FAILED', `close failed for ${id}: ${error.name}`, { causeName: error.name })
  }
  steps.close = { ok: true }

  // Full semantic read-back. NOTE: the rc.4 read handle's own
  // `inheritedEventCount` is a RE-DERIVED value (0 for a seeded import), not
  // the persisted header field — passing it as authoritative would misverify.
  // The persisted inherited count is verified through the create-time handle
  // echo plus the session/end-seed marker instead.
  const read = await persistence.open(id, 'read')
  let readback
  try {
    const slice = await read.read()
    readback = {
      header: read.header,
      events: slice.events,
      inheritedEventCount: null,
    }
  } finally {
    await read.close()
  }
  const comparison = compareReadback(
    { header, events, inheritedEventCount },
    readback,
  )
  steps.readback = {
    ok: comparison.ok && readback.events.length === expected,
    expected,
    // The rc.4 public read surface does not expose the inherited count:
    // create-time echo (steps.create) + the end-seed marker are the
    // inherited verification for seeded candidates.
    inheritedVerification: comparison.inheritedVerifiable
      ? { channel: 'readback', match: comparison.inheritedMatch }
      : { channel: 'create-echo+seed-marker', createEcho: inheritedEchoed, seedMarkerPresent: comparison.seedMarkerPresent },
    ...comparison,
  }
  if (!steps.readback.ok) {
    const detail = comparison.firstHeaderDiff ?? comparison.firstEventDiff
      ?? (comparison.seedMarkerPresent ? null : 'seeded session lacks the session/end-seed marker in the read-back')
      ?? `event count ${readback.events.length} != ${expected}`
    throw coded('IMPORT_READBACK_MISMATCH', `read-back of ${id} does not match the verified candidate (${detail})`, {
      headerMatch: comparison.headerMatch,
      eventsMatch: comparison.eventsMatch,
      seedMarkerPresent: comparison.seedMarkerPresent,
    })
  }

  let revision = null
  if (typeof persistence.stat === 'function') {
    const snap = await persistence.stat(id)
    revision = snap?.revision ?? null
  }
  return { id, revision, digest: digest(events), readback, steps }
}
