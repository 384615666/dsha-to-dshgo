// Formal host-side workspace-unit provider (P2 M1).
//
// The provider is what makes a G6 snapshot a REAL pre-state capture: it reads
// the target's workspace storage unit from the backend's own location,
// validates the unit schema and version, rejects a unit carrying a pending
// mutation marker, and returns:
//   - bytes     — the exact persisted content (for the content-addressed copy)
//   - projection— the committed entity state AS STORED in those bytes:
//                 durable order, archive/pin sets and the RAW persisted
//                 workspace records (persisted sessionIds included, even when
//                 the registry's visible set filters some candidates out)
//   - unitName / unitVersion — the validated unit identity
//
// Nothing here guesses a backend path: the caller supplies the backend's real
// storage root and unit name (for the isolated json backend that is
// <storageRoot>/workspace.json, but this module treats it as configuration,
// not a universal rule). The projection is derived from the bytes, never
// rebuilt from the registry to "make the comparison pass".

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SUPPORTED_WORKSPACE_UNIT_VERSIONS = [2]
export const DEFAULT_WORKSPACE_UNIT_NAME = 'workspace'

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Validate one parsed workspace unit and derive its committed projection.
 * Exported for tests and for hosts that already read the bytes themselves.
 */
export function projectWorkspaceUnit(parsed, { unitName = DEFAULT_WORKSPACE_UNIT_NAME } = {}) {
  if (!isPlainObject(parsed)) throw coded('G6_SNAPSHOT_INVALID', 'the workspace unit is not a JSON object')
  const unit = parsed.unit
  if (!isPlainObject(unit) || unit.name !== unitName) {
    throw coded('G6_SNAPSHOT_INVALID', `the workspace unit is not the "${unitName}" unit (got ${JSON.stringify(unit?.name ?? null)})`)
  }
  if (!SUPPORTED_WORKSPACE_UNIT_VERSIONS.includes(unit.version)) {
    throw coded('G6_SNAPSHOT_UNSUPPORTED', `the workspace unit version ${JSON.stringify(unit.version)} is not supported (supported: ${SUPPORTED_WORKSPACE_UNIT_VERSIONS.join(', ')})`)
  }
  const global = parsed.global
  if (!isPlainObject(global) || !Array.isArray(global.workspaceIds) || !Array.isArray(global.archivedSessionIds) || !Array.isArray(global.pinnedSessionIds)) {
    throw coded('G6_SNAPSHOT_INVALID', 'the workspace unit global state is malformed')
  }
  // A pending mutation marker means a create/delete was interrupted mid-flight:
  // the registry may not yet reflect it. Never capture such a unit.
  if (global.pendingMutation !== undefined) {
    throw coded('G6_SNAPSHOT_PENDING', `the workspace unit carries a pending ${JSON.stringify(global.pendingMutation?.operation ?? 'mutation')} — refusing to capture a non-quiescent state`)
  }
  const tables = parsed.tables
  if (!isPlainObject(tables) || !isPlainObject(tables.workspaces)) {
    throw coded('G6_SNAPSHOT_INVALID', 'the workspace unit has no workspaces table')
  }
  const workspaces = {}
  const order = new Set(global.workspaceIds)
  for (const id of global.workspaceIds) {
    if (typeof id !== 'string' || id === '') throw coded('G6_SNAPSHOT_INVALID', 'the durable workspace order contains an invalid id')
  }
  for (const [id, record] of Object.entries(tables.workspaces)) {
    if (!order.has(id)) {
      throw coded('G6_SNAPSHOT_INVALID', `workspace record ${id} is not present in the durable order`)
    }
    if (!isPlainObject(record)) throw coded('G6_SNAPSHOT_INVALID', `workspace record ${id} is malformed`)
    if (typeof record.path !== 'string' || typeof record.title !== 'string' || !Array.isArray(record.sessionIds)) {
      throw coded('G6_SNAPSHOT_INVALID', `workspace record ${id} is missing path/title/sessionIds`)
    }
    if (record.sessionIds.some(s => typeof s !== 'string' || s === '')) {
      throw coded('G6_SNAPSHOT_INVALID', `workspace record ${id} contains an invalid session id`)
    }
    workspaces[id] = {
      path: record.path,
      title: record.title,
      // RAW persisted candidates — the registry's visible set may filter these.
      sessionIds: [...record.sessionIds],
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? null,
    }
  }
  for (const id of global.workspaceIds) {
    if (!workspaces[id]) throw coded('G6_SNAPSHOT_INVALID', `durable workspace order references missing record ${id}`)
  }
  return {
    workspaceIds: [...global.workspaceIds],
    archivedSessionIds: [...global.archivedSessionIds],
    pinnedSessionIds: [...global.pinnedSessionIds],
    workspaces,
  }
}

/**
 * Create the formal provider for one target backend.
 * @param {object} params
 * @param {string} params.storageRoot - the backend's REAL storage root (from
 *   the target's configuration, never a guessed universal path).
 * @param {string} [params.unitName='workspace'] - the domain unit name.
 * @param {(path: string) => Buffer} [params.readFile] - injectable reader.
 */
export function createWorkspaceUnitProvider({ storageRoot, unitName = DEFAULT_WORKSPACE_UNIT_NAME, readFile = readFileSync }) {
  if (typeof storageRoot !== 'string' || storageRoot === '') {
    throw coded('G6_SNAPSHOT_INVALID', 'a workspace unit provider needs the backend storage root')
  }
  return async () => {
    const file = join(storageRoot, `${unitName}.json`)
    let bytes
    try {
      bytes = readFile(file)
    } catch (error) {
      throw coded('G6_SNAPSHOT_INVALID', `the workspace unit could not be read at the configured backend location (${error?.code ?? error?.message})`)
    }
    if (!(bytes instanceof Uint8Array)) {
      throw coded('G6_SNAPSHOT_INVALID', 'the workspace unit reader returned no bytes')
    }
    let parsed
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch {
      throw coded('G6_SNAPSHOT_INVALID', 'the workspace unit is not valid JSON')
    }
    const projection = projectWorkspaceUnit(parsed, { unitName })
    return {
      bytes: Buffer.from(bytes),
      projection,
      unitName,
      unitVersion: parsed.unit.version,
    }
  }
}
