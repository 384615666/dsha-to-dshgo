// v5 streaming reader tests. Fixtures are PRIVATE (real backup derivatives)
// and live outside the repository; point the env vars at them locally:
//   DSHA_V5_REAL      — the user's real backup (positive)
//   DSHA_V5_FIXTURES  — directory with valid-large..gz / corrupt-digest..gz /
//                       truncated..gz / and the padded-README sample
// Without these the suite skips (the repo itself never carries chat data).
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readV5Backup } from '../lib/archive/v5-reader.js'

const REAL = process.env.DSHA_V5_REAL
const FIX = process.env.DSHA_V5_FIXTURES

test('real backup verifies fully', { skip: !REAL || !existsSync(REAL) }, async () => {
  const r = await readV5Backup(REAL)
  assert.equal(r.manifest.formatVersion, 5)
  assert.equal(r.manifest.operation, 'EXPORT')
  assert.equal(r.stats.fileEntries, r.manifest.entries - 33) // 181 files of 214 records
  assert.equal(r.stats.fileVerified, r.stats.fileEntries)
  assert.equal(r.stats.fileFailures, 0)
  assert.ok(r.stats.readmeBytes <= r.limits.maxReadmeBytes)
})

test('valid large sample (>8 MiB, legal README) verifies fully', { skip: !FIX || !existsSync(join(FIX, 'valid-large..gz')) }, async () => {
  const r = await readV5Backup(join(FIX, 'valid-large..gz'))
  assert.equal(r.manifest.formatVersion, 5)
  assert.equal(r.stats.fileFailures, 0)
  assert.equal(r.stats.fileVerified, r.stats.fileEntries)
  assert.ok(r.stats.readmeBytes <= r.limits.maxReadmeBytes)
})

test('corrupt per-FILE digest rejects', { skip: !FIX || !existsSync(join(FIX, 'corrupt-digest..gz')) }, async () => {
  await assert.rejects(() => readV5Backup(join(FIX, 'corrupt-digest..gz')), /sha256 mismatch/)
})

test('truncated container rejects', { skip: !FIX || !existsSync(join(FIX, 'truncated..gz')) }, async () => {
  await assert.rejects(() => readV5Backup(join(FIX, 'truncated..gz')), /truncated|mismatch|ended|gzip layer/i)
})

test('oversized README rejects (source v5 limit)', { skip: !FIX || !existsSync(join(FIX, '..', 'DSHA-data-v5-synth-large-8mib..gz')) }, async () => {
  await assert.rejects(() => readV5Backup(join(FIX, '..', 'DSHA-data-v5-synth-large-8mib..gz')), /README\.txt is .* over the source v5 limit/)
})
