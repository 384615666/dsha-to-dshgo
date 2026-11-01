// Migration-chain tests against the installed official rc.4 format packages.
// Resolution: RC4_MODULES env var pointing at a node_modules directory that
// carries @deepseek-ai/dsh-session-format-* (dev machines have this from the
// P0 probe environment); production loads them from the host engine.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir

async function loadChain() {
  const chain = await import('../lib/migration/legacy-chain.js')
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const catPath = pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href
  const v3Path = pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href
  await chain.setModuleLoader(async () => ({
    cat: await import(catPath),
    v3: await import(v3Path),
  }))
  return chain
}

// A minimal legal current (v4) header + one user message event, matching the
// shapes the real rc.4 restore accepts (see real-backup-sample-report).
// Legal event shape taken from DSHA/tools/test-dsh-sessions.mjs via the P0
// probe's verified control (accepted by rc.4 strict/current).
function v4Fixture(id) {
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1793500000000,
    cwd: '/tmp/proj',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const rows = [
    e('turn/start', 0, { turn: 1 }),
    e('user/message', 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '保留这句话' }] }, { surfaceOp: 'append' }),
    e('step/start', 2, { turn: 1, step: 1 }),
    e('step/end', 3, { turn: 1, step: 1 }),
    e('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]
  return { header, rows }
}

test('classify: current v4 header classifies as current', async () => {
  if (skip) return
  const { classifyHeader } = await loadChain()
  const f = v4Fixture('session-cls-1')
  const cls = await classifyHeader(f.header)
  assert.equal(cls.status, 'current')
  assert.equal(cls.storedVersion, 4)
})

test('classify: unknown future version is LEGACY_HEADER_UNSUPPORTED', async () => {
  if (skip) return
  const { classifyHeader, migrateToV4, LEGACY_CODES } = await loadChain()
  const f = v4Fixture('session-cls-2')
  // readHeader classifies without throwing; migrateToV4 turns 'unsupported'
  // into LEGACY_HEADER_UNSUPPORTED.
  const cls = await classifyHeader({ ...f.header, version: 9 })
  assert.equal(cls.status, 'unsupported')
  assert.equal(cls.storedVersion, 9)
  await assert.rejects(
    () => migrateToV4({ ...f.header, version: 9 }, []),
    error => error.code === LEGACY_CODES.HEADER_UNSUPPORTED && error.details.storedVersion === 9,
  )
})

test('classify: malformed header is LEGACY_HEADER_UNSUPPORTED', async () => {
  if (skip) return
  const { classifyHeader, migrateToV4, LEGACY_CODES } = await loadChain()
  const cls = await classifyHeader({ type: 'session', version: 4, id: 'x' }) // missing fields
  assert.equal(cls.status, 'malformed')
  await assert.rejects(
    () => migrateToV4({ type: 'session', version: 4, id: 'x' }, []),
    error => error.code === LEGACY_CODES.HEADER_UNSUPPORTED,
  )
})

test('v4 restore + canonical encode + round-trip self-check passes', async () => {
  if (skip) return
  const { migrateToV4 } = await loadChain()
  const f = v4Fixture('session-rt-1')
  const out = await migrateToV4(f.header, f.rows, { childFacts: null })
  assert.equal(out.sourceVersion, 4)
  assert.equal(out.eventRows.length, 5)
  assert.equal(out.inheritedEventCount, 0)
})

test('v4 restore with a bad row is LEGACY_ROW_DECODE_FAILED', async () => {
  if (skip) return
  const { migrateToV4, LEGACY_CODES } = await loadChain()
  const f = v4Fixture('session-badrow')
  const badRows = [{ ...f.rows[0], seq: 5 }, ...f.rows.slice(1)] // gap at start
  await assert.rejects(
    () => migrateToV4(f.header, badRows, { childFacts: null }),
    error => {
      assert.equal(error.code, LEGACY_CODES.ROW_DECODE_FAILED)
      assert.equal(error.details.row, 0)
      return true
    },
  )
})

test('v3 header goes through the historical catalog', async () => {
  if (skip) return
  const { classifyHeader } = await loadChain()
  const f = v4Fixture('session-v3')
  const v3Header = { ...f.header, version: 3 }
  const cls = await classifyHeader(v3Header)
  // Historical catalog with no events restored: classification is by header
  // only. A header-only classification of a complete v3 header is 'current'
  // (for the historical catalog, current means "valid at v3").
  assert.ok(['current', 'migration-required'].includes(cls.status), `status ${cls.status}`)
})
