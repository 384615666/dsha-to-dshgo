#!/usr/bin/env node
// Read-only preservation of the workspace unit, journal/plan/snapshot evidence
// and session header cwds. Intended to run as the DSH app user (or root) while
// the engine is stopped. It never modifies the source data and never copies
// session bodies or credentials.
//
// Usage:
//   node scripts/preserve-workspace-state.mjs \
//     [--dsh-home /root/.dsh] \
//     [--out /sdcard/Download/dsha-preserve-<stamp>]
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { splitZstdFrames } from '../lib/archive/zstd-frames.js'

const sha256 = value => createHash('sha256').update(value).digest('hex')
function arg(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const home = arg('--dsh-home', process.env.DSH_HOME || '/root/.dsh')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = arg('--out', `/sdcard/Download/dsha-preserve-${stamp}`)
fs.mkdirSync(out, { recursive: true, mode: 0o700 })

const manifest = { at: new Date().toISOString(), home, out, files: [], sessionHeaders: [], errors: [] }

function copy(source, name) {
  try {
    const bytes = fs.readFileSync(source)
    const target = join(out, name)
    fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    fs.writeFileSync(target, bytes, { mode: 0o600 })
    manifest.files.push({ name, bytes: bytes.length, sha256: sha256(bytes) })
  } catch (error) {
    manifest.errors.push({ name, error: `${error?.code ?? error?.name}: ${error?.message}` })
  }
}

// 1. workspace unit (the repair input)
const unitPath = join(home, 'storages', 'workspace.json')
copy(unitPath, 'workspace.json')

// 2. job journal / frozen plan / content-addressed snapshot copies (minimal
//    recovery evidence); never quarantine payloads, credentials or staging.
const jobsRoot = join(home, 'dsha-migrator', 'jobs')
try {
  for (const job of fs.readdirSync(jobsRoot)) {
    const dir = join(jobsRoot, job)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const name of fs.readdirSync(dir)) {
      if (name === 'journal.json' || name === 'plan.json' || /^workspace-unit\.[a-f0-9]+\.json$/.test(name)) {
        copy(join(dir, name), join('jobs', job, name))
      }
    }
  }
} catch (error) {
  manifest.errors.push({ name: 'jobs', error: `${error?.code ?? error?.name}: ${error?.message}` })
}

// 3. session header cwds only (no bodies): the offline diff needs an exact
//    owner per duplicated session id.
function headerFromFile(path) {
  const bytes = fs.readFileSync(path)
  let text
  if (path.endsWith('.zstd')) {
    const frames = splitZstdFrames(bytes)
    if (frames.length === 0) throw new Error('no zstd frame')
    text = zlib.zstdDecompressSync(frames[0]).toString('utf8')
  } else {
    text = bytes.toString('utf8')
  }
  const line = text.split('\n')[0]
  return JSON.parse(line)
}

const sessionsRoot = join(home, 'sessions')
try {
  for (const rel of fs.readdirSync(sessionsRoot, { recursive: true })) {
    const name = rel.split(/[\\/]/).pop()
    if (!/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name)) continue
    try {
      const header = headerFromFile(join(sessionsRoot, rel))
      manifest.sessionHeaders.push({ id: header.id, cwd: header.cwd ?? null, version: header.version })
    } catch (error) {
      manifest.errors.push({ name: `session:${rel}`, error: `${error?.code ?? error?.name}: ${error?.message}` })
    }
  }
} catch (error) {
  manifest.errors.push({ name: 'sessions', error: `${error?.code ?? error?.name}: ${error?.message}` })
}

// A simple id → cwd map for scripts/workspace-repair-diff.mjs.
const sessionCwds = {}
for (const header of manifest.sessionHeaders) {
  if (typeof header.id === 'string' && typeof header.cwd === 'string') sessionCwds[header.id] = header.cwd
}
fs.writeFileSync(join(out, 'session-cwds.json'), JSON.stringify(sessionCwds, null, 2), { mode: 0o600 })
fs.writeFileSync(join(out, 'preserve-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ out, files: manifest.files.length, sessionHeaders: manifest.sessionHeaders.length, errors: manifest.errors.length }, null, 2))
