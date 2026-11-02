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
import { decompressZstdMultiFrame } from './archive/zstd-frames.js'
import { classifyHeader, restoreArtifact, childFactsFromArtifacts, restoreParentWithChildren, encodeCanonicalV4AndSelfCheck, LEGACY_CODES } from './migration/legacy-chain.js'
import { officialSessionDirectory } from './migration/location.js'

// Canonical session log names — INCLUDING the v0 compressed canonical
// (session.jsonl.zstd), which selection and the inventory census must both
// recognize. Exported so the CLI inventory mode shares the exact rule.
export const CANONICAL_SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/

export function canonicalGeneration(fileName) {
  const m = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(fileName)
  if (!m) return -1
  return m[1] === undefined ? 0 : Number(m[1])
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
 * Choose the highest canonical generation per session directory. Highest
 * wins; a corrupt highest does NOT fall back (recorded as a failed session);
 * same-generation candidates are isolated as ambiguous.
 *
 * missingCandidates: declared MISSING/UNREADABLE slots (same shape as files,
 * plus `missing: true` and `kind`). If a directory's highest generation has
 * only missing/unreadable slots, the directory is returned in `unavailable`
 * — the no-silent-fallback rule: a lower readable generation is NEVER
 * substituted for an explicitly unavailable higher one. When the highest
 * generation also has a readable FILE, that FILE stands (the generation is
 * available) and the missing slot stays diagnostic.
 */
export function selectGenerators(files, missingCandidates = []) {
  const byDir = new Map()
  for (const f of [...files, ...missingCandidates]) {
    if (canonicalGeneration(f.fileName) < 0) continue
    const list = byDir.get(f.relDir) ?? []
    list.push(f)
    byDir.set(f.relDir, list)
  }
  const chosen = []
  const ambiguous = []
  const unavailable = []
  for (const [relDir, list] of byDir) {
    const ranked = [...list].sort((a, b) => canonicalGeneration(b.fileName) - canonicalGeneration(a.fileName))
    const topGen = canonicalGeneration(ranked[0].fileName)
    const topGroup = ranked.filter(x => canonicalGeneration(x.fileName) === topGen)
    const topFiles = topGroup.filter(x => !x.missing)
    if (topFiles.length === 0) {
      unavailable.push({
        relDir,
        generation: topGen,
        kinds: [...new Set(topGroup.map(x => x.kind ?? 'MISSING'))],
        lowerPresent: ranked.slice(topGroup.length).map(x => x.fileName),
      })
      continue
    }
    if (topFiles.length > 1) {
      ambiguous.push({ relDir, generation: topGen, candidates: topFiles.map(x => x.fileName) })
      continue
    }
    const top = topFiles[0]
    chosen.push({ ...top, relDir, discardedLower: ranked.filter(x => x !== top).map(x => x.fileName) })
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
  const report = {
    at: new Date().toISOString(),
    backupFile,
    archive: null,
    sessions: [],
    ambiguous: [],
    childEvidence: { declared: [], unmatchedFacts: [], declaredMissing: [] },
    errors: [],
    counts: { total: 0, importable: 0, refused: 0, failed: 0 },
  }
  const budget = { ...DEFAULT_SESSION_BUDGET, ...(options.sessionBudget ?? {}) }

  const staging = new SessionStaging(options.stagingRoot)
  await staging.prepare()
  try {
    // ---- Phase 1a: full archive verification. Non-FILE records (MISSING/
    // UNREADABLE/…) are notified by the reader exactly once and tracked —
    // both for the report AND for generation selection (a declared-unavailable
    // highest generation must block silent fallback).
    const files = []
    const missingSlots = []
    const result = await readV5Backup(backupFile, {
      limits: options.limits,
      onRecord: (meta, info) => {
        if (meta.kind !== 'FILE') {
          if (meta.root === 'sessions' && CANONICAL_SESSION_LOG_RE.test(meta.path.split('/').at(-1))) {
            const fileName = meta.path.split('/').at(-1)
            missingSlots.push({
              path: meta.path,
              kind: meta.kind,
              relDir: meta.path.split('/').slice(0, -1).join('/'),
              fileName,
              generation: canonicalGeneration(fileName),
            })
          }
          return
        }
        if (meta.root !== 'sessions') return
        const fileName = meta.path.split('/').at(-1)
        if (!CANONICAL_SESSION_LOG_RE.test(fileName)) return
        files.push({
          relDir: meta.path.split('/').slice(0, -1).join('/'),
          fileName,
          compressed: fileName.endsWith('.zstd'),
          bytes: meta.size,
          sha256: info?.sha256,
        })
      },
      makeSink: staging.makeSinkFactory(),
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
    // Declared MISSING/UNREADABLE canonical slots never silently vanish —
    // and they participate in generation selection below.
    report.childEvidence.declaredMissing = missingSlots.map(({ path, kind }) => ({ path, kind }))

    // ---- Phase 1b: staging verification + generation selection (missing
    // slots included: a declared-unavailable highest generation blocks the
    // directory instead of silently falling back).
    const { staged, failed: stagedFailed } = await staging.verifyAll()
    if (stagedFailed.length > 0) {
      report.errors.push(...stagedFailed.map(e => `staging failed: ${e.path}: ${e.error ?? 'unknown'}`))
    }
    const missingCandidates = missingSlots
      .filter(s => s.kind === 'MISSING' || s.kind === 'UNREADABLE')
      .map(s => ({ relDir: s.relDir, fileName: s.fileName, generation: s.generation, missing: true, kind: s.kind }))
    const { chosen, ambiguous, unavailable } = selectGenerators(files, missingCandidates)
    report.ambiguous = ambiguous
    report.unavailableDirs = unavailable

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

    // ---- Phase 2: child-evidence binding + migration to canonical v4.
    // Direct children of a historical parent are matched from every VERIFIED
    // candidate; unreadable-rows children with verified identity contribute
    // explicit empty-descriptor facts; the official chain decides. v4
    // children are NOT specially rejected — their restored artifact goes
    // through the same historicalChildCatalogSource and the official
    // withChildren chain rules on the parent.
    const migratable = candidates.filter(c => c.verified && !c.duplicate && !c.parseError && !c.restoreError)
    const evidenceEligible = candidates.filter(c => c.verified && !c.duplicate)
    // Directories whose highest canonical generation is explicitly declared
    // MISSING/UNREADABLE: refused with a stable reason, lower generations
    // kept as diagnostics — never substituted.
    for (const u of report.unavailableDirs ?? []) {
      report.sessions.push({
        id: u.relDir.split('/').at(-1),
        status: 'refused',
        sourceGeneration: u.generation,
        error: `highest canonical generation (v${u.generation}) is declared ${u.kinds.join('/')} — no silent fallback to a lower generation`,
        code: 'LEGACY_GENERATION_UNAVAILABLE',
        lowerGenerationsPresent: u.lowerPresent,
      })
    }
    // Emit every candidate's row UPFRONT so phase 2 can finalize in place
    // (ids are unique: duplicates were isolated, one row per directory slot).
    for (const c of candidates) {
      const error = c.verifyError ?? c.parseError ?? c.restoreError
      if (!c.verified || c.duplicate || error) {
        report.sessions.push({
          id: c.id,
          status: 'refused',
          sourceGeneration: c.sourceGeneration,
          error: c.duplicate
            ? `duplicate session id ${c.header?.id} across directories; both candidates isolated`
            : error.message,
          code: c.duplicate ? 'LEGACY_DUPLICATE_SESSION_ID' : (error.code ?? null),
        })
      } else {
        report.sessions.push({
          id: c.id,
          status: 'restored',
          sourceGeneration: c.sourceGeneration,
          headerVersion: c.header.version,
          events: c.artifact.events.length,
          binding: c.binding,
          filesDiscardedLower: c.filesDiscardedLower,
        })
      }
    }

    for (const parent of migratable) {
      const entry = report.sessions.find(s => s.id === parent.id)
      try {
        let artifact
        if (parent.header.version < 4) {
          const direct = evidenceEligible.filter(c =>
            c !== parent &&
            c.header.origin === 'subagent' &&
            c.header.parentSession === parent.header.id)
          const facts = []
          for (const child of direct) {
            if (child.parseError || child.restoreError) {
              // Rows unreadable, identity/time VERIFIED (classification +
              // location + generation all passed): explicit empty-descriptor
              // fact in the OFFICIAL shape; the official chain decides.
              facts.push({
                childId: child.header.id,
                childCreatedAt: child.header.createdAt,
                descriptorCount: 0,
                descriptor: null,
              })
              report.childEvidence.declared.push({ parent: parent.header.id, child: child.header.id, mode: 'unavailable-fact', sourceDirectory: child.directory })
              continue
            }
            facts.push(...await childFactsFromArtifacts([child.artifact]))
            report.childEvidence.declared.push({ parent: parent.header.id, child: child.header.id, mode: 'bound' })
          }
          const bound = await restoreParentWithChildren(parent.header, parent.rows, facts)
          artifact = bound.artifact
        } else {
          artifact = parent.artifact
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
        // Admission: importable REQUIRES the official location binding. A
        // location-unverified session is never counted importable.
        entry.locationVerified = parent.binding.location === 'official-locate'
        entry.importable = entry.locationVerified
      } catch (error) {
        entry.status = 'refused'
        entry.error = error.message
        entry.code = error.code ?? null
        entry.importable = false
      }
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
    }
    report.stagingSummary = staging.summarize()
    return report
  } catch (error) {
    // Archive-level failure: no candidates may be published; clean up.
    await staging.cleanupAll()
    report.archiveFailed = true
    report.errors.push(error.message.slice(0, 200))
    return report
  }
}
