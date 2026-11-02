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
    const fromDisk = ImportJournal.load(journal.file, binding)
    assert.throws(() => fromDisk.transitionBatch('IMPORTING'), /does not match its digest/, 'a tampered snapshot must refuse IMPORTING')
    // restore the correct snapshot (original journal still holds it) and proceed
    journal.setSnapshot(snapshot)
    journal.transitionBatch('IMPORTING')

    // ---- side effects as intent → effect → confirm(outcome) pairs.
    const w1dir = join(t.base, 'w1dir')
    mkdirSync(w1dir, { recursive: true })
    let seq = journal.intent({ type: 'workspace.create', workspaceId: null, workspacePath: w1dir })
    const W1 = await t.workspaceRegistry.create(w1dir, '本批工作区')
    journal.confirm(seq, { workspaceId: W1.id })
    journal.session('g6-s1', 'writing')
    const s1 = await canonicalCandidate('g6-s1', w1dir)
    seq = journal.intent({ type: 'session.import', sessionId: 'g6-s1' })
    const importResult = await importSessionViaA(t.persistence, s1)
    journal.confirm(seq, { revision: importResult.revision })
    journal.session('g6-s1', 'readback-verified')
    seq = journal.intent({ type: 'session.attach', workspaceId: W1.id, sessionId: 'g6-s1' })
    await W1.attachSession('g6-s1')
    journal.confirm(seq, {})
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
    journal.confirm(seq, {})
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
    assert.ok(rb.conflicts.some(c => /user archived this session after our unpin/.test(c.reason)), JSON.stringify(rb.conflicts))
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
