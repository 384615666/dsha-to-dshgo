// P3 controller acceptance: the REAL backup drives the unified A job through
// the product controller (source → preview → approved plan → runImportJob),
// then re-imports and re-checks a DONE journal. Isolated engine target; the
// real backup is read-only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createMigrationController } from '../lib/import/controller.js'

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

    // A removed committed session is a target discrepancy, not a silent pass.
    const located = engine.persistence.locate({ cwd: targetCwd, id: ids[0] })
    rmSync(join(located.path, '..'), { recursive: true, force: true })
    await controller.preparePath(realBackup)
    await controller.start()
    snap = controller.snapshot()
    assert.equal(snap.result?.status, 'RECOVERY_REQUIRED')
    assert.equal(snap.phase, 'recovery_required')
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
