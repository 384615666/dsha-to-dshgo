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

test('P2 journal: approved-plan gate verifies the ACTUAL plan content, binding and set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-bind-'))
  try {
    const { computeSnapshotDigest } = await import('../lib/import/g6.js')
    const file = join(dir, 'j.json')
    const planFile = join(dir, 'plan.json')
    const binding = { instanceFingerprint: 'inst-p', sourceDigest: 'src-p' }
    const snap = { workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], sessions: { a: { exists: false } }, ownership: { plannedCreates: [{ id: 'a', preExisting: false }] } }
    snap.digest = computeSnapshotDigest(snap)
    const report = { sessions: [{ id: 'a', importable: true }], counts: {} }
    const planA = buildPlan({ sourceDigest: 'src-p', instanceFingerprint: 'inst-p', report })
    freezePlan(planFile, planA)
    const j = ImportJournal.init(file, binding, { requirePlanApproval: true })
    j.transitionBatch('PLANNED')
    j.setSnapshot(snap)
    j.transitionBatch('SNAPSHOT_READY')

    // raw transition refuses in approval mode; there is no content check
    assert.throws(() => j.transitionBatch('IMPORTING'), err => err.code === 'JOURNAL_PLAN_MISMATCH')
    // no approval bound yet
    assert.throws(() => j.beginImport(planA), err => err.code === 'JOURNAL_PLAN_MISMATCH')
    j.approvePlan({ digest: planA.digest, file: planFile })

    // (a) altered IN-MEMORY content carrying the old digest is refused
    const tampered = JSON.parse(JSON.stringify(planA))
    tampered.cwdMapping = { '/x': '/y' }
    assert.throws(() => j.beginImport(tampered), err => err.code === 'PLAN_CORRUPT')
    // (b) consistent plan passes and records the importing version
    const started = j.beginImport(planA)
    assert.equal(started.digest, planA.digest)
    assert.equal(j.state.importingPlan.digest, planA.digest)

    // (c) a DIFFERENT (explicitly superseded) plan file replacing the bound
    // one after approval is caught even when the caller passes the old object
    const planB = buildPlan({ sourceDigest: 'src-p', instanceFingerprint: 'inst-p', report, cwdMapping: { '/x': '/y' } })
    freezePlan(planFile, planB, { supersedes: planA.digest })
    const j2 = ImportJournal.init(join(dir, 'j2.json'), binding, { requirePlanApproval: true })
    j2.transitionBatch('PLANNED')
    j2.setSnapshot(snap)
    j2.transitionBatch('SNAPSHOT_READY')
    j2.approvePlan({ digest: planA.digest, file: planFile })
    assert.throws(() => j2.beginImport(planA), err => err.code === 'JOURNAL_PLAN_MISMATCH')
    // (d) plan with a different source/target binding is refused
    const foreignPlan = buildPlan({ sourceDigest: 'other-src', instanceFingerprint: 'inst-p', report })
    const j3 = ImportJournal.init(join(dir, 'j3.json'), binding, { requirePlanApproval: true })
    j3.transitionBatch('PLANNED')
    j3.setSnapshot(snap)
    j3.transitionBatch('SNAPSHOT_READY')
    j3.approvePlan({ digest: foreignPlan.digest })
    assert.throws(() => j3.beginImport(foreignPlan), err => err.code === 'JOURNAL_PLAN_BINDING')
    // (e) selected set must match the persisted plan
    freezePlan(planFile, planA, { supersedes: planB.digest })
    const emptyPlan = buildPlan({ sourceDigest: 'src-p', instanceFingerprint: 'inst-p', report, selectedIds: [] })
    const j4 = ImportJournal.init(join(dir, 'j4.json'), binding, { requirePlanApproval: true })
    j4.transitionBatch('PLANNED')
    j4.setSnapshot(snap)
    j4.transitionBatch('SNAPSHOT_READY')
    j4.approvePlan({ digest: emptyPlan.digest })
    assert.throws(() => j4.beginImport(emptyPlan), err => err.code === 'JOURNAL_PLAN_BINDING')
    // (f) reload: recovery check + the same approved version still verifies
    const reloaded = ImportJournal.load(file, binding)
    reloaded.acknowledgeRecovery()
    reloaded.assertApprovedPlan(planA)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 lock: two CROSS-PROCESS reclaimers cannot interleave — a newer generation survives intact', async () => {
  const { spawn } = await import('node:child_process')
  const { writeFileSync: writeFile, existsSync: exists } = await import('node:fs')
  const { pathToFileURL: p2u } = await import('node:url')
  const dir = mkdtempSync(join(tmpdir(), 'lock-race-'))
  const signalDir = mkdtempSync(join(tmpdir(), 'lock-sig-'))
  const signalFile = join(signalDir, 'a-inside')
  const goFile = join(signalDir, 'go')
  const libUrl = p2u(join(import.meta.dirname, '..', 'lib', 'import', 'lock.js')).href
  const run = (script, args) => new Promise(resolve => {
    const cp = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    cp.stdout.on('data', d => { out += d })
    cp.stderr.on('data', d => { err += d })
    cp.on('close', code => resolve({ code, out, err }))
  })
  const waitFor = async (file, ms = 10_000) => {
    const start = Date.now()
    while (!exists(file)) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${file}`)
      await new Promise(r => setTimeout(r, 20))
    }
  }
  try {
    // A crashed owner left generation G1 behind.
    writeFile(join(dir, 'import-job.lock'), JSON.stringify({
      instanceFingerprint: 'inst-race', ownerId: 'dead-owner', generation: 'G1', pid: 999999, at: new Date(0).toISOString(),
    }))
    const reclaimerA = run(`
      const { breakStaleLock } = await import(${JSON.stringify(libUrl)});
      const fs = await import('node:fs');
      const [dir, signal, go] = process.argv.slice(1);
      const res = breakStaleLock(dir, { instanceFingerprint: 'inst-race', olderThanMs: 0, hooks: {
        beforeUnlink() {
          fs.writeFileSync(signal, '1');
          const t0 = Date.now();
          while (!fs.existsSync(go)) {
            if (Date.now() - t0 > 8000) throw new Error('hook timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        },
      } });
      process.stdout.write(JSON.stringify(res));
    `, [dir, signalFile, goFile])
    await waitFor(signalFile)
    // Reclaimer B starts while A is paused INSIDE the guard: it must block.
    const reclaimerB = run(`
      const { breakStaleLock } = await import(${JSON.stringify(libUrl)});
      const [dir] = process.argv.slice(1);
      const res = breakStaleLock(dir, { instanceFingerprint: 'inst-race', olderThanMs: 0 });
      process.stdout.write(JSON.stringify(res));
    `, [dir])
    await new Promise(r => setTimeout(r, 300))
    writeFile(goFile, '1')
    const [a, b] = await Promise.all([reclaimerA, reclaimerB])
    assert.equal(a.code, 0, `A stderr: ${a.err.slice(0, 300)}`)
    assert.equal(b.code, 0, `B stderr: ${b.err.slice(0, 300)}`)
    const resA = JSON.parse(a.out)
    const resB = JSON.parse(b.out)
    assert.equal(resA.broken, true, 'the first reclaimer removes the stale G1')
    assert.equal(resB.broken, false, 'the second reclaimer must observe the serialized state, not delete a newer lock')
    // a new holder now acquires; no stale reclaimer may remove it
    const current = acquireJobLock(dir, { instanceFingerprint: 'inst-race' })
    assert.equal(peekJobLock(dir).held, true)
    const third = run(`
      const { acquireJobLock } = await import(${JSON.stringify(libUrl)});
      const [dir] = process.argv.slice(1);
      try { const l = acquireJobLock(dir, { instanceFingerprint: 'inst-race' }); l.release(); process.stdout.write(JSON.stringify({ acquired: true })); }
      catch (e) { process.stdout.write(JSON.stringify({ acquired: false, code: e.code })); }
    `, [dir])
    const resThird = JSON.parse((await third).out)
    assert.equal(resThird.acquired, false, 'a third job must be refused while the new generation is unreleased')
    assert.equal(resThird.code, 'IMPORT_JOB_LOCKED')
    assert.equal(peekJobLock(dir).held, true, 'the new generation lock is still present')
    current.release()
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(signalDir, { recursive: true, force: true })
  }
})
