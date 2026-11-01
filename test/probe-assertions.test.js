// Negative controls for the P0 probes (review §2): with a persistence mock
// where every read fails, the probes must report failing assertions — never a
// green pass. The B path must not report 10/10 when visibility, counts and
// hashes are all wrong; the A path must not pass on an empty readback.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWriteProbeA } from '../lib/p0/write-probe.js'
import { runWriteProbeB } from '../lib/p0/write-probe-b.js'

function failingPersistence() {
  return {
    locate: () => ({ kind: 'jsonl', path: '/tmp/mock/p0-capability-probe/session.v4.jsonl.zstd' }),
    create: async () => {
      throw new Error('SessionAlreadyExistsError (mock)')
    },
    list: async () => [],
    open: async () => ({ read: async () => ({ events: [] }), header: {}, close: async () => {} }),
    stat: async () => undefined,
    flush: async () => {},
  }
}

const mockCtx = (persistence) => ({
  sessionPersistence: persistence,
  workspaceRegistry: {
    create: async () => {
      throw new Error('workspaceRegistry unavailable (mock)')
    },
  },
})

test('B probe reports failing assertions, never a fake full pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p0-b-mock-'))
  try {
    const manifest = join(dir, 'manifest.json')
    const bytesDir = join(dir, 'bytes')
    writeFileSync(manifest, JSON.stringify({
      entries: [{ id: 'mock-session-1', relDir: 'x', cwdOriginal: '/a', cwdMapped: '/b', eventCount: 5, eventsSha256: 'deadbeef' }],
    }))
    mkdirSync(join(bytesDir, 'remapped', 'mock-session-1'), { recursive: true })
    writeFileSync(join(bytesDir, 'remapped', 'mock-session-1', 'session.v4.jsonl.zstd'), 'MOCK')
    process.env.DSHA_MIGRATOR_P0_B_MANIFEST = manifest
    process.env.DSHA_MIGRATOR_P0_B_BYTES = bytesDir
    process.env.DSHA_MIGRATOR_P0_B_MODE = 'remapped'

    const r = await runWriteProbeB(mockCtx({
      ...failingPersistence(),
      locate: () => ({ kind: 'jsonl', path: join(dir, 'located', 'session.v4.jsonl.zstd') }),
    }), { root: join(dir, 'sessions') })
    assert.ok(r.total > 0, 'probe must score steps')
    assert.ok(r.pass < r.total, `probe must not fake a full pass (got ${r.pass}/${r.total})`)
    const probe = r.probes.find(p => p.total > 0)
    assert.equal(probe.steps.list.ok, false)
    assert.equal(probe.steps.readback.ok, false)
    assert.equal(probe.steps.stat.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DSHA_MIGRATOR_P0_B_MANIFEST
    delete process.env.DSHA_MIGRATOR_P0_B_BYTES
  }
})

test('A probe does not pass when the readback is empty and the list hides the session', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p0-a-mock-'))
  process.env.DSHA_MIGRATOR_P0_CWD = join(tmp, 'probe-cwd')
  // Even the happy path up to create() is broken in this mock: create()
  // resolves with a handle but nothing is visible afterwards. Model it with a
  // persistence whose create returns a dummy handle and every read fails.
  const p = failingPersistence()
  p.create = async () => ({ access: 'write', inheritedEventCount: 0, flush: async () => {}, close: async () => {} })
  const ctx = mockCtx(p)
  const svc = {
    sessionPersistence: p,
    workspaceRegistry: ctx.workspaceRegistry,
  }
  const r = await runWriteProbeA(svc, { root: '/tmp/mock-sessions' })
  const empty = r.probes.find(x => x.name === 'empty-session' && x.total > 0)
  assert.ok(empty, 'empty-session probe must be scored')
  assert.ok(empty.pass < empty.total, `empty probe must fail honestly (got ${empty.pass}/${empty.total})`)
  assert.equal(empty.steps.list.ok, false)
  assert.equal(empty.steps.stat.ok, false)
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.DSHA_MIGRATOR_P0_CWD
})
