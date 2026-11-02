// P2 batch-2 acceptance (post-review): the G6 gate and the persistent journal
// on a REAL engine mounted on an ISOLATED throwaway root. This file covers
// the review's five findings:
//   1. load() never rewrites the disk journal (init/load separated; init
//      refuses an existing record).
//   2. real fsync/write/rename failures abort the transition and revert the
//      in-memory state — the previous valid record stays readable.
//   3. the G6 snapshot is persisted INTO the journal and digest-verified
//      before IMPORTING; side effects are intent→confirm pairs; commit is
//      gated on VERIFYING_TARGET + evidence + no open intents; a subprocess
//      crash at the intent boundary leaves a judgeable record.
//   4. rollback three-way protection: user-archive preservation, withdrawal
//      withheld when the session gained user content, wrong-ownership
//      actions never withdraw, unknown intents manual-judgment only.
//   5. verifyTargetRestored checks EVERY snapshot-known session — a vanished
//      pre-existing session can never yield a false "restored".
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, renameSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
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
  return {
    ctx, persistence, workspaceRegistry, base, sessionsRoot,
    instanceFingerprint: `jsonl:${sessionsRoot}`,
    locateDir(header) {
      const loc = persistence.locate(header)
      return relative(sessionsRoot, loc.path).split(sep).slice(0, -1).join('/')
    },
    async remount() {
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

test('P2 G6: full flow with intents/outcomes, reverse rollback, fresh-instance verification', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
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

    // ---- G6 capture, persisted INTO the journal; IMPORTING gated on it.
    const binding = { instanceFingerprint: t.instanceFingerprint, sourceDigest: 'src-digest-1' }
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), binding)
    journal.transitionBatch('PLANNED')
    const snapshot = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['g6-s1'],
    })
    journal.setSnapshot(snapshot)
    journal.transitionBatch('SNAPSHOT_READY')
    // tamper the DISK copy, then judge a freshly loaded journal: IMPORTING
    // must refuse because the persisted snapshot no longer matches its digest.
    const tampered = JSON.parse(readFileSync(journal.file, 'utf8'))
    tampered.snapshot.workspaces = []
    writeFileSync(journal.file, JSON.stringify(tampered))
    // A tampered snapshot now refuses at LOAD (full disk validation).
    assert.throws(() => ImportJournal.load(journal.file, binding), /does not match its digest/, 'a tampered snapshot must refuse to load')
    // restore the correct snapshot (in-process journal still holds it) and proceed
    journal.setSnapshot(snapshot)
    journal.transitionBatch('IMPORTING')

    // ---- side effects as intent → effect → confirm(outcome) pairs.
    const w1dir = join(t.base, 'w1dir')
    mkdirSync(w1dir, { recursive: true })
    let seq = journal.intent({ type: 'workspace.create', workspaceId: null, workspacePath: w1dir })
    const W1 = await t.workspaceRegistry.create(w1dir, '本批工作区')
    journal.confirm(seq, { workspaceId: W1.id, title: W1.title, path: W1.path })
    journal.session('g6-s1', 'writing')
    const s1 = await canonicalCandidate('g6-s1', w1dir)
    seq = journal.intent({ type: 'session.import', sessionId: 'g6-s1' })
    const importResult = await importSessionViaA(t.persistence, s1)
    journal.confirm(seq, { revision: importResult.revision })
    journal.session('g6-s1', 'readback-verified')
    seq = journal.intent({ type: 'session.attach', workspaceId: W1.id, sessionId: 'g6-s1' })
    await W1.attachSession('g6-s1')
    journal.confirm(seq, { title: W1.title, path: W1.path })
    journal.session('g6-s1', 'attached')
    assert.ok(await t.persistence.stat('g6-s1'), 'batch session visible after import')

    // ---- commit gating: before VERIFYING_TARGET it refuses.
    assert.throws(() => journal.session('g6-s1', 'committed'), /VERIFYING_TARGET/)
    journal.transitionBatch('VERIFYING_TARGET')
    journal.session('g6-s1', 'committed')

    // ---- failure simulation AFTER commit → whole-batch rollback.
    journal.transitionBatch('ROLLING_BACK')
    const rollbackDir = join(jobDir, 'rollback')
    mkdirSync(rollbackDir, { recursive: true })
    const withdrawSession = async (id) => {
      const dir = t.locateDir({ cwd: s1.header.cwd, id })
      const dest = join(rollbackDir, `session-${id}`)
      try {
        renameSync(join(t.sessionsRoot, dir), dest)
      } catch (error) {
        if (error.code === 'EXDEV') {
          cpSyncDir(join(t.sessionsRoot, dir), dest)
        } else throw error
      }
    }
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot,
      plannedSessionIds: ['g6-s1'],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      withdrawSession,
      journal,
      allowUnprotected: true,
    })
    assert.equal(rb.outcome, 'complete', `clean rollback must complete: ${JSON.stringify({ conflicts: rb.conflicts, failures: rb.failures, diffs: rb.verification.diffs })}`)
    assert.ok(rb.compensated.some(c => c.startsWith('session.attach:g6-s1')))
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
      assert.ok(await fresh.persistence.stat('g6-s0'), 'pre-existing session must survive the rollback')
      assert.ok(fresh.workspaceRegistry.pinnedSessionIds.includes('g6-s0'))
      assert.ok(existsSync(join(rollbackDir, 'session-g6-s1')), 'withdrawn session kept recoverable, not deleted')
    } finally {
      await fresh.dispose()
    }
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

function cpSyncDir(from, to) {
  // EXDEV fallback: copy + remove
  cpSync(from, to, { recursive: true })
}

test('P2 G6 §4a: user archive after our unpin is PRESERVED — pin not restored, outcome pending, conflict persisted', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'g6-pin-'))
  try {
    const w0dir = join(t.base, 'w0dir')
    mkdirSync(w0dir, { recursive: true })
    const W0 = await t.workspaceRegistry.create(w0dir, 'W0')
    const s0 = await canonicalCandidate('g6-pin-s0', w0dir)
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    await importSessionViaA(t.persistence, s0)
    await W0.attachSession('g6-pin-s0')
    // batch unpins the session (our flip, done+outcome)
    await t.workspaceRegistry.pinSession('g6-pin-s0')
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: t.instanceFingerprint, sourceDigest: 'src' })
    const snapshot = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['g6-pin-new'],
      relatedSessionIds: ['g6-pin-s0'],
    })
    journal.transitionBatch('PLANNED')
    journal.setSnapshot(snapshot)
    journal.transitionBatch('SNAPSHOT_READY')
    journal.transitionBatch('IMPORTING')
    const seq = journal.intent({ type: 'session.unpin', sessionId: 'g6-pin-s0' })
    await t.workspaceRegistry.unpinSession('g6-pin-s0')
    journal.confirm(seq, { membershipAfter: { pinned: false, archived: false } })
    // THE USER archives the session afterwards (concurrent operation)
    await t.workspaceRegistry.archiveSession('g6-pin-s0')
    // rollback: our pin restore must NOT undo the user's archive
    journal.transitionBatch('ROLLING_BACK')
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot,
      plannedSessionIds: ['g6-pin-new'],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      withdrawSession: async () => { throw new Error('withdraw must not be called for a pin-only batch') },
      journal,
    })
    assert.equal(rb.outcome, 'pending', `concurrent user archive must yield pending (got ${rb.outcome})`)
    assert.ok(rb.conflicts.some(c => /membership changed after our session\.unpin/.test(c.reason)), JSON.stringify(rb.conflicts))
    assert.ok(t.workspaceRegistry.archivedSessionIds.includes('g6-pin-s0'), 'the USER archive must be preserved')
    assert.ok(!t.workspaceRegistry.pinnedSessionIds.includes('g6-pin-s0'), 'must not re-pin over the user archive')
    assert.equal(journal.state.batchState, 'ROLLBACK_PENDING', 'pending must be persisted in the journal')
    assert.ok(journal.state.conflicts.length > 0, 'conflict reasons persisted')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 G6 §4b/§4c: withdrawal withheld for user-appended sessions; wrong-ownership actions never withdraw', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'g6-withdraw-'))
  try {
    // pre-existing session s0, attached to W0
    const w0dir = join(t.base, 'w0dir')
    mkdirSync(w0dir, { recursive: true })
    const W0 = await t.workspaceRegistry.create(w0dir, 'W0')
    const s0 = await canonicalCandidate('g6-s0', w0dir)
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    await importSessionViaA(t.persistence, s0)
    await W0.attachSession('g6-s0')

    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: t.instanceFingerprint, sourceDigest: 'src' })
    const snapshot = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['g6-s1'],
      relatedSessionIds: ['g6-s0'],
    })
    journal.transitionBatch('PLANNED')
    journal.setSnapshot(snapshot)
    journal.transitionBatch('SNAPSHOT_READY')
    journal.transitionBatch('IMPORTING')

    // §4b: batch imports s1 (intent → effect → confirm WITH revision), the
    // user then APPENDS to it → withdrawal must be withheld.
    let seq = journal.intent({ type: 'session.import', sessionId: 'g6-s1' })
    const s1 = await canonicalCandidate('g6-s1', t.base)
    const importResult = await importSessionViaA(t.persistence, s1)
    journal.confirm(seq, { revision: importResult.revision })
    const userWrite = await t.persistence.open('g6-s1', 'write')
    await userWrite.append([{ type: 'turn/start', seq: s1.events.length, time: 999, data: { turn: 2, user: true } }])
    await userWrite.flush()
    await userWrite.close()
    // §4c: a WRONG/stale action attributes an import of the PRE-EXISTING s0
    // to this batch (s0 is not in the ownership manifest).
    const badSeq = journal.intent({ type: 'session.import', sessionId: 'g6-s0' })
    journal.confirm(badSeq, { revision: 'fabricated' })

    journal.transitionBatch('ROLLING_BACK')
    let withdrawCalls = 0
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot,
      plannedSessionIds: ['g6-s1'],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      withdrawSession: async (id) => { withdrawCalls += 1 },
      journal,
      allowUnprotected: true,
    })
    assert.equal(rb.outcome, 'pending', `both conflicts must yield pending (got ${rb.outcome})`)
    assert.equal(withdrawCalls, 0, 'no session may be withdrawn under ownership/revision conflicts')
    assert.ok(rb.conflicts.some(c => /changed after our write/.test(c.reason)), JSON.stringify(rb.conflicts))
    assert.ok(rb.conflicts.some(c => /NOT in this batch ownership manifest/.test(c.reason)), JSON.stringify(rb.conflicts))
    assert.ok(await t.persistence.stat('g6-s1'), 'user-appended session PRESERVED')
    assert.ok(await t.persistence.stat('g6-s0'), 'wrong-ownership target PRESERVED')
    assert.equal(journal.state.batchState, 'ROLLBACK_PENDING')

    // §5: simulate a FOREIGN deletion of the pre-existing session — the
    // verification must flag the disappearance (never a false "restored").
    const dir = t.locateDir({ cwd: s0.header.cwd, id: 'g6-s0' })
    rmSync(join(t.sessionsRoot, dir), { recursive: true, force: true })
    const v = await verifyTargetRestored({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      snapshot,
      plannedSessionIds: ['g6-s1'],
    })
    assert.equal(v.ok, false, 'a vanished pre-existing session must fail the verification')
    assert.ok(v.diffs.some(d => /g6-s0 DISAPPEARED/.test(d)), JSON.stringify(v.diffs))
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 journal §1/§2/§3: init/load separation, fsync EIO aborts, snapshot gate, intent-before-effect, subprocess recovery', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'journal-'))
  try {
    const file = join(jobDir, 'j.json')
    const binding = { instanceFingerprint: 'inst-1', sourceDigest: 'src-1' }

    // §1: init refuses to overwrite an existing journal.
    const j = ImportJournal.init(file, binding)
    assert.throws(() => ImportJournal.init(file, binding), err => err.code === 'JOURNAL_ALREADY_EXISTS')
    j.transitionBatch('PLANNED')
    j.transitionBatch('SNAPSHOT_READY')
    j.intent({ type: 'session.import', sessionId: 's1' })

    // §1: load NEVER takes the persisting path — the disk record survives
    // two consecutive loads (the old bug turned it into an empty NEW job).
    const l1 = ImportJournal.load(file, binding)
    assert.equal(l1.state.batchState, 'SNAPSHOT_READY')
    assert.equal(l1.state.actions.length, 1)
    const l2 = ImportJournal.load(file, binding)
    assert.equal(l2.state.batchState, 'SNAPSHOT_READY', 'second load must still see the real record')
    assert.equal(l2.state.actions.length, 1, 'actions must survive repeated loads')
    const onDiskAfterLoads = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDiskAfterLoads.batchState, 'SNAPSHOT_READY')
    assert.equal(onDiskAfterLoads.actions.length, 1)
    // A restored NON-TERMINAL record must pass an explicit recovery check
    // before any mutation (conservative admission independent of any seal).
    assert.throws(() => l2.transitionBatch('IMPORTING'), err => err.code === 'JOURNAL_RECOVERY_REQUIRED')
    l2.acknowledgeRecovery()

    // §3 snapshot gate first: IMPORTING requires a persisted,
    // digest-verified snapshot.
    assert.throws(() => l2.transitionBatch('IMPORTING'), /requires a persisted G6 snapshot/)
    const snapshot = { workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], sessions: { s1: { exists: false } }, ownership: { plannedCreates: [{ id: 's1', preExisting: false }] }, digest: 'wrong' }
    l2.setSnapshot({ ...snapshot, digest: 'wrong' })
    assert.throws(() => l2.transitionBatch('IMPORTING'), /does not match its digest/, 'a wrong digest refuses')
    const { computeSnapshotDigest } = await import('../lib/import/g6.js')
    l2.setSnapshot({ ...snapshot, digest: computeSnapshotDigest(snapshot) })

    // §2: fsync EIO aborts the IMPORTING transition — in-memory state
    // reverts, the disk keeps the previous valid record.
    const realFsync = fs.fsyncSync
    fs.fsyncSync = () => { const e = new Error('injected EIO'); e.code = 'EIO'; throw e }
    let persistedFailureCaught = false
    try {
      l2.transitionBatch('IMPORTING') // gate passes, persist fails → must throw
    } catch (error) {
      persistedFailureCaught = true
      assert.match(error.message, /EIO|injected/)
    }
    assert.equal(persistedFailureCaught, true, 'real fsync failures must propagate')
    fs.fsyncSync = realFsync
    assert.equal(l2.state.batchState, 'SNAPSHOT_READY', 'in-memory state must revert on persistence failure')
    const afterEio = ImportJournal.load(file, binding)
    assert.equal(afterEio.state.batchState, 'SNAPSHOT_READY', 'the disk keeps the previous valid record')
    assert.equal(afterEio.state.actions.length, 1, 'actions survive a failed persistence attempt')
    afterEio.acknowledgeRecovery()
    afterEio.transitionBatch('IMPORTING')

    // §3: commit gates — session evidence, batch state, open intents.
    afterEio.session('s1', 'writing')
    afterEio.session('s1', 'readback-verified')
    // batch still IMPORTING → the batch gate fires first
    assert.throws(() => afterEio.session('s1', 'committed'), /VERIFYING_TARGET/)
    afterEio.transitionBatch('VERIFYING_TARGET')
    // NOW the still-open s1 import intent refuses the commit
    assert.throws(() => afterEio.session('s1', 'committed'), /unconfirmed action intents/)
    afterEio.confirm(1, { revision: 'r1' })
    // commit from readback-verified without an attach needs an explicit skip reason
    assert.throws(() => afterEio.session('s1', 'committed'), /skipReason/)
    afterEio.session('s1', 'committed', { skipReason: 'batch planned no workspace attachment for this session (verified)' })

    // §3: real subprocess crash at the INTENT boundary — the parent judges
    // from disk alone: intent present, no outcome, recovery flagged.
    const childFile = join(jobDir, 'child-journal.json')
    const libUrl = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'import', 'journal.js')).href
    const childScript = `
      const { ImportJournal } = await import(${JSON.stringify(libUrl)});
      const j = ImportJournal.init(${JSON.stringify(childFile)}, { instanceFingerprint: 'inst-2', sourceDigest: 'src-2' });
      j.transitionBatch('PLANNED');
      j.intent({ type: 'session.import', sessionId: 'child-s' });
      process.exit(0); // crash BEFORE confirm
    `
    const { spawnSync } = await import('node:child_process')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(res.status, 0, `subprocess exited cleanly (stderr: ${String(res.stderr).slice(0, 200)})`)
    const childLoaded = ImportJournal.load(childFile, { instanceFingerprint: 'inst-2', sourceDigest: 'src-2' })
    assert.equal(childLoaded.recovered, true, 'a mid-import journal flags recovery')
    const open = childLoaded.state.actions.find(a => a.sessionId === 'child-s')
    assert.equal(open?.stage, 'intent', 'the intent survived the crash WITHOUT its outcome — result unknown')
  } finally {
    rmSync(jobDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// R1–R5 review counterexamples (p2-5bbf121-review).
// ---------------------------------------------------------------------------

test('P2 R1: post-replace directory fsync failure seals the journal as durability-unknown — disk state adopted, no silent revert', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'r1-dur-'))
  try {
    const file = join(jobDir, 'j.json')
    const binding = { instanceFingerprint: 'inst-r1', sourceDigest: 'src-r1' }
    const j = ImportJournal.init(file, binding)
    j.transitionBatch('PLANNED')
    const realFsync = fs.fsyncSync
    let calls = 0
    fs.fsyncSync = fd => {
      calls += 1
      // call 1 = file content; call 2 = directory entry (post-rename). Only
      // the FIRST directory sync fails (transient EIO) — the seal record
      // itself must then be persisting normally.
      if (calls === 2) { const e = new Error('injected directory EIO'); e.code = 'EIO'; throw e }
      return realFsync(fd)
    }
    let caught = null
    try {
      j.transitionBatch('SNAPSHOT_READY')
    } catch (error) {
      caught = error
    } finally {
      fs.fsyncSync = realFsync
    }
    assert.ok(caught, 'the post-replace failure must surface')
    assert.equal(caught.code, 'JOURNAL_DURABILITY_UNKNOWN', `got ${caught.code}: ${caught.message}`)
    // The rename landed: memory must ADOPT the disk state, not pretend NEW.
    assert.equal(j.state.batchState, 'SNAPSHOT_READY', 'memory must adopt the state that is actually on disk')
    assert.ok(j.durabilityUnknown, 'the journal records the durability gap')
    // Further transitions are sealed until an explicit re-check.
    assert.throws(() => j.transitionBatch('IMPORTING'), err => err.code === 'JOURNAL_DURABILITY_UNKNOWN')
    // A fresh process sees the same sealed record.
    const reloaded = ImportJournal.load(file, binding)
    assert.equal(reloaded.state.batchState, 'SNAPSHOT_READY')
    assert.ok(reloaded.durabilityUnknown, 'the seal survives a reload')
    // Explicit resolution re-reads the disk and clears the seal.
    reloaded.resolveDurabilityUnknown()
    assert.equal(reloaded.durabilityUnknown, null)
    reloaded.transitionBatch('FAILED')
  } finally {
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 R2: DONE requires committed sessions, no open intents and recorded verification; failed rollback persists its verdict', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'r2-done-'))
  try {
    const file = join(jobDir, 'j.json')
    const binding = { instanceFingerprint: 'inst-r2', sourceDigest: 'src-r2' }
    const { computeSnapshotDigest } = await import('../lib/import/g6.js')
    const snap = { workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], sessions: { s1: { exists: false } }, ownership: { plannedCreates: [{ id: 's1', preExisting: false }] } }
    snap.digest = computeSnapshotDigest(snap)
    const j = ImportJournal.init(file, binding)
    j.transitionBatch('PLANNED')
    j.setSnapshot(snap)
    j.transitionBatch('SNAPSHOT_READY')
    j.transitionBatch('IMPORTING')
    const seq = j.intent({ type: 'session.import', sessionId: 's1' })
    j.session('s1', 'writing')
    j.transitionBatch('VERIFYING_TARGET')
    // session still writing → DONE refused
    assert.throws(() => j.transitionBatch('DONE'), /not committed/)
    j.session('s1', 'readback-verified')
    j.confirm(seq, { revision: 'r1' })
    j.session('s1', 'committed', { skipReason: 'test batch plans no attachment (verified)' })
    // committed but no recorded verification → DONE refused
    assert.throws(() => j.transitionBatch('DONE'), /recorded successful target verification/)
    j.recordVerification({ ok: true, diffs: [] })
    j.transitionBatch('DONE')

    // ---- failed rollback branch: the verdict is PERSISTED, not just returned.
    const file2 = join(jobDir, 'j2.json')
    const snap2 = { workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], sessions: { x: { exists: false } }, ownership: { plannedCreates: [{ id: 'x', preExisting: false }] } }
    snap2.digest = computeSnapshotDigest(snap2)
    const j2 = ImportJournal.init(file2, binding)
    j2.transitionBatch('PLANNED')
    j2.setSnapshot(snap2)
    j2.transitionBatch('SNAPSHOT_READY')
    j2.transitionBatch('IMPORTING')
    const s2 = j2.intent({ type: 'session.import', sessionId: 'x' })
    j2.confirm(s2, { revision: 'rX' })
    j2.transitionBatch('ROLLING_BACK')
    const fakePersistence = {
      stat: async () => ({ revision: 'rX' }),
      open: async () => ({ close: async () => {} }),
    }
    const rb = await rollbackBatch({
      actions: j2.actionsReversed(),
      snapshot: snap2,
      plannedSessionIds: ['x'],
      persistence: fakePersistence,
      withdrawSession: async () => { const e = new Error('injected withdraw EIO'); e.code = 'EIO'; throw e },
      journal: j2,
      allowUnprotected: true,
    })
    assert.equal(rb.outcome, 'failed')
    assert.equal(j2.state.batchState, 'ROLLBACK_PENDING', 'a failed compensation stays resumable')
    const reloaded = ImportJournal.load(file2, binding)
    assert.equal(reloaded.state.rollback?.outcome, 'failed')
    assert.ok((reloaded.state.rollback?.failures ?? []).length > 0, 'failure reasons persisted for a restart to judge')
    assert.equal(reloaded.recovered, true)
  } finally {
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 R3: membership compensation restores the WHOLE before-state (unpin→pin, archive→unarchive+pin) and preserves later user pins', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { importSessionViaA } = await import('../lib/import/writer-a.js')
  const runCase = async (setup, batchAction, between, expect) => {
    const t = await mountTarget()
    const jobDir = mkdtempSync(join(tmpdir(), 'r3-memb-'))
    try {
      const wdir = join(t.base, 'w')
      mkdirSync(wdir, { recursive: true })
      const W = await t.workspaceRegistry.create(wdir, 'W')
      const s = await canonicalCandidate('r3-s', wdir)
      await importSessionViaA(t.persistence, s)
      await W.attachSession('r3-s')
      await setup(t)
      const journal = ImportJournal.init(join(jobDir, 'j.json'), { instanceFingerprint: t.instanceFingerprint, sourceDigest: 'src' })
      const snapshot = await captureTargetPreState({ persistence: t.persistence, workspaceRegistry: t.workspaceRegistry, plannedSessionIds: ['r3-new'], relatedSessionIds: ['r3-s'] })
      journal.transitionBatch('PLANNED')
      journal.setSnapshot(snapshot)
      journal.transitionBatch('SNAPSHOT_READY')
      journal.transitionBatch('IMPORTING')
      const seq = journal.intent({ type: batchAction, sessionId: 'r3-s' })
      if (batchAction === 'session.unpin') await t.workspaceRegistry.unpinSession('r3-s')
      else if (batchAction === 'session.archive') await t.workspaceRegistry.archiveSession('r3-s')
      else if (batchAction === 'session.unarchive') await t.workspaceRegistry.unarchiveSession('r3-s')
      else throw new Error(`unsupported batch action ${batchAction}`)
      const after = { pinned: t.workspaceRegistry.pinnedSessionIds.includes('r3-s'), archived: t.workspaceRegistry.archivedSessionIds.includes('r3-s') }
      journal.confirm(seq, { membershipAfter: after })
      if (between) await between(t)
      journal.transitionBatch('ROLLING_BACK')
      const rb = await rollbackBatch({ actions: journal.actionsReversed(), snapshot, plannedSessionIds: ['r3-new'], workspaceRegistry: t.workspaceRegistry, persistence: t.persistence, withdrawSession: async () => {}, journal })
      expect(rb, t)
    } finally {
      await t.unmount()
      rmSync(jobDir, { recursive: true, force: true })
    }
  }

  // case 1: pinned before → batch unpin → rollback restores the pin, complete
  await runCase(
    async t => { await t.workspaceRegistry.pinSession('r3-s') },
    'session.unpin',
    null,
    (rb, t) => {
      assert.equal(rb.outcome, 'complete', JSON.stringify(rb.conflicts))
      assert.ok(rb.compensated.some(c => c.startsWith('session.unpin:r3-s')), JSON.stringify(rb.compensated))
      assert.ok(t.workspaceRegistry.pinnedSessionIds.includes('r3-s'), 'the original pin must be RESTORED (old code skipped it)')
    },
  )

  // case 2: pinned before → batch archive (registry drops the pin) → rollback
  // restores archive=false AND pin=true
  await runCase(
    async t => { await t.workspaceRegistry.pinSession('r3-s') },
    'session.archive',
    null,
    (rb, t) => {
      assert.equal(rb.outcome, 'complete', JSON.stringify(rb.conflicts))
      assert.ok(!t.workspaceRegistry.archivedSessionIds.includes('r3-s'), 'archive must be reverted')
      assert.ok(t.workspaceRegistry.pinnedSessionIds.includes('r3-s'), 'the pin removed by OUR archive must be restored')
    },
  )

  // case 3: archived before → batch unarchive → USER pins → rollback keeps
  // the user pin and stays pending (never re-archives over it)
  await runCase(
    async t => { await t.workspaceRegistry.archiveSession('r3-s') },
    'session.unarchive',
    async t => { await t.workspaceRegistry.pinSession('r3-s') },
    (rb, t) => {
      assert.equal(rb.outcome, 'pending', 'a later user pin yields pending')
      assert.ok(rb.conflicts.some(c => /membership changed after our session\.unarchive/.test(c.reason)), JSON.stringify(rb.conflicts))
      assert.ok(t.workspaceRegistry.pinnedSessionIds.includes('r3-s'), 'the USER pin must be preserved')
      assert.ok(!t.workspaceRegistry.archivedSessionIds.includes('r3-s'), 'must not re-archive over the user pin')
    },
  )
})

test('P2 R4: a user-edited title on this batch\'s new workspace preserves the registration (pending, not complete)', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'r4-title-'))
  try {
    const journal = ImportJournal.init(join(jobDir, 'j.json'), { instanceFingerprint: t.instanceFingerprint, sourceDigest: 'src' })
    const snapshot = await captureTargetPreState({ persistence: t.persistence, workspaceRegistry: t.workspaceRegistry, plannedSessionIds: ['r4-new'] })
    journal.transitionBatch('PLANNED')
    journal.setSnapshot(snapshot)
    journal.transitionBatch('SNAPSHOT_READY')
    journal.transitionBatch('IMPORTING')
    const wdir = join(t.base, 'r4-w')
    mkdirSync(wdir, { recursive: true })
    const seq = journal.intent({ type: 'workspace.create', workspaceId: null })
    const W = await t.workspaceRegistry.create(wdir, '批建标题')
    journal.confirm(seq, { workspaceId: W.id, title: W.title, path: W.path })
    // the USER renames it afterwards
    await W.setTitle('用户改的标题')
    journal.transitionBatch('ROLLING_BACK')
    const rb = await rollbackBatch({ actions: journal.actionsReversed(), snapshot, plannedSessionIds: ['r4-new'], workspaceRegistry: t.workspaceRegistry, persistence: t.persistence, withdrawSession: async () => {}, journal })
    assert.equal(rb.outcome, 'pending', `user title change must yield pending (got ${rb.outcome})`)
    assert.ok(rb.conflicts.some(c => /workspace title changed after our creation/.test(c.reason)), JSON.stringify(rb.conflicts))
    const still = t.workspaceRegistry.get(W.id)
    assert.ok(still, 'the user-renamed registration must be preserved')
    assert.equal(still.title, '用户改的标题')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 R5: an active write owner blocks withdrawal even when the revision is unchanged; a freed session withdraws normally', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'r5-owner-'))
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    const journal = ImportJournal.init(join(jobDir, 'j.json'), { instanceFingerprint: t.instanceFingerprint, sourceDigest: 'src' })
    const snapshot = await captureTargetPreState({ persistence: t.persistence, workspaceRegistry: t.workspaceRegistry, plannedSessionIds: ['r5-s'] })
    journal.transitionBatch('PLANNED')
    journal.setSnapshot(snapshot)
    journal.transitionBatch('SNAPSHOT_READY')
    journal.transitionBatch('IMPORTING')
    const seq = journal.intent({ type: 'session.import', sessionId: 'r5-s' })
    const s = await canonicalCandidate('r5-s', t.base)
    const imported = await importSessionViaA(t.persistence, s)
    journal.confirm(seq, { revision: imported.revision })
    // a USER opens the session for writing and holds the handle (no append →
    // revision unchanged)
    const userHandle = await t.persistence.open('r5-s', 'write')
    journal.transitionBatch('ROLLING_BACK')
    let withdrawCalls = 0
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot,
      plannedSessionIds: ['r5-s'],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      withdrawSession: async () => { withdrawCalls += 1 },
      journal,
      allowUnprotected: true,
    })
    assert.equal(rb.outcome, 'pending', `an active owner must yield pending (got ${rb.outcome})`)
    assert.equal(withdrawCalls, 0, 'withdrawal must not run while a write owner holds the session')
    assert.ok(rb.conflicts.some(c => /active write owner/.test(c.reason)), JSON.stringify(rb.conflicts))
    assert.ok(await t.persistence.stat('r5-s'), 'the session stays visible')
    // the user finishes; a re-run of the rollback may now withdraw safely
    await userHandle.close()
    const rb2 = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot,
      plannedSessionIds: ['r5-s'],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      withdrawSession: async id => { withdrawCalls += 1; const dir = t.locateDir({ cwd: s.header.cwd, id }); rmSync(join(t.sessionsRoot, dir), { recursive: true, force: true }) },
      journal,
      allowUnprotected: true,
    })
    assert.equal(rb2.outcome, 'complete', JSON.stringify({ conflicts: rb2.conflicts, diffs: rb2.verification.diffs }))
    assert.equal(withdrawCalls, 1)
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// W1–W3 (p2-46eb1a6 review).
// ---------------------------------------------------------------------------

test('P2 W1: a NEW PROCESS refuses to advance a restored non-terminal journal — even when the seal write itself failed (double EIO); ack validates the full binding', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'w1-seal-'))
  try {
    const file = join(jobDir, 'j.json')
    const binding = { instanceFingerprint: 'inst-w1', sourceDigest: 'src-w1' }
    const j = ImportJournal.init(file, binding)
    j.transitionBatch('PLANNED')
    const realFsync = fs.fsyncSync
    let fsyncCalls = 0
    // Ordering per the review: content fsync OK + rename OK; directory fsync
    // EIO; then the SEAL record's own file fsync fails too (its rename never
    // happens) — the disk keeps the new record with NO seal marker.
    fs.fsyncSync = fd => {
      fsyncCalls += 1
      if (fsyncCalls === 2 || fsyncCalls >= 3) { const e = new Error('injected EIO'); e.code = 'EIO'; throw e }
      return realFsync(fd)
    }
    let caught = null
    try { j.transitionBatch('SNAPSHOT_READY') } catch (error) { caught = error } finally { fs.fsyncSync = realFsync }
    assert.equal(caught?.code, 'JOURNAL_DURABILITY_UNKNOWN')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.batchState, 'SNAPSHOT_READY')
    assert.equal(raw.durabilityUnknown, undefined, 'the seal write failed — no marker on disk (the hard case)')

    // A REAL new process must still refuse to advance: the recovery
    // requirement comes from the durable state, not from the failed marker.
    const libUrl = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'import', 'journal.js')).href
    const script = `
      const { ImportJournal } = await import(${JSON.stringify(libUrl)});
      const j = ImportJournal.load(${JSON.stringify(file)}, ${JSON.stringify(binding)});
      let code = null;
      try { j.transitionBatch('FAILED'); } catch (e) { code = e.code; }
      process.stdout.write(JSON.stringify({ loadedState: j.state.batchState, refusedWith: code }));
    `
    const { spawnSync } = await import('node:child_process')
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(res.status, 0, String(res.stderr).slice(0, 300))
    const child = JSON.parse(res.stdout)
    assert.equal(child.loadedState, 'SNAPSHOT_READY')
    assert.equal(child.refusedWith, 'JOURNAL_RECOVERY_REQUIRED', 'a new process must not advance without a recovery check')

    // ack refuses a different source digest (no rebinding through recovery).
    const reloaded = ImportJournal.load(file, binding)
    const swapped = JSON.parse(readFileSync(file, 'utf8'))
    swapped.binding = { instanceFingerprint: binding.instanceFingerprint, sourceDigest: 'different-source' }
    writeFileSync(file, JSON.stringify(swapped))
    assert.throws(() => reloaded.acknowledgeRecovery(), err => err.code === 'JOURNAL_BINDING_MISMATCH')
    // restore the original binding and verify the explicit ack works.
    const original = JSON.parse(readFileSync(file, 'utf8'))
    original.binding = binding
    writeFileSync(file, JSON.stringify(original))
    const ok = ImportJournal.load(file, binding)
    ok.acknowledgeRecovery()
    ok.transitionBatch('FAILED')
  } finally {
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 W2: DONE checks the COMPLETE persisted plan — a planned id with no state entry blocks DONE; explicit exclusions yield PARTIAL', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'w2-plan-'))
  try {
    const { computeSnapshotDigest } = await import('../lib/import/g6.js')
    const binding = { instanceFingerprint: 'inst-w2', sourceDigest: 'src-w2' }
    const make = name => {
      const snap = {
        workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [],
        sessions: { 'planned-a': { exists: false }, 'planned-b': { exists: false } },
        ownership: { plannedCreates: [{ id: 'planned-a', preExisting: false }, { id: 'planned-b', preExisting: false }] },
      }
      snap.digest = computeSnapshotDigest(snap)
      const j = ImportJournal.init(join(jobDir, name), binding)
      j.transitionBatch('PLANNED')
      j.setSnapshot(snap)
      j.transitionBatch('SNAPSHOT_READY')
      j.transitionBatch('IMPORTING')
      return j
    }
    // evidence phases first; committing is judged in VERIFYING_TARGET
    const verifyA = j => {
      const seq = j.intent({ type: 'session.import', sessionId: 'planned-a' })
      j.session('planned-a', 'writing')
      j.session('planned-a', 'readback-verified')
      j.confirm(seq, { revision: 'rA' })
    }
    const commitA = j => j.session('planned-a', 'committed', { skipReason: 'no attachment planned (verified)' })

    const j1 = make('j1.json')
    verifyA(j1)
    j1.transitionBatch('VERIFYING_TARGET')
    commitA(j1)
    j1.recordVerification({ ok: true, diffs: [] })
    assert.throws(() => j1.transitionBatch('DONE'), /planned sessions not committed: planned-b/)

    j1.session('planned-b', 'writing')
    j1.session('planned-b', 'readback-verified')
    j1.session('planned-b', 'committed', { skipReason: 'no attachment planned (verified)' })
    j1.transitionBatch('DONE')
    assert.equal(j1.state.outcome, 'DONE')

    const j2 = make('j2.json')
    verifyA(j2)
    j2.recordPartial([{ id: 'planned-b', reason: 'source child evidence unavailable (declared missing)' }])
    j2.transitionBatch('VERIFYING_TARGET')
    commitA(j2)
    j2.recordVerification({ ok: true, diffs: [] })
    j2.transitionBatch('DONE')
    assert.equal(j2.state.outcome, 'PARTIAL', 'an excluded planned session must not read as a full success')
    assert.equal(j2.state.partialExcluded.length, 1)
    const j3 = make('j3.json')
    assert.throws(() => j3.recordPartial([{ id: 'planned-b' }]), /reason/)
  } finally {
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 W3: multiple membership actions on one session compensate as ONE group — no false user-change conflict; real user change still pending', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const { importSessionViaA } = await import('../lib/import/writer-a.js')
  const run = async userChange => {
    const t = await mountTarget()
    const jobDir = mkdtempSync(join(tmpdir(), 'w3-multi-'))
    const wdir = join(t.base, 'w')
    mkdirSync(wdir, { recursive: true })
    const W = await t.workspaceRegistry.create(wdir, 'W')
    const s = await canonicalCandidate('w3-s', wdir)
    await importSessionViaA(t.persistence, s)
    await W.attachSession('w3-s')
    await t.workspaceRegistry.pinSession('w3-s')
    const journal = ImportJournal.init(join(jobDir, 'j.json'), { instanceFingerprint: t.instanceFingerprint, sourceDigest: 'src' })
    const snapshot = await captureTargetPreState({ persistence: t.persistence, workspaceRegistry: t.workspaceRegistry, plannedSessionIds: ['w3-new'], relatedSessionIds: ['w3-s'] })
    journal.transitionBatch('PLANNED')
    journal.setSnapshot(snapshot)
    journal.transitionBatch('SNAPSHOT_READY')
    journal.transitionBatch('IMPORTING')
    const s1 = journal.intent({ type: 'session.unpin', sessionId: 'w3-s' })
    await t.workspaceRegistry.unpinSession('w3-s')
    journal.confirm(s1, { membershipAfter: { pinned: false, archived: false } })
    const s2 = journal.intent({ type: 'session.archive', sessionId: 'w3-s' })
    await t.workspaceRegistry.archiveSession('w3-s')
    journal.confirm(s2, { membershipAfter: { pinned: false, archived: true } })
    if (userChange) await userChange(t)
    journal.transitionBatch('ROLLING_BACK')
    let withdrawCalls = 0
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot,
      plannedSessionIds: ['w3-new'],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      withdrawSession: async () => { withdrawCalls += 1 },
      journal,
    })
    return { rb, t, withdrawCalls, journal, jobDir }
  }

  const clean = await run(null)
  try {
    assert.equal(clean.rb.outcome, 'complete', JSON.stringify(clean.rb.conflicts))
    assert.ok(clean.rb.compensated.some(c => c.startsWith('session.unpin:w3-s')), JSON.stringify(clean.rb.compensated))
    assert.ok(clean.rb.compensated.some(c => c.startsWith('session.archive:w3-s')), JSON.stringify(clean.rb.compensated))
    assert.ok(clean.t.workspaceRegistry.pinnedSessionIds.includes('w3-s'), 'pre-batch pin restored')
    assert.ok(!clean.t.workspaceRegistry.archivedSessionIds.includes('w3-s'), 'pre-batch archive state restored')
    assert.equal(clean.rb.conflicts.length, 0, 'our own restore must never be reported as a user conflict')
  } finally {
    await clean.t.unmount()
    rmSync(clean.jobDir, { recursive: true, force: true })
  }

  // a genuine, OBSERVABLE user change after our last action: the user
  // unarchives the session themselves.
  const dirty = await run(async t => { await t.workspaceRegistry.unarchiveSession('w3-s') })
  try {
    assert.equal(dirty.rb.outcome, 'pending')
    assert.ok(dirty.rb.conflicts.some(c => /membership changed after our session\.archive/.test(c.reason)), JSON.stringify(dirty.rb.conflicts))
    assert.ok(!dirty.t.workspaceRegistry.archivedSessionIds.includes('w3-s'), 'the user unarchive must be preserved')
    assert.ok(!dirty.t.workspaceRegistry.pinnedSessionIds.includes('w3-s'), 'no pin is re-applied over the user change')
  } finally {
    await dirty.t.unmount()
    rmSync(dirty.jobDir, { recursive: true, force: true })
  }
})

function cpSync(from, to, _opts) {
  // EXDEV fallback: recursive copy (caller removes the source afterwards)
  const st = existsSync(from)
  if (!st) throw new Error(`source missing: ${from}`)
  mkdirSync(to, { recursive: true })
  for (const name of fs.readdirSync(from)) {
    const src = join(from, name)
    const dst = join(to, name)
    if (fs.statSync(src).isDirectory()) cpSync(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

test('P2 fallback policy: an UNPROTECTED withdrawal adapter is refused by default (isolated labs opt in explicitly)', async () => {
  const snapshot = { workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], sessions: { x: { exists: false } }, ownership: { plannedCreates: [{ id: 'x', preExisting: false }] } }
  const actions = [{ seq: 1, stage: 'done', type: 'session.import', sessionId: 'x', outcome: { revision: 'r1' } }]
  const persistence = { stat: async () => ({ revision: 'r1' }), open: async () => ({ close: async () => {} }) }
  let calls = 0
  const plain = async () => { calls += 1 }
  const refused = await rollbackBatch({ actions, snapshot, plannedSessionIds: ['x'], persistence, withdrawSession: plain })
  assert.equal(calls, 0, 'production mode must not call an unprotected adapter')
  assert.ok(refused.conflicts.some(c => /unprotected withdrawal adapter/.test(c.reason)), JSON.stringify(refused.conflicts))
  // explicit isolated-lab opt-in keeps the probe path available
  const lab = await rollbackBatch({ actions, snapshot, plannedSessionIds: ['x'], persistence, withdrawSession: plain, allowUnprotected: true })
  assert.equal(calls, 1)
  void lab
})
