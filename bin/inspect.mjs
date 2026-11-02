#!/usr/bin/env node
// dsh-dsha-migrator inspect CLI — READ-ONLY diagnostic tool (P1 unified entry).
//
// Default mode: the full read-only pipeline from lib/inspect-sessions.js —
// archive verification → controlled private staging (canonical allowlist) →
// highest canonical generation selection → header/location binding →
// direct-child evidence binding → official recovery chain → canonical v4
// round-trip self-check → sanitized per-session report. Staging lives in a
// temp directory (or --staging-root) and is REMOVED and VERIFIED REMOVED
// before the cleanup receipt is printed; the process exits naturally so
// cleanup cannot be skipped (process.exit would bypass the finally block —
// the bug that left private session copies on disk).
//
// --inventory: lightweight archive census only (no staging, no session
// restore) — kept as a fast diagnostic; NOT a session importability verdict.
//
// Usage: node bin/inspect.mjs <backup-file> [--inventory]
//        [--staging-root <dir>] [--limits k=v,…]

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectSessions, CANONICAL_SESSION_LOG_RE, sanitizeRoots } from '../lib/inspect-sessions.js'

function parseLimits(spec) {
  if (!spec) return {}
  const out = {}
  for (const pair of String(spec).split(',')) {
    const [k, v] = pair.split('=')
    if (!k || v === undefined) throw new Error(`bad --limits entry ${pair}`)
    let n = v.startsWith('0x') || /^\d+n$/.test(v)
      ? (v.endsWith('n') ? BigInt(v.slice(0, -1)) : BigInt(v))
      : Number(v)
    if (Number.isNaN(Number(n)) && typeof n !== 'bigint') throw new Error(`bad number ${v}`)
    out[k] = n
  }
  return out
}

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
const inventoryOnly = args.includes('--inventory')
const stagingIdx = args.indexOf('--staging-root')
const explicitStagingRoot = stagingIdx !== -1 ? args[stagingIdx + 1] : null
const limitsIdx = args.indexOf('--limits')
let limits = {}
if (limitsIdx !== -1) limits = parseLimits(args[limitsIdx + 1])

if (!file) {
  console.error('Usage: node bin/inspect.mjs <backup-file> [--inventory] [--staging-root <dir>] [--limits k=v,…]')
  console.error('Read-only: verifies the archive, restores sessions through the official chain, prints a sanitized report.')
  process.exitCode = 3
} else if (inventoryOnly) {
  runInventory()
} else {
  await runSessions()
}

async function runInventory() {
  // Light diagnostic census: manifest + canonical-name inventory (counts
  // generation files; does NOT choose generations or restore sessions).
  const started = Date.now()
  const tool = { tool: 'dsh-dsha-migrator inspect', at: new Date().toISOString(), file, mode: 'inventory' }
  try {
    const { readV5Backup } = await import('../lib/archive/v5-reader.js')
    const sessions = []
    const onRecord = (meta, info) => {
      if (meta.root !== 'sessions' || meta.kind !== 'FILE') return
      const name = meta.path.split('/').at(-1)
      if (!CANONICAL_SESSION_LOG_RE.test(name)) return
      const m = /^session(?:\.v(\d+))?/.exec(name)
      sessions.push({
        path: meta.path,
        generation: m[1] === undefined ? 0 : Number(m[1]),
        compressed: name.endsWith('.zstd'),
        bytes: meta.size,
        sha256: info?.sha256 ?? meta.sha256,
      })
    }
    const result = await readV5Backup(file, { limits, onRecord })
    const { manifest, stats } = result
    const byLocation = {}
    for (const s of sessions) {
      const parts = s.path.split('/')
      const sessionId = parts.length >= 2 ? parts[parts.length - 2] : '(unknown)'
      const projectKey = parts.length >= 3 ? parts.slice(0, -2).join('/') : '(unknown)'
      ;(byLocation[`${projectKey}/${sessionId}`] ??= []).push({
        file: parts.at(-1), generation: s.generation, bytes: s.bytes, compressed: s.compressed,
      })
    }
    const census = {}
    for (const s of sessions) census[s.generation] = (census[s.generation] ?? 0) + 1
    console.log(JSON.stringify({
      ...tool,
      durationMs: Date.now() - started,
      verified: true,
      manifest: {
        formatVersion: manifest.formatVersion,
        operation: manifest.operation,
        integrity: manifest.integrity,
        requestedScope: manifest.requestedScope,
        sensitivePolicy: manifest.sensitivePolicy,
        dataFormat: manifest.dataFormat,
        appVersion: manifest.appVersion,
        runtime: manifest.runtime,
        entries: manifest.entries,
        bytes: manifest.bytes,
        roots: sanitizeRoots(manifest.roots),
      },
      stats: {
        containerBytes: stats.containerBytes,
        readmeBytes: stats.readmeBytes,
        fileEntries: stats.fileEntries,
        fileVerified: stats.fileVerified,
        incomplete: stats.incomplete,
        cumulativePayloadBytes: stats.cumulativePayloadBytes,
        limits: JSON.parse(JSON.stringify(result.limits, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
      },
      sessions: { count: sessions.length, byLocation, generationCensus: census },
    }, null, 2))
    process.exitCode = 0
  } catch (error) {
    console.log(JSON.stringify({ ...tool, durationMs: Date.now() - started, verified: false, error: { message: error.message, code: error.code ?? null } }, null, 2))
    process.exitCode = 1
  }
}

async function runSessions() {
  const started = Date.now()
  const tool = { tool: 'dsh-dsha-migrator inspect', at: new Date().toISOString(), file, mode: 'sessions' }
  // Outside the host, RC4_MODULES points at a node_modules holding the
  // official 0.2.1-rc.4 packages; inside the host the bare names resolve.
  // The official location adapter is mounted from the SAME node_modules when
  // the official JSONL persistence backend is present: the authoritative
  // session directory for a header comes from the backend's OWN locate()
  // (mounted on an isolated throwaway root), never from copied encoders.
  let disposeLocation = null
  if (process.env.RC4_MODULES) {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
    const req = createRequire(join(process.env.RC4_MODULES, 'noop.js'))
    await setModuleLoader(async () => ({
      cat: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href),
      v3: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
    }))
    try {
      const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
      const cordisUrl = pathToFileURL(req.resolve('@deepseek-ai/cordis')).href
      const { Context } = await import(cordisUrl)
      const { relative } = await import('node:path')
      const { sep } = await import('node:path')
      const backendRoot = mkdtempSync(join(tmpdir(), 'dsha-locate-root-'))
      const ctx = new Context()
      await ctx.plugin(jsonl, { root: backendRoot, compression: 'zstd' })
      const store = ctx.sessionPersistence
      if (typeof store?.locate !== 'function') throw new Error('official backend locate unavailable')
      const { setLocationAdapter } = await import('../lib/migration/location.js')
      await setLocationAdapter(header => {
        const loc = store.locate({ cwd: header.cwd, id: header.id })
        return relative(backendRoot, loc.path).split(sep).slice(0, -1).join('/')
      })
      disposeLocation = async () => {
        await setLocationAdapter(null)
        try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
        rmSync(backendRoot, { recursive: true, force: true })
      }
    } catch {
      // Location adapter unavailable: sessions will be admitted as
      // location-unverified and NOT importable (honest downgrade).
      disposeLocation = null
    }
  }
  // OWNERSHIP: --staging-root is a CONTAINER, not a job directory. The job's
  // staging area is a unique subdirectory created inside it; ONLY that
  // subdirectory is ever removed. Pre-existing files in the container (the
  // caller's own objects) can never be deleted by a failed or successful run.
  const stagingRoot = explicitStagingRoot
    ? mkdtempSync(join(explicitStagingRoot, 'job-'))
    : mkdtempSync(join(tmpdir(), 'dsha-inspect-'))
  let payload = null
  let exitCode = 0
  try {
    const report = await inspectSessions(file, { stagingRoot, limits })
    payload = {
      ...tool,
      durationMs: Date.now() - started,
      archiveVerified: !report.archiveFailed,
      locationAdmission: report.locationAdmission,
      archive: report.archive,
      ambiguous: report.ambiguous,
      childEvidence: report.childEvidence,
      sessions: report.sessions,
      counts: report.counts,
      stagingSummary: report.stagingSummary,
      errors: report.errors,
      archiveFailed: report.archiveFailed ?? false,
    }
    exitCode = report.archiveFailed ? 1 : 0
  } catch (error) {
    payload = { ...tool, durationMs: Date.now() - started, verified: false, error: { message: error.message, code: error.code ?? null } }
    exitCode = 1
  }
  // Cleanup FIRST (this job's directory ONLY), verify the removal, then emit
  // the receipt — the receipt must describe what actually happened, never a
  // hardcoded true, and must NOT echo the local staging path.
  let cleanup = { cleanedUp: false, removedRoot: explicitStagingRoot ? 'container/job-*' : '<temp>' }
  try {
    rmSync(stagingRoot, { recursive: true, force: true })
  } catch (error) {
    cleanup.cleanupError = error.message.slice(0, 200)
  }
  cleanup.cleanedUp = !existsSync(stagingRoot)
  if (!cleanup.cleanedUp && !cleanup.cleanupError) {
    cleanup.cleanupError = 'staging root still exists after rmSync'
  }
  if (disposeLocation) await disposeLocation()
  // Sanitized staging summary is part of the payload (no absolute paths);
  // the cleanup receipt is appended after verified removal.
  console.log(JSON.stringify({ ...payload, staging: cleanup }, null, 2))
  process.exitCode = exitCode
}
