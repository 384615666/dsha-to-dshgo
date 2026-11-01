// Synthetic default-running regression suite for the v5 reader and the probe
// verdict semantics (review P1-batch1 §2). No private data: every fixture is
// built in-test. These run everywhere; the env-gated real-data tests live in
// v5-reader.test.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readV5Backup } from '../lib/archive/v5-reader.js'
import { buildV5Archive, fileEntry } from './helpers/v5-fixture.mjs'
import { runWriteProbeB } from '../lib/p0/write-probe-b.js'

async function rejects(target, re) {
  await assert.rejects(target, re)
}

test('synthetic valid baseline is accepted', async () => {
  const gz = buildV5Archive([fileEntry('plugins', 'hello.txt', Buffer.from('abc'))])
  const file = join(tmpdir(), `v5-ok-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    const r = await readV5Backup(file)
    assert.equal(r.stats.fileVerified, 1)
    assert.equal(r.stats.incomplete, false)
    assert.equal(r.manifest.entries, 1)
  } finally {
    rmSync(file, { force: true })
  }
})

test('path traversal ../../escape.txt is rejected', async () => {
  const gz = buildV5Archive([fileEntry('plugins', '../../escape.txt', Buffer.from('abc'))])
  const file = join(tmpdir(), `v5-trav-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(() => readV5Backup(file), /ARCHIVE_PATH/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('duplicate logical path is rejected', async () => {
  const gz = buildV5Archive([
    fileEntry('plugins', 'dup.txt', Buffer.from('one')),
    fileEntry('plugins', 'dup.txt', Buffer.from('two')),
  ])
  const file = join(tmpdir(), `v5-dup-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(() => readV5Backup(file), /DUPLICATE_PATH/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('case-folded duplicate path is rejected (collision key semantics)', async () => {
  const gz = buildV5Archive([
    fileEntry('plugins', 'A.txt', Buffer.from('one')),
    fileEntry('plugins', 'a.txt', Buffer.from('two')),
  ])
  const file = join(tmpdir(), `v5-case-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(() => readV5Backup(file), /DUPLICATE_PATH/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('manifest roots/bytes mismatch is rejected', async () => {
  const gz = buildV5Archive([fileEntry('plugins', 'three.txt', Buffer.from('abc'))], {
    manifest: { roots: [], bytes: 999 },
  })
  const file = join(tmpdir(), `v5-man-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(() => readV5Backup(file), /MANIFEST_PAYLOAD_MISMATCH|ROOTS_PAYLOAD_MISMATCH/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('valid MISSING record with PARTIAL integrity is accepted and flagged incomplete', async () => {
  const gz = buildV5Archive([
    fileEntry('plugins', 'present.txt', Buffer.from('abc')),
    { meta: { root: 'plugins', path: 'gone.bin', kind: 'MISSING', scope: 'plugins', size: 0, sha256: '' } },
  ], { manifest: { integrity: 'PARTIAL' } })
  const file = join(tmpdir(), `v5-miss-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    const r = await readV5Backup(file)
    assert.equal(r.stats.incomplete, true)
    assert.equal(r.stats.fileVerified, 1)
  } finally {
    rmSync(file, { force: true })
  }
})

test('MISSING record with QUIESCENT integrity is rejected (FALSE_COMPLETE)', async () => {
  const gz = buildV5Archive([
    { meta: { root: 'plugins', path: 'gone.bin', kind: 'MISSING', scope: 'plugins', size: 0, sha256: '' } },
  ], { manifest: { integrity: 'QUIESCENT' } })
  const file = join(tmpdir(), `v5-false-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(() => readV5Backup(file), /FALSE_COMPLETE/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('corrupted tar header checksum is rejected', async () => {
  const gz = buildV5Archive([fileEntry('plugins', 'hello.txt', Buffer.from('abc'))], {
    corruptChecksum: true,
  })
  const file = join(tmpdir(), `v5-chk-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(() => readV5Backup(file), /checksum mismatch/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('single tar zero end block is rejected', async () => {
  const gz = buildV5Archive([fileEntry('plugins', 'hello.txt', Buffer.from('abc'))], {
    singleZeroBlock: true,
  })
  const file = join(tmpdir(), `v5-zb-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(() => readV5Backup(file), /two zero blocks|block multiple/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('cumulative payload budget is enforced across records', async () => {
  const gz = buildV5Archive([
    fileEntry('plugins', 'a.bin', Buffer.from('abc')),
    fileEntry('plugins', 'b.bin', Buffer.from('def')),
  ])
  const file = join(tmpdir(), `v5-budget-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(
      () => readV5Backup(file, { limits: { maxCumulativePayloadBytes: 4n } }),
      /PAYLOAD_LIMIT/,
    )
  } finally {
    rmSync(file, { force: true })
  }
})

test('slow sink stays within its own buffering budget (backpressure honored)', async () => {
  const payload = Buffer.alloc(8 * 1024 * 1024, 0x41)
  const gz = buildV5Archive([fileEntry('plugins', 'big.bin', payload)])
  const file = join(tmpdir(), `v5-bp-${Date.now()}.gz`)
  writeFileSync(file, gz)
  let maxQueued = 0
  let queued = 0
  const listeners = {}
  const timers = []
  const sink = {
    highWaterMark: 16 * 1024,
    write(chunk) {
      queued += chunk.length
      if (queued > maxQueued) maxQueued = queued
      // Drain asynchronously: a real sink at/below its high-water mark frees
      // the accepted bytes and emits drain once.
      setImmediate(() => {
        queued = 0
        for (const fn of listeners.drain ?? []) fn()
      })
      return false
    },
    emit(event, ...args) {
      for (const fn of listeners[event] ?? []) fn(...args)
    },
    end(cb) {
      for (const t of timers) clearInterval(t)
      cb?.()
      for (const fn of listeners.close ?? []) fn()
    },
    on(event, fn) {
      (listeners[event] ??= []).push(fn)
    },
    once(event, fn) {
      (listeners[event] ??= []).push(fn)
    },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] ?? []).filter(f => f !== fn)
    },
    destroy() {
      for (const t of timers) clearInterval(t)
    },
  }
  try {
    const r = await readV5Backup(file, { makeSink: () => sink })
    assert.equal(r.stats.fileVerified, 1)
    // Bound = one feed chunk (≤1 MiB) + one drained step: the reader must
    // wait for drain after every refused write, never queue ahead. The
    // pre-fix peak was 3,145,728 B with an identical mock.
    assert.ok(
      maxQueued <= 2 * 1024 * 1024,
      `sink queue must stay bounded (peak ${maxQueued} bytes; pre-fix peak was 3,145,728)`,
    )
    assert.ok(maxQueued >= 1024 * 1024, 'sanity: the fixture feeds MiB chunks')
  } finally {
    rmSync(file, { force: true })
  }
})

test('sink failing mid-stream rejects the whole read', async () => {
  const payload = Buffer.alloc(1024 * 1024, 0x42)
  const gz = buildV5Archive([fileEntry('plugins', 'fail.bin', payload)])
  const file = join(tmpdir(), `v5-sinkerr-${Date.now()}.gz`)
  writeFileSync(file, gz)
  const listeners = {}
  const sink = {
    write() {
      return true
    },
    emit(event, ...args) {
      for (const fn of listeners[event] ?? []) fn(...args)
    },
    end(cb) {
      // Fail INSTEAD of completing: a real sink that hits ENOSPC during the
      // final flush never calls the completion callback successfully.
      process.nextTick(() => {
        sink.emit('error', new Error('disk full (mock)'))
      })
    },
    on(event, fn) {
      (listeners[event] ??= []).push(fn)
    },
    once(event, fn) {
      (listeners[event] ??= []).push(fn)
    },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] ?? []).filter(f => f !== fn)
    },
    destroy() {},
  }
  try {
    await rejects(() => readV5Backup(file, { makeSink: () => sink }), /disk full/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('LINK record with a backslash target is rejected', async () => {
  const gz = buildV5Archive([
    { meta: { root: 'plugins', path: 'evil.lnk', kind: 'LINK', scope: 'plugins', size: 0, sha256: '', target: '..\\evil.txt' } },
  ])
  const file = join(tmpdir(), `v5-link-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(() => readV5Backup(file), /LINK_FORMAT/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('directory child recorded, then a non-directory at its parent path, is rejected', async () => {
  const gz = buildV5Archive([
    { meta: { root: 'plugins', path: 'a/b', kind: 'DIRECTORY', scope: 'plugins', size: 0, sha256: '' } },
    fileEntry('plugins', 'a', Buffer.from('abc')),
  ])
  const file = join(tmpdir(), `v5-order-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(() => readV5Backup(file), /PATH_TYPE_CONFLICT/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('file recorded over an existing non-directory path is rejected', async () => {
  const gz = buildV5Archive([
    fileEntry('plugins', 'a', Buffer.from('abc')),
    fileEntry('plugins', 'a/b.txt', Buffer.from('abc')),
  ])
  const file = join(tmpdir(), `v5-conflict-${Date.now()}.gz`)
  writeFileSync(file, gz)
  try {
    await rejects(() => readV5Backup(file), /PATH_TYPE_CONFLICT/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('probe verdict fails and aggregates errors when list() throws mid-run', async () => {
  // Reviewer counterexample: both session probes throw at list() AFTER the
  // file was placed; the aggregate must not read 6/6 + error:null.
  const dir = mkdtempSync(join(tmpdir(), 'p0-verdict-'))
  try {
    const payload = Buffer.from('abc')
    const gz = buildV5Archive([fileEntry('sessions', 'x.txt', payload, 'sessions')])
    const bytesDir = join(dir, 'bytes')
    mkdirSync(join(bytesDir, 'remapped', 'session-x'), { recursive: true })
    writeFileSync(join(bytesDir, 'remapped', 'session-x', 'session.v4.jsonl.zstd'), gz)
    const entryMeta = id => ({ id, relDir: id, cwdOriginal: '/a', cwdMapped: '/b', eventCount: 1, eventsSha256: createHash('sha256').update(JSON.stringify([{ seq: 0 }])).digest('hex') })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      entries: [entryMeta('session-x'), entryMeta('session-y')],
    }))
    for (const id of ['session-x', 'session-y']) {
      mkdirSync(join(bytesDir, 'remapped', id), { recursive: true })
      writeFileSync(join(bytesDir, 'remapped', id, 'session.v4.jsonl.zstd'), gz)
    }
    process.env.DSHA_MIGRATOR_P0_B_MANIFEST = join(dir, 'manifest.json')
    process.env.DSHA_MIGRATOR_P0_B_BYTES = bytesDir
    process.env.DSHA_MIGRATOR_P0_B_MODE = 'remapped'
    mkdirSync(join(dir, 'located', 'session-x'), { recursive: true })
    mkdirSync(join(dir, 'located', 'session-y'), { recursive: true })
    let listCalls = 0
    const persistence = {
      locate: (meta) => ({ kind: 'jsonl', path: join(dir, 'located', meta.id, 'session.v4.jsonl.zstd') }),
      list: async () => {
        listCalls += 1
        throw new Error(`list exploded (call ${listCalls})`)
      },
      open: async () => ({ read: async () => ({ events: [{ seq: 0 }] }), header: {}, close: async () => {} }),
      stat: async () => ({ formatStatus: 'current' }),
    }
    const registry = {
      create: async () => ({
        attachSession: async id => {
          if (id === 'session-y') return // workspace attach: first session only
          throw new TypeError('Workspace path is not fully qualified')
        },
      }),
    }
    const r = await runWriteProbeB({ sessionPersistence: persistence, workspaceRegistry: registry }, { root: join(dir, 'sessions') })
    assert.equal(r.verdict, 'failed', 'aggregate verdict must be failed')
    assert.ok(r.error, 'aggregate error must surface sub-probe failures')
    assert.ok(r.pass < r.total, `must not read as a full pass (${r.pass}/${r.total})`)
    const sessionProbes = r.probes.filter(p => p.name === 'b-placement-remapped')
    assert.equal(sessionProbes.length, 2)
    for (const p of sessionProbes) {
      assert.equal(p.verdict, 'failed')
      assert.match(p.error ?? '', /list exploded/)
    }
  } finally {
    delete process.env.DSHA_MIGRATOR_P0_B_MANIFEST
    delete process.env.DSHA_MIGRATOR_P0_B_BYTES
    delete process.env.DSHA_MIGRATOR_P0_B_MODE
    rmSync(dir, { recursive: true, force: true })
  }
})
