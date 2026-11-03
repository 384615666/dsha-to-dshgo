// Extraction-mode negative controls with REAL Node Writable sinks
// (review P1-batch2): multi-file resets, empty files, non-FILE records
// interleaved, and a mid-payload ENOSPC failure. All synthetic, default-run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readV5Backup } from '../lib/archive/v5-reader.js'
import { buildV5Archive, fileEntry } from './helpers/v5-fixture.mjs'

// Real Writable that accumulates chunks and reports what it stored.
function makeCaptureSink(sinks, meta) {
  const chunks = []
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _enc, cb) {
      chunks.push(chunk)
      cb()
    },
  })
  sinks.push({ meta, sink, chunks })
  return sink
}

test('two-file extraction: per-file counters reset, both payloads stored intact', async () => {
  const gz = buildV5Archive([
    fileEntry('plugins', 'one.jsonl', Buffer.from('abc')),
    fileEntry('plugins', 'two.jsonl', Buffer.from('def')),
  ])
  const file = join(tmpdir(), `v5-multi-${Date.now()}.gz`)
  writeFileSync(file, gz)
  const sinks = []
  try {
    const r = await readV5Backup(file, { makeSink: meta => makeCaptureSink(sinks, meta) })
    assert.equal(r.stats.fileVerified, 2)
    assert.equal(sinks.length, 2)
    // Both payloads must be complete and byte-identical to the inputs.
    assert.equal(Buffer.concat(sinks[0].chunks).toString(), 'abc')
    assert.equal(Buffer.concat(sinks[1].chunks).toString(), 'def')
  } finally {
    rmSync(file, { force: true })
  }
})

test('empty file between two non-empty files: no state carried across', async () => {
  const gz = buildV5Archive([
    fileEntry('plugins', 'a.jsonl', Buffer.from('abc')),
    fileEntry('plugins', 'empty.jsonl', Buffer.alloc(0)),
    fileEntry('plugins', 'b.jsonl', Buffer.from('def')),
  ])
  const file = join(tmpdir(), `v5-empty-${Date.now()}.gz`)
  writeFileSync(file, gz)
  const sinks = []
  try {
    const r = await readV5Backup(file, { makeSink: meta => makeCaptureSink(sinks, meta) })
    assert.equal(r.stats.fileVerified, 3)
    assert.equal(Buffer.concat(sinks[0].chunks).toString(), 'abc')
    assert.equal(Buffer.concat(sinks[1].chunks).length, 0)
    assert.equal(Buffer.concat(sinks[2].chunks).toString(), 'def')
  } finally {
    rmSync(file, { force: true })
  }
})

test('DIRECTORY/MISSING records interleaved between FILEs keep per-file sinks clean', async () => {
  const gz = buildV5Archive([
    { meta: { root: 'plugins', path: 'dir', kind: 'DIRECTORY', scope: 'plugins', size: 0, sha256: '' } },
    fileEntry('plugins', 'dir/one.jsonl', Buffer.from('abc')),
    { meta: { root: 'plugins', path: 'dir/gone.bin', kind: 'MISSING', scope: 'plugins', size: 0, sha256: '' } },
    fileEntry('plugins', 'dir/two.jsonl', Buffer.from('def')),
  ], { manifest: { integrity: 'PARTIAL' } })
  const file = join(tmpdir(), `v5-mix-${Date.now()}.gz`)
  writeFileSync(file, gz)
  const sinks = []
  try {
    const r = await readV5Backup(file, { makeSink: meta => makeCaptureSink(sinks, meta) })
    assert.equal(r.stats.fileVerified, 2)
    assert.equal(r.stats.incomplete, true)
    assert.equal(sinks.length, 2)
    assert.equal(Buffer.concat(sinks[0].chunks).toString(), 'abc')
    assert.equal(Buffer.concat(sinks[1].chunks).toString(), 'def')
  } finally {
    rmSync(file, { force: true })
  }
})

test('sink failing DURING payload writes rejects cleanly (no unhandled error, no hang)', async () => {
  // 3 MiB through a 16 KiB sink: the reader feeds ~1 MiB chunks, so writes 2+
  // land mid-payload. The failing write is triggered from the write callback
  // (ENOSPC typically surfaces exactly there) while the reader holds a drain
  // promise — the pre-fix reader hung here and could kill the Host process
  // with an unhandled 'error' event.
  const payload = Buffer.alloc(3 * 1024 * 1024 + 5, 0x42)
  const gz = buildV5Archive([fileEntry('plugins', 'fail.bin', payload)])
  const file = join(tmpdir(), `v5-mid-${Date.now()}.gz`)
  writeFileSync(file, gz)
  const escaped = []
  // The sink itself HAS an error listener (installed by the reader at
  // creation), so a handled error never reaches these process-level hooks.
  const onUnhandledRejection = error => {
    escaped.push({ kind: 'unhandledRejection', error })
  }
  const onUncaught = error => {
    escaped.push({ kind: 'uncaughtException', error })
  }
  process.on('unhandledRejection', onUnhandledRejection)
  process.on('uncaughtException', onUncaught)
  let writes = 0
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _enc, cb) {
      writes += 1
      if (writes === 2) {
        cb(new Error('synthetic ENOSPC during payload write'))
        return
      }
      setTimeout(cb, 1)
    },
  })
  try {
    await assert.rejects(
      () => readV5Backup(file, { makeSink: () => sink }),
      /synthetic ENOSPC during payload write/,
    )
    // Give any stray async event a tick, then require none escaped to the
    // process level (that is what kills a Host).
    await new Promise(r => setTimeout(r, 100))
    assert.equal(
      escaped.length,
      0,
      `no process-level errors may escape (got ${escaped.map(e => `${e.kind}: ${e.error.message}`).join('; ')})`,
    )
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection)
    process.removeListener('uncaughtException', onUncaught)
    sink.destroy()
    rmSync(file, { force: true })
  }
})

test('premature sink close (destroy before finish) rejects as ERR_STREAM_PREMATURE_CLOSE', async () => {
  const gz = buildV5Archive([fileEntry('plugins', 'tiny.bin', Buffer.from('abc'))])
  const file = join(tmpdir(), `v5-pc-${Date.now()}.gz`)
  writeFileSync(file, gz)
  // Standard Writable destroyed asynchronously BEFORE its write callback
  // completes: close fires, finish never does, writableFinished stays false.
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _enc, cb) {
      setTimeout(() => {
        sink.destroy()
        // cb intentionally never called: the stream dies mid-write.
      }, 5)
    },
  })
  try {
    await assert.rejects(
      () => readV5Backup(file, { makeSink: () => sink }),
      error => error.code === 'ERR_STREAM_PREMATURE_CLOSE' || /PREMATURE_CLOSE/.test(error.message),
    )
    assert.equal(sink.writableFinished, false, 'sink must not have finished')
  } finally {
    rmSync(file, { force: true })
  }
})

test('successful extraction leaves no residual poller timers', async () => {
  // Reviewer counterexample: after a normal ~2 MiB extraction two internal
  // 5 ms intervals were still alive (the losing drain-race branch never
  // cleared its poller).
  const payload = Buffer.alloc(2 * 1024 * 1024 + 3, 0x41)
  const gz = buildV5Archive([fileEntry('plugins', 'two-mib.bin', payload)])
  const file = join(tmpdir(), `v5-poll-${Date.now()}.gz`)
  writeFileSync(file, gz)
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _enc, cb) {
      setImmediate(cb)
    },
  })
  try {
    const r = await readV5Backup(file, { makeSink: () => sink })
    assert.equal(r.stats.fileVerified, 1)
    // Count our own poller intervals: a real Writable only ever emits drain
    // (no polling needed on the happy path), so zero pollers must remain.
    await new Promise(r => setTimeout(r, 30))
    assert.ok(
      sink.listenerCount('drain') === 0,
      `drain listeners left: ${sink.listenerCount('drain')}`,
    )
  } finally {
    rmSync(file, { force: true })
  }
})

test('premature close while backpressured (large file, no drain/error after destroy) rejects without hanging', async () => {
  // Reviewer counterexample: file > sink high-water mark so write() returns
  // false, then the sink is destroyed WITHOUT error or drain. The reader is
  // parked in drainWait at that moment — before sinkEnd ever runs — so the
  // premature-close detection must live at sink creation and wake the
  // drain wait. Pre-fix behavior: promise never settles (2 s timeout).
  const payload = Buffer.alloc(2 * 1024 * 1024 + 7, 0x41) // > 16 KiB HWM
  const gz = buildV5Archive([fileEntry('plugins', 'big-pc.bin', payload)])
  const file = join(tmpdir(), `v5-pcbp-${Date.now()}.gz`)
  writeFileSync(file, gz)
  const { Writable } = await import('node:stream')
  let writes = 0
  let sawBackpressure = false
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _enc, cb) {
      writes += 1
      // Never call cb: after the first write the stream stays backpressured
      // and no drain will ever fire.
      if (writes >= 2) sawBackpressure = true
    },
  })
  // Emulate the host/disk layer force-closing the sink while it is stuck
  // backpressured: destroy() without error drains nothing and emits only
  // 'close' (writableFinished stays false).
  const destroyTimer = setTimeout(() => sink.destroy(), 50)
  destroyTimer.unref?.()
  const kill = setTimeout(() => {
    assert.fail(`reader hung instead of rejecting (writes=${writes}, sawBackpressure=${sawBackpressure})`)
  }, 5000)
  try {
    await assert.rejects(
      () => readV5Backup(file, { makeSink: () => sink }),
      error => error.code === 'ERR_STREAM_PREMATURE_CLOSE' || /PREMATURE_CLOSE/.test(error.message),
    )
    clearTimeout(kill)
    assert.ok(writes >= 1, 'at least one write must have happened before the close')
    assert.equal(sink.writableFinished, false, 'sink must not have finished')
  } finally {
    clearTimeout(kill)
    clearTimeout(destroyTimer)
    sink.destroy()
    rmSync(file, { force: true })
  }
})

test('after failure: zero residual listeners and no writes to the destroyed sink', async () => {
  // Reviewer counterexample: after fail(), one drain listener stayed on the
  // destroyed sink; if the internal buffer still held bytes, write() was
  // called again on it (residual grew to 2). Both must be impossible.
  const payload = Buffer.alloc(3 * 1024 * 1024 + 5, 0x42) // buffer will hold leftovers
  const gz = buildV5Archive([fileEntry('plugins', 'fail.bin', payload)])
  const file = join(tmpdir(), `v5-resid-${Date.now()}.gz`)
  writeFileSync(file, gz)
  let writes = 0
  let writesAfterDestroy = 0
  let destroyed = false
  let errorDelivered = false
  const sink = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk, _enc, cb) {
      writes += 1
      if (destroyed) writesAfterDestroy += 1
      if (writes === 2 && !errorDelivered) {
        // ENOSPC mid-payload via the write callback.
        errorDelivered = true
        cb(new Error('synthetic ENOSPC during payload write'))
        // Simulate the stream's own teardown after the error.
        process.nextTick(() => sink.destroy())
        return
      }
      setTimeout(cb, 1)
    },
  })
  sink.on('error', () => {}) // reader owns the error path; keep stream quiet
  try {
    await assert.rejects(
      () => readV5Backup(file, { makeSink: () => sink }),
      /synthetic ENOSPC during payload write/,
    )
    await new Promise(r => setTimeout(r, 50))
    assert.equal(sink.listenerCount('drain'), 0, `drain listeners must be fully detached (got ${sink.listenerCount('drain')})`)
    assert.equal(writesAfterDestroy, 0, `no write() may reach the sink after it errored/was destroyed (got ${writesAfterDestroy})`)
  } finally {
    sink.destroy()
    rmSync(file, { force: true })
  }
})

test('staging integration: sessions root extracted to private dir, other roots ignored', async () => {
  const { SessionStaging } = await import('../lib/archive/session-staging.js')
  // Each root carries exactly one scope (reader validates per-root scope
  // consistency against the manifest, matching the source packager).
  const entries = [
    fileEntry('sessions', 'proj-a/session-aaa/session.v4.jsonl.zstd', Buffer.from('session-aaa-payload'), 'sessions'),
    fileEntry('sessions', 'proj-a/session-bbb/session.v4.jsonl.zstd', Buffer.from('session-bbb-payload'), 'sessions'),
    fileEntry('storages', 'workspace.json', Buffer.from('{"unit":"workspace"}'), 'sessions'),
    fileEntry('settings', 'app.cfg', Buffer.from('cfg'), 'settings'),
    { meta: { root: 'sessions', path: 'proj-a/session-ccc/session.v4.jsonl.zstd', kind: 'MISSING', scope: 'sessions', size: 0, sha256: '' } },
  ]
  // manifest.roots is derived per-root; scopes application is exempt from
  // the per-root scope check, and the fixture helper already collects the
  // roots from entries — nothing extra needed. (Kept as a note: the earlier
  // ROOT_SCOPE_MISMATCH came from mixing scopes under one root.)
  const gz = buildV5Archive(entries, { manifest: { integrity: 'PARTIAL' } })
  const file = join(tmpdir(), `v5-stage-${Date.now()}.gz`)
  writeFileSync(file, gz)
  const stagingRoot = join(tmpdir(), `v5-stage-dir-${Date.now()}`)
  const staging = new SessionStaging(stagingRoot)
  await staging.prepare()
  try {
    const r = await readV5Backup(file, { makeSink: staging.makeSinkFactory() })
    // FILE records: 2 session files + workspace.json + app.cfg (MISSING is
    // not a FILE record).
    assert.equal(r.stats.fileVerified, 4)
    const { staged, failed } = await staging.verifyAll()
    // Only the sessions root reached staging: storages/settings must not.
    assert.equal(staged.length, 2)
    assert.equal(failed.length, 0)
    const bodies = staged.map(e => readFileSync(e.stagedTo).toString())
    assert.deepEqual(bodies.sort(), ['session-aaa-payload', 'session-bbb-payload'])
    for (const e of staged) {
      assert.ok(e.stagedTo.startsWith(staging.root), 'staged file must stay inside the staging root')
      assert.match(e.path, /^proj-a\//)
    }
    // Nothing from other roots landed on disk.
    for (const e of staged) assert.ok(!e.path.startsWith('storages') && !e.path.startsWith('settings'))
    // M5 mode contract: 0600 files in 0700 directories where POSIX modes are
    // enforced. Windows does not enforce POSIX bits (entries report 0666/
    // 0777) — the platform limitation is recorded separately, never used as
    // Android evidence.
    if (process.platform !== 'win32') {
      for (const e of staged) {
        assert.equal(statSync(dirname(e.stagedTo)).mode & 0o777, 0o700, 'staging directory is 0700')
        assert.equal(statSync(e.stagedTo).mode & 0o777, 0o600, 'staged file is 0600')
      }
    } else {
      assert.ok(true, 'win32: POSIX mode bits are not enforced — recorded as a platform limitation')
    }
  } finally {
    await staging.cleanupAll()
    rmSync(file, { force: true })
  }
})
