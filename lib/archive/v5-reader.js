// Streaming DSHA one-click backup (v5) reader — P1 archive core.
//
// Pipeline: gzip → ustar tar → portable.dshbak (DSHADATA container).
// Validation mirrors the source packager (DSHA BackupArchive.java:
// Record / Index / validateSummary, BackupLimits, LegacyTarReader):
//   - tar: header checksum, exactly two zero end blocks, member set/order
//   - record: kind/scope enums, size/mode/checksum/LINK-target field rules,
//     root & path grammar (no absolute/..-backslash-drive/NUL/CR-LF/empty
//     segments), parent-before-child ordering with type conflicts
//   - index: duplicate logical paths (NFC + case-folded key), cumulative
//     budgets (entries / metadata / payload / collision-key bytes)
//   - manifest: formatVersion/entries/bytes cross-check, operation/integrity
//     enums, FALSE_COMPLETE for incomplete archives claiming QUIESCENT,
//     provenance keys, roots consistency (≤512, duplicates, per-root scope,
//     roots == payload roots)
// Any failure rejects the whole input; partial results are never a success.
//
// Backpressure is honored end to end: gunzip pauses when the internal queue
// is over its high-water mark and sink writes respect `write() === false`
// with an explicit drain wait. Sinks get an error listener from creation and
// every failure path destroys the pipeline.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'

export const DEFAULT_LIMITS = {
  maxManifestBytes: 2 * 1024 * 1024, // 2 MiB
  maxMetaBytes: 16 * 1024, // 16 KiB per-record metadata
  maxPayloadBytes: 16n * 1024n * 1024n * 1024n, // 16 GiB per record
  maxCumulativePayloadBytes: 16n * 1024n * 1024n * 1024n, // 16 GiB total
  maxCumulativeMetaBytes: 32 * 1024 * 1024, // 32 MiB total
  maxKeyBytes: 8 * 1024 * 1024, // collision-key budget (×2 bytes, source)
  maxEntries: 100000,
  maxPathBytes: 2048,
  maxPathDepth: 64,
  maxRoots: 512,
  maxReadmeBytes: 16 * 1024, // README cap enforced by the source v5 packager
  queueHighWater: 4 * 1024 * 1024, // internal gzip→parser queue bound
}

const CONTAINER_MAGIC = 'DSHADATA'
const NUL = String.fromCharCode(0)
const TAR_BLOCK = 512
const CONTAINER_TAIL = 32

// Source BackupArchive.KINDS (PARTIAL/BEST_EFFORT are manifest integrity
// values, never record kinds).
const KINDS = new Set(['FILE', 'DIRECTORY', 'LINK', 'MISSING', 'UNREADABLE', 'EXCLUDED'])
// Source BackupScopes.ALL.
const SCOPES = new Set(['application', 'sessions', 'settings', 'plugins', 'projects'])
const OPERATIONS = new Set(['EXPORT', 'MAINTENANCE', 'RESCUE'])
const INTEGRITY = new Set(['QUIESCENT', 'EXTERNAL_CHECKED', 'PARTIAL', 'BEST_EFFORT'])

function cleanString(buf) {
  return buf.toString('utf8').split(NUL)[0]
}

function octalField(buf) {
  const raw = buf.toString('utf8').split(NUL).join('').split(' ').join('')
  if (!/^[0-7]*$/.test(raw)) throw new Error(`bad tar octal field: ${JSON.stringify(raw)}`)
  const n = parseInt(raw, 8)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad tar octal field: ${JSON.stringify(raw)}`)
  return n
}

// Port of BackupLimits.root: [a-z][a-z0-9_-]{0,79}
function checkRoot(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(value)) {
    throw new Error(`ROOT_ID: ${JSON.stringify(value)}`)
  }
  return value
}

// Port of BackupLimits.path.
function checkPath(name, limits) {
  if (typeof name !== 'string'
    || name.length > limits.maxPathBytes
    || name.startsWith('/')
    || name.includes('\\')
    || name.includes(NUL)
    || /^[A-Za-z]:/.test(name)) {
    throw new Error(`ARCHIVE_PATH: ${JSON.stringify(String(name).slice(0, 60))}`)
  }
  if (name === '') return name
  const parts = name.split('/')
  if (parts.length > limits.maxPathDepth) throw new Error(`PATH_DEPTH at ${name.slice(0, 60)}`)
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.includes('\n') || part.includes('\r')) {
      throw new Error(`ARCHIVE_PATH at ${JSON.stringify(name.slice(0, 60))}`)
    }
  }
  return name
}

// Port of BackupLimits.collisionKey: root + '/' + NFC(path).toLowerCase().
function collisionKey(root, path) {
  return root + (path === '' ? '' : '/' + path.normalize('NFC').toLowerCase())
}

// Exact-take reader over queued container bytes.
class ByteSource {
  constructor() {
    this.parts = []
    this.length = 0
  }

  push(chunk) {
    if (chunk.length) {
      this.parts.push(chunk)
      this.length += chunk.length
    }
  }

  take(n) {
    if (this.length < n) return null
    this.length -= n
    if (this.parts.length === 1 && this.parts[0].length === n) return this.parts.shift()
    const out = Buffer.alloc(n)
    let filled = 0
    while (filled < n) {
      const part = this.parts[0]
      const take = Math.min(part.length, n - filled)
      part.copy(out, filled, 0, take)
      if (take === part.length) this.parts.shift()
      else this.parts[0] = part.subarray(take)
      filled += take
    }
    return out
  }
}

export async function readV5Backup(filePath, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const onRecord = options.onRecord ?? (() => {})
  const makeSink = options.makeSink ?? null
  const startedAt = new Date().toISOString()

  // --- tar layer ---
  let tarStage = 'header'
  let headerBuf = null
  let headerSeen = 0
  let memberName = ''
  let memberSize = 0
  let memberSeen = 0
  let memberPad = 0
  let members = []
  let zeroBytes = 0
  let tarEnded = false
  let readmeSize = 0
  let containerMemberSeen = false

  // --- container layer ---
  const src = new ByteSource()
  const containerHash = createHash('sha256')
  let tailHold = Buffer.alloc(0)
  let containerBytes = 0

  let stage = 'magic'
  let version = null
  let metaLen = 0
  let recordMeta = null
  let payloadLeft = 0n
  let fileHash = null
  let fileSink = null
  let fileSinkSeen = 0
  let fileSinkDrain = null
  let fileSinkError = null  // set by the creation-time error listener
  let manifestLen = 0
  let manifestBuf = null
  let digest = null
  let entries = 0
  let fileEntries = 0
  let fileVerified = 0
  const payloadPaths = new Set()
  const rootScopeMap = new Map()
  const seenRoots = new Set()
  const sortedPaths = [] // collision keys, kept sorted (source TreeSet semantics)
  let metaTotal = 0
  let payloadTotal = 0n
  let keyTotal = 0
  let incomplete = false
  let manifest = null
  const pendingSinks = []
  const sinkErrors = []

  function containerFeed(part) {
    containerBytes += part.length
    const joined = tailHold.length ? Buffer.concat([tailHold, part]) : part
    if (joined.length > CONTAINER_TAIL) {
      containerHash.update(joined.subarray(0, joined.length - CONTAINER_TAIL))
      tailHold = joined.subarray(joined.length - CONTAINER_TAIL)
    } else {
      tailHold = joined
    }
    src.push(part)
  }

  function finishFile() {
    const digestHex = fileHash.digest('hex')
    if (digestHex !== recordMeta.sha256) {
      throw new Error(`FILE record ${recordMeta.root}/${recordMeta.path}: sha256 mismatch`)
    }
    fileVerified += 1
    onRecord(recordMeta, { sha256: digestHex })
    fileHash = null
  }

  // Port of Index.add: ordering, duplicates, type conflicts, cumulative
  // budgets, incomplete flag.
  function indexAdd(meta, metaLenBytes) {
    entries += 1
    if (entries > limits.maxEntries) throw new Error(`ENTRY_LIMIT (> ${limits.maxEntries})`)
    metaTotal += metaLenBytes
    if (metaTotal > limits.maxCumulativeMetaBytes) throw new Error(`METADATA_LIMIT (cumulative ${metaTotal})`)
    payloadTotal += BigInt(meta.size ?? 0)
    if (payloadTotal > limits.maxCumulativePayloadBytes) throw new Error(`PAYLOAD_LIMIT (cumulative ${payloadTotal})`)
    const key = collisionKey(meta.root, meta.path)
    keyTotal += Buffer.byteLength(key, 'utf8') * 2
    if (keyTotal > limits.maxKeyBytes) throw new Error(`KEY_LIMIT (cumulative ${keyTotal})`)
    // Sorted-set insert; duplicates reject (case-folded NFC key).
    let lo = 0
    let hi = sortedPaths.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sortedPaths[mid] < key) lo = mid + 1
      else hi = mid
    }
    if (sortedPaths[lo] === key) throw new Error(`DUPLICATE_PATH at ${meta.root}/${meta.path}`)
    sortedPaths.splice(lo, 0, key)
    seenRoots.add(meta.root)
    if (!rootScopeMap.has(meta.root)) rootScopeMap.set(meta.root, new Set())
    rootScopeMap.get(meta.root).add(meta.scope)
    // Port of the source ancestor check: no ancestor may be a non-directory.
    // (The source does NOT require parent records to exist.)
    let parent = key
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'))
      if (nonDirectories.has(parent)) throw new Error(`PATH_TYPE_CONFLICT: ancestor ${parent} of ${meta.root}/${meta.path} is not a directory`)
    }
    if (meta.kind !== 'DIRECTORY') {
      // A non-directory must not already have children recorded under it.
      const prefix = key + '/'
      let lo2 = 0
      let hi2 = sortedPaths.length
      while (lo2 < hi2) {
        const mid = (lo2 + hi2) >> 1
        if (sortedPaths[mid] < prefix) lo2 = mid + 1
        else hi2 = mid
      }
      if (sortedPaths[lo2]?.startsWith(prefix)) throw new Error(`PATH_TYPE_CONFLICT: children exist under non-directory ${meta.root}/${meta.path}`)
      nonDirectories.add(key)
    }
    if (meta.kind === 'MISSING' || meta.kind === 'UNREADABLE') incomplete = true
  }

  const nonDirectories = new Set()

  function validateRecord(meta) {
    checkRoot(meta.root)
    checkPath(meta.path, limits)
    if (!KINDS.has(meta.kind)) {
      throw new Error(`unknown record kind ${JSON.stringify(meta.kind)} at ${meta.root}/${meta.path} (source kinds: FILE/DIRECTORY/LINK/MISSING/UNREADABLE/EXCLUDED)`)
    }
    if (typeof meta.scope !== 'string' || !SCOPES.has(meta.scope)) {
      throw new Error(`UNKNOWN_SCOPE ${JSON.stringify(meta.scope)} at ${meta.root}/${meta.path}`)
    }
    if (!Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > Number(limits.maxPayloadBytes)) {
      throw new Error(`RECORD_FORMAT size at ${meta.root}/${meta.path}`)
    }
    if (meta.mode !== undefined && (!Number.isSafeInteger(meta.mode) || meta.mode < 0 || meta.mode > 0o777)) {
      throw new Error(`RECORD_MODE at ${meta.root}/${meta.path}`)
    }
    if (meta.kind === 'FILE') {
      if (typeof meta.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(meta.sha256)) {
        throw new Error(`RECORD_CHECKSUM at ${meta.root}/${meta.path}`)
      }
    } else if (meta.size !== 0 || (meta.sha256 ?? '') !== '') {
      throw new Error(`RECORD_FORMAT: non-FILE ${meta.kind} at ${meta.root}/${meta.path} must have size 0 and empty sha256`)
    }
    if (meta.kind === 'LINK') {
      const target = meta.target
      if (typeof target !== 'string' || target === '' || target.length > 2048 || target.includes(NUL) || target.includes('\\')) {
        throw new Error(`LINK_FORMAT at ${meta.root}/${meta.path}`)
      }
    }
  }

  // Port of validateSummary: full manifest/index cross-check.
  function validateSummary() {
    if (manifest.formatVersion !== 5) throw new Error(`manifest formatVersion ${manifest.formatVersion}, expected 5`)
    if (manifest.entries !== entries) throw new Error(`MANIFEST_PAYLOAD_MISMATCH: manifest claims ${manifest.entries} entries, stream had ${entries}`)
    if (manifest.bytes !== Number(payloadTotal)) throw new Error(`MANIFEST_PAYLOAD_MISMATCH: manifest claims ${manifest.bytes} bytes, stream had ${payloadTotal}`)
    if (!OPERATIONS.has(manifest.operation) || !INTEGRITY.has(manifest.integrity)) {
      throw new Error(`BACKUP_POLICY: operation ${JSON.stringify(manifest.operation)} integrity ${JSON.stringify(manifest.integrity)}`)
    }
    if (incomplete && manifest.integrity !== 'PARTIAL' && manifest.integrity !== 'BEST_EFFORT') {
      throw new Error('FALSE_COMPLETE: archive has MISSING/UNREADABLE records but integrity is not PARTIAL/BEST_EFFORT')
    }
    for (const key of ['createdAt', 'appVersion', 'runtime', 'dataFormat', 'sensitivePolicy', 'plugins']) {
      if (!(key in manifest)) throw new Error(`MANIFEST_PROVENANCE: missing ${key}`)
    }
    if (!Array.isArray(manifest.roots) || manifest.roots.length > limits.maxRoots) throw new Error('ROOTS_LIMIT')
    const declaredRoots = new Set()
    for (const row of manifest.roots) {
      if (!row || typeof row !== 'object') throw new Error('ROOTS_FORMAT')
      const id = checkRoot(row.id)
      if (declaredRoots.has(id)) throw new Error(`DUPLICATE_ROOT ${id}`)
      declaredRoots.add(id)
      if (typeof row.scope !== 'string' || !SCOPES.has(row.scope)) throw new Error(`UNKNOWN_SCOPE ${JSON.stringify(row.scope)} for root ${id}`)
      if (row.scope !== 'application') {
        const seenScopes = rootScopeMap.get(id) ?? new Set()
        if (seenScopes.size !== 1 || !seenScopes.has(row.scope)) {
          throw new Error(`ROOT_SCOPE_MISMATCH: root ${id} declares ${row.scope}, records carry [${[...seenScopes].join(', ')}]`)
        }
      }
    }
    const payloadRoots = new Set(seenRoots)
    if (declaredRoots.size !== payloadRoots.size || ![...payloadRoots].every(r => declaredRoots.has(r))) {
      throw new Error(`ROOTS_PAYLOAD_MISMATCH: manifest roots and payload roots differ`)
    }
  }

  function containerStage() {
    for (;;) {
      switch (stage) {
        case 'magic': {
          const b = src.take(8)
          if (!b) return
          if (b.toString('utf8') !== CONTAINER_MAGIC) {
            throw new Error(`container magic ${JSON.stringify(b.toString('latin1'))}, expected DSHADATA`)
          }
          stage = 'version'
          break
        }
        case 'version': {
          const b = src.take(4)
          if (!b) return
          version = b.readUint32BE(0)
          if (version !== 5) throw new Error(`container version ${version}, expected 5 (host v1–v4 not supported)`)
          stage = 'metaLen'
          break
        }
        case 'metaLen': {
          const b = src.take(4)
          if (!b) return
          metaLen = b.readInt32BE(0)
          if (metaLen === -1) {
            stage = 'manifestLen'
            break
          }
          if (metaLen <= 0 || metaLen > limits.maxMetaBytes) {
            throw new Error(`record metadata length ${metaLen} outside (0, ${limits.maxMetaBytes}]`)
          }
          stage = 'meta'
          break
        }
        case 'meta': {
          const b = src.take(metaLen)
          if (!b) return
          recordMeta = JSON.parse(b.toString('utf8'))
          if (!recordMeta || typeof recordMeta !== 'object' || typeof recordMeta.kind !== 'string') {
            throw new Error('record metadata is not an object with a kind')
          }
          recordMeta.root = checkRoot(recordMeta.root)
          recordMeta.path = checkPath(recordMeta.path, limits)
          validateRecord(recordMeta)
          // Index bookkeeping (ordering/duplicates/budgets) before payload.
          indexAdd(recordMeta, metaLen)
          if (recordMeta.kind === 'FILE') {
            fileEntries += 1
            fileHash = createHash('sha256')
            // Per-file state reset: fileSinkSeen in particular must NOT carry
            // bytes counted for the previous file (two-file extraction used
            // to fail with "sink size 6 != 3").
            fileSinkSeen = 0
            fileSinkDrain = null
            fileSink = makeSink ? makeSink(recordMeta) : null
            if (fileSink) {
              // Error listener installed at CREATION: a sink that fails mid-
              // payload (ENOSPC/EIO while write() is in flight) must surface
              // as a pipeline failure, never as an unhandled 'error' event
              // that kills the Host process. The listener only RECORDS the
              // error (it lives outside the executor); pumpContainer checks
              // the slot and routes it through fail().
              fileSink.on('error', error => {
                fileSinkError = fileSinkError ?? (error instanceof Error ? error : new Error(String(error)))
              })
            }
            stage = 'payloadLen'
          } else {
            // Non-FILE records carry an empty payload segment (length 0 per
            // the source Record rules) and are reported as-is.
            stage = 'payloadLen'
          }
          break
        }
        case 'payloadLen': {
          const b = src.take(8)
          if (!b) return
          payloadLeft = b.readBigUInt64BE(0)
          if (payloadLeft > limits.maxPayloadBytes) throw new Error(`FILE record ${recordMeta.root}/${recordMeta.path}: payload ${payloadLeft} over limit`)
          if (recordMeta.kind === 'FILE' && BigInt(recordMeta.size) !== payloadLeft) {
            throw new Error(`FILE record ${recordMeta.root}/${recordMeta.path}: metadata size ${recordMeta.size} != payload length ${payloadLeft}`)
          }
          if (recordMeta.kind !== 'FILE' && payloadLeft !== 0n) {
            throw new Error(`non-FILE record ${recordMeta.root}/${recordMeta.path} carries ${payloadLeft} payload bytes`)
          }
          stage = 'payload'
          break
        }
        case 'payload': {
          // The finish check lives in the OUTER loop: with a slow sink the
          // 'await-drain' return fires exactly when payloadLeft hits 0, and
          // the resumed call must run the completion path before anything
          // else.
          while (payloadLeft > 0n) {
            const want = payloadLeft >= 0x100000n ? 0x100000 : Number(payloadLeft)
            const b = src.take(want)
            if (!b) return
            if (fileHash) fileHash.update(b)
            // Account the bytes BEFORE handing them to the sink: an early
            // 'await-drain' return must never leave the ledger out of sync
            // with what the sink already received.
            payloadLeft -= BigInt(b.length)
            if (fileSink) {
              // Register the drain waiter BEFORE writing: a sink that drains
              // synchronously after write() must not leave us awaiting an
              // event that already fired.
              let onDrain
              const drained = new Promise(resolve => { onDrain = resolve })
              fileSink.once('drain', onDrain)
              const okToContinue = fileSink.write(b)
              fileSinkSeen += b.length
              if (!okToContinue) {
                fileSinkDrain = drained
                return 'await-drain'
              }
              fileSink.removeListener('drain', onDrain)
            }
          }
          if (payloadLeft === 0n && stage === 'payload') {
            if (fileSink) {
              if (fileSinkSeen !== recordMeta.size) {
                throw new Error(`FILE record ${recordMeta.root}/${recordMeta.path}: sink size ${fileSinkSeen} != ${recordMeta.size}`)
              }
              pendingSinks.push(sinkEnd(fileSink))
            }
            fileSink = null
            fileSinkDrain = null
            if (fileHash) finishFile()
            stage = 'metaLen'
          }
          break
        }
        case 'manifestLen': {
          const b = src.take(4)
          if (!b) return
          manifestLen = b.readUint32BE(0)
          if (manifestLen > limits.maxManifestBytes) throw new Error(`manifest ${manifestLen} bytes over limit ${limits.maxManifestBytes}`)
          stage = 'manifest'
          break
        }
        case 'manifest': {
          const b = src.take(manifestLen)
          if (!b) return
          manifestBuf = b
          manifest = JSON.parse(manifestBuf.toString('utf8'))
          stage = 'digest'
          break
        }
        case 'digest': {
          const b = src.take(CONTAINER_TAIL)
          if (!b) return
          digest = b
          stage = 'eof'
          break
        }
        case 'eof':
          // Normal rest state once the digest is consumed; only real trailing
          // container bytes are an error.
          if (src.length > 0) throw new Error(`trailing bytes after container digest (${src.length} extra)`)
          return
        default:
          throw new Error(`unreachable container stage ${stage}`)
      }
    }
  }

  function sinkEnd(sink) {
    // Rejects on sink error; resolves on successful completion. An error that
    // arrives after resolve() is recorded in sinkErrors so the overall
    // verification still fails — without leaving an unhandled rejection.
    // NOTE: callers must push the returned promise into pendingSinks before
    // any await point; fail() attaches the swallowing catch there.
    const p = new Promise((resolve, reject) => {
      if (typeof sink.end !== 'function') return resolve()
      let done = false
      const onError = error => {
        if (!done) {
          done = true
          reject(error)
        } else {
          sinkErrors.push(error)
        }
      }
      const onFinish = () => { if (!done) { done = true; resolve() } }
      sink.on('error', onError)
      sink.on('close', onFinish)
      sink.end(() => {
        // Completion callback alone is not success: wait one microtask so a
        // synchronous-after-end error can still flip this to rejected.
        queueMicrotask(onFinish)
      })
    })
    void p.catch(() => {}) // fail() also swallows via pendingSinks; belt and braces
    return p
  }

  function destroySink(sink) {
    if (sink && typeof sink.destroy === 'function') sink.destroy()
  }

  return await new Promise((resolve, reject) => {
    const gunzip = createGunzip()
    const input = createReadStream(filePath, { highWaterMark: 1 << 18 })
    let queue = []
    let pumping = false
    let settled = false
    let paused = false

    const queueLength = () => queue.reduce((a, c) => a + c.length, 0)

    const resumeIfNeeded = () => {
      if (!settled && paused && queueLength() <= limits.queueHighWater) {
        paused = false
        input.resume()
        gunzip.resume()
      }
    }

    const fail = (error) => {
      if (settled) return
      settled = true
      input.destroy()
      gunzip.destroy()
      if (fileSink) destroySink(fileSink)
      for (const s of pendingSinks) void s.catch(() => {})
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    async function drainWait() {
      if (fileSinkDrain) {
        const wait = fileSinkDrain
        fileSinkDrain = null
        // A settled run must not wait on a drain that may never fire (the
        // sink failed or the pipeline was destroyed) — race the settle flag.
        await Promise.race([wait, new Promise(resolve => {
          // Wake when the run settles OR the sink errored (no drain will
          // ever come after ENOSPC/EIO).
          const t = setInterval(() => {
            if (settled || fileSinkError) { clearInterval(t); resolve() }
          }, 5)
          t.unref?.()
        })])
      }
    }

    async function pumpContainer() {
      for (;;) {
        if (settled) return // a sink error routed through fail() ends everything
        if (fileSinkError) fail(fileSinkError) // recorded by the creation-time listener
        const verdict = containerStage()
        if (verdict !== 'await-drain') return
        await drainWait()
        // After each drain, keep driving the stage machine: it may have more
        // buffered bytes available (src) that never trigger a new feed.
      }
    }

    async function pump() {
      pumping = true
      try {
        // Body wrapped below; rejections after settle are swallowed by the
        // caller's catch — before settle they race the main promise, which
        // wins because fail() settles synchronously.
        while (queue.length > 0) {
          const data = queue.length === 1 ? queue[0] : Buffer.concat(queue)
          queue = []
          let off = 0
          while (off < data.length) {
            if (tarStage === 'header') {
              const want = TAR_BLOCK - headerSeen
              const take = Math.min(want, data.length - off)
              headerBuf = headerBuf ? Buffer.concat([headerBuf, data.subarray(off, off + take)]) : Buffer.from(data.subarray(off, off + take))
              headerSeen += take
              off += take
              if (headerSeen < TAR_BLOCK) break
              const header = headerBuf
              headerBuf = null
              headerSeen = 0
              if (header.every(b => b === 0)) {
                zeroBytes += TAR_BLOCK
                tarStage = 'zeroTail'
                continue
              }
              if (tarEnded) throw new Error('data block after tar end-of-archive')
              // Verify the ustar header checksum: sum of all bytes with the
              // chksum field treated as 8 spaces must equal the stored value.
              const withSpaces = Buffer.from(header)
              withSpaces.fill(0x20, 148, 156)
              let sum = 0
              for (const b of withSpaces) sum += b
              const stored = octalField(header.subarray(148, 156))
              if (sum !== stored) throw new Error(`tar header checksum mismatch for ${JSON.stringify(cleanString(header.subarray(0, 100)))} (computed ${sum}, stored ${stored})`)
              memberName = cleanString(header.subarray(0, 100))
              memberSize = octalField(header.subarray(124, 136))
              const type = header[156]
              const magicField = cleanString(header.subarray(257, 263))
              if (magicField !== 'ustar') throw new Error(`tar member ${memberName}: magic ${JSON.stringify(magicField)}, expected ustar`)
              memberSeen = 0
              members.push({ name: memberName, size: memberSize })
              if (type !== 0x30) throw new Error(`tar member ${memberName}: unsupported type 0x${type.toString(16)} (only regular files)`)
              if (members.length > 2) throw new Error(`unexpected tar member ${memberName}: a v5 archive has exactly two members`)
              if (members.length === 1 && memberName !== 'portable.dshbak') {
                throw new Error(`first tar member is ${JSON.stringify(memberName)}, expected portable.dshbak`)
              }
              if (members.length === 2 && memberName !== 'README.txt') {
                throw new Error(`second tar member is ${JSON.stringify(memberName)}, expected README.txt`)
              }
              tarStage = 'data'
              continue
            }
            if (tarStage === 'zeroTail') {
              // After the first zero block only zeros may follow; the archive
              // ends once two full zero blocks are seen.
              const rest = data.length - off
              if (rest > 0 && data.subarray(off).some(b => b !== 0)) {
                throw new Error(`non-zero bytes after tar end-of-archive block (members=${JSON.stringify(members)}, memberSeen=${memberSeen}/${memberSize}, containerBytes=${containerBytes}, zeroBytes=${zeroBytes}, stage=${stage}, srcLeft=${src.length})`)
              }
              zeroBytes += rest
              off = data.length
              if (zeroBytes >= 2 * TAR_BLOCK) tarEnded = true
              await pumpContainer()
              break
            }
            if (tarStage === 'padding') {
              const take = Math.min(memberPad, data.length - off)
              if (take > 0 && data.subarray(off, off + take).some(b => b !== 0)) throw new Error('non-zero tar padding')
              memberPad -= take
              off += take
              if (memberPad === 0) tarStage = 'header'
              if (containerMemberSeen) await pumpContainer()
              continue
            }
            // tarStage === 'data'
            const want = memberSize - memberSeen
            const take = Math.min(want, data.length - off)
            const part = data.subarray(off, off + take)
            off += take
            memberSeen += take
            if (memberName === 'portable.dshbak') {
              containerMemberSeen = true
              containerFeed(part)
              await pumpContainer()
            } else {
              readmeSize += part.length
              if (readmeSize > limits.maxReadmeBytes) {
                throw new Error(`README.txt is ${readmeSize} bytes, over the source v5 limit ${limits.maxReadmeBytes}`)
              }
              if (containerMemberSeen) await pumpContainer()
            }
            if (memberSeen === memberSize) {
              memberPad = (TAR_BLOCK - (memberSize % TAR_BLOCK)) % TAR_BLOCK
              tarStage = memberPad > 0 ? 'padding' : 'header'
            }
          }
        }
      } catch (error) {
        fail(error)
        if (settled) return // already routed through the main promise
        return
      }
      pumping = false
      resumeIfNeeded()
    }

    gunzip.on('data', chunk => {
      if (settled) return
      queue.push(chunk)
      if (queueLength() > limits.queueHighWater && !paused) {
        // Flow control: the parser (or a slow sink) is behind — pause the
        // source until the queue drains below the mark.
        paused = true
        input.pause()
        gunzip.pause()
      }
      if (!pumping) {
        // pump() rethrows only after settle; the main promise already carries
        // that error, so swallowing here cannot hide a live failure.
        pump().catch(error => { if (!settled) fail(error) })
      }
    })

    gunzip.on('end', () => {
      const drainAndVerify = async () => {
        try {
          while (!settled && (queue.length > 0 || pumping)) {
            if (!pumping && queue.length > 0) await pump()
            else await new Promise(r => setImmediate(r))
          }
          resumeIfNeeded()
          if (settled) return
          // Tar is complete: drive the container stage machine until it has
          // consumed every buffered byte (or is legitimately at eof).
          while (stage !== 'eof' && src.length > 0) {
            await pumpContainer()
            if (stage === 'eof' || src.length === 0) break
            if (src.length > 0) {
              // One more pass in case the stage machine consumed partially.
              const before = src.length
              await new Promise(r => setImmediate(r))
              if (src.length === before) break
            }
          }
          if (zeroBytes % TAR_BLOCK !== 0) throw new Error(`tar zero tail is ${zeroBytes} bytes, not a block multiple`)
          if (zeroBytes < 2 * TAR_BLOCK) throw new Error(`tar end-of-archive needs two zero blocks, saw ${zeroBytes / TAR_BLOCK}`)
          if (!tarEnded) throw new Error('tar stream ended without end-of-archive blocks')
          if (!containerMemberSeen) throw new Error('portable.dshbak member missing')
          if (members.length !== 2) throw new Error(`expected exactly two tar members, got ${members.length}`)
          if (stage !== 'eof') throw new Error(`container ended mid-${stage} (truncated; containerBytes=${containerBytes}, payloadLeft=${payloadLeft}, srcLeft=${src.length}, metaTotal=${metaTotal}, fileSeen=${fileSinkSeen ?? 0}, incompleteStage=${stage})`)
          if (tailHold.length !== CONTAINER_TAIL) throw new Error(`tail window ${tailHold.length} bytes, expected ${CONTAINER_TAIL}`)
          const digestHex = containerHash.copy().digest('hex')
          if (digestHex !== digest.toString('hex')) throw new Error('container tail sha256 mismatch')
          await Promise.all(pendingSinks).catch(error => { throw error })
          if (sinkErrors.length > 0) throw sinkErrors[0]
          validateSummary()
          resolve({
            at: startedAt,
            filePath,
            limits,
            manifest,
            stats: {
              containerBytes,
              tarMembers: members,
              readmeBytes: readmeSize,
              entries,
              fileEntries,
              fileVerified,
              incomplete,
              cumulativePayloadBytes: Number(payloadTotal),
              cumulativeMetaBytes: metaTotal,
            },
          })
        } catch (error) {
          fail(error)
        }
      }
      drainAndVerify().catch(() => {})
    })

    input.on('error', fail)
    gunzip.on('error', error => fail(new Error(`gzip layer: ${error.message}`)))
    input.pipe(gunzip)
  })
}
