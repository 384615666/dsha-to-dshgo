// P2 M4: same-input A/B matrix on isolated rc.4 targets. Each case builds one
// verified candidate, then imports it through A (service replay) and through B
// (locate-based exclusive publication) on two FRESH roots, recording the same
// gate evidence: strict/current provenance, full readback, inherited cut,
// list/open, write-open, append capability, and A/B equivalence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { importSessionViaA } from '../lib/import/writer-a.js'
import { publishSessionViaB, verifyAppendCapability, hasLocateCapability } from '../lib/import/writer-b.js'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex')

async function loadChain() {
  const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
  const req = createRequire(join(rc4Dir, 'noop.js'))
  await setModuleLoader(async () => ({
    cat: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href),
    v3: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
  }))
  return import('../lib/migration/legacy-chain.js')
}

async function mountTarget() {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const base = mkdtempSync(join(tmpdir(), 'm4-ab-'))
  const sessionsRoot = join(base, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(jsonl, { root: sessionsRoot, compression: 'zstd' })
  return {
    base,
    sessionsRoot,
    persistence: ctx.sessionPersistence,
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(base, { recursive: true, force: true })
    },
  }
}

// Canonical v3→v4 candidate, optionally seeded with a legal non-zero cut.
async function candidate(id, cwd, { seedCut = null } = {}) {
  const chain = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  const codec = v23.releasedV3SessionFormatCodec
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const seeded = seedCut != null
  const logical = seeded
    ? [
        e('turn/start', 0, { turn: 1 }),
        e('step/start', 1, { turn: 1, step: 1 }),
        e('session/end-seed', seedCut, { inherited: true }),
        e('user/message', seedCut + 1, { id: `${id}-u`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'M4 AB' }] }, { surfaceOp: 'append' }),
        e('step/end', seedCut + 2, { turn: 1, step: 1 }),
        e('turn/end', seedCut + 3, { turn: 1, reason: { kind: 'completed' } }),
      ]
    : [
        e('turn/start', 0, { turn: 1 }),
        e('user/message', 1, { id: `${id}-u`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'M4 AB' }] }, { surfaceOp: 'append' }),
        e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
      ]
  const physicalHeader = codec.encodeHeader({ version: 3, id, createdAt: 1793500000000, cwd, isSeeded: seeded, delegationDepth: 0, agentPreset: 'standard' }, seedCut ?? 0)
  const out = await chain.migrateToV4(physicalHeader, logical.map(ev => codec.encodeEvent(ev)), { childFacts: null })
  const cat = (await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)).sessionFormatCatalog
  const restore = cat.createRestore(out.headerRow, { recovery: 'strict', validation: 'current' })
  for (const row of out.eventRows) restore.decodeRow(row)
  const artifact = restore.finish()
  return { header: { ...artifact.header }, events: artifact.events, inheritedEventCount: artifact.inheritedEventCount ?? 0, cat }
}

// Canonical B bytes: official header row + one encoded event per line, zstd.
async function canonicalBytes(candidate) {
  const { cat, header, events, inheritedEventCount } = candidate
  const headerRow = cat.encodeCurrentHeader(header, inheritedEventCount)
  const rows = events.map(ev => cat.encodeCurrentEvent(ev))
  // Physical layout constraint: the FIRST zstd frame is exactly the one-line
  // header; event rows follow as their own frames (as the backend writes).
  const frames = [zlib.zstdCompressSync(Buffer.from(JSON.stringify(headerRow) + '\n'))]
  for (const row of rows) frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n')))
  return Buffer.concat(frames)
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

const CASES = [
  { name: 'upgraded-v4', seedCut: null },
  { name: 'seeded-cut-2', seedCut: 2 },
]

test('P2 M4 A/B matrix: identical inputs satisfy the same gates on both paths; append capability verified', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const matrix = []
  for (const testCase of CASES) {
    const a = await mountTarget()
    const b = await mountTarget()
    try {
      const cand = await candidate(`ab-${testCase.name}`, a.base, { seedCut: testCase.seedCut })
      // ---- A path
      const aRes = await importSessionViaA(a.persistence, cand)
      const aRead = await readAll(a.persistence, cand.header.id)
      const aDigest = sha(aRead.events)
      const aInherited = aRead.inherited
      const appended = [
        { type: 'turn/start', seq: cand.events.length, time: 9_000, data: { turn: 2 } },
        { type: 'turn/end', seq: cand.events.length + 1, time: 9_001, data: { turn: 2, reason: { kind: 'completed' } } },
      ]
      const aAppendCount = await verifyAppendCapability({
        persistence: a.persistence,
        id: cand.header.id,
        makeEvents: appended,
        expectedEvents: cand.events.length,
      })
      const aAfter = await readAll(a.persistence, cand.header.id)

      // ---- B path (capability recorded, bound to THIS root)
      assert.equal(hasLocateCapability(b.persistence), true)
      const bBytes = await canonicalBytes(cand)
      const bRes = await publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate: cand, bytes: bBytes })
      const bRead = await readAll(b.persistence, cand.header.id)
      const bDigest = sha(bRead.events)
      const bInherited = bRead.inherited
      const bAppendCount = await verifyAppendCapability({
        persistence: b.persistence,
        id: cand.header.id,
        makeEvents: appended,
        expectedEvents: cand.events.length,
      })
      const bAfter = await readAll(b.persistence, cand.header.id)

      // ---- equivalence and gates
      assert.equal(aDigest, sha(cand.events), `${testCase.name}: A readback equals the candidate`)
      assert.equal(bDigest, sha(cand.events), `${testCase.name}: B readback equals the candidate`)
      assert.equal(aInherited, cand.inheritedEventCount, `${testCase.name}: A inherited cut`)
      assert.equal(bInherited, cand.inheritedEventCount, `${testCase.name}: B inherited cut`)
      assert.equal(aAppendCount, bAppendCount, `${testCase.name}: both append the same count`)
      assert.equal(aAfter.events.length, bAfter.events.length, `${testCase.name}: post-append counts match`)
      assert.equal(sha(aAfter.events), sha(bAfter.events), `${testCase.name}: post-append events match`)
      assert.equal(aRes.steps.readback.ok, true)
      assert.equal(bRes.steps.readback.ok, true)
      assert.equal(bRes.steps.list.ok, true)
      assert.equal(bRes.steps.writeOpen.ok, true)

      // ---- duplicate/overwrite refusals on both paths
      await assert.rejects(() => importSessionViaA(a.persistence, cand), err => err.code === 'IMPORT_ID_CONFLICT')
      await assert.rejects(
        () => publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate: cand, bytes: bBytes }),
        err => err.code === 'B_ID_CONFLICT',
      )

      matrix.push({
        case: testCase.name,
        a: { readback: aDigest === sha(cand.events), inherited: aInherited, appended: aAppendCount },
        b: { readback: bDigest === sha(cand.events), inherited: bInherited, appended: bAppendCount, locate: 'available' },
        equivalent: sha(aAfter.events) === sha(bAfter.events),
      })
    } finally {
      await a.unmount()
      await b.unmount()
    }
  }
  assert.equal(matrix.length, CASES.length)
  // The matrix is the deliverable artifact; keep it deterministic and content free.
  assert.ok(matrix.every(row => row.a.readback && row.b.readback && row.equivalent))
})
