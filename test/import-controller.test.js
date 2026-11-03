// P3 controller acceptance: the REAL backup drives the unified A job through
// the product controller (source → preview → approved plan → runImportJob),
// then re-imports and re-checks a DONE journal. Isolated engine target; the
// real backup is read-only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createMigrationController } from '../lib/import/controller.js'
import { buildPlan, freezePlan } from '../lib/import/plan.js'
import { ImportJournal } from '../lib/import/journal.js'

const rc4Dir = process.env.RC4_MODULES
const realBackup = process.env.DSHA_V5_REAL
const skip = !rc4Dir || !realBackup

async function mountEngine(base) {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const imp = async name => import(pathToFileURL(req.resolve(name)).href)
  const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
  await setModuleLoader(async () => ({
    cat: await imp('@deepseek-ai/dsh-session-format-catalog'),
    v3: await imp('@deepseek-ai/dsh-session-format-v3-to-v4'),
  }))
  const jsonl = await imp('@deepseek-ai/dsh-session-persistence-jsonl')
  const storagePkg = await imp('@deepseek-ai/dsh-storage')
  const storageJson = await imp('@deepseek-ai/dsh-storage-json')
  const storageDomain = await imp('@deepseek-ai/dsh-storage-domain')
  const workspacePkg = await imp('@deepseek-ai/dsh-workspace')
  const attachmentLocal = await imp('@deepseek-ai/dsh-attachment-local')
  const { Context } = await imp('@deepseek-ai/cordis')
  const storageRoot = join(base, 'storage')
  const dshHome = join(base, 'dshhome')
  const sessionsRoot = join(base, 'sessions')
  mkdirSync(storageRoot, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(sessionsRoot, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(storagePkg.Storage, {})
  await ctx.plugin(storageJson, { root: storageRoot })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(jsonl, { root: sessionsRoot, compression: 'zstd' })
  await ctx.plugin(workspacePkg.WorkspaceRegistry)
  await ctx.plugin(attachmentLocal.default, { dshHome })
  // Materialize the workspace unit before G6 captures it.
  const seedWorkspace = join(base, 'seed-workspace')
  mkdirSync(seedWorkspace, { recursive: true })
  await ctx.workspaceRegistry.create(seedWorkspace, 'seed')
  return {
    base,
    storageRoot,
    dshHome,
    sessionsRoot,
    persistence: ctx.sessionPersistence,
    workspaceRegistry: ctx.workspaceRegistry,
    attachments: ctx.attachments,
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
    },
  }
}

function presetStub() {
  return {
    defaultId: 'standard',
    async list() { return [{ id: 'standard', name: 'Standard' }, { id: 'deepseek', name: 'DeepSeek' }] },
  }
}

test('P3 controller: real backup → preview → approved plan → DONE → repeat re-check', { skip: skip ? 'DSHA_V5_REAL or RC4_MODULES not set' : false }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'p3-controller-'))
  const engine = await mountEngine(base)
  const dataRoot = join(base, 'migrator-data')
  const oldData = process.env.DSHA_MIGRATOR_DATA_DIR
  const oldStorage = process.env.DSHA_MIGRATOR_STORAGE_ROOT
  const oldWorkspaceRoot = process.env.DSH_WORKSPACE_ROOT
  const workspaceRoot = join(base, 'workspace-root')
  mkdirSync(workspaceRoot, { recursive: true })
  process.env.DSHA_MIGRATOR_DATA_DIR = dataRoot
  process.env.DSHA_MIGRATOR_STORAGE_ROOT = engine.storageRoot
  process.env.DSH_WORKSPACE_ROOT = workspaceRoot
  const controller = createMigrationController()
  try {
    controller.setServices({
      sessionPersistence: engine.persistence,
      workspaceRegistry: engine.workspaceRegistry,
      attachments: engine.attachments,
      agentPresets: presetStub(),
    })
    await controller.preparePath(realBackup)
    let snap = controller.snapshot()
    assert.equal(snap.phase, 'preview', JSON.stringify(snap))
    assert.equal(snap.sessions.length, 2, 'the real backup exposes two importable sessions')
    assert.deepEqual(snap.sessions.map(s => s.events).sort((a, b) => a - b), [454, 596])
    assert.equal(snap.selectedCount, 2)
    assert.equal(snap.canApprove, true, JSON.stringify(snap.blockedReasons))
    assert.ok(snap.targetWorkspace?.title, 'a dedicated target workspace is planned')
    for (const session of snap.sessions) {
      assert.equal(session.presetTarget, 'standard')
      assert.equal(session.presetWritable, true)
      assert.ok(['kept', 'missing-custom-preset', 'absent-source-preset'].includes(session.presetReason), session.presetReason)
    }

    await controller.approve()
    snap = controller.snapshot()
    assert.equal(snap.phase, 'approved')
    assert.match(snap.planDigest, /^[a-f0-9]{64}$/)
    assert.equal(snap.canStart, true)

    await controller.start()
    snap = controller.snapshot()
    assert.equal(snap.phase, 'done', JSON.stringify(snap))
    assert.equal(snap.result?.status, 'DONE')
    assert.equal(snap.result?.verificationOk, true)
    assert.equal(snap.result?.attachments?.published, 0)

    const ids = snap.sessions.map(s => s.id)
    for (const [index, id] of ids.entries()) {
      assert.ok(await engine.persistence.stat(id), `session ${index} exists`)
    }
    const targetCwd = join(workspaceRoot, `dsha-import-${new Date().toISOString().slice(0, 10)}`)
    const read = await engine.persistence.open(ids[0], 'read')
    let header
    let events
    try {
      header = read.header
      events = (await read.read()).events
    } finally {
      await read.close()
    }
    assert.equal(header.cwd, targetCwd, 'the approved cwd mapping is applied')
    assert.equal(events.length, snap.sessions[0].events)
    const workspaces = engine.workspaceRegistry.list()
    const importedWorkspace = workspaces.find(w => w.path === targetCwd)
    assert.ok(importedWorkspace, 'the dedicated workspace was created')
    assert.equal(importedWorkspace.title, snap.targetWorkspace.title)
    for (const id of ids) assert.ok(importedWorkspace.sessionIds.includes(id), 'both sessions attached')
    // Success keeps the journal but removes the private input/staging.
    const jobName = snap.sourceDigest
    const jobDir = join(dataRoot, 'jobs', jobName)
    assert.ok(existsSync(join(jobDir, 'journal.json')), 'journal is the recovery point')
    assert.equal(existsSync(join(jobDir, 'input')), false, 'picked input copy removed')
    assert.equal(existsSync(join(jobDir, 'source')), false, 'private source staging removed')
    const journal = JSON.parse(readFileSync(join(jobDir, 'journal.json'), 'utf8'))
    assert.equal(journal.batchState, 'DONE')

    // Re-import the SAME backup with the SAME plan: the controller re-reads the
    // source, then the job's DONE gate classifies the target as identical.
    await controller.preparePath(realBackup)
    snap = controller.snapshot()
    assert.equal(snap.phase, 'approved', JSON.stringify(snap))
    assert.equal(snap.notice, 'reimport-check')
    await controller.start()
    snap = controller.snapshot()
    assert.equal(snap.result?.status, 'ALREADY_DONE', JSON.stringify(snap))
    assert.equal(snap.phase, 'already_done')

    // A removed/changed committed session is a COMPLETED-batch target
    // discrepancy, not a rollback candidate: there are no open intents. The
    // panel reports a terminal target-modified result instead of pretending a
    // recovery rollback is pending.
    const located = engine.persistence.locate({ cwd: targetCwd, id: ids[0] })
    rmSync(join(located.path, '..'), { recursive: true, force: true })
    await controller.preparePath(realBackup)
    await controller.start()
    snap = controller.snapshot()
    assert.equal(snap.result?.status, 'TARGET_MODIFIED')
    assert.equal(snap.phase, 'target_modified')
    assert.equal(snap.canPurge, true)
    assert.equal(snap.recovery, null)
  } finally {
    if (oldData === undefined) delete process.env.DSHA_MIGRATOR_DATA_DIR
    else process.env.DSHA_MIGRATOR_DATA_DIR = oldData
    if (oldStorage === undefined) delete process.env.DSHA_MIGRATOR_STORAGE_ROOT
    else process.env.DSHA_MIGRATOR_STORAGE_ROOT = oldStorage
    if (oldWorkspaceRoot === undefined) delete process.env.DSH_WORKSPACE_ROOT
    else process.env.DSH_WORKSPACE_ROOT = oldWorkspaceRoot
    await engine.unmount()
    rmSync(base, { recursive: true, force: true })
  }
})

test('P3 R3: two controllers with different sources share ONE instance lock; the second is refused before any target write', { skip: skip || !process.env.DSHA_V5_FIXTURES ? 'DSHA_V5_REAL/DSHA_V5_FIXTURES or RC4_MODULES not set' : false }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'p3-lock-'))
  const engine = await mountEngine(base)
  const dataRoot = join(base, 'migrator-data')
  const workspaceRoot = join(base, 'workspace-root')
  mkdirSync(workspaceRoot, { recursive: true })
  const oldData = process.env.DSHA_MIGRATOR_DATA_DIR
  const oldStorage = process.env.DSHA_MIGRATOR_STORAGE_ROOT
  const oldWorkspaceRoot = process.env.DSH_WORKSPACE_ROOT
  process.env.DSHA_MIGRATOR_DATA_DIR = dataRoot
  process.env.DSHA_MIGRATOR_STORAGE_ROOT = engine.storageRoot
  process.env.DSH_WORKSPACE_ROOT = workspaceRoot
  const services = {
    sessionPersistence: engine.persistence,
    workspaceRegistry: engine.workspaceRegistry,
    attachments: engine.attachments,
    agentPresets: presetStub(),
  }
  let releaseGate
  let gateEntered
  const entered = new Promise(resolve => { gateEntered = resolve })
  const gate = new Promise(resolve => { releaseGate = resolve })
  let firstStat = true
  const gatedPersistence = new Proxy(engine.persistence, {
    get(target, prop) {
      if (prop === 'stat') {
        return async (...args) => {
          if (firstStat) {
            firstStat = false
            gateEntered()
            await gate
          }
          return target.stat(...args)
        }
      }
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const controllerA = createMigrationController()
  const controllerB = createMigrationController()
  try {
    controllerA.setServices({ ...services, sessionPersistence: gatedPersistence })
    controllerB.setServices(services)
    await controllerA.preparePath(realBackup)
    await controllerA.approve()
    const runA = controllerA.start()
    await Promise.race([
      entered,
      new Promise((_, reject) => setTimeout(() => reject(new Error('controller A never reached the gated stat')), 10_000)),
    ])

    // B uses a DIFFERENT source (same sessions) and must be refused by the
    // shared instance lock before its journal/snapshot or any target write.
    await controllerB.preparePath(join(process.env.DSHA_V5_FIXTURES, 'valid-large..gz'))
    const bSnap = controllerB.snapshot()
    assert.equal(bSnap.phase, 'preview', JSON.stringify(bSnap))
    await controllerB.approve()
    await controllerB.start()
    const bDone = controllerB.snapshot()
    assert.equal(bDone.result?.status, 'FAILED', JSON.stringify(bDone.result))
    assert.equal(bDone.result?.errorCode, 'IMPORT_JOB_LOCKED')
    assert.equal(controllerB.snapshot().sessions.length, 2)
    // No B journal actions were written (the lock is acquired first).
    const bJob = join(dataRoot, 'jobs', bDone.sourceDigest)
    let bJournal = null
    try { bJournal = JSON.parse(readFileSync(join(bJob, 'journal.json'), 'utf8')) } catch { /* not created */ }
    assert.ok(!bJournal || bJournal.actions.length === 0, 'the blocked job performed no target action')

    releaseGate()
    const aDone = await runA
    assert.ok(['DONE', 'FAILED', 'VERIFY_FAILED'].includes(controllerA.snapshot().result?.status), JSON.stringify(aDone))
  } finally {
    releaseGate()
    if (oldData === undefined) delete process.env.DSHA_MIGRATOR_DATA_DIR
    else process.env.DSHA_MIGRATOR_DATA_DIR = oldData
    if (oldStorage === undefined) delete process.env.DSHA_MIGRATOR_STORAGE_ROOT
    else process.env.DSHA_MIGRATOR_STORAGE_ROOT = oldStorage
    if (oldWorkspaceRoot === undefined) delete process.env.DSH_WORKSPACE_ROOT
    else process.env.DSH_WORKSPACE_ROOT = oldWorkspaceRoot
    await engine.unmount()
    rmSync(base, { recursive: true, force: true })
  }
})

test('P3 R4: a fresh controller resumes a pending journal from the PERSISTED plan and rolls it back', { skip: skip ? 'RC4_MODULES or DSHA_V5_REAL not set' : false }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'p3-r4-'))
  const engine = await mountEngine(base)
  const dataRoot = join(base, 'migrator-data')
  const oldData = process.env.DSHA_MIGRATOR_DATA_DIR
  const oldStorage = process.env.DSHA_MIGRATOR_STORAGE_ROOT
  process.env.DSHA_MIGRATOR_DATA_DIR = dataRoot
  process.env.DSHA_MIGRATOR_STORAGE_ROOT = engine.storageRoot
  try {
    const { createHash } = await import('node:crypto')
    const fp = createHash('sha256').update('dsha-migrator|' + engine.persistence.root + '|' + (engine.persistence.name ?? '')).digest('hex')
    const wdir = join(base, 'r4-ws')
    mkdirSync(wdir, { recursive: true })
    const target = await engine.workspaceRegistry.create(wdir, 'R4 target')
    const s1 = {
      id: 'r4-s',
      header: { version: 4, id: 'r4-s', createdAt: 1793500000000, cwd: wdir, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
      events: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 2, data: { id: 'r4-u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'r4' }] }, surfaceOp: 'append' },
        { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
      inheritedEventCount: 0,
      workspace: { path: wdir, title: 'R4 target' },
    }
    const jobDir = join(dataRoot, 'jobs', 'srcdigest-r4')
    mkdirSync(jobDir, { recursive: true })
    const plan = buildPlan({
      sourceDigest: 'src-r4',
      instanceFingerprint: fp,
      report: { sessions: [{ id: 'r4-s', status: 'restored', importable: true, sourceGeneration: 4, headerVersion: 4 }], counts: { total: 1 } },
    })
    freezePlan(join(jobDir, 'plan.json'), plan)
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: fp, sourceDigest: 'src-r4' }, { requirePlanApproval: true })
    journal.approvePlan({ digest: plan.digest, file: join(jobDir, 'plan.json') })
    journal.transitionBatch('PLANNED')
    const wrapEntity = w => new Proxy(w, {
      get(t, prop) {
        if (prop === 'attachSession') return async () => { throw new Error('injected attach failure') }
        const value = t[prop]
        return typeof value === 'function' ? value.bind(t) : value
      },
    })
    const badRegistry = new Proxy(engine.workspaceRegistry, {
      get(t, prop) {
        if (prop === 'list') return () => t.list().map(w => (w.id === target.id ? wrapEntity(w) : w))
        const value = t[prop]
        return typeof value === 'function' ? value.bind(t) : value
      },
    })
    const { runImportJob } = await import('../lib/import/job.js')
    const failed = await runImportJob({
      jobDir,
      instanceLockDir: join(dataRoot, 'instance-lock'),
      instanceFingerprint: fp,
      sourceDigest: 'src-r4',
      approvedPlan: plan,
      target: { persistence: engine.persistence, workspaceRegistry: badRegistry },
      sessions: [s1],
      withdrawSession: async () => { throw new Error('injected withdraw failure') },
      allowUnprotected: true,
    })
    assert.equal(failed.status, 'ROLLBACK_PENDING', JSON.stringify(failed))
    assert.ok(await engine.persistence.stat('r4-s'), 'the pending session remains for recovery')

    // Simulate a process that died while holding the instance lock: the lock
    // file exists with an old mtime and no live owner. The panel must be able
    // to inspect it, refuse a young lock, and reclaim this stale generation
    // only after the explicit recovery action.
    const lockDir = join(dataRoot, 'instance-lock')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'import-job.lock'), JSON.stringify({
      instanceFingerprint: fp,
      ownerId: 'crashed-owner',
      generation: 'crashed-generation',
      pid: 999999,
      at: new Date(0).toISOString(),
    }))
    const old = new Date(Date.now() - 120_000)
    utimesSync(join(lockDir, 'import-job.lock'), old, old)

    const controller = createMigrationController()
    controller.setServices({
      sessionPersistence: engine.persistence,
      workspaceRegistry: engine.workspaceRegistry,
      attachments: engine.attachments,
      agentPresets: presetStub(),
    })
    for (let i = 0; i < 200 && controller.snapshot().phase !== 'recovery_required'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(controller.snapshot().phase, 'recovery_required', JSON.stringify(controller.snapshot()))
    assert.equal(controller.inspectLock().held, true)
    assert.equal(controller.inspectLock().canBreak, true)
    await controller.unlockAndResume()
    const snap = controller.snapshot()
    assert.equal(snap.result?.errorCode, null, JSON.stringify(snap.result))
    // The confirmed session import is compensated; the OPEN attach intent
    // remains result-unknown and keeps the journal pending by policy. The
    // important R4 property is that recovery reached compensation using the
    // persisted plan identity instead of failing with IMPORT_PLAN_BINDING.
    assert.equal(snap.result?.status, 'ROLLBACK_PENDING', JSON.stringify(snap.result))
    assert.equal(snap.result?.rollback?.finalOk, true)
    assert.equal(await engine.persistence.stat('r4-s'), undefined, 'the pending session was withdrawn')
    const reloaded = ImportJournal.load(join(jobDir, 'journal.json'), { instanceFingerprint: fp, sourceDigest: 'src-r4' })
    assert.equal(reloaded.state.batchState, 'ROLLBACK_PENDING')
  } finally {
    if (oldData === undefined) delete process.env.DSHA_MIGRATOR_DATA_DIR
    else process.env.DSHA_MIGRATOR_DATA_DIR = oldData
    if (oldStorage === undefined) delete process.env.DSHA_MIGRATOR_STORAGE_ROOT
    else process.env.DSHA_MIGRATOR_STORAGE_ROOT = oldStorage
    await engine.unmount()
    rmSync(base, { recursive: true, force: true })
  }
})
