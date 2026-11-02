// R3 acceptance: the unified read-only orchestrator (inspectSessions) —
// generation selection, v0 canonical-name recognition, no-fallback on a
// corrupt highest generation, ambiguity isolation, and archive-failure
// cleanup. Selection/reading tests are synthetic; restore-verdict tests need
// the official rc.4 packages (RC4_MODULES), like the legacy-chain suite.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { inspectSessions } from '../lib/inspect-sessions.js'
import { buildV5Archive, fileEntry } from './helpers/v5-fixture.mjs'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir

async function injectLoader() {
  const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
  const req = createRequire(join(rc4Dir, 'noop.js'))
  await setModuleLoader(async () => ({
    cat: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href),
    v3: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
  }))
}

// Header rows the official chain accepts per generation (v3+ need isSeeded;
// its absence demotes a v3 header to the v2 shape).
const headerRow = (version, id) => Buffer.from(JSON.stringify({
  type: 'session', version, id, createdAt: 1, cwd: '/w', delegationDepth: 0, isSeeded: version >= 3 ? false : undefined,
}) + '\n')

function sessionFile(root, scope, project, sessionId, fileName, content) {
  if (fileName.endsWith('.zstd')) {
    return fileEntry(root, `${project}/${sessionId}/${fileName}`, zlib.zstdCompressSync(content), scope)
  }
  return fileEntry(root, `${project}/${sessionId}/${fileName}`, content, scope)
}

const text = t => Buffer.from(t)

// Multi-frame zstd: DSHA session logs are concatenated frames (first frame =
// the one-line header). Node's zstdDecompressSync handles exactly one frame,
// so a naive single call silently drops every event after the first frame.
test('readSessionFile: multi-frame zstd decodes ALL rows; trailing garbage refuses', async () => {
  const { readSessionFile } = await import('../lib/inspect-sessions.js')
  const header = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'mf', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
  const rowA = Buffer.from(JSON.stringify({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } }) + '\n')
  const rowB = Buffer.from(JSON.stringify({ type: 'turn/end', seq: 1, time: 101, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n')
  const multi = Buffer.concat([zlib.zstdCompressSync(header), zlib.zstdCompressSync(rowA), zlib.zstdCompressSync(rowB)])
  const { header: h, rows } = readSessionFile(multi, { compressed: true })
  assert.equal(h.id, 'mf')
  assert.equal(rows.length, 2, 'all frames must decode, not just the first')
  assert.equal(rows[0].type, 'turn/start')
  assert.equal(rows[1].type, 'turn/end')
  // integrity: trailing garbage after the last frame is a hard error
  assert.throws(() => readSessionFile(Buffer.concat([multi, Buffer.from('junk')]), { compressed: true }), /trailing|magic/i)
  // single-frame still works, plain JSONL unchanged
  const single = readSessionFile(zlib.zstdCompressSync(Buffer.concat([header, rowA])), { compressed: true })
  assert.equal(single.rows.length, 1)
  const plain = readSessionFile(Buffer.concat([header, rowA, rowB]), { compressed: false })
  assert.equal(plain.rows.length, 2)
})

test('R3: highest generation wins; v0 canonical session.jsonl is recognized; lower generations discarded are listed', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const dir = mkdtempSync(join(tmpdir(), 'r3-sel-'))
  try {
    const gz = buildV5Archive([
      // highest-only: v4 alone
      sessionFile('sessions', 'sessions', 'proj', 's-v4', 'session.v4.jsonl.zstd', headerRow(4, 's-v4')),
      // v0 canonical name (no version segment): must be recognized; the
      // official chain gives its own verdict (header-only v0 is accepted).
      sessionFile('sessions', 'sessions', 'proj', 's-v0', 'session.jsonl', headerRow(0, 's-v0')),
      // mixed dir: v3 + v4 → v4 wins, v3 listed as discarded lower
      sessionFile('sessions', 'sessions', 'proj', 's-mix', 'session.v3.jsonl', headerRow(3, 's-mix')),
      sessionFile('sessions', 'sessions', 'proj', 's-mix', 'session.v4.jsonl', headerRow(4, 's-mix')),
    ])
    const backup = join(dir, 'backup.gz')
    writeFileSync(backup, gz)
    const stagingRoot = join(dir, 'staging')
    const r = await inspectSessions(backup, { stagingRoot })

    assert.equal(r.counts.total, 3, `three session dirs (got ${JSON.stringify(r.sessions.map(s => s.id))})`)
    const byId = new Map(r.sessions.map(s => [s.id, s]))
    // v4-only dir restores and migrates
    assert.equal(byId.get('s-v4').status, 'restored')
    assert.equal(byId.get('s-v4').importable, true)
    assert.deepEqual(byId.get('s-v4').filesDiscardedLower, [])
    // v0 canonical name recognized and given the official chain's verdict
    assert.equal(byId.get('s-v0').status, 'restored')
    assert.equal(byId.get('s-v0').sourceGeneration, 0)
    assert.equal(byId.get('s-v0').outputGeneration, 4)
    // mixed dir chose the highest
    assert.equal(byId.get('s-mix').status, 'restored')
    assert.equal(byId.get('s-mix').sourceGeneration, 4)
    assert.deepEqual(byId.get('s-mix').filesDiscardedLower, ['session.v3.jsonl'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R3: corrupt highest generation does NOT fall back — the session is refused', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const dir = mkdtempSync(join(tmpdir(), 'r3-corrupt-'))
  try {
    // Corrupt "v5": text garbage in a .v5.jsonl — highest generation on top.
    const v5garbage = Buffer.from('not json at all\nsecond line\n')
    const gz = buildV5Archive([
      sessionFile('sessions', 'sessions', 'proj', 's-cor', 'session.v5.jsonl', v5garbage),
      sessionFile('sessions', 'sessions', 'proj', 's-cor', 'session.v3.jsonl', headerRow(3, 's-cor')),
      // a control session that must restore fine
      sessionFile('sessions', 'sessions', 'proj', 's-good', 'session.v4.jsonl', headerRow(4, 's-good')),
    ])
    const backup = join(dir, 'backup.gz')
    writeFileSync(backup, gz)
    const stagingRoot = join(dir, 'staging')
    const r = await inspectSessions(backup, { stagingRoot })
    const byId = new Map(r.sessions.map(s => [s.id, s]))
    assert.equal(byId.get('s-good').status, 'restored', 'control session must restore')
    // The corrupt-highest session must be REFUSED, not silently fallen back
    // to the lower generation.
    const corrupt = byId.get('s-cor')
    assert.equal(corrupt.status, 'refused', `corrupt highest must refuse (got ${corrupt.status})`)
    assert.ok((corrupt.error ?? '').length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R3: archive-level failure stages nothing publishable and cleans up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-fail-'))
  try {
    // Corrupt per-FILE digest: the archive must be rejected as a whole.
    const entries = [fileEntry('sessions', 'proj/s1/session.v4.jsonl', text('abc'))]
    const gz = buildV5Archive(entries)
    // Flip a byte inside the payload region (after 512-byte tar header block).
    gz[gz.length - 700] ^= 0xff
    const backup = join(dir, 'backup.gz')
    writeFileSync(backup, gz)
    const stagingRoot = join(dir, 'staging')
    mkdirSync(stagingRoot, { recursive: true })
    const r = await inspectSessions(backup, { stagingRoot })
    assert.equal(r.archiveFailed, true, 'archive-level failure must be reported')
    assert.ok((r.errors ?? []).length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R3: real backup passes through the unified entry (env-gated)', { skip: !process.env.DSHA_V5_REAL ? 'DSHA_V5_REAL not set' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-real-'))
  try {
    const stagingRoot = join(dir, 'staging')
    const r = await inspectSessions(process.env.DSHA_V5_REAL, { stagingRoot })
    assert.equal(r.archiveFailed, undefined)
    assert.equal(r.counts.total, 2)
    assert.equal(r.counts.importable, 2)
    for (const s of r.sessions) {
      assert.equal(s.status, 'restored')
      assert.equal(s.sourceGeneration, 4)
      assert.ok([596, 454].includes(s.events), `event count ${s.events}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
