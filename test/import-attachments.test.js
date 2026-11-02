// P2 M2: attachment dependency graph + verbatim publication on the REAL local
// attachment store (isolated dshHome).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { collectAttachmentDependencies, planAttachmentPublication, publishAttachments, validateAttachmentRef } from '../lib/import/attachments.js'
import { isStageableAttachmentPath, AttachmentStaging } from '../lib/archive/attachment-staging.js'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir

// A valid synthetic PNG produced by the lab's own sharp (fixture generation,
// not part of the migration path).
async function makePng() {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const sharp = (await import(pathToFileURL(req.resolve('sharp')).href)).default
  return sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
}

async function mountStore() {
  const req = createRequire(join(rc4Dir, 'noop.js'))
  const attachmentLocal = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-attachment-local')).href)
  const { Context } = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
  const base = mkdtempSync(join(tmpdir(), 'm2-attach-'))
  const ctx = new Context()
  await ctx.plugin(attachmentLocal.default, { dshHome: base })
  const store = ctx.attachments
  if (!store) throw new Error('attachments service unavailable')
  return {
    base,
    store,
    root: join(base, 'attachments', 'v1'),
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
      rmSync(base, { recursive: true, force: true })
    },
  }
}

const sha = b => createHash('sha256').update(b).digest('hex')

test('P2 M2 graph: refs come from the formal content schema; invalid refs are isolated; identity distinguishes name/digest', () => {
  const imgRef = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 68, width: 1, height: 1 }
  const fileRef = { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'notes.txt', bytes: 5 }
  const sameBytesOtherName = { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'copy.txt', bytes: 5 }
  const badRef = { attachmentId: 'not-a-sha', name: 'x.txt', bytes: 1 }
  const sessions = [
    { id: 's1', events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }, { type: 'image', attachment: imgRef }, { type: 'file', attachment: fileRef }] } }] },
    { id: 's2', events: [{ type: 'user/message', data: { content: [{ type: 'image', attachment: imgRef }, { type: 'file', attachment: sameBytesOtherName }, { type: 'file', attachment: badRef }] } }] },
  ]
  const graph = collectAttachmentDependencies(sessions)
  assert.equal(graph.invalid.length, 1)
  assert.equal(graph.invalid[0].sessionId, 's2')
  assert.equal(graph.objects.length, 3, 'image dedupes by digest; two file names are distinct objects')
  const image = graph.objects.find(o => o.kind === 'image')
  assert.deepEqual(image.usedBy.sort(), ['s1', 's2'], 'shared image references one object')
  const files = graph.objects.filter(o => o.kind === 'file')
  assert.equal(files.length, 2)
  assert.ok(files.every(f => f.usedBy.length === 1))
  assert.throws(() => validateAttachmentRef('image', { ...imgRef, mediaType: 'image/svg+xml' }), err => err.code === 'ATTACHMENT_REF_INVALID')
  assert.throws(() => validateAttachmentRef('file', { ...fileRef, name: '../escape.txt' }), err => err.code === 'ATTACHMENT_REF_INVALID')
})

test('P2 M2 staging: only the versioned attachment namespaces are candidates', () => {
  assert.equal(isStageableAttachmentPath('v1/objects/aa/' + 'a'.repeat(64)), true)
  assert.equal(isStageableAttachmentPath('v1/files/aa/' + 'a'.repeat(64) + '/name.txt'), true)
  assert.equal(isStageableAttachmentPath('v1/file-objects/aa/' + 'a'.repeat(64)), true)
  assert.equal(isStageableAttachmentPath('v1/../etc/passwd'), false)
  assert.equal(isStageableAttachmentPath('v2/objects/x'), false)
  assert.equal(isStageableAttachmentPath('objects/aa/x'), false)
  const dir = mkdtempSync(join(tmpdir(), 'm2-stage-'))
  try {
    const staging = new AttachmentStaging(join(dir, 'stg'))
    staging.prepare()
    // a non-attachment-root record and a non-allowlisted path never stage
    assert.equal(staging.makeSinkFactory()({ root: 'sessions', kind: 'FILE', path: 'v1/objects/aa/x', size: 1 }), null)
    assert.equal(staging.makeSinkFactory()({ root: 'attachments', kind: 'FILE', path: 'v1/secret.txt', size: 1 }), null)
    assert.equal(staging.makeSinkFactory()({ root: 'attachments', kind: 'DIRECTORY', path: 'v1/objects' }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P2 M2 publish: normalized images are copied byte-for-byte (no re-encode); files via the verbatim interface; existing objects are reused', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountStore()
  try {
    // Fixture generation (allowed to normalize): the official store produces
    // the canonical image object.
    const imageRef = await t.store.saveImage({ data: await makePng(), mediaType: 'image/png', name: 'pixel.png' })
    const canonical = await t.store.readImage(imageRef)
    const imageBytes = Buffer.from(canonical.data)
    assert.equal(sha(imageBytes), imageRef.attachmentId.slice('sha256:'.length))

    const fileBytes = Buffer.from('hello attachment bytes\n')
    const step = { id: 's1' }
    const sessions = [{
      id: 's1',
      events: [{
        type: 'user/message',
        data: {
          content: [
            { type: 'image', attachment: imageRef },
            { type: 'file', attachment: { attachmentId: `sha256:${sha(fileBytes)}`, name: 'hello.txt', bytes: fileBytes.length } },
          ],
        },
      }],
    }]
    void step
    const graph = collectAttachmentDependencies(sessions)
    assert.equal(graph.objects.length, 2)
    // source bytes come from the backup objects (here: the canonical image)
    const planned = await planAttachmentPublication({
      objects: graph.objects,
      exists: async object => object.kind === 'image'
        ? existsSync(join(t.root, 'objects', object.digest.slice(0, 2), object.digest))
        : false,
      readSource: async object => object.kind === 'image' ? imageBytes : fileBytes,
    })
    assert.equal(planned.find(o => o.kind === 'image').reused, true, 'the canonical image already exists → reuse, no ownership')
    assert.equal(planned.find(o => o.kind === 'file').needsPublish, true)
    const result = await publishAttachments({ store: t.store, attachmentRoot: t.root, planned })
    assert.equal(result.reused.length, 1)
    assert.equal(result.published.length, 1)
    const filePublished = result.published.find(x => x.kind === 'file')
    assert.ok(filePublished, 'the file is the newly created object')
    assert.equal(filePublished.owned, true, 'file creation is reported owned when the store created it')
    assert.equal(filePublished.attachmentId, `sha256:${sha(fileBytes)}`)
    // the reused image is honestly reported NOT owned (existed before this batch)
    const imageReused = result.reused.find(x => x.kind === 'image')
    assert.equal(imageReused.owned, false)
    // official readback: exact file bytes
    const chunks = []
    for await (const chunk of t.store.readFileStream({ attachmentId: filePublished.attachmentId, name: 'hello.txt', bytes: fileBytes.length })) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), fileBytes)
    // image bytes stay byte-identical (no second normalization)
    const after = await t.store.readImage(imageRef)
    assert.deepEqual(Buffer.from(after.data), imageBytes)

    // second run: everything exists → reused, nothing published
    const planned2 = await planAttachmentPublication({
      objects: graph.objects,
      exists: async object => object.kind === 'image'
        ? existsSync(join(t.root, 'objects', object.digest.slice(0, 2), object.digest))
        : existsSync(join(t.root, 'files', object.digest.slice(0, 2), object.digest, object.ref.name)),
      readSource: async object => object.kind === 'image' ? imageBytes : fileBytes,
    })
    const again = await publishAttachments({ store: t.store, attachmentRoot: t.root, planned: planned2 })
    assert.equal(again.published.length, 0)
    assert.equal(again.reused.length, 2)
    assert.ok(again.reused.every(x => x.owned === false))
  } finally {
    await t.unmount()
  }
})

test('P2 M2 publish: source digest/length mismatches and an fsync failure refuse; cancellation leaves the intent unconfirmed', { skip: skip ? 'RC4_MODULES not set' : false }, async () => {
  const t = await mountStore()
  try {
    // A SECOND, distinct image that the target does not have yet (a raw
    // canonical fixture produced with sharp, not published through saveImage).
    const req = createRequire(join(rc4Dir, 'noop.js'))
    const sharp = (await import(pathToFileURL(req.resolve('sharp')).href)).default
    const blue = await sharp({ create: { width: 3, height: 3, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer()
    const imageRef = { attachmentId: `sha256:${sha(blue)}`, mediaType: 'image/png', bytes: blue.length, width: 3, height: 3 }
    const graph = { objects: [{ key: `image:${sha(blue)}`, kind: 'image', digest: sha(blue), ref: imageRef, usedBy: ['s1'] }] }
    const canonical = blue
    // wrong bytes → refused at planning
    await assert.rejects(
      () => planAttachmentPublication({ objects: graph.objects, exists: async () => false, readSource: async () => Buffer.from('not the image') }),
      err => err.code === 'ATTACHMENT_SOURCE_MISMATCH',
    )
    // fsync failure during object publication → ATTACHMENT_IO, no publication
    const planned = await planAttachmentPublication({ objects: graph.objects, exists: async () => false, readSource: async () => canonical })
    const fsmod = (await import('node:fs')).default
    const real = fsmod.fsyncSync
    fsmod.fsyncSync = () => { const e = new Error('injected ENOSPC'); e.code = 'ENOSPC'; throw e }
    try {
      await assert.rejects(
        () => publishAttachments({ store: t.store, attachmentRoot: t.root, planned }),
        err => err.code === 'ATTACHMENT_IO',
      )
    } finally {
      fsmod.fsyncSync = real
    }
    // cancellation before publication: abort → no readback, no object
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => publishAttachments({ store: t.store, attachmentRoot: t.root, planned, signal: controller.signal }),
      err => err?.name === 'AbortError' || /aborted/i.test(String(err?.message)),
    )
  } finally {
    await t.unmount()
  }
})
