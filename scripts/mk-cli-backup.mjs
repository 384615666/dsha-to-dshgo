// Scratch: build a synthetic multi-scenario v5 backup and print its path.
import { buildV5Archive, fileEntry } from '../test/helpers/v5-fixture.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const mk = (t, id) => Buffer.from(JSON.stringify({
  type: 'session', version: t, id, createdAt: 1, cwd: '/w', delegationDepth: 0, isSeeded: t >= 3 ? false : undefined,
}) + '\n')
const gz = buildV5Archive([
  fileEntry('sessions', '--w--/s-v4/session.v4.jsonl.zstd', zlib.zstdCompressSync(mk(4, 's-v4')), 'sessions'),
  fileEntry('sessions', '--w--/s-v0/session.jsonl', mk(0, 's-v0'), 'sessions'),
  fileEntry('sessions', '--w--/s-mix/session.v3.jsonl', mk(3, 's-mix'), 'sessions'),
  fileEntry('sessions', '--w--/s-mix/session.v4.jsonl', mk(4, 's-mix'), 'sessions'),
  fileEntry('sessions', '--w--/s-v3only/session.v3.jsonl', mk(3, 's-v3only'), 'sessions'),
])
const dir = mkdtempSync(join(tmpdir(), 'cli-bk-'))
const p = join(dir, 'b.gz')
writeFileSync(p, gz)
console.log(p)
