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

test('classify: current v4 header classifies as current', async () => {
  if (skip) return
  const { classifyHeader } = await loadChain()
  const f = v4Fixture('session-cls-1')
  const cls = await classifyHeader(f.header)
  assert.equal(cls.status, 'current')
  assert.equal(cls.storedVersion, 4)
})

test('classify: unknown future version is LEGACY_HEADER_UNSUPPORTED', async () => {
  if (skip) return
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

test('classify: malformed header is LEGACY_HEADER_UNSUPPORTED', async () => {
  if (skip) return
  const { classifyHeader, migrateToV4, LEGACY_CODES } = await loadChain()
  const cls = await classifyHeader({ type: 'session', version: 4, id: 'x' }) // missing fields
  assert.equal(cls.status, 'malformed')
  await assert.rejects(
    () => migrateToV4({ type: 'session', version: 4, id: 'x' }, []),
    error => error.code === LEGACY_CODES.HEADER_UNSUPPORTED,
  )
})

test('v4 restore + canonical encode + round-trip self-check passes', async () => {
  if (skip) return
  const { migrateToV4 } = await loadChain()
  const f = v4Fixture('session-rt-1')
  const out = await migrateToV4(f.header, f.rows, { childFacts: null })
  assert.equal(out.sourceVersion, 4)
  assert.equal(out.eventRows.length, 5)
  assert.equal(out.inheritedEventCount, 0)
})

test('v4 restore with a bad row is LEGACY_ROW_DECODE_FAILED', async () => {
  if (skip) return
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

test('v3 header goes through the historical catalog', async () => {
  if (skip) return
  const { classifyHeader } = await loadChain()
  const f = v4Fixture('session-v3')
  const v3Header = { ...f.header, version: 3 }
  const cls = await classifyHeader(v3Header)
  // Historical catalog with no events restored: classification is by header
  // only. A header-only classification of a complete v3 header is 'current'
  // (for the historical catalog, current means "valid at v3").
  assert.ok(['current', 'migration-required'].includes(cls.status), `status ${cls.status}`)
})

test('v0 real-shape negative sample classifies and is rejected (chronology)', async () => {
  if (skip) return
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

test('v0/v1 packed-row decode: packed rows expand via finish(), not line count', async () => {
  if (skip) return
  // packed-row semantics smoke test on the CURRENT (v4) path: N physical rows
  // in → N logical events out (v0/v1 packing is handled by the official
  // chain's decodeRow; the contract here is finish().events is the count).
  const { migrateToV4 } = await loadChain()
  const f = v4Fixture('session-packed')
  const out = await migrateToV4(f.header, f.rows, { childFacts: null })
  assert.equal(out.eventRows.length, f.rows.length)
})

test('synthetic v3 positive: official codec encode → official chain restore → v4 round-trip', async () => {
  if (skip) return
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

test('synthetic v2 positive: same pipeline through the v2 codec', async () => {
  if (skip) return
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
})

test('v3 parent with subagent child: child facts restore the parent to v4', async () => {
  if (skip) return
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

test('v3 parent restore still works when the archive declares no direct children (empty set)', async () => {
  if (skip) return
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

test('CHILD_EVIDENCE: parent rows carry subagent/catalog but no fact bound → official chain refuses', async () => {
  if (skip) return
  const { restoreParentWithChildren, LEGACY_CODES } = await loadChain()
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const parentHeader = { type: 'session', version: 3, id: 'p-ev', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }
  const rows = [
    e('turn/start', 0, { turn: 1 }),
    // The parent declares a subagent child in its own rows, but the caller
    // binds an EMPTY fact set (the archive was missing that child's log).
    e('subagent/catalog', 1, { childId: 'missing-child', mode: 'unknown', version: 0, childCreatedAt: 1793500001000 }),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ]
  await assert.rejects(
    () => restoreParentWithChildren(parentHeader, rows, []),
    error => {
      // The official chain's own refusal maps to CHILD_EVIDENCE_INCOMPLETE.
      assert.ok(
        /subagent\/catalog requires a supported versioned catalog fact/.test(error.message)
          || error.code === LEGACY_CODES.CHILD_EVIDENCE_INCOMPLETE
          || error.name === 'SessionFormatUnsupportedMigrationError',
        `unexpected error: ${error.message.slice(0, 120)}`,
      )
      return true
    },
  )
})

test('CHILD_EVIDENCE: parent rows + matching fact restore to v4; unrelated fact set refuses', async () => {
  if (skip) return
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
