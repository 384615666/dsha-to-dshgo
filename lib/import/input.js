// Product input path for large backups.
//
// The system file picker is limited to 8 MiB per file. A DSHA one-click backup
// may be much larger (attachments/projects), so the product flow lists files in
// the phone's Download/DSHA directory and streams the selected file into the
// private job directory while hashing. Nothing here reads the whole backup into
// memory; the v5 reader consumes the staged file as a stream.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const DEFAULT_SCAN_ROOT = '/sdcard/Download/DSHA'
// The v5 container itself allows 16 GiB; keep the product guard equal so a
// legitimate backup is never rejected merely because it is large. The phone's
// own free-space check still applies.
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024 * 1024

function coded(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

export function safeName(name) {
  return String(name || 'backup').replace(/[^\w.-]+/g, '_').slice(-80) || 'backup'
}

async function identityOf(path) {
  const st = await lstat(path)
  if (!st.isFile()) throw coded('INPUT_SOURCE_INVALID', 'backup source is not a regular file')
  return {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    mode: st.mode,
  }
}

function sameIdentity(a, b) {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.size === b.size
    && a.mtimeMs === b.mtimeMs
    && a.ctimeMs === b.ctimeMs
}

async function readMagic(path) {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(2)
    const { bytesRead } = await handle.read(buf, 0, 2, 0)
    return bytesRead === 2 ? buf : Buffer.alloc(0)
  } finally {
    await handle.close()
  }
}

/**
 * List plausible DSHA backups in the phone download directory.
 * Only regular files whose first bytes are gzip magic are returned; extension
 * is never trusted (real files can end in `..gz`). No full hash is computed
 * here: the selected file is hashed while it is streamed into the private job.
 *
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {number} [options.maxEntries]
 * @param {number} [options.maxBytes]
 * @returns {Promise<{root:string, entries:Array<{name:string,path:string,size:number,mtimeMs:number}>}>}
 */
export async function listBackupCandidates({
  root = process.env.DSHA_MIGRATOR_SCAN_DIR || DEFAULT_SCAN_ROOT,
  maxEntries = 20,
  maxBytes = MAX_BACKUP_BYTES,
} = {}) {
  let dirents
  try {
    dirents = await readdir(root, { withFileTypes: true })
  } catch (error) {
    throw coded('INPUT_SCAN_FAILED', `cannot read ${root} (enable 访问手机文件 first?)`, { cause: error })
  }
  const entries = []
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue // never follow symlinks/directories from the shared volume
    if (entries.length >= maxEntries * 4) break
    const path = join(root, dirent.name)
    let st
    try { st = await lstat(path) } catch { continue }
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) continue
    let magic
    try { magic = await readMagic(path) } catch { continue }
    if (magic.length !== 2 || magic[0] !== 0x1f || magic[1] !== 0x8b) continue
    entries.push({ name: dirent.name, path, size: st.size, mtimeMs: st.mtimeMs })
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { root, entries: entries.slice(0, maxEntries) }
}

/**
 * Stream one selected source file into `destinationDirectory`, hashing while
 * writing. The source file identity is checked before and after so a file
 * replaced/changed while copying is rejected instead of producing a mixed
 * backup. The returned temp file lives on the same filesystem as the future
 * job directory (caller renames it into place).
 *
 * @param {object} params
 * @param {string} params.sourcePath
 * @param {string} params.destinationDirectory
 * @param {number} [params.maxBytes]
 * @param {(copied:number,total:number)=>void} [params.onProgress]
 * @returns {Promise<{tmpPath:string,name:string,size:number,digest:string,sourceIdentity:object}>}
 */
export async function stageBackupFile({
  sourcePath,
  destinationDirectory,
  maxBytes = MAX_BACKUP_BYTES,
  onProgress,
}) {
  const before = await identityOf(sourcePath)
  if (before.size > maxBytes) {
    throw coded('INPUT_FILE_TOO_LARGE', `backup is ${before.size} B, over the accepted size`, { size: before.size, maxBytes })
  }
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 })
  const tmpPath = join(destinationDirectory, `.input-${randomUUID()}.part`)
  const hash = createHash('sha256')
  let copied = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      copied += chunk.length
      if (copied > maxBytes) {
        callback(coded('INPUT_FILE_TOO_LARGE', 'streamed backup exceeded the accepted size', { copied, maxBytes }))
        return
      }
      hash.update(chunk)
      if (typeof onProgress === 'function') {
        try { onProgress(copied, before.size) } catch { /* progress must not break copy */ }
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      createReadStream(sourcePath, { highWaterMark: 1024 * 1024 }),
      meter,
      createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }),
    )
    // Durability: the staged bytes are the source for verification/import.
    const handle = await open(tmpPath, 'r+')
    try {
      try { await handle.sync() } catch (error) {
        if (error?.code !== 'ENOSYS' && error?.code !== 'EPERM') throw error
      }
    } finally {
      await handle.close()
    }
    const after = await identityOf(sourcePath)
    if (!sameIdentity(before, after)) {
      throw coded('INPUT_FILE_CHANGED', 'backup changed while it was being staged — refusing a mixed copy')
    }
    return {
      tmpPath,
      name: sourcePath.split(/[\\/]/).pop() || 'backup',
      size: copied,
      digest: hash.digest('hex'),
      sourceIdentity: before,
    }
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {})
    if (error?.code === 'INPUT_FILE_CHANGED' || error?.code === 'INPUT_FILE_TOO_LARGE') throw error
    throw coded('INPUT_STAGE_FAILED', 'failed to stage the selected backup', { cause: error })
  }
}

/** Move a staged temp file into its final private input path (same fs). */
export async function commitStagedFile(tmpPath, destinationPath) {
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 }).catch(() => {})
  try {
    await fs.rename(tmpPath, destinationPath)
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      await rm(tmpPath, { force: true }).catch(() => {})
      throw coded('INPUT_STAGE_FAILED', 'failed to commit the staged backup', { cause: error })
    }
    // Cross-device (unexpected for a private data dir): copy then remove.
    await fs.copyFile(tmpPath, destinationPath)
    await rm(tmpPath, { force: true }).catch(() => {})
  }
}
