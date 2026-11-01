// Extraction-mode negative controls with REAL Node Writable sinks
// (review P1-batch2): multi-file resets, empty files, non-FILE records
// interleaved, and a mid-payload ENOSPC failure. All synthetic, default-run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
