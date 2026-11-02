// P2 M1: formal workspace unit provider + workspace recovery adapter on the
// real rc.4 engine (isolated roots).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createWorkspaceUnitProvider, projectWorkspaceUnit } from '../lib/import/workspace-unit.js'
import { readWorkspaceRegistryView } from '../lib/import/g6.js'
import { captureTargetPreState } from '../lib/import/g6.js'
import { restoreWorkspaceUnit, verifyWorkspaceUnit } from '../lib/import/workspace-recovery.js'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir

async function mountTarget() {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
  const storagePkg = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage')).href)
  const storageJson = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-json')).href)
  const storageDomain = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-domain')).href)
  const workspacePkg = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-workspace')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const base = mkdtempSync(join(tmpdir(), 'm1-ws-'))
  const storageRoot = join(base, 'storage')
  mkdirSync(storageRoot, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(storagePkg.Storage, {})
  await ctx.plugin(storageJson, { root: storageRoot })
  await ctx.plugin(storageDomain, { backend: 'json' })
  mkdirSync(join(base, 'sessions'), { recursive: true })
  await ctx.plugin(jsonl, { root: join(base, 'sessions'), compression: 'zstd' })
  await ctx.plugin(workspacePkg.WorkspaceRegistry)
  return {
    base,
    storageRoot,
    workspaceRegistry: ctx.workspaceRegistry,
    persistence: ctx.sessionPersistence,
    unitFile: join(storageRoot, 'workspace.json'),
    provider: createWorkspaceUnitProvider({ storageRoot }),
    async makeSession(id, cwd) {
      const h = { version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
      const handle = await ctx.sessionPersistence.create(h, { inheritedEventCount: 0 })
      await handle.flush()
      await handle.close()
    },
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(base, { recursive: true, force: true })
    },
  }
}

test('P2 M1 provider: derives a validated projection from the configured unit; pending/schema/version/file errors refuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm1-provider-'))
  try {
    const unitFile = join(dir, 'workspace.json')
    const valid = {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: ['s-arc'], pinnedSessionIds: ['s-pin'] },
      tables: { workspaces: { w1: { path: '/p/w1', title: 'T', sessionIds: ['s1', 's2'], createdAt: 'a', updatedAt: 'b' } } },
    }
    writeFileSync(unitFile, JSON.stringify(valid))
    const provider = createWorkspaceUnitProvider({ storageRoot: dir })
    const out = await provider()
    assert.equal(out.unitName, 'workspace')
    assert.equal(out.unitVersion, 2)
    assert.deepEqual(out.projection.workspaceIds, ['w1'])
    assert.deepEqual(out.projection.workspaces.w1.sessionIds, ['s1', 's2'], 'the RAW persisted members are projected')
    assert.deepEqual(out.projection.archivedSessionIds, ['s-arc'])
    assert.deepEqual(out.projection.pinnedSessionIds, ['s-pin'])

    // pending mutation marker → refuse
    writeFileSync(unitFile, JSON.stringify({ ...valid, global: { ...valid.global, pendingMutation: { operation: 'create', workspaceId: 'w2' } } }))
    await assert.rejects(() => provider(), err => err.code === 'G6_SNAPSHOT_PENDING')
    // wrong unit name / unsupported version / malformed global
    writeFileSync(unitFile, JSON.stringify({ ...valid, unit: { name: 'other', version: 2 } }))
    await assert.rejects(() => provider(), err => err.code === 'G6_SNAPSHOT_INVALID')
    writeFileSync(unitFile, JSON.stringify({ ...valid, unit: { name: 'workspace', version: 99 } }))
    await assert.rejects(() => provider(), err => err.code === 'G6_SNAPSHOT_UNSUPPORTED')
    writeFileSync(unitFile, JSON.stringify({ ...valid, global: { initialized: true } }))
    await assert.rejects(() => provider(), err => err.code === 'G6_SNAPSHOT_INVALID')
    // order/record mismatch
    writeFileSync(unitFile, JSON.stringify({ ...valid, tables: { workspaces: {} } }))
    await assert.rejects(() => provider(), err => err.code === 'G6_SNAPSHOT_INVALID')
    // missing file
    const missing = createWorkspaceUnitProvider({ storageRoot: join(dir, 'nope') })
    await assert.rejects(() => missing(), err => err.code === 'G6_SNAPSHOT_INVALID')
    // direct projection helper
    assert.throws(() => projectWorkspaceUnit(null), err => err.code === 'G6_SNAPSHOT_INVALID')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 M1 capture: filtered visible members are allowed — persisted candidates are kept in the snapshot', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'm1-capture-'))
  try {
    const wdir = join(t.base, 'w')
    mkdirSync(wdir, { recursive: true })
    const W = await t.workspaceRegistry.create(wdir, 'filtered')
    // Inject a persisted candidate that the registry will NOT show (no such
    // session exists → candidateMatches filters it out).
    const unit = JSON.parse(readFileSync(t.unitFile, 'utf8'))
    unit.tables.workspaces[W.id].sessionIds.push('ghost-candidate')
    writeFileSync(t.unitFile, JSON.stringify(unit))
    const snapshot = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['m1-new'],
      workspaceUnitProvider: t.provider,
      snapshotDir: jobDir,
    })
    const entity = snapshot.workspaces.find(w => w.id === W.id)
    assert.ok(!entity.sessionIds.includes('ghost-candidate'), 'the registry visible set filters it')
    assert.ok(entity.persistedSessionIds.includes('ghost-candidate'), 'the RAW unit record keeps it — never silently dropped')
    assert.deepEqual(snapshot.workspaceUnitSchema, { unitName: 'workspace', unitVersion: 2 })
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 M1 recovery: three-way restore of title/members/pin and our new registration; user changes preserved', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  try {
    const wdir = join(t.base, 'w0')
    mkdirSync(wdir, { recursive: true })
    const W0 = await t.workspaceRegistry.create(wdir, 'before-title')
    await t.makeSession('m1-s0', wdir)
    await W0.attachSession('m1-s0')
    await t.workspaceRegistry.pinSession('m1-s0')
    const snapshot = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['m1-new'],
      workspaceUnitProvider: t.provider,
      snapshotDir: mkdtempSync(join(tmpdir(), 'm1-snap-')),
    })

    // our batch: rename, detach, unpin, create W1
    await W0.setTitle('after-title')
    await W0.detachSession('m1-s0')
    await t.workspaceRegistry.unpinSession('m1-s0')
    const w1dir = join(t.base, 'w1')
    mkdirSync(w1dir, { recursive: true })
    const W1 = await t.workspaceRegistry.create(w1dir, 'batch-created')
    const afterBatch = readWorkspaceRegistryView(t.workspaceRegistry)

    const restored = await restoreWorkspaceUnit({
      workspaceRegistry: t.workspaceRegistry,
      snapshot,
      afterBatch,
    })
    assert.equal(restored.outcome, 'complete', JSON.stringify({ pending: restored.pending, failures: restored.failures, diffs: restored.verification.diffs }))
    assert.ok(restored.capabilityGaps.some(g => /createdAt\/updatedAt/.test(g)))
    const now = readWorkspaceRegistryView(t.workspaceRegistry)
    assert.equal(now.workspaces.find(w => w.id === W0.id).title, 'before-title')
    assert.ok(now.workspaces.find(w => w.id === W0.id).sessionIds.includes('m1-s0'))
    assert.ok(now.pinnedSessionIds.includes('m1-s0'))
    assert.ok(!now.workspaceIds.includes(W1.id), 'the batch-created registration is removed')
    assert.ok(verifyWorkspaceUnit({ workspaceRegistry: t.workspaceRegistry, snapshot }).ok)

    // a USER edit after our batch is preserved → pending, not overwritten
    await W0.setTitle('after-title')
    await t.workspaceRegistry.unpinSession('m1-s0')
    const afterBatch2 = readWorkspaceRegistryView(t.workspaceRegistry)
    await W0.setTitle('user-title')
    const second = await restoreWorkspaceUnit({ workspaceRegistry: t.workspaceRegistry, snapshot, afterBatch: afterBatch2 })
    assert.equal(second.outcome, 'pending', JSON.stringify(second.pending))
    assert.ok(second.pending.some(p => p.field === 'title'))
    assert.equal(readWorkspaceRegistryView(t.workspaceRegistry).workspaces.find(w => w.id === W0.id).title, 'user-title')
    assert.ok(second.capabilityGaps.length > 0)
  } finally {
    await t.unmount()
  }
})

test('P2 M1 recovery: a deleted pre-existing registration is re-created on its real path and order is restored; createdAt is a recorded capability gap', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  try {
    const d0 = join(t.base, 'd0')
    const d1 = join(t.base, 'd1')
    mkdirSync(d0, { recursive: true })
    mkdirSync(d1, { recursive: true })
    const W0 = await t.workspaceRegistry.create(d0, 'keep-me')
    const W1 = await t.workspaceRegistry.create(d1, 'second') // prepends → [W1, W0]
    const snapshot = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['m1-new2'],
      workspaceUnitProvider: t.provider,
      snapshotDir: mkdtempSync(join(tmpdir(), 'm1-snap2-')),
    })
    // our batch deletes the pre-existing W0 and reverses the order
    await t.workspaceRegistry.delete(W0.id)
    await t.workspaceRegistry.insertBefore(W1.id, undefined)
    const afterBatch = readWorkspaceRegistryView(t.workspaceRegistry)
    const restored = await restoreWorkspaceUnit({ workspaceRegistry: t.workspaceRegistry, snapshot, afterBatch })
    // The public registry assigns a NEW durable id on re-creation: content is
    // restored, identity is not — the outcome is pending with an explicit gap.
    assert.equal(restored.outcome, 'pending', JSON.stringify({ pending: restored.pending, failures: restored.failures }))
    const now = readWorkspaceRegistryView(t.workspaceRegistry)
    const recreatedEntity = now.workspaces.find(w => w.path === now.workspaces.find(x => x.title === 'keep-me')?.path)
    assert.ok(recreatedEntity && recreatedEntity.title === 'keep-me', 'the deleted registration is back with its title')
    assert.ok(restored.capabilityGaps.some(g => /new durable id/.test(g)), 'the identity change is reported, not hidden')
    assert.ok(restored.capabilityGaps.some(g => /createdAt\/updatedAt/.test(g)), 'the new createdAt is reported, not hidden')
    const idMap = new Map([[W0.id, recreatedEntity.id]])
    const v = verifyWorkspaceUnit({ workspaceRegistry: t.workspaceRegistry, snapshot, idMap })
    assert.equal(v.ok, true, JSON.stringify(v.diffs))
    assert.deepEqual(now.workspaceIds, snapshot.workspaceIds.map(id => idMap.get(id) ?? id), 'the durable order is restored')
  } finally {
    await t.unmount()
  }
})
