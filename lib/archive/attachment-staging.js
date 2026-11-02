// Controlled staging for attachment objects extracted from a v5 backup
// (P2 M2.1). Only the attachment root is staged, and only the versioned
// object namespaces: v1/objects (normalized images), v1/files (verbatim file
// aliases) and v1/file-objects (canonical file objects). Everything else —
// credentials, config, unrelated roots — participates in archive integrity
// verification but is never extracted.
//
// Files land 0600 inside 0700 directories with the same verified-size rule as
// session staging.

import { createWriteStream, mkdirSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export const ATTACHMENT_ROOT_NAME = 'attachments'
const STAGED_PREFIXES = ['v1/objects/', 'v1/files/', 'v1/file-objects/']

export function isStageableAttachmentPath(path) {
  return STAGED_PREFIXES.some(prefix => path.startsWith(prefix))
}

export class AttachmentStaging {
  constructor(root) {
    this.root = resolve(root)
    this.staged = []
    this.failures = []
  }

  prepare() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  makeSinkFactory() {
    return meta => {
      if (meta.root !== ATTACHMENT_ROOT_NAME || meta.kind !== 'FILE') return null
      if (!isStageableAttachmentPath(meta.path)) return null
      const rel = meta.path.split('/').filter(p => p && p !== '.' && p !== '..')
      if (rel.length === 0) return null
      const abs = resolve(this.root, ...rel)
      if (!abs.startsWith(this.root + sep)) return null
      const entry = {
        root: meta.root,
        path: meta.path,
        bytes: meta.size,
        expectedSha256: meta.sha256,
        stagedTo: abs,
        status: 'writing',
        writtenBytes: 0,
      }
      this.staged.push(entry)
      mkdirSync(resolve(abs, '..'), { recursive: true, mode: 0o700 })
      const stream = createWriteStream(abs, { mode: 0o600 })
      entry.sink = stream
      stream.on('error', () => { entry.status = 'failed' })
      return stream
    }
  }

  async verifyAll() {
    for (const entry of this.staged) {
      if (entry.status !== 'writing') continue
      try {
        const st = await stat(entry.stagedTo)
        if (st.size !== entry.bytes) throw new Error(`staged size ${st.size} != declared ${entry.bytes}`)
        entry.status = 'staged'
      } catch (error) {
        entry.status = 'failed'
        entry.error = error.message
        this.failures.push(entry)
        await rm(entry.stagedTo, { force: true }).catch(() => {})
      }
    }
    for (const entry of this.staged) {
      if (entry.sink && entry.sink.errored) entry.status = 'failed'
    }
    return {
      staged: this.staged.filter(e => e.status === 'staged'),
      failed: this.staged.filter(e => e.status === 'failed'),
    }
  }

  async cleanupAll() {
    await rm(this.root, { recursive: true, force: true })
    for (const entry of this.staged) entry.status = 'discarded'
  }

  summarize() {
    return this.staged.map(({ root, path, bytes, expectedSha256, status }) => ({ root, path, bytes, sha256: expectedSha256, status }))
  }
}
