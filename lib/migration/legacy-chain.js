// Session generation classification + official migration chain (P1).
//
// Wraps the installed @deepseek-ai/dsh-session-format-catalog and
// dsh-session-format-v3-to-v4 (target rc.4). READ-ONLY with respect to
// sources: recovery happens into detached artifacts; encoding to canonical
// v4 goes through the official codec; a round-trip self-check (restore →
// encode → restore) must match event count and header before anything is
// considered migrated.
//
// Error codes (four legacy classes from the implementation plan):
//   LEGACY_HEADER_UNSUPPORTED       — classification says unsupported
//   LEGACY_CHRONOLOGY_UNREACHABLE   — official chain cannot prove chronology
//                                     (v0 without a provable system head)
//   LEGACY_CHILD_EVIDENCE_INCOMPLETE — parent requires child evidence that
//                                     is missing/unreadable
//   LEGACY_ROW_DECODE_FAILED        — a physical row failed to decode

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The official rc.4 packages are provided by the host engine in production.
// Tests/dev may point RC4 loader paths via setModuleLoader(); by default the
// static package names resolve through normal node_modules. In the packaged
// App the plugin is a symlink and the engine lives in the host runtime's
// node_modules, so a bare import from the plugin realpath fails: fall back to
// resolution from the host entry script (and a documented runtime override).
let loaded = null

export async function setModuleLoader(loader) {
  loaded = await loader()
}

async function importOfficial(specifier) {
  try {
    return await import(specifier)
  } catch (firstError) {
    const bases = []
    if (typeof process.argv[1] === 'string' && process.argv[1] !== '') bases.push(process.argv[1])
    if (typeof process.env.DSH_RUNTIME_MODULES === 'string' && process.env.DSH_RUNTIME_MODULES !== '') {
      bases.push(join(process.env.DSH_RUNTIME_MODULES, 'noop.js'))
    }
    bases.push(join(process.cwd(), 'noop.js'))
    bases.push('/opt/dsh/noop.js')
    for (const base of bases) {
      try {
        const req = createRequire(base)
        return await import(pathToFileURL(req.resolve(specifier)).href)
      } catch { /* try the next host base */ }
    }
    throw firstError
  }
}

async function ensureModules() {
  if (loaded) return loaded
  loaded = await Promise.all([
    importOfficial('@deepseek-ai/dsh-session-format-catalog'),
    importOfficial('@deepseek-ai/dsh-session-format-v3-to-v4'),
  ]).then(([cat, v3]) => ({ cat, v3 }))
  return loaded
}

export const LEGACY_CODES = {
  HEADER_UNSUPPORTED: 'LEGACY_HEADER_UNSUPPORTED',
  CHRONOLOGY_UNREACHABLE: 'LEGACY_CHRONOLOGY_UNREACHABLE',
  CHILD_EVIDENCE_INCOMPLETE: 'LEGACY_CHILD_EVIDENCE_INCOMPLETE',
  ROW_DECODE_FAILED: 'LEGACY_ROW_DECODE_FAILED',
  ROUNDTRIP_MISMATCH: 'LEGACY_ROUNDTRIP_MISMATCH',
}

// Deep-equality for session events and headers: every own enumerable key
// (seq/type/time/data/surfaceOp/sourceEventSeqs/extensions) must match.
// Key order is irrelevant; values compare structurally.
function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a !== 'object') return a === b
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
}

/**
 * Round-trip verification: the pre-encode artifact and the post-encode
 * restored artifact must match on the COMPLETE logical header, EVERY event
 * (all fields), and the inherited cut. Fault-injection review showed a
 * count+six-field check accepted rewritten message text.
 */
export function assertDeepRoundTrip(before, after) {
  const h1 = before.header ?? {}
  const h2 = after.header ?? {}
  for (const key of new Set([...Object.keys(h1), ...Object.keys(h2)])) {
    if (!deepEqual(h1[key] ?? undefined, h2[key] ?? undefined)) {
      throw new LegacyMigrationError(
        LEGACY_CODES.ROUNDTRIP_MISMATCH,
        `round-trip header mismatch on ${key}`,
        { field: key, before: h1[key] ?? null, after: h2[key] ?? null },
      )
    }
  }
  const e1 = before.events ?? []
  const e2 = after.events ?? []
  if (e1.length !== e2.length) {
    throw new LegacyMigrationError(
      LEGACY_CODES.ROUNDTRIP_MISMATCH,
      `round-trip event count mismatch: ${e2.length} != ${e1.length}`,
      { before: e1.length, after: e2.length },
    )
  }
  for (let i = 0; i < e1.length; i++) {
    if (!deepEqual(e1[i], e2[i])) {
      // Locate the first differing field for a sanitized diagnostic.
      const fields = new Set([...Object.keys(e1[i] ?? {}), ...Object.keys(e2[i] ?? {})])
      const differing = [...fields].filter(k => !deepEqual(e1[i]?.[k] ?? undefined, e2[i]?.[k] ?? undefined))
      throw new LegacyMigrationError(
        LEGACY_CODES.ROUNDTRIP_MISMATCH,
        `round-trip event mismatch at index ${i}: fields ${differing.join(', ') || '(structure)'}`,
        { index: i, fields: differing },
      )
    }
  }
  const i1 = before.inheritedEventCount ?? 0
  const i2 = after.inheritedEventCount ?? 0
  if (i1 !== i2) {
    throw new LegacyMigrationError(
      LEGACY_CODES.ROUNDTRIP_MISMATCH,
      `round-trip inheritedEventCount mismatch: ${i2} != ${i1}`,
      { before: i1, after: i2 },
    )
  }
}

export class LegacyMigrationError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`)
    this.name = 'LegacyMigrationError'
    this.code = code
    this.details = details
  }
}

/**
 * Classify one physical header. Returns the catalog's own classification
 * object ({status, storedVersion, targetVersion, header?, reason?}).
 */
export async function classifyHeader(physicalHeader) {
  const { cat } = await ensureModules()
  const version = physicalHeader?.version
  const catalog = typeof version === 'number' && version < 4
    ? loaded.cat.historicalSessionFormatCatalog
    : loaded.cat.sessionFormatCatalog
  return catalog.readHeader(physicalHeader)
}


// ---------------------------------------------------------------------------
// Official failure classification (CORE-AUDIT B3 / plan §5.2 four-code table).
//
// The four LEGACY classes are decided from STRUCTURED evidence first:
//   * the official error CLASS — the rc.4 packages put a stable `name` on their
//     error classes (`SessionFormatError`, `SessionFormatUnsupportedMigrationError`,
//     dsh-session-format/lib/index.js error.js);
//   * the wrapper's `cause` chain (a transform refusal wraps the inner detail:
//     dsh-session-format/lib/index.js throwUnsupportedRefusal);
//   * the failing MIGRATION recorded in the official refusal prefix
//     `${migration.name} refuses this format v${from} ${subject}: ${detail}`;
//   * the caller's STAGE (row decode vs restore.finish vs parent restore).
// Only then is the refusal TEXT discriminated, through a table of exact
// strings transcribed from the installed rc.4 packages. English word-regex
// matching is no longer the primary signal: the previous
// /subagent\/catalog|child.*fact|catalog child|parent catalog/i pattern missed
// 4 of the 7 real child-evidence refusals (CORE-AUDIT B3 measured 4/7 wrong).
// ---------------------------------------------------------------------------

const OFFICIAL_UNSUPPORTED_MIGRATION_CLASS = 'SessionFormatUnsupportedMigrationError'
const UNSUPPORTED_REFUSAL_PREFIX = /^(@deepseek-ai\/dsh-session-format-v(\d+)-to-v(\d+)) refuses this format v(\d+) ([^:]+):/

// CHILD-EVIDENCE refusals. Anchors (@deepseek-ai/dsh-session-format-v3-to-v4,
// rc.4 = 0.2.1-rc.4, lib/index.js): facts.js:873, facts.js:890, facts.js:910,
// facts.js:911, migration.js:1415, migration.js:1520, migration.js:1530.
// The trailing generic entries are the same package's official vocabulary for
// a child/catalog fact refusal (kept so a reworded detail still lands here).
const CHILD_EVIDENCE_REFUSALS = Object.freeze([
  'catalog migration requires a subagent child with a direct parent',
  'catalog migration requires historical child identity and descriptor evidence',
  'has an invalid subagent descriptor provider',
  'has an invalid subagent descriptor mode',
  'requires explicit historical child facts',
  'conflicts with its parent catalog',
  'duplicate catalog child',
  'subagent/catalog',
  'subagent descriptor',
  'child identity',
  'child facts',
  'catalog migration',
  'parent catalog',
])

// CHRONOLOGY refusals. Anchors (dsh-session-format-v2-to-v3, rc.4): the only
// released refusals that state a chronology/system-head impossibility
// (migration.js "cannot acquire a system head without changing chronology",
// "cannot retain source chronology"). v0 refusals are event-level and are
// classified as ROW_DECODE_FAILED instead — see ROW_LEVEL_REFUSALS.
const CHRONOLOGY_REFUSALS = Object.freeze([
  'cannot acquire a system head without changing chronology',
  'cannot retain source chronology',
  'system head',
  'chronology',
])

// ROW/EVENT-LEVEL refusals: a specific physical row or event cannot be
// represented, so the row-decode class owns them (plan §5.2: record the
// physical row and the recovered event count; never continue past the row).
const ROW_LEVEL_REFUSALS = Object.freeze([
  // dsh-session-format-v0-to-v1 (v0/v1 unknown event shapes)
  'unknown historical event type',
  'unknown required event type',
  'unsupported legacy',
  'unsupported request/header reason',
  'unsupported descriptor version',
  // v2-to-v3 / v3-to-v4 event-level refusals
  'contains unknown event type',
  'rejects retired event type',
  'cannot safely transform unclassified',
  'nested tool-result unsupported by this converter',
  'contains deferLoading',
  'delivery marker claims target format',
])

function matchesRefusal(text, table) {
  return table.some(fragment => text.includes(fragment))
}

function errorTrail(error) {
  const trail = []
  let current = error
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth += 1) {
    trail.push(current)
    current = current.cause
  }
  return trail
}

/** Structured evidence of one official-chain failure (no classification yet). */
function officialFailureFacts(error) {
  const trail = errorTrail(error)
  const names = trail.map(item => (typeof item?.name === 'string' ? item.name : '')).filter(Boolean)
  const messages = trail.map(item => (typeof item?.message === 'string' ? item.message : '')).filter(Boolean)
  const text = messages.join(' | ')
  const prefix = UNSUPPORTED_REFUSAL_PREFIX.exec(messages[0] ?? '')
  return {
    names,
    text,
    refusal: names.includes(OFFICIAL_UNSUPPORTED_MIGRATION_CLASS),
    migration: prefix?.[1] ?? null,
    migrationFromVersion: prefix ? Number(prefix[2]) : null,
    migrationToVersion: prefix ? Number(prefix[3]) : null,
    subject: prefix?.[5] ?? null,
    code: typeof error?.code === 'string' ? error.code : null,
  }
}

const LEGACY_CODE_SET = new Set(Object.values(LEGACY_CODES))

// Stages whose implementation lives in exactly one official migration package.
// The caller records the stage, so this is structured evidence for `migration`
// when the refusal itself was thrown without the official wrapper prefix.
const MIGRATION_BY_STAGE = Object.freeze({
  'child-facts': '@deepseek-ai/dsh-session-format-v3-to-v4',
})

/**
 * Classify one official-chain failure into {code, message, details}. Never
 * throws; an already-classified LegacyMigrationError passes through. Exported
 * so the official-message table can be tested directly (table-driven B3).
 */
export function classifyOfficialFailure(error, { stage = 'unknown', storedVersion = null, row = null } = {}) {
  if (error instanceof LegacyMigrationError) {
    return {
      code: error.code,
      message: error.message,
      details: { stage: error.details?.stage ?? stage, storedVersion: error.details?.storedVersion ?? storedVersion, ...error.details },
    }
  }
  const facts = officialFailureFacts(error)
  const message = error?.message ?? String(error)
  const details = {
    stage,
    storedVersion: storedVersion ?? null,
    cause: facts.names.at(-1) ?? null,
    migration: facts.migration ?? MIGRATION_BY_STAGE[stage] ?? null,
    subject: facts.subject,
    fromVersion: facts.migrationFromVersion,
    toVersion: facts.migrationToVersion,
    ...(row === null ? {} : { row }),
  }
  // A code this module already owns is a classification, not a foreign failure.
  if (facts.code && LEGACY_CODE_SET.has(facts.code)) return { code: facts.code, message, details }
  if (facts.refusal) {
    if (matchesRefusal(facts.text, CHILD_EVIDENCE_REFUSALS)) return { code: LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE, message, details }
    if (matchesRefusal(facts.text, CHRONOLOGY_REFUSALS)) return { code: LEGACY_CODES.CHRONOLOGY_UNREACHABLE, message, details }
    if (matchesRefusal(facts.text, ROW_LEVEL_REFUSALS)) return { code: LEGACY_CODES.ROW_DECODE_FAILED, message, details }
    // A refusal naming the HEADER as its subject is a header capability gap.
    if (facts.subject === 'Session header') return { code: LEGACY_CODES.HEADER_UNSUPPORTED, message, details }
    // A refusal raised while decoding a specific row is a row-level failure
    // regardless of its wording.
    if (stage === 'row-decode') return { code: LEGACY_CODES.ROW_DECODE_FAILED, message, details }
    // Any other migration refusal states that the stored generation cannot be
    // migrated by this build: that is the header/format class.
    return { code: LEGACY_CODES.HEADER_UNSUPPORTED, message, details }
  }
  // A non-refusal official SessionFormatError is a losslessness failure: the
  // decoded row, or a finish() invariant, did not hold.
  return { code: LEGACY_CODES.ROW_DECODE_FAILED, message, details }
}

// Normalize an error thrown by the OFFICIAL chain during restore.finish()
// (the evidence/chronology/relationship phase) into a precise legacy code.
// Row-decode failures never reach here (they throw earlier with their own
// code); round-trip mismatches are a separate, later stage.
export function normalizeFinishError(error, { stage = 'restore-finish', storedVersion = null, row = null } = {}) {
  if (error instanceof LegacyMigrationError) return error
  const classified = classifyOfficialFailure(error, { stage, storedVersion, row })
  const wrapped = new LegacyMigrationError(classified.code, classified.message, classified.details)
  if (error && typeof error === 'object') wrapped.cause = error
  return wrapped
}

/**
 * Restore physical rows into the current artifact through the official
 * chain. v4 goes through the current catalog directly; v0–v3 go through
 * the historical catalog (whose finish() yields a v3-era artifact that the
 * caller may further migrate via the child-bound catalog).
 *
 * physicalRows: iterable of already-decoded row objects (one JSONL line each).
 * Throws LegacyMigrationError with a legacy code on classification/decode
 * failures; SessionFormat* errors from the official chain pass through.
 */
// Materialize physicalRows ONCE so both migration phases (historical
// restore, child-bound restore) replay identical rows. A one-shot iterator
// consumed by the first phase would silently yield an empty second pass —
// that failure mode is refused explicitly instead.
function materializeRows(physicalRows) {
  if (Array.isArray(physicalRows)) return physicalRows
  if (physicalRows && typeof physicalRows.next === 'function') {
    // Iterator/generator: replayable only if we buffer it. Buffering is
    // bounded by the per-session row budget enforced upstream, so this is
    // the supported form; the caller's iterator is drained exactly once.
    return [...physicalRows]
  }
  // Strings and other non-iterable shapes are caller errors.
  throw new LegacyMigrationError(
    LEGACY_CODES.ROW_DECODE_FAILED,
    'physicalRows must be an array or iterator of decoded row objects',
    { received: typeof physicalRows },
  )
}

// Shared row-decode stage classification: EVERY restore entry (single and
// parent-with-children) routes decode failures through the same classifier — a
// chronology or child-evidence refusal is never a mere bad row, regardless of
// entry point, while a genuine row failure keeps the physical row number.
function decodeStageError(error, { row, storedVersion }) {
  if (error instanceof LegacyMigrationError) return error
  const classified = classifyOfficialFailure(error, { stage: 'row-decode', storedVersion, row })
  const message = classified.code === LEGACY_CODES.ROW_DECODE_FAILED
    ? `row ${row} failed to decode: ${classified.message}`
    : classified.message
  const wrapped = new LegacyMigrationError(classified.code, message, { ...classified.details, row })
  wrapped.cause = error
  return wrapped
}

export const MARKER_P1_BATCH7 = true
export async function restoreArtifact(physicalHeader, physicalRowsInput, { recovery = 'strict' } = {}) {
  const cls = await classifyHeader(physicalHeader)
  if (cls.status === 'unsupported') {
    throw new LegacyMigrationError(
      LEGACY_CODES.HEADER_UNSUPPORTED,
      cls.reason ?? 'unsupported stored version',
      { storedVersion: cls.storedVersion, targetVersion: cls.targetVersion },
    )
  }
  if (cls.status === 'malformed') {
    throw new LegacyMigrationError(
      LEGACY_CODES.HEADER_UNSUPPORTED,
      cls.reason ?? 'malformed physical header',
      { storedVersion: cls.storedVersion ?? null },
    )
  }
  const useHistorical = physicalHeader.version < 4
  const physicalRows = materializeRows(physicalRowsInput)
  const catalog = useHistorical ? loaded.cat.historicalSessionFormatCatalog : loaded.cat.sessionFormatCatalog
  const restore = catalog.createRestore(physicalHeader, { recovery, validation: 'current' })
  let rowCount = 0
  // v0/v1 restorers deliver logical events through context.emitEvent (their
  // finish() only returns the inherited count); v2+ expose finish().artifact.
  const collected = []
  const context = { emitEvent: ev => collected.push(ev) }
  for (const row of physicalRows) {
    try {
      restore.decodeRow(row, context)
      rowCount += 1
    } catch (error) {
      throw decodeStageError(error, { row: rowCount, storedVersion: physicalHeader.version })
    }
  }
  let artifact
  try {
    artifact = typeof restore.finish === 'function' ? restore.finish(context) : restore.finish()
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error
    throw normalizeFinishError(error, { stage: 'restore-finish', storedVersion: physicalHeader.version })
  }
  // Normalize two restorer contracts (probed on rc.4):
  //  - v0–v3 (historical): context.emitEvent collects the logical events and
  //    finish() yields the inherited count — synthesize the artifact using
  //    the classification's translated header.
  //  - v4 (current): finish() returns the full artifact; collected stays
  //    empty and MUST NOT overwrite artifact.events.
  if (!artifact || typeof artifact !== 'object' || !Array.isArray(artifact.events)) {
    artifact = {
      header: restore.header ?? cls.header ?? physicalHeader,
      events: collected,
      inheritedEventCount: typeof artifact === 'number' ? artifact : 0,
    }
  }
  // NOTE: a v0–v3 artifact is returned AS the historical artifact — binding
  // it to direct-child evidence and upgrading to v4 is the CALLER's second
  // phase (restoreParentWithChildren with the complete child set). Upgrading
  // in here with an implicit empty set would silently drop real parent-child
  // evidence (review F2).
  return { artifact, classification: cls, rowCount, usedHistorical: useHistorical, collectedEvents: collected, physicalRows }
}

/**
 * Build child evidence facts for v3→v4 parent migration.
 * childArtifacts: already-restored artifacts of DIRECT child sessions
 * (origin === 'subagent' && parentSession === parentId). Returns facts for
 * createSessionFormatCatalogWithChildren.
 *
 * The official child-fact builder validates the child's descriptor (provider/
 * mode) and refuses malformed evidence; those refusals are child-evidence
 * failures, so they are classified here instead of leaking a raw official
 * error into a report row.
 */
export async function childFactsFromArtifacts(childArtifacts) {
  const { v3 } = await ensureModules()
  const facts = []
  for (const artifact of childArtifacts) {
    try {
      facts.push(v3.historicalChildCatalogSource(artifact))
    } catch (error) {
      throw normalizeFinishError(error, {
        stage: 'child-facts',
        storedVersion: artifact?.header?.version ?? null,
      })
    }
  }
  return facts
}

/**
 * Restore a v3 parent to the current artifact using child evidence.
 * childFacts: array from childFactsFromArtifacts ([] when the parent has no
 * direct children — an explicit statement, not a placeholder for unknowns).
 */
export async function restoreParentWithChildren(parentHeader, parentRowsInput, childFacts, { recovery = 'strict' } = {}) {
  const { cat } = await ensureModules()
  const catalog = cat.createSessionFormatCatalogWithChildren(childFacts)
  const parentRows = materializeRows(parentRowsInput)
  const restore = catalog.createRestore(parentHeader, { recovery, validation: 'current' })
  let rowCount = 0
  for (const row of parentRows) {
    try {
      restore.decodeRow(row)
      rowCount += 1
    } catch (error) {
      // Same stage classification as the single restore entry: the parent
      // entry point must not re-file chronology refusals as bad rows (F7).
      throw decodeStageError(error, { row: rowCount, storedVersion: parentHeader.version })
    }
  }
  let artifact
  try {
    artifact = restore.finish()
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error
    throw normalizeFinishError(error, { stage: 'parent-restore-finish', storedVersion: parentHeader.version })
  }
  return { artifact, rowCount }
}

/**
 * Round-trip self-check: restore → encode to canonical v4 → restore again.
 * Verifies event count and header equality. Returns the canonical v4
 * physical rows (header row + event rows) for downstream staging.
 */
export async function encodeCanonicalV4AndSelfCheck(artifact) {
  const { cat } = await ensureModules()
  const encodedHeader = cat.sessionFormatCatalog.encodeCurrentHeader(artifact.header, artifact.inheritedEventCount ?? 0)
  const encodedEvents = artifact.events.map(e => cat.sessionFormatCatalog.encodeCurrentEvent(e))
  const re = cat.sessionFormatCatalog.createRestore(encodedHeader, { recovery: 'strict', validation: 'current' })
  for (const row of encodedEvents) re.decodeRow(row)
  const rt = re.finish()
  // Full deep comparison per plan §5.2/§10: complete header, EVERY event
  // (seq, type, data, surfaceOp, references, extensions) and the inherited
  // cut. A count-only or field-subset check missed content-changing faults
  // (fault-injection review: rewritten message text passed the old check).
  assertDeepRoundTrip(artifact, rt)
  return {
    headerRow: encodedHeader,
    eventRows: encodedEvents,
    inheritedEventCount: artifact.inheritedEventCount ?? 0,
  }
}

/**
 * One-shot: classify → restore → (optionally migrate children) → canonical
 * v4 + self-check. Used by the inspect/plan tooling on extracted staging
 * files.
 */
export async function migrateToV4(physicalHeader, physicalRowsInput, { childFacts = null, recovery = 'strict' } = {}) {
  // Materialize ONCE at the outermost layer: both chain passes must replay
  // the same physical rows. A one-shot generator consumed by the first pass
  // used to leave the second pass an exhausted iterator — the official chain
  // accepts the resulting empty session, so the failure mode was silent 5→0.
  const physicalRows = materializeRows(physicalRowsInput)
  const { artifact, classification, usedHistorical, rowCount } = await restoreArtifact(physicalHeader, physicalRows, { recovery })
  if (usedHistorical) {
    // A v3-era artifact reaches v4 ONLY through the child-bound catalog —
    // with an explicit empty child set when the parent has no direct
    // children (childFacts === null means "no direct children seen in this
    // archive", which the caller must confirm from the backup manifest).
    const parent = await restoreParentWithChildren(physicalHeader, physicalRows, childFacts ?? [], { recovery })
    return {
      sourceVersion: physicalHeader.version,
      classification,
      ...(await encodeCanonicalV4AndSelfCheck(parent.artifact)),
      rowCount: parent.rowCount,
    }
  }
  return {
    sourceVersion: physicalHeader.version,
    classification,
    ...(await encodeCanonicalV4AndSelfCheck(artifact)),
    rowCount,
  }
}
