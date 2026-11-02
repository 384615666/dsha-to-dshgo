// Probe: §1–§5 orchestrator behaviors with the official locate adapter.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { buildV5Archive, fileEntry, missingEntry } from '../test/helpers/v5-fixture.mjs'
import { inspectSessions, readSessionFile, DEFAULT_SESSION_BUDGET } from '../lib/inspect-sessions.js'
import { setLocationAdapter, officialSessionDirectory } from '../lib/migration/location.js'
import { splitZstdFrames } from '../lib/archive/zstd-frames.js'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep, dirname } from 'node:path'
import zlib from 'node:zlib'

const req = createRequire(process.env.RC4_MODULES + '/noop.js')
const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
await setModuleLoader(async () => ({
  cat: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href),
  v3: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
}))
const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)

const backendRoot = mkdtempSync(join(tmpdir(), 'probe-locate-root-'))
const ctx = new Context()
await ctx.plugin(jsonl, { root: backendRoot, compression: 'zstd' })
const store = ctx.sessionPersistence
await setLocationAdapter(header => {
  const loc = store.locate({ cwd: header.cwd, id: header.id })
  return relative(backendRoot, loc.path).split(sep).slice(0, -1).join('/')
})
console.log('probe dir for cwd=/w id=abc:', officialSessionDirectory({ cwd: '/w', id: 'abc' }))

const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
const codec = v23.releasedV3SessionFormatCodec
const cat = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
const cur = cat.sessionFormatCatalog
const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })

const v3Bytes = (id, extra = {}, rowsOverride = null) => {
  const h = codec.encodeHeader({ version: 3, id, createdAt: 1793500000000, cwd: '/w', isSeeded: false, delegationDepth: 0, ...extra }, 0)
  const logical = rowsOverride ?? [
    e('turn/start', 0, { turn: 1 }),
    e('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const rows = logical.map(ev => codec.encodeEvent(ev))
  return Buffer.from([JSON.stringify(h), ...rows.map(r => JSON.stringify(r))].join('\n') + '\n')
}
const v4Bytes = (id, cwd = '/w', text = null, extra = {}) => {
  const h = cur.encodeCurrentHeader({ version: 4, id, createdAt: 1793500000000, cwd, isSeeded: false, delegationDepth: 0, ...extra }, 0)
  const logical = [
    e('turn/start', 0, { turn: 1 }),
    e('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const rows = logical.map(ev => cur.encodeCurrentEvent(ev))
  let blob = Buffer.from([JSON.stringify(h), ...rows.map(r => JSON.stringify(r))].join('\n') + '\n')
  if (text) blob = Buffer.concat([blob, Buffer.from(text)])
  return blob
}

const dir = mkdtempSync(join(tmpdir(), 'probe-s5-'))
const officialDir = (id, cwd = '/w') => officialSessionDirectory({ cwd, id })
try {
  // A: v3 parent + v4 child (official chain decides) + correct layout.
  const v4Child = v4Bytes('kid-v4', '/w', null, { delegationDepth: 1, origin: 'subagent', parentSession: 'pp' })
  // B: salvage header claiming another id in child dir → no fact.
  const badSalvage = Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 'impostor', createdAt: 1793500001000, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'pp' }) + '\n' + '{"broken": SYNTHCHAT!\n')
  const gz = buildV5Archive([
    fileEntry('sessions', `${officialDir('pp')}/session.v3.jsonl`, v3Bytes('pp'), 'sessions'),
    fileEntry('sessions', `${officialDir('kid-v4')}/session.v4.jsonl`, v4Child, 'sessions'),
    fileEntry('sessions', `${officialDir('impostor')}/session.v3.jsonl`, badSalvage, 'sessions'),
    // MISSING slot declared under the sessions root
    missingEntry('sessions', `${officialDir('ghost')}/session.v3.jsonl`, 'sessions'),
  ], { manifest: { integrity: 'PARTIAL' } })
  const backup = join(dir, 'a.gz')
  writeFileSync(backup, gz)
  const r = await inspectSessions(backup, { stagingRoot: join(dir, 'stg') })
  console.log('A+B:', JSON.stringify({
    archiveFailed: r.archiveFailed ?? false,
    errors: r.errors,
    incomplete: r.archive?.stats?.incomplete,
    counts: r.counts,
    declaredMissing: r.childEvidence.declaredMissing,
    declared: r.childEvidence.declared,
    reportHasSynthchat: JSON.stringify(r).includes('SYNTHCHAT'),
    sessions: r.sessions.map(s => ({ id: s.id, status: s.status, gen: s.sourceGeneration, canonical: s.canonicalEvents, importable: s.importable, code: s.code, binding: s.binding?.location, err: (s.error || '').slice(0, 70) })),
  }, null, 1))

  // C: budget stops decoding — second frame CORRUPT so touching it would error differently.
  const goodFrame = zlib.zstdCompressSync(Buffer.from('x'.repeat(2000)))
  const corruptFrame = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const { decompressZstdMultiFrame } = await import('../lib/archive/zstd-frames.js')
  try {
    decompressZstdMultiFrame(Buffer.concat([goodFrame, corruptFrame]), { maxBytes: 100 })
    console.log('C budget: ACCEPTED (BAD)')
  } catch (err) {
    console.log('C budget stop:', /budget/.test(err.message) ? 'BUDGET error (frames after limit not touched)' : `WRONG error: ${err.message}`)
  }

  // D: SYNTHCHAT marker never reaches the report (JSON row error message is fixed).
  const badRow = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 's-mark', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n' + '{"x": "SYNTHCHAT-marker" NOPE\n')
  try { readSessionFile(badRow, { compressed: false }) } catch (err) { console.log('D row error message:', JSON.stringify(err.message), 'code:', err.code, 'hasHeader:', Boolean(err.header)) }

  // E: wrong-cwd location refused + CJK official encoding admitted.
  const gz2 = buildV5Archive([
    fileEntry('sessions', `--wrong-project--/${'s-loc'}/session.v4.jsonl`, v4Bytes('s-loc'), 'sessions'),
    fileEntry('sessions', `${officialDir('会话-id')}/session.v4.jsonl`, v4Bytes('会话-id'), 'sessions'),
  ])
  const backup2 = join(dir, 'b.gz')
  writeFileSync(backup2, gz2)
  const r2 = await inspectSessions(backup2, { stagingRoot: join(dir, 'stg2') })
  console.log('E:', JSON.stringify(r2.sessions.map(s => ({ id: s.id, status: s.status, code: s.code, importable: s.importable, binding: s.binding?.location }))))
} finally {
  rmSync(dir, { recursive: true, force: true })
  await setLocationAdapter(null)
  try { await ctx.fiber?.dispose?.() } catch {}
  rmSync(backendRoot, { recursive: true, force: true })
}
process.exit(0)
