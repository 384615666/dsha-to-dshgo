// Unified read-only P1 orchestrator (two-phase, child-evidence aware):
// archive verification → controlled staging (canonical allowlist) → highest
// canonical generation selection → header/location/generation binding →
// duplicate-ID isolation → direct-child evidence collection (origin ===
// 'subagent' && parentSession === parentId) → official chain restore →
// canonical v4 round-trip self-check → sanitized per-session report.
//
// This is the single entry the inspect CLI consumes. It performs NO target
// writes; the caller owns staging cleanup on any abort.

import { readFile as readFileAsync } from 'node:fs/promises'
import { readV5Backup } from './archive/v5-reader.js'
import { SessionStaging } from './archive/session-staging.js'
import { decompressZstdMultiFrame } from './archive/zstd-frames.js'
import { classifyHeader, restoreArtifact, childFactsFromArtifacts, restoreParentWithChildren, encodeCanonicalV4AndSelfCheck, LEGACY_CODES } from './migration/legacy-chain.js'

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

const fold = s => String(s).normalize('NFC').toLowerCase()

// Binding error with a stable code (the report carries error.code).
function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

/**
 * Default per-session budgets AFTER decompression. The archive-level limits
 * bound container reads; these bound what ONE staged log may expand to
 * (decompressed bytes and physical rows) plus what one restore may emit.
 */
export const DEFAULT_SESSION_BUDGET = { maxDecompressedBytes: 64 * 1024 * 1024, maxRows: 500_000 }

// Fatal UTF-8: replacement decoding (0xff → U+FFFD) would rewrite session
// content BEFORE the official chain sees it — a corruption the round-trip
// cannot detect. Invalid UTF-8 must refuse the whole session log.
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Read one staged session file into physical rows. Plain JSONL or complete
 * MULTI-frame zstd (structural framing). Strict: fatal UTF-8, NUL check,
 * newline-delimited JSON, header first row, decompression/row budgets.
 */
export function readSessionFile(bytes, { compressed }, budget = DEFAULT_SESSION_BUDGET) {
  const plain = compressed ? decompressZstdMultiFrame(bytes) : bytes
  if (plain.length > budget.maxDecompressedBytes) {
    throw coded(LEGACY_CODES.ROW_DECODE_FAILED, `decompressed log ${plain.length} B over per-session budget ${budget.maxDecompressedBytes} B`)
  }
  let text
  try {
    text = FATAL_UTF8.decode(plain)
  } catch {
    throw coded(LEGACY_CODES.ROW_DECODE_FAILED, 'session log is not strictly valid UTF-8')
  }
  if (text.includes('\u0000')) throw coded(LEGACY_CODES.ROW_DECODE_FAILED, 'NUL byte in session log (binary or truncated)')
  const lines = text.split('\n').filter(x => x.trim().length > 0)
  if (lines.length === 0) throw coded(LEGACY_CODES.ROW_DECODE_FAILED, 'empty session log')
  if (lines.length - 1 > budget.maxRows) {
    throw coded(LEGACY_CODES.ROW_DECODE_FAILED, `session log ${lines.length - 1} rows over per-session budget ${budget.maxRows}`)
  }
  const header = JSON.parse(lines[0])
  if (header.type !== 'session') throw coded(LEGACY_CODES.ROW_DECODE_FAILED, `first row is not a session header (${header.type})`)
  const rows = lines.slice(1).map(line => JSON.parse(line))
  return { header, rows }
}

/**
 * Choose the highest canonical generation per session directory. Highest
 * wins; a corrupt highest does NOT fall back (recorded as a failed session);
 * same-generation candidates are isolated as ambiguous.
 */
export function selectGenerators(files) {
  const byDir = new Map()
  for (const f of files) {
    if (canonicalGeneration(f.fileName) < 0) continue
    const list = byDir.get(f.relDir) ?? []
    list.push(f)
    byDir.set(f.relDir, list)
  }
  const chosen = []
  const ambiguous = []
  for (const [relDir, list] of byDir) {
    const ranked = [...list].sort((a, b) => canonicalGeneration(b.fileName) - canonicalGeneration(a.fileName))
    const top = ranked[0]
    const sameTop = ranked.filter(x => canonicalGeneration(x.fileName) === canonicalGeneration(top.fileName))
    if (sameTop.length > 1) {
      ambiguous.push({ relDir, generation: canonicalGeneration(top.fileName), candidates: sameTop.map(x => x.fileName) })
      continue
    }
    chosen.push({ ...top, relDir, discardedLower: ranked.slice(1).map(x => x.fileName) })
  }
  return { chosen, ambiguous }
}

/**
 * Run the full read-only pipeline over one backup file.
 * options:
 *   stagingRoot   — private directory for staged candidates (required)
 *   limits        — optional reader (container) limits
 *   sessionBudget — optional overrides for DEFAULT_SESSION_BUDGET
 * Returns a sanitized JSON-ready report (no private absolute paths, no
 * credential/bridge root metadata).
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
    // ---- Phase 1a: full archive verification (rejects ANY structural
    // failure; excluded-name files participate in integrity, not staging).
    const files = []
    const missing = []
    const result = await readV5Backup(backupFile, {
      limits: options.limits,
      onRecord: (meta, info) => {
        if (meta.kind === 'MISSING') {
          missing.push({ root: meta.root, path: meta.path })
          return
        }
        if (meta.kind !== 'FILE' || meta.root !== 'sessions') return
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
    // Declared-but-missing session slots never silently vanish.
    report.childEvidence.declaredMissing = missing
      .filter(m => m.root === 'sessions')
      .map(m => ({ path: m.path }))

    // ---- Phase 1b: staging verification + generation selection.
    const { staged, failed: stagedFailed } = await staging.verifyAll()
    if (stagedFailed.length > 0) {
      report.errors.push(...stagedFailed.map(e => `staging failed: ${e.path}: ${e.error ?? 'unknown'}`))
    }
    const { chosen, ambiguous } = selectGenerators(files)
    report.ambiguous = ambiguous

    // ---- Phase 1c: read + bind every chosen candidate. Binding covers the
    // checks verifiable offline: header.id vs directory segment (exact or
    // NFC-casefold), header.version vs the selected FILENAME generation.
    // cwd↔projectKey needs the host's own segment encoder and is recorded
    // as explicitly unverified rather than silently claimed.
    const candidates = []
    for (const session of chosen) {
      const dirId = session.relDir.split('/').at(-1)
      const entry = {
        id: dirId,
        directory: session.relDir,
        sourceGeneration: canonicalGeneration(session.fileName),
        filesDiscardedLower: session.discardedLower,
      }
      try {
        const stagedEntry = staged.find(x => x.path === `${session.relDir}/${session.fileName}`)
        if (!stagedEntry) throw coded(LEGACY_CODES.ROW_DECODE_FAILED, 'no staged candidate for the chosen session file')
        const bytes = await readFileAsync(stagedEntry.stagedTo)
        const { header, rows } = readSessionFile(bytes, { compressed: session.compressed }, budget)
        if (header.id !== dirId && fold(header.id) !== fold(dirId)) {
          throw coded('LEGACY_BINDING_MISMATCH', `header id ${header.id} does not match directory session id ${dirId}`)
        }
        if (Number(header.version) !== entry.sourceGeneration) {
          throw coded('LEGACY_GENERATION_MISMATCH', `header version ${header.version} does not match selected file generation ${entry.sourceGeneration}`)
        }
        entry.header = header
        entry.rows = rows
        entry.binding = {
          idDirectory: header.id === dirId ? 'exact' : 'casefold',
          generationName: 'match',
          cwdProjectKey: 'unverified-offline',
        }
      } catch (error) {
        entry.parseError = error
        // Identity salvage: even when the ROWS are unreadable, the header
        // line may still validate the session's identity/time. That lets a
        // declared direct child contribute an explicit empty-descriptor fact
        // (official chain decides) instead of silently vanishing from the
        // parent's evidence set. A header that fails to parse leaves
        // identity unverifiable — no fact may be fabricated from it.
        try {
          const stagedEntry2 = staged.find(x => x.path === `${session.relDir}/${session.fileName}`)
          if (stagedEntry2) {
            const bytes = await readFileAsync(stagedEntry2.stagedTo)
            const plain = session.compressed ? decompressZstdMultiFrame(bytes) : bytes
            const firstLine = FATAL_UTF8.decode(plain).split('\n')[0]
            const salvaged = JSON.parse(firstLine)
            if (salvaged && salvaged.type === 'session' && salvaged.id) {
              entry.header = salvaged
              entry.headerOnly = true
              entry.parseError = error
            }
          }
        } catch {
          // identity stays unverifiable
        }
      }
      candidates.push(entry)
    }

    // ---- Phase 1d: duplicate-ID isolation BEFORE any artifact is shared.
    // Two directories claiming the same header id must not let one report
    // row reference another's artifact.
    const seenIds = new Map()
    for (const c of candidates) {
      if (c.parseError || !c.header) continue
      const key = fold(c.header.id)
      if (seenIds.has(key)) {
        seenIds.get(key).duplicate = true
        c.duplicate = true
      } else {
        seenIds.set(key, c)
      }
    }

    // ---- Phase 1e: restore every clean candidate (children included).
    for (const c of candidates) {
      if (c.parseError || c.duplicate) continue
      try {
        const restored = await restoreArtifact(c.header, c.rows)
        c.artifact = restored.artifact
        c.usedHistorical = restored.usedHistorical
        c.rowCount = restored.rowCount
      } catch (error) {
        c.restoreError = error
      }
    }

    // ---- Phase 2: child-evidence binding + migration to canonical v4.
    // Direct children of a historical (v0–v3) parent are collected by the
    // parent's OWN id (origin === 'subagent' && parentSession === parentId);
    // facts from other parents never mix in. The empty set is passed only
    // after scanning confirmed no direct children.
    const migratable = candidates.filter(c => !c.parseError && !c.duplicate && !c.restoreError)
    const reportEntry = c => {
      const found = report.sessions.find(s => s.id === c.id)
      return found
    }
    // First emit per-candidate rows so every candidate appears exactly once.
    for (const c of candidates) {
      if (c.parseError) {
        report.sessions.push({
          id: c.id,
          status: 'refused',
          sourceGeneration: c.sourceGeneration,
          error: c.parseError.message.slice(0, 200),
          code: c.parseError.code ?? null,
        })
      } else if (c.duplicate) {
        report.sessions.push({
          id: c.id,
          status: 'refused',
          sourceGeneration: c.sourceGeneration,
          error: `duplicate session id ${c.header.id} across directories; both candidates isolated`,
          code: 'LEGACY_DUPLICATE_SESSION_ID',
        })
      } else if (c.restoreError) {
        report.sessions.push({
          id: c.id,
          status: 'refused',
          sourceGeneration: c.sourceGeneration,
          error: c.restoreError.message.slice(0, 200),
          code: c.restoreError.code ?? null,
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
      const entry = reportEntry(parent)
      try {
        let artifact
        if (parent.header.version < 4) {
          // Collect THIS parent's direct children from every scanned
          // candidate — including unreadable ones with a salvaged header —
          // so declared child slots never silently vanish. Duplicates
          // (identity ambiguous) are excluded; their facts must not bind.
          const direct = candidates.filter(c =>
            c !== parent &&
            !c.duplicate &&
            c.header &&
            c.header.origin === 'subagent' &&
            c.header.parentSession === parent.header.id)
          const facts = []
          let isolation = null
          for (const child of direct) {
            if (child.header.version >= 4) {
              isolation = `direct child ${child.header.id} is v${child.header.version}, inconsistent with historical parent ${parent.header.id}`
              break
            }
            if (child.parseError || child.restoreError) {
              // Identity/time validated from the (salvaged) child header;
              // its rows are unreadable — offer an explicit empty-descriptor
              // fact and let the official chain decide (never fabricate
              // descriptors).
              facts.push({
                childId: child.header.id,
                childCreatedAt: child.header.createdAt,
                descriptorCount: 0,
                descriptor: null,
              })
              report.childEvidence.declared.push({ parent: parent.header.id, child: child.header.id, mode: 'unavailable-fact' })
              continue
            }
            facts.push(...await childFactsFromArtifacts([child.artifact]))
            report.childEvidence.declared.push({ parent: parent.header.id, child: child.header.id, mode: 'bound' })
          }
          if (isolation) throw coded(LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE, isolation)
          const bound = await restoreParentWithChildren(parent.header, parent.rows, facts)
          artifact = bound.artifact
        } else {
          artifact = parent.artifact
        }
        const out = await encodeCanonicalV4AndSelfCheck(artifact)
        entry.outputGeneration = 4
        entry.canonicalEvents = out.eventRows.length
        entry.importable = true
        entry.inheritedEventCount = out.inheritedEventCount
      } catch (error) {
        entry.status = 'refused'
        entry.error = error.message.slice(0, 200)
        entry.code = error.code ?? null
        entry.importable = false
      }
    }

    // Children referenced by parents that were themselves refused or absent:
    // unmatched child declarations (the child's parentSession names a parent
    // that is not a migratable historical candidate here).
    const migratableIds = new Set(migratable.filter(c => c.header.version < 4).map(c => c.header.id))
    for (const c of migratable) {
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
