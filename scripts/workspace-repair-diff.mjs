#!/usr/bin/env node
// Offline workspace-unit repair diff for a duplicated session membership.
//
// Usage (dry-run):
//   node scripts/workspace-repair-diff.mjs \
//     --unit /path/to/workspace.json \
//     --session-cwds /path/to/session-cwds.json \
//     [--out /path/to/repair-diff.json]
//
// Apply (only after the engine is stopped and the unit hash was reviewed):
//   node scripts/workspace-repair-diff.mjs \
//     --unit /path/to/workspace.json \
//     --session-cwds /path/to/session-cwds.json \
//     --apply --engine-stopped --expect-sha256 <unitSha256>
//
// session-cwds.json is a read-only map { "<sessionId>": "<session header cwd>" }
// produced from the persisted session logs. The tool never guesses ownership:
// a duplicate without exactly one workspace whose path equals the session cwd
// is reported as blocked, and --apply refuses unless every duplicate is
// resolved.
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { planWorkspaceRepair, applyWorkspaceRepair } from '../lib/import/workspace-repair.js'

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const unitPath = arg('--unit')
const cwdsPath = arg('--session-cwds')
const outPath = arg('--out')
const apply = process.argv.includes('--apply')
const engineStopped = process.argv.includes('--engine-stopped')
const expectSha = arg('--expect-sha256')
if (!unitPath || !cwdsPath) {
  console.error('usage: workspace-repair-diff.mjs --unit <workspace.json> --session-cwds <session-cwds.json> [--out diff.json] [--apply --engine-stopped --expect-sha256 <hash>]')
  process.exit(2)
}

const unitBytes = fs.readFileSync(unitPath)
const sessionCwds = JSON.parse(fs.readFileSync(cwdsPath, 'utf8'))
const diff = planWorkspaceRepair({ unitBytes, sessionCwds })
if (outPath) fs.writeFileSync(outPath, JSON.stringify(diff, null, 2), { mode: 0o600 })

if (!apply) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    unitSha256: diff.unitSha256,
    duplicates: diff.duplicates,
    removals: diff.removals,
    blocked: diff.blocked,
    changed: diff.changed,
  }, null, 2))
  process.exit(0)
}

if (!engineStopped) {
  console.error('refusing to apply: --engine-stopped is required (stop the DSH engine and verify nothing holds the unit)')
  process.exit(1)
}
if (typeof expectSha !== 'string' || expectSha !== diff.unitSha256) {
  console.error('refusing to apply: --expect-sha256 does not match the current unit')
  process.exit(1)
}
if (!diff.changed || diff.blocked.length > 0) {
  console.error('refusing to apply: every duplicate must have exactly one proven owner')
  process.exit(1)
}
const applied = applyWorkspaceRepair(unitBytes, diff, { expectSha256: expectSha })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${unitPath}.bak-${stamp}`
fs.writeFileSync(backup, unitBytes, { mode: 0o600 })
const temp = join(dirname(unitPath), `.workspace-repair-${randomUUID()}.tmp`)
let fd
try {
  fd = fs.openSync(temp, 'wx', 0o600)
  fs.writeSync(fd, applied.bytes)
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  fd = undefined
  fs.renameSync(temp, unitPath)
  try {
    const dfd = fs.openSync(dirname(unitPath), 'r')
    try { fs.fsyncSync(dfd) } catch { /* platform limitation */ }
    finally { fs.closeSync(dfd) }
  } catch { /* directory fsync unsupported */ }
  const verified = fs.readFileSync(unitPath)
  if (verified.length !== applied.bytes.length || !verified.equals(applied.bytes)) {
    throw new Error('post-apply verification failed — restore the backup')
  }
} catch (error) {
  try { if (fd !== undefined) fs.closeSync(fd) } catch { /* closed */ }
  try { fs.unlinkSync(temp) } catch { /* nothing */ }
  throw error
}
console.log(JSON.stringify({
  mode: 'applied',
  backup,
  beforeSha256: diff.unitSha256,
  afterSha256: applied.sha256,
  removals: diff.removals,
}, null, 2))
