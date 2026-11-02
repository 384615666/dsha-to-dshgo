// Attachment dependency graph + verbatim publication (P2 M2).
//
// Refs are taken ONLY from the formal event/content schema — content parts
// shaped { type: 'image' | 'file', attachment: { attachmentId, ... } } — never
// by regex-scanning text. Every ref is validated (id shape, media metadata,
// leaf-name contract) before it can enter a dependency group.
//
// Publishing is "attachments before sessions":
//   - IMAGES: historical images are already normalized objects. They are
//     published BYTE-FOR-BYTE through the backend's measured layout
//     (objects/<aa>/<sha256>), never re-encoded through saveImage; an existing
//     object with the same digest is REUSED (not owned by this batch).
//   - FILES: published through the store's official verbatim interface
//     (saveFileStream), whose leaf name is part of the object identity.
// Each new object is an intent before publication and an outcome (actual
// identity/digest) after; readback through the store's official readers
// verifies the bytes.
//
// The module performs no deletion: reuse vs ownership is reported so the
// rollback layer can decide (existing/shared objects are never withdrawn).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f<>:"|?*]/

export function attachmentDigest(ref) {
  const m = ATTACHMENT_ID.exec(String(ref?.attachmentId ?? ''))
  return m ? m[1] : null
}

function validLeafName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && !name.includes('/') && !name.includes('\\') && !NAME_FORBIDDEN.test(name)
    && name !== '.' && name !== '..'
}

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0
}

/** Validate one durable reference against its content part kind. */
export function validateAttachmentRef(kind, ref) {
  const digest = attachmentDigest(ref)
  if (!digest) throw coded('ATTACHMENT_REF_INVALID', 'attachmentId must be sha256:<64 hex>')
  if (kind === 'file') {
    if (!validLeafName(ref.name)) throw coded('ATTACHMENT_REF_INVALID', 'file reference name is not a single safe leaf name')
    // The official file contract has NO admission limits: a 0-byte file is a
    // valid verbatim object (images require positive dimensions).
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw coded('ATTACHMENT_REF_INVALID', 'file reference bytes must be a non-negative integer')
    return { kind, digest, name: ref.name, bytes: ref.bytes }
  }
  if (kind === 'image') {
    if (!IMAGE_MEDIA.has(ref.mediaType)) throw coded('ATTACHMENT_REF_INVALID', `unsupported image media type ${JSON.stringify(ref.mediaType)}`)
    if (!isPositiveInt(ref.bytes) || !isPositiveInt(ref.width) || !isPositiveInt(ref.height)) {
      throw coded('ATTACHMENT_REF_INVALID', 'image reference needs positive bytes/width/height')
    }
    if (ref.name !== undefined && !validLeafName(ref.name)) throw coded('ATTACHMENT_REF_INVALID', 'image reference name is not a single safe leaf name')
    return { kind, digest, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name }
  }
  throw coded('ATTACHMENT_REF_INVALID', `unsupported attachment kind ${JSON.stringify(kind)}`)
}

// Structural walk for the formal content schema. Bounded so a malformed log
// cannot explode memory; only objects with the exact part shape qualify.
function walkParts(value, depth, out) {
  if (depth > 12 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkParts(item, depth + 1, out)
    return
  }
  if (value.type === 'image' && value.attachment && typeof value.attachment === 'object') {
    out.push({ kind: 'image', ref: value.attachment })
  } else if (value.type === 'file' && value.attachment && typeof value.attachment === 'object') {
    out.push({ kind: 'file', ref: value.attachment })
  }
  for (const key of Object.keys(value)) {
    if (key === 'attachment') continue
    walkParts(value[key], depth + 1, out)
  }
}

/**
 * Build the attachment dependency graph for a set of sessions.
 * @param {object[]} sessions - [{ id, events }]
 * @returns {{ bySession: Map<string, object[]>, objects: object[], invalid: object[] }}
 *   objects: unique by (kind, digest, name-for-files): { key, kind, digest,
 *   ref, usedBy: string[] }
 */
export function collectAttachmentDependencies(sessions) {
  const bySession = new Map()
  const objects = new Map()
  const invalid = []
  for (const session of sessions) {
    const found = []
    for (const event of session.events ?? []) {
      const parts = []
      walkParts(event?.data, 0, parts)
      for (const part of parts) {
        let validated
        try {
          validated = validateAttachmentRef(part.kind, part.ref)
        } catch (error) {
          invalid.push({ sessionId: session.id, kind: part.kind, attachmentId: part.ref?.attachmentId ?? null, code: error.code, message: error.message })
          continue
        }
        const key = validated.kind === 'file'
          ? `file:${validated.digest}:${validated.name}`
          : `image:${validated.digest}`
        const existing = objects.get(key)
        if (existing) {
          if (!existing.usedBy.includes(session.id)) existing.usedBy.push(session.id)
        } else {
          objects.set(key, { key, kind: validated.kind, digest: validated.digest, ref: part.ref, usedBy: [session.id] })
        }
        if (!found.some(f => f.key === key)) found.push({ key, kind: validated.kind, digest: validated.digest, ref: part.ref })
      }
    }
    bySession.set(session.id, found)
  }
  return { bySession, objects: [...objects.values()], invalid }
}

/**
 * Build the attachment publication plan: which source object each dependency
 * needs and whether the target already has it (reuse) — decided by the
 * caller-provided existence check (backend-aware).
 * @param {object} params
 * @param {object[]} params.objects - collectAttachmentDependencies().objects
 * @param {(object: object) => Promise<boolean>} params.exists - target probe
 * @param {(object: object) => Promise<Uint8Array>} params.readSource - source bytes
 */
export async function planAttachmentPublication({ objects, exists, readSource }) {
  const planned = []
  for (const object of objects) {
    const bytes = await readSource(object)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== object.digest) {
      throw coded('ATTACHMENT_SOURCE_MISMATCH', `source bytes for ${object.key} do not match the referenced digest`, { key: object.key })
    }
    if (object.ref.bytes !== bytes.length) {
      // BOTH kinds: the declared length is part of the durable reference.
      throw coded('ATTACHMENT_SOURCE_MISMATCH', `source length for ${object.key} (${bytes.length}) does not match the reference (${object.ref.bytes})`, { key: object.key })
    }
    const alreadyPresent = await exists(object)
    planned.push({ ...object, bytes, needsPublish: !alreadyPresent, reused: alreadyPresent })
  }
  return planned
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// Durable immutable-object publication for NORMALIZED images, using the
// measured local layout: <root>/objects/<aa>/<sha256>. Temp → fsync → rename
// (content-addressed, so an existing object is the same bytes); directory
// fsync where supported. Never calls saveImage (no re-encoding).
async function publishImageObject(root, bytes, digest) {
  const dest = join(root, 'objects', digest.slice(0, 2), digest)
  if (existsSync(dest)) {
    const existing = readFileSync(dest)
    if (hashBytes(existing) !== digest) {
      throw coded('ATTACHMENT_IO', `existing image object ${digest} does not match its content address`)
    }
    return { path: dest, reused: true }
  }
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  const tmp = `${dest}.tmp`
  let fd
  try {
    fd = openSync(tmp, 'w', 0o600)
    writeSync(fd, bytes)
    try { fs.fsyncSync(fd) } catch (error) {
      if (error?.code === 'ENOSYS') throw coded('ATTACHMENT_UNSUPPORTED', 'the platform cannot fsync attachment objects')
      throw coded('ATTACHMENT_IO', `image object fsync failed: ${error?.code ?? error?.message}`)
    }
    closeSync(fd)
    fd = undefined
    renameSync(tmp, dest)
  } catch (error) {
    try { if (fd !== undefined) closeSync(fd) } catch { /* closed */ }
    try { unlinkSync(tmp) } catch { /* nothing */ }
    if (typeof error?.code === 'string' && error.code.startsWith('ATTACHMENT_')) throw error
    throw coded('ATTACHMENT_IO', `image object publication failed: ${error?.code ?? error?.message}`)
  }
  try {
    const dfd = openSync(dirname(dest), 'r')
    try { fs.fsyncSync(dfd) } catch (error) {
      const tolerated = process.platform === 'win32'
        ? ['EPERM', 'EISDIR', 'EINVAL', 'EBUSY'].includes(error?.code)
        : error?.code === 'ENOSYS'
      if (!tolerated) throw coded('ATTACHMENT_IO', `image object directory fsync failed: ${error?.code ?? error?.message}`)
    } finally {
      closeSync(dfd)
    }
  } catch (error) {
    if (error?.code === 'ATTACHMENT_IO') throw error
    // opening the directory is unsupported on some platforms — recorded as a
    // durability limitation, same rule as the journal.
  }
  return { path: dest, reused: false }
}

async function storeFile(store, object) {
  if (typeof store.saveFileStream === 'function') {
    async function* chunks() { yield object.bytes }
    const ref = await store.saveFileStream({ data: chunks(), name: object.ref.name })
    return ref
  }
  if (typeof store.saveFile === 'function') {
    return store.saveFile({ data: object.bytes, name: object.ref.name })
  }
  throw coded('ATTACHMENT_UNSUPPORTED', 'the target attachment store has no verbatim file publication')
}

/**
 * Publish planned objects, attachments-before-sessions. Each publication is
 * intent → effect → outcome; existing objects are reused and NOT owned.
 * @param {object} params
 * @param {object} params.store - target AttachmentStore (readers used too)
 * @param {string} params.attachmentRoot - the store's real v1 root (from its
 *   configuration/host adapter — never guessed from a canonical path).
 * @param {object[]} params.planned - planAttachmentPublication result.
 * @param {object} [params.journal] - optional journal for intent/outcome.
 * @returns {Promise<{ published: object[], reused: object[], invalid: object[] }>}
 */
export async function publishAttachments({ store, attachmentRoot, planned, journal, signal }) {
  if (!store) throw coded('ATTACHMENT_UNSUPPORTED', 'the target attachment store is unavailable')
  const root = resolve(attachmentRoot)
  const published = []
  const reused = []
  for (const object of planned) {
    signal?.throwIfAborted()
    if (object.reused) {
      // R3: reuse still requires an official readback — an existing object
      // with corrupt bytes must refuse, never be claimed as verified.
      if (object.kind === 'image') {
        if (typeof store.readImage !== 'function') throw coded('ATTACHMENT_UNSUPPORTED', 'the target store cannot read images back')
        const stored = await store.readImage(object.ref)
        const storedBytes = Buffer.from(stored.data)
        if (hashBytes(storedBytes) !== object.digest || storedBytes.length !== object.ref.bytes) {
          throw coded('ATTACHMENT_READBACK_MISMATCH', `reused image ${object.key} does not match its reference`)
        }
      } else {
        if (typeof store.readFileStream !== 'function') throw coded('ATTACHMENT_UNSUPPORTED', 'the target store cannot read files back')
        const hash = createHash('sha256')
        let total = 0
        for await (const chunk of store.readFileStream(object.ref)) { hash.update(chunk); total += chunk.length }
        if (hash.digest('hex') !== object.digest || total !== object.ref.bytes) {
          throw coded('ATTACHMENT_READBACK_MISMATCH', `reused file ${object.key} does not match its reference`)
        }
      }
      reused.push({ key: object.key, kind: object.kind, attachmentId: object.ref.attachmentId, owned: false })
      continue
    }
    const seq = journal ? journal.intent({ type: 'attachment.publish', key: object.key, kind: object.kind, digest: object.digest }) : null
    let ref
    let hostPath = null
    let wasReusedByHelper = false
    // R3: detect an object that appeared between planning and publication.
    // For images the layout helper reports reuse; for files the host path
    // probe (backend-provided) plays the same role when available.
    let independentlyPresent = false
    if (object.kind === 'file' && typeof store.fileHostPath === 'function') {
      try {
        const p = store.fileHostPath(object.ref)
        if (p && existsSync(resolve(p))) independentlyPresent = true
      } catch { /* cannot probe — ownership stays unknown */ }
    }
    if (object.kind === 'file' && independentlyPresent) {
      reused.push({ key: object.key, kind: object.kind, attachmentId: object.ref.attachmentId, owned: false, reused: true })
      continue
    }
    if (object.kind === 'image') {
      const published = await publishImageObject(root, object.bytes, object.digest)
      // The helper detects an object created between planning and publication:
      // honor its reused verdict for OWNERSHIP.
      wasReusedByHelper = published.reused === true
      hostPath = typeof store.imageHostPath === 'function' ? store.imageHostPath(object.ref) ?? null : null
      // Readback through the store's official reader: bytes must match.
      if (typeof store.readImage !== 'function') throw coded('ATTACHMENT_UNSUPPORTED', 'the target store cannot read images back')
      const stored = await store.readImage(object.ref)
      const storedBytes = Buffer.from(stored.data)
      if (hashBytes(storedBytes) !== object.digest || storedBytes.length !== object.ref.bytes) {
        throw coded('ATTACHMENT_READBACK_MISMATCH', `image readback for ${object.key} does not match the reference`)
      }
      ref = object.ref
    } else {
      ref = await storeFile(store, object)
      if (ref.attachmentId !== object.ref.attachmentId || ref.name !== object.ref.name || ref.bytes !== object.ref.bytes) {
        throw coded('ATTACHMENT_REF_MISMATCH', `file publication for ${object.key} returned a different identity`)
      }
      if (typeof store.readFileStream !== 'function') throw coded('ATTACHMENT_UNSUPPORTED', 'the target store cannot read files back')
      const hash = createHash('sha256')
      let total = 0
      for await (const chunk of store.readFileStream(ref)) { hash.update(chunk); total += chunk.length }
      if (hash.digest('hex') !== object.digest || total !== object.ref.bytes) {
        throw coded('ATTACHMENT_READBACK_MISMATCH', `file readback for ${object.key} does not match the reference`)
      }
      if (typeof store.fileHostPath === 'function') {
        const p = store.fileHostPath(ref)
        if (p) hostPath = resolve(p)
      }
    }
    if (hostPath && !hostPath.startsWith(root + sep)) {
      throw coded('ATTACHMENT_PATH_UNSAFE', 'the backend reported an object path outside its configured root')
    }
    signal?.throwIfAborted()
    if (journal && seq != null) {
      journal.confirm(seq, {
        attachmentId: ref.attachmentId,
        bytes: object.ref.bytes,
        hostPath: hostPath ?? null,
        // R3: persist the OWNERSHIP verdict with its evidence, so a crash
        // after publication can still distinguish created vs reused.
        ownership: object.kind === 'image' ? (wasReusedByHelper ? 'reused' : 'created') : (independentlyPresent ? 'reused' : 'unknown'),
      })
    }
    // R3: absent at PLANNING does not prove ownership — the image helper may
    // have found the object already present. Files cannot prove creation
    // either, so ownership is reported honestly (created vs reused/unknown).
    // Ownership evidence: an image object found existing during publication
    // is NOT ours (helper reused); a file that the store just committed with
    // our exact identity and a verified readback IS our creation.
    // Files: the store just committed our exact identity (ref matches, readback
    // verified) and the pre-publication probe found the object absent — that
    // IS creation evidence. A probe that cannot run leaves ownership unknown
    // but the object still lands in published (non-owned) so compensation
    // stays conservative.
    const ownership = object.kind === 'image' ? (wasReusedByHelper ? 'reused' : 'created') : (independentlyPresent ? 'reused' : 'created-unverified')
    if (ownership === 'created') {
      published.push({ key: object.key, kind: object.kind, attachmentId: ref.attachmentId, owned: true, hostPath })
    } else if (ownership === 'created-unverified') {
      published.push({ key: object.key, kind: object.kind, attachmentId: ref.attachmentId, owned: false, ownership: 'unknown', hostPath })
    } else {
      reused.push({ key: object.key, kind: object.kind, attachmentId: ref.attachmentId, owned: false })
    }
  }
  return { published, reused, invalid: [] }
}
