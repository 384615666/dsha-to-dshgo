// Debug: R3 orchestrator scenario — highest-generation selection, v3-only
// child-bound routing, same-generation ambiguity, corrupt highest (no
// fallback), header-id binding refusal.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { buildV5Archive, fileEntry } from '../test/helpers/v5-fixture.mjs'
import { inspectSessions } from '../lib/inspect-sessions.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const req = createRequire(process.env.RC4_MODULES + '/noop.js')
const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
await setModuleLoader(async () => ({
  cat: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href),
  v3: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
}))

const mk = (t, id) => Buffer.from(JSON.stringify({
  type: 'session', version: t, id, createdAt: 1, cwd: '/w', delegationDepth: 0, isSeeded: t >= 3 ? false : undefined,
}) + '\n')

const dir = mkdtempSync(join(tmpdir(), 'dbg11-'))
const gz = buildV5Archive([
  fileEntry('sessions', 'proj/s-v4/session.v4.jsonl.zstd', zlib.zstdCompressSync(mk(4, 's-v4')), 'sessions'),
  fileEntry('sessions', 'proj/s-v0/session.jsonl', mk(0, 's-v0'), 'sessions'),
  // Highest generation wins; v3 discarded without restore.
  fileEntry('sessions', 'proj/s-mix/session.v3.jsonl', mk(3, 's-mix'), 'sessions'),
  fileEntry('sessions', 'proj/s-mix/session.v4.jsonl', mk(4, 's-mix'), 'sessions'),
  // v3-only: exercises the historical → child-bound routing to reach v4.
  fileEntry('sessions', 'proj/s-v3only/session.v3.jsonl', mk(3, 's-v3only'), 'sessions'),
  // Same-generation twins (plain + zstd) → ambiguous, isolated.
  fileEntry('sessions', 'proj/s-amb/session.v4.jsonl', mk(4, 's-amb'), 'sessions'),
  fileEntry('sessions', 'proj/s-amb/session.v4.jsonl.zstd', zlib.zstdCompressSync(mk(4, 's-amb')), 'sessions'),
  // Corrupt highest: garbage zstd bytes → refused, must NOT fall back to v3.
  fileEntry('sessions', 'proj/s-corrupt/session.v4.jsonl.zstd', Buffer.from('not-zstd-at-all'), 'sessions'),
  fileEntry('sessions', 'proj/s-corrupt/session.v3.jsonl', mk(3, 's-corrupt'), 'sessions'),
  // Header id disagrees with the directory name → binding refusal.
  fileEntry('sessions', 'proj/s-wrong/session.v4.jsonl', mk(4, 's-elsewhere'), 'sessions'),
])
const backup = join(dir, 'b.gz')
writeFileSync(backup, gz)
const r = await inspectSessions(backup, { stagingRoot: join(dir, 'staging') })
console.log(JSON.stringify({
  archiveVerified: r.archive?.fileVerified,
  ambiguous: r.ambiguous,
  sessions: r.sessions.map(s => ({ id: s.id, status: s.status, gen: s.sourceGeneration, importable: s.importable ?? null, err: (s.error || '').slice(0, 90) })),
  counts: r.counts,
}, null, 1))
rmSync(dir, { recursive: true, force: true })
process.exit(0)
