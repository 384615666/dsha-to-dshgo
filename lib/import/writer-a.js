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
  if (typeof header.agentPreset !== 'string' || !header.agentPreset) {
    // A preset mapping that could not be resolved (target preset service
    // unavailable) must never reach write admission — the caller blocks it;
    // this guard keeps an unresolved header out of create().
    throw coded('IMPORT_CANDIDATE_INVALID', 'candidate header has no resolved agentPreset — resolve the preset mapping (or the environment) before import')
  }
  // Cut self-consistency BEFORE create (official catalog semantics: the LAST
  // inherited end-seed marker marks the accepted cut). A candidate whose cut
  // disagrees with its own marker is not an officially verified artifact —
  // the review's fixture had a marker at seq 0 (official cut 0) while
  // claiming 7.
  const markers = events.filter(x => x?.type === 'session/end-seed' && x?.data?.inherited === true)
  if (header.isSeeded === true) {
    if (markers.length === 0) {
      throw coded('IMPORT_CANDIDATE_INVALID', 'seeded candidate lacks a session/end-seed marker')
    }
    const lastCut = markers[markers.length - 1].seq
    if (lastCut !== inheritedEventCount) {
      throw coded('IMPORT_CANDIDATE_INVALID', `candidate inheritedEventCount ${inheritedEventCount} does not match the last end-seed marker seq ${lastCut}`)
    }
  } else if (markers.length > 0) {
    throw coded('IMPORT_CANDIDATE_INVALID', 'unseeded candidate contains a session/end-seed marker')
  }
  // Cross-check count: must be a non-negative safe integer agreeing with the
  // verified candidate — a disagreement refuses BEFORE create so no visible
  // object is made.
  const expected = options.expectedEventCount ?? events.length
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw coded('IMPORT_CANDIDATE_INVALID', `expectedEventCount must be a non-negative safe integer (got ${expected})`)
  }
  if (expected !== events.length) {
    throw coded('IMPORT_CANDIDATE_INVALID', `expectedEventCount ${expected} disagrees with the candidate's verified ${events.length} events`)
  }
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
  // The echo is STAGE evidence and must be the target's own number — never
  // fall back to the caller's value when the target does not echo.
  const inheritedEchoed = handle.inheritedEventCount
  if (inheritedEchoed !== inheritedEventCount) {
    try { await handle?.close?.() } catch { /* nothing written yet */ }
    throw coded('IMPORT_CREATE_REFUSED', `create did not echo the requested inheritedEventCount ${inheritedEventCount} (target echo: ${JSON.stringify(inheritedEchoed)})`)
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

  // Full semantic read-back. The read handle's inheritedEventCount IS the
  // authoritative persisted cut (rc.4 SessionHandle contract: the exact
  // inherited prefix length — verified with a non-zero-cut positive control).
  // It is compared precisely; a missing/abnormal value counts as UNVERIFIED,
  // never as success.
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
  const comparison = compareReadback(
    { header, events, inheritedEventCount },
    readback,
  )
  // Compose comparison FIRST, then compute the single final verdict — the
  // spread used to overwrite the expected-count conjunction, letting a
  // 999-expected/3-actual import report success.
  steps.readback = {
    ...comparison,
    expected,
    inheritedVerification: comparison.inheritedVerifiable
      ? { channel: 'readback', match: comparison.inheritedMatch, readCut: readback.inheritedEventCount }
      : { channel: 'unverified', createEcho: inheritedEchoed, seedMarkerPresent: comparison.seedMarkerPresent },
  }
  steps.readback.ok = comparison.ok && readback.events.length === expected
  if (!steps.readback.ok) {
    const detail = comparison.firstHeaderDiff ?? comparison.firstEventDiff
      ?? (!comparison.inheritedVerifiable
        ? 'read-back did not expose the inherited cut — cut unverified'
        : (!comparison.inheritedMatch ? `inherited cut ${readback.inheritedEventCount} != candidate ${inheritedEventCount}` : null))
      ?? `event count ${readback.events.length} != ${expected}`
    throw coded('IMPORT_READBACK_MISMATCH', `read-back of ${id} does not match the verified candidate (${detail})`, {
      headerMatch: comparison.headerMatch,
      eventsMatch: comparison.eventsMatch,
      inheritedMatch: comparison.inheritedMatch,
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
