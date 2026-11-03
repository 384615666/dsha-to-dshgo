// Offline workspace-repair diff: minimal, ownership-proven, preserves all
// other workspace data, and never deletes a workspace.
import test from 'node:test'
import assert from 'node:assert/strict'
import { planWorkspaceRepair, applyWorkspaceRepair } from '../lib/import/workspace-repair.js'

function unitFixture() {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      workspaceIds: ['ws-a', 'ws-b', 'ws-c'],
      archivedSessionIds: ['arch-1'],
      pinnedSessionIds: ['pin-1'],
    },
    tables: {
      workspaces: {
        'ws-a': { path: '/old/workspace', title: 'Old', sessionIds: ['s1', 's2'], createdAt: 1, updatedAt: 2 },
        'ws-b': { path: '/root/workspace/dsha-import', title: 'New', sessionIds: ['s1', 's3'], createdAt: 3, updatedAt: 4 },
        'ws-c': { path: '/other', title: 'Other', sessionIds: ['s4'], createdAt: 5, updatedAt: 6 },
      },
    },
  }
}

const bytesOf = unit => Buffer.from(JSON.stringify(unit))

test('workspace repair: only the non-owner membership is removed; everything else is preserved', () => {
  const unit = unitFixture()
  const bytes = bytesOf(unit)
  const diff = planWorkspaceRepair({
    unitBytes: bytes,
    sessionCwds: { s1: '/root/workspace/dsha-import', s2: '/old/workspace', s3: '/root/workspace/dsha-import', s4: '/other' },
  })
  assert.equal(diff.duplicates, 1)
  assert.deepEqual(diff.blocked, [])
  assert.deepEqual(diff.removals, [{ sessionId: 's1', keep: 'ws-b', removeFrom: ['ws-a'] }])
  assert.equal(diff.changed, true)
  const applied = applyWorkspaceRepair(bytes, diff, { expectSha256: diff.unitSha256 })
  assert.deepEqual(applied.unit.global, unit.global)
  assert.deepEqual(applied.unit.tables.workspaces['ws-a'], { ...unit.tables.workspaces['ws-a'], sessionIds: ['s2'] })
  assert.deepEqual(applied.unit.tables.workspaces['ws-b'], unit.tables.workspaces['ws-b'])
  assert.deepEqual(applied.unit.tables.workspaces['ws-c'], unit.tables.workspaces['ws-c'])
  assert.deepEqual(applied.unit.unit, unit.unit)
})

test('workspace repair: no proven owner OR multiple matching owners blocks the diff', () => {
  const unit = unitFixture()
  const bytes = bytesOf(unit)
  const missing = planWorkspaceRepair({ unitBytes: bytes, sessionCwds: { s1: '/not/a/workspace' } })
  assert.equal(missing.changed, false)
  assert.equal(missing.blocked[0].reason, 'no-owner-matches-cwd')
  const noCwd = planWorkspaceRepair({ unitBytes: bytes, sessionCwds: {} })
  assert.equal(noCwd.blocked[0].reason, 'no-session-cwd')
  assert.equal(noCwd.changed, false)

  const ambiguous = unitFixture()
  ambiguous.tables.workspaces['ws-a'].path = '/same'
  ambiguous.tables.workspaces['ws-b'].path = '/same'
  const ambiguousDiff = planWorkspaceRepair({ unitBytes: bytesOf(ambiguous), sessionCwds: { s1: '/same' } })
  assert.equal(ambiguousDiff.blocked[0].reason, 'multiple-owners-match-cwd')
  assert.equal(ambiguousDiff.changed, false)
})

test('workspace repair: apply is hash-bound and keeps an emptied workspace rather than deleting it', () => {
  const unit = unitFixture()
  unit.tables.workspaces['ws-a'].sessionIds = ['s1']
  const bytes = bytesOf(unit)
  const diff = planWorkspaceRepair({ unitBytes: bytes, sessionCwds: { s1: '/root/workspace/dsha-import' } })
  assert.equal(diff.changed, true)
  assert.throws(() => applyWorkspaceRepair(bytes, diff, { expectSha256: '0'.repeat(64) }), /changed since/)
  const applied = applyWorkspaceRepair(bytes, diff, { expectSha256: diff.unitSha256 })
  assert.deepEqual(applied.unit.global.workspaceIds, ['ws-a', 'ws-b', 'ws-c'])
  assert.deepEqual(applied.unit.tables.workspaces['ws-a'].sessionIds, [])
  assert.ok(applied.unit.tables.workspaces['ws-a'], 'an empty workspace is preserved, not deleted')
})

test('workspace repair: a diff that does not match the unit membership is refused', () => {
  const bytes = bytesOf(unitFixture())
  const diff = {
    unitSha256: planWorkspaceRepair({ unitBytes: bytes, sessionCwds: { s1: '/root/workspace/dsha-import' } }).unitSha256,
    removals: [{ sessionId: 's1', keep: 'ws-c', removeFrom: ['ws-a'] }],
  }
  assert.throws(() => applyWorkspaceRepair(bytes, diff, { expectSha256: diff.unitSha256 }), /keeper does not hold/)
})
