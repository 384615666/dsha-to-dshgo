// P2 batch-3: workspace unit snapshot completeness — full entity fields plus
// a verified on-disk copy of the workspace storage unit, enforced at the
// IMPORTING gate.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ImportJournal } from '../lib/import/journal.js'
import { captureTargetPreState, computeSnapshotDigest } from '../lib/import/g6.js'

// The committed entity projection of a json storage unit (host-side knowledge
// supplied through the provider contract).
export function projectionFromUnit(bytes) {
  const unit = JSON.parse(Buffer.from(bytes).toString('utf8'))
  return {
    workspaceIds: unit.global?.workspaceIds ?? [],
    archivedSessionIds: unit.global?.archivedSessionIds ?? [],
    pinnedSessionIds: unit.global?.pinnedSessionIds ?? [],
    workspaces: unit.tables?.workspaces ?? {},
  }
}

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
  const base = mkdtempSync(join(tmpdir(), 'ws-unit-'))
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
    // The host knows the backend's real unit location AND how to project the
    // committed entity state from those bytes (cross-layer contract). For
    // this json backend the domain unit is <root>/workspace.json.
    unitProvider: async () => {
      const bytes = readFileSync(join(storageRoot, 'workspace.json'))
      return { bytes, projection: projectionFromUnit(bytes) }
    },
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(base, { recursive: true, force: true })
    },
  }
}

test('P2 workspace snapshot: full entity fields + verified disk copy of the storage unit at the IMPORTING gate', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'ws-unit-job-'))
  // the unit copy lives in the JOB directory, next to the journal — the
  // journal verifies it relative to its own location (no private abs paths).
  const snapshotDir = jobDir
  try {
    const wdir = join(t.base, 'w')
    mkdirSync(wdir, { recursive: true })
    const W = await t.workspaceRegistry.create(wdir, '完整快照')
    const snapshot = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['ws-new'],
      workspaceUnitProvider: t.unitProvider,
      snapshotDir,
    })
    // full supported entity fields
    const entity = snapshot.workspaces.find(w => w.id === W.id)
    assert.ok(entity, 'the workspace entity is captured')
    assert.equal(entity.title, '完整快照')
    assert.equal(entity.path, W.path)
    assert.ok(Object.hasOwn(entity, 'createdAt') && entity.createdAt != null)
    assert.ok(Object.hasOwn(entity, 'updatedAt') && entity.updatedAt != null)
    assert.deepEqual(entity.sessionIds, [])
    // verified disk copy
    assert.ok(snapshot.workspaceUnit, 'the unit copy is recorded')
    const copyFile = join(snapshotDir, snapshot.workspaceUnit.file)
    assert.ok(existsSync(copyFile))
    if (process.platform !== 'win32') {
      assert.equal(statSync(copyFile).mode & 0o777, 0o600, 'the snapshot copy is private (0600)')
    }
    const copied = readFileSync(copyFile)
    assert.equal(copied.length, snapshot.workspaceUnit.bytes)
    assert.equal(snapshot.workspaceUnit.digest, (await import('node:crypto')).createHash('sha256').update(copied).digest('hex'))
    // the snapshot digest covers the unit copy
    assert.equal(computeSnapshotDigest(snapshot), snapshot.digest)

    const journal = ImportJournal.init(join(jobDir, 'j.json'), { instanceFingerprint: 'inst-ws', sourceDigest: 'src-ws' })
    journal.transitionBatch('PLANNED')
    journal.setSnapshot(snapshot)
    journal.transitionBatch('SNAPSHOT_READY')
    journal.transitionBatch('IMPORTING') // intact copy admits

    // tampered copy refuses IMPORTING
    const j2 = ImportJournal.init(join(jobDir, 'j2.json'), { instanceFingerprint: 'inst-ws', sourceDigest: 'src-ws' })
    j2.transitionBatch('PLANNED')
    j2.setSnapshot(snapshot)
    j2.transitionBatch('SNAPSHOT_READY')
    writeFileSync(copyFile, Buffer.from('{"tampered":true}'))
    assert.throws(() => j2.transitionBatch('IMPORTING'), err => err.code === 'G6_SNAPSHOT_CORRUPT')
    // missing copy refuses IMPORTING
    rmSync(copyFile)
    const j3 = ImportJournal.init(join(jobDir, 'j3.json'), { instanceFingerprint: 'inst-ws', sourceDigest: 'src-ws' })
    j3.transitionBatch('PLANNED')
    j3.setSnapshot(snapshot)
    j3.transitionBatch('SNAPSHOT_READY')
    assert.throws(() => j3.transitionBatch('IMPORTING'), err => err.code === 'G6_SNAPSHOT_MISSING')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 workspace snapshot: a state change DURING capture is retried — no mixed pre-state is published', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'ws-stable-'))
  try {
    const wdir = join(t.base, 'w2')
    mkdirSync(wdir, { recursive: true })
    const W = await t.workspaceRegistry.create(wdir, 'before-capture-title')
    let mutated = false
    const provider = async () => {
      if (!mutated) {
        mutated = true
        await W.setTitle('during-capture-user-title')
      }
      const bytes = readFileSync(join(t.storageRoot, 'workspace.json'))
      return { bytes, projection: projectionFromUnit(bytes) }
    }
    const snapshot = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['ws-new-2'],
      workspaceUnitProvider: provider,
      snapshotDir: jobDir,
    })
    // The accepted snapshot is internally consistent: entity fields and the
    // disk copy are both the POST-change state.
    const entity = snapshot.workspaces.find(w => w.id === W.id)
    assert.equal(entity.title, 'during-capture-user-title', 'the entity view must come from the same moment as the copy')
    const copy = readFileSync(join(jobDir, snapshot.workspaceUnit.file))
    assert.equal(snapshot.workspaceUnit.digest, (await import('node:crypto')).createHash('sha256').update(copy).digest('hex'))
    assert.equal(computeSnapshotDigest(snapshot), snapshot.digest)
    // A journal admits it (intact copy)
    const journal = ImportJournal.init(join(jobDir, 'j.json'), { instanceFingerprint: 'inst-s', sourceDigest: 'src-s' })
    journal.transitionBatch('PLANNED')
    journal.setSnapshot(snapshot)
    journal.transitionBatch('SNAPSHOT_READY')
    journal.transitionBatch('IMPORTING')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 workspace snapshot: a never-stable target is refused with G6_SNAPSHOT_UNSTABLE', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'ws-unstable-'))
  try {
    const wdir = join(t.base, 'w3')
    mkdirSync(wdir, { recursive: true })
    const W = await t.workspaceRegistry.create(wdir, 'unstable-0')
    let n = 0
    const provider = async () => {
      n += 1
      await W.setTitle(`unstable-${n}`)
      const bytes = readFileSync(join(t.storageRoot, 'workspace.json'))
      return { bytes, projection: projectionFromUnit(bytes) }
    }
    await assert.rejects(
      () => captureTargetPreState({
        persistence: t.persistence,
        workspaceRegistry: t.workspaceRegistry,
        plannedSessionIds: ['ws-new-3'],
        workspaceUnitProvider: provider,
        snapshotDir: jobDir,
        captureAttempts: 3,
        captureRetryDelayMs: 1,
      }),
      err => err.code === 'G6_SNAPSHOT_UNSTABLE',
    )
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 workspace snapshot: a file fsync failure aborts capture — no admission without a durable backup', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'ws-fsync-'))
  try {
    const wdir = join(t.base, 'w4')
    mkdirSync(wdir, { recursive: true })
    await t.workspaceRegistry.create(wdir, 'durable')
    const fsmod = (await import('node:fs')).default
    const real = fsmod.fsyncSync
    fsmod.fsyncSync = () => { const e = new Error('injected EIO'); e.code = 'EIO'; throw e }
    try {
      await assert.rejects(
        () => captureTargetPreState({
          persistence: t.persistence,
          workspaceRegistry: t.workspaceRegistry,
          plannedSessionIds: ['ws-new-4'],
          workspaceUnitProvider: t.unitProvider,
          snapshotDir: jobDir,
        }),
        err => err.code === 'G6_SNAPSHOT_IO',
      )
    } finally {
      fsmod.fsyncSync = real
    }
    assert.ok(!existsSync(join(jobDir, 'workspace-unit.json')), 'no published copy after a failed fsync')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 workspace snapshot: storage committed but entity projection lagging is NOT accepted — cross-layer mismatch retries', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'ws-cross-'))
  try {
    const wdir = join(t.base, 'w5')
    mkdirSync(wdir, { recursive: true })
    const W = await t.workspaceRegistry.create(wdir, 'old-title')
    const unitFile = join(t.storageRoot, 'workspace.json')
    const staleBytes = readFileSync(unitFile)
    const staleProjection = projectionFromUnit(staleBytes)
    await W.setTitle('new-title')
    let calls = 0
    // The first attempt sees individually-stable views that DISAGREE across
    // layers (registry new, provider projection stale) — the pending-window
    // shape. From attempt 2 both agree.
    const provider = async () => {
      calls += 1
      const bytes = readFileSync(unitFile)
      return { bytes, projection: calls <= 2 ? staleProjection : projectionFromUnit(bytes) }
    }
    const snapshot = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['ws-new-5'],
      workspaceUnitProvider: provider,
      snapshotDir: jobDir,
      captureAttempts: 3,
      captureRetryDelayMs: 1,
    })
    assert.ok(calls >= 4, `the cross-layer mismatch must trigger a retry (provider calls: ${calls})`)
    assert.equal(snapshot.workspaces.find(w => w.id === W.id).title, 'new-title')
    const copy = readFileSync(join(jobDir, snapshot.workspaceUnit.file))
    assert.equal(snapshot.workspaceUnit.digest, (await import('node:crypto')).createHash('sha256').update(copy).digest('hex'))
    // a permanently lagging projection cannot be published
    const alwaysStale = async () => ({ bytes: readFileSync(unitFile), projection: staleProjection })
    await assert.rejects(
      () => captureTargetPreState({
        persistence: t.persistence,
        workspaceRegistry: t.workspaceRegistry,
        plannedSessionIds: ['ws-new-6'],
        workspaceUnitProvider: alwaysStale,
        snapshotDir: jobDir,
        captureAttempts: 2,
        captureRetryDelayMs: 1,
      }),
      err => err.code === 'G6_SNAPSHOT_UNSTABLE',
    )
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 workspace snapshot: a failed recapture never damages the copy an existing journal references', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'ws-immutable-'))
  try {
    const wdir = join(t.base, 'w6')
    mkdirSync(wdir, { recursive: true })
    const W = await t.workspaceRegistry.create(wdir, 'first-title')
    const snapshot1 = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['ws-new-7'],
      workspaceUnitProvider: t.unitProvider,
      snapshotDir: jobDir,
    })
    const file1 = snapshot1.workspaceUnit.file
    const digest1 = snapshot1.workspaceUnit.digest
    const journal = ImportJournal.init(join(jobDir, 'j.json'), { instanceFingerprint: 'inst-im', sourceDigest: 'src-im' })
    journal.transitionBatch('PLANNED')
    journal.setSnapshot(snapshot1)
    journal.transitionBatch('SNAPSHOT_READY')

    // the target changes; a recapture fails at the POST-rename directory sync
    await W.setTitle('second-title')
    const fsmod = (await import('node:fs')).default
    const real = fsmod.fsyncSync
    let fsyncCalls = 0
    fsmod.fsyncSync = fd => {
      fsyncCalls += 1
      if (fsyncCalls === 2) { const e = new Error('injected dir EIO'); e.code = 'EIO'; throw e }
      return real(fd)
    }
    let recaptureError = null
    try {
      await captureTargetPreState({
        persistence: t.persistence,
        workspaceRegistry: t.workspaceRegistry,
        plannedSessionIds: ['ws-new-8'],
        workspaceUnitProvider: t.unitProvider,
        snapshotDir: jobDir,
      })
    } catch (error) {
      recaptureError = error
    } finally {
      fsmod.fsyncSync = real
    }
    assert.equal(recaptureError?.code, 'G6_SNAPSHOT_IO')
    // the ORIGINAL object and the journal's reference are untouched
    const original = readFileSync(join(jobDir, file1))
    assert.equal((await import('node:crypto')).createHash('sha256').update(original).digest('hex'), digest1)
    journal.transitionBatch('IMPORTING')
    // a later successful capture produces a DIFFERENT content-addressed object
    const snapshot3 = await captureTargetPreState({
      persistence: t.persistence,
      workspaceRegistry: t.workspaceRegistry,
      plannedSessionIds: ['ws-new-9'],
      workspaceUnitProvider: t.unitProvider,
      snapshotDir: jobDir,
    })
    assert.notEqual(snapshot3.workspaceUnit.file, file1)
    assert.ok(existsSync(join(jobDir, file1)), 'the old referenced copy is still present')
    assert.ok(existsSync(join(jobDir, snapshot3.workspaceUnit.file)))
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})
