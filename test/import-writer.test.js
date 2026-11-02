// P2 batch-1 acceptance: the A-path production writer against a REAL engine
// backend mounted on an ISOLATED throwaway root (never a live home). Covers:
// import + full semantic read-back, duplicate-id refusal, preset mapping,
// inheritedEventCount preservation, and invalid-candidate refusals.
// Requires RC4_MODULES pointing at the full engine install (needs
// dsh-session-persistence-jsonl + cordis + the format packages).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir

// Mount the official JSONL backend on an isolated root; return the target's
// sessionPersistence service plus an unmount function.
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
    unmount: async () => {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(backendRoot, { recursive: true, force: true })
    },
  }
}

// Boot the plugin migration chain through the rc.4 packages (canonical v4
// encoding for candidates).
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
// canonical v4 out (header row + event rows decoded back to logical events).
async function canonicalCandidate(id, { preset = 'standard', inheritedEventCount = 0, userText = 'P2 写入验证' } = {}) {
  const chain = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  const codec = v23.releasedV3SessionFormatCodec
  const cat = (await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)).sessionFormatCatalog
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  // A seeded session (inheritedEventCount > 0) requires isSeeded:true AND a
  // session/end-seed marker marking the inherited cut — the official chain
  // refuses the inconsistent shapes (verified negative).
  const logical = [
    ...(inheritedEventCount > 0 ? [e('session/end-seed', 0, { inherited: true })] : []),
    e('turn/start', inheritedEventCount > 0 ? 1 : 0, { turn: 1 }),
    e('user/message', inheritedEventCount > 0 ? 2 : 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }, { surfaceOp: 'append' }),
    e('turn/end', inheritedEventCount > 0 ? 3 : 2, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const physicalHeader = codec.encodeHeader(
    { version: 3, id, createdAt: 1793500000000, cwd: '/w', isSeeded: inheritedEventCount > 0, delegationDepth: 0, agentPreset: preset },
    inheritedEventCount,
  )
  const physicalRows = logical.map(ev => codec.encodeEvent(ev))
  const out = await chain.migrateToV4(physicalHeader, physicalRows, { childFacts: null })
  // Decode the canonical rows back into logical events for the writer.
  const restore = cat.createRestore(out.headerRow, { recovery: 'strict', validation: 'current' })
  for (const row of out.eventRows) restore.decodeRow(row)
  const artifact = restore.finish()
  return {
    header: { ...artifact.header, agentPreset: preset },
    events: artifact.events,
    inheritedEventCount: inheritedEventCount,
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
    // visible in list + stat
    const list = await persistence.list()
    assert.ok(list.some(s => s.header.id === 'p2-import-a'), 'imported session must be visible in list()')
    const snap = await persistence.stat('p2-import-a')
    assert.ok(snap, 'stat must find the imported session')
    // the original user text survives end to end
    const read = await persistence.open('p2-import-a', 'read')
    const slice = await read.read()
    await read.close()
    const blob = slice.events.map(x => JSON.stringify(x)).join('|')
    assert.ok(blob.includes('P2 写入验证'), 'user content must survive write + read-back')
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
    // the first copy is untouched: read-back still matches the original
    const read = await persistence.open('p2-dup', 'read')
    const slice = await read.read()
    await read.close()
    assert.equal(slice.events.length, candidate.events.length, 'refused re-import must not have appended anything')
  } finally {
    await unmount()
  }
})

test('P2 writer-a: preset mapping (D2) — kept, missing-custom-preset, applied to the written header', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { resolvePresetMapping, applyPresetMapping, STANDARD_PRESET } = await import('../lib/import/preset.js')
  const { persistence, unmount } = await mountTarget()
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    // installed target presets
    const available = ['standard', 'deepresearch']
    assert.deepEqual(resolvePresetMapping('standard', available), { sourcePreset: 'standard', targetPreset: 'standard', reason: 'kept' })
    assert.deepEqual(resolvePresetMapping('deepresearch', available), { sourcePreset: 'deepresearch', targetPreset: 'deepresearch', reason: 'kept' })
    const mapped = resolvePresetMapping('my-custom-preset', available)
    assert.deepEqual(mapped, { sourcePreset: 'my-custom-preset', targetPreset: 'standard', reason: 'missing-custom-preset' })
    // a candidate with the custom preset, mapped before import
    const candidate = await canonicalCandidate('p2-preset', { preset: 'my-custom-preset' })
    const written = applyPresetMapping(candidate.header, mapped)
    const result = await importSessionViaA(persistence, { ...candidate, header: written })
    assert.equal(result.steps.readback.ok, true)
    const read = await persistence.open('p2-preset', 'read')
    const header = read.header
    await read.close()
    assert.equal(header.agentPreset, STANDARD_PRESET, 'the written header must carry the MAPPED preset')
    // source preset list unavailable: mapping recorded honestly
    const unknown = resolvePresetMapping('my-custom-preset', null)
    assert.equal(unknown.reason, 'unavailable-presets-assumed-standard')
  } finally {
    await unmount()
  }
})

test('P2 writer-a: seeded session (inheritedEventCount) — create echo + end-seed marker verification', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { persistence, unmount } = await mountTarget()
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    const candidate = await canonicalCandidate('p2-inherited', { inheritedEventCount: 7 })
    assert.equal(candidate.header.isSeeded, true, 'fixture must be a seeded session')
    const result = await importSessionViaA(persistence, candidate)
    // The rc.4 read surface does NOT re-expose the inherited count — the
    // authoritative channels are the create-time handle echo and the
    // session/end-seed marker in the read-back events.
    assert.equal(result.steps.create.inheritedEventCount, 7, 'create must echo the requested inherited count')
    assert.equal(result.steps.readback.inheritedVerification.channel, 'create-echo+seed-marker')
    assert.equal(result.steps.readback.inheritedVerification.createEcho, 7)
    assert.equal(result.steps.readback.inheritedVerification.seedMarkerPresent, true)
    assert.equal(result.steps.readback.ok, true)
    assert.ok(
      result.readback.events.some(x => x.type === 'session/end-seed' && x.data?.inherited === true),
      'the end-seed marker must survive write + read-back',
    )
    assert.equal(result.readback.header.isSeeded, true)
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
