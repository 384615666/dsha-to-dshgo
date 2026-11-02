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
    // The host knows the backend's real unit location; the module never
    // guesses it. For this json backend the domain unit is <root>/workspace.json.
    unitProvider: async () => {
      const file = join(storageRoot, 'workspace.json')
      return { bytes: readFileSync(file) }
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
