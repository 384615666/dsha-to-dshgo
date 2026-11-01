// Probe: v3 parent/child evidence semantics on the installed rc.4 packages.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const req = createRequire(process.env.RC4_MODULES + '/noop.js')
const cat = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
const v3mod = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href)

const parent = { type: 'session', version: 3, id: 'parent-1', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }
const child = { type: 'session', version: 3, id: 'child-1', createdAt: 2, cwd: '/w', isSeeded: false, delegationDepth: 1, origin: 'subagent', parentSession: 'parent-1' }
console.log('parent class:', cat.historicalSessionFormatCatalog.readHeader(parent).status)
console.log('child class:', cat.historicalSessionFormatCatalog.readHeader(child).status)

// What does a parent restore WITHOUT child facts do, when the parent's rows
// reference subagent activity? Build a minimal parent event set.
const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
const parentRows = [
  e('turn/start', 0, { turn: 1 }),
  e('step/start', 1, { turn: 1, step: 1 }),
  e('user/message', 2, { id: 'p-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, { surfaceOp: 'append' }),
  e('step/end', 3, { turn: 1, step: 1 }),
  e('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
]

// Childless, empty facts — should restore to v3 (then v4 needs the child-
// bound catalog from P1 batch: createSessionFormatCatalogWithChildren([])).
const childlessCatalog = cat.createSessionFormatCatalogWithChildren([])
try {
  const restore = childlessCatalog.createRestore(parent, { recovery: 'strict', validation: 'current' })
  for (const row of parentRows) restore.decodeRow(row)
  const art = restore.finish()
  console.log('childless restore OK: events', art.events.length, 'header ver', art.header.version)
  // historicalChildCatalogSource on this artifact:
  try {
    const fact = v3mod.historicalChildCatalogSource(art)
    console.log('childCatalogSource:', JSON.stringify(fact).slice(0, 160))
  } catch (error) {
    console.log('childCatalogSource err (expected for a parent artifact):', error.message.slice(0, 100))
  }
} catch (error) {
  console.log('childless restore ERR:', error.message.slice(0, 140))
}
process.exit(0)
