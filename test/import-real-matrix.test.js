// P2 M4 (remaining): REAL v4 sessions through both import paths, B-path
// atomic publication / failure compensation, and a mock-Agent continuation.
//
// The real-data tests are env-gated on DSHA_V5_REAL (the user's own backup).
// They never print session ids, cwd, chat content or digests; assertions name
// sessions by index only. Synthetic controls carry no private data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { importSessionViaA } from '../lib/import/writer-a.js'
import { publishSessionViaB, verifyAppendCapability, hasLocateCapability } from '../lib/import/writer-b.js'
import { collectAttachmentDependencies, planAttachmentPublication, publishAttachments } from '../lib/import/attachments.js'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir
const realSkip = !process.env.DSHA_V5_REAL || skip
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex')

const rc4Require = () => createRequire(join(rc4Dir, 'noop.js'))
const importPkg = async name => {
  const req = rc4Require()
  return import(pathToFileURL(req.resolve(name)).href)
}

async function mountTarget() {
  const jsonl = await importPkg('@deepseek-ai/dsh-session-persistence-jsonl')
  const attachmentLocal = await importPkg('@deepseek-ai/dsh-attachment-local')
  const { Context } = await importPkg('@deepseek-ai/cordis')
  const base = mkdtempSync(join(tmpdir(), 'm4-real-'))
  const dshHome = join(base, 'dshhome')
  mkdirSync(dshHome, { recursive: true })
  const sessionsRoot = join(base, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(jsonl, { root: sessionsRoot, compression: 'zstd' })
  await ctx.plugin(attachmentLocal.default, { dshHome })
  return {
    base,
    sessionsRoot,
    attachmentRoot: join(dshHome, 'attachments', 'v1'),
    persistence: ctx.sessionPersistence,
    attachments: ctx.attachments,
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(base, { recursive: true, force: true })
    },
  }
}

async function readAll(persistence, id) {
  const read = await persistence.open(id, 'read')
  try {
    const slice = await read.read()
    return { header: read.header, events: slice.events, inherited: read.inheritedEventCount }
  } finally {
    await read.close()
  }
}

async function catalog() {
  return (await importPkg('@deepseek-ai/dsh-session-format-catalog')).sessionFormatCatalog
}

async function loadChain() {
  const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
  const req = rc4Require()
  await setModuleLoader(async () => ({
    cat: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href),
    v3: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
  }))
  return import('../lib/migration/legacy-chain.js')
}

function canonicalBytes(cat, header, events, inheritedEventCount) {
  const headerRow = cat.encodeCurrentHeader(header, inheritedEventCount)
  const frames = [zlib.zstdCompressSync(Buffer.from(JSON.stringify(headerRow) + '\n'))]
  for (const ev of events) frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(cat.encodeCurrentEvent(ev)) + '\n')))
  return Buffer.concat(frames)
}

const nextTurnOf = events => Math.max(0, ...events.filter(x => x.type === 'turn/start').map(x => x.data.turn)) + 1

const APPEND = (id, startSeq, turn) => [
  { type: 'turn/start', seq: startSeq, time: 9_000, data: { turn } },
  { type: 'user/message', seq: startSeq + 1, time: 9_001, data: { id: `${id}-m9`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'appended after import' }] }, surfaceOp: 'append' },
  { type: 'turn/end', seq: startSeq + 2, time: 9_002, data: { turn, reason: { kind: 'completed' } } },
]

// A mock Agent turn: the official write handle receives a complete turn
// (start → step/start → user → assistant → step/end → end) exactly as a
// continuing agent would. The released v4 lifecycle requires an open step
// for assistant/message — a bare message is rejected by the official decoder.
const MOCK_TURN = (id, startSeq, turn) => [
  { type: 'turn/start', seq: startSeq, time: 9_100, data: { turn } },
  { type: 'step/start', seq: startSeq + 1, time: 9_101, data: { turn, step: 1 } },
  { type: 'user/message', seq: startSeq + 2, time: 9_102, data: { id: `${id}-mock-u`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'continue please' }], turn, step: 1 }, surfaceOp: 'append' },
  { type: 'assistant/message', seq: startSeq + 3, time: 9_103, data: { id: `${id}-mock-a`, role: 'assistant', message: { id: `${id}-mock-a`, role: 'assistant', content: [{ type: 'text', text: 'mock agent reply' }], source: { kind: 'model', provider: 'mock', model: 'mock-agent' } }, turn, step: 1, stream: [] }, surfaceOp: 'append' },
  { type: 'step/end', seq: startSeq + 4, time: 9_104, data: { turn, step: 1 } },
  { type: 'turn/end', seq: startSeq + 5, time: 9_105, data: { turn, reason: { kind: 'completed' } } },
]

// Stage and decode the REAL v4 logs with the OFFICIAL catalog. Returns
// candidates in verified-candidate shape. No ids are logged.
async function loadRealCandidates(dir) {
  const { readV5Backup } = await import('../lib/archive/v5-reader.js')
  const { SessionStaging } = await import('../lib/archive/session-staging.js')
  const { decompressZstdMultiFrame } = await import('../lib/archive/zstd-frames.js')
  const staging = new SessionStaging(join(dir, 'staging'))
  staging.prepare()
  await readV5Backup(process.env.DSHA_V5_REAL, { makeSink: staging.makeSinkFactory() })
  const verified = await staging.verifyAll()
  assert.equal(verified.failed.length, 0, 'every staged real file is byte-verified')
  const cat = await catalog()
  const out = []
  for (const entry of verified.staged) {
    const name = entry.path.split('/').at(-1)
    if (!/^session\.v4\.jsonl(?:\.zstd)?$/.test(name)) continue
    const raw = readFileSync(entry.stagedTo)
    const plain = name.endsWith('.zstd') ? decompressZstdMultiFrame(raw) : raw
    const lines = plain.toString('utf8').split('\n').filter(Boolean)
    const headerRow = JSON.parse(lines[0])
    assert.equal(headerRow.version, 4, 'the real backup session is a current v4 log')
    const restore = cat.createRestore(headerRow, { recovery: 'strict', validation: 'current' })
    for (const line of lines.slice(1)) restore.decodeRow(JSON.parse(line))
    const artifact = restore.finish()
    out.push({
      header: artifact.header,
      events: artifact.events,
      inheritedEventCount: artifact.inheritedEventCount ?? 0,
    })
  }
  return out
}

test('P2 M4 real v4 two-session matrix (596/454): A and B preserve semantics and stay appendable', { skip: realSkip ? 'DSHA_V5_REAL or RC4_MODULES not set' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm4-real-'))
  const a = await mountTarget()
  const b = await mountTarget()
  try {
    const candidates = await loadRealCandidates(dir)
    assert.equal(candidates.length, 2, 'the real backup exposes exactly two v4 sessions')
    const counts = candidates.map(c => c.events.length).sort((x, y) => x - y)
    assert.deepEqual(counts, [454, 596], 'the real sessions carry 454 and 596 events')
    const cat = await catalog()

    for (const cand of candidates) {
      await importSessionViaA(a.persistence, cand)
    }
    for (const cand of candidates) {
      const bytes = canonicalBytes(cat, cand.header, cand.events, cand.inheritedEventCount)
      const res = await publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate: cand, bytes })
      assert.equal(res.steps.readback.ok, true)
      assert.equal(res.steps.list.ok, true)
      assert.equal(res.steps.writeOpen.ok, true)
    }

    for (const [i, cand] of candidates.entries()) {
      const aRead = await readAll(a.persistence, cand.header.id)
      const bRead = await readAll(b.persistence, cand.header.id)
      assert.equal(sha(aRead.events), sha(cand.events), `real ${i}: A readback equals the real log`)
      assert.equal(sha(bRead.events), sha(cand.events), `real ${i}: B readback equals the real log`)
      assert.equal(aRead.header.agentPreset, cand.header.agentPreset, `real ${i}: A preserves the source preset`)
      assert.equal(bRead.header.agentPreset, cand.header.agentPreset, `real ${i}: B preserves the source preset`)

      const turn = nextTurnOf(cand.events)
      const expectedAppend = APPEND(cand.header.id, cand.events.length, turn)
      const aCount = await verifyAppendCapability({
        persistence: a.persistence, id: cand.header.id,
        makeEvents: expectedAppend, expectedEvents: cand.events.length,
      })
      const bCount = await verifyAppendCapability({
        persistence: b.persistence, id: cand.header.id,
        makeEvents: APPEND(cand.header.id, cand.events.length, turn), expectedEvents: cand.events.length,
      })
      assert.equal(aCount, expectedAppend.length)
      assert.equal(bCount, expectedAppend.length)
      const aAfter = await readAll(a.persistence, cand.header.id)
      const bAfter = await readAll(b.persistence, cand.header.id)
      assert.equal(sha(aAfter.events), sha([...cand.events, ...expectedAppend]), `real ${i}: A post-append semantics`)
      assert.equal(sha(bAfter.events), sha(aAfter.events), `real ${i}: post-append semantics agree across paths`)
      await assert.rejects(() => importSessionViaA(a.persistence, cand), err => err.code === 'IMPORT_ID_CONFLICT')
      await assert.rejects(
        () => publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate: cand, bytes: canonicalBytes(cat, cand.header, cand.events, cand.inheritedEventCount) }),
        err => err.code === 'B_ID_CONFLICT')
    }
  } finally {
    await a.unmount()
    await b.unmount()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 M4 mock Agent continues a REAL imported session; a fresh instance reads the full continuation', { skip: realSkip ? 'DSHA_V5_REAL or RC4_MODULES not set' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm4-agent-'))
  const a = await mountTarget()
  try {
    const candidates = await loadRealCandidates(dir)
    const cand = candidates.find(c => c.events.length === 596)
    assert.ok(cand, 'the larger real session is present')
    await importSessionViaA(a.persistence, cand)

    // mock Agent: load the history through the official read surface, then
    // append one complete turn through the official write handle.
    const before = await readAll(a.persistence, cand.header.id)
    assert.equal(before.events.length, 596)
    assert.equal(before.events.at(-1)?.type, 'turn/end', 'the real history ends at a turn boundary')
    const turn = nextTurnOf(before.events)
    const mockTurn = MOCK_TURN(cand.header.id, before.events.length, turn)
    const count = await verifyAppendCapability({
      persistence: a.persistence,
      id: cand.header.id,
      makeEvents: mockTurn,
      expectedEvents: before.events.length,
    })
    assert.equal(count, mockTurn.length)

    // fresh instance on the SAME real root: full semantic readback of the
    // imported history + the mock continuation.
    const jsonl = await importPkg('@deepseek-ai/dsh-session-persistence-jsonl')
    const { Context } = await importPkg('@deepseek-ai/cordis')
    const ctx2 = new Context()
    await ctx2.plugin(jsonl, { root: a.sessionsRoot, compression: 'zstd' })
    try {
      const read = await ctx2.sessionPersistence.open(cand.header.id, 'read')
      let events
      let header
      try { header = read.header; events = (await read.read()).events } finally { await read.close() }
      assert.equal(events.length, 602, '596 imported events + 6 mock-Agent events')
      const expected = [...cand.events, ...mockTurn]
      assert.equal(sha(events), sha(expected), 'the fresh instance reads the complete continuation')
      assert.equal(header.agentPreset, cand.header.agentPreset, 'the fresh instance keeps the source preset')
      assert.equal(events.at(-1)?.type, 'turn/end')
      assert.equal(events.at(-1)?.data?.turn, turn)
      assert.equal(events.at(-1)?.data?.reason?.kind, 'completed')
    } finally {
      await ctx2.fiber?.dispose?.()
    }
  } finally {
    await a.unmount()
    rmSync(dir, { recursive: true, force: true })
  }
})

// Synthetic candidate for the B atomicity tests (no private data).
async function syntheticCandidate(id, cwd) {
  const cat = await catalog()
  const header = { version: 4, id, createdAt: 1793500000000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
  const events = [
    { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 101, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'atomic' }] }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 2, time: 102, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return { candidate: { header, events, inheritedEventCount: 0 }, bytes: canonicalBytes(cat, header, events, 0) }
}

test('P2 M4 B atomic publication: concurrent same-id writers race on O_EXCL — exactly one wins, one file', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const b = await mountTarget()
  try {
    assert.equal(hasLocateCapability(b.persistence), true)
    const { candidate, bytes } = await syntheticCandidate('m4-b-race', b.base)
    const results = await Promise.allSettled([
      publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate, bytes }),
      publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate, bytes }),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    assert.equal(fulfilled.length, 1, 'exactly one concurrent publisher wins')
    assert.equal(rejected.length, 1, 'the loser is refused, not silently appended')
    assert.equal(rejected[0].reason.code, 'B_ID_CONFLICT')
    const read = await readAll(b.persistence, candidate.header.id)
    assert.equal(sha(read.events), sha(candidate.events), 'the winner published the exact candidate')
    const located = b.persistence.locate({ cwd: candidate.header.cwd, id: candidate.header.id })
    const siblings = readdirSync(dirname(located.path)).filter(n => n === 'session.v4.jsonl.zstd')
    assert.equal(siblings.length, 1, 'exactly one canonical generation file exists')
  } finally {
    await b.unmount()
  }
})

test('P2 M4 B failure compensation: a write fault leaves no visible session and no partial file', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const b = await mountTarget()
  const origWriteSync = fs.writeSync
  try {
    const { candidate, bytes } = await syntheticCandidate('m4-b-fail', b.base)
    // half-write then fail: the publication must unlink, never leave a
    // truncated log that could be read as a session.
    fs.writeSync = (fd, data, ...rest) => {
      origWriteSync(fd, Buffer.from(data).subarray(0, Math.max(1, Math.floor(Buffer.byteLength(data) / 2))), ...rest)
      const e = new Error('injected ENOSPC')
      e.code = 'ENOSPC'
      throw e
    }
    await assert.rejects(
      () => publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate, bytes }),
      err => err.code === 'B_IO')
    fs.writeSync = origWriteSync
    assert.equal(await b.persistence.stat(candidate.header.id), undefined, 'no partial session becomes visible')
    const located = b.persistence.locate({ cwd: candidate.header.cwd, id: candidate.header.id })
    assert.equal(statSync(located.path, { throwIfNoEntry: false }), undefined, 'the partial file was removed')
    // the same id can be published afterwards: compensation restored a clean namespace
    const ok = await publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate, bytes })
    assert.equal(ok.steps.readback.ok, true)
  } finally {
    fs.writeSync = origWriteSync
    await b.unmount()
  }
})

test('P2 M4 B namespace competition: a foreign file at the locate path is never overwritten', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const b = await mountTarget()
  try {
    const { candidate, bytes } = await syntheticCandidate('m4-b-foreign', b.base)
    const located = b.persistence.locate({ cwd: candidate.header.cwd, id: candidate.header.id })
    mkdirSync(dirname(located.path), { recursive: true })
    const foreign = Buffer.from('FOREIGN-NOT-A-SESSION')
    writeFileSync(located.path, foreign)
    let code = null
    let threw = false
    try {
      await publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate, bytes })
    } catch (error) {
      threw = true
      code = error.code
    }
    assert.equal(threw, true, 'the publication must refuse a pre-existing namespace entry')
    assert.ok(['B_ID_CONFLICT', 'B_IO', 'B_READBACK_MISMATCH'].includes(code), `stable refusal code, got ${code}`)
    assert.deepEqual(readFileSync(located.path), foreign, 'the foreign file is byte-identical (never overwritten)')
  } finally {
    await b.unmount()
  }
})

test('P2 M4 pagination/follow: a real imported session reads in slices and a later append is visible', { skip: realSkip ? 'DSHA_V5_REAL or RC4_MODULES not set' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm4-page-'))
  const a = await mountTarget()
  try {
    const candidates = await loadRealCandidates(dir)
    const cand = candidates.find(c => c.events.length === 596)
    assert.ok(cand, 'the 596-event real session is present')
    await importSessionViaA(a.persistence, cand)

    const read = await a.persistence.open(cand.header.id, 'read')
    try {
      const pages = []
      for (let off = 0; off < cand.events.length; off += 128) {
        const slice = await read.read(off, 128)
        assert.ok(slice.events.length <= 128)
        pages.push(...slice.events)
      }
      assert.equal(pages.length, cand.events.length, 'paged reads cover the whole log')
      assert.equal(sha(pages), sha(cand.events), 'paged read equals the verified candidate')
      const end = await read.read(cand.events.length, 10)
      assert.equal(end.events.length, 0, 'an offset at the end returns an empty slice')

      // follow: append through a write handle, then a read STARTED afterwards
      // on the existing read handle observes the new prefix.
      const turn = nextTurnOf(cand.events)
      const mockTurn = MOCK_TURN(cand.header.id, cand.events.length, turn)
      const write = await a.persistence.open(cand.header.id, 'write')
      try {
        await write.append(mockTurn)
        await write.flush()
      } finally {
        await write.close()
      }
      const followed = await read.read(cand.events.length, 100)
      assert.equal(followed.events.length, mockTurn.length, 'the follow read sees the appended turn')
      assert.equal(sha(followed.events), sha(mockTurn), 'the followed slice is exactly the appended turn')
    } finally {
      await read.close()
    }
  } finally {
    await a.unmount()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 M4 parent/child group through B: the bound catalog and both logs survive on a fresh instance', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const b = await mountTarget()
  try {
    const chain = await loadChain()
    const req = rc4Require()
    const cat = await catalog()
    const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
    const codec = v23.releasedV3SessionFormatCodec
    const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
    const childHeader = codec.encodeHeader({ version: 3, id: 'm4-b-child', createdAt: 1793500001000, cwd: b.base, isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'm4-b-parent' }, 0)
    const childLogical = [
      e('turn/start', 0, { turn: 1 }),
      e('subagent/descriptor', 1, { provider: 'p', version: 1, mode: 'continuable', label: 'l' }),
      e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const childOut = await chain.migrateToV4(childHeader, childLogical.map(ev => codec.encodeEvent(ev)), { childFacts: null })
    const childRestore = cat.createRestore(childOut.headerRow, { recovery: 'strict', validation: 'current' })
    for (const row of childOut.eventRows) childRestore.decodeRow(row)
    const childArtifact = childRestore.finish()
    const { childFactsFromArtifacts } = await import('../lib/migration/legacy-chain.js')
    const facts = await childFactsFromArtifacts([childArtifact])

    const parentHeader = codec.encodeHeader({ version: 3, id: 'm4-b-parent', createdAt: 1793500000000, cwd: b.base, isSeeded: false, delegationDepth: 0 }, 0)
    const parentLogical = [
      e('turn/start', 0, { turn: 1 }),
      e('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const parentOut = await chain.migrateToV4(parentHeader, parentLogical.map(ev => codec.encodeEvent(ev)), { childFacts: facts })
    assert.equal(parentOut.eventRows.length, 3, 'the child fact adds the parent catalog event (2→3)')
    const parentRestore = cat.createRestore(parentOut.headerRow, { recovery: 'strict', validation: 'current' })
    for (const row of parentOut.eventRows) parentRestore.decodeRow(row)
    const parentArtifact = parentRestore.finish()

    const childCand = { header: { ...childArtifact.header, agentPreset: 'standard' }, events: childArtifact.events, inheritedEventCount: 0 }
    const parentCand = { header: { ...parentArtifact.header, agentPreset: 'standard' }, events: parentArtifact.events, inheritedEventCount: 0 }
    await publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate: childCand, bytes: canonicalBytes(cat, childCand.header, childCand.events, 0) })
    await publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate: parentCand, bytes: canonicalBytes(cat, parentCand.header, parentCand.events, 0) })

    const jsonl = await importPkg('@deepseek-ai/dsh-session-persistence-jsonl')
    const { Context } = await importPkg('@deepseek-ai/cordis')
    const ctx2 = new Context()
    await ctx2.plugin(jsonl, { root: b.sessionsRoot, compression: 'zstd' })
    try {
      const read = await ctx2.sessionPersistence.open('m4-b-parent', 'read')
      let events
      try { events = (await read.read()).events } finally { await read.close() }
      assert.ok(events.some(x => x.type === 'subagent/catalog' && x.data?.childId === 'm4-b-child'), 'the fresh instance reads the bound catalog')
      assert.ok(await ctx2.sessionPersistence.stat('m4-b-child'), 'the child log is visible')
    } finally {
      await ctx2.fiber?.dispose?.()
    }
  } finally {
    await b.unmount()
  }
})


test('P2 M4 attachment group through B: verbatim file first, session ref and bytes read back on a fresh store', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const b = await mountTarget()
  try {
    const req = rc4Require()
    const chain = await loadChain()
    const cat = await catalog()
    const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
    const codec = v23.releasedV3SessionFormatCodec
    const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
    const fileBytes = Buffer.from('M4 B attachment group\n')
    const fileDigest = createHash('sha256').update(fileBytes).digest('hex')
    const ref = { attachmentId: `sha256:${fileDigest}`, name: 'b-group.txt', bytes: fileBytes.length }
    const logical = [
      e('turn/start', 0, { turn: 1 }),
      e('user/message', 1, { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] }, { surfaceOp: 'append' }),
      e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const header = codec.encodeHeader({ version: 3, id: 'm4-b-att', createdAt: 1793500000000, cwd: b.base, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }, 0)
    const out = await chain.migrateToV4(header, logical.map(ev => codec.encodeEvent(ev)), { childFacts: null })
    const restore = cat.createRestore(out.headerRow, { recovery: 'strict', validation: 'current' })
    for (const row of out.eventRows) restore.decodeRow(row)
    const artifact = restore.finish()
    const cand = { header: { ...artifact.header, agentPreset: 'standard' }, events: artifact.events, inheritedEventCount: 0 }

    const graph = collectAttachmentDependencies([{ id: cand.header.id, events: cand.events }])
    assert.equal(graph.objects.length, 1)
    const planned = await planAttachmentPublication({ objects: graph.objects, exists: async () => false, readSource: async () => fileBytes })
    const pub = await publishAttachments({ store: b.attachments, attachmentRoot: b.attachmentRoot, planned })
    assert.equal(pub.published.length, 1)

    const bres = await publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate: cand, bytes: canonicalBytes(cat, cand.header, cand.events, 0) })
    assert.equal(bres.steps.readback.ok, true)
    const readEvents = bres.readback.events
    assert.ok(readEvents.some(x => x.type === 'user/message' && JSON.stringify(x.data).includes(ref.attachmentId)), 'the session readback carries the file reference')

    const attachmentLocal = await importPkg('@deepseek-ai/dsh-attachment-local')
    const { Context } = await importPkg('@deepseek-ai/cordis')
    const ctx2 = new Context()
    await ctx2.plugin(attachmentLocal.default, { dshHome: join(b.base, 'dshhome') })
    try {
      const chunks = []
      for await (const chunk of ctx2.attachments.readFileStream(ref)) chunks.push(Buffer.from(chunk))
      assert.deepEqual(Buffer.concat(chunks), fileBytes)
    } finally {
      await ctx2.fiber?.dispose?.()
    }
  } finally {
    await b.unmount()
  }
})

test('P2 M4 B gate: a backend without locate is refused with the stable capability code', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const noLocate = {
    stat: async () => undefined,
    open: async () => { throw new Error('unreachable') },
    list: async () => [],
  }
  const candidate = { header: { version: 4, id: 'm4-nolocate', cwd: '/w', agentPreset: 'standard' }, events: [], inheritedEventCount: 0 }
  await assert.rejects(
    () => publishSessionViaB({ persistence: noLocate, sessionsRoot: '/tmp/x', candidate, bytes: Buffer.alloc(0) }),
    err => err.code === 'B_UNAVAILABLE_LOCATE')
})
