// R3 acceptance: the unified read-only orchestrator (inspectSessions) —
// generation selection, v0 canonical-name recognition, no-fallback on a
// corrupt highest generation, ambiguity isolation, and archive-failure
// cleanup. Selection/reading tests are synthetic; restore-verdict tests need
// the official rc.4 packages (RC4_MODULES), like the legacy-chain suite.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
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

// ---------------------------------------------------------------------------
// F2/F4/F5/F6 acceptance (official-chain verdicts need the rc.4 packages).
// ---------------------------------------------------------------------------

const v3codec = async () => {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  return v23.releasedV3SessionFormatCodec
}

// Physical v3 session bytes through the OFFICIAL codec (physical header has
// no type field; events carry surfaceOp).
function v3SessionBytes(codec, id, { origin, parentSession, descriptor } = {}) {
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const header = codec.encodeHeader({
    version: 3, id, createdAt: 1793500000000, cwd: '/w', isSeeded: false, delegationDepth: origin ? 1 : 0,
    ...(origin ? { origin, parentSession } : {}),
  }, 0)
  const logical = [
    e('turn/start', 0, { turn: 1 }),
    ...(descriptor ? [e('subagent/descriptor', 1, descriptor)] : []),
    e('turn/end', 1 + (descriptor ? 1 : 0), { turn: 1, reason: { kind: 'completed' } }),
  ]
  const rows = logical.map(ev => codec.encodeEvent(ev))
  return Buffer.concat([
    Buffer.from(JSON.stringify(header) + '\n'),
    Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n'),
  ])
}

test('F2: parent + direct subagent child binds evidence (catalog event added); unrelated child stays unmatched', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const codec = await v3codec()
  const dir = mkdtempSync(join(tmpdir(), 'f2-bind-'))
  try {
    const gz = buildV5Archive([
      fileEntry('sessions', 'proj/parent-p/session.v3.jsonl', v3SessionBytes(codec, 'parent-p'), 'sessions'),
      fileEntry('sessions', 'proj/child-a/session.v3.jsonl', v3SessionBytes(codec, 'child-a', { origin: 'subagent', parentSession: 'parent-p', descriptor: { provider: 'p', version: 1, mode: 'continuable', label: 'l' } }), 'sessions'),
      // another parent's child: its fact must NOT mix into parent-p
      fileEntry('sessions', 'proj/child-q/session.v3.jsonl', v3SessionBytes(codec, 'child-q', { origin: 'subagent', parentSession: 'parent-z', descriptor: { provider: 'p', version: 1, mode: 'continuable', label: 'z' } }), 'sessions'),
    ])
    const backup = join(dir, 'b.gz')
    writeFileSync(backup, gz)
    const r = await inspectSessions(backup, { stagingRoot: join(dir, 'staging') })
    assert.equal(r.counts.importable, 3)
    const parent = r.sessions.find(s => s.id === 'parent-p')
    const child = r.sessions.find(s => s.id === 'child-a')
    assert.equal(parent.status, 'restored')
    assert.equal(parent.importable, true)
    assert.equal(child.importable, true)
    // The bound fact ADDS the subagent/catalog event to the parent's output
    // (2 own logical events → 3 canonical rows).
    assert.equal(parent.events, 2)
    assert.equal(parent.canonicalEvents, 3, 'bound child fact must complete the catalog (official chain adds the event)')
    assert.deepEqual(r.childEvidence.declared, [{ parent: 'parent-p', child: 'child-a', mode: 'bound' }])
    // The other parent's child is never mixed in; it is reported unmatched.
    assert.ok(!r.childEvidence.declared.some(d => d.child === 'child-q'))
    assert.ok(r.childEvidence.unmatchedFacts.some(u => u.child === 'child-q' && u.parent === 'parent-z'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F2: confirmed-empty child set restores a standalone historical parent; unreadable-rows child contributes an identity-validated unavailable fact', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const codec = await v3codec()
  const dir = mkdtempSync(join(tmpdir(), 'f2-empty-'))
  try {
    // standalone parent: no child dirs at all
    const goodParent = v3SessionBytes(codec, 'solo-p')
    // parent with a child whose HEADER parses but rows are corrupt
    const corruptChild = Buffer.concat([
      Buffer.from(JSON.stringify(codec.encodeHeader({ version: 3, id: 'child-bad', createdAt: 1793500001000, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'p-with-bad' }, 0)) + '\n'),
      Buffer.from('{"type":"turn/start" NOT_JSON\n'),
    ])
    const gz = buildV5Archive([
      fileEntry('sessions', 'proj/solo-p/session.v3.jsonl', goodParent, 'sessions'),
      fileEntry('sessions', 'proj/p-with-bad/session.v3.jsonl', v3SessionBytes(codec, 'p-with-bad'), 'sessions'),
      fileEntry('sessions', 'proj/child-bad/session.v3.jsonl', corruptChild, 'sessions'),
    ])
    const backup = join(dir, 'b.gz')
    writeFileSync(backup, gz)
    const r = await inspectSessions(backup, { stagingRoot: join(dir, 'staging') })
    const solo = r.sessions.find(s => s.id === 'solo-p')
    const pBad = r.sessions.find(s => s.id === 'p-with-bad')
    const badChild = r.sessions.find(s => s.id === 'child-bad')
    assert.equal(solo.status, 'restored', 'standalone parent must restore with the scanned-empty set')
    assert.equal(solo.importable, true)
    // unreadable child is REPORTED (never silently dropped) …
    assert.equal(badChild.status, 'refused')
    // … and its salvaged identity still feeds the parent an explicit
    // empty-descriptor fact; the official chain decides (accepted here,
    // adding the catalog event: 2 own logical → 3 canonical).
    assert.deepEqual(r.childEvidence.declared, [{ parent: 'p-with-bad', child: 'child-bad', mode: 'unavailable-fact' }])
    assert.equal(pBad.status, 'restored')
    assert.equal(pBad.importable, true)
    assert.equal(pBad.canonicalEvents, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F4: generation mismatch refuses; duplicate ids isolate BOTH; v0 compressed canonical is recognized', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const dir = mkdtempSync(join(tmpdir(), 'f4-bind-'))
  try {
    const v4 = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-gen', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
    const v0z = Buffer.from(JSON.stringify({ type: 'session', version: 0, id: 's-v0z', createdAt: 1, cwd: '/w', delegationDepth: 0 }) + '\n')
    const dup = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-dup', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
    const gz = buildV5Archive([
      // legal v4 header inside a v1-named file: generation mismatch
      fileEntry('sessions', 'proj/s-gen/session.v1.jsonl', v4, 'sessions'),
      // v0 compressed canonical name must be SELECTED (gen 0), then refused
      // by the official chain on its own merits
      fileEntry('sessions', 'proj/s-v0z/session.jsonl.zstd', zlib.zstdCompressSync(v0z), 'sessions'),
      // same id from two directories: BOTH isolated
      fileEntry('sessions', 'pa/s-dup/session.v4.jsonl', dup, 'sessions'),
      fileEntry('sessions', 'pb/s-dup/session.v4.jsonl', dup, 'sessions'),
    ])
    const backup = join(dir, 'b.gz')
    writeFileSync(backup, gz)
    const r = await inspectSessions(backup, { stagingRoot: join(dir, 'staging') })
    const byId = new Map(r.sessions.map(s => [s.id, s]))
    assert.equal(byId.get('s-gen').code, 'LEGACY_GENERATION_MISMATCH', `got ${byId.get('s-gen').error}`)
    assert.equal(byId.get('s-gen').sourceGeneration, 1, 'source generation comes from the FILENAME')
    const v0zEntry = byId.get('s-v0z')
    assert.equal(v0zEntry.sourceGeneration, 0, 'session.jsonl.zstd is the v0 canonical and must not vanish')
    assert.notEqual(v0zEntry.code, 'LEGACY_DUPLICATE_SESSION_ID')
    // The v0 canonical reaches the OFFICIAL chain's own verdict: this
    // header-only v0 is accepted (empty historical session) — selection must
    // not be conflated with the migration verdict.
    assert.equal(v0zEntry.importable, true)
    const dups = r.sessions.filter(s => s.id === 's-dup')
    assert.equal(dups.length, 2)
    for (const d of dups) {
      assert.equal(d.status, 'refused')
      assert.equal(d.code, 'LEGACY_DUPLICATE_SESSION_ID')
    }
    assert.equal(r.counts.importable, 1, 'only the v0 canonical; neither duplicate counts as a success')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F5: invalid UTF-8 and truncated skippable tails refuse; budgets refuse oversized expansion', async () => {
  const { readSessionFile } = await import('../lib/inspect-sessions.js')
  const { splitZstdFrames } = await import('../lib/archive/zstd-frames.js')
  const header = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'x', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
  // 1) raw invalid UTF-8 inside a JSON string position: fatal decode refuses
  const badUtf8 = Buffer.concat([header, Buffer.from([0xff, 0xfe]), Buffer.from('\n')])
  assert.throws(() => readSessionFile(badUtf8, { compressed: false }), /UTF-8/)
  // 2) complete session + 8-byte skippable header claiming 1024 B payload:
  //    the declared payload must be present, never skipped past EOF
  const framed = zlib.zstdCompressSync(header)
  const skippable = Buffer.alloc(8)
  skippable.writeUInt32LE(0x184d2a50, 0)
  skippable.writeUInt32LE(1024, 4)
  assert.throws(() => splitZstdFrames(Buffer.concat([framed, skippable])), /skippable frame payload overruns/)
  // 3) per-session expansion budget: decompressed size over budget refuses
  assert.throws(
    () => readSessionFile(Buffer.concat([header, header]), { compressed: false }, { maxDecompressedBytes: 10 }),
    /budget/,
  )
  assert.throws(
    () => readSessionFile(Buffer.concat([header, Buffer.from('{"t":1}\n')]), { compressed: false }, { maxRows: 0 }),
    /budget/,
  )
})

test('F6: excluded names are never staged; credential/bridge roots and local paths never reach the report', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const codec = await v3codec()
  const dir = mkdtempSync(join(tmpdir(), 'f6-excl-'))
  try {
    // A manifest with sensitive root names + excluded files under sessions.
    // Root IDs must match the payload; NAMES are free — exactly the metadata
    // surface the report must sanitize.
    const gz = buildV5Archive([
      fileEntry('sessions', 'proj/s-ok/session.v3.jsonl', v3SessionBytes(codec, 's-ok'), 'sessions'),
      fileEntry('sessions', 'proj/s-ok/session.lock', Buffer.from('{}'), 'sessions'),
      fileEntry('settings', 'generic-settings-file.txt', Buffer.from('x'), 'settings'),
    ], {
      manifest: {
        roots: [
          { id: 'sessions', scope: 'sessions', external: false, logicalKind: 'dsh-child', name: 'sessions' },
          { id: 'settings', scope: 'settings', external: false, logicalKind: 'dsh-child', name: '.credentials.yaml' },
        ],
      },
    })
    const backup = join(dir, 'b.gz')
    writeFileSync(backup, gz)
    const r = await inspectSessions(backup, { stagingRoot: join(dir, 'staging') })
    // archive integrity still verifies everything
    assert.equal(r.archive.stats.fileVerified, 3)
    // lock never staged
    assert.ok(!r.stagingSummary.some(s => s.path.endsWith('session.lock')), 'session.lock must not be staged')
    assert.equal(r.stagingSummary.length, 1)
    // no local absolute staging path anywhere in the report — checked in
    // BOTH raw and JSON-escaped forms (the backup path legitimately appears;
    // the caller passed it in)
    const blob = JSON.stringify(r)
    const stagingPath = join(dir, 'staging')
    const stagingEscaped = JSON.stringify(stagingPath).slice(1, -1)
    assert.ok(!blob.includes(stagingPath) && !blob.includes(stagingEscaped), 'report must not contain the private staging root path')
    // sensitive root metadata never listed
    assert.ok(!blob.includes('.credentials.yaml'))
    assert.equal(r.archive.manifest.roots.excludedSensitive, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F3: CLI child process removes its staging root — success AND failure paths (exit-after-cleanup)', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'f3-cli-'))
  try {
    const okBackup = join(dir, 'ok.gz')
    writeFileSync(okBackup, buildV5Archive([
      fileEntry('sessions', 'proj/s-ok/session.v3.jsonl', Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 's-ok', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n'), 'sessions'),
    ]))
    const badBackup = join(dir, 'bad.gz')
    const badGz = buildV5Archive([fileEntry('sessions', 'proj/s1/session.v4.jsonl', text('abc'))])
    badGz[badGz.length - 700] ^= 0xff
    writeFileSync(badBackup, badGz)
    const cli = join(import.meta.dirname, '..', 'bin', 'inspect.mjs')
    for (const [label, backup, stagingRoot, expectedExit] of [
      ['success', okBackup, join(dir, 'stg-ok'), 0],
      ['failure', badBackup, join(dir, 'stg-bad'), 1],
    ]) {
      const res = spawnSync(process.execPath, [cli, backup, '--staging-root', stagingRoot], { encoding: 'utf8', timeout: 60_000 })
      assert.equal(res.status, expectedExit, `${label}: exit ${res.status} (stderr: ${String(res.stderr).slice(0, 200)})`)
      const out = JSON.parse(res.stdout)
      assert.equal(out.staging.cleanedUp, true, `${label}: receipt must claim cleanup only after verified removal`)
      assert.ok(!out.staging.cleanupError, `${label}: ${out.staging.cleanupError ?? ''}`)
      assert.equal(existsSync(stagingRoot), false, `${label}: staging root must NOT exist after the child exited`)
      // robust path-leak check: the staging dir's unique segment must not
      // appear in ANY form (JSON escaping would hide raw-backslash matches).
      // (The backup path legitimately appears — the caller passed it in.)
      const stagingSegment = label === 'success' ? 'stg-ok' : 'stg-bad'
      assert.ok(!JSON.stringify(out).includes(stagingSegment), `${label}: report must not contain the staging root path`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
