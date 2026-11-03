// P2 M5: F8 — runtime-unique fake credentials injected into excluded
// credential/config roots and into a real job error path; every observable
// output channel is scanned for leakage, with NEGATIVE CONTROLS proving the
// scanner detects deliberate leaks. The marker is generated at RUNTIME (never
// hardcoded into shipped source), so a leak cannot be masked by tests that
// strip a known constant.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { captureTargetPreState } from '../lib/import/g6.js'
import { sanitizeRoots } from '../lib/inspect-sessions.js'
import { ImportJournal } from '../lib/import/journal.js'
import { planContentDigest } from '../lib/import/plan.js'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir

function runtimeMarker() {
  return `F8TOKEN-${randomBytes(16).toString('hex')}`
}

// An uppercase-hex credential-shaped value that PASSES the old format-only
// filter (first character must be a letter): 48 hex chars starting A–F.
function credentialLikeHex() {
  for (;;) {
    const value = randomBytes(24).toString('hex').toUpperCase()
    if (/^[A-F]/.test(value)) return value
  }
}

// The leak scanner under test: returns the channels containing the marker.
function scanForMarker(channels, marker) {
  const hits = []
  for (const [channel, content] of Object.entries(channels)) {
    if (typeof content === 'string' && content.includes(marker)) hits.push(channel)
  }
  return hits
}

test('P2 F8 scanner negative control: a deliberate leak into stdout/report IS detected', () => {
  const token = runtimeMarker()
  // negative controls: the scanner must catch deliberate leaks
  assert.deepEqual(scanForMarker({ stdout: `ok ${token}`, report: '{"clean":true}' }, token), ['stdout'])
  assert.deepEqual(scanForMarker({ stdout: 'clean', report: `{"note":"${token}"}` }, token), ['report'])
  // positive control: clean channels pass
  assert.deepEqual(scanForMarker({ stdout: 'clean', report: '{"clean":true}' }, token), [])
})

test('P2 F8: runtime fake credentials in excluded roots never reach report channels', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const token = runtimeMarker()
  const dir = mkdtempSync(join(tmpdir(), 'f8-'))
  try {
    // The token is placed INSIDE the excluded roots' payloads (content of
    // .credentials.yaml / .bridge_token) — the F8 injection contract.
    const roots = [
      { id: 'r1', scope: 'settings', name: '.credentials.yaml', payload: `api_key: ${token}` },
      { id: 'r2', scope: 'settings', name: '.bridge_token', payload: `token: ${token}` },
      { id: 'r3', scope: 'settings', name: 'sessions', payload: null },
    ]
    // precondition: the injected input really carries the marker
    assert.ok(roots.map(r => r.payload ?? '').join('\n').includes(token), 'precondition: the injected input contains the marker')

    const report = { archive: { manifest: { roots: sanitizeRoots(roots) } } }
    const hits = scanForMarker({
      stdout: JSON.stringify(report),
      stderr: '',
      report: JSON.stringify({ archive: report.archive, warnings: [] }),
    }, token)
    assert.deepEqual(hits, [], `report/stdout channels must be clean (leaked in: ${hits})`)
    assert.ok(JSON.stringify(report).includes('sessions'), 'non-sensitive roots stay listed')
    assert.equal(report.archive.manifest.roots.excludedSensitive, 2, 'excluded count kept as a number, not a name')

    // the workspace unit copy is an INTERNAL restore artifact (it carries the
    // target's own storage content and must survive for restoration) — its
    // classification is explicit and it is NOT a public report channel.
    const jobDir = join(dir, 'job')
    const fakePersistence = { stat: async () => undefined }
    const unitBytes = Buffer.from(JSON.stringify({ note: token, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], workspaces: {} }))
    const snapshot = await captureTargetPreState({
      persistence: fakePersistence,
      plannedSessionIds: ['f8-s'],
      workspaceUnitProvider: async () => ({ bytes: unitBytes, projection: { workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], workspaces: {} } }),
      snapshotDir: jobDir,
    })
    const unitFile = join(jobDir, snapshot.workspaceUnit.file)
    assert.ok(readFileSync(unitFile).includes(token), 'the internal restore payload keeps the target content (by design)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 F8: error-path diagnostic messages do not echo injected credentials', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const token = runtimeMarker()
  const dir = mkdtempSync(join(tmpdir(), 'f8-err-'))
  try {
    // a damaged session log whose row content embeds the fake token: the
    // stable-code error contract must not echo the fragment (F6 behavior)
    const { readSessionFile } = await import('../lib/inspect-sessions.js')
    const header = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'f8', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
    const badRow = Buffer.concat([header, Buffer.from(`{"x": "${token}" BROKEN\n`)])
    let captured = null
    try {
      readSessionFile(badRow, { compressed: false })
    } catch (error) {
      captured = error
    }
    assert.ok(captured, 'the damaged row refuses')
    const full = `${captured.name}\n${captured.message}\n${captured.stack ?? ''}`
    assert.ok(!full.includes(token), 'error text/stack must not echo the token')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// R1.2: the REAL production job entry must not echo a token-carrying storage
// failure into its public report — with the token PROVEN present in the
// injected input first.
test('P2 F8: a real runImportJob with a token-carrying storage failure leaks nothing into stdout/stderr/report', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const token = runtimeMarker()
  const dir = mkdtempSync(join(tmpdir(), 'f8-job-'))
  try {
    const { runImportJob } = await import('../lib/import/job.js')
    const { ImportJournal } = await import('../lib/import/journal.js')
    const failingPersistence = {
      stat: async () => { const e = new Error(`storage backend echoed ${token}`); e.code = 'SYNTHETIC_STORAGE_FAILED'; throw e },
      open: async () => { throw new Error('unreachable') },
      list: async () => [],
    }
    const jobDir = join(dir, 'job')
    mkdirSync(jobDir, { recursive: true })
    const approvedPlan = {
      sourceDigest: 'src-f8',
      target: { instanceFingerprint: 'inst-f8' },
      selected: ['f8-s'],
      excluded: [],
      sessions: [],
    }
    approvedPlan.digest = planContentDigest(approvedPlan)
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: 'inst-f8', sourceDigest: 'src-f8' }, { requirePlanApproval: true })
    journal.approvePlan({ digest: approvedPlan.digest })
    journal.transitionBatch('PLANNED')
    // precondition: the token really is in the injected error input
    const probeError = await failingPersistence.stat().then(() => null, e => e)
    assert.ok(String(probeError.message).includes(token), 'precondition: the injected storage error carries the marker')

    let stdout = ''
    let stderr = ''
    const origOut = process.stdout.write.bind(process.stdout)
    const origErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = chunk => { stdout += String(chunk); return true }
    process.stderr.write = chunk => { stderr += String(chunk); return true }
    let report
    try {
      report = await runImportJob({
        jobDir,
        instanceLockDir: join(dir, 'lock'),
        instanceFingerprint: 'inst-f8',
        sourceDigest: 'src-f8',
        approvedPlan,
        target: { persistence: failingPersistence, workspaceRegistry: undefined, workspaceUnitProvider: undefined },
        sessions: [{ id: 'f8-s', header: { version: 4, id: 'f8-s' }, events: [], inheritedEventCount: 0 }],
        withdrawSession: async () => {},
        allowUnprotected: true,
      })
    } finally {
      process.stdout.write = origOut
      process.stderr.write = origErr
    }
    assert.equal(report.status, 'FAILED')
    // THE core F8 assertion: no public channel contains the token
    const hits = scanForMarker({ stdout, stderr, report: JSON.stringify(report) }, token)
    assert.deepEqual(hits, [], `public channels leaked the token: ${hits}`)
    assert.ok(!String(report.error?.message ?? '').includes(token), 'the public error message must not echo the token')
    // a raw lower-layer code is NOT a public code: only the fixed closed set
    // from this package may pass, so the synthetic foreign code falls back.
    assert.equal(report.error.code, 'RUNTIME_FAILURE', 'unknown foreign codes are classified to the fallback')
    assert.equal(report.error.publicTextWithheld, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 F8: shipped sources contain no runtime markers; the scanner detects deliberate stdout leaks', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const token = runtimeMarker()
  const dir = mkdtempSync(join(tmpdir(), 'f8-pkg-'))
  try {
    // NEGATIVE CONTROL: a child that deliberately leaks the token to stdout
    // must be DETECTED by the scanner (the previous test printed it and
    // passed anyway — that gap is what this control closes).
    const leakScript = `process.stdout.write(${JSON.stringify(`leak ${token}`)});`
    const leaked = spawnSync(process.execPath, ['--input-type=module', '-e', leakScript], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(leaked.status, 0)
    assert.deepEqual(scanForMarker({ stdout: leaked.stdout, stderr: leaked.stderr }, token), ['stdout'], 'the scanner MUST detect a deliberate stdout leak')
    // positive control: clean child output passes
    const clean = spawnSync(process.execPath, ['--input-type=module', '-e', 'process.stdout.write(JSON.stringify({clean:true}));'], { encoding: 'utf8', timeout: 60_000 })
    assert.deepEqual(scanForMarker({ stdout: clean.stdout, stderr: clean.stderr }, token), [])
    // static supplement: shipped lib sources cannot contain a RUNTIME token
    const libDir = join(import.meta.dirname, '..', 'lib')
    const walk = d => {
      let hits = 0
      for (const name of fs.readdirSync(d)) {
        const p = join(d, name)
        if (fs.statSync(p).isDirectory()) hits += walk(p)
        else if (p.endsWith('.js') && readFileSync(p, 'utf8').includes(token)) hits += 1
      }
      return hits
    }
    assert.equal(walk(libDir), 0, 'no shipped source may contain a runtime-generated token')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// F6 contract regression kept adjacent: NUL byte handling in staged files
test('P2 F6 adjacent: session logs with NUL bytes refuse (binary/truncated)', async () => {
  const { readSessionFile } = await import('../lib/inspect-sessions.js')
  const header = Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'nul', createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 }) + '\n')
  const withNul = Buffer.concat([header, Buffer.from([0x00]), Buffer.from('\n')])
  assert.throws(() => readSessionFile(withNul, { compressed: false }), /NUL byte/)
})

// F8 residual: error.code/name/stage fields themselves must not carry the
// runtime marker into the public report — the classifier publishes only the
// closed set of fixed constants from this package.
test('P2 F8 residual: raw error code/name/stage with the marker are classified out of the public report', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const token = runtimeMarker()
  // FORMAT-VALID negative control: a random uppercase-hex credential that
  // starts with a letter satisfies the old "uppercase/digit" format filter.
  // The closed set must still reject it.
  const credentialLikeCode = credentialLikeHex()
  assert.match(credentialLikeCode, /^[A-Z][A-Z0-9_]{2,63}$/, 'precondition: the injected code passes the FORMAT filter')
  const dir = mkdtempSync(join(tmpdir(), 'f8-fields-'))
  try {
    const { runImportJob } = await import('../lib/import/job.js')
    const { ImportJournal } = await import('../lib/import/journal.js')
    // a storage failure whose CODE (not just message) embeds credential-like
    // text — simulating a lower layer that interpolates sensitive data into
    // codes while keeping a format the old classifier accepted
    const failingPersistence = {
      stat: async () => { const e = new Error(`boom ${token}`); e.code = credentialLikeCode; e.stage = `stage-${token}`; throw e },
      open: async () => { throw new Error('unreachable') },
      list: async () => [],
    }
    const jobDir = join(dir, 'job')
    mkdirSync(jobDir, { recursive: true })
    const approvedPlan = {
      sourceDigest: 'src-f8b',
      target: { instanceFingerprint: 'inst-f8b' },
      selected: ['f8b-s'],
      excluded: [],
      sessions: [],
    }
    approvedPlan.digest = planContentDigest(approvedPlan)
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: 'inst-f8b', sourceDigest: 'src-f8b' }, { requirePlanApproval: true })
    journal.approvePlan({ digest: approvedPlan.digest })
    journal.transitionBatch('PLANNED')
    let stdout = ''
    let stderr = ''
    const origOut = process.stdout.write.bind(process.stdout)
    const origErr = process.stderr.write.bind(process.stderr)
    process.stdout.write = chunk => { stdout += String(chunk); return true }
    process.stderr.write = chunk => { stderr += String(chunk); return true }
    let report
    try {
      report = await runImportJob({
        jobDir,
        instanceLockDir: join(dir, 'lock'),
        instanceFingerprint: 'inst-f8b',
        sourceDigest: 'src-f8b',
        approvedPlan,
        target: { persistence: failingPersistence, workspaceRegistry: undefined, workspaceUnitProvider: undefined },
        sessions: [{ id: 'f8b-s', header: { version: 4, id: 'f8b-s' }, events: [], inheritedEventCount: 0 }],
        withdrawSession: async () => {},
        allowUnprotected: true,
      })
    } finally {
      process.stdout.write = origOut
      process.stderr.write = origErr
    }
    assert.equal(report.status, 'FAILED')
    const hits = scanForMarker({ stdout, stderr, report: JSON.stringify(report) }, token)
    assert.deepEqual(hits, [], `raw code/name/stage leaked the marker: ${hits}`)
    assert.equal(report.error.code, 'RUNTIME_FAILURE', 'a format-valid but UNKNOWN code must not be published')
    assert.notEqual(report.error.code, credentialLikeCode)
    assert.equal(report.error.stage, undefined, 'stage never enters the public report')
    assert.equal(report.error.name, undefined, 'name never enters the public report')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 F8: public error classification is a CLOSED SET (known constants only)', async () => {
  const { PUBLIC_ERROR_CODES, publicErrorCode } = await import('../lib/import/public-codes.js')
  // the set is explicit, non-trivial and entirely format-valid fixed text
  assert.ok(PUBLIC_ERROR_CODES.length > 40, `expected the full known-code set, got ${PUBLIC_ERROR_CODES.length}`)
  for (const code of PUBLIC_ERROR_CODES) {
    assert.match(code, /^[A-Z][A-Z0-9_]{2,63}$/)
  }
  // known package constants pass through unchanged
  assert.equal(publicErrorCode({ code: 'IMPORT_PLAN_BINDING' }), 'IMPORT_PLAN_BINDING')
  assert.equal(publicErrorCode({ code: 'G6_SNAPSHOT_CORRUPT' }), 'G6_SNAPSHOT_CORRUPT')
  // NEGATIVE CONTROL: format-valid but not in the set → fallback. A random
  // uppercase-hex credential (letter-leading) satisfied the old format-only
  // filter.
  const credentialLike = credentialLikeHex()
  assert.match(credentialLike, /^[A-Z][A-Z0-9_]{2,63}$/, 'precondition: passes the old format filter')
  assert.equal(publicErrorCode({ code: credentialLike }), 'RUNTIME_FAILURE')
  assert.equal(publicErrorCode({ code: credentialLike }, 'ROLLBACK_FAILURE'), 'ROLLBACK_FAILURE')
  // format-valid unknown non-credential code also falls back
  assert.equal(publicErrorCode({ code: 'SOME_FUTURE_CODE' }), 'RUNTIME_FAILURE')
  // non-string / missing codes
  assert.equal(publicErrorCode({}), 'RUNTIME_FAILURE')
  assert.equal(publicErrorCode({ code: 42 }), 'RUNTIME_FAILURE')
  assert.equal(publicErrorCode({ code: null }), 'RUNTIME_FAILURE')
})
