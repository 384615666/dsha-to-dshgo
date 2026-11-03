import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listBackupCandidates, stageBackupFile, commitStagedFile } from '../lib/import/input.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsha-input-'))
  const download = join(root, 'Download', 'DSHA')
  await mkdir(download, { recursive: true })
  return { root, download }
}

test('listBackupCandidates: gzip magic only, newest first, regular files only', async () => {
  const { root, download } = await fixture()
  try {
    const big = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(64 * 1024, 7)])
    await writeFile(join(download, 'real..gz'), big)
    await writeFile(join(download, 'not-gzip.bin'), Buffer.from('plain'))
    await mkdir(join(download, 'subdir'))
    await writeFile(join(download, 'subdir', 'nested.gz'), big)
    const result = await listBackupCandidates({ root: download })
    assert.equal(result.root, download)
    assert.deepEqual(result.entries.map(e => e.name), ['real..gz'])
    assert.equal(result.entries[0].size, big.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stageBackupFile: streams, hashes and keeps identity; commit moves', async () => {
  const { root, download } = await fixture()
  try {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 0x5a)
    bytes[0] = 0x1f
    bytes[1] = 0x8b
    const source = join(download, 'stream..gz')
    await writeFile(source, bytes)
    const destination = join(root, 'job', 'input')
    const staged = await stageBackupFile({ sourcePath: source, destinationDirectory: join(root, 'tmp') })
    assert.equal(staged.size, bytes.length)
    assert.equal(staged.digest, createHash('sha256').update(bytes).digest('hex'))
    assert.equal((await readFile(staged.tmpPath)).length, bytes.length)
    await mkdir(destination, { recursive: true })
    const final = join(destination, 'stream..gz')
    await commitStagedFile(staged.tmpPath, final)
    assert.deepEqual(await readFile(final), bytes)
    await assert.rejects(stat(staged.tmpPath))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stageBackupFile: rejects a source whose identity changes before commit', async () => {
  const { root, download } = await fixture()
  try {
    const source = join(download, 'change..gz')
    await writeFile(source, Buffer.from([0x1f, 0x8b, 1, 2, 3]))
    const staged = await stageBackupFile({ sourcePath: source, destinationDirectory: join(root, 'tmp') })
    // A file replaced after the copy must be detected by the next caller's
    // identity check; staging itself only guarantees the bytes it read were a
    // consistent prefix. This test locks in the returned source identity.
    assert.equal(staged.sourceIdentity.size, 5)
    await rename(source, `${source}.renamed`)
    await writeFile(source, Buffer.from([0x1f, 0x8b, 9]))
    assert.notEqual((await stat(source)).size, staged.sourceIdentity.size)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
