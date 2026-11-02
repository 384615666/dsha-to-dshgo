#!/usr/bin/env node
// dsh-dsha-migrator inspect CLI — READ-ONLY diagnostic tool (P1 unified entry).
//
// Default mode: the full read-only pipeline from lib/inspect-sessions.js —
// archive verification → controlled private staging → highest canonical
// generation selection → header/location binding → official recovery chain →
// canonical v4 round-trip self-check → sanitized per-session report
// (importable / refused + code). Staging lives in a temp directory and is
// removed when the run ends; nothing is written to the archive or to any
// target DSH; chat content and credentials are never printed.
//
// --inventory: lightweight archive census only (no staging, no session
// restore) — kept as a fast diagnostic; NOT a session importability verdict.
//
// Usage: node bin/inspect.mjs <backup-file> [--inventory] [--limits k=v,…]

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectSessions } from '../lib/inspect-sessions.js'

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
const limitsIdx = args.indexOf('--limits')
let limits = {}
if (limitsIdx !== -1) limits = parseLimits(args[limitsIdx + 1])

if (!file) {
  console.error('Usage: node bin/inspect.mjs <backup-file> [--inventory] [--limits k=v,…]')
  console.error('Read-only: verifies the archive, restores sessions through the official chain, prints a sanitized report.')
  process.exit(3)
}

const started = Date.now()
const tool = { tool: 'dsh-dsha-migrator inspect', at: new Date().toISOString(), file }

if (inventoryOnly) {
  // Light diagnostic census: manifest + canonical-name inventory (counts
  // generation files; does NOT choose generations or restore sessions).
  const { readV5Backup } = await import('../lib/archive/v5-reader.js')
  try {
    const sessions = []
    const onRecord = (meta, info) => {
      if (meta.root !== 'sessions' || meta.kind !== 'FILE') return
      const name = meta.path.split('/').at(-1)
      const m = /^session(?:\.v(\d+))?\.jsonl(?:\.(zstd))?$/.exec(name)
      if (!m) return
      sessions.push({
        path: meta.path,
        generation: m[1] === undefined ? 0 : Number(m[1]),
        compressed: Boolean(m[2]),
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
      mode: 'inventory',
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
        roots: (manifest.roots ?? []).map(r => ({ id: r.id, scope: r.scope, name: r.name })),
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
  } catch (error) {
    console.log(JSON.stringify({ ...tool, mode: 'inventory', durationMs: Date.now() - started, verified: false, error: { message: error.message, code: error.code ?? null } }, null, 2))
    process.exit(1)
  }
  process.exit(0)
}

// Default: full read-only pipeline. Staging is private and temporary.
// Outside the host, RC4_MODULES points at a node_modules holding the
// official 0.2.1-rc.4 packages; inside the host the bare names resolve.
if (process.env.RC4_MODULES) {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
  const req = createRequire(join(process.env.RC4_MODULES, 'noop.js'))
  await setModuleLoader(async () => ({
    cat: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href),
    v3: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
  }))
}
const stagingRoot = mkdtempSync(join(tmpdir(), 'dsha-inspect-'))
try {
  const report = await inspectSessions(file, { stagingRoot, limits })
  console.log(JSON.stringify({
    ...tool,
    mode: 'sessions',
    durationMs: Date.now() - started,
    archiveVerified: !report.archiveFailed,
    archive: report.archive,
    ambiguous: report.ambiguous,
    sessions: report.sessions,
    counts: report.counts,
    staging: { ...report.stagingSummary, cleanedUp: true },
    errors: report.errors,
    archiveFailed: report.archiveFailed ?? false,
  }, null, 2))
  process.exit(report.archiveFailed ? 1 : 0)
} catch (error) {
  console.log(JSON.stringify({ ...tool, mode: 'sessions', durationMs: Date.now() - started, verified: false, error: { message: error.message, code: error.code ?? null } }, null, 2))
  process.exit(1)
} finally {
  rmSync(stagingRoot, { recursive: true, force: true })
}
