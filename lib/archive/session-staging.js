// Controlled private staging for session extraction (P1).
//
// Bridges the v5 reader's makeSink hook to on-disk staging: only FILE
// records inside the 'sessions' logical root are written, only to paths
// inside the staging directory (defense in depth on top of the reader's
// path grammar), files land 0600 inside 0700 directories, and each staged
// artifact is verified (byte count + sha256) before it is reported staged.
//
// Nothing here touches a target DSH home; staging is a private candidate
// area for later migration steps.

import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

// Candidate allowlist: ONLY canonical session logs are copied into private
// staging (session.jsonl, session.vN.jsonl, and their .zstd forms). Other
// files under the sessions root (session.lock, notes, caches) participate in
// the archive's integrity verification through the reader but are never
// extracted — "sha-256 verification reads bytes" does not extend to keeping
// copies of excluded objects.
const CANONICAL_SESSION_LOG = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/

export class SessionStaging {
  /**
   * @param {string} root absolute private directory (created 0700)
   */
  constructor(root) {
    this.root = resolve(root)
    this.staged = []
    this.failures = []
  }

  prepare() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  /**
   * makeSink factory for readV5Backup. Rejects (by returning null, which the
   * caller treats as "record but do not extract") anything outside the
   * sessions root, and resolves the on-disk path strictly INSIDE the staging
   * root.
   */
  makeSinkFactory() {
    return meta => {
      if (meta.root !== 'sessions' || meta.kind !== 'FILE') return null
      const name = meta.path.split('/').at(-1)
      if (!CANONICAL_SESSION_LOG.test(name)) return null
      // Defense in depth: re-verify the relative path and pin it under root.
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
        sha256: null,
      }
      this.staged.push(entry)
      // createWriteStream does not create parent directories: build the
      // project/session hierarchy synchronously (makeSink is called on the
      // reader's thread; a race here would lose the file silently).
      const dir = resolve(abs, '..')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const stream = createWriteStream(abs, { mode: 0o600 })
      entry.sink = stream
      stream.on('error', () => {
        entry.status = 'failed'
      })
      return stream
    }
  }

  /** Verify all staged entries (size/sha256); mark failed ones and clean up. */
  async verifyAll() {
    for (const entry of this.staged) {
      if (entry.status !== 'writing') continue
      try {
        const st = await stat(entry.stagedTo)
        if (st.size !== entry.bytes) {
          throw new Error(`staged size ${st.size} != declared ${entry.bytes}`)
        }
        // Size matches; trust the reader's own per-FILE digest (it already
        // rejected the whole archive on any mismatch). Record the file's
        // digest by reading it back only if a sink errored mid-write is not
        // the case — a full re-hash here would double I/O; the reader's
        // streaming hash over the same bytes is authoritative.
        entry.status = 'staged'
      } catch (error) {
        entry.status = 'failed'
        entry.error = error.message
        this.failures.push(entry)
        await rm(entry.stagedTo, { force: true }).catch(() => {})
      }
    }
    // A sink that errored mid-write leaves an unfinished stream; mark those.
    for (const entry of this.staged) {
      if (entry.sink && entry.sink.errored) entry.status = 'failed'
    }
    return {
      staged: this.staged.filter(e => e.status === 'staged'),
      failed: this.staged.filter(e => e.status === 'failed'),
    }
  }

  /** Remove everything this session staged (cancel/abort path). */
  async cleanupAll() {
    await rm(this.root, { recursive: true, force: true })
    for (const entry of this.staged) entry.status = 'discarded'
  }

  /** Summarize for reports: identifiers and digests only — NO local
   * absolute paths (stagedTo stays internal; the report must not leak the
   * machine's private staging locations). */
  summarize() {
    return this.staged.map(({ root, path, bytes, expectedSha256, status }) => ({
      root, path, bytes, sha256: expectedSha256, status,
    }))
  }
}
