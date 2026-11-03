// Unified read-only P1 orchestrator (two-phase, child-evidence aware):
// archive verification → controlled staging (canonical allowlist) → highest
// canonical generation selection → VERIFIED header binding (official
// location, filename generation, official classification — for restored AND
// salvaged headers alike) → duplicate-ID isolation → direct-child evidence
// (origin === 'subagent' && parentSession === parentId; v4 children included,
// the official chain decides) → official chain restore → canonical v4
// round-trip self-check → sanitized per-session report.
//
// Admission rule: `importable: true` requires FULL verification including the
// official location binding. Without a location adapter the binding is
// reported as unverified and the session is NOT importable.
//
// This is the single entry the inspect CLI consumes. It performs NO target
// writes; the caller owns staging cleanup on any abort.

import { readFile as readFileAsync } from 'node:fs/promises'
import { readV5Backup } from './archive/v5-reader.js'
import { SessionStaging } from './archive/session-staging.js'
import { ATTACHMENT_ROOT_NAME } from './archive/attachment-staging.js'
import { decompressZstdMultiFrame } from './archive/zstd-frames.js'
import { classifyHeader, restoreArtifact, childFactsFromArtifacts, restoreParentWithChildren, encodeCanonicalV4AndSelfCheck, LEGACY_CODES } from './migration/legacy-chain.js'
import { officialSessionDirectory } from './migration/location.js'

// Canonical session log names, decided by the OFFICIAL rule rather than a
// permissive local variant (CORE-AUDIT B5 / plan §5.2):
//   dsh-session-format/lib/index.js  CANONICAL_LOG_FILENAME =
//     /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u
//   dsh-session-persistence-jsonl/lib/index.js  parseGenerationLogFilename =
//     strip the configured `.zstd` compression suffix, then apply that basename.
// So: `session.jsonl` is v0, `session.vN.jsonl` is vN for N ≥ 1, each optionally
// `.zstd`. `.v0`, leading zeros (`.v01`), uppercase/mixed-case variants,
// temporary names and foreign suffixes are NOT canonical generation slots — a
// leftover such file must neither create a generation nor manufacture ambiguity
// against a real one.
const CANONICAL_LOG_BASENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u
const ZSTD_SUFFIX = '.zstd'

/**
 * Generation named by one archive entry name, or -1 when the name is not a
 * canonical generation slot. Mirrors the official parser exactly.
 */
export function canonicalGeneration(fileName) {
  if (typeof fileName !== 'string') return -1
  const base = fileName.endsWith(ZSTD_SUFFIX) ? fileName.slice(0, -ZSTD_SUFFIX.length) : fileName
  const match = CANONICAL_LOG_BASENAME.exec(base)
  if (match === null) return -1
  const generation = match[1] === undefined ? 0 : Number(match[1])
  return Number.isSafeInteger(generation) ? generation : -1
}

// The SAME strict rule as a RegExp, kept only for callers that need a predicate
// (the CLI inventory census). It is not wider than the official rule.
export const CANONICAL_SESSION_LOG_RE = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u

// A name that TRIES to be a session log but is not canonical (e.g.
// `session.v0.jsonl`, `Session.v4.jsonl`, `session.v4.jsonl.tmp`). Such a slot
// in a directory with no canonical generation is reported instead of silently
// vanishing, but it never participates in generation selection.
const SESSION_LOG_LIKE = /^session(?:[.\-][^/]*)?\.jsonl(?:[.\-][^/]*)?$/iu

function looksLikeSessionLog(fileName) {
  return typeof fileName === 'string' && SESSION_LOG_LIKE.test(fileName)
}

// Stable isolation vocabulary for refused report rows: the Lead's controller/UI
// can branch on `reason` without parsing prose, and `code` stays the precise
// public error code.
const REASON_BY_CODE = Object.freeze({
  LEGACY_GENERATION_UNAVAILABLE: 'highest-generation-unavailable',
  LEGACY_GENERATION_AMBIGUOUS: 'ambiguous-generation',
  LEGACY_NONCANONICAL_SESSION_NAME: 'noncanonical-session-name',
  LEGACY_DUPLICATE_SESSION_ID: 'duplicate-session-id',
  LEGACY_CHILD_EVIDENCE_INCOMPLETE: 'child-evidence-incomplete',
  LEGACY_HEADER_UNSUPPORTED: 'header-unsupported',
  LEGACY_CHRONOLOGY_UNREACHABLE: 'chronology-unreachable',
  LEGACY_ROW_DECODE_FAILED: 'row-decode-failed',
  LEGACY_LOCATION_MISMATCH: 'location-mismatch',
  LEGACY_GENERATION_MISMATCH: 'generation-mismatch',
  LEGACY_ROUNDTRIP_MISMATCH: 'roundtrip-mismatch',
  SESSION_ROW_MALFORMED: 'row-malformed',
  SESSION_HEADER_MALFORMED: 'header-malformed',
  SESSION_EMPTY: 'log-empty',
  SESSION_NOT_UTF8: 'log-not-utf8',
  SESSION_BINARY: 'log-binary',
  SESSION_BUDGET: 'log-over-budget',
  SESSION_STAGING_MISSING: 'log-not-staged',
})

function refusedReason(code) {
  if (typeof code !== 'string' || code === '') return 'refused'
  return REASON_BY_CODE[code] ?? code.replace(/_/g, '-').toLowerCase()
}

// Isolation reasons that must be surfaced as "sessions held back" (never as a
// clean 0/0 preview, CORE-AUDIT B4): directory-level isolations plus sessions
// withheld because their dependency group (parent chain) is not importable.
const ISOLATION_REASONS = new Set([
  'highest-generation-unavailable',
  'ambiguous-generation',
  'noncanonical-session-name',
  'parent-isolated',
])

/**
 * Child-evidence closure invariant: a parent's OWN source rows may already
 * declare subagent/catalog children (v1–v3 shape). Binding child facts can only
 * ADD catalog events — a restored artifact that lost one means the evidence
 * chain dropped a declared child. Refuse instead of importing a parent whose
 * catalog was silently emptied (CORE-AUDIT B1 / plan §5.2-3).
 */
export function assertChildCatalogPreserved(sourceRows, artifact) {
  const declared = (sourceRows ?? []).filter(row => row?.type === 'subagent/catalog').length
  const restored = (artifact?.events ?? []).filter(event => event?.type === 'subagent/catalog').length
  if (restored < declared) {
    throw coded(LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE,
      `restored artifact has ${restored} subagent/catalog event(s); the source rows declared ${declared}`,
      { declared, restored })
  }
  return { declared, restored }
}

// Root names never listed in reports (credentials/bridge/identity metadata).
// They still participate in archive integrity verification — exclusion is a
// reporting boundary, not an integrity exemption.
const SENSITIVE_ROOT_RE = /credential|bridge|token|secret|password|anonymous|auth/i

export function sanitizeRoots(roots = []) {
  const visible = roots.filter(r => !SENSITIVE_ROOT_RE.test(r.name ?? ''))
  return {
    listed: visible.map(r => ({ id: r.id, scope: r.scope, name: r.name })),
    excludedSensitive: roots.length - visible.length,
  }
}

// Binding error with a stable code (the report carries error.code).
// Messages are FIXED text: parse failures must never echo source fragments
// from the damaged log (they can carry chat or tool-parameter content).
function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

/**
 * Default per-session budgets AFTER decompression. The archive-level limits
 * bound container reads; these bound what ONE staged log may expand to.
 * maxDecompressedBytes/maxRows are enforced DURING parsing (the decompressor
 * stops at the first frame crossing the budget); maxEvents bounds one
 * restore's logical-event expansion, checked before any further use.
 */
export const DEFAULT_SESSION_BUDGET = { maxDecompressedBytes: 64 * 1024 * 1024, maxRows: 500_000, maxEvents: 500_000 }

// Fatal UTF-8: replacement decoding (0xff → U+FFFD) would rewrite session
// content BEFORE the official chain sees it — a corruption the round-trip
// cannot detect. Invalid UTF-8 must refuse the whole session log.
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Read one staged session file into physical rows. Plain JSONL or complete
 * MULTI-frame zstd (structural framing). Strict: fatal UTF-8, NUL check,
 * newline-delimited JSON, header first row, budgets enforced during parsing.
 *
 * Error messages are stable and fixed — no source fragments. A row that
 * fails JSON parsing throws with `error.header` attached (the header parsed
 * fine under the same budget), so identity evidence never needs a second,
 * unbounded decompression pass.
 */
export function readSessionFile(bytes, { compressed }, budget = DEFAULT_SESSION_BUDGET) {
  const plain = compressed
    ? decompressZstdMultiFrame(bytes, { maxBytes: budget.maxDecompressedBytes })
    : bytes
  if (plain.length > budget.maxDecompressedBytes) {
    throw coded('SESSION_BUDGET', `decompressed log ${plain.length} B over per-session budget ${budget.maxDecompressedBytes} B`)
  }
  let text
  try {
    text = FATAL_UTF8.decode(plain)
  } catch {
    throw coded('SESSION_NOT_UTF8', 'session log is not strictly valid UTF-8')
  }
  if (text.includes('\u0000')) throw coded('SESSION_BINARY', 'NUL byte in session log (binary or truncated)')
  const lines = text.split('\n').filter(x => x.trim().length > 0)
  if (lines.length === 0) throw coded('SESSION_EMPTY', 'empty session log')
  if (lines.length - 1 > budget.maxRows) {
    throw coded('SESSION_BUDGET', `session log ${lines.length - 1} rows over per-session budget ${budget.maxRows}`)
  }
  let header
  try {
    header = JSON.parse(lines[0])
  } catch {
    throw coded('SESSION_HEADER_MALFORMED', 'session header (physical row 0) is not valid JSON')
  }
  if (!header || typeof header !== 'object' || header.type !== 'session') {
    throw coded('SESSION_HEADER_MALFORMED', 'first row is not a session header')
  }
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    try {
      rows.push(JSON.parse(lines[i]))
    } catch {
      const e = coded('SESSION_ROW_MALFORMED', `physical row ${i} is not valid JSON`)
      e.header = header
      throw e
    }
  }
  return { header, rows }
}

/**
 * Choose the highest canonical generation per session directory.
 *
 * `files` are FILE candidates; `declaredSlots` are every NON-FILE record of a
 * canonical generation name (MISSING/UNREADABLE/LINK/EXCLUDED/…). Both are
 * generation evidence, and the decision is made ONCE for the whole directory:
 *
 *   - the highest generation has no readable FILE (only declared slots) →
 *     UNAVAILABLE; a lower readable generation is NEVER substituted (the
 *     silent-fallback rule of plan §5.2 / CORE-AUDIT B2: importing an older
 *     generation is importing different content than the user asked for);
 *   - the highest generation has more than one FILE candidate → AMBIGUOUS;
 *     neither candidate may be imported and neither may be guessed;
 *   - otherwise the single highest FILE is chosen; declared slots of that
 *     generation and every lower generation stay as diagnostics.
 *
 * Declared slots below the highest generation never block a readable highest.
 */
export function selectGenerators(files, declaredSlots = []) {
  const byDir = new Map()
  const add = (slot, isFile) => {
    const generation = canonicalGeneration(slot.fileName)
    if (generation < 0) return
    const list = byDir.get(slot.relDir) ?? []
    list.push({ ...slot, generation, isFile })
    byDir.set(slot.relDir, list)
  }
  for (const file of files) add(file, true)
  for (const slot of declaredSlots) add(slot, false)
  const chosen = []
  const ambiguous = []
  const unavailable = []
  for (const [relDir, list] of byDir) {
    const ranked = [...list].sort((a, b) => b.generation - a.generation)
    const topGeneration = ranked[0].generation
    const topGroup = ranked.filter(slot => slot.generation === topGeneration)
    const topFiles = topGroup.filter(slot => slot.isFile)
    const declaredAtTop = topGroup.filter(slot => !slot.isFile)
    const lowerPresent = ranked.filter(slot => slot.generation < topGeneration)
    if (topFiles.length === 0) {
      unavailable.push({
        relDir,
        generation: topGeneration,
        kinds: [...new Set(topGroup.map(slot => slot.kind ?? 'MISSING'))],
        lowerPresent: lowerPresent.map(slot => slot.fileName),
        declaredFiles: topGroup.map(slot => slot.fileName),
        reason: 'highest-generation-unavailable',
      })
      continue
    }
    if (topFiles.length > 1) {
      ambiguous.push({
        relDir,
        generation: topGeneration,
        candidates: topFiles.map(slot => slot.fileName),
        declaredKinds: declaredAtTop.map(slot => slot.kind ?? 'MISSING'),
        reason: 'ambiguous-generation',
      })
      continue
    }
    const top = topFiles[0]
    chosen.push({
      ...top,
      relDir,
      discardedLower: lowerPresent.map(slot => slot.fileName),
      declaredAtHighest: declaredAtTop.map(slot => ({ fileName: slot.fileName, kind: slot.kind ?? 'MISSING' })),
    })
  }
  return { chosen, ambiguous, unavailable }
}

/**
 * Run the full read-only pipeline over one backup file.
 * options:
 *   stagingRoot   — private directory OWNED BY THIS JOB (the CLI passes a
 *                   job-unique subdirectory; nothing pre-existing inside is
 *                   touched, and failures clean only what this job created)
 *   limits        — optional reader (container) limits
 *   sessionBudget — optional overrides for DEFAULT_SESSION_BUDGET
 * Returns a sanitized JSON-ready report (no private absolute paths, no
 * credential/bridge root metadata, no source fragments from damaged logs).
 */
export async function inspectSessions(backupFile, options = {}) {
  const { report } = await inspectSessionsInternal(backupFile, options)
  return report
}

/**
 * INTERNAL: the shared verification kernel behind the public sanitized
 * inspect report and the product controller. Returns the report PLUS the
 * private canonical artifacts (header/events/cut) and the live staging
 * handles. Callers own cleanup after success; the private artifacts must
 * never be serialized into a public report.
 */
export async function inspectSessionsInternal(backupFile, options = {}) {
  const report = {
    at: new Date().toISOString(),
    backupFile,
    archive: null,
    sessions: [],
    ambiguous: [],
    unavailableDirs: [],
    nonCanonicalSessionSlots: [],
    dependencyIsolation: [],
    childEvidence: { declared: [], unmatchedFacts: [], declaredMissing: [], complete: true, unattributed: [] },
    errors: [],
    // `isolated` counts sessions held back by an isolation reason
    // (unavailable/ambiguous/non-canonical directories and dependency-group
    // withholding); without it the preview could claim "0/0" while sessions
    // were silently excluded (CORE-AUDIT B4).
    counts: { total: 0, importable: 0, refused: 0, failed: 0, isolated: 0 },
  }
  const budget = { ...DEFAULT_SESSION_BUDGET, ...(options.sessionBudget ?? {}) }
  const attachmentStaging = options.attachmentStaging ?? null
  const privateArtifacts = []

  const staging = new SessionStaging(options.stagingRoot)
  await staging.prepare()
  if (attachmentStaging) attachmentStaging.prepare()
  const sessionSink = staging.makeSinkFactory()
  const attachmentSink = attachmentStaging?.makeSinkFactory?.() ?? null
  try {
    // ---- Phase 1a: full archive verification. Every record is classified
    // ONCE here: canonical FILE candidates, canonical DECLARED slots (any
    // non-FILE kind — MISSING/UNREADABLE/LINK/EXCLUDED/…: a LINK or EXCLUDED
    // highest generation is exactly as unavailable as a MISSING one, CORE B2),
    // and session-log-LIKE names that are not canonical (CORE B5).
    const files = []
    const missingSlots = []
    const nonCanonicalSlots = []
    const parsePath = path => {
      const segments = path.split('/')
      return { fileName: segments.at(-1), relDir: segments.slice(0, -1).join('/') }
    }
    const result = await readV5Backup(backupFile, {
      limits: options.limits,
      onRecord: (meta, info) => {
        if (meta.root !== 'sessions') return
        const { fileName, relDir } = parsePath(meta.path)
        const generation = canonicalGeneration(fileName)
        if (meta.kind !== 'FILE') {
          if (generation >= 0) {
            missingSlots.push({ path: meta.path, kind: meta.kind, relDir, fileName, generation })
          } else if (looksLikeSessionLog(fileName)) {
            nonCanonicalSlots.push({ path: meta.path, kind: meta.kind, relDir, fileName })
          }
          return
        }
        if (generation < 0) {
          if (looksLikeSessionLog(fileName)) nonCanonicalSlots.push({ path: meta.path, kind: meta.kind, relDir, fileName })
          return
        }
        files.push({
          relDir,
          fileName,
          compressed: fileName.endsWith(ZSTD_SUFFIX),
          bytes: meta.size,
          sha256: info?.sha256,
        })
      },
      makeSink: attachmentSink
        ? meta => (meta.root === ATTACHMENT_ROOT_NAME ? attachmentSink(meta) : sessionSink(meta))
        : sessionSink,
    })
    report.archive = {
      manifest: {
        formatVersion: result.manifest.formatVersion,
        operation: result.manifest.operation,
        integrity: result.manifest.integrity,
        requestedScope: result.manifest.requestedScope,
        sensitivePolicy: result.manifest.sensitivePolicy,
        dataFormat: result.manifest.dataFormat,
        appVersion: result.manifest.appVersion,
        runtime: result.manifest.runtime,
        entries: result.manifest.entries,
        bytes: result.manifest.bytes,
        roots: sanitizeRoots(result.manifest.roots),
      },
      stats: {
        containerBytes: result.stats.containerBytes,
        readmeBytes: result.stats.readmeBytes,
        fileEntries: result.stats.fileEntries,
        fileVerified: result.stats.fileVerified,
        incomplete: result.stats.incomplete,
        cumulativePayloadBytes: result.stats.cumulativePayloadBytes,
      },
    }
    // Declared canonical slots never silently vanish — and every kind
    // (MISSING/UNREADABLE/LINK/EXCLUDED/…) participates in generation
    // selection below. An entry never gets "imported around" a declaration.
    report.childEvidence.declaredMissing = missingSlots.map(({ path, kind }) => ({ path, kind }))
    report.nonCanonicalSessionSlots = nonCanonicalSlots.map(({ path, kind, fileName }) => ({ path, kind, fileName }))

    // ---- Phase 1b: staging verification + generation selection (declared
    // slots of ANY kind included: a declared-unavailable highest generation
    // blocks the directory instead of silently falling back).
    const { staged, failed: stagedFailed } = await staging.verifyAll()
    if (stagedFailed.length > 0) {
      report.errors.push(...stagedFailed.map(e => `staging failed: ${e.path}: ${e.error ?? 'unknown'}`))
    }
    if (attachmentStaging && typeof attachmentStaging.verifyAll === 'function') {
      const verifiedAttachments = await attachmentStaging.verifyAll()
      if (verifiedAttachments.failed.length > 0) {
        report.errors.push(...verifiedAttachments.failed.map(e => `attachment staging failed: ${e.path}: ${e.error ?? 'unknown'}`))
      }
    }
    const declaredCandidates = missingSlots
      .map(s => ({ relDir: s.relDir, fileName: s.fileName, generation: s.generation, missing: true, kind: s.kind }))
    const { chosen, ambiguous, unavailable } = selectGenerators(files, declaredCandidates)
    report.ambiguous = ambiguous
    report.unavailableDirs = unavailable
    // Directories that carry a session-log-LIKE but non-canonical name and NO
    // canonical generation at all: the official backend would see no committed
    // generation, so this is reported (never imported, never silently dropped).
    const canonicalDirs = new Set([...files, ...missingSlots].map(s => s.relDir))
    const nonCanonicalOnlyDirs = [...new Set(nonCanonicalSlots.map(s => s.relDir))]
      .filter(relDir => !canonicalDirs.has(relDir))
      .sort()

    // ---- Phase 1c: read every chosen candidate. Full-parse failures keep
    // the parsed header (error.header) as SALVAGE identity — it then goes
    // through exactly the same verification chain as a full parse (official
    // classification, official location, filename generation). A salvage
    // header never becomes a fact on its own word.
    const candidates = []
    for (const session of chosen) {
      const entry = {
        id: session.relDir.split('/').at(-1),
        directory: session.relDir,
        sourceGeneration: canonicalGeneration(session.fileName),
        filesDiscardedLower: session.discardedLower,
      }
      try {
        const stagedEntry = staged.find(x => x.path === `${session.relDir}/${session.fileName}`)
        if (!stagedEntry) throw coded('SESSION_STAGING_MISSING', 'no staged candidate for the chosen session file')
        const bytes = await readFileAsync(stagedEntry.stagedTo)
        const { header, rows } = readSessionFile(bytes, { compressed: session.compressed }, budget)
        entry.header = header
        entry.rows = rows
      } catch (error) {
        entry.parseError = error
        if (error.header) entry.header = error.header // salvage identity
      }
      candidates.push(entry)
    }

    // ---- Phase 1d: VERIFIED binding for every candidate that has a header
    // (full-parse or salvage, identically): official classification →
    // official location → filename generation. Failure marks the candidate
    // refused and DISQUALIFIES it from contributing any child fact.
    const locationAdmission = officialSessionDirectory({ cwd: undefined, id: 'probe' }) !== null
      ? 'official-locate'
      : 'unverified'
    report.locationAdmission = locationAdmission
    for (const c of candidates) {
      if (!c.header) continue
      c.binding = { generationName: 'pending', location: 'pending' }
      try {
        const cls = await classifyHeader(c.header)
        // Official readHeader verdicts: 'current' (v4 on the current catalog)
        // and 'migration-required' (v0–v3 on the historical catalog) are the
        // restorable classes; 'unsupported'/'malformed' refuse — and then no
        // fact may ever form from this identity.
        if (cls.status !== 'current' && cls.status !== 'migration-required') {
          throw coded(LEGACY_CODES.HEADER_UNSUPPORTED, `header failed official classification: ${cls.reason ?? cls.status}`, { storedVersion: cls.storedVersion ?? null })
        }
        // Official location: the archive directory must equal the directory
        // the official backend itself assigns to this header (cwd + id).
        const officialDir = officialSessionDirectory(c.header)
        if (officialDir === null) {
          c.binding.location = 'unverified'
        } else if (c.directory !== officialDir) {
          throw coded('LEGACY_LOCATION_MISMATCH', 'archive directory does not match the official location for this header', {
            expectedDirectory: officialDir,
          })
        } else {
          c.binding.location = 'official-locate'
        }
        if (Number(c.header.version) !== c.sourceGeneration) {
          throw coded('LEGACY_GENERATION_MISMATCH', `header version ${c.header.version} does not match selected file generation ${c.sourceGeneration}`)
        }
        c.binding.generationName = 'match'
        c.verified = true
      } catch (error) {
        c.verifyError = error
        c.verified = false
      }
    }

    // ---- Phase 1e: duplicate-ID isolation BEFORE any artifact is shared —
    // across verified candidates only (unverified salvage identity can neither
    // claim a slot nor poison a verified one).
    const seenIds = new Map()
    for (const c of candidates) {
      if (!c.verified) continue
      const key = String(c.header.id).normalize('NFC')
      if (seenIds.has(key)) {
        seenIds.get(key).duplicate = true
        c.duplicate = true
      } else {
        seenIds.set(key, c)
      }
    }

    // ---- Phase 1f: restore every clean candidate (children included).
    for (const c of candidates) {
      if (!c.verified || c.duplicate || c.parseError) continue
      try {
        const restored = await restoreArtifact(c.header, c.rows)
        c.artifact = restored.artifact
        c.usedHistorical = restored.usedHistorical
        c.rowCount = restored.rowCount
        if (restored.artifact.events.length > budget.maxEvents) {
          throw coded('SESSION_BUDGET', `restored ${restored.artifact.events.length} events over per-session budget ${budget.maxEvents}`)
        }
      } catch (error) {
        c.restoreError = error
      }
    }

    // ---- Phase 2: child-evidence closure, binding, and migration to v4.
    //
    // A direct child is identified ONLY by a VERIFIED header
    // (origin === 'subagent' && parentSession === parentId). Any session slot
    // in this archive whose identity is not verified could be such a child:
    // an unavailable/ambiguous directory, a declared-only slot, an unverified
    // candidate (unsupported/malformed header, failed location or generation
    // binding) or a directory carrying only non-canonical names. Restoring a
    // historical parent with an empty fact set while one of those exists is
    // exactly the silent child-evidence loss of CORE-AUDIT B1; the dependency
    // group is isolated instead (plan §5.2-3: a declared-missing child log is
    // never "no children").
    //
    // v4 children are NOT specially rejected: their restored artifact goes
    // through the same historicalChildCatalogSource and the official
    // withChildren chain rules on the parent.
    const migratable = candidates.filter(c => c.verified && !c.duplicate && !c.parseError && !c.restoreError)
    const evidenceEligible = candidates.filter(c => c.verified && !c.duplicate)
    const unattributedSlots = [
      ...(report.unavailableDirs ?? []).map(u => ({
        directory: u.relDir,
        generation: u.generation,
        kinds: [...u.kinds],
        reason: 'highest-generation-unavailable',
      })),
      ...(report.ambiguous ?? []).map(a => ({
        directory: a.relDir,
        generation: a.generation,
        kinds: [...new Set(a.declaredKinds ?? [])],
        reason: 'ambiguous-generation',
      })),
      ...candidates.filter(c => !c.verified).map(c => ({
        directory: c.directory,
        generation: c.sourceGeneration,
        kinds: [c.verifyError?.code ?? c.parseError?.code ?? 'UNVERIFIED'],
        reason: 'unverified-candidate',
      })),
      ...nonCanonicalOnlyDirs.map(relDir => ({
        directory: relDir,
        generation: null,
        kinds: ['NONCANONICAL'],
        reason: 'noncanonical-session-name',
      })),
    ]
    report.childEvidence.complete = unattributedSlots.length === 0
    report.childEvidence.unattributed = unattributedSlots

    // ---- Phase 2a: isolation rows BEFORE anything else. Every directory the
    // pipeline refused to select gets a counted row carrying its reason and
    // generation, so report/counts/preview can never claim "0 sessions" while
    // sessions were isolated (CORE-AUDIT B4 / plan §5.2 "明确隔离").
    for (const u of report.unavailableDirs ?? []) {
      report.sessions.push({
        id: u.relDir.split('/').at(-1),
        directory: u.relDir,
        status: 'refused',
        sourceGeneration: u.generation,
        error: `highest canonical generation (v${u.generation}) is declared ${u.kinds.join('/')} — no silent fallback to a lower generation`,
        code: 'LEGACY_GENERATION_UNAVAILABLE',
        reason: 'highest-generation-unavailable',
        lowerGenerationsPresent: u.lowerPresent,
        declaredFiles: u.declaredFiles,
      })
    }
    for (const a of report.ambiguous ?? []) {
      report.sessions.push({
        id: a.relDir.split('/').at(-1),
        directory: a.relDir,
        status: 'refused',
        sourceGeneration: a.generation,
        error: `${a.candidates.length} canonical candidates for generation v${a.generation} — the directory is isolated and no candidate is imported`,
        code: 'LEGACY_GENERATION_AMBIGUOUS',
        reason: 'ambiguous-generation',
        candidates: a.candidates,
      })
    }
    for (const relDir of nonCanonicalOnlyDirs) {
      report.sessions.push({
        id: relDir.split('/').at(-1),
        directory: relDir,
        status: 'refused',
        sourceGeneration: null,
        error: 'directory has no canonical generation name — non-canonical log names are never imported',
        code: 'LEGACY_NONCANONICAL_SESSION_NAME',
        reason: 'noncanonical-session-name',
        nonCanonicalFiles: nonCanonicalSlots.filter(s => s.relDir === relDir).map(s => s.fileName),
      })
    }
    // Emit every candidate's row UPFRONT so phase 2b can finalize in place
    // (ids are unique: duplicates were isolated, one row per directory slot).
    // `c.row` keeps the identity link used by the dependency-group closure.
    for (const c of candidates) {
      const error = c.verifyError ?? c.parseError ?? c.restoreError
      let row
      if (!c.verified || c.duplicate || error) {
        const code = c.duplicate ? 'LEGACY_DUPLICATE_SESSION_ID' : (error?.code ?? null)
        row = {
          id: c.id,
          directory: c.directory,
          status: 'refused',
          sourceGeneration: c.sourceGeneration,
          error: c.duplicate
            ? `duplicate session id ${c.header?.id} across directories; both candidates isolated`
            : error?.message ?? 'candidate refused',
          code,
          reason: refusedReason(code),
        }
      } else {
        row = {
          id: c.id,
          directory: c.directory,
          status: 'restored',
          sourceGeneration: c.sourceGeneration,
          headerVersion: c.header.version,
          events: c.artifact.events.length,
          binding: c.binding,
          filesDiscardedLower: c.filesDiscardedLower,
        }
      }
      report.sessions.push(row)
      c.row = row
    }

    // ---- Phase 2b: bind child facts and migrate each parent to canonical v4.
    for (const parent of migratable) {
      const entry = report.sessions.find(s => s.id === parent.id)
      try {
        let artifact
        if (parent.header.version < 4) {
          if (!report.childEvidence.complete) {
            throw coded(LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE,
              `direct-child evidence cannot be closed: ${unattributedSlots.length} session slot(s) in this archive have no verified identity`,
              {
                unattributedSlots: unattributedSlots.map(s => ({
                  directory: s.directory,
                  generation: s.generation,
                  kinds: s.kinds,
                  reason: s.reason,
                })),
              })
          }
          const facts = []
          const boundChildren = []
          const unavailableChildren = []
          const seenChildIds = new Set()
          // Verified duplicates are included: their CONTENT slot is isolated,
          // but the identity/time evidence is verified, and dropping them
          // would let a declared child vanish from the parent catalog.
          for (const child of candidates) {
            if (child === parent || !child.verified || !child.header) continue
            if (child.header.origin !== 'subagent' || child.header.parentSession !== parent.header.id) continue
            const childKey = String(child.header.id).normalize('NFC')
            if (seenChildIds.has(childKey)) continue
            seenChildIds.add(childKey)
            if (child.duplicate || child.parseError || child.restoreError) {
              // Rows unreadable, identity/time VERIFIED (classification +
              // location + generation all passed): explicit empty-descriptor
              // fact in the OFFICIAL shape; the official chain decides.
              const reasonCode = child.duplicate
                ? 'LEGACY_DUPLICATE_SESSION_ID'
                : ((child.parseError ?? child.restoreError)?.code ?? null)
              facts.push({
                childId: child.header.id,
                childCreatedAt: child.header.createdAt,
                descriptorCount: 0,
                descriptor: null,
              })
              unavailableChildren.push({ child: child.header.id, code: reasonCode })
              report.childEvidence.declared.push({ parent: parent.header.id, child: child.header.id, mode: 'unavailable-fact', sourceDirectory: child.directory })
              continue
            }
            facts.push(...await childFactsFromArtifacts([child.artifact]))
            boundChildren.push(child.header.id)
            report.childEvidence.declared.push({ parent: parent.header.id, child: child.header.id, mode: 'bound' })
          }
          const bound = await restoreParentWithChildren(parent.header, parent.rows, facts)
          artifact = bound.artifact
          assertChildCatalogPreserved(parent.rows, artifact)
          entry.childEvidence = {
            status: 'closed',
            declared: boundChildren.length + unavailableChildren.length,
            bound: boundChildren.length,
            unavailable: unavailableChildren.length,
            ...(unavailableChildren.length > 0 ? { unavailableChildren } : {}),
          }
        } else {
          artifact = parent.artifact
          entry.childEvidence = { status: 'not-required', declared: 0, bound: 0, unavailable: 0 }
        }
        // FINAL event budget: child binding can ADD events to the historical
        // artifact — the budget applies to the artifact that enters the
        // canonical encode, not just the initial restore.
        if (artifact.events.length > budget.maxEvents) {
          throw coded('SESSION_BUDGET', `final artifact ${artifact.events.length} events over per-session budget ${budget.maxEvents}`)
        }
        const out = await encodeCanonicalV4AndSelfCheck(artifact)
        if (out.eventRows.length > budget.maxEvents) {
          throw coded('SESSION_BUDGET', `canonical output ${out.eventRows.length} rows over per-session budget ${budget.maxEvents}`)
        }
        entry.outputGeneration = 4
        entry.canonicalEvents = out.eventRows.length
        entry.inheritedEventCount = out.inheritedEventCount
        entry.subagentCatalogEvents = artifact.events.filter(e => e?.type === 'subagent/catalog').length
        // Admission: importable REQUIRES the official location binding. A
        // location-unverified session is never counted importable.
        entry.locationVerified = parent.binding.location === 'official-locate'
        entry.importable = entry.locationVerified
        if (entry.importable) {
          // PRIVATE artifact for the product controller. Never placed on the
          // public report; the caller owns it and must not serialize it into
          // a user-facing report.
          privateArtifacts.push({
            id: parent.header.id,
            directory: parent.directory,
            sourceGeneration: parent.sourceGeneration,
            header: artifact.header,
            events: artifact.events,
            inheritedEventCount: artifact.inheritedEventCount ?? 0,
          })
        }
      } catch (error) {
        entry.status = 'refused'
        entry.error = error.message
        entry.code = error.code ?? null
        entry.reason = refusedReason(entry.code)
        entry.importable = false
        if (entry.code === LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE) {
          // The closure gate throws a coded() error (details at the top level);
          // an official-chain refusal carries LegacyMigrationError.details.
          const slots = Array.isArray(error?.unattributedSlots)
            ? error.unattributedSlots
            : (Array.isArray(error?.details?.unattributedSlots) ? error.details.unattributedSlots : null)
          entry.childEvidence = { status: 'incomplete', ...(slots ? { unattributedSlots: slots } : {}) }
        }
      }
    }

    // ---- Phase 2c: dependency-group closure (CORE P1-1 / plan §5.2-3).
    //
    // A session that names a parent (header.parentSession) must not be imported
    // on its own when this migration refuses that parent: the target would end
    // up with a session whose parentSession points at a session that was never
    // imported. Resolution uses the VERIFIED header chain — never the `origin`
    // string or a directory-name guess:
    //   * a slot with that header.id exists and is importable → the child keeps
    //     its verdict (other verified parents are never collateral damage);
    //   * such a slot exists but is refused (child-evidence group, restore
    //     failure, duplicate, budget, location, …) → the child joins the
    //     isolated dependency group (`cause: 'isolated-parent'`);
    //   * no slot carries that id while the archive still has unverifiable
    //     session slots → the parent cannot be ruled out, so the child is
    //     conservatively withheld and reported (`cause: 'unresolved-parent'`);
    //   * no slot carries that id in a fully attributed archive → a genuine
    //     orphan; it keeps its verdict and stays visible through
    //     `childEvidence.unmatchedFacts` (no silent loss, no over-isolation).
    // Descendants are covered transitively: a withheld child may itself be a
    // parent, so the scan repeats until no verdict changes.
    const normalizeIdentity = value => String(value).normalize('NFC')
    const candidatesByHeaderId = new Map()
    for (const c of candidates) {
      if (!c.verified || !c.header) continue
      const key = normalizeIdentity(c.header.id)
      const list = candidatesByHeaderId.get(key) ?? []
      list.push(c)
      candidatesByHeaderId.set(key, list)
    }
    const dependencyIsolation = []
    for (let pass = 0; pass < candidates.length; pass += 1) {
      let changed = false
      for (const child of candidates) {
        const row = child.row
        if (!row || row.importable !== true) continue
        if (!child.verified || !child.header) continue
        const parentId = child.header.parentSession
        if (typeof parentId !== 'string' || parentId === '') continue
        const parentCandidates = candidatesByHeaderId.get(normalizeIdentity(parentId)) ?? []
        if (parentCandidates.some(parent => parent.row?.importable === true)) continue
        let cause
        if (parentCandidates.length > 0) cause = 'isolated-parent'
        else if (!report.childEvidence.complete) cause = 'unresolved-parent'
        else continue
        row.status = 'refused'
        row.importable = false
        row.code = LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE
        row.reason = 'parent-isolated'
        row.error = `parent session ${parentId} is not part of the imported dependency group — the child is withheld instead of importing it without its parent`
        row.parentIsolation = { parent: parentId, cause }
        dependencyIsolation.push({
          child: child.header.id,
          directory: child.directory,
          parent: parentId,
          cause,
        })
        changed = true
      }
      if (!changed) break
    }
    if (dependencyIsolation.length > 0) report.dependencyIsolation = dependencyIsolation
    // A withheld session must not leave a PRIVATE artifact behind: the product
    // controller imports exactly this list.
    const importableHeaderIds = new Set(candidates
      .filter(c => c.verified && c.header && c.row?.importable === true)
      .map(c => normalizeIdentity(c.header.id)))
    for (let index = privateArtifacts.length - 1; index >= 0; index -= 1) {
      if (!importableHeaderIds.has(normalizeIdentity(privateArtifacts[index].id))) privateArtifacts.splice(index, 1)
    }

    // Children whose parentSession names a parent that is not a migratable
    // historical candidate in this archive.
    const migratableIds = new Set(migratable.filter(c => c.header.version < 4).map(c => c.header.id))
    for (const c of evidenceEligible) {
      if (c.header.origin === 'subagent' && c.header.parentSession && !migratableIds.has(c.header.parentSession)) {
        report.childEvidence.unmatchedFacts.push({ child: c.header.id, parent: c.header.parentSession })
      }
    }

    for (const s of report.sessions) {
      report.counts.total += 1
      if (s.status === 'restored' && s.importable) report.counts.importable += 1
      else if (s.status === 'refused') report.counts.refused += 1
      else report.counts.failed += 1
      if (s.status === 'refused' && ISOLATION_REASONS.has(s.reason)) report.counts.isolated += 1
    }
    report.stagingSummary = staging.summarize()
    if (attachmentStaging) {
      report.attachmentStagingSummary = attachmentStaging.summarize()
    }
    return { report, artifacts: privateArtifacts, staging, attachmentStaging }
  } catch (error) {
    // Archive-level failure: no candidates may be published; clean up.
    await staging.cleanupAll()
    if (attachmentStaging) await attachmentStaging.cleanupAll()
    report.archiveFailed = true
    report.errors.push(error.message.slice(0, 200))
    return { report, artifacts: [], staging, attachmentStaging }
  }
}
