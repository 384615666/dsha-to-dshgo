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
export async function restoreArtifact(physicalHeader, physicalRows, { recovery = 'strict' } = {}) {
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
      throw new LegacyMigrationError(
        LEGACY_CODES.ROW_DECODE_FAILED,
        `row ${rowCount} failed to decode: ${error.message}`,
        { row: rowCount, storedVersion: physicalHeader.version },
      )
    }
  }
  let artifact
  if (typeof restore.finish === 'function') {
    artifact = restore.finish(context)
  } else {
    artifact = restore.finish()
  }
  // Normalize: the emitEvent contract yields events in `collected` and no
  // artifact object — synthesize one so downstream code is uniform.
  if (!artifact || typeof artifact !== 'object' || !Array.isArray(artifact.events)) {
    artifact = {
      header: restore.header ?? cls.header ?? physicalHeader,
      events: collected,
      inheritedEventCount: typeof artifact === 'number' ? artifact : 0,
    }
  } else if (collected.length > 0 && (!artifact.events || artifact.events.length === 0)) {
    artifact.events = collected
  }
  return { artifact, classification: cls, rowCount, usedHistorical: useHistorical, collectedEvents: collected }
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
export async function restoreParentWithChildren(parentHeader, parentRows, childFacts, { recovery = 'strict' } = {}) {
  const { cat } = await ensureModules()
  const catalog = cat.createSessionFormatCatalogWithChildren(childFacts)
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
  return { artifact: restore.finish(), rowCount }
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
  if (rt.events.length !== artifact.events.length) {
    throw new LegacyMigrationError(
      LEGACY_CODES.CHRONOLOGY_UNREACHABLE,
      `round-trip event count mismatch: ${rt.events.length} != ${artifact.events.length}`,
      {},
    )
  }
  const h1 = artifact.header
  const h2 = rt.header
  for (const key of ['version', 'id', 'createdAt', 'cwd', 'isSeeded', 'agentPreset']) {
    if ((h1[key] ?? null) !== (h2[key] ?? null)) {
      throw new LegacyMigrationError(
        LEGACY_CODES.CHRONOLOGY_UNREACHABLE,
        `round-trip header mismatch on ${key}`,
        { before: h1[key] ?? null, after: h2[key] ?? null },
      )
    }
  }
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
