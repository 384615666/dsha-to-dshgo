// Private source loader for the product migration flow.
//
// The public inspect report is a sanitized SUMMARY. The actual import needs
// the private canonical artifacts (header + full event log + inherited cut)
// and the staged attachment objects. This module runs the SAME verification
// kernel (inspectSessionsInternal) and returns those private artifacts plus a
// controlled attachment reader. Nothing here writes a user report; callers
// must keep the artifacts private and delete the staging on terminal states.
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { inspectSessionsInternal } from '../inspect-sessions.js'
import { AttachmentStaging } from '../archive/attachment-staging.js'
import { collectAttachmentDependencies } from './attachments.js'

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

async function digestFile(path) {
  const bytes = await readFile(path)
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * Load one backup into private import candidates.
 * @param {string} backupFile - absolute path to the v5 backup (read-only).
 * @param {object} params
 * @param {string} params.stagingRoot - private job source root (0700).
 * @param {(path: string) => Promise<Uint8Array>} [params.readFileImpl]
 * @returns {Promise<{
 *   report: object,
 *   candidates: object[],
 *   missingAttachments: object[],
 *   sourceDigest: string,
 *   sourceBytes: number,
 *   readAttachmentSource: (object) => Promise<Uint8Array>,
 *   cleanup: () => Promise<void>,
 * }>}
 */
export async function loadBackupSource(backupFile, { stagingRoot, readFileImpl = readFile } = {}) {
  if (typeof stagingRoot !== 'string' || stagingRoot === '') {
    throw coded('SOURCE_INVALID', 'a private staging root is required')
  }
  const sourceRoot = resolve(stagingRoot)
  const sessionStagingRoot = join(sourceRoot, 'sessions')
  const attachmentRoot = join(sourceRoot, 'attachments')
  const attachmentStaging = new AttachmentStaging(attachmentRoot)
  const sourceFacts = await digestFile(backupFile)

  const { report, artifacts, staging } = await inspectSessionsInternal(backupFile, {
    stagingRoot: sessionStagingRoot,
    attachmentStaging,
  })

  const cleanup = async () => {
    await staging.cleanupAll().catch(() => {})
    await attachmentStaging.cleanupAll().catch(() => {})
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {})
  }

  if (report.archiveFailed) {
    return {
      report,
      candidates: [],
      missingAttachments: [],
      sourceDigest: sourceFacts.sha256,
      sourceBytes: sourceFacts.bytes,
      readAttachmentSource: async () => { throw coded('SOURCE_UNAVAILABLE', 'the backup failed verification') },
      cleanup,
    }
  }

  const candidates = artifacts.map(a => ({
    id: a.id,
    header: a.header,
    events: a.events,
    inheritedEventCount: a.inheritedEventCount,
    sourceGeneration: a.sourceGeneration,
    sourceDirectory: a.directory,
  }))

  const stagedAttachments = new Set(attachmentStaging.staged
    .filter(e => e.status === 'staged')
    .map(e => e.path))

  const readAttachmentSource = async object => {
    if (!object || typeof object.digest !== 'string') throw coded('SOURCE_INVALID', 'attachment object is invalid')
    const digest = object.digest
    const candidatesPaths = object.kind === 'image'
      ? [join('v1', 'objects', digest.slice(0, 2), digest)]
      : [
          join('v1', 'files', digest.slice(0, 2), digest, object.ref?.name ?? ''),
          join('v1', 'file-objects', digest.slice(0, 2), digest),
        ]
    for (const rel of candidatesPaths) {
      if (!rel) continue
      const abs = resolve(attachmentRoot, rel)
      if (abs !== attachmentRoot && !abs.startsWith(attachmentRoot + sep)) {
        throw coded('SOURCE_PATH_UNSAFE', 'an attachment path escaped the staging root')
      }
      if (!stagedAttachments.has(rel.split('\\').join('/'))) continue
      try {
        return await readFileImpl(abs)
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
    }
    throw coded('SOURCE_ATTACHMENT_MISSING', `staged attachment ${object.key ?? digest} is not present in the backup`)
  }

  const graph = collectAttachmentDependencies(candidates)
  const missingAttachments = []
  for (const object of graph.objects) {
    try {
      await readAttachmentSource(object)
    } catch (error) {
      missingAttachments.push({ key: object.key, kind: object.kind, usedBy: object.usedBy, code: error.code ?? null })
    }
  }

  return {
    report,
    candidates,
    missingAttachments,
    sourceDigest: sourceFacts.sha256,
    sourceBytes: sourceFacts.bytes,
    readAttachmentSource,
    cleanup,
  }
}
