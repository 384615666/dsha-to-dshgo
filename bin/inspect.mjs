#!/usr/bin/env node
// dsh-dsha-migrator inspect CLI — READ-ONLY diagnostic tool (P1).
//
// Verifies a DSHA one-click backup (v5) end to end and prints a sanitized
// JSON report: manifest summary, per-root/scope breakdown, and the session
// inventory (id/version/preset/event counts derived from the v4 headers).
// Never writes to the archive, never prints chat content, never extracts
// credentials; suitable for attaching to a migration report.
//
// Usage: node bin/inspect.mjs <backup-file> [--limits k=v[,k=v…]]

import { readV5Backup } from '../lib/archive/v5-reader.js'
import zlib from 'node:zlib'

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
const limitsIdx = args.indexOf('--limits')
let limits = {}
if (limitsIdx !== -1) limits = parseLimits(args[limitsIdx + 1])

if (!file) {
  console.error('Usage: node bin/inspect.mjs <backup-file> [--limits k=v,…]')
  console.error('Read-only: verifies the archive and prints a sanitized inventory.')
  process.exit(3)
}

const started = Date.now()
try {
  // Session inventory: stream FILE payloads whose path looks like
  // sessions/<projectKey>/<id>/session.v*.jsonl[.zstd]; decode the first
  // frame (the header row) for generation/version/preset, count rows.
  const sessions = []
  const onRecord = (meta, info) => {
    if (meta.root !== 'sessions' || meta.kind !== 'FILE') return
    const m = /session\.(v\d+)\.jsonl(?:\.(zstd))?$/.exec(meta.path)
    if (!m) return
    sessions.push({
      path: meta.path,
      generation: m[1],
      compressed: Boolean(m[2]),
      bytes: meta.size,
      sha256: info?.sha256 ?? meta.sha256,
    })
  }

  const result = await readV5Backup(file, { limits, onRecord })
  const { manifest, stats } = result

  // Group sessions by project key and session id.
  const byLocation = {}
  for (const s of sessions) {
    // Path layout inside the sessions root: <projectKey>/<sessionId>/file
    const parts = s.path.split('/')
    const sessionId = parts.length >= 2 ? parts[parts.length - 2] : '(unknown)'
    const projectKey = parts.length >= 3 ? parts.slice(0, -2).join('/') : '(unknown)'
    const key = `${projectKey}/${sessionId}`
    byLocation[key] ??= []
    byLocation[key].push({ file: parts.at(-1), generation: s.generation, bytes: s.bytes, compressed: s.compressed })
  }

  const report = {
    tool: 'dsh-dsha-migrator inspect',
    at: new Date().toISOString(),
    file,
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
    sessions: {
      count: sessions.length,
      byLocation,
    },
  }

  // Generation census (v0–v4) — informational; extraction/migration is P1
  // follow-up work, not performed here.
  const census = {}
  for (const s of sessions) census[s.generation] = (census[s.generation] ?? 0) + 1
  report.sessions.generationCensus = census

  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  console.log(JSON.stringify({
    tool: 'dsh-dsha-migrator inspect',
    at: new Date().toISOString(),
    file,
    durationMs: Date.now() - started,
    verified: false,
    error: { message: error.message, code: error.code ?? null },
  }, null, 2))
  process.exit(1)
}
