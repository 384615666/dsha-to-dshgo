// P2 M5: cleanup terminal states + the publishable-package gate.
//
// Success-path cleanup is covered by the F3 CLI test (sentinel container).
// This file adds the FAILURE terminal (no staging leftovers, truthful
// receipt, caller container untouched) and the package manifest/leak check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const bin = join(import.meta.dirname, '..', 'bin', 'inspect.mjs')

test('P2 M5 cleanup: a FAILED inspection verifies staging removal and never touches the caller container', async () => {
  const container = mkdtempSync(join(tmpdir(), 'm5-cli-fail-'))
  try {
    const sentinel = join(container, 'sentinel.txt')
    writeFileSync(sentinel, 'caller-owned')
    const missing = join(container, 'does-not-exist.dshbak')
    const env = { ...process.env }
    delete env.RC4_MODULES
    const child = spawnSync(process.execPath, [bin, missing, '--staging-root', container], {
      encoding: 'utf8',
      timeout: 120_000,
      env,
    })
    assert.equal(child.status, 1, `a failed archive must exit 1 (stderr: ${child.stderr?.slice(0, 200)})`)
    const out = JSON.parse(child.stdout)
    assert.equal(out.archiveFailed, true)
    assert.equal(out.staging.cleanedUp, true, 'the receipt may claim cleanup only after verified removal')
    assert.ok(!out.staging.cleanupError, String(out.staging.cleanupError ?? ''))
    assert.equal(readFileSync(sentinel, 'utf8'), 'caller-owned', 'the caller container is never recursively cleaned')
    assert.deepEqual(readdirSync(container).filter(n => n.startsWith('job-')), [], 'no job staging directory survives')
  } finally {
    rmSync(container, { recursive: true, force: true })
  }
})

test('P2 M5 package gate: allowlisted files only, <50 MiB, no install scripts, no private markers', async () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'check-package.mjs')
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 180_000 })
  assert.equal(child.status, 0, `package gate failed:\n${child.stdout}\n${child.stderr}`)
  const result = JSON.parse(child.stdout)
  assert.equal(result.ok, true)
  assert.ok(result.files >= 20, 'the runtime package really ships the implementation')
  assert.ok(result.unpackedBytes < 50 * 1024 * 1024)
  assert.deepEqual(result.problems, [])
})
