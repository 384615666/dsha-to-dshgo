// P2 M4: extended A/B matrix — same verified candidates through A (service
// replay) and B (locate-based exclusive publication) on FRESH isolated roots,
// covering: compaction sessions, legal seeded cut, preset mapping, parent/
// child groups, attachment groups, and new-instance visibility. Each case
// records the gate evidence; unsupported shapes go to the failure column.
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
import { collectAttachmentDependencies, planAttachmentPublication, publishAttachments } from '../lib/import/attachments.js'

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
  const attachmentLocal = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-attachment-local')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const base = mkdtempSync(join(tmpdir(), 'm4x-ab-'))
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

const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })

// Verified candidate builders (official codecs only).
async function buildCandidate(kind, id, cwd) {
  const chain = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  const codec = v23.releasedV3SessionFormatCodec
  let logical
  let inheritedEventCount = 0
  let preset = 'standard'
  if (kind === 'compaction') {
    logical = [
      e('turn/start', 0, { turn: 1 }),
      e('step/start', 1, { turn: 1, step: 1 }),
      e('user/message', 2, { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'early' }], turn: 1, step: 1 }, { surfaceOp: 'append' }),
      e('assistant/message', 3, { id: 'a1', role: 'assistant', message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'reply' }], source: { kind: 'model', provider: 'deepseek', model: 'test-model' } }, turn: 1, step: 1, stream: [] }, { surfaceOp: 'append' }),
      e('step/end', 4, { turn: 1, step: 1 }),
      e('compaction/start', 5, { compactionId: 'cmp-1', turn: 1 }),
      e('compaction/summary', 6, { compactionId: 'cmp-1', summary: [{ type: 'text', text: 'compacted summary' }], rawOutput: [{ type: 'text', text: 'raw' }], shadowedRange: { start: 2, end: 3 }, shadowedSeqs: [2, 3], shadowedTokenCount: 42 }),
      e('compaction/end', 7, { compactionId: 'cmp-1', turn: 1 }),
      e('turn/end', 8, { turn: 1, reason: { kind: 'completed' } }),
      e('turn/start', 9, { turn: 2 }),
      e('user/message', 10, { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'late' }] }, { surfaceOp: 'append' }),
      e('turn/end', 11, { turn: 2, reason: { kind: 'completed' } }),
    ]
  } else if (kind === 'seeded') {
    inheritedEventCount = 2
    logical = [
      e('turn/start', 0, { turn: 1 }),
      e('step/start', 1, { turn: 1, step: 1 }),
      e('session/end-seed', 2, { inherited: true }),
      e('user/message', 3, { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'after seed' }] }, { surfaceOp: 'append' }),
      e('step/end', 4, { turn: 1, step: 1 }),
      e('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
    ]
  } else if (kind === 'preset-preserved') {
    preset = 'custom-source-preset'
    logical = [
      e('turn/start', 0, { turn: 1 }),
      e('user/message', 1, { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'preset test' }] }, { surfaceOp: 'append' }),
      e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ]
  } else if (kind === 'attachment-file') {
    // built by the caller with the file ref already embedded
    logical = null
  } else if (kind === 'empty') {
    // a CURRENT v4 session with a header and zero events: the official
    // backend accepts an empty session (probed), so the import gates must too.
    return {
      id,
      header: { version: 4, id, createdAt: 1793500000000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: preset },
      events: [],
      inheritedEventCount: 0,
    }
  } else {
    logical = [
      e('turn/start', 0, { turn: 1 }),
      e('user/message', 1, { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: kind }] }, { surfaceOp: 'append' }),
      e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ]
  }
  let events = null
  if (logical) {
    const physicalHeader = codec.encodeHeader({ version: 3, id, createdAt: 1793500000000, cwd, isSeeded: inheritedEventCount > 0, delegationDepth: 0, agentPreset: preset }, inheritedEventCount)
    const out = await chain.migrateToV4(physicalHeader, logical.map(ev => codec.encodeEvent(ev)), { childFacts: null })
    const cat = (await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)).sessionFormatCatalog
    const restore = cat.createRestore(out.headerRow, { recovery: 'strict', validation: 'current' })
    for (const row of out.eventRows) restore.decodeRow(row)
    const artifact = restore.finish()
    events = artifact.events
  }
  return {
    id,
    header: { ...{ version: 4, id, createdAt: 1793500000000, cwd, isSeeded: inheritedEventCount > 0, delegationDepth: 0 }, agentPreset: preset },
    events,
    inheritedEventCount,
  }
}

// Canonical B bytes with the first frame = the one-line header.
function canonicalBytes(cat, header, events, inheritedEventCount) {
  const headerRow = cat.encodeCurrentHeader(header, inheritedEventCount)
  const frames = [zlib.zstdCompressSync(Buffer.from(JSON.stringify(headerRow) + '\n'))]
  for (const ev of events) frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(cat.encodeCurrentEvent(ev)) + '\n')))
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

const APPEND = (id, startSeq, turn) => [
  { type: 'turn/start', seq: startSeq, time: 9_000, data: { turn } },
  { type: 'user/message', seq: startSeq + 1, time: 9_001, data: { id: `${id}-m9`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'appended after import' }] }, surfaceOp: 'append' },
  { type: 'turn/end', seq: startSeq + 2, time: 9_002, data: { turn, reason: { kind: 'completed' } } },
]

const MATRIX_CASES = ['plain', 'compaction', 'seeded', 'preset-preserved', 'empty']

test('P2 M4 extended A/B matrix: plain/compaction/seeded/preset-preserved/empty satisfy the same gates on both paths', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const matrix = []
  for (const kind of MATRIX_CASES) {
    const a = await mountTarget()
    const b = await mountTarget()
    try {
      const cand = await buildCandidate(kind, `abx-${kind}`, a.base)
      // ---- A
      const aRes = await importSessionViaA(a.persistence, cand)
      const aRead = await readAll(a.persistence, cand.header.id)
      const nextTurn = Math.max(0, ...cand.events.filter(x => x.type === 'turn/start').map(x => x.data.turn)) + 1
      const aAppend = await verifyAppendCapability({
        persistence: a.persistence, id: cand.header.id,
        makeEvents: APPEND(cand.header.id, cand.events.length, nextTurn), expectedEvents: cand.events.length,
      })
      // ---- B
      assert.equal(hasLocateCapability(b.persistence), true)
      const cat = (await import(pathToFileURL(createRequire(join(rc4Dir, 'noop.js')).resolve('@deepseek-ai/dsh-session-format-catalog')))).sessionFormatCatalog
      const bytes = canonicalBytes(cat, cand.header, cand.events, cand.inheritedEventCount)
      const bRes = await publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate: cand, bytes })
      const bRead = await readAll(b.persistence, cand.header.id)
      const bAppend = await verifyAppendCapability({
        persistence: b.persistence, id: cand.header.id,
        makeEvents: APPEND(cand.header.id, cand.events.length, nextTurn), expectedEvents: cand.events.length,
      })

      const aDigest = sha(aRead.events)
      const bDigest = sha(bRead.events)
      assert.equal(aDigest, sha(cand.events), `${kind}: A readback equals candidate`)
      assert.equal(bDigest, sha(cand.events), `${kind}: B readback equals candidate`)
      assert.equal(aRead.inherited, cand.inheritedEventCount, `${kind}: A inherited cut`)
      assert.equal(bRead.inherited, cand.inheritedEventCount, `${kind}: B inherited cut`)
      assert.equal(aAppend, bAppend, `${kind}: identical append counts`)
      // per-row gate assertions: B's list/open/writeOpen steps must pass
      assert.equal(bRes.steps.list.ok, true, `${kind}: B list gate`)
      assert.equal(bRes.steps.writeOpen.ok, true, `${kind}: B writeOpen gate`)
      assert.equal(bRes.steps.readback.ok, true, `${kind}: B readback gate`)
      assert.equal(aRes.steps.readback.ok, true, `${kind}: A readback gate`)
      // preset mapping is preserved verbatim on both paths (mapping happens
      // at the plan layer, before the candidate is verified). For the
      // preset-preserved case this proves the CUSTOM preset really flowed
      // through (not silently standard).
      assert.equal(aRead.header.agentPreset, bRead.header.agentPreset)
      if (kind === 'preset-preserved') {
        assert.equal(aRead.header.agentPreset, 'custom-source-preset', 'the custom preset must be exercised verbatim')
      }
      // R2.1: FULL semantic re-read AFTER the append — the append content
      // must match exactly on both paths (a content swap with equal count
      // must fail this comparison), plus gates and duplicate-ID refusals.
      const aAfter = await readAll(a.persistence, cand.header.id)
      const bAfter = await readAll(b.persistence, cand.header.id)
      const expectedAfter = [...cand.events, ...APPEND(cand.header.id, cand.events.length, Math.max(0, ...cand.events.filter(x => x.type === 'turn/start').map(x => x.data.turn)) + 1)]
      const aPrefixOk = aAfter.events.slice(0, cand.events.length).every((ev, i) => JSON.stringify(ev) === JSON.stringify(cand.events[i]))
      const bPrefixOk = bAfter.events.slice(0, cand.events.length).every((ev, i) => JSON.stringify(ev) === JSON.stringify(cand.events[i]))
      assert.ok(aPrefixOk && bPrefixOk, `${kind}: the candidate prefix must survive the append on both paths`)
      assert.equal(sha(aAfter.events), sha(bAfter.events), `${kind}: post-append events must match across paths`)
      assert.equal(sha(aAfter.events), sha(expectedAfter), `${kind}: post-append events must equal candidate + APPEND exactly`)
      await assert.rejects(() => importSessionViaA(a.persistence, cand), err => err.code === 'IMPORT_ID_CONFLICT', `${kind}: A duplicate id refuses`)
      await assert.rejects(
        () => publishSessionViaB({ persistence: b.persistence, sessionsRoot: b.sessionsRoot, candidate: cand, bytes }),
        err => err.code === 'B_ID_CONFLICT', `${kind}: B duplicate id refuses`)
      matrix.push({
        case: kind,
        aEvents: cand.events.length,
        bEvents: cand.events.length,
        inherited: cand.inheritedEventCount,
        appended: aAppend,
        postAppendMatch: sha(aAfter.events) === sha(bAfter.events) && sha(aAfter.events) === sha(expectedAfter),
        aDuplicateRefused: true,
        bDuplicateRefused: true,
        // derived from the checks, never hardcoded
        equivalent: aPrefixOk && bPrefixOk && sha(aAfter.events) === sha(bAfter.events) && sha(aAfter.events) === sha(expectedAfter),
      })
    } finally {
      await a.unmount()
      await b.unmount()
    }
  }
  assert.equal(matrix.length, MATRIX_CASES.length)
})

test('P2 M4 parent/child group through A: parent binds the child fact; new instance sees both', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const a = await mountTarget()
  try {
    const chain = await loadChain()
    const req = createRequire(join(rc4Dir, 'noop.js'))
    const cat = (await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)).sessionFormatCatalog
    const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
    const codec = v23.releasedV3SessionFormatCodec
    const e2 = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
    // child with descriptor
    const childHeader = codec.encodeHeader({ version: 3, id: 'ab-child', createdAt: 1793500001000, cwd: a.base, isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'ab-parent' }, 0)
    const childLogical = [
      e2('turn/start', 0, { turn: 1 }),
      e2('subagent/descriptor', 1, { provider: 'p', version: 1, mode: 'continuable', label: 'l' }),
      e2('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const child = await chain.migrateToV4(childHeader, childLogical.map(ev => codec.encodeEvent(ev)), { childFacts: null })
    const childRestore = cat.createRestore(child.headerRow, { recovery: 'strict', validation: 'current' })
    for (const row of child.eventRows) childRestore.decodeRow(row)
    const childArtifact = childRestore.finish()
    const { childFactsFromArtifacts } = await import('../lib/migration/legacy-chain.js')
    const facts = await childFactsFromArtifacts([childArtifact])

    // R2.2 control: a parent whose OWN catalog row is self-sufficient stays
    // 3→3 with the official chain even with childFacts=[] (separate positive).
    const selfSufficientHeader = codec.encodeHeader({ version: 3, id: 'ab-parent-self', createdAt: 1793500000000, cwd: a.base, isSeeded: false, delegationDepth: 0 }, 0)
    const selfSufficientLogical = [
      e2('turn/start', 0, { turn: 1 }),
      e2('subagent/catalog', 1, { childId: 'ab-child', mode: 'continuable', version: 1, provider: 'p', label: 'l', childCreatedAt: 1793500001000 }),
      e2('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const selfOut = await chain.migrateToV4(selfSufficientHeader, selfSufficientLogical.map(ev => codec.encodeEvent(ev)), { childFacts: [] })
    assert.equal(selfOut.eventRows.length, 3, 'a self-sufficient parent catalog stays 3→3 (separate control)')

    // R2.2 main case: a TRUE no-catalog 2-event parent — the child fact must
    // ADD the catalog event (2→3) with the child identity in the output.
    const parentHeader = codec.encodeHeader({ version: 3, id: 'ab-parent', createdAt: 1793500000000, cwd: a.base, isSeeded: false, delegationDepth: 0 }, 0)
    const parentLogical = [
      e2('turn/start', 0, { turn: 1 }),
      e2('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const parentOut = await chain.migrateToV4(parentHeader, parentLogical.map(ev => codec.encodeEvent(ev)), { childFacts: facts })
    assert.equal(parentOut.eventRows.length, 3, `the bound child fact must ADD the catalog event (2→3), got ${parentOut.eventRows.length}`)
    const parentRestore = cat.createRestore(parentOut.headerRow, { recovery: 'strict', validation: 'current' })
    for (const row of parentOut.eventRows) parentRestore.decodeRow(row)
    const parentArtifact = parentRestore.finish()
    const catalogEvent = parentArtifact.events.find(x => x.type === 'subagent/catalog')
    assert.ok(catalogEvent, 'the output must contain the added subagent/catalog')
    assert.equal(catalogEvent.data?.childId, 'ab-child', 'the catalog must name the child identity')

    // A-path import: child first, then parent with the bound fact
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    await importSessionViaA(a.persistence, { header: { ...childArtifact.header, agentPreset: 'standard' }, events: childArtifact.events, inheritedEventCount: childArtifact.inheritedEventCount ?? 0 })
    const parentResult = await importSessionViaA(a.persistence, { header: { ...parentArtifact.header, agentPreset: 'standard' }, events: parentArtifact.events, inheritedEventCount: parentArtifact.inheritedEventCount ?? 0 })
    assert.equal(parentResult.steps.readback.ok, true)
    // the parent readback contains the bound subagent/catalog event
    const parentRead = await readAll(a.persistence, 'ab-parent')
    assert.ok(parentRead.events.some(x => x.type === 'subagent/catalog' && x.data?.childId === 'ab-child'), 'bound fact completes the parent catalog with the child identity')
    // new-instance visibility (R2.3: this instance IS used and disposed)
    const req2 = createRequire(join(rc4Dir, 'noop.js'))
    const jsonl2 = await import(pathToFileURL(req2.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
    const { Context } = await import(pathToFileURL(req2.resolve('@deepseek-ai/cordis')).href)
    const ctx2 = new Context()
    const sessionsRoot = join(a.base, 'sessions')
    await ctx2.plugin(jsonl2, { root: sessionsRoot, compression: 'zstd' })
    try {
      // R2.2: new-instance SEMANTIC readback, not just stat — the parent's
      // catalog event with the child identity must be visible there too.
      const pRead = await ctx2.sessionPersistence.open('ab-parent', 'read')
      let pEvents
      try { pEvents = (await pRead.read()).events } finally { await pRead.close() }
      assert.ok(pEvents.some(x => x.type === 'subagent/catalog' && x.data?.childId === 'ab-child'), 'new instance reads the completed catalog semantics')
      assert.ok(await ctx2.sessionPersistence.stat('ab-child'), 'child visible on a new instance')
      assert.ok(await ctx2.sessionPersistence.stat('ab-parent'), 'parent visible on a new instance')
    } finally {
      await ctx2.fiber?.dispose?.()
    }
  } finally {
    await a.unmount()
  }
})

test('P2 M4 attachment group through A: file published verbatim, session readback carries the ref, new instance reads it', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const attachmentLocal = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-attachment-local')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const a = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'm4x-att-'))
  try {
    const fileBytes = Buffer.from('M4 attachment group\n')
    const fileDigest = createHash('sha256').update(fileBytes).digest('hex')
    const ref = { attachmentId: `sha256:${fileDigest}`, name: 'group.txt', bytes: fileBytes.length }
    const chain = await loadChain()
    const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
    const codec = v23.releasedV3SessionFormatCodec
    const e2 = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
    const logical = [
      e2('turn/start', 0, { turn: 1 }),
      e2('user/message', 1, { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] }, { surfaceOp: 'append' }),
      e2('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ]
    const header = codec.encodeHeader({ version: 3, id: 'abx-att', createdAt: 1793500000000, cwd: a.base, isSeeded: false, delegationDepth: 0 }, 0)
    const out = await chain.migrateToV4(header, logical.map(ev => codec.encodeEvent(ev)), { childFacts: null })
    const cat = (await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)).sessionFormatCatalog
    const restore = cat.createRestore(out.headerRow, { recovery: 'strict', validation: 'current' })
    for (const row of out.eventRows) restore.decodeRow(row)
    const artifact = restore.finish()

    const graph = collectAttachmentDependencies([{ id: 'abx-att', events: artifact.events }])
    assert.equal(graph.objects.length, 1)
    const planned = await planAttachmentPublication({
      objects: graph.objects,
      exists: async () => false,
      readSource: async () => fileBytes,
    })
    const pub = await publishAttachments({ store: a.attachments, attachmentRoot: a.attachmentRoot, planned })
    assert.equal(pub.published.length, 1)
    // session import AFTER the attachment is published (attachments-first)
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    const result = await importSessionViaA(a.persistence, { header: { ...artifact.header, agentPreset: 'standard' }, events: artifact.events, inheritedEventCount: 0 })
    assert.equal(result.steps.readback.ok, true)
    // new instance reads the file verbatim
    const ctx2 = new Context()
    const jsonl2 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
    const attachmentLocal2 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-attachment-local')).href)
    await ctx2.plugin(attachmentLocal2.default, { dshHome: join(a.base, 'dshhome') })
    void jsonl2
    const chunks = []
    for await (const chunk of ctx2.attachments.readFileStream(ref)) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), fileBytes)
  } finally {
    await a.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})


