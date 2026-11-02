// P2 batch-2 acceptance: the G6 gate and the persistent journal on a REAL
// engine mounted on an ISOLATED throwaway root. Covers: pre-state capture
// (workspace unit + light session state + ownership non-existence proofs),
// the full import flow with journal states and ordered actions, reverse-order
// rollback through the target's real interfaces (workspace detach/delete,
// archive/pin restore, backend-specific session withdrawal), target-matches-
// snapshot verification, crash-recovery flags, and ownership conflicts.
// The session withdrawal adapter used here is the MEASURED jsonl mechanism
// (move the backend-located directory into the job's rollback area) — the
// SessionPersistence service itself has no delete.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, renameSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ImportJournal } from '../lib/import/journal.js'
import { captureTargetPreState, verifyTargetRestored, rollbackBatch } from '../lib/import/g6.js'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir

async function loadChain() {
  const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
  const req = createRequire(join(rc4Dir, 'noop.js'))
  await setModuleLoader(async () => ({
    cat: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href),
    v3: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
  }))
  return import('../lib/migration/legacy-chain.js')
}

// Mount the FULL target: storage hub -> json backend -> storage domain ->
// jsonl session persistence -> workspace registry, all on isolated roots.
async function mountTarget() {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
  const storagePkg = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage')).href)
  const storageJson = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-json')).href)
  const storageDomain = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-domain')).href)
  const workspacePkg = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-workspace')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const base = mkdtempSync(join(tmpdir(), 'g6-target-'))
  const ctx = new Context()
  // Cordis plugin mounting (not bare apply()): each package declares its
  // inject list, so the storage hub must be a resolved service before the
  // json backend and the domain facility initialize.
  await ctx.plugin(storagePkg.Storage, {})
  const storageRoot = join(base, 'storage')
  mkdirSync(storageRoot, { recursive: true })
  await ctx.plugin(storageJson, { root: storageRoot })
  await ctx.plugin(storageDomain, { backend: 'json' })
  const sessionsRoot = join(base, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  await ctx.plugin(jsonl, { root: sessionsRoot, compression: 'zstd' })
  await ctx.plugin(workspacePkg.WorkspaceRegistry)
  const persistence = ctx.sessionPersistence
  const workspaceRegistry = ctx.workspaceRegistry
  if (!persistence?.create) throw new Error('persistence unavailable')
  if (!workspaceRegistry?.list) throw new Error('workspaceRegistry unavailable')
  const fingerprintInput = `jsonl:${sessionsRoot}`
  return {
    ctx, persistence, workspaceRegistry, base, sessionsRoot,
    instanceFingerprint: fingerprintInput,
    locateDir(header) {
      const loc = persistence.locate(header)
      return relative(sessionsRoot, loc.path).split(sep).slice(0, -1).join('/')
    },
    async remount() {
      // A NEW context on the SAME roots — authoritative visibility check
      // (the jsonl backend memoizes in-instance observations).
      const ctx2 = new Context()
      await ctx2.plugin(storagePkg.Storage, {})
      await ctx2.plugin(storageJson, { root: storageRoot })
      await ctx2.plugin(storageDomain, { backend: 'json' })
      await ctx2.plugin(jsonl, { root: sessionsRoot, compression: 'zstd' })
      await ctx2.plugin(workspacePkg.WorkspaceRegistry)
      return { persistence: ctx2.sessionPersistence, workspaceRegistry: ctx2.workspaceRegistry, dispose: () => ctx2.fiber?.dispose?.() }
    },
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(base, { recursive: true, force: true })
    },
  }
}

async function canonicalCandidate(id, cwd, { preset = 'standard', seedCut = null } = {}) {
  const chain = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  const codec = v23.releasedV3SessionFormatCodec
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const logical = seedCut != null
    ? [
        e('turn/start', 0, { turn: 1 }),
        e('step/start', 1, { turn: 1, step: 1 }),
        e('session/end-seed', seedCut, { inherited: true }),
        e('user/message', seedCut + 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'G6 验证' }] }, { surfaceOp: 'append' }),
        e('step/end', seedCut + 2, { turn: 1, step: 1 }),
        e('turn/end', seedCut + 3, { turn: 1, reason: { kind: 'completed' } }),
      ]
    : [
        e('turn/start', 0, { turn: 1 }),
        e('user/message', 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'G6 验证' }] }, { surfaceOp: 'append' }),
        e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
      ]
  const physicalHeader = codec.encodeHeader(
    { version: 3, id, createdAt: 1793500000000, cwd, isSeeded: seedCut != null, delegationDepth: 0, agentPreset: preset },
    seedCut ?? 0,
  )
  const out = await chain.migrateToV4(physicalHeader, logical.map(ev => codec.encodeEvent(ev)), { childFacts: null })
  const cat = (await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)).sessionFormatCatalog
  const restore = cat.createRestore(out.headerRow, { recovery: 'strict', validation: 'current' })
  for (const row of out.eventRows) restore.decodeRow(row)
  const artifact = restore.finish()
  return { header: { ...artifact.header, agentPreset: preset }, events: artifact.events, inheritedEventCount: artifact.inheritedEventCount ?? 0 }
}

test('P2 G6: full flow — pre-state, ordered import, reverse rollback, target matches snapshot', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'g6-job-'))
  try {
    // Pre-populate: workspace W0 over a REAL directory + session S0 attached and pinned.
    const w0dir = join(t.base, 'w0dir')
    mkdirSync(w0dir, { recursive: true })
    const W0 = await t.workspaceRegistry.create(w0dir, '已有工作区')
    const s0 = await canonicalCandidate('g6-s0', w0dir)
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    await importSessionViaA(t.persistence, s0)
    await W0.attachSession('g6-s0')
    await t.workspaceRegistry.pinSession('g6-s0')

    // ---- G6 capture for a batch importing g6-s1.
    const binding = { instanceFingerprint: t.instanceFingerprint, sourceDigest: 'src-digest-1' }
    const journal = new ImportJournal(join(jobDir, 'journal.json'), binding)
    journal.transitionBatch('PLANNED')
    // the session entry already starts in 'planned' — no redundant transition
    const snapshot = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['g6-s1'],
    })
    assert.equal(snapshot.sessions['g6-s1'].exists, false, 'pre-existence proof')
    assert.ok(snapshot.workspaces.some(w => w.id === W0.id && w.sessionIds.includes('g6-s0')))
    assert.ok(snapshot.pinnedSessionIds.includes('g6-s0'))
    journal.transitionBatch('SNAPSHOT_READY')
    journal.session('g6-s1', 'snapshot-ready')

    // ---- IMPORTING: the batch creates W1, imports s1 (cwd = W1's real
    // directory — attach requires the header cwd to resolve to the workspace
    // path), then attaches — every ownership action recorded IN ORDER.
    journal.transitionBatch('IMPORTING')
    const w1dir = join(t.base, 'w1dir')
    mkdirSync(w1dir, { recursive: true })
    const W1 = await t.workspaceRegistry.create(w1dir, '本批工作区')
    journal.action({ type: 'workspace.create', workspaceId: W1.id })
    journal.session('g6-s1', 'writing')
    const s1 = await canonicalCandidate('g6-s1', w1dir)
    const importResult = await importSessionViaA(t.persistence, s1)
    journal.action({ type: 'session.import', sessionId: 'g6-s1' })
    journal.session('g6-s1', 'readback-verified')
    await W1.attachSession('g6-s1')
    journal.action({ type: 'session.attach', workspaceId: W1.id, sessionId: 'g6-s1' })
    journal.session('g6-s1', 'attached')
    // confirm the batch is visible right now
    assert.ok((await t.persistence.stat('g6-s1')), 'batch session visible after import')

    // ---- failure simulation → ROLLING_BACK, compensate in REVERSE order.
    journal.transitionBatch('ROLLING_BACK')
    const rollbackDir = join(jobDir, 'rollback')
    mkdirSync(rollbackDir, { recursive: true })
    const withdrawSession = async (id) => {
      // MEASURED jsonl withdrawal: move the backend-located session
      // directory into the job's rollback area (recoverable, not deleted).
      const dir = t.locateDir({ cwd: s1.header.cwd, id })
      const dest = join(rollbackDir, `session-${id}`)
      try {
        renameSync(join(t.sessionsRoot, dir), dest)
      } catch (error) {
        if (error.code === 'EXDEV') cpSync(join(t.sessionsRoot, dir), dest, { recursive: true })
        else throw error
      }
    }
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot,
      plannedSessionIds: ['g6-s1'],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      withdrawSession,
    })
    assert.equal(rb.ok, true, `rollback verification must pass: ${JSON.stringify(rb.failures)} ${JSON.stringify(rb.verification.diffs)}`)
    // reverse order actually applied: detach before workspace delete
    assert.ok(rb.compensated.some(c => c.startsWith('session.attach:g6-s1')), `compensated: ${JSON.stringify(rb.compensated)}`)
    assert.ok(rb.compensated.some(c => c.startsWith('workspace.create')))
    assert.ok(rb.compensated.some(c => c.startsWith('session.import:g6-s1')))
    journal.transitionBatch('ROLLED_BACK')
    journal.session('g6-s1', 'rolled-back')

    // ---- authoritative visibility via a NEW context on the same roots.
    const fresh = await t.remount()
    try {
      const v = await verifyTargetRestored({
        persistence: fresh.persistence,
        workspaceRegistry: fresh.workspaceRegistry,
        snapshot,
        plannedSessionIds: ['g6-s1'],
      })
      assert.equal(v.ok, true, `fresh-instance verification: ${JSON.stringify(v.diffs)}`)
      // the pre-existing session survived untouched (visible + pinned workspace membership)
      assert.ok(await fresh.persistence.stat('g6-s0'), 'pre-existing session must survive the rollback')
      assert.ok(fresh.workspaceRegistry.archivedSessionIds.length === 0)
      assert.ok(fresh.workspaceRegistry.pinnedSessionIds.includes('g6-s0'))
      // the withdrawn session's payload is recoverable in the rollback area
      assert.ok(existsSync(join(rollbackDir, 'session-g6-s1')), 'withdrawn session kept recoverable, not deleted')
    } finally {
      await fresh.dispose()
    }
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 G6: ownership conflict — a planned id that already exists refuses the batch', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'g6-conf-'))
  try {
    const s0 = await canonicalCandidate('g6-c0', t.base)
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    await importSessionViaA(t.persistence, s0)
    await assert.rejects(
      () => captureTargetPreState({
        persistence: t.persistence,
        plannedSessionIds: ['g6-c0'],
      }),
      err => err.code === 'G6_OWNERSHIP_CONFLICT',
    )
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 journal: atomic persistence, crash-recovery flag, binding mismatch, illegal transitions', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'journal-'))
  try {
    const file = join(jobDir, 'j.json')
    const binding = { instanceFingerprint: 'inst-1', sourceDigest: 'src-1' }
    const j = new ImportJournal(file, binding)
    j.transitionBatch('PLANNED')
    j.transitionBatch('SNAPSHOT_READY')
    // a brand-new journal entry already starts in 'planned'
    j.transitionBatch('IMPORTING')
    j.action({ type: 'session.import', sessionId: 's1' })
    // reload from disk: crash state is flagged, binding matches
    const loaded = ImportJournal.load(file, binding)
    assert.ok(loaded, 'journal must persist to disk')
    assert.equal(loaded.state.recovered, true, 'IMPORTING without DONE must flag recovery')
    assert.equal(loaded.state.batchState, 'IMPORTING')
    assert.deepEqual(loaded.actionsReversed().map(a => a.type), ['session.import'])
    // illegal transitions refuse
    assert.throws(() => loaded.transitionBatch('DONE'), /illegal batch journal transition/)
    loaded.session('s1', 'committed') // planned -> committed is a legal fast-forward
    assert.throws(() => loaded.session('s1', 'committed'), /illegal session journal transition/) // committed is terminal
    // binding mismatch refuses replay
    assert.throws(
      () => ImportJournal.load(file, { instanceFingerprint: 'other', sourceDigest: 'src-1' }),
      err => err.code === 'JOURNAL_BINDING_MISMATCH',
    )
  } finally {
    rmSync(jobDir, { recursive: true, force: true })
  }
})
