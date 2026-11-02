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

// The official rc.4 packages are provided by the host engine in production.
// Tests/dev may point RC4 loader paths via setModuleLoader(); by default the
// static package names resolve through normal node_modules.
let loaded = null

export async function setModuleLoader(loader) {
  loaded = await loader()
}

async function ensureModules() {
  if (loaded) return loaded
  loaded = await Promise.all([
    import('@deepseek-ai/dsh-session-format-catalog'),
    import('@deepseek-ai/dsh-session-format-v3-to-v4'),
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


// Normalize an error thrown by the OFFICIAL chain during restore.finish()
// (the evidence/chronology/relationship phase) into a precise legacy code.
// Row-decode failures never reach here (they throw earlier with their own
// code); round-trip mismatches are a separate, later stage.
export function normalizeFinishError(error, { stage, storedVersion }) {
  if (error instanceof LegacyMigrationError) return error
  const message = error.message ?? String(error)
  const unsupported = error.name === 'SessionFormatUnsupportedMigrationError'
    || /UnsupportedMigration/.test(error.name ?? '')
  // Child-evidence: subagent catalog facts, conflicts, direct-parent identity.
  if (/subagent\/catalog|child.*fact|catalog child|parent catalog/i.test(message)) {
    return new LegacyMigrationError(LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE, message,
      { stage, storedVersion, cause: error.name })
  }
  // Chronology: system head / surface-before-step / seq-gap chronology
  // refusals from the official chain.
  if (/system head|chronolog/i.test(message)) {
    return new LegacyMigrationError(LEGACY_CODES.CHRONOLOGY_UNREACHABLE, message,
      { stage, storedVersion, cause: error.name })
  }
  if (unsupported) {
    // An unsupported-migration refusal that names neither chronology nor
    // child evidence stays in its own class rather than being misfiled.
    return new LegacyMigrationError(LEGACY_CODES.HEADER_UNSUPPORTED, message,
      { stage, storedVersion, cause: error.name })
  }
  return new LegacyMigrationError(LEGACY_CODES.ROW_DECODE_FAILED, message,
    { stage, storedVersion, cause: error.name })
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
      // A chronology refusal (system-head acquisition) thrown at row-admission
      // time is a chronology failure, not a mere bad row.
      if (/system head|chronolog/i.test(error.message ?? '')) {
        throw new LegacyMigrationError(
          LEGACY_CODES.CHRONOLOGY_UNREACHABLE,
          `row ${rowCount}: ${error.message}`,
          { row: rowCount, storedVersion: physicalHeader.version },
        )
      }
      throw new LegacyMigrationError(
        LEGACY_CODES.ROW_DECODE_FAILED,
        `row ${rowCount} failed to decode: ${error.message}`,
        { row: rowCount, storedVersion: physicalHeader.version },
      )
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
  // A v3-era artifact STILL requires the child-bound catalog to reach v4 —
  // even when the caller passed childFacts: null (interpreted upstream as
  // "no direct children seen"). Route through restoreParentWithChildren so
  // the historical→current migration completes; encodeCurrent rejects v3.
  if (useHistorical && artifact.header.version < 4) {
    const parent = await restoreParentWithChildren(physicalHeader, physicalRows, [], { recovery })
    return {
      artifact: parent.artifact,
      classification: cls,
      rowCount,
      usedHistorical: useHistorical,
      collectedEvents: collected,
      physicalRows,
    }
  }
  return { artifact, classification: cls, rowCount, usedHistorical: useHistorical, collectedEvents: collected, physicalRows }
}

/**
 * Build child evidence facts for v3→v4 parent migration.
 * childArtifacts: already-restored artifacts of DIRECT child sessions
 * (origin === 'subagent' && parentSession === parentId). Returns facts for
 * createSessionFormatCatalogWithChildren.
 */
export async function childFactsFromArtifacts(childArtifacts) {
  const { v3 } = await ensureModules()
  return childArtifacts.map(artifact => v3.historicalChildCatalogSource(artifact))
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
      throw new LegacyMigrationError(
        LEGACY_CODES.ROW_DECODE_FAILED,
        `parent row ${rowCount} failed to decode: ${error.message}`,
        { row: rowCount, storedVersion: parentHeader.version },
      )
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
export async function migrateToV4(physicalHeader, physicalRows, { childFacts = null, recovery = 'strict' } = {}) {
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
