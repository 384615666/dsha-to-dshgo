// R3/F-series acceptance: the unified read-only orchestrator (inspectSessions).
// Generation selection, v0 canonical recognition (plain AND compressed), no
// fallback on a corrupt highest, ambiguity isolation, archive-failure
// cleanup, VERIFIED binding through the OFFICIAL location backend, direct
// child evidence (v3 and v4 children), identity-validated unavailable facts,
// strict decoding with parsing-time budgets, exclusion rules, container-
// semantics staging, and truthful cleanup receipts.
//
// Restore-verdict and location tests need the official rc.4 packages
// (RC4_MODULES), like the legacy-chain suite. RC4_MODULES must point at a
// node_modules that ALSO carries @deepseek-ai/dsh-session-persistence-jsonl
// and @deepseek-ai/cordis (the full engine install) so the official location
// adapter can mount; without it, sessions are admitted only as
// location-unverified (never importable).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { inspectSessions, readSessionFile } from '../lib/inspect-sessions.js'
import { setLocationAdapter } from '../lib/migration/location.js'
import { splitZstdFrames, decompressZstdMultiFrame } from '../lib/archive/zstd-frames.js'
import { buildV5Archive, fileEntry, missingEntry } from './helpers/v5-fixture.mjs'

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

// Mount the OFFICIAL JSONL persistence backend on an isolated throwaway root
// and expose its own locate() as the location adapter. Returns an unmount
// function. Locate only computes paths; the root is removed afterwards.
async function mountLocation() {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const backendRoot = mkdtempSync(join(tmpdir(), 'locate-root-'))
  const ctx = new Context()
  await ctx.plugin(jsonl, { root: backendRoot, compression: 'zstd' })
  const store = ctx.sessionPersistence
  if (typeof store?.locate !== 'function') throw new Error('official backend locate unavailable')
  await setLocationAdapter(header => {
    const loc = store.locate({ cwd: header.cwd, id: header.id })
    return relative(backendRoot, loc.path).split(sep).slice(0, -1).join('/')
  })
  return async () => {
    await setLocationAdapter(null)
    try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
    rmSync(backendRoot, { recursive: true, force: true })
  }
}

// Header rows the official chain accepts per generation (v3+ need isSeeded;
// its absence demotes a v3 header to the v2 shape).
const headerRow = (version, id, cwd = '/w') => Buffer.from(JSON.stringify({
  type: 'session', version, id, createdAt: 1, cwd, delegationDepth: 0, isSeeded: version >= 3 ? false : undefined,
}) + '\n')

// The OFFICIAL directory slot for cwd '/w' is '--w--' (backend-verified in
// the location tests); fixtures must use the official layout, not 'proj/…'.
const officialDirFor = id => `--w--/${id}`

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

test('F5: invalid UTF-8 and truncated skippable tails refuse; budgets bound DURING parsing', async () => {
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
  // 3) per-session budgets: decompressed size and rows refuse (fixed codes)
  assert.throws(
    () => readSessionFile(Buffer.concat([header, header]), { compressed: false }, { maxDecompressedBytes: 10 }),
    err => err.code === 'SESSION_BUDGET',
  )
  assert.throws(
    () => readSessionFile(Buffer.concat([header, Buffer.from('{"t":1}\n')]), { compressed: false }, { maxRows: 0 }),
    err => err.code === 'SESSION_BUDGET',
  )
  // 4) budget stops the run DURING decoding: the second frame is CORRUPT, so
  // if the decoder touched it the error would be "bad zstd magic" — the
  // budget error proves later frames were neither walked nor decoded.
  const goodFrame = zlib.zstdCompressSync(Buffer.from('x'.repeat(2000)))
  const corruptFrame = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.throws(
    () => decompressZstdMultiFrame(Buffer.concat([goodFrame, corruptFrame]), { maxBytes: 100 }),
    err => /budget/.test(err.message),
    'budget must stop before any later frame is touched',
  )
  // 5) the SINGLE frame itself is bounded by the NATIVE output limit: a
  // 4096-byte frame against a 16-byte budget must be refused by the decoder
  // BEFORE its full output is allocated (ERR_BUFFER_TOO_LARGE path).
  const bigFrame = zlib.zstdCompressSync(Buffer.from('x'.repeat(4096)))
  assert.throws(
    () => decompressZstdMultiFrame(bigFrame, { maxBytes: 16 }),
    err => err.code === 'SESSION_BUDGET' && err.message.includes('native output limit applied before allocation'),
    'single-frame output must be capped natively, not allocated then refused',
  )
  // 6) budget 0 refuses before any decode; exact-fit output passes.
  assert.throws(
    () => decompressZstdMultiFrame(bigFrame, { maxBytes: 0 }),
    err => err.code === 'SESSION_BUDGET' && /budget/.test(err.message),
  )
  // 6b) cumulative budget across frames: second frame rejected natively with
  // the SAME stable code (first frame consumed 8 of 12).
  const f8 = zlib.zstdCompressSync(Buffer.from('x'.repeat(8)))
  assert.throws(
    () => decompressZstdMultiFrame(Buffer.concat([f8, f8]), { maxBytes: 12 }),
    err => err.code === 'SESSION_BUDGET' && err.message.includes('at frame 2'),
  )
  const exact = decompressZstdMultiFrame(zlib.zstdCompressSync(Buffer.from('y'.repeat(16))), { maxBytes: 16 })
  assert.equal(exact.length, 16, 'output exactly at budget is admitted')
  // 5) row JSON errors carry a FIXED message (no source fragments) and the
  // parsed header for identity salvage — no second unbounded decompression.
  const badRow = Buffer.concat([header, Buffer.from('{"x": "SYNTHCHAT-marker" NOPE\n')])
  try {
    readSessionFile(badRow, { compressed: false })
    assert.fail('corrupt row must refuse')
  } catch (error) {
    assert.equal(error.code, 'SESSION_ROW_MALFORMED')
    assert.equal(error.message, 'physical row 1 is not valid JSON')
    assert.ok(error.header, 'parsed header must be attached for verified identity salvage')
    assert.ok(!error.message.includes('SYNTHCHAT-marker'), 'error text must not echo the damaged row content')
  }
})

test('R3: highest generation wins; v0 canonical session.jsonl is recognized; lower generations discarded are listed', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const dir = mkdtempSync(join(tmpdir(), 'r3-sel-'))
  try {
    const gz = buildV5Archive([
      // highest-only: v4 alone
      sessionFile('sessions', 'sessions', '--w--', 's-v4', 'session.v4.jsonl.zstd', headerRow(4, 's-v4')),
      // v0 canonical name (no version segment): must be recognized; the
      // official chain gives its own verdict (header-only v0 is accepted).
      sessionFile('sessions', 'sessions', '--w--', 's-v0', 'session.jsonl', headerRow(0, 's-v0')),
      // mixed dir: v3 + v4 → v4 wins, v3 listed as discarded lower
      sessionFile('sessions', 'sessions', '--w--', 's-mix', 'session.v3.jsonl', headerRow(3, 's-mix')),
      sessionFile('sessions', 'sessions', '--w--', 's-mix', 'session.v4.jsonl', headerRow(4, 's-mix')),
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
    // v0 canonical name recognized (gen 0 selected) and given the official
    // chain's verdict: this header-only v0 shape is accepted (empty session).
    assert.equal(byId.get('s-v0').status, 'restored')
    assert.equal(byId.get('s-v0').sourceGeneration, 0)
    assert.equal(byId.get('s-v0').outputGeneration, 4)
    // mixed dir chose the highest
    assert.equal(byId.get('s-mix').status, 'restored')
    assert.equal(byId.get('s-mix').sourceGeneration, 4)
    assert.deepEqual(byId.get('s-mix').filesDiscardedLower, ['session.v3.jsonl'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await unmount()
  }
})

test('R3: corrupt highest generation does NOT fall back — the session is refused', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const dir = mkdtempSync(join(tmpdir(), 'r3-corrupt-'))
  try {
    // Corrupt "v5": text garbage in a .v5.jsonl — highest generation on top.
    const v5garbage = Buffer.from('not json at all\nsecond line\n')
    const gz = buildV5Archive([
      sessionFile('sessions', 'sessions', '--w--', 's-cor', 'session.v5.jsonl', v5garbage),
      sessionFile('sessions', 'sessions', '--w--', 's-cor', 'session.v3.jsonl', headerRow(3, 's-cor')),
      // a control session that must restore fine
      sessionFile('sessions', 'sessions', '--w--', 's-good', 'session.v4.jsonl', headerRow(4, 's-good')),
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
    await unmount()
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

// ---------------------------------------------------------------------------
// Official codec fixtures for child-evidence and binding tests.
// ---------------------------------------------------------------------------

const v3codec = async () => {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  return v23.releasedV3SessionFormatCodec
}

// Physical v3 session bytes through the OFFICIAL codec (physical header has
// no type field; events carry surfaceOp).
function v3SessionBytes(codec, id, { origin, parentSession, descriptor, cwd = '/w' } = {}) {
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const header = codec.encodeHeader({
    version: 3, id, createdAt: 1793500000000, cwd, isSeeded: false, delegationDepth: origin ? 1 : 0,
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
  const unmount = await mountLocation()
  const codec = await v3codec()
  const dir = mkdtempSync(join(tmpdir(), 'f2-bind-'))
  try {
    const gz = buildV5Archive([
      fileEntry('sessions', `${officialDirFor('parent-p')}/session.v3.jsonl`, v3SessionBytes(codec, 'parent-p'), 'sessions'),
      fileEntry('sessions', `${officialDirFor('child-a')}/session.v3.jsonl`, v3SessionBytes(codec, 'child-a', { origin: 'subagent', parentSession: 'parent-p', descriptor: { provider: 'p', version: 1, mode: 'continuable', label: 'l' } }), 'sessions'),
      // another parent's child: its fact must NOT mix into parent-p
      fileEntry('sessions', `${officialDirFor('child-q')}/session.v3.jsonl`, v3SessionBytes(codec, 'child-q', { origin: 'subagent', parentSession: 'parent-z', descriptor: { provider: 'p', version: 1, mode: 'continuable', label: 'z' } }), 'sessions'),
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
    await unmount()
  }
})

test('F2: v4 direct child binds through the official chain (no blanket version rejection)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const codec = await v3codec()
  const dir = mkdtempSync(join(tmpdir(), 'f2-v4-'))
  try {
    const req = createRequire(join(rc4Dir, 'noop.js'))
    const cat = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
    const e = (type, seq, data) => ({ type, seq, time: seq + 100, data })
    const h = cat.sessionFormatCatalog.encodeCurrentHeader({
      version: 4, id: 'kid-v4', createdAt: 1793500001000, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'p-v4k',
    }, 0)
    const rows = [e('turn/start', 0, { turn: 1 }), e('turn/end', 1, { turn: 1, reason: { kind: 'completed' } })]
      .map(ev => cat.sessionFormatCatalog.encodeCurrentEvent(ev))
    const v4Child = Buffer.from([JSON.stringify(h), ...rows.map(r => JSON.stringify(r))].join('\n') + '\n')
    const gz = buildV5Archive([
      fileEntry('sessions', `${officialDirFor('p-v4k')}/session.v3.jsonl`, v3SessionBytes(codec, 'p-v4k'), 'sessions'),
      fileEntry('sessions', `${officialDirFor('kid-v4')}/session.v4.jsonl`, v4Child, 'sessions'),
    ])
    const backup = join(dir, 'b.gz')
    writeFileSync(backup, gz)
    const r = await inspectSessions(backup, { stagingRoot: join(dir, 'staging') })
    const parent = r.sessions.find(s => s.id === 'p-v4k')
    assert.equal(parent.status, 'restored', `v4 child must follow the official chain verdict, not a local version rule (${parent.error ?? ''})`)
    assert.equal(parent.importable, true)
    assert.deepEqual(r.childEvidence.declared, [{ parent: 'p-v4k', child: 'kid-v4', mode: 'bound' }])
    assert.equal(parent.canonicalEvents, 3, 'v4 child fact completes the parent catalog (2 own → 3)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await unmount()
  }
})

test('F2: standalone historical parent restores with the scanned-empty set; verified unreadable child yields an unavailable fact; UNVERIFIED salvage identity yields none', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const codec = await v3codec()
  const dir = mkdtempSync(join(tmpdir(), 'f2-empty-'))
  try {
    // parent with a child whose HEADER parses but rows are corrupt — the
    // header sits at the child's OWN official directory (identity verified)
    const corruptChild = Buffer.concat([
      Buffer.from(JSON.stringify(codec.encodeHeader({ version: 3, id: 'child-bad', createdAt: 1793500001000, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'p-with-bad' }, 0)) + '\n'),
      Buffer.from('{"type":"turn/start" NOT_JSON\n'),
    ])
    // an IMPOSTOR: header claims a different id than its directory — the
    // location check must disqualify it from contributing ANY fact.
    const impostor = Buffer.concat([
      Buffer.from(JSON.stringify(codec.encodeHeader({ version: 3, id: 'impostor', createdAt: 1793500002000, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'p-with-bad' }, 0)) + '\n'),
      Buffer.from('{"type":"turn/start" ALSO_BROKEN\n'),
    ])
    const gz = buildV5Archive([
      fileEntry('sessions', `${officialDirFor('solo-p')}/session.v3.jsonl`, v3SessionBytes(codec, 'solo-p'), 'sessions'),
      fileEntry('sessions', `${officialDirFor('p-with-bad')}/session.v3.jsonl`, v3SessionBytes(codec, 'p-with-bad'), 'sessions'),
      fileEntry('sessions', `${officialDirFor('child-bad')}/session.v3.jsonl`, corruptChild, 'sessions'),
      // impostor header parked in the honest child's official directory
      fileEntry('sessions', `${officialDirFor('honest-child')}/session.v3.jsonl`, impostor, 'sessions'),
      // declared-but-missing canonical slot must surface, never vanish
      missingEntry('sessions', `${officialDirFor('ghost')}/session.v3.jsonl`, 'sessions'),
    ], { manifest: { integrity: 'PARTIAL' } })
    const backup = join(dir, 'b.gz')
    writeFileSync(backup, gz)
    const r = await inspectSessions(backup, { stagingRoot: join(dir, 'staging') })
    const solo = r.sessions.find(s => s.id === 'solo-p')
    const pBad = r.sessions.find(s => s.id === 'p-with-bad')
    const badChild = r.sessions.find(s => s.id === 'child-bad')
    const imp = r.sessions.find(s => s.id === 'honest-child')
    assert.equal(solo.status, 'restored', 'standalone parent must restore with the scanned-empty set')
    assert.equal(solo.importable, true)
    // unreadable child is REPORTED (never silently dropped) …
    assert.equal(badChild.status, 'refused')
    assert.equal(badChild.code, 'SESSION_ROW_MALFORMED')
    assert.ok(!JSON.stringify(r).includes('NOT_JSON'), 'fixed error text must not echo the damaged row')
    // … and its VERIFIED identity feeds the parent an explicit
    // empty-descriptor fact; the official chain decides (accepted: 2 own → 3).
    assert.ok(r.childEvidence.declared.some(d => d.parent === 'p-with-bad' && d.child === 'child-bad' && d.mode === 'unavailable-fact'))
    assert.equal(pBad.status, 'restored')
    assert.equal(pBad.importable, true)
    assert.equal(pBad.canonicalEvents, 3)
    // the impostor failed the location binding → refused, and contributed NO fact
    assert.equal(imp.status, 'refused')
    assert.equal(imp.code, 'LEGACY_LOCATION_MISMATCH')
    assert.ok(!r.childEvidence.declared.some(d => d.child === 'impostor'), 'unverified salvage identity must never become a fact')
    // declared MISSING slot survives into the report
    assert.deepEqual(r.childEvidence.declaredMissing, [{ path: `${officialDirFor('ghost')}/session.v3.jsonl`, kind: 'MISSING' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await unmount()
  }
})

test('F4: official location binding admits correct/canonical-encoded directories and refuses wrong ones; generation mismatch refuses; duplicate ids isolate BOTH; v0 compressed canonical is recognized', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const dir = mkdtempSync(join(tmpdir(), 'f4-bind-'))
  try {
    const v4 = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-gen', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
    const v0z = Buffer.from(JSON.stringify({ type: 'session', version: 0, id: 's-v0z', createdAt: 1, cwd: '/w', delegationDepth: 0 }) + '\n')
    const dupA = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-dup', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
    const dupB = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-dup', createdAt: 1, cwd: '/other', isSeeded: false, delegationDepth: 0 }) + '\n')
    const cjk = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: '会话-id', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
    // The CJK id's official slot comes from the adapter itself — raw
    // characters are NOT the directory encoding.
    const { officialSessionDirectory } = await import('../lib/migration/location.js')
    const cjkDir = officialSessionDirectory({ cwd: '/w', id: '会话-id' })
    const gz = buildV5Archive([
      // legal v4 header inside a v1-named file: generation mismatch
      fileEntry('sessions', `${officialDirFor('s-gen')}/session.v1.jsonl`, v4, 'sessions'),
      // v0 compressed canonical name must be SELECTED (gen 0)
      fileEntry('sessions', `${officialDirFor('s-v0z')}/session.jsonl.zstd`, zlib.zstdCompressSync(v0z), 'sessions'),
      // same id from two directories (each at its OWN official location):
      // BOTH isolated
      fileEntry('sessions', `--w--/s-dup/session.v4.jsonl`, dupA, 'sessions'),
      fileEntry('sessions', `--other--/s-dup/session.v4.jsonl`, dupB, 'sessions'),
      // OFFICIAL encoding of a non-ASCII id must be admitted (backend's own
      // locate() assigns the encoded directory segment)
      fileEntry('sessions', `${cjkDir}/session.v4.jsonl`, cjk, 'sessions'),
    ])
    const backup = join(dir, 'b.gz')
    writeFileSync(backup, gz)
    const r = await inspectSessions(backup, { stagingRoot: join(dir, 'staging') })
    const byId = new Map(r.sessions.map(s => [s.id, s]))
    assert.equal(byId.get('s-gen').code, 'LEGACY_GENERATION_MISMATCH', `got ${byId.get('s-gen').error}`)
    assert.equal(byId.get('s-gen').sourceGeneration, 1, 'source generation comes from the FILENAME')
    const v0zEntry = byId.get('s-v0z')
    assert.equal(v0zEntry.sourceGeneration, 0, 'session.jsonl.zstd is the v0 canonical and must not vanish')
    assert.equal(v0zEntry.importable, true, 'header-only v0 follows the official chain verdict')
    const dups = r.sessions.filter(s => s.code === 'LEGACY_DUPLICATE_SESSION_ID')
    assert.equal(dups.length, 2, 'both same-id candidates isolated')
    assert.equal(r.counts.importable, 2, 'v0 canonical + official-encoded CJK session; neither duplicate counts')
    const cjkEntry = r.sessions.find(s => s.headerVersion === 4 && s.binding?.location === 'official-locate' && s.importable && s.id !== 's-v0z' && s.id !== 's-gen')
    assert.ok(cjkEntry, 'the official-encoded CJK id must be admitted')
    assert.ok(cjkEntry.id.startsWith('~'), `encoded directory segment is the reported slot id (got ${cjkEntry.id})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await unmount()
  }
})

test('F4: wrong-cwd location refuses with LEGACY_LOCATION_MISMATCH', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const dir = mkdtempSync(join(tmpdir(), 'f4-wrong-'))
  try {
    const v4 = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-loc', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
    const gz = buildV5Archive([
      // the header says cwd=/w (→ '--w--') but the archive parks it elsewhere
      fileEntry('sessions', `--wrong-project--/s-loc/session.v4.jsonl`, v4, 'sessions'),
    ])
    const backup = join(dir, 'b.gz')
    writeFileSync(backup, gz)
    const r = await inspectSessions(backup, { stagingRoot: join(dir, 'staging') })
    const s = r.sessions[0]
    assert.equal(s.status, 'refused')
    assert.equal(s.code, 'LEGACY_LOCATION_MISMATCH')
    assert.equal(s.importable, undefined)
    assert.equal(r.counts.importable, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await unmount()
  }
})

test('F6: excluded names are never staged; credential/bridge roots and local paths never reach the report', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const codec = await v3codec()
  const dir = mkdtempSync(join(tmpdir(), 'f6-excl-'))
  try {
    // A manifest with sensitive root names + excluded files under sessions.
    // Root IDs must match the payload; NAMES are free — exactly the metadata
    // surface the report must sanitize.
    const gz = buildV5Archive([
      fileEntry('sessions', `${officialDirFor('s-ok')}/session.v3.jsonl`, v3SessionBytes(codec, 's-ok'), 'sessions'),
      fileEntry('sessions', `${officialDirFor('s-ok')}/session.lock`, Buffer.from('{}'), 'sessions'),
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
    await unmount()
  }
})

test('F6: damaged-row content markers never reach the report', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const dir = mkdtempSync(join(tmpdir(), 'f6-leak-'))
  try {
    const badRow = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-leak', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n' + '{"x": "SYNTHCHAT-PLACEHOLDER" broken\n')
    const gz = buildV5Archive([
      fileEntry('sessions', `${officialDirFor('s-leak')}/session.v4.jsonl`, badRow, 'sessions'),
    ])
    const backup = join(dir, 'b.gz')
    writeFileSync(backup, gz)
    const r = await inspectSessions(backup, { stagingRoot: join(dir, 'staging') })
    assert.equal(r.sessions[0].status, 'refused')
    assert.equal(r.sessions[0].code, 'SESSION_ROW_MALFORMED')
    assert.ok(!JSON.stringify(r).includes('SYNTHCHAT-PLACEHOLDER'), 'the damaged row content must not leak into any report field')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await unmount()
  }
})

test('F3: CLI staging root is a CONTAINER — job subdirectory removed, sentinel untouched, root verified gone after child exit', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'f3-cli-'))
  try {
    const okBackup = join(dir, 'ok.gz')
    writeFileSync(okBackup, buildV5Archive([
      fileEntry('sessions', `${officialDirFor('s-ok')}/session.v3.jsonl`, headerRow(3, 's-ok'), 'sessions'),
    ]))
    const badBackup = join(dir, 'bad.gz')
    const badGz = buildV5Archive([fileEntry('sessions', 'proj/s1/session.v4.jsonl', text('abc'))])
    badGz[badGz.length - 700] ^= 0xff
    writeFileSync(badBackup, badGz)
    const cli = join(import.meta.dirname, '..', 'bin', 'inspect.mjs')
    for (const [label, backup, container, expectedExit] of [
      ['success', okBackup, join(dir, 'cont-ok'), 0],
      ['failure', badBackup, join(dir, 'cont-bad'), 1],
    ]) {
      // a PRE-EXISTING sentinel in the container simulates the caller's own
      // object; a failed (or successful) job must never delete it.
      const sentinel = join(container, 'sentinel.txt')
      mkdirSync(container, { recursive: true })
      writeFileSync(sentinel, 'caller-owned')
      const res = spawnSync(process.execPath, [cli, backup, '--staging-root', container], { encoding: 'utf8', timeout: 60_000 })
      assert.equal(res.status, expectedExit, `${label}: exit ${res.status} (stderr: ${String(res.stderr).slice(0, 200)})`)
      const out = JSON.parse(res.stdout)
      assert.equal(out.staging.cleanedUp, true, `${label}: receipt must claim cleanup only after verified removal`)
      assert.ok(!out.staging.cleanupError, `${label}: ${out.staging.cleanupError ?? ''}`)
      assert.equal(existsSync(sentinel), true, `${label}: the caller's sentinel must survive the job`)
      const leftover = existsSync(container) ? readdirSync(container).filter(n => n.startsWith('job-')) : ['container-missing']
      assert.equal(leftover.length, 0, `${label}: the job subdirectory must be gone after exit (left: ${leftover})`)
      const stagingSegment = label === 'success' ? 'cont-ok' : 'cont-bad'
      assert.ok(!JSON.stringify(out).includes(stagingSegment), `${label}: report must not contain the staging root path`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('F2: final artifact budget — child binding that pushes the output over maxEvents refuses', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const codec = await v3codec()
  const dir = mkdtempSync(join(tmpdir(), 'f2-budget-'))
  try {
    const mk = () => buildV5Archive([
      fileEntry('sessions', `${officialDirFor('bp')}/session.v3.jsonl`, v3SessionBytes(codec, 'bp'), 'sessions'),
      fileEntry('sessions', `${officialDirFor('bc')}/session.v3.jsonl`, v3SessionBytes(codec, 'bc', { origin: 'subagent', parentSession: 'bp', descriptor: { provider: 'p', version: 1, mode: 'continuable', label: 'l' } }), 'sessions'),
    ])
    // budget 2: parent (2 events) + bound child fact pushes the final
    // artifact to 3 — the FINAL count must refuse, not the initial one.
    const over = mkdtempSync(join(tmpdir(), 'f2-over-'))
    writeFileSync(join(dir, 'over.gz'), mk())
    const rOver = await inspectSessions(join(dir, 'over.gz'), { stagingRoot: join(over, 'stg'), sessionBudget: { maxEvents: 2 } })
    const pOver = rOver.sessions.find(s => s.id === 'bp')
    assert.equal(pOver.status, 'refused', 'final artifact over budget must refuse')
    assert.equal(pOver.code, 'SESSION_BUDGET')
    assert.ok((pOver.error ?? '').includes('final artifact'), `final-count refusal (got ${pOver.error})`)
    rmSync(over, { recursive: true, force: true })
    // budget 3: the same archive passes (canonical 3 ≤ 3).
    const fits = mkdtempSync(join(tmpdir(), 'f2-fits-'))
    writeFileSync(join(dir, 'fits.gz'), mk())
    const rFits = await inspectSessions(join(dir, 'fits.gz'), { stagingRoot: join(fits, 'stg'), sessionBudget: { maxEvents: 3 } })
    const pFits = rFits.sessions.find(s => s.id === 'bp')
    assert.equal(pFits.status, 'restored')
    assert.equal(pFits.importable, true)
    assert.equal(pFits.canonicalEvents, 3)
    rmSync(fits, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await unmount()
  }
})

test('selection: a declared-missing highest generation blocks fallback; a present highest ignores lower missing slots', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const codec = await v3codec()
  const dir = mkdtempSync(join(tmpdir(), 'gen-missing-'))
  try {
    // Case 1: v3 FILE + same-dir v4 MISSING (PARTIAL archive) → no silent
    // fallback; the directory is refused with the stable reason and the
    // lower generation stays as diagnostics.
    const gz1 = buildV5Archive([
      fileEntry('sessions', `${officialDirFor('g-up')}/session.v3.jsonl`, v3SessionBytes(codec, 'g-up'), 'sessions'),
      missingEntry('sessions', `${officialDirFor('g-up')}/session.v4.jsonl`, 'sessions'),
    ], { manifest: { integrity: 'PARTIAL' } })
    writeFileSync(join(dir, 'up.gz'), gz1)
    const r1 = await inspectSessions(join(dir, 'up.gz'), { stagingRoot: join(dir, 'stg1') })
    const up = r1.sessions.find(s => s.id === 'g-up')
    assert.equal(up.status, 'refused', 'missing highest must refuse, not fall back to v3')
    assert.equal(up.code, 'LEGACY_GENERATION_UNAVAILABLE')
    assert.equal(up.sourceGeneration, 4)
    assert.deepEqual(up.lowerGenerationsPresent, ['session.v3.jsonl'])
    assert.equal(r1.counts.importable, 0)
    assert.ok(r1.childEvidence.declaredMissing.some(m => m.path.endsWith('session.v4.jsonl')))
    rmSync(join(dir, 'stg1'), { recursive: true, force: true })

    // Case 2: v4 FILE + lower v3 MISSING → the valid highest is NOT blocked.
    const gz2 = buildV5Archive([
      fileEntry('sessions', `${officialDirFor('g-ok')}/session.v4.jsonl`, headerRow(4, 'g-ok'), 'sessions'),
      missingEntry('sessions', `${officialDirFor('g-ok')}/session.v3.jsonl`, 'sessions'),
    ], { manifest: { integrity: 'PARTIAL' } })
    writeFileSync(join(dir, 'ok.gz'), gz2)
    const r2 = await inspectSessions(join(dir, 'ok.gz'), { stagingRoot: join(dir, 'stg2') })
    const ok = r2.sessions.find(s => s.id === 'g-ok')
    assert.equal(ok.status, 'restored')
    assert.equal(ok.importable, true, 'a present highest generation must not be blocked by a missing lower slot')
    assert.equal(ok.sourceGeneration, 4)
    rmSync(join(dir, 'stg2'), { recursive: true, force: true })

    // Case 3: only a v3 FILE, no higher declaration → normal historical
    // upgrade still applies.
    const gz3 = buildV5Archive([
      fileEntry('sessions', `${officialDirFor('g-plain')}/session.v3.jsonl`, v3SessionBytes(codec, 'g-plain'), 'sessions'),
    ])
    writeFileSync(join(dir, 'plain.gz'), gz3)
    const r3 = await inspectSessions(join(dir, 'plain.gz'), { stagingRoot: join(dir, 'stg3') })
    const plain = r3.sessions.find(s => s.id === 'g-plain')
    assert.equal(plain.status, 'restored')
    assert.equal(plain.importable, true)
    assert.equal(plain.sourceGeneration, 3)
    assert.equal(plain.outputGeneration, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await unmount()
  }
})

test('R3: real backup passes through the unified entry (env-gated)', { skip: !process.env.DSHA_V5_REAL || skip ? 'DSHA_V5_REAL or RC4_MODULES not set' : false }, async () => {
  await injectLoader()
  const unmount = await mountLocation()
  const dir = mkdtempSync(join(tmpdir(), 'r3-real-'))
  try {
    const stagingRoot = join(dir, 'staging')
    const r = await inspectSessions(process.env.DSHA_V5_REAL, { stagingRoot })
    assert.equal(r.archiveFailed, undefined)
    assert.equal(r.counts.total, 2)
    assert.equal(r.counts.importable, 2, `sessions must be FULLY admitted (official location verified); got ${JSON.stringify(r.sessions.map(s => ({ id: s.id, status: s.status, binding: s.binding, err: s.error })))}`)
    for (const s of r.sessions) {
      assert.equal(s.status, 'restored')
      assert.equal(s.sourceGeneration, 4)
      assert.equal(s.locationVerified, true)
      assert.ok([596, 454].includes(s.events), `event count ${s.events}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await unmount()
  }
})
