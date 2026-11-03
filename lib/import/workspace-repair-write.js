// Durable offline write protocol for the workspace repair diff.
//
// Order (each step is a barrier before the next):
//   1. exclusive backup, writeAll, file fsync, byte readback, dir fsync
//   2. complete temp writeAll, file fsync, byte readback + JSON parse
//   3. re-check the current unit hash, atomic rename over the unit
//   4. verify the replaced bytes, dir fsync, report durability honestly
//
// Real I/O errors are never "unsupported": only the measured platform
// directory limitations degrade, and then they are recorded in the result.
import fsDefault from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { applyWorkspaceRepair } from './workspace-repair.js'

const sha256 = value => createHash('sha256').update(value).digest('hex')

function coded(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

function dirFsyncUnsupported(error) {
  const code = error?.code
  if (process.platform === 'win32') return ['EPERM', 'EISDIR', 'EINVAL', 'EBUSY'].includes(code)
  return code === 'ENOSYS'
}

function writeAll(fsOps, fd, bytes) {
  const buffer = Buffer.from(bytes)
  let offset = 0
  while (offset < buffer.length) {
    let written
    try {
      written = fsOps.writeSync(fd, buffer, offset, buffer.length - offset)
    } catch (error) {
      throw coded('REPAIR_WRITE_FAILED', `write failed: ${error?.code ?? error?.message}`, { causeCode: error?.code ?? null })
    }
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw coded('REPAIR_WRITE_FAILED', `short write made no progress at ${offset}/${buffer.length}`)
    }
    offset += written
  }
  return buffer.length
}

function fsyncFile(fsOps, fd, label) {
  try {
    fsOps.fsyncSync(fd)
  } catch (error) {
    throw coded('REPAIR_FSYNC_FAILED', `${label} file fsync failed: ${error?.code ?? error?.message}`, { causeCode: error?.code ?? null })
  }
}

function fsyncDirectory(fsOps, dir) {
  let fd
  try {
    fd = fsOps.openSync(dir, 'r')
  } catch (error) {
    if (dirFsyncUnsupported(error)) return { ok: false, reason: `directory-open-unsupported:${error.code}` }
    throw coded('REPAIR_FSYNC_FAILED', `directory open failed: ${error?.code ?? error?.message}`, { causeCode: error?.code ?? null })
  }
  try {
    try {
      fsOps.fsyncSync(fd)
      return { ok: true }
    } catch (error) {
      if (dirFsyncUnsupported(error)) return { ok: false, reason: `directory-fsync-unsupported:${error.code}` }
      throw coded('REPAIR_FSYNC_FAILED', `directory fsync failed: ${error?.code ?? error?.message}`, { causeCode: error?.code ?? null })
    }
  } finally {
    fsOps.closeSync(fd)
  }
}

function compareBytes(fsOps, path, expected, code, label) {
  let actual
  try {
    actual = fsOps.readFileSync(path)
  } catch (error) {
    throw coded(code, `${label} readback failed: ${error?.code ?? error?.message}`, { causeCode: error?.code ?? null })
  }
  if (actual.length !== expected.length || !actual.equals(expected)) {
    throw coded(code, `${label} readback does not match the written bytes`)
  }
}

/**
 * Apply a reviewed repair diff to one workspace unit with the durable protocol.
 * @param {object} params
 * @param {string} params.unitPath
 * @param {Buffer|Uint8Array} params.unitBytes - bytes that produced the diff
 * @param {object} params.diff - planWorkspaceRepair result
 * @param {string} params.expectSha256 - reviewed unit hash
 * @param {boolean} params.engineStopped - explicit offline attestation
 * @param {object} [params.fsOps] - injectable fs (tests)
 * @returns {{ok: boolean, mode: string, backup: string, beforeSha256: string,
 *   afterSha256: string|null, directorySync: object|null,
 *   backupDirectorySync: object|null, error?: object}}
 */
export function applyWorkspaceRepairFile({
  unitPath,
  unitBytes,
  diff,
  expectSha256,
  engineStopped,
  fsOps = fsDefault,
}) {
  if (engineStopped !== true) throw coded('REPAIR_ENGINE_RUNNING', '--engine-stopped is required for a durable repair')
  const before = Buffer.from(unitBytes)
  if (typeof expectSha256 !== 'string' || sha256(before) !== expectSha256) {
    throw coded('REPAIR_STALE_UNIT', 'the unit changed since the diff was generated')
  }
  const applied = applyWorkspaceRepair(before, diff, { expectSha256 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${unitPath}.bak-${stamp}`

  // ---- 1. durable backup, exclusive create ----
  let backupFd
  try {
    backupFd = fsOps.openSync(backup, 'wx', 0o600)
    writeAll(fsOps, backupFd, before)
    fsyncFile(fsOps, backupFd, 'backup')
    fsOps.closeSync(backupFd)
    backupFd = undefined
    compareBytes(fsOps, backup, before, 'REPAIR_BACKUP_VERIFY_FAILED', 'backup')
  } catch (error) {
    try { if (backupFd !== undefined) fsOps.closeSync(backupFd) } catch { /* closed */ }
    try { fsOps.unlinkSync(backup) } catch { /* partial backup removed */ }
    throw error
  }
  // A backup that is not durably linked cannot justify replacing the original.
  const backupDirectorySync = fsyncDirectory(fsOps, dirname(unitPath))

  // ---- 2. complete, verified temporary file ----
  const temp = join(dirname(unitPath), `.workspace-repair-${randomUUID()}.tmp`)
  let tempFd
  try {
    tempFd = fsOps.openSync(temp, 'wx', 0o600)
    writeAll(fsOps, tempFd, applied.bytes)
    fsyncFile(fsOps, tempFd, 'temp')
    fsOps.closeSync(tempFd)
    tempFd = undefined
    compareBytes(fsOps, temp, applied.bytes, 'REPAIR_TEMP_VERIFY_FAILED', 'temp')
    JSON.parse(fsOps.readFileSync(temp).toString('utf8'))
  } catch (error) {
    try { if (tempFd !== undefined) fsOps.closeSync(tempFd) } catch { /* closed */ }
    try { fsOps.unlinkSync(temp) } catch { /* nothing */ }
    throw error
  }

  // ---- 3. re-check the original, then atomic replace ----
  let current
  try {
    current = fsOps.readFileSync(unitPath)
  } catch (error) {
    try { fsOps.unlinkSync(temp) } catch { /* nothing */ }
    throw coded('REPAIR_STALE_UNIT', `the unit could not be re-read before replace: ${error?.code ?? error?.message}`, { causeCode: error?.code ?? null })
  }
  if (sha256(current) !== expectSha256) {
    try { fsOps.unlinkSync(temp) } catch { /* nothing */ }
    throw coded('REPAIR_STALE_UNIT', 'the unit changed while the repair was staged — refusing to replace')
  }
  try {
    fsOps.renameSync(temp, unitPath)
  } catch (error) {
    try { fsOps.unlinkSync(temp) } catch { /* nothing */ }
    throw coded('REPAIR_REPLACE_FAILED', `atomic replace failed: ${error?.code ?? error?.message}`, { causeCode: error?.code ?? null })
  }

  // ---- 4. verify the replaced unit; report durability honestly ----
  const afterSha256 = sha256(applied.bytes)
  let replaced
  try {
    replaced = fsOps.readFileSync(unitPath)
  } catch (error) {
    return {
      ok: false,
      mode: 'replaced-verification-unknown',
      backup,
      beforeSha256: expectSha256,
      afterSha256,
      directorySync: null,
      backupDirectorySync,
      error: { code: 'REPAIR_REPLACE_VERIFY_FAILED', message: `replaced unit readback failed: ${error?.code ?? error?.message}` },
    }
  }
  if (replaced.length !== applied.bytes.length || !replaced.equals(applied.bytes)) {
    return {
      ok: false,
      mode: 'replaced-bytes-mismatch',
      backup,
      beforeSha256: expectSha256,
      afterSha256,
      directorySync: null,
      backupDirectorySync,
      error: { code: 'REPAIR_REPLACE_VERIFY_FAILED', message: 'replaced unit does not match the staged bytes — restore the backup' },
    }
  }
  let directorySync
  try {
    directorySync = fsyncDirectory(fsOps, dirname(unitPath))
  } catch (error) {
    return {
      ok: false,
      mode: 'replaced-durability-unknown',
      backup,
      beforeSha256: expectSha256,
      afterSha256,
      directorySync: null,
      backupDirectorySync,
      error: { code: error.code ?? 'REPAIR_FSYNC_FAILED', message: error.message },
    }
  }
  return {
    ok: true,
    mode: 'applied',
    backup,
    beforeSha256: expectSha256,
    afterSha256,
    directorySync,
    backupDirectorySync,
  }
}
