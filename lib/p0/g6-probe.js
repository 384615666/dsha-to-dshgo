// P0 G6 minimal probe: snapshot-before → mutate workspace unit (pin/archive/
// detach) → snapshot-after → rollback via the registry's own APIs → verify
// the unit matches the before-state. This is the feasibility demo for the
// full G6 adapter (P2); it is NOT the production rollback implementation.
import { readFile as rf } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Json(value) {
  return sha256(JSON.stringify(value))
}

async function snapshotState(ctx, cap) {
  const registry = ctx.workspaceRegistry
  const workspaces = registry.list().map(w => ({
    id: w.id,
    path: w.path,
    title: w.title,
    sessionIds: [...w.sessionIds],
  }))
  const snap = {
    at: new Date().toISOString(),
    workspaceOrder: registry.list().map(w => w.id),
    workspaces,
  }
  // Workspace unit完整前态: byte copy of the durable domain file.
  try {
    const unitPath = join(dirname(cap.root), 'storages', 'workspace.json')
    const bytes = await rf(unitPath)
    snap.workspaceUnitPath = unitPath
    snap.workspaceUnitSha256 = sha256(bytes)
    snap.workspaceUnitNormalized = sha256Json(normalizeUnit(JSON.parse(bytes.toString('utf8'))))
    snap.workspaceUnitBytes = bytes.toString('utf8')
  } catch (error) {
    snap.workspaceUnitError = `${error.name}: ${error.message}`
  }
  return snap
}

// Normalize away timestamps that legitimately change on any mutation, so the
// rollback comparison checks state, not wall clocks.
function normalizeUnit(unit) {
  const clone = JSON.parse(JSON.stringify(unit))
  for (const record of Object.values(clone.tables?.workspaces ?? {})) {
    delete record.updatedAt
  }
  return clone
}

export async function runG6Probe(ctx, cap) {
  const result = { at: new Date().toISOString(), evidenceKind: 'real', path: 'G6-minimal', steps: {}, pass: 0, total: 5, error: null }
  try {
    const registry = ctx.workspaceRegistry
    const manifestPath = process.env.DSHA_MIGRATOR_P0_B_MANIFEST
    const manifest = JSON.parse(await rf(manifestPath))
    const ids = manifest.entries.map(e => e.id)
    const [sid1, sid2] = ids

    const before = await snapshotState(ctx, cap)
    result.steps.snapshotBefore = { ok: !before.workspaceUnitError, unitSha: before.workspaceUnitSha256?.slice(0, 12) }

    // Writes (the "import" mutations being guarded).
    await registry.pinSession(sid1)
    await registry.archiveSession(sid2)
    const ws = registry.list().find(w => w.sessionIds.includes(sid1)) ?? await registry.create(process.env.DSHA_MIGRATOR_P0_CWD || join(dirname(cap.root), 'p0-probe-cwd'), 'DSHA 迁移 P0 探针')
    await ws.detachSession(sid1)
    const afterWrite = await snapshotState(ctx, cap)
    result.steps.mutationsApplied = {
      ok: true,
      orderChanged: JSON.stringify(afterWrite.workspaceOrder) !== JSON.stringify(before.workspaceOrder),
      membershipChanged: JSON.stringify(afterWrite.workspaces.map(w => w.sessionIds)) !== JSON.stringify(before.workspaces.map(w => w.sessionIds)),
      unitChanged: afterWrite.workspaceUnitSha256 !== before.workspaceUnitSha256,
    }

    // Rollback in reverse journal order: detach's inverse first.
    await ws.attachSession(sid1)
    await registry.unarchiveSession(sid2)
    await registry.unpinSession(sid1)
    const afterRollback = await snapshotState(ctx, cap)
    result.steps.rollbackApplied = { ok: true }

    result.steps.stateMatchesBefore = {
      ok: afterRollback.workspaceUnitNormalized === before.workspaceUnitNormalized,
      normalizedUnitSha: afterRollback.workspaceUnitNormalized?.slice(0, 12),
      beforeNormalizedSha: before.workspaceUnitNormalized?.slice(0, 12),
      orderRestored: JSON.stringify(afterRollback.workspaceOrder) === JSON.stringify(before.workspaceOrder),
      membershipRestored: JSON.stringify(afterRollback.workspaces.map(w => w.sessionIds)) === JSON.stringify(before.workspaces.map(w => w.sessionIds)),
    }
  } catch (error) {
    result.error = `${error.name}: ${error.message}`
  }
  result.pass = Object.values(result.steps).filter(s => s && s.ok).length
  return result
}
