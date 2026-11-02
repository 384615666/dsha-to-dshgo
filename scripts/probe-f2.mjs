// Probe: F2/F4/F5/F6 orchestrator behaviors against the rewritten pipeline.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { buildV5Archive, fileEntry } from '../test/helpers/v5-fixture.mjs'
import { inspectSessions, readSessionFile } from '../lib/inspect-sessions.js'
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

const req2 = createRequire(process.env.RC4_MODULES + '/noop.js')
const v23 = await import(pathToFileURL(req2.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
const codec = v23.releasedV3SessionFormatCodec

const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
const logical = id => [
  e('turn/start', 0, { turn: 1 }),
  e('user/message', 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `content-${id}` }] }, { surfaceOp: 'append' }),
  e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
]
const encodeSession = (id, extraHeader = {}) => {
  const header = codec.encodeHeader({ version: 3, id, createdAt: 1793500000000, cwd: '/w', isSeeded: false, delegationDepth: 0, ...extraHeader }, 0)
  const rows = logical(id).map(ev => codec.encodeEvent(ev))
  return Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n')])
}

const dir = mkdtempSync(join(tmpdir(), 'probe-f2-'))
try {
  // Scenario A: v3 parent + v3 subagent child with descriptor + unrelated child of another parent.
  const childRows = Buffer.concat([Buffer.from(JSON.stringify(codec.encodeHeader({ version: 3, id: 'child-a', createdAt: 1793500001000, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'parent-p' }, 0)) + '\n'), Buffer.from([
    e('turn/start', 0, { turn: 1 }),
    e('subagent/descriptor', 1, { provider: 'p', version: 1, mode: 'continuable', label: 'l' }),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ].map(r => JSON.stringify(codec.encodeEvent(r))).join('\n') + '\n')])
  const otherChild = Buffer.concat([Buffer.from(JSON.stringify(codec.encodeHeader({ version: 3, id: 'child-q', createdAt: 1793500002000, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'parent-z' }, 0)) + '\n'), Buffer.from([
    e('turn/start', 0, { turn: 1 }),
    e('subagent/descriptor', 1, { provider: 'p', version: 1, mode: 'continuable', label: 'z' }),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ].map(r => JSON.stringify(codec.encodeEvent(r))).join('\n') + '\n')])
  const gzA = buildV5Archive([
    fileEntry('sessions', 'proj/parent-p/session.v3.jsonl', encodeSession('parent-p'), 'sessions'),
    fileEntry('sessions', 'proj/child-a/session.v3.jsonl', childRows, 'sessions'),
    fileEntry('sessions', 'proj/child-q/session.v3.jsonl', otherChild, 'sessions'),
    // F6: excluded names that must not stage but must verify
    fileEntry('sessions', 'proj/parent-p/session.lock', Buffer.from('{}'), 'sessions'),
  ])
  const backupA = join(dir, 'a.gz')
  writeFileSync(backupA, gzA)
  const rA = await inspectSessions(backupA, { stagingRoot: join(dir, 'stg-a') })
  console.log('A parent-child:', JSON.stringify({
    counts: rA.counts,
    childEvidence: rA.childEvidence,
    staged: rA.stagingSummary.map(s => s.path),
    sessions: rA.sessions.map(s => ({ id: s.id, status: s.status, events: s.events, canonical: s.canonicalEvents, importable: s.importable, err: (s.error || '').slice(0, 80) })),
  }))

  // Scenario B: unreadable child (corrupt rows) with valid header → unavailable fact?
  const badChild = Buffer.concat([Buffer.from(JSON.stringify(codec.encodeHeader({ version: 3, id: 'child-bad', createdAt: 1793500003000, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'parent-b' }, 0)) + '\n'), Buffer.from('{"type":"turn/start" NOPE\n')])
  const gzB = buildV5Archive([
    fileEntry('sessions', 'proj/parent-b/session.v3.jsonl', encodeSession('parent-b'), 'sessions'),
    fileEntry('sessions', 'proj/child-bad/session.v3.jsonl', badChild, 'sessions'),
  ])
  const backupB = join(dir, 'b.gz')
  writeFileSync(backupB, gzB)
  const rB = await inspectSessions(backupB, { stagingRoot: join(dir, 'stg-b') })
  console.log('B unreadable-child:', JSON.stringify({
    counts: rB.counts,
    childEvidence: rB.childEvidence,
    sessions: rB.sessions.map(s => ({ id: s.id, status: s.status, canonical: s.canonicalEvents, code: s.code, err: (s.error || '').slice(0, 100) })),
  }))

  // Scenario C: F4 — v0 compressed canonical + generation mismatch + duplicate id.
  const v0z = Buffer.from(JSON.stringify({ type: 'session', version: 0, id: 's-v0z', createdAt: 1, cwd: '/w' }) + '\n')
  const v4h = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-gen', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
  const dupA1 = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-dup', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
  const gzC = buildV5Archive([
    fileEntry('sessions', 'proj/s-v0z/session.jsonl.zstd', zlib.zstdCompressSync(v0z), 'sessions'),
    fileEntry('sessions', 'proj/s-gen/session.v1.jsonl', v4h, 'sessions'),
    fileEntry('sessions', 'pa/s-dup/session.v4.jsonl', dupA1, 'sessions'),
    fileEntry('sessions', 'pb/s-dup/session.v4.jsonl', dupA1, 'sessions'),
  ])
  const backupC = join(dir, 'c.gz')
  writeFileSync(backupC, gzC)
  const rC = await inspectSessions(backupC, { stagingRoot: join(dir, 'stg-c') })
  console.log('C binding:', JSON.stringify({
    counts: rC.counts,
    ambiguous: rC.ambiguous,
    sessions: rC.sessions.map(s => ({ id: s.id, status: s.status, srcGen: s.sourceGeneration, code: s.code, err: (s.error || '').slice(0, 90) })),
  }))

  // Scenario D: F5 — invalid UTF-8 refusal + truncated skippable tail.
  const ok = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-utf', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
  const bad = Buffer.concat([Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-utf', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n'), Buffer.from([0xff]), Buffer.from('\n')])
  try { readSessionFile(bad, { compressed: false }); console.log('D utf8: ACCEPTED (BAD)') } catch (err) { console.log('D utf8 refused:', err.message) }
  const { splitZstdFrames } = await import('../lib/archive/zstd-frames.js')
  const framed = zlib.zstdCompressSync(ok)
  const skippable = Buffer.alloc(8); skippable.writeUInt32LE(0x184d2a50, 0); skippable.writeUInt32LE(1024, 4)
  try { splitZstdFrames(Buffer.concat([framed, skippable])); console.log('D skippable: ACCEPTED (BAD)') } catch (err) { console.log('D skippable refused:', err.message) }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(0)
