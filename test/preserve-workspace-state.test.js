// Read-only preservation script: copies the workspace unit and journal/plan/
// snapshot evidence, records session header cwds, and never copies session
// bodies or quarantine payloads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('preserve workspace state: unit/journal/snapshot + header cwds only, no bodies or quarantine', () => {
  const base = mkdtempSync(join(tmpdir(), 'preserve-'))
  try {
    const home = join(base, 'home')
    const out = join(base, 'out')
    mkdirSync(join(home, 'storages'), { recursive: true })
    mkdirSync(join(home, 'dsha-migrator', 'jobs', 'j1'), { recursive: true })
    mkdirSync(join(home, 'sessions', 'proj', 'session-x'), { recursive: true })
    mkdirSync(join(home, 'sessions', 'proj', 'session-y'), { recursive: true })
    mkdirSync(join(home, 'sessions', 'proj', 'session-z'), { recursive: true })
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: {} },
    }))
    writeFileSync(join(home, 'dsha-migrator', 'jobs', 'j1', 'journal.json'), '{"journal":1}')
    writeFileSync(join(home, 'dsha-migrator', 'jobs', 'j1', 'plan.json'), '{"plan":1}')
    writeFileSync(join(home, 'dsha-migrator', 'jobs', 'j1', 'workspace-unit.abcdef.json'), '{"snapshot":1}')
    writeFileSync(join(home, 'dsha-migrator', 'jobs', 'j1', 'quarantine.json'), 'SHOULD_NOT_COPY')
    const header = JSON.stringify({ type: 'session', version: 4, id: 's1', createdAt: 1, cwd: '/root/workspace/dsha-import', isSeeded: false, delegationDepth: 0 })
    writeFileSync(join(home, 'sessions', 'proj', 'session-x', 'session.v4.jsonl'), `${header}\n${JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } })}\n`)
    const older = JSON.stringify({ type: 'session', version: 3, id: 's1', createdAt: 1, cwd: '/root/workspace/old', isSeeded: false, delegationDepth: 0 })
    writeFileSync(join(home, 'sessions', 'proj', 'session-x', 'session.v3.jsonl'), `${older}\n${JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } })}\n`)
    const conflictA = JSON.stringify({ type: 'session', version: 4, id: 's2', createdAt: 1, cwd: '/root/workspace/a', isSeeded: false, delegationDepth: 0 })
    const conflictB = JSON.stringify({ type: 'session', version: 4, id: 's2', createdAt: 1, cwd: '/root/workspace/b', isSeeded: false, delegationDepth: 0 })
    writeFileSync(join(home, 'sessions', 'proj', 'session-y', 'session.v4.jsonl'), `${conflictA}\n`)
    writeFileSync(join(home, 'sessions', 'proj', 'session-z', 'session.v4.jsonl'), `${conflictB}\n`)
    const script = join(import.meta.dirname, '..', 'scripts', 'preserve-workspace-state.mjs')
    const child = spawnSync(process.execPath, [script, '--dsh-home', home, '--out', out], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(existsSync(join(out, 'workspace.json')), true)
    assert.equal(existsSync(join(out, 'jobs', 'j1', 'journal.json')), true)
    assert.equal(existsSync(join(out, 'jobs', 'j1', 'plan.json')), true)
    assert.equal(existsSync(join(out, 'jobs', 'j1', 'workspace-unit.abcdef.json')), true)
    assert.equal(existsSync(join(out, 'jobs', 'j1', 'quarantine.json')), false, 'quarantine payloads are not copied')
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'session-cwds.json'), 'utf8')), { s1: '/root/workspace/dsha-import' })
    const manifest = JSON.parse(readFileSync(join(out, 'preserve-manifest.json'), 'utf8'))
    assert.equal(manifest.sessionHeaders.length, 4)
    assert.equal(manifest.sessionConflicts.length, 1)
    assert.equal(manifest.sessionConflicts[0].id, 's2')
    assert.equal(manifest.sessionConflicts[0].reason, 'different-cwds')
    assert.deepEqual(manifest.sessionConflicts[0].candidates.sort(), ['/root/workspace/a', '/root/workspace/b'])
    assert.equal(manifest.files.some(f => f.name.includes('quarantine')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
