// Offline workspace-unit repair: produce a MINIMAL, reviewable diff for a
// duplicated session membership. It never deletes workspaces, never rewrites
// titles/paths/order/pin/archive, and refuses to guess when ownership cannot
// be proven from the session's actual cwd.
//
// This module is pure (bytes/objects only). The CLI in scripts/ performs the
// offline file read/write with an explicit hash precondition and backup.
import { createHash } from 'node:crypto'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const normalizePath = value => (typeof value === 'string' ? value.replace(/\/+$/, '') : value)

export function planWorkspaceRepair({ unitBytes, sessionCwds = {} }) {
  const bytes = Buffer.isBuffer(unitBytes) ? unitBytes : Buffer.from(unitBytes)
  const parsed = JSON.parse(bytes.toString('utf8'))
  const records = parsed?.tables?.workspaces
  if (!records || typeof records !== 'object') throw new Error('workspace unit has no workspaces table')
  const owners = new Map()
  for (const [workspaceId, record] of Object.entries(records)) {
    for (const sessionId of record.sessionIds ?? []) {
      if (!owners.has(sessionId)) owners.set(sessionId, [])
      owners.get(sessionId).push(workspaceId)
    }
  }
  const duplicates = [...owners].filter(([, list]) => list.length > 1)
  const removals = []
  const blocked = []
  for (const [sessionId, list] of duplicates) {
    const cwd = normalizePath(sessionCwds[sessionId])
    if (typeof cwd !== 'string' || cwd === '') {
      blocked.push({ sessionId, reason: 'no-session-cwd', owners: list })
      continue
    }
    const keep = list.filter(id => normalizePath(records[id].path) === cwd)
    if (keep.length !== 1) {
      blocked.push({ sessionId, reason: keep.length === 0 ? 'no-owner-matches-cwd' : 'multiple-owners-match-cwd', owners: list })
      continue
    }
    const [keeper] = keep
    const drop = list.filter(id => id !== keeper)
    if (drop.length > 0) removals.push({ sessionId, keep: keeper, removeFrom: drop })
  }
  return {
    unitSha256: sha256(bytes),
    duplicates: duplicates.length,
    removals,
    blocked,
    changed: removals.length > 0,
    applied: false,
  }
}

/** Apply a previously reviewed diff to the unit bytes. Hash-bound. */
export function applyWorkspaceRepair(unitBytes, diff, { expectSha256 } = {}) {
  const bytes = Buffer.isBuffer(unitBytes) ? unitBytes : Buffer.from(unitBytes)
  if (typeof expectSha256 !== 'string' || sha256(bytes) !== expectSha256) {
    throw new Error('workspace unit changed since the diff was generated — refusing to apply')
  }
  const parsed = JSON.parse(bytes.toString('utf8'))
  const records = parsed?.tables?.workspaces
  if (!records) throw new Error('workspace unit has no workspaces table')
  for (const removal of diff?.removals ?? []) {
    const keeper = records[removal.keep]
    if (!keeper) throw new Error('diff keeper workspace is missing from the unit')
    if (!(keeper.sessionIds ?? []).includes(removal.sessionId)) {
      throw new Error('diff keeper does not hold the session in the unit')
    }
    for (const workspaceId of removal.removeFrom ?? []) {
      const record = records[workspaceId]
      if (!record) throw new Error('diff target workspace is missing from the unit')
      if (!(record.sessionIds ?? []).includes(removal.sessionId)) {
        throw new Error('diff target does not hold the session in the unit')
      }
      record.sessionIds = (record.sessionIds ?? []).filter(id => id !== removal.sessionId)
    }
  }
  // Structural safety: only memberships changed; one owner at most remains.
  const seen = new Map()
  for (const [workspaceId, record] of Object.entries(records)) {
    for (const sessionId of record.sessionIds ?? []) {
      if (seen.has(sessionId)) throw new Error(`duplicate membership remains for ${sessionId}`)
      seen.set(sessionId, workspaceId)
    }
  }
  const out = Buffer.from(JSON.stringify(parsed))
  return { bytes: out, sha256: sha256(out), unit: parsed }
}
