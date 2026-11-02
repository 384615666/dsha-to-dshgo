// Migration-chain tests against the installed official rc.4 format packages.
// Resolution: RC4_MODULES env var pointing at a node_modules directory that
// carries @deepseek-ai/dsh-session-format-* (dev machines have this from the
// P0 probe environment); production loads them from the host engine.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir

async function loadChain() {
  const chain = await import('../lib/migration/legacy-chain.js')
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const catPath = pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href
  const v3Path = pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href
  await chain.setModuleLoader(async () => ({
    cat: await import(catPath),
    v3: await import(v3Path),
  }))
  return chain
}

// A minimal legal current (v4) header + one user message event, matching the
// shapes the real rc.4 restore accepts (see real-backup-sample-report).
// Legal event shape taken from DSHA/tools/test-dsh-sessions.mjs via the P0
// probe's verified control (accepted by rc.4 strict/current).
function v4Fixture(id) {
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1793500000000,
    cwd: '/tmp/proj',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const rows = [
    e('turn/start', 0, { turn: 1 }),
    e('user/message', 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '保留这句话' }] }, { surfaceOp: 'append' }),
    e('step/start', 2, { turn: 1, step: 1 }),
    e('step/end', 3, { turn: 1, step: 1 }),
    e('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]
  return { header, rows }
}

test('classify: current v4 header classifies as current', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { classifyHeader } = await loadChain()
  const f = v4Fixture('session-cls-1')
  const cls = await classifyHeader(f.header)
  assert.equal(cls.status, 'current')
  assert.equal(cls.storedVersion, 4)
})

test('classify: unknown future version is LEGACY_HEADER_UNSUPPORTED', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { classifyHeader, migrateToV4, LEGACY_CODES } = await loadChain()
  const f = v4Fixture('session-cls-2')
  // readHeader classifies without throwing; migrateToV4 turns 'unsupported'
  // into LEGACY_HEADER_UNSUPPORTED.
  const cls = await classifyHeader({ ...f.header, version: 9 })
  assert.equal(cls.status, 'unsupported')
  assert.equal(cls.storedVersion, 9)
  await assert.rejects(
    () => migrateToV4({ ...f.header, version: 9 }, []),
    error => error.code === LEGACY_CODES.HEADER_UNSUPPORTED && error.details.storedVersion === 9,
  )
})

test('classify: malformed header is LEGACY_HEADER_UNSUPPORTED', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { classifyHeader, migrateToV4, LEGACY_CODES } = await loadChain()
  const cls = await classifyHeader({ type: 'session', version: 4, id: 'x' }) // missing fields
  assert.equal(cls.status, 'malformed')
  await assert.rejects(
    () => migrateToV4({ type: 'session', version: 4, id: 'x' }, []),
    error => error.code === LEGACY_CODES.HEADER_UNSUPPORTED,
  )
})

test('v4 restore + canonical encode + round-trip self-check passes', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { migrateToV4 } = await loadChain()
  const f = v4Fixture('session-rt-1')
  const out = await migrateToV4(f.header, f.rows, { childFacts: null })
  assert.equal(out.sourceVersion, 4)
  assert.equal(out.eventRows.length, 5)
  assert.equal(out.inheritedEventCount, 0)
})

test('v4 restore with a bad row is LEGACY_ROW_DECODE_FAILED', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { migrateToV4, LEGACY_CODES } = await loadChain()
  const f = v4Fixture('session-badrow')
  const badRows = [{ ...f.rows[0], seq: 5 }, ...f.rows.slice(1)] // gap at start
  await assert.rejects(
    () => migrateToV4(f.header, badRows, { childFacts: null }),
    error => {
      assert.equal(error.code, LEGACY_CODES.ROW_DECODE_FAILED)
      assert.equal(error.details.row, 0)
      return true
    },
  )
})

test('v3 header goes through the historical catalog', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { classifyHeader } = await loadChain()
  const f = v4Fixture('session-v3')
  const v3Header = { ...f.header, version: 3 }
  const cls = await classifyHeader(v3Header)
  // Historical catalog with no events restored: classification is by header
  // only. A header-only classification of a complete v3 header is 'current'
  // (for the historical catalog, current means "valid at v3").
  assert.ok(['current', 'migration-required'].includes(cls.status), `status ${cls.status}`)
})

test('v0 real-shape negative sample classifies and is rejected (chronology)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { readFile } = await import('node:fs/promises')
  // The released v0 real-shape fixture ships with DSHA (committed to the
  // handoff); it must classify via the historical catalog and be REJECTED,
  // not upgraded — the shapes cannot prove a chronology/system head.
  const fixturePath = process.env.DSHA_V0_NEGATIVE
  if (!fixturePath) return // fixture is machine-local; CI runs without it
  const lines = (await readFile(fixturePath, 'utf8')).split('\n').filter(x => x.trim())
  const header = JSON.parse(lines[0])
  const rows = lines.slice(1).map(x => JSON.parse(x))
  const { classifyHeader, migrateToV4, LEGACY_CODES } = await loadChain()
  const cls = await classifyHeader(header)
  assert.ok(['unsupported', 'malformed', 'migration-required'].includes(cls.status), `status ${cls.status}`)
  await assert.rejects(
    () => migrateToV4(header, rows, { childFacts: null }),
    error => {
      assert.ok(
        [LEGACY_CODES.HEADER_UNSUPPORTED, LEGACY_CODES.CHRONOLOGY_UNREACHABLE, LEGACY_CODES.ROW_DECODE_FAILED].includes(error.code),
        `unexpected code ${error.code}`,
      )
      return true
    },
  )
})

test('genuine packed v1: one text-chunks physical row expands to TWO logical events through the official chain', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { migrateToV4 } = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v01 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v0-to-v1')).href)
  const header = { type: 'session', version: 1, id: 'synthetic-packed-v1', createdAt: 1, cwd: '/synthetic', delegationDepth: 0 }
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const packedRows = [
    e('turn/start', 0, { turn: 1 }),
    e('step/start', 1, { turn: 1, step: 1 }),
    { type: 'text-chunks', seq0: 2, time0: 102, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ['A', 'B'] } },
    e('step/end', 4, { turn: 1, step: 1 }),
    e('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
  ]

  // Direct codec oracle: exactly ONE packed run, expanding to 2 events.
  const dec = v01.releasedV1SessionFormatCodec.createDecoder(header, 'strict')
  const decoded = []
  const ctx = { emitEvent: v => decoded.push(v), emitRun: r => decoded.push(...r.expand()) }
  for (const row of packedRows) dec.decodeRow(row, ctx)
  dec.finish(ctx)
  assert.equal(decoded.length, 6, '5 physical rows must decode to 6 logical events')
  const runEvents = decoded.filter(x => x.type === 'assistant/chunk')
  assert.equal(runEvents.length, 2, 'the packed run expands to exactly 2 events')
  assert.deepEqual(runEvents.map(x => x.seq), [2, 3])
  assert.deepEqual(runEvents.map(x => x.data.chunk.text), ['A', 'B'])

  // Through the plugin chain: same expansion, physical rows preserved, and
  // the packed texts survive the v1→v4 rewrite (migrateToV4 already ran the
  // deep round-trip self-check on its own output).
  const out = await migrateToV4(header, packedRows, { childFacts: [] })
  assert.equal(out.rowCount, 5, 'source physical row count must not collapse to 0')
  assert.equal(out.eventRows.length, 6)
  assert.deepEqual(out.eventRows.map(x => x.seq), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(out.eventRows.map(x => x.type),
    ['turn/start', 'step/start', 'system/message', 'assistant/attempt', 'step/end', 'turn/end'])
  const blob = out.eventRows.map(x => JSON.stringify(x)).join('|')
  assert.ok(blob.includes('"A"') && blob.includes('"B"'), 'packed chunk texts must survive the v1→v4 migration')
})

test('synthetic v3 positive: official codec encode → official chain restore → v4 round-trip', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { classifyHeader, migrateToV4 } = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  const codec = v23.releasedV3SessionFormatCodec

  const id = 'session-synth-v3'
  const v3LogicalHeader = { version: 3, id, createdAt: 1793500000000, cwd: '/tmp/proj', isSeeded: false, delegationDepth: 0 }
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const logicalEvents = [
    e('turn/start', 0, { turn: 1 }),
    e('user/message', 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '保留这句话' }] }, { surfaceOp: 'append' }),
    e('step/start', 2, { turn: 1, step: 1 }),
    e('step/end', 3, { turn: 1, step: 1 }),
    e('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]

  // Encode with the OFFICIAL v3 codec (physical header has no type field).
  const physicalHeader = codec.encodeHeader(v3LogicalHeader, 0)
  const physicalRows = logicalEvents.map(ev => codec.encodeEvent(ev))

  // Classification through the historical catalog.
  const cls = await classifyHeader(physicalHeader)
  assert.equal(cls.status, 'current', `historical catalog status ${cls.status}: ${cls.reason ?? ''}`)

  // Migrate: restore (historical) → canonical v4 → round-trip self-check.
  const out = await migrateToV4(physicalHeader, physicalRows, { childFacts: null })
  assert.equal(out.sourceVersion, 3)
  assert.equal(out.eventRows.length, logicalEvents.length)
  assert.equal(out.headerRow.version, 4)
  assert.equal(out.headerRow.id, id)
})

test('synthetic v2 positive: same pipeline through the v2 codec', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { migrateToV4 } = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v12 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v1-to-v2')).href)
  const codec = v12.releasedV2SessionFormatCodec

  const id = 'session-synth-v2'
  const v2LogicalHeader = { version: 2, id, createdAt: 1793500000000, cwd: '/tmp/proj', isSeeded: false, delegationDepth: 0 }
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const logicalEvents = [
    e('turn/start', 0, { turn: 1 }),
    e('step/start', 1, { turn: 1, step: 1 }),
    e('user/message', 2, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '保留这句话' }] }, { surfaceOp: 'append' }),
    e('step/end', 3, { turn: 1, step: 1 }),
    e('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]

  const physicalHeader = codec.encodeHeader(v2LogicalHeader, 0)
  const physicalRows = logicalEvents.map(ev => codec.encodeEvent(ev))

  const out = await migrateToV4(physicalHeader, physicalRows, { childFacts: null })
  assert.equal(out.sourceVersion, 2)
  // The v2→v3→v4 chain may legitimately rewrite the event stream (structure
  // events); the round-trip self-check inside migrateToV4 already asserted
  // canonical-v4 consistency, so here we require at least the original
  // surfaces to survive and the header identity to be preserved.
  assert.ok(out.eventRows.length >= logicalEvents.length, `expected >= ${logicalEvents.length} events, got ${out.eventRows.length}`)
  assert.equal(out.headerRow.version, 4)
  assert.equal(out.headerRow.id, id)
  // Content preservation: the original user message text must survive the
  // official rewrite (the migrated artifact was deep-compared internally;
  // here we assert the surviving canonical rows still carry it).
  const roundTripTexts = out.eventRows
    .map(r => { try { return JSON.stringify(r) } catch { return '' } })
    .join('|')
  assert.ok(roundTripTexts.includes('保留这句话'), 'original user message text must survive the v2→v4 rewrite')
})

test('v3 parent with subagent child: child facts restore the parent to v4', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const chain = await loadChain()
  const { classifyHeader, restoreArtifact, childFactsFromArtifacts, restoreParentWithChildren, encodeCanonicalV4AndSelfCheck, LEGACY_CODES } = chain
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const cat = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })

  // Child: subagent origin, parentSession pointing at the parent.
  const childHeader = { type: 'session', version: 3, id: 'session-child', createdAt: 1793500000500, cwd: '/tmp/proj', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'session-parent' }
  const childRows = [
    e('turn/start', 0, { turn: 1 }),
    e('step/start', 1, { turn: 1, step: 1 }),
    e('step/end', 2, { turn: 1, step: 1 }),
    e('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const child = await restoreArtifact(childHeader, childRows)
  assert.equal(child.usedHistorical, true)
  const facts = await childFactsFromArtifacts([child.artifact])
  assert.equal(facts.length, 1)
  assert.equal(facts[0].childId, 'session-child')

  // Parent restores to v4 with the child facts bound.
  const parentHeader = { type: 'session', version: 3, id: 'session-parent', createdAt: 1793500000000, cwd: '/tmp/proj', isSeeded: false, delegationDepth: 0 }
  const parentRows = [
    e('turn/start', 0, { turn: 1 }),
    e('step/start', 1, { turn: 1, step: 1 }),
    e('user/message', 2, { id: 'p-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '保留这句话' }] }, { surfaceOp: 'append' }),
    e('step/end', 3, { turn: 1, step: 1 }),
    e('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const parent = await restoreParentWithChildren(parentHeader, parentRows, facts)
  const canonical = await encodeCanonicalV4AndSelfCheck(parent.artifact)
  assert.equal(canonical.headerRow.version, 4)
  assert.equal(canonical.headerRow.id, 'session-parent')
  void classifyHeader
  void LEGACY_CODES
})

test('v3 parent restore still works when the archive declares no direct children (empty set)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { restoreParentWithChildren, encodeCanonicalV4AndSelfCheck } = await loadChain()
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const parentHeader = { type: 'session', version: 3, id: 'session-solo', createdAt: 1793500000000, cwd: '/tmp/proj', isSeeded: false, delegationDepth: 0 }
  const parentRows = [
    e('turn/start', 0, { turn: 1 }),
    e('step/start', 1, { turn: 1, step: 1 }),
    e('user/message', 2, { id: 's-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'solo' }] }, { surfaceOp: 'append' }),
    e('step/end', 3, { turn: 1, step: 1 }),
    e('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]
  // Explicit empty child set — a statement from the backup manifest, not a
  // placeholder for unknowns.
  const parent = await restoreParentWithChildren(parentHeader, parentRows, [])
  const canonical = await encodeCanonicalV4AndSelfCheck(parent.artifact)
  assert.equal(canonical.headerRow.version, 4)
  assert.equal(canonical.headerRow.id, 'session-solo')
})

test('CHILD_EVIDENCE: ILLEGAL parent catalog row (version 0/unknown mode) refuses regardless of facts — NOT a missing-fact refusal', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { restoreParentWithChildren, LEGACY_CODES } = await loadChain()
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const parentHeader = { type: 'session', version: 3, id: 'p-ev', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }
  const rows = [
    e('turn/start', 0, { turn: 1 }),
    // The refusal source is the ILLEGAL row payload (version 0 / mode
    // unknown is not a supported catalog fact shape) — renaming the old
    // "no fact bound → refuses" claim, which the differential matrix
    // disproved (a LEGAL parent catalog row is self-sufficient with an
    // empty fact set).
    e('subagent/catalog', 1, { childId: 'missing-child', mode: 'unknown', version: 0, childCreatedAt: 1793500001000 }),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ]
  await assert.rejects(
    () => restoreParentWithChildren(parentHeader, rows, []),
    error => {
      assert.equal(error.code, LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE, `expected CHILD_EVIDENCE_INCOMPLETE, got ${error.code} (${error.message.slice(0, 120)})`)
      return true
    },
  )
})

test('CHILD_EVIDENCE: parent rows + matching fact restore to v4; unrelated fact set refuses', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { restoreArtifact, childFactsFromArtifacts, restoreParentWithChildren, encodeCanonicalV4AndSelfCheck } = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const cat = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })

  // Build a real subagent child artifact (origin subagent) whose rows carry
  // a subagent/descriptor event.
  const childHeader = { type: 'session', version: 3, id: 'child-with-desc', createdAt: 1793500001000, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'p-match' }
  const childRestore = cat.historicalSessionFormatCatalog.createRestore(childHeader, { recovery: 'strict', validation: 'current' })
  const childRows = [
    e('turn/start', 0, { turn: 1 }),
    e('subagent/descriptor', 1, { provider: 'test-provider', version: 1, mode: 'continuable', label: 'test child' }),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ]
  for (const row of childRows) childRestore.decodeRow(row)
  const childArtifact = childRestore.finish()

  const facts = await childFactsFromArtifacts([childArtifact])
  assert.equal(facts[0].childId, 'child-with-desc')

  const parentHeader = { type: 'session', version: 3, id: 'p-match', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }
  const parentRows = [
    e('turn/start', 0, { turn: 1 }),
    e('subagent/catalog', 1, { childId: 'child-with-desc', mode: 'continuable', version: 1, provider: 'test-provider', label: 'test child', childCreatedAt: 1793500001000 }),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ]

  // Positive: matching fact bound → restores to v4.
  const parent = await restoreParentWithChildren(parentHeader, parentRows, facts)
  const canonical = await encodeCanonicalV4AndSelfCheck(parent.artifact)
  assert.equal(canonical.headerRow.version, 4)

  // Semantics note (probed on rc.4): binding a fact for a DIFFERENT child id
  // is TOLERATED by the official chain — the parent's own subagent/catalog
  // rows are authoritative, extra candidate facts are inert. The hard gate
  // is a declared child with NO fact at all (previous test).
  const tolerated = await restoreParentWithChildren(parentHeader, parentRows, [{ ...facts[0], childId: 'other-child' }])
  const canonicalOther = await encodeCanonicalV4AndSelfCheck(tolerated.artifact)
  assert.equal(canonicalOther.headerRow.version, 4)
})

test('v1 raw physical rows: shared-layout header + rows decode through the official v1 codec', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  // v1 codec is decode-only (no encode); rows are the shared physical layout
  // built by hand per DSHA's test harness shape.
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v0mod = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v0-to-v1')).href)
  const codec = v0mod.releasedV1SessionFormatCodec

  const header = { type: 'session', version: 1, id: 'session-synth-v1', createdAt: 1793500000000, cwd: '/tmp/proj', delegationDepth: 0 }
  // Classification of the raw v1 header via the historical catalog.
  const { classifyHeader } = await loadChain()
  const cls = await classifyHeader(header)
  // classifyHeader picks the catalog by version: for v1 the CURRENT catalog
  // says migration-required (valid v1, needs upgrade to v4) — exactly right.
  assert.ok(['migration-required', 'current'].includes(cls.status), `v1 header status ${cls.status}: ${cls.reason ?? ''}`)

  // Raw v1 physical rows (shared layout; one event per row for this shape).
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  // v1 surface rows require an open step (same chronology rule as v2+).
  const rows = [
    e('turn/start', 0, { turn: 1 }),
    e('step/start', 1, { turn: 1, step: 1 }),
    e('user/message', 2, { id: 'v1-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '保留这句话' }] }, { surfaceOp: 'append' }),
    e('step/end', 3, { turn: 1, step: 1 }),
    e('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]

  // Official decode with the emitEvent context contract (v0/v1 codec).
  const decoder = codec.createDecoder(header, 'strict')
  const events = []
  const context = { emitEvent: ev => events.push(ev) }
  for (const row of rows) decoder.decodeRow(row, context)
  decoder.finish(context)
  assert.equal(events.length, rows.length)

  // Then through the canonical v4 chain (catalog createRestore emits events
  // the same way — restoreArtifact normalizes both shapes).
  const { migrateToV4 } = await loadChain()
  const out = await migrateToV4(header, rows, { childFacts: [] })
  assert.equal(out.sourceVersion, 1)
  assert.ok(out.eventRows.length >= rows.length, `expected >= ${rows.length} canonical events`)
  assert.equal(out.headerRow.version, 4)
  assert.equal(out.headerRow.id, 'session-synth-v1')
})

test('R1: one-shot generator input produces the SAME full result as an array — on the LEGACY v3 path (both chain passes)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  // The historical path runs TWO passes over the physical rows (historical
  // catalog, then child-bound). A one-shot generator consumed by pass 1 used
  // to leave pass 2 an exhausted iterator → official chain accepts the empty
  // session → silent 5→0 "success". v4 does not exercise both passes, so the
  // regression must drive a real v3 fixture.
  const { migrateToV4 } = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  const codec = v23.releasedV3SessionFormatCodec
  const id = 'session-gen-v3'
  const v3LogicalHeader = { version: 3, id, createdAt: 1793500000000, cwd: '/tmp/proj', isSeeded: false, delegationDepth: 0 }
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const logicalEvents = [
    e('turn/start', 0, { turn: 1 }),
    e('user/message', 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '生成器回归' }] }, { surfaceOp: 'append' }),
    e('step/start', 2, { turn: 1, step: 1 }),
    e('step/end', 3, { turn: 1, step: 1 }),
    e('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const physicalHeader = codec.encodeHeader(v3LogicalHeader, 0)
  const physicalRows = logicalEvents.map(ev => codec.encodeEvent(ev))

  const fromArray = await migrateToV4(physicalHeader, physicalRows, { childFacts: null })
  assert.equal(fromArray.eventRows.length, logicalEvents.length)
  function* gen() { yield* physicalRows }
  const fromGen = await migrateToV4(physicalHeader, gen(), { childFacts: null })
  assert.equal(fromGen.rowCount, physicalRows.length, 'row count must survive BOTH historical passes')
  assert.equal(fromGen.eventRows.length, logicalEvents.length, 'legacy generator input must not silently yield 0 events')
  assert.deepEqual(fromGen.eventRows.map(r => JSON.stringify(r)), fromArray.eventRows.map(r => JSON.stringify(r)))
  assert.equal(fromGen.headerRow.version, 4)
  assert.equal(fromGen.headerRow.id, id)
  assert.equal(fromGen.inheritedEventCount, fromArray.inheritedEventCount)
  assert.ok(fromGen.eventRows.map(r => JSON.stringify(r)).join('|').includes('生成器回归'), 'original text must survive')
})

test('R2: round-trip self-check rejects content-changing fault injection', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { encodeCanonicalV4AndSelfCheck, assertDeepRoundTrip, migrateToV4, LEGACY_CODES } = await loadChain()
  const f = v4Fixture('session-fault')
  // Build a legitimate artifact via the normal path first.
  const good = await migrateToV4(f.header, f.rows, { childFacts: null })
  // Reconstruct an artifact whose event text was rewritten but count/header
  // kept — exactly the fault-injection the review proved the old check missed.
  const tampered = {
    header: { ...f.header },
    events: f.rows.map((row, i) => i === 1
      ? { ...row, data: { ...row.data, content: [{ type: 'text', text: '被篡改的内容' }] } }
      : row),
    inheritedEventCount: 0,
  }
  assert.throws(
    () => assertDeepRoundTrip(tampered, { header: tampered.header, events: f.rows, inheritedEventCount: 0 }),
    error => error.code === LEGACY_CODES.ROUNDTRIP_MISMATCH,
    'rewritten message text must be refused by the deep comparison',
  )
  void good
})

test('R5: precise legacy codes — chronology/child-evidence/row-decode/round-trip each assert their exact code', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { restoreArtifact, migrateToV4, restoreParentWithChildren, LEGACY_CODES } = await loadChain()
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const f = v4Fixture('session-codes')

  // ROW_DECODE_FAILED: plain bad row (surface chronology during decode).
  await assert.rejects(
    () => restoreArtifact(f.header, [{ ...f.rows[1] }], {}),
    error => error.code === LEGACY_CODES.ROW_DECODE_FAILED,
  )

  // CHILD_EVIDENCE_INCOMPLETE: parent declares subagent/catalog with an
  // INVALID fact payload (version 0 / mode unknown is not a supported fact),
  // restored with an empty fact set. The refusal comes from finish().
  const parentHeader = { type: 'session', version: 3, id: 'p-codes', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }
  const rows = [
    e('turn/start', 0, { turn: 1 }),
    e('subagent/catalog', 1, { childId: 'missing-child', mode: 'unknown', version: 0 }),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ]
  await assert.rejects(
    () => restoreParentWithChildren(parentHeader, rows, []),
    error => error.code === LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE,
  )

  // HEADER_UNSUPPORTED: future version via migrateToV4.
  await assert.rejects(
    () => migrateToV4({ ...f.header, version: 9 }, []),
    error => error.code === LEGACY_CODES.HEADER_UNSUPPORTED,
  )

  // CHRONOLOGY_UNREACHABLE: v2 surface before the first step cannot acquire
  // a system head (SessionFormatUnsupportedMigrationError from the v2→v3
  // stage) — normalizeFinishError maps it to the precise chronology code.
  const { createRequire: cr } = await import('node:module')
  const { pathToFileURL: p2u } = await import('node:url')
  const req2 = cr(join(rc4Dir, 'noop.js'))
  const v12 = await import(p2u(req2.resolve('@deepseek-ai/dsh-session-format-v1-to-v2')).href)
  const v2Header = v12.releasedV2SessionFormatCodec.encodeHeader(
    { version: 2, id: `${f.header.id}-v2`, createdAt: 1793500000000, cwd: '/tmp/proj', isSeeded: false, delegationDepth: 0 }, 0)
  const surfFirst = [
    e('user/message', 0, { id: `${f.header.id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }, { surfaceOp: 'append' }),
  ]
  await assert.rejects(
    () => restoreArtifact(v2Header, surfFirst, {}),
    error => {
      assert.equal(error.code, LEGACY_CODES.CHRONOLOGY_UNREACHABLE)
      assert.match(error.message, /system head/)
      return true
    },
  )

  // SAME chronology refusal through the PARENT entry: restoreParentWithChildren
  // used to wrap every decode error as ROW_DECODE_FAILED — the entry point
  // must not change the classification (F7).
  await assert.rejects(
    () => restoreParentWithChildren(v2Header, surfFirst, []),
    error => {
      assert.equal(error.code, LEGACY_CODES.CHRONOLOGY_UNREACHABLE, `parent entry must classify chronology identically, got ${error.code}`)
      assert.match(error.message, /system head/)
      return true
    },
  )

  // ROUNDTRIP_MISMATCH: direct assertion via the comparator.
  const { assertDeepRoundTrip } = await import('../lib/migration/legacy-chain.js')
  assert.throws(
    () => assertDeepRoundTrip({ header: f.header, events: f.rows, inheritedEventCount: 0 }, { header: f.header, events: [], inheritedEventCount: 0 }),
    error => error.code === LEGACY_CODES.ROUNDTRIP_MISMATCH,
  )
  void migrateToV4
})

// ---------------------------------------------------------------------------
// R4: child-evidence differential matrix (rc.4 behaviors verified in the
// review and re-verified here against the same packages).
// ---------------------------------------------------------------------------

function parentWithCatalogRow(catalogData) {
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const header = { type: 'session', version: 3, id: 'p-matrix', createdAt: 1793500000000, cwd: '/w', isSeeded: false, delegationDepth: 0 }
  return { header, rows: [
    e('turn/start', 0, { turn: 1 }),
    e('subagent/catalog', 1, catalogData),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ] }
}

test('R4 matrix: legal v1/continuable parent catalog row + EMPTY facts succeeds (parent row is self-sufficient)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { restoreParentWithChildren, encodeCanonicalV4AndSelfCheck } = await loadChain()
  const { header, rows } = parentWithCatalogRow({ childId: 'child-a', mode: 'continuable', version: 1, provider: 'p', label: 'l', childCreatedAt: 1793500001000 })
  const parent = await restoreParentWithChildren(header, rows, [])
  const canonical = await encodeCanonicalV4AndSelfCheck(parent.artifact)
  assert.equal(canonical.headerRow.version, 4)
})

test('R4 matrix: same legal parent catalog + MATCHING fact succeeds (3 events)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { restoreArtifact, childFactsFromArtifacts, restoreParentWithChildren, encodeCanonicalV4AndSelfCheck } = await loadChain()
  const { createRequire: cr } = await import('node:module')
  const { pathToFileURL: p2u } = await import('node:url')
  const req = cr(join(rc4Dir, 'noop.js'))
  const cat = await import(p2u(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  // Build the matching child artifact.
  const childHeader = { type: 'session', version: 3, id: 'child-a', createdAt: 1793500001000, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'p-matrix' }
  const restore = cat.historicalSessionFormatCatalog.createRestore(childHeader, { recovery: 'strict', validation: 'current' })
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  for (const row of [
    e('turn/start', 0, { turn: 1 }),
    e('subagent/descriptor', 1, { provider: 'p', version: 1, mode: 'continuable', label: 'l' }),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ]) restore.decodeRow(row)
  const childArtifact = restore.finish()
  const facts = await childFactsFromArtifacts([childArtifact])

  const { header, rows } = parentWithCatalogRow({ childId: 'child-a', mode: 'continuable', version: 1, provider: 'p', label: 'l', childCreatedAt: 1793500001000 })
  const parent = await restoreParentWithChildren(header, rows, facts)
  const canonical = await encodeCanonicalV4AndSelfCheck(parent.artifact)
  assert.equal(canonical.eventRows.length, 3)
})

test('R4 matrix: same parent catalog + CONFLICTING childCreatedAt fact → official refusal (conflicts with its parent catalog)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { restoreParentWithChildren, LEGACY_CODES } = await loadChain()
  const { header, rows } = parentWithCatalogRow({ childId: 'child-a', mode: 'continuable', version: 1, provider: 'p', label: 'l', childCreatedAt: 1793500001000 })
  const conflictingFact = { childId: 'child-a', childCreatedAt: 9999999999999, descriptorCount: 1, descriptor: { provider: 'p', version: 1, mode: 'continuable', label: 'l' } }
  await assert.rejects(
    () => restoreParentWithChildren(header, rows, [conflictingFact]),
    error => {
      // Precise class: a parent/child time conflict is child-evidence
      // evidence conflict, not a generic bad row.
      assert.equal(error.code, LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE, `expected CHILD_EVIDENCE_INCOMPLETE, got ${error.code}`)
      assert.match(error.message, /conflicts with its parent catalog/i)
      return true
    },
  )
})

test('R4 matrix: same parent catalog + UNRELATED childId fact ADDS a new subagent/catalog event (not ignored)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { restoreParentWithChildren } = await loadChain()
  const { header, rows } = parentWithCatalogRow({ childId: 'child-a', mode: 'continuable', version: 1, provider: 'p', label: 'l', childCreatedAt: 1793500001000 })
  const unrelatedFact = { childId: 'child-b', childCreatedAt: 1793500002000, descriptorCount: 1, descriptor: { provider: 'p', version: 1, mode: 'continuable', label: 'b' } }
  // The chain tolerates and ADDS the unrelated child as its own catalog row.
  const parent = await restoreParentWithChildren(header, rows, [unrelatedFact])
  assert.ok(parent.artifact.events.length >= rows.length + 1, 'unrelated fact must ADD a catalog entry, not be ignored')
})

test('R4 matrix: INVALID v0/unknown parent catalog row refuses with empty AND matching facts (fact shape is not the differentiator)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { restoreParentWithChildren } = await loadChain()
  const { header, rows } = parentWithCatalogRow({ childId: 'child-x', mode: 'unknown', version: 0 })
  // Empty facts: refuses (row payload itself is illegal).
  await assert.rejects(() => restoreParentWithChildren(header, rows, []), error => /catalog/i.test(error.message ?? ''))
  // Even a MATCHING fact must not rescue an illegal parent row payload.
  const matchingFact = { childId: 'child-x', childCreatedAt: 1793500001000, descriptorCount: 1, descriptor: { provider: 'p', version: 1, mode: 'continuable', label: 'x' } }
  await assert.rejects(() => restoreParentWithChildren(header, rows, [matchingFact]), error => /catalog/i.test(error.message ?? ''))
})

test('R4 matrix: parent WITHOUT catalog rows + legal matching fact → chain adds the catalog (completes evidence)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { restoreParentWithChildren, encodeCanonicalV4AndSelfCheck } = await loadChain()
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const header = { type: 'session', version: 3, id: 'p-nocat', createdAt: 1793500000000, cwd: '/w', isSeeded: false, delegationDepth: 0 }
  const rows = [
    e('turn/start', 0, { turn: 1 }),
    e('step/start', 1, { turn: 1, step: 1 }),
    e('step/end', 2, { turn: 1, step: 1 }),
    e('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const matchingFact = { childId: 'child-c', childCreatedAt: 1793500001000, descriptorCount: 1, descriptor: { provider: 'p', version: 1, mode: 'continuable', label: 'c' } }
  const parent = await restoreParentWithChildren(header, rows, [matchingFact])
  const canonical = await encodeCanonicalV4AndSelfCheck(parent.artifact)
  assert.equal(canonical.headerRow.version, 4)
})
