// P2 batch-3 basics: immutable plan.json + per-instance job lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlan, freezePlan, loadPlan, verifyPlanFresh } from '../lib/import/plan.js'
import { acquireJobLock, peekJobLock, breakStaleLock } from '../lib/import/lock.js'
import { ImportJournal } from '../lib/import/journal.js'

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

test('P2 F2: the lock is INSTANCE-level — two different job directories of one instance cannot both enter; generations protect release', () => {
  const shared = mkdtempSync(join(tmpdir(), 'lock-shared-'))
  const jobA = mkdtempSync(join(tmpdir(), 'job-a-'))
  const jobB = mkdtempSync(join(tmpdir(), 'job-b-'))
  try {
    // Both jobs pass the SAME instance-level lock directory.
    const a = acquireJobLock(shared, { instanceFingerprint: 'inst-1' })
    assert.equal(peekJobLock(shared).held, true)
    assert.throws(() => acquireJobLock(shared, { instanceFingerprint: 'inst-1' }), err => err.code === 'IMPORT_JOB_LOCKED')
    assert.equal(readdirSync(jobA).length + readdirSync(jobB).length, 0, 'job-private directories hold no lock file')
    void jobB

    // Generation identity: after an explicit stale break, the OLD handle must
    // not delete the NEW generation's lock.
    const broken = breakStaleLock(shared, { instanceFingerprint: 'inst-1', olderThanMs: 0 })
    assert.equal(broken.broken, true)
    const current = acquireJobLock(shared, { instanceFingerprint: 'inst-1' })
    assert.notEqual(current.holder.generation, a.holder.generation)
    a.release() // stale handle: content mismatch → no-op
    assert.equal(peekJobLock(shared).held, true, 'the old handle must not remove the new lock')
    assert.throws(() => acquireJobLock(shared, { instanceFingerprint: 'inst-1' }), err => err.code === 'IMPORT_JOB_LOCKED', 'a third job is still refused')
    // current releases, repeated release is safe
    current.release()
    current.release()
    assert.equal(peekJobLock(shared).held, false)
    const next = acquireJobLock(shared, { instanceFingerprint: 'inst-1' })
    next.release()
  } finally {
    rmSync(shared, { recursive: true, force: true })
    rmSync(jobA, { recursive: true, force: true })
    rmSync(jobB, { recursive: true, force: true })
  }
})

test('P2 F3: plan freshness compares canonical evidence CONTENT — identity/mode/missing-slot changes with equal counts are stale', () => {
  const makeReport = declared => ({
    counts: { total: 1, importable: 1, refused: 0, failed: 0 },
    sessions: [{ id: 'p', status: 'restored', importable: true, sourceGeneration: 3, headerVersion: 3, locationVerified: true }],
    ambiguous: [],
    unavailableDirs: [],
    childEvidence: { declared, unmatchedFacts: [], declaredMissing: [] },
  })
  const declaredA = [{ parent: 'p', child: 'child-A', mode: 'bound', sourceDirectory: '--w--/child-A' }]
  const plan = buildPlan({ sourceDigest: 's', instanceFingerprint: 'i', report: makeReport(declaredA) })
  assert.equal(verifyPlanFresh(plan, makeReport(declaredA)).ok, true)
  // same order different array instance → still fresh (content identical)
  assert.equal(verifyPlanFresh(plan, makeReport([{ ...declaredA[0] }])).ok, true)
  // count-preserving identity swap
  const swapped = makeReport([{ parent: 'p', child: 'child-B', mode: 'bound', sourceDirectory: '--w--/child-B' }])
  const r1 = verifyPlanFresh(plan, swapped)
  assert.equal(r1.ok, false)
  assert.ok(r1.reasons.some(r => /child evidence/.test(r)), JSON.stringify(r1.reasons))
  // count-preserving mode degradation
  const degraded = makeReport([{ ...declaredA[0], mode: 'unavailable-fact' }])
  assert.equal(verifyPlanFresh(plan, degraded).ok, false)
  // count-preserving NEW missing slot
  const missing = makeReport(declaredA)
  missing.childEvidence.declaredMissing = [{ path: '--w--/ghost/session.v3.jsonl', kind: 'MISSING' }]
  const r3 = verifyPlanFresh(plan, missing)
  assert.equal(r3.ok, false)
  assert.ok(r3.reasons.some(r => /declared missing slot/.test(r)), JSON.stringify(r3.reasons))
})

test('P2 plan: frozen versions are immutable — replacing a different approved version needs the explicit supersedes digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-ver-'))
  try {
    const file = join(dir, 'plan.json')
    const p1 = buildPlan({ sourceDigest: 's', instanceFingerprint: 'i', report: { sessions: [{ id: 'a', importable: true }], counts: {} } })
    freezePlan(file, p1)
    // same digest: idempotent
    freezePlan(file, p1)
    const p2 = buildPlan({ sourceDigest: 's', instanceFingerprint: 'i', report: { sessions: [{ id: 'a', importable: true }], counts: {} }, cwdMapping: { '/old': '/new' } })
    assert.notEqual(p1.digest, p2.digest)
    assert.throws(() => freezePlan(file, p2), err => err.code === 'PLAN_VERSION_CONFLICT')
    // explicit supersede of the exact frozen version
    freezePlan(file, p2, { supersedes: p1.digest })
    assert.equal(loadPlan(file, { sourceDigest: 's', instanceFingerprint: 'i' }).digest, p2.digest)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 journal: the approved plan digest is bound and enforced at IMPORTING', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-bind-'))
  try {
    const { computeSnapshotDigest } = await import('../lib/import/g6.js')
    const file = join(dir, 'j.json')
    const binding = { instanceFingerprint: 'inst-p', sourceDigest: 'src-p' }
    const snap = { workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], sessions: { a: { exists: false } }, ownership: { plannedCreates: [{ id: 'a', preExisting: false }] } }
    snap.digest = computeSnapshotDigest(snap)
    const plan = buildPlan({ sourceDigest: 'src-p', instanceFingerprint: 'inst-p', report: { sessions: [{ id: 'a', importable: true }], counts: {} } })
    const j = ImportJournal.init(file, binding, { requirePlanApproval: true })
    j.transitionBatch('PLANNED')
    j.setSnapshot(snap)
    j.transitionBatch('SNAPSHOT_READY')
    assert.throws(() => j.transitionBatch('IMPORTING'), err => err.code === 'JOURNAL_PLAN_MISMATCH', 'IMPORTING requires the approved plan digest')
    j.approvePlan({ digest: plan.digest })
    assert.throws(() => j.assertApprovedPlan({ digest: 'f'.repeat(64) }), err => err.code === 'JOURNAL_PLAN_MISMATCH')
    j.assertApprovedPlan(plan)
    j.transitionBatch('IMPORTING')
    // the binding survives a reload
    const reloaded = ImportJournal.load(file, binding)
    reloaded.acknowledgeRecovery()
    reloaded.assertApprovedPlan(plan)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
