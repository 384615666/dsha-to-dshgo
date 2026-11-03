// P3.2 attachment recovery: rollback compensation of published attachment
// objects on the REAL local attachment store + REAL jsonl persistence (isolated
// temp roots).
//
// Contract under test: an object is moved out of the active store into the
// job's quarantine ONLY when this batch recorded it as created, its bytes still
// match the recorded digest, and no remaining session references it. Reused
// (shared) objects are never touched; unproven cases preserve the object and
// keep the batch PENDING with persisted evidence. The final rollback
// verification proves shared objects are still present/unchanged and moved
// objects are gone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  ATTACHMENT_QUARANTINE_SUBDIR,
  attachmentQuarantineName,
  rollbackBatch,
  verifyTargetRestored,
} from '../lib/import/g6.js'
import { ImportJournal } from '../lib/import/journal.js'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir
const sha = value => createHash('sha256').update(value).digest('hex')

async function mountTarget() {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const jsonl = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
  const storagePkg = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage')).href)
  const storageJson = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-json')).href)
  const storageDomain = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-storage-domain')).href)
  const workspacePkg = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-workspace')).href)
  const attachmentLocal = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-attachment-local')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const base = mkdtempSync(join(tmpdir(), 'p32-attrec-'))
  const dshHome = join(base, 'dsh')
  mkdirSync(dshHome, { recursive: true })
  const sessionsRoot = join(base, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(storagePkg.Storage, {})
  mkdirSync(join(base, 'storage'), { recursive: true })
  await ctx.plugin(storageJson, { root: join(base, 'storage') })
  await ctx.plugin(storageDomain, { backend: 'json' })
  await ctx.plugin(jsonl, { root: sessionsRoot, compression: 'zstd' })
  await ctx.plugin(workspacePkg.WorkspaceRegistry)
  await ctx.plugin(attachmentLocal.default, { dshHome })
  if (!ctx.attachments) throw new Error('attachment store unavailable')
  return {
    base,
    sessionsRoot,
    persistence: ctx.sessionPersistence,
    workspaceRegistry: ctx.workspaceRegistry,
    store: ctx.attachments,
    root: join(dshHome, 'attachments', 'v1'),
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(base, { recursive: true, force: true })
    },
  }
}

function emptySnapshot() {
  return { workspaces: [], workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [], sessions: {}, ownership: { plannedCreates: [] } }
}

async function publishFile(store, bytes, name) {
  async function* chunks() { yield bytes }
  return store.saveFileStream({ data: chunks(), name })
}

function recordPublish(journal, { ref, hostPath, ownership, digest, publication = 'published' }) {
  const key = `file:${digest}:${ref.name}`
  const seq = journal.intent({ type: 'attachment.publish', key, kind: 'file', digest, name: ref.name })
  journal.confirm(seq, { attachmentId: ref.attachmentId, bytes: ref.bytes, ref, hostPath, ownership, publication })
  return key
}

test('P3.2 attachment recovery: created objects move to quarantine; reused/unknown/referenced objects are preserved with evidence', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'p32-attrec-job-'))
  try {
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: 'inst-att', sourceDigest: 'src-att' })

    const created = Buffer.from('created object bytes\n')
    const createdRef = await publishFile(t.store, created, 'created.txt')
    const createdHost = t.store.fileHostPath(createdRef)
    const createdKey = recordPublish(journal, { ref: createdRef, hostPath: createdHost, ownership: 'created', digest: sha(created) })

    const reused = Buffer.from('reused object bytes\n')
    const reusedRef = await publishFile(t.store, reused, 'reused.txt')
    const reusedHost = t.store.fileHostPath(reusedRef)
    recordPublish(journal, { ref: reusedRef, hostPath: reusedHost, ownership: 'reused', digest: sha(reused), publication: 'reused' })

    const unknown = Buffer.from('unknown ownership bytes\n')
    const unknownRef = await publishFile(t.store, unknown, 'unknown.txt')
    const unknownHost = t.store.fileHostPath(unknownRef)
    recordPublish(journal, { ref: unknownRef, hostPath: unknownHost, ownership: 'unknown', digest: sha(unknown) })

    const referenced = Buffer.from('referenced object bytes\n')
    const referencedRef = await publishFile(t.store, referenced, 'referenced.txt')
    const referencedHost = t.store.fileHostPath(referencedRef)
    // an INDEPENDENT target session still references this object
    const header = { version: 4, id: 'ref-owner', createdAt: 1793500000000, cwd: t.base, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
    const handle = await t.persistence.create(header)
    try {
      await handle.append([{
        type: 'user/message',
        seq: 0,
        time: 1,
        data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: referencedRef }] },
        surfaceOp: 'append',
      }])
      await handle.flush()
    } finally {
      await handle.close()
    }
    recordPublish(journal, { ref: referencedRef, hostPath: referencedHost, ownership: 'created-unverified', digest: sha(referenced) })

    const quarantineRoot = join(jobDir, 'quarantine')
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot: emptySnapshot(),
      plannedSessionIds: [],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      attachments: t.store,
      attachmentRoot: t.root,
      attachmentQuarantineDir: quarantineRoot,
      journal,
    })

    // The two unprovable objects keep the batch pending — never a blind delete.
    assert.equal(rb.outcome, 'pending', JSON.stringify(rb.conflicts))
    // created → moved out of the active store, recoverable, with an owner record
    assert.equal(existsSync(createdHost), false, 'the created object left the active store')
    const movedTo = join(quarantineRoot, ATTACHMENT_QUARANTINE_SUBDIR, attachmentQuarantineName('file', sha(created), 'created.txt'))
    assert.ok(existsSync(movedTo), 'the object is kept recoverable in quarantine')
    assert.deepEqual(readFileSync(movedTo), created, 'the quarantined bytes are byte-identical')
    const owner = JSON.parse(readFileSync(`${movedTo}.owner.json`, 'utf8'))
    assert.equal(owner.digest, sha(created))
    assert.equal(owner.ownership, 'created')
    assert.equal(owner.key, createdKey)
    assert.equal(owner.sourcePath, createdHost)
    // reused / unknown / referenced are PRESERVED
    assert.ok(existsSync(reusedHost), 'a shared object is never touched')
    assert.ok(existsSync(unknownHost), 'unproven ownership is preserved')
    assert.ok(existsSync(referencedHost), 'a still-referenced object is preserved')
    assert.ok(rb.conflicts.some(c => /still referenced by another session/.test(c.reason)), JSON.stringify(rb.conflicts))
    assert.ok(rb.conflicts.some(c => /result-unknown/.test(c.reason)), JSON.stringify(rb.conflicts))
    // final verification: moved is absent, kept objects present with match
    assert.equal(rb.verification.ok, true, JSON.stringify(rb.verification.diffs))
    assert.equal(rb.verification.attachments.checked, 4)
    assert.equal(rb.verification.attachments.skipped, 0)
    // the verdict (with the reasons) is persisted in the private journal
    const reloaded = ImportJournal.load(join(jobDir, 'journal.json'), { instanceFingerprint: 'inst-att', sourceDigest: 'src-att' })
    assert.equal(reloaded.state.rollback.outcome, 'pending')
    assert.ok(reloaded.state.conflicts.some(c => /still referenced/.test(c.reason)), JSON.stringify(reloaded.state.conflicts))
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P3.2 attachment recovery: an unavailable reference check preserves the object instead of deleting it', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  const jobDir = mkdtempSync(join(tmpdir(), 'p32-attrec-scan-'))
  try {
    const bytes = Buffer.from('unscanned bytes\n')
    const ref = await publishFile(t.store, bytes, 'unscanned.txt')
    const host = t.store.fileHostPath(ref)
    const journal = ImportJournal.init(join(jobDir, 'journal.json'), { instanceFingerprint: 'inst-scan', sourceDigest: 'src-scan' })
    recordPublish(journal, { ref, hostPath: host, ownership: 'created', digest: sha(bytes) })
    // no list/open capability on this persistence → the reference set is unproven
    const rb = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot: emptySnapshot(),
      plannedSessionIds: [],
      workspaceRegistry: t.workspaceRegistry,
      persistence: { stat: async () => null },
      attachments: t.store,
      attachmentRoot: t.root,
      attachmentQuarantineDir: join(jobDir, 'quarantine'),
      journal,
    })
    assert.equal(rb.outcome, 'pending')
    assert.ok(rb.conflicts.some(c => /reference check unavailable/.test(c.reason)), JSON.stringify(rb.conflicts))
    assert.ok(existsSync(host), 'an unproven reference set must never authorize a move')
    // an explicit scan that reports no reference DOES authorize the move
    const rb2 = await rollbackBatch({
      actions: journal.actionsReversed(),
      snapshot: emptySnapshot(),
      plannedSessionIds: [],
      workspaceRegistry: t.workspaceRegistry,
      persistence: t.persistence,
      attachments: t.store,
      attachmentRoot: t.root,
      attachmentQuarantineDir: join(jobDir, 'quarantine2'),
      attachmentReferenceScan: () => [],
      journal,
    })
    assert.equal(rb2.outcome, 'complete', JSON.stringify(rb2.conflicts))
    assert.equal(existsSync(host), false, 'the proven-unreferenced object moved')
    assert.ok(existsSync(join(jobDir, 'quarantine2', ATTACHMENT_QUARANTINE_SUBDIR, attachmentQuarantineName('file', sha(bytes), 'unscanned.txt'))))
  } finally {
    await t.unmount()
    rmSync(jobDir, { recursive: true, force: true })
  }
})

test('P3.2 attachment recovery: rollback verification proves shared objects stayed present and unchanged', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountTarget()
  try {
    const bytes = Buffer.from('shared object bytes\n')
    const ref = await publishFile(t.store, bytes, 'shared.txt')
    const host = t.store.fileHostPath(ref)
    const action = {
      seq: 1,
      stage: 'done',
      type: 'attachment.publish',
      key: `file:${sha(bytes)}:shared.txt`,
      kind: 'file',
      digest: sha(bytes),
      outcome: { attachmentId: ref.attachmentId, bytes: ref.bytes, ref, hostPath: host, ownership: 'reused', publication: 'reused' },
    }
    const checks = [{ key: action.key, action, expect: 'present', digest: sha(bytes) }]
    const base = { persistence: t.persistence, workspaceRegistry: null, snapshot: emptySnapshot(), plannedSessionIds: [], attachmentChecks: checks, attachments: t.store, attachmentRoot: t.root }
    const ok = await verifyTargetRestored(base)
    assert.equal(ok.ok, true, JSON.stringify(ok.diffs))
    assert.equal(ok.attachments.checked, 1)
    // A shared object that vanished is a FAILED restoration, not a silent pass.
    rmSync(host)
    const missing = await verifyTargetRestored(base)
    assert.equal(missing.ok, false)
    assert.ok(missing.diffs.some(d => /disappeared/.test(d)), JSON.stringify(missing.diffs))
    // A tampered object is refused by the official reader.
    writeFileSync(host, Buffer.from('tampered bytes\n'))
    const tampered = await verifyTargetRestored(base)
    assert.equal(tampered.ok, false)
    assert.ok(tampered.diffs.some(d => /could not be read back|content changed/.test(d)), JSON.stringify(tampered.diffs))
  } finally {
    await t.unmount()
  }
})
