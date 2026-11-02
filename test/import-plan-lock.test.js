// P2 batch-3 basics: immutable plan.json + per-instance job lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlan, freezePlan, loadPlan, verifyPlanFresh } from '../lib/import/plan.js'
import { acquireJobLock, peekJobLock, breakStaleLock } from '../lib/import/lock.js'

const report = () => ({
  counts: { total: 2, importable: 2, refused: 0, failed: 0 },
  sessions: [
    { id: 'p/a', status: 'restored', importable: true, sourceGeneration: 4, headerVersion: 4, locationVerified: true },
    { id: 'p/b', status: 'restored', importable: true, sourceGeneration: 3, headerVersion: 3, locationVerified: true },
  ],
  ambiguous: [],
  unavailableDirs: [],
  childEvidence: { declared: [], unmatchedFacts: [], declaredMissing: [] },
})

test('P2 plan: freeze/load round-trip; tampering, source change and target change are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-'))
  try {
    const file = join(dir, 'plan.json')
    const plan = buildPlan({ sourceDigest: 'src-1', instanceFingerprint: 'inst-1', report: report() })
    assert.equal(plan.selected.length, 2)
    freezePlan(file, plan)
    const loaded = loadPlan(file, { sourceDigest: 'src-1', instanceFingerprint: 'inst-1' })
    assert.deepEqual(loaded.selected, ['p/a', 'p/b'])
    // content tamper → corrupt
    const tampered = JSON.parse(readFileSync(file, 'utf8'))
    tampered.selected = ['p/a']
    writeFileSync(file, JSON.stringify(tampered))
    assert.throws(() => loadPlan(file, { sourceDigest: 'src-1', instanceFingerprint: 'inst-1' }), err => err.code === 'PLAN_CORRUPT')
    // source changed → expired
    freezePlan(file, plan)
    assert.throws(() => loadPlan(file, { sourceDigest: 'src-2', instanceFingerprint: 'inst-1' }), err => err.code === 'PLAN_EXPIRED')
    // target changed → expired
    assert.throws(() => loadPlan(file, { sourceDigest: 'src-1', instanceFingerprint: 'inst-2' }), err => err.code === 'PLAN_EXPIRED')
    // exclusions must be explicit with a reason and cannot overlap selection
    assert.throws(() => buildPlan({ sourceDigest: 's', instanceFingerprint: 'i', report: report(), excluded: [{ id: 'p/b' }] }), /reason/)
    assert.throws(() => buildPlan({ sourceDigest: 's', instanceFingerprint: 'i', report: report(), excluded: [{ id: 'p/b', reason: 'x' }] }), /both selected and excluded/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 plan: verifyPlanFresh detects new ambiguity/unavailability/importability/child-evidence changes', () => {
  const base = buildPlan({ sourceDigest: 's', instanceFingerprint: 'i', report: report() })
  assert.equal(verifyPlanFresh(base, report()).ok, true)
  const changed = report()
  changed.ambiguous = [{ relDir: 'p/c', generation: 4, candidates: ['a', 'b'] }]
  assert.equal(verifyPlanFresh(base, changed).ok, false)
  const gone = report()
  gone.sessions[0].importable = false
  assert.ok(verifyPlanFresh(base, gone).reasons.some(r => /p\/a is no longer importable/.test(r)))
  const child = report()
  child.childEvidence.declared = [{ parent: 'p/a', child: 'k', mode: 'bound' }]
  assert.ok(verifyPlanFresh(base, child).reasons.some(r => /child evidence changed/.test(r)))
})

test('P2 lock: one job per target instance; release; explicit stale break only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'))
  try {
    const lock = acquireJobLock(dir, { instanceFingerprint: 'inst-1' })
    assert.equal(peekJobLock(dir).held, true)
    // a second job refuses with the holder details
    assert.throws(() => acquireJobLock(dir, { instanceFingerprint: 'inst-1' }), err => err.code === 'IMPORT_JOB_LOCKED' && err.holder?.pid === process.pid)
    assert.throws(() => acquireJobLock(dir, { instanceFingerprint: 'inst-2' }), err => err.code === 'IMPORT_JOB_LOCKED')
    // breaking a different instance's lock is refused
    assert.throws(() => breakStaleLock(dir, { instanceFingerprint: 'inst-2' }), err => err.code === 'IMPORT_JOB_LOCKED')
    // a fresh lock is not breakable with a threshold
    assert.throws(() => breakStaleLock(dir, { instanceFingerprint: 'inst-1', olderThanMs: 60_000 }), err => err.code === 'IMPORT_JOB_LOCKED')
    // explicit break (caller judged the journal) then re-acquire
    const broken = breakStaleLock(dir, { instanceFingerprint: 'inst-1', olderThanMs: 0 })
    assert.equal(broken.broken, true)
    assert.equal(existsSync(lock.file), false)
    const again = acquireJobLock(dir, { instanceFingerprint: 'inst-1' })
    again.release()
    assert.equal(peekJobLock(dir).held, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
