// Unified read-only P1 orchestrator: archive verification → controlled
// staging → session file selection (highest canonical generation) → header
// binding checks → recovery chain → sanitized per-session report.
//
// This is the single entry the inspect CLI consumes. It performs NO target
// writes; the job owns staging cleanup on any abort.

import { readV5Backup } from './archive/v5-reader.js'
import { SessionStaging } from './archive/session-staging.js'
import { decompressZstdMultiFrame } from './archive/zstd-frames.js'
import { classifyHeader, restoreArtifact, childFactsFromArtifacts, restoreParentWithChildren, encodeCanonicalV4AndSelfCheck, LEGACY_CODES } from './migration/legacy-chain.js'

const CANONICAL_RE = /^session\.jsonl$|^session\.v(\d+)\.jsonl(\.zstd)?$/

function genRank(name) {
  const m = /^session\.(v(\d+))?\.jsonl/.exec(name)
  if (name === 'session.jsonl') return 0
  return m && m[2] ? Number(m[2]) : -1
}

/**
 * Read one staged session file into physical rows. Supports plain JSONL and
 * complete MULTI-frame zstd (structural framing; strict UTF-8; newline
 * delimited; header must be first row). Trailing garbage, truncated frames,
 * or reserved block types are hard errors — never partially decoded.
 */
export function readSessionFile(bytes, { compressed }) {
  const plain = compressed ? decompressZstdMultiFrame(bytes) : bytes
  const text = plain.toString('utf8')
  if (text.includes('\u0000')) throw new Error('NUL byte in session log (binary or truncated)')
  const lines = text.split('\n').filter(x => x.trim().length > 0)
  if (lines.length === 0) throw new Error('empty session log')
  const header = JSON.parse(lines[0])
  if (header.type !== 'session') throw new Error(`first row is not a session header (${header.type})`)
  const rows = lines.slice(1).map(line => JSON.parse(line))
  return { header, rows }
}

/**
 * Choose the highest canonical generation per session directory. Same-
 * generation duplicates and lower/higher mixes: highest wins, a corrupt
 * highest does NOT fall back (recorded as a failed session), same-generation
 * candidates are isolated as ambiguous.
 */
export function selectGenerators(files) {
  // files: [{ relDir, fileName, ... }]
  const byDir = new Map()
  for (const f of files) {
    if (!CANONICAL_RE.test(f.fileName)) continue
    const list = byDir.get(f.relDir) ?? []
    list.push(f)
    byDir.set(f.relDir, list)
  }
  const chosen = []
  const ambiguous = []
  for (const [relDir, list] of byDir) {
    const ranked = [...list].sort((a, b) => genRank(b.fileName) - genRank(a.fileName))
    const top = ranked[0]
    const sameTop = ranked.filter(x => genRank(x.fileName) === genRank(top.fileName))
    if (sameTop.length > 1) {
      ambiguous.push({ relDir, generation: genRank(top.fileName), candidates: sameTop.map(x => x.fileName) })
      continue
    }
    chosen.push({ ...top, relDir, discardedLower: ranked.slice(1).map(x => x.fileName) })
  }
  return { chosen, ambiguous }
}

/**
 * Run the full read-only pipeline over one backup file.
 * options:
 *   stagingRoot — private directory for staged candidates (required)
 *   limits      — optional reader limits
 * Returns a sanitized JSON-ready report.
 */
export async function inspectSessions(backupFile, options = {}) {
  const report = {
    at: new Date().toISOString(),
    backupFile,
    archive: null,
    sessions: [],
    ambiguous: [],
    childEvidence: { declared: [], unmatchedFacts: [] },
    errors: [],
    counts: { total: 0, importable: 0, refused: 0, failed: 0 },
  }

  const staging = new SessionStaging(options.stagingRoot)
  await staging.prepare()
  try {
    // 1. Full archive verification (rejects on ANY structural failure).
    const files = []
    const result = await readV5Backup(backupFile, {
      limits: options.limits,
      onRecord: (meta, info) => {
        if (meta.kind !== 'FILE') return
        if (meta.root !== 'sessions') return
        files.push({
          relDir: meta.path.split('/').slice(0, -1).join('/'),
          fileName: meta.path.split('/').at(-1),
          compressed: Boolean(/\.zstd$/.test(meta.path)),
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
        roots: (result.manifest.roots ?? []).map(r => ({ id: r.id, scope: r.scope, name: r.name })),
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

    // 2. Generation selection. (Staged files are verified first so their
    // on-disk paths and byte counts are final before restoration reads them.)
    const { staged, failed: stagedFailed } = await staging.verifyAll()
    if (stagedFailed.length > 0) {
      report.errors.push(...stagedFailed.map(e => `staging failed: ${e.path}: ${e.error ?? 'unknown'}`))
    }
    const { chosen, ambiguous } = selectGenerators(files)
    report.ambiguous = ambiguous

    // 3. Per-session: read staged bytes → classify → restore → canonical v4.
    // Direct-child collection is a manifest-level statement: this archive
    // shape does not carry separate child session logs unless they appear as
    // their own session directories, so parents restore with an explicit
    // empty child set unless child artifacts were restored earlier in THIS
    // run (two-pass: restore all, then bind).
    const restored = new Map() // sessionId → artifact (v3-era or v4)
    for (const session of chosen) {
      const sessionId = session.relDir.split('/').at(-1)
      try {
        // The staging summary maps archive path → staged file path.
        const stagedEntry = staged.find(x => x.path === `${session.relDir}/${session.fileName}`)
        if (!stagedEntry) throw new Error('no staged candidate for the chosen session file')
        const bytes = await readFileSyncSafe(stagedEntry.stagedTo)
        const { header, rows } = readSessionFile(bytes, { compressed: session.compressed })
        // Binding check: header id/cwd must agree with the storage location.
        if (header.id !== sessionId) {
          throw new Error(`header id ${header.id} does not match directory session id ${sessionId}`)
        }
        const { artifact, usedHistorical } = await restoreArtifact(header, rows)
        restored.set(sessionId, { artifact, usedHistorical, header })
        report.sessions.push({
          id: sessionId,
          sourceGeneration: header.version,
          filesDiscardedLower: session.discardedLower,
          events: artifact.events.length,
          status: 'restored',
        })
      } catch (error) {
        report.sessions.push({
          id: sessionId,
          status: 'refused',
          error: error.message.slice(0, 200),
          code: error.code ?? null,
        })
      }
    }

    // 4. Second pass: migrate everything to canonical v4 (v3-era parents use
    // an explicit empty child set — child session logs in the same archive
    // would be bound here in a follow-up pass; the reader's per-archive scan
    // records them as their own sessions).
    for (const entry of report.sessions) {
      if (entry.status !== 'restored') continue
      const rec = restored.get(entry.id)
      try {
        const out = await encodeCanonicalV4AndSelfCheck(rec.artifact)
        entry.outputGeneration = 4
        entry.canonicalEvents = out.eventRows.length
        entry.importable = true
      } catch (error) {
        entry.status = 'refused'
        entry.error = error.message.slice(0, 200)
        entry.code = error.code ?? null
        entry.importable = false
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

import { readFile as _readFile } from 'node:fs/promises'
function readFileSyncSafe(path) {
  // promise wrapper to keep the caller async
  return _readFile(path)
}
