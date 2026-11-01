// Isolation probe for the synthetic v3 pipeline (run with RC4_MODULES set).
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const req = createRequire(process.env.RC4_MODULES
  ? process.env.RC4_MODULES + '/noop.js'
  : import.meta.url)
const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
const cat = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
const codec = v23.releasedV3SessionFormatCodec

const id = 'session-synth-v3'
const v3LogicalHeader = { version: 3, id, createdAt: 1793500000000, cwd: '/tmp/proj', isSeeded: false, delegationDepth: 0 }
const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
const logicalEvents = [
  e('turn/start', 0, { turn: 1 }),
  e('user/message', 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '保留这句话' }] }, { surfaceOp: 'append' }),
  e('step/start', 2, { turn: 1, step: 1 }),
  e('step/end', 3, { turn: 1, step: 1 }),
  e('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
]
const physicalHeader = codec.encodeHeader(v3LogicalHeader, 0)
const physicalRows = logicalEvents.map(ev => codec.encodeEvent(ev))
console.log('physical header:', JSON.stringify(physicalHeader).slice(0, 200))
console.log('row 0:', JSON.stringify(physicalRows[0]).slice(0, 140))
console.log('hist class:', JSON.stringify(cat.historicalSessionFormatCatalog.readHeader(physicalHeader)))
try {
  const restore = cat.historicalSessionFormatCatalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'current' })
  for (const row of physicalRows) restore.decodeRow(row)
  const art = restore.finish()
  console.log('restored events:', art.events.length, 'header ver:', art.header.version)
} catch (error) {
  console.log('RESTORE ERR:', error.message.slice(0, 180))
}
process.exit(0)
