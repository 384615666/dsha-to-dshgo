// Durable offline write protocol: short writes complete, backups are durable
// before replace, temp bytes are verified before the atomic rename, and real
// directory I/O failures are never reported as success.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs'
import { planWorkspaceRepair } from '../lib/import/workspace-repair.js'
import { applyWorkspaceRepairFile } from '../lib/import/workspace-repair-write.js'

function unitFixture() {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { workspaceIds: ['ws-a', 'ws-b'], archivedSessionIds: ['arch'], pinnedSessionIds: ['pin'] },
    tables: {
      workspaces: {
        'ws-a': { path: '/old', title: 'Old', sessionIds: ['s1', 's2'], createdAt: 1, updatedAt: 2 },
        'ws-b': { path: '/new', title: 'New', sessionIds: ['s1'], createdAt: 3, updatedAt: 4 },
      },
    },
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'repair-write-'))
  const unitPath = join(dir, 'workspace.json')
  const original = Buffer.from(JSON.stringify(unitFixture()))
  writeFileSync(unitPath, original)
  const diff = planWorkspaceRepair({ unitBytes: original, sessionCwds: { s1: '/new', s2: '/old' } })
  assert.equal(diff.changed, true)
  return { dir, unitPath, original, diff }
}

function proxyFs({ onOpen, onWrite, onFsync, onRename } = {}) {
  const fdPaths = new Map()
  const state = { renamed: false }
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'openSync') {
        return (path, flags, mode) => {
          if (onOpen) {
            const injected = onOpen(path, flags, state)
            if (injected) throw injected
          }
          const fd = fs.openSync(path, flags, mode)
          fdPaths.set(fd, path)
          return fd
        }
      }
      if (prop === 'closeSync') {
        return fd => { fdPaths.delete(fd); return fs.closeSync(fd) }
      }
      if (prop === 'writeSync') {
        return (...args) => (onWrite ? onWrite(fdPaths.get(args[0]), args) : fs.writeSync(...args))
      }
      if (prop === 'fsyncSync') {
        return fd => (onFsync ? onFsync(fdPaths.get(fd), fd) : fs.fsyncSync(fd))
      }
      if (prop === 'renameSync') {
        return (from, to) => {
          if (onRename) onRename(from, to, state)
          const result = fs.renameSync(from, to)
          state.renamed = true
          return result
        }
      }
      const value = fs[prop]
      return typeof value === 'function' ? value.bind(fs) : value
    },
  })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('repair write: a legal short write is completed; backup and unit are durable and correct', () => {
  const { dir, unitPath, original, diff } = setup()
  try {
    let first = true
    const fsOps = proxyFs({
      onWrite: (path, args) => {
        if (!first) return fs.writeSync(...args)
        first = false
        const [fd, buffer, offset, length] = args
        const half = Math.max(1, Math.floor(length / 2))
        return fs.writeSync(fd, buffer, offset, half)
      },
    })
    const result = applyWorkspaceRepairFile({ unitPath, unitBytes: original, diff, expectSha256: diff.unitSha256, engineStopped: true, fsOps })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'applied')
    const after = readJson(unitPath)
    assert.deepEqual(after.tables.workspaces['ws-a'].sessionIds, ['s2'])
    assert.deepEqual(after.tables.workspaces['ws-b'].sessionIds, ['s1'])
    assert.deepEqual(after.global, unitFixture().global)
    assert.deepEqual(readFileSync(result.backup), original)
    assert.ok(result.backupDirectorySync, 'backup directory barrier recorded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repair write: a temp write failure leaves the original unit untouched and removes the temp file', () => {
  const { dir, unitPath, original, diff } = setup()
  try {
    const fsOps = proxyFs({
      onWrite: (path, args) => {
        if (typeof path === 'string' && path.includes('.workspace-repair-')) {
          const error = new Error('injected ENOSPC')
          error.code = 'ENOSPC'
          throw error
        }
        return fs.writeSync(...args)
      },
    })
    assert.throws(
      () => applyWorkspaceRepairFile({ unitPath, unitBytes: original, diff, expectSha256: diff.unitSha256, engineStopped: true, fsOps }),
      error => error.code === 'REPAIR_WRITE_FAILED')
    assert.deepEqual(readFileSync(unitPath), original, 'the original unit is unchanged')
    assert.deepEqual(readdirSync(dir).filter(n => n.startsWith('.workspace-repair-')), [], 'no temp file remains')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repair write: a backup fsync failure does not replace the unit', () => {
  const { dir, unitPath, original, diff } = setup()
  try {
    const fsOps = proxyFs({
      onFsync: (path, fd) => {
        if (typeof path === 'string' && path.includes('.bak-')) {
          const error = new Error('injected EIO')
          error.code = 'EIO'
          throw error
        }
        return fs.fsyncSync(fd)
      },
    })
    assert.throws(
      () => applyWorkspaceRepairFile({ unitPath, unitBytes: original, diff, expectSha256: diff.unitSha256, engineStopped: true, fsOps }),
      error => error.code === 'REPAIR_FSYNC_FAILED')
    assert.deepEqual(readFileSync(unitPath), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repair write: directory open EIO after rename is a non-success with the replaced fact preserved', () => {
  const { dir, unitPath, original, diff } = setup()
  try {
    const fsOps = proxyFs({
      onOpen: (path, flags, state) => {
        if (state.renamed && path === dir && flags === 'r') {
          const error = new Error('injected EIO')
          error.code = 'EIO'
          return error
        }
        return null
      },
    })
    const result = applyWorkspaceRepairFile({ unitPath, unitBytes: original, diff, expectSha256: diff.unitSha256, engineStopped: true, fsOps })
    assert.equal(result.ok, false)
    assert.equal(result.mode, 'replaced-durability-unknown')
    assert.equal(result.error.code, 'REPAIR_FSYNC_FAILED')
    assert.deepEqual(readJson(unitPath).tables.workspaces['ws-a'].sessionIds, ['s2'], 'the complete replacement is present')
    assert.deepEqual(readFileSync(result.backup), original, 'the original backup remains')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repair write: directory fsync EIO after rename is a non-success; a verified unsupported pair is recorded', () => {
  const eioDir = setup()
  try {
    let renamed = false
    const fsOps = proxyFs({
      onRename: (_from, _to, state) => { renamed = state.renamed = true },
      onFsync: (path, fd) => {
        if (renamed && path === eioDir.dir) {
          const error = new Error('injected EIO')
          error.code = 'EIO'
          throw error
        }
        return fs.fsyncSync(fd)
      },
    })
    const result = applyWorkspaceRepairFile({ unitPath: eioDir.unitPath, unitBytes: eioDir.original, diff: eioDir.diff, expectSha256: eioDir.diff.unitSha256, engineStopped: true, fsOps })
    assert.equal(result.ok, false)
    assert.equal(result.mode, 'replaced-durability-unknown')
    assert.equal(result.error.code, 'REPAIR_FSYNC_FAILED')
  } finally {
    rmSync(eioDir.dir, { recursive: true, force: true })
  }

  const unsupported = setup()
  const code = process.platform === 'win32' ? 'EPERM' : 'ENOSYS'
  try {
    const fsOps = proxyFs({
      onOpen: (path, flags, state) => {
        if (state.renamed && path === unsupported.dir && flags === 'r') {
          const error = new Error('platform directory open unsupported')
          error.code = code
          return error
        }
        return null
      },
    })
    const result = applyWorkspaceRepairFile({ unitPath: unsupported.unitPath, unitBytes: unsupported.original, diff: unsupported.diff, expectSha256: unsupported.diff.unitSha256, engineStopped: true, fsOps })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'applied')
    assert.equal(result.directorySync.ok, false)
    assert.match(result.directorySync.reason, /directory-open-unsupported/)
  } finally {
    rmSync(unsupported.dir, { recursive: true, force: true })
  }
})

test('repair write: a changed unit or a missing engine-stopped attestation refuses before any write', () => {
  const { dir, unitPath, original, diff } = setup()
  try {
    assert.throws(
      () => applyWorkspaceRepairFile({ unitPath, unitBytes: original, diff, expectSha256: diff.unitSha256, engineStopped: false }),
      error => error.code === 'REPAIR_ENGINE_RUNNING')
    const changed = Buffer.from(JSON.stringify({ ...unitFixture(), extra: 1 }))
    writeFileSync(unitPath, changed)
    assert.throws(
      () => applyWorkspaceRepairFile({ unitPath, unitBytes: original, diff, expectSha256: diff.unitSha256, engineStopped: true }),
      error => error.code === 'REPAIR_STALE_UNIT')
    assert.deepEqual(readFileSync(unitPath), changed)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repair CLI: the real --apply path succeeds with the durable protocol and refuses without attestation', async () => {
  const { spawnSync } = await import('node:child_process')
  const { dir, unitPath, original, diff } = setup()
  const cwdsPath = join(dir, 'cwds.json')
  writeFileSync(cwdsPath, JSON.stringify({ s1: '/new', s2: '/old' }))
  const script = join(import.meta.dirname, '..', 'scripts', 'workspace-repair-diff.mjs')
  try {
    const refused = spawnSync(process.execPath, [script, '--unit', unitPath, '--session-cwds', cwdsPath, '--apply', '--expect-sha256', diff.unitSha256], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(refused.status, 1)
    assert.deepEqual(readFileSync(unitPath), original, 'a refused apply leaves the unit untouched')

    const applied = spawnSync(process.execPath, [script, '--unit', unitPath, '--session-cwds', cwdsPath, '--apply', '--engine-stopped', '--expect-sha256', diff.unitSha256], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(applied.status, 0, applied.stderr)
    const receipt = JSON.parse(applied.stdout)
    assert.equal(receipt.mode, 'applied')
    assert.equal(receipt.ok, true)
    const after = readJson(unitPath)
    assert.deepEqual(after.tables.workspaces['ws-a'].sessionIds, ['s2'])
    assert.deepEqual(after.tables.workspaces['ws-b'].sessionIds, ['s1'])
    assert.deepEqual(readFileSync(receipt.backup), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
