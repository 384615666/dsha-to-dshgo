// P2 batch-1 acceptance (post-review): the A-path production writer against
// a REAL engine backend mounted on an ISOLATED throwaway root. Covers:
// import + full semantic read-back (including the AUTHORITATIVE inherited
// cut from the public read handle — verified with a legal non-zero cut),
// duplicate-id refusal, expected-count cross-check refused before create,
// preset mapping and the unavailable-preset write-admission block, cut
// self-consistency, and independent strict re-restoration of the actual log.
// Requires RC4_MODULES pointing at the full engine install.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { decompressZstdMultiFrame } from '../lib/archive/zstd-frames.js'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir

// Mount the official JSONL backend on an isolated root; return the target's
// sessionPersistence service, an official locate-based directory resolver,
// and an unmount function.
async function mountTarget() {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const backendRoot = mkdtempSync(join(tmpdir(), 'import-target-'))
  const ctx = new Context()
  await ctx.plugin(jsonl, { root: backendRoot, compression: 'zstd' })
  const persistence = ctx.sessionPersistence
  if (!persistence || typeof persistence.create !== 'function') throw new Error('official backend persistence unavailable')
  return {
    persistence,
    locateDir(header) {
      const loc = persistence.locate(header)
      return relative(backendRoot, loc.path).split(sep).slice(0, -1).join('/')
    },
    backendRoot,
    unmount: async () => {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(backendRoot, { recursive: true, force: true })
    },
  }
}

async function loadChain() {
  const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
  const req = createRequire(join(rc4Dir, 'noop.js'))
  await setModuleLoader(async () => ({
    cat: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href),
    v3: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
  }))
  return import('../lib/migration/legacy-chain.js')
}

// A verified canonical v4 candidate via the official chain: synthetic v3 in,
// canonical v4 out. The candidate's inheritedEventCount is ALWAYS the
// official artifact's own cut — never a caller-supplied override (the review
// caught the fixture claiming 7 while the official cut was 0).
// seedCut: place the end-seed marker at this seq with legal events before it
// (a legal NON-ZERO cut positive control), making the session seeded.
async function canonicalCandidate(id, { preset = 'standard', seedCut = null, userText = 'P2 写入验证' } = {}) {
  const chain = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  const codec = v23.releasedV3SessionFormatCodec
  const cat = (await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)).sessionFormatCatalog
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const seeded = seedCut != null
  const logical = seeded
    ? [
        e('turn/start', 0, { turn: 1 }),
        e('step/start', 1, { turn: 1, step: 1 }),
        e('session/end-seed', seedCut, { inherited: true }),
        e('user/message', seedCut + 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }, { surfaceOp: 'append' }),
        e('step/end', seedCut + 2, { turn: 1, step: 1 }),
        e('turn/end', seedCut + 3, { turn: 1, reason: { kind: 'completed' } }),
      ]
    : [
        e('turn/start', 0, { turn: 1 }),
        e('user/message', 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }, { surfaceOp: 'append' }),
        e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
      ]
  const physicalHeader = codec.encodeHeader(
    { version: 3, id, createdAt: 1793500000000, cwd: '/w', isSeeded: seeded, delegationDepth: 0, agentPreset: preset },
    seeded ? seedCut : 0,
  )
  const physicalRows = logical.map(ev => codec.encodeEvent(ev))
  const out = await chain.migrateToV4(physicalHeader, physicalRows, { childFacts: null })
  const restore = cat.createRestore(out.headerRow, { recovery: 'strict', validation: 'current' })
  for (const row of out.eventRows) restore.decodeRow(row)
  const artifact = restore.finish()
  return {
    header: { ...artifact.header, agentPreset: preset },
    events: artifact.events,
    inheritedEventCount: artifact.inheritedEventCount ?? 0,
    _canonical: out,
  }
}

test('P2 writer-a: import + full semantic read-back on an isolated real backend', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { persistence, unmount } = await mountTarget()
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    const candidate = await canonicalCandidate('p2-import-a')
    const result = await importSessionViaA(persistence, candidate)
    assert.equal(result.id, 'p2-import-a')
    assert.equal(result.steps.readback.ok, true, `read-back must match: ${JSON.stringify(result.steps.readback.firstEventDiff ?? result.steps.readback.firstHeaderDiff)}`)
    assert.ok(/^[0-9a-f]{64}$/.test(result.digest), 'digest over the sent events')
    const list = await persistence.list()
    assert.ok(list.some(s => s.header.id === 'p2-import-a'), 'imported session must be visible in list()')
    const read = await persistence.open('p2-import-a', 'read')
    const slice = await read.read()
    await read.close()
    const blob = slice.events.map(x => JSON.stringify(x)).join('|')
    assert.ok(blob.includes('P2 写入验证'), 'user content must survive write + read-back')
  } finally {
    await unmount()
  }
})

test('P2 writer-a: legal NON-ZERO cut — read handle, a NEW backend instance, and a strict re-restore of the actual log all return the cut', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const first = await mountTarget()
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    const candidate = await canonicalCandidate('p2-seeded', { seedCut: 2 })
    assert.equal(candidate.header.isSeeded, true)
    assert.equal(candidate.inheritedEventCount, 2, 'the official artifact cut must be 2 (marker at seq 2)')
    const result = await importSessionViaA(first.persistence, candidate)
    assert.equal(result.steps.readback.ok, true)
    assert.equal(result.steps.readback.inheritedVerification.channel, 'readback')
    assert.equal(result.steps.readback.inheritedVerification.readCut, 2)
    assert.equal(result.steps.readback.inheritedMatch, true)
    // public read handle of the SAME instance
    const read = await first.persistence.open('p2-seeded', 'read')
    assert.equal(read.inheritedEventCount, 2, 'public read handle must return the persisted cut')
    await read.close()
    // a NEW backend instance mounted on the SAME root
    const second = await mountTarget() // separate root — only used for its ctx mechanics? no: reuse first root via raw mount
    await second.unmount()
    const req = createRequire(join(rc4Dir, 'noop.js'))
    const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
    const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
    const ctx2 = new Context()
    await ctx2.plugin(jsonl, { root: first.backendRoot, compression: 'zstd' })
    const p2 = ctx2.sessionPersistence
    const read2 = await p2.open('p2-seeded', 'read')
    assert.equal(read2.inheritedEventCount, 2, 'a new instance must also see the persisted cut')
    const slice2 = await read2.read()
    await read2.close()
    assert.equal(slice2.events.filter(x => x.type === 'session/end-seed').at(-1).seq, 2)
    // independent evidence: strict re-restore of the ACTUAL located log
    const dir = first.locateDir({ cwd: '/w', id: 'p2-seeded' })
    const raw = readFileSync(join(first.backendRoot, dir, 'session.v4.jsonl.zstd'))
    const { readSessionFile } = await import('../lib/inspect-sessions.js')
    const { header, rows } = readSessionFile(raw, { compressed: true })
    const cat = (await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)).sessionFormatCatalog
    const restore = cat.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of rows) restore.decodeRow(row)
    const artifact = restore.finish()
    assert.equal(artifact.inheritedEventCount, 2, 'strict re-restore of the actual log must return the cut')
    await ctx2.fiber?.dispose?.()
  } finally {
    await first.unmount()
  }
})

test('P2 writer-a: cut self-consistency — the old fixture shape (marker at 0, claimed 7) refuses BEFORE create', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { persistence, unmount } = await mountTarget()
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    // The review's counterexample: marker at seq 0 (official cut 0) while
    // the candidate claims 7 — not an officially verified artifact.
    const bad = {
      header: { version: 4, id: 'p2-badcut', createdAt: 1, cwd: '/w', isSeeded: true, delegationDepth: 0, agentPreset: 'standard' },
      events: [
        { type: 'session/end-seed', seq: 0, time: 100, data: { inherited: true } },
        { type: 'turn/start', seq: 1, time: 101, data: { turn: 1 } },
      ],
      inheritedEventCount: 7,
    }
    await assert.rejects(
      () => importSessionViaA(persistence, bad),
      err => err.code === 'IMPORT_CANDIDATE_INVALID' && /does not match the last end-seed marker seq 0/.test(err.message),
    )
    assert.equal(await persistence.stat('p2-badcut'), undefined, 'nothing may be created for a self-inconsistent candidate')
    // unseeded candidate carrying a marker also refuses
    const unseededMarker = { ...bad, header: { ...bad.header, isSeeded: false }, inheritedEventCount: 0 }
    await assert.rejects(() => importSessionViaA(persistence, unseededMarker), err => err.code === 'IMPORT_CANDIDATE_INVALID')
    // seeded candidate WITHOUT a marker refuses
    const noMarker = { ...bad, events: [{ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } }], inheritedEventCount: 0 }
    await assert.rejects(() => importSessionViaA(persistence, noMarker), err => err.code === 'IMPORT_CANDIDATE_INVALID')
  } finally {
    await unmount()
  }
})

test('P2 writer-a: expectedEventCount cross-check refuses BEFORE create (no visible object)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { persistence, unmount } = await mountTarget()
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    const candidate = await canonicalCandidate('p2-count')
    assert.equal(candidate.events.length, 3)
    // 999 vs actual 3: refuses pre-create — the previous spread bug reported
    // success here.
    await assert.rejects(
      () => importSessionViaA(persistence, candidate, { expectedEventCount: 999 }),
      err => err.code === 'IMPORT_CANDIDATE_INVALID' && /disagrees with the candidate/.test(err.message),
    )
    assert.equal(await persistence.stat('p2-count'), undefined, 'nothing may be created for a mismatched expectation')
    // equal expectation succeeds; non-integer/NaN refuses
    const ok = await importSessionViaA(persistence, candidate, { expectedEventCount: 3 })
    assert.equal(ok.steps.readback.ok, true)
    const candidate2 = await canonicalCandidate('p2-count2')
    await assert.rejects(
      () => importSessionViaA(persistence, candidate2, { expectedEventCount: Number.NaN }),
      err => err.code === 'IMPORT_CANDIDATE_INVALID',
    )
  } finally {
    await unmount()
  }
})

test('P2 writer-a: duplicate id refuses (import never overwrites or appends)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { persistence, unmount } = await mountTarget()
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    const candidate = await canonicalCandidate('p2-dup')
    await importSessionViaA(persistence, candidate)
    await assert.rejects(
      () => importSessionViaA(persistence, candidate),
      err => err.code === 'IMPORT_ID_CONFLICT',
    )
    const read = await persistence.open('p2-dup', 'read')
    const slice = await read.read()
    await read.close()
    assert.equal(slice.events.length, candidate.events.length, 'refused re-import must not have appended anything')
  } finally {
    await unmount()
  }
})

test('P2 writer-a: preset mapping (D2) — kept, missing-custom-preset applied; unavailable presets BLOCK write admission', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { resolvePresetMapping, applyPresetMapping, STANDARD_PRESET } = await import('../lib/import/preset.js')
  const { persistence, unmount } = await mountTarget()
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    const available = ['standard', 'deepresearch']
    assert.deepEqual(resolvePresetMapping('standard', available), { sourcePreset: 'standard', targetPreset: 'standard', reason: 'kept', writable: true })
    const mapped = resolvePresetMapping('my-custom-preset', available)
    assert.deepEqual(mapped, { sourcePreset: 'my-custom-preset', targetPreset: 'standard', reason: 'missing-custom-preset', writable: true })
    const candidate = await canonicalCandidate('p2-preset', { preset: 'my-custom-preset' })
    const result = await importSessionViaA(persistence, { ...candidate, header: applyPresetMapping(candidate.header, mapped) })
    assert.equal(result.steps.readback.ok, true)
    const read = await persistence.open('p2-preset', 'read')
    const header = read.header
    await read.close()
    assert.equal(header.agentPreset, STANDARD_PRESET, 'the written header must carry the MAPPED preset')
    // unavailable presets: NO writable mapping may be produced
    const unknown = resolvePresetMapping('my-custom-preset', null)
    assert.equal(unknown.reason, 'unavailable-presets')
    assert.equal(unknown.targetPreset, null, 'an unverified environment must not be assigned a guessed default')
    assert.equal(unknown.writable, false)
    assert.throws(() => applyPresetMapping(candidate.header, unknown), /not writable/)
    // a header whose preset never got resolved cannot reach create()
    let createCalls = 0
    const counting = new Proxy(persistence, {
      get(target, prop) {
        if (prop === 'create') return async (...args) => { createCalls += 1; return target.create(...args) }
        return target[prop]
      },
    })
    const unresolved = { ...candidate, header: { ...candidate.header, agentPreset: null } }
    await assert.rejects(
      () => importSessionViaA(counting, unresolved),
      err => err.code === 'IMPORT_CANDIDATE_INVALID' && /agentPreset/.test(err.message),
    )
    assert.equal(createCalls, 0, 'an unresolved preset must never reach create()')
  } finally {
    await unmount()
  }
})

test('P2 writer-a: invalid candidates refuse with stable codes', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { persistence, unmount } = await mountTarget()
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    await assert.rejects(
      () => importSessionViaA(persistence, { header: { version: 3, id: 'x' }, events: [] }),
      err => err.code === 'IMPORT_CANDIDATE_INVALID',
    )
    await assert.rejects(
      () => importSessionViaA(persistence, { header: { version: 4, id: 'y' }, events: 'nope' }),
      err => err.code === 'IMPORT_CANDIDATE_INVALID',
    )
    await assert.rejects(() => importSessionViaA(null, { header: { version: 4, id: 'z' }, events: [] }), err => err.code === 'IMPORT_TARGET_INVALID')
  } finally {
    await unmount()
  }
})
