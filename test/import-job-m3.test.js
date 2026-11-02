// P2 M3: unified run/resume/cancel job entry over the real rc.4 engine
// (isolated roots). Covers: attachments-first ordering, readback-verified
// sessions, workspace attach, DONE; duplicate replan classification; failure
// rollback with protected withdrawal; cancellation; RECOVERY_REQUIRED.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runImportJob } from '../lib/import/job.js'
import { buildPlan, freezePlan } from '../lib/import/plan.js'
import { ImportJournal } from '../lib/import/journal.js'
import { createJsonlWithdrawalAdapter } from '../lib/import/withdraw.js'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir

async function loadChain() {
  const { setModuleLoader } = await import('../lib/migration/legacy-chain.js')
  const req = createRequire(join(rc4Dir, 'noop.js'))
  await setModuleLoader(async () => ({
    cat: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href),
    v3: await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href),
  }))
  return import('../lib/migration/legacy-chain.js')
}

async function mountEngine() {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
  const storagePkg = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage')).href)
  const storageJson = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-json')).href)
  const storageDomain = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-domain')).href)
  const workspacePkg = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-workspace')).href)
  const attachmentLocal = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-attachment-local')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const base = mkdtempSync(join(tmpdir(), 'm3-engine-'))
  const storageRoot = join(base, 'storage')
  mkdirSync(storageRoot, { recursive: true })
  const dshHome = join(base, 'dshhome')
  mkdirSync(dshHome, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(storagePkg.Storage, {})
  await ctx.plugin(storageJson, { root: storageRoot })
  await ctx.plugin(storageDomain, { backend: 'json' })
  mkdirSync(join(base, 'sessions'), { recursive: true })
  await ctx.plugin(jsonl, { root: join(base, 'sessions'), compression: 'zstd' })
  await ctx.plugin(workspacePkg.WorkspaceRegistry)
  await ctx.plugin(attachmentLocal.default, { dshHome })
  return {
    base,
    storageRoot,
    dshHome,
    sessionsRoot: join(base, 'sessions'),
    persistence: ctx.sessionPersistence,
    workspaceRegistry: ctx.workspaceRegistry,
    attachments: ctx.attachments,
    attachmentRoot: join(dshHome, 'attachments', 'v1'),
    locateDir(header) {
      const loc = ctx.sessionPersistence.locate(header)
      return relative(join(base, 'sessions'), loc.path).split(sep).slice(0, -1).join('/')
    },
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(base, { recursive: true, force: true })
    },
  }
}

const sha = b => createHash('sha256').update(b).digest('hex')

async function candidate(id, cwd, { fileBytes = null, withWorkspace = true } = {}) {
  const chain = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  const codec = v23.releasedV3SessionFormatCodec
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const content = [{ type: 'text', text: `M3 ${id}` }]
  if (fileBytes) {
    content.push({ type: 'file', attachment: { attachmentId: `sha256:${sha(fileBytes)}`, name: 'report.txt', bytes: fileBytes.length } })
  }
  const logical = [
    e('turn/start', 0, { turn: 1 }),
    e('user/message', 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content }, { surfaceOp: 'append' }),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const physicalHeader = codec.encodeHeader({ version: 3, id, createdAt: 1793500000000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }, 0)
  const out = await chain.migrateToV4(physicalHeader, logical.map(ev => codec.encodeEvent(ev)), { childFacts: null })
  const cat = (await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)).sessionFormatCatalog
  const restore = cat.createRestore(out.headerRow, { recovery: 'strict', validation: 'current' })
  for (const row of out.eventRows) restore.decodeRow(row)
  const artifact = restore.finish()
  return {
    id,
    header: { ...artifact.header, agentPreset: 'standard' },
    events: artifact.events,
    inheritedEventCount: artifact.inheritedEventCount ?? 0,
    workspace: withWorkspace ? { path: cwd, title: 'M3 导入区' } : null,
  }
}

async function approvedPlanFor(dir, sessions, { sourceDigest = 'src-m3', instanceFingerprint = 'inst-m3' } = {}) {
  const report = { sessions: sessions.map(s => ({ id: s.id, status: 'restored', importable: true, sourceGeneration: 4, headerVersion: 4 })), counts: { total: sessions.length } }
  const plan = buildPlan({ sourceDigest, instanceFingerprint, report })
  const file = join(dir, 'plan.json')
  freezePlan(file, plan)
  return { plan, file }
}

test('P2 M3 run: attachments published BEFORE sessions, readback verified, workspace attached, DONE', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountEngine()
  const jobDir = mkdtempSync(join(tmpdir(), 'm3-job-'))
  try {
    const wdir = join(t.base, 'w')
    mkdirSync(wdir, { recursive: true })
    const fileBytes = Buffer.from('M3 verbatim attachment\n')
    const s1 = await candidate('m3-s1', wdir, { fileBytes })
    const { plan } = await approvedPlanFor(jobDir, [s1])
    const journalFile = join(jobDir, 'journal.json')
    const journal = ImportJournal.init(journalFile, { instanceFingerprint: 'inst-m3', sourceDigest: 'src-m3' }, { requirePlanApproval: true })
    journal.approvePlan({ digest: plan.digest, file: join(jobDir, 'plan.json') })
    // the job expects an existing journal already in PLANNED (init created NEW)
    journal.transitionBatch('PLANNED')

    const withdraw = createJsonlWithdrawalAdapter({
      persistence: t.persistence,
      sessionsRoot: t.sessionsRoot,
      locateDir: h => t.locateDir(h),
      quarantineRoot: join(jobDir, 'quarantine'),
    })
    const result = await runImportJob({
      jobDir,
      instanceLockDir: join(jobDir, 'lock'),
      instanceFingerprint: 'inst-m3',
      sourceDigest: 'src-m3',
      approvedPlan: plan,
      target: t,
      sessions: [s1],
      readAttachmentSource: async () => fileBytes,
      attachmentExists: async () => false,
      withdrawSession: withdraw,
      allowUnprotected: true,
    })
    assert.equal(result.status, 'DONE', JSON.stringify(result))
    // attachments-first ordering in the journal
    const actions = JSON.parse(readFileSync(journalFile, 'utf8')).actions
    const types = actions.map(a => a.type)
    assert.ok(types.indexOf('attachment.publish') < types.indexOf('session.import'), `order: ${types}`)
    assert.ok(types.indexOf('session.import') < types.indexOf('session.attach'), `order: ${types}`)
    // attachment readback through the official store
    const ref = { attachmentId: `sha256:${sha(fileBytes)}`, name: 'report.txt', bytes: fileBytes.length }
    const chunks = []
    for await (const c of t.attachments.readFileStream(ref)) chunks.push(Buffer.from(c))
    assert.deepEqual(Buffer.concat(chunks), fileBytes)
    // session exists + workspace attach
    assert.ok(await t.persistence.stat('m3-s1'))
    const ws = t.workspaceRegistry.list().find(w => w.path === wdir)
    assert.ok(ws, 'workspace registration exists')
    assert.ok(ws.sessionIds.includes('m3-s1'), 'session attached to the workspace')
    // journal terminal
    const reloaded = ImportJournal.load(journalFile, { instanceFingerprint: 'inst-m3', sourceDigest: 'src-m3' })
    assert.equal(reloaded.state.batchState, 'DONE')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 M3 run: an existing identical session yields REPLAN_REQUIRED with no target writes', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountEngine()
  const jobDir = mkdtempSync(join(tmpdir(), 'm3-dup-'))
  try {
    const wdir = join(t.base, 'w')
    mkdirSync(wdir, { recursive: true })
    const s1 = await candidate('m3-dup', wdir, { withWorkspace: false })
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    await importSessionViaA(t.persistence, s1)
    const { plan } = await approvedPlanFor(jobDir, [s1])
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: 'inst-m3', sourceDigest: 'src-m3' }, { requirePlanApproval: true })
    journal.approvePlan({ digest: plan.digest })
    journal.transitionBatch('PLANNED')
    const result = await runImportJob({
      jobDir,
      instanceLockDir: join(jobDir, 'lock'),
      instanceFingerprint: 'inst-m3',
      sourceDigest: 'src-m3',
      approvedPlan: plan,
      target: t,
      sessions: [s1],
      withdrawSession: async () => { throw new Error('must not withdraw an existing session') },
      allowUnprotected: true,
    })
    assert.equal(result.status, 'REPLAN_REQUIRED')
    assert.equal(result.existing[0].classification, 'identical')
    assert.equal(result.attachments.published, 0)
    const actions = JSON.parse(readFileSync(join(jobDir, 'journal.json'), 'utf8')).actions
    assert.equal(actions.length, 0, 'no target action was recorded or performed')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 M3 run: a failure after session creation rolls back through protected withdrawal and returns the target to the snapshot', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountEngine()
  const jobDir = mkdtempSync(join(tmpdir(), 'm3-fail-'))
  try {
    const wdir = join(t.base, 'w')
    mkdirSync(wdir, { recursive: true })
    const s1 = await candidate('m3-fail', wdir, { withWorkspace: false })
    const { plan } = await approvedPlanFor(jobDir, [s1])
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: 'inst-m3', sourceDigest: 'src-m3' }, { requirePlanApproval: true })
    journal.approvePlan({ digest: plan.digest })
    journal.transitionBatch('PLANNED')
    const withdraw = createJsonlWithdrawalAdapter({
      persistence: t.persistence,
      sessionsRoot: t.sessionsRoot,
      locateDir: h => t.locateDir(h),
      quarantineRoot: join(jobDir, 'quarantine'),
    })
    // force the failure AFTER the session import: the workspace path does not
    // exist, so registry.create refuses; the job must roll back.
    const ghostWorkspace = { ...s1, workspace: { path: join(t.base, 'does-not-exist'), title: 'ghost' } }
    const result = await runImportJob({
      jobDir,
      instanceLockDir: join(jobDir, 'lock'),
      instanceFingerprint: 'inst-m3',
      sourceDigest: 'src-m3',
      approvedPlan: plan,
      target: t,
      sessions: [ghostWorkspace],
      withdrawSession: withdraw,
      allowUnprotected: true,
    })
    assert.ok(['ROLLED_BACK', 'ROLLBACK_PENDING', 'FAILED'].includes(result.status), JSON.stringify(result))
    assert.equal(await t.persistence.stat('m3-fail'), undefined, 'the created session was withdrawn')
    const reloaded = ImportJournal.load(join(jobDir, 'journal.json'), { instanceFingerprint: 'inst-m3', sourceDigest: 'src-m3' })
    assert.ok(['ROLLED_BACK', 'ROLLBACK_PENDING', 'IMPORTING', 'VERIFYING_TARGET'].includes(reloaded.state.batchState), reloaded.state.batchState)
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 M3 resume: a restored mid-import journal demands an explicit recovery judgment; a rollback judgment compensates without replaying', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountEngine()
  const jobDir = mkdtempSync(join(tmpdir(), 'm3-resume-'))
  try {
    const wdir = join(t.base, 'w')
    mkdirSync(wdir, { recursive: true })
    const s1 = await candidate('m3-resume', wdir, { withWorkspace: false })
    const { plan } = await approvedPlanFor(jobDir, [s1])
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: 'inst-m3', sourceDigest: 'src-m3' }, { requirePlanApproval: true })
    journal.approvePlan({ digest: plan.digest })
    journal.transitionBatch('PLANNED')
    // simulate a crash mid-import: snapshot + IMPORTING + one open intent
    const { captureTargetPreState } = await import('../lib/import/g6.js')
    const snap = await captureTargetPreState({ persistence: t.persistence, workspaceRegistry: t.workspaceRegistry, plannedSessionIds: ['m3-resume'] })
    journal.setSnapshot(snap)
    journal.transitionBatch('SNAPSHOT_READY')
    journal.beginImport(plan)
    journal.intent({ type: 'session.import', sessionId: 'm3-resume' })

    const first = await runImportJob({
      jobDir,
      instanceLockDir: join(jobDir, 'lock'),
      instanceFingerprint: 'inst-m3',
      sourceDigest: 'src-m3',
      approvedPlan: plan,
      target: t,
      sessions: [s1],
      withdrawSession: async () => { throw new Error('no withdrawal during a recovery check') },
      allowUnprotected: true,
    })
    assert.equal(first.status, 'RECOVERY_REQUIRED', JSON.stringify(first))
    assert.equal(first.recovery.batchState, 'IMPORTING')
    assert.equal(first.recovery.openIntents.length, 1)

    // explicit judgment: rollback (unknown intent → pending, no withdrawal)
    let withdrawCalls = 0
    const second = await runImportJob({
      jobDir,
      instanceLockDir: join(jobDir, 'lock'),
      instanceFingerprint: 'inst-m3',
      sourceDigest: 'src-m3',
      approvedPlan: plan,
      target: t,
      sessions: [s1],
      withdrawSession: async () => { withdrawCalls += 1 },
      recoveredJudgment: { resolveOpenIntents: 'rollback' },
      allowUnprotected: true,
    })
    assert.ok(['ROLLBACK_PENDING', 'ROLLED_BACK'].includes(second.status), JSON.stringify(second))
    assert.equal(withdrawCalls, 0, 'an unconfirmed import intent is never auto-withdrawn')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 M3 cancel: a pre-aborted run compensates at the safe boundary and reports CANCELLED', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountEngine()
  const jobDir = mkdtempSync(join(tmpdir(), 'm3-cancel-'))
  try {
    const wdir = join(t.base, 'w')
    mkdirSync(wdir, { recursive: true })
    const s1 = await candidate('m3-cancel', wdir, { withWorkspace: false })
    const { plan } = await approvedPlanFor(jobDir, [s1])
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: 'inst-m3', sourceDigest: 'src-m3' }, { requirePlanApproval: true })
    journal.approvePlan({ digest: plan.digest })
    journal.transitionBatch('PLANNED')
    const controller = new AbortController()
    controller.abort()
    const result = await runImportJob({
      jobDir,
      instanceLockDir: join(jobDir, 'lock'),
      instanceFingerprint: 'inst-m3',
      sourceDigest: 'src-m3',
      approvedPlan: plan,
      target: t,
      sessions: [s1],
      withdrawSession: async () => { throw new Error('nothing was written, nothing to withdraw') },
      signal: controller.signal,
      allowUnprotected: true,
    })
    assert.ok(['CANCELLED', 'CANCELLED_ROLLBACK_PENDING'].includes(result.status), JSON.stringify(result))
    assert.equal(await t.persistence.stat('m3-cancel'), undefined, 'no session was created')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})
