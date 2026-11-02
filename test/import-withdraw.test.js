// P2 batch-3 W4 acceptance: the PROTECTED withdrawal adapter holds the write
// lease ACROSS the directory move — the probe→close→move window that the
// review reproduced deterministically is closed. Tests use the real rc.4
// isolated backend; the competing writer runs during the critical section
// through the adapter's test seam.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createJsonlWithdrawalAdapter, quarantineNameFor } from '../lib/import/withdraw.js'
import { ImportJournal } from '../lib/import/journal.js'
import { captureTargetPreState, rollbackBatch } from '../lib/import/g6.js'

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

async function mountTarget() {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
  const storagePkg = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage')).href)
  const storageJson = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-json')).href)
  const storageDomain = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-domain')).href)
  const workspacePkg = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-workspace')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const base = mkdtempSync(join(tmpdir(), 'w4-target-'))
  const ctx = new Context()
  await ctx.plugin(storagePkg.Storage, {})
  mkdirSync(join(base, 'storage'), { recursive: true })
  await ctx.plugin(storageJson, { root: join(base, 'storage') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  const sessionsRoot = join(base, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  await ctx.plugin(jsonl, { root: sessionsRoot, compression: 'zstd' })
  await ctx.plugin(workspacePkg.WorkspaceRegistry)
  return {
    persistence: ctx.sessionPersistence,
    workspaceRegistry: ctx.workspaceRegistry,
    sessionsRoot,
    base,
    locateDir(header) {
      const loc = ctx.sessionPersistence.locate(header)
      return relative(sessionsRoot, loc.path).split(sep).slice(0, -1).join('/')
    },
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(base, { recursive: true, force: true })
    },
  }
}

async function canonicalCandidate(id, cwd) {
  const chain = await loadChain()
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const v23 = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href)
  const codec = v23.releasedV3SessionFormatCodec
  const e = (type, seq, data, extra = {}) => ({ type, seq, time: seq + 100, data, ...extra })
  const logical = [
    e('turn/start', 0, { turn: 1 }),
    e('user/message', 1, { id: `${id}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'W4 验证' }] }, { surfaceOp: 'append' }),
    e('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const physicalHeader = codec.encodeHeader({ version: 3, id, createdAt: 1793500000000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }, 0)
  const out = await chain.migrateToV4(physicalHeader, logical.map(ev => codec.encodeEvent(ev)), { childFacts: null })
  const cat = (await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-catalog')).href)).sessionFormatCatalog
  const restore = cat.createRestore(out.headerRow, { recovery: 'strict', validation: 'current' })
  for (const row of out.eventRows) restore.decodeRow(row)
  const artifact = restore.finish()
  return { header: { ...artifact.header, agentPreset: 'standard' }, events: artifact.events, inheritedEventCount: artifact.inheritedEventCount ?? 0 }
}

async function prepareBatch(t, jobDir, id) {
  const { importSessionViaA } = await import('../lib/import/writer-a.js')
  const journal = ImportJournal.init(join(jobDir, 'j.json'), { instanceFingerprint: t.sessionsRoot, sourceDigest: 'src' })
  const snapshot = await captureTargetPreState({ persistence: t.persistence, workspaceRegistry: t.workspaceRegistry, plannedSessionIds: [id] })
  journal.transitionBatch('PLANNED')
  journal.setSnapshot(snapshot)
  journal.transitionBatch('SNAPSHOT_READY')
  journal.transitionBatch('IMPORTING')
  const seq = journal.intent({ type: 'session.import', sessionId: id })
  const candidate = await canonicalCandidate(id, t.base)
  const imported = await importSessionViaA(t.persistence, candidate)
  journal.confirm(seq, { revision: imported.revision, cwd: candidate.header.cwd })
  journal.transitionBatch('ROLLING_BACK')
  return { journal, snapshot, candidate, imported }
}

test('P2 W4: a competing writer cannot enter during the protected withdrawal — the review\'s interleaving is closed', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'w4-job-'))
  try {
    const { journal, snapshot } = await prepareBatch(t, jobDir, 'w4-s')
    let competingRefused = null
    let competingAppended = 0
    const withdraw = createJsonlWithdrawalAdapter({
      persistence: t.persistence,
      sessionsRoot: t.sessionsRoot,
      locateDir: h => t.locateDir(h),
      quarantineRoot: join(jobDir, 'quarantine'),
      hooks: {
        // Runs WHILE the adapter holds the write lease, BEFORE the move —
        // exactly the window the review exploited with probe→close→move.
        afterAcquire: async ({ id }) => {
          let w = null
          try {
            w = await t.persistence.open(id, 'write')
            // If the service wrongly allowed a second owner, the competing
            // write would land — count it and fail loudly below.
            const snap = await t.persistence.stat(id)
            const seq = 3 // candidate has events 0..2
            await w.append([{ type: 'turn/start', seq, time: 999, data: { turn: 2, user: true } }])
            await w.flush()
            competingAppended += 1
            void snap
          } catch (error) {
            competingRefused = `${error?.name}`
          } finally {
            try { await w?.close?.() } catch { /* competing handle */ }
          }
        },
      },
    })
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot,
      plannedSessionIds: ['w4-s'],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      withdrawSession: withdraw,
      journal,
    })
    assert.equal(competingAppended, 0, 'no competing append may land inside the protected section')
    assert.match(competingRefused ?? '', /SessionAlreadyOwned/, `the competing open must be refused while the lease is held (got ${competingRefused})`)
    assert.equal(rb.outcome, 'complete', JSON.stringify({ conflicts: rb.conflicts, failures: rb.failures, diffs: rb.verification.diffs }))
    assert.equal(await t.persistence.stat('w4-s'), undefined, 'session withdrawn from the active namespace')
    const quarantined = join(jobDir, 'quarantine', quarantineNameFor('w4-s'))
    assert.ok(existsSync(quarantined), 'payload kept recoverable in quarantine')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 W4: content that changed before the lease was acquired is NOT withdrawn — pending, no move', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'w4-rev-'))
  try {
    const { journal, snapshot, candidate } = await prepareBatch(t, jobDir, 'w4-r')
    // user appends BEFORE rollback (ownership free): revision changes
    const w = await t.persistence.open('w4-r', 'write')
    await w.append([{ type: 'turn/start', seq: 3, time: 999, data: { turn: 2, user: true } }])
    await w.flush()
    await w.close()
    const withdraw = createJsonlWithdrawalAdapter({
      persistence: t.persistence,
      sessionsRoot: t.sessionsRoot,
      locateDir: h => t.locateDir(h),
      quarantineRoot: join(jobDir, 'quarantine'),
    })
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot,
      plannedSessionIds: ['w4-r'],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      withdrawSession: withdraw,
      journal,
    })
    assert.equal(rb.outcome, 'pending')
    assert.ok(rb.conflicts.some(c => /changed after our write|revision changed/.test(c.reason)), JSON.stringify(rb.conflicts))
    assert.ok(await t.persistence.stat('w4-r'), 'the session stays visible')
    assert.ok(!existsSync(join(jobDir, 'quarantine', quarantineNameFor('w4-r'))), 'nothing was quarantined')
    void candidate
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 W4: the adapter refuses to overwrite an existing quarantined payload', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'w4-dup-'))
  try {
    const { journal, snapshot, candidate, imported } = await prepareBatch(t, jobDir, 'w4-d')
    mkdirSync(join(jobDir, 'quarantine', quarantineNameFor('w4-d')), { recursive: true })
    const withdraw = createJsonlWithdrawalAdapter({
      persistence: t.persistence,
      sessionsRoot: t.sessionsRoot,
      locateDir: h => t.locateDir(h),
      quarantineRoot: join(jobDir, 'quarantine'),
    })
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot,
      plannedSessionIds: ['w4-d'],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      withdrawSession: withdraw,
      journal,
    })
    assert.equal(rb.outcome, 'pending')
    assert.ok(rb.conflicts.some(c => /quarantine already holds/.test(c.reason)), JSON.stringify(rb.conflicts))
    assert.ok(await t.persistence.stat('w4-d'), 'the session must not be moved on an ambiguous quarantine state')
    void candidate
    void imported
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 F1: quarantine names never derive from the raw session id — slash / traversal / CJK ids stay inside quarantine', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'f1-paths-'))
  const quarantineRoot = join(jobDir, 'quarantine')
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    const ids = ['plain-id', 'ordinary/slash', 'nested/../../escaped-quarantine', '会话-id']
    const results = []
    for (const id of ids) {
      const candidate = await canonicalCandidate(id, t.base)
      const imported = await importSessionViaA(t.persistence, candidate)
      const withdraw = createJsonlWithdrawalAdapter({
        persistence: t.persistence,
        sessionsRoot: t.sessionsRoot,
        locateDir: h => t.locateDir(h),
        quarantineRoot,
      })
      const res = await withdraw(id, { expectedRevision: imported.revision, cwd: candidate.header.cwd })
      const name = quarantineNameFor(id)
      const dest = join(quarantineRoot, name)
      assert.equal(res.quarantinedTo, dest)
      assert.ok(existsSync(dest), `payload for ${id} quarantined under its digest name`)
      assert.ok(!res.quarantinedTo.includes('/'), 'quarantine target is a single segment')
      // ownership record carries the raw id in a SEMANTIC field
      const owner = JSON.parse(readFileSync(join(quarantineRoot, `${name}.owner.json`), 'utf8'))
      assert.equal(owner.sourceId, id)
      assert.equal(await t.persistence.stat(id), undefined, `${id} withdrawn from the active namespace`)
      results.push({ id, name, dest })
    }
    // nothing may exist outside the quarantine root because of these ids
    const parentEntries = readdirSync(jobDir)
    assert.ok(!parentEntries.includes('escaped-quarantine'), 'a traversal id must never create an object next to the quarantine root')
    assert.ok(!parentEntries.includes('slash'), 'a slash id must never create nested directories outside')
    assert.equal(readdirSync(quarantineRoot).filter(n => !n.endsWith('.owner.json')).length, ids.length)
    void results
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P2 F1: an escaping locate result and the sessions root itself are refused before any move', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'f1-src-'))
  try {
    const { importSessionViaA } = await import('../lib/import/writer-a.js')
    const candidate = await canonicalCandidate('f1-src', t.base)
    const imported = await importSessionViaA(t.persistence, candidate)
    const escaping = createJsonlWithdrawalAdapter({
      persistence: t.persistence,
      sessionsRoot: t.sessionsRoot,
      locateDir: () => '../outside-the-root',
      quarantineRoot: join(jobDir, 'quarantine'),
    })
    await assert.rejects(
      () => escaping('f1-src', { expectedRevision: imported.revision, cwd: candidate.header.cwd }),
      err => err.code === 'WITHDRAW_UNSAFE_PATH',
    )
    const rootItself = createJsonlWithdrawalAdapter({
      persistence: t.persistence,
      sessionsRoot: t.sessionsRoot,
      locateDir: () => '.',
      quarantineRoot: join(jobDir, 'quarantine'),
    })
    await assert.rejects(
      () => rootItself('f1-src', { expectedRevision: imported.revision, cwd: candidate.header.cwd }),
      err => err.code === 'WITHDRAW_UNSAFE_PATH',
    )
    assert.ok(await t.persistence.stat('f1-src'), 'refusals never move the session')
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})
