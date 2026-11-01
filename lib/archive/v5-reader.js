// Streaming DSHA one-click backup (v5) reader — P1 archive core.
//
// Pipeline: gzip → ustar tar → portable.dshbak (DSHADATA container).
// Every layer is verified incrementally and ANY structural failure rejects
// the whole input: tar member set, README size cap, container magic/version,
// per-record metadata size, payload size limits, path limits, per-FILE
// size/sha256, manifest size, container tail digest, and EOF after the
// digest. Partial results are never reported as success.
//
// Memory stays bounded: payload bytes stream through the per-file hash (and
// optionally into a caller-provided sink) and are never buffered whole.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'

export const DEFAULT_LIMITS = {
  maxManifestBytes: 2 * 1024 * 1024, // 2 MiB
  maxMetaBytes: 16 * 1024, // 16 KiB per-record metadata (source BackupLimits)
  maxPayloadBytes: 16n * 1024n * 1024n * 1024n, // 16 GiB source cap
  maxEntries: 100000,
  maxPathBytes: 2048,
  maxPathDepth: 64,
  maxReadmeBytes: 16 * 1024, // README cap enforced by the source v5 packager
}

const CONTAINER_MAGIC = 'DSHADATA'
const NUL = String.fromCharCode(0)
const TAR_BLOCK = 512
const CONTAINER_TAIL = 32

function cleanString(buf) {
  return buf.toString('utf8').split(NUL)[0]
}

function octalField(buf) {
  const raw = buf.toString('utf8').split(NUL).join('').split(' ').join('')
  const n = parseInt(raw, 8)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad tar octal field: ${JSON.stringify(raw)}`)
  return n
}

function checkPath(path) {
  // '' names the logical root itself (legal for root-level records).
  if (path.length === 0) return path
  if (Buffer.byteLength(path, 'utf8') > DEFAULT_LIMITS.maxPathBytes) {
    throw new Error(`path longer than ${DEFAULT_LIMITS.maxPathBytes}`)
  }
  if (path.split('/').length > DEFAULT_LIMITS.maxPathDepth) throw new Error(`path deeper than ${DEFAULT_LIMITS.maxPathDepth}`)
  return path
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

  // Take exactly n bytes; null while fewer are available.
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
  const makeSink = options.makeSink ?? null // (meta) => Writable for FILE payloads
  const startedAt = new Date().toISOString()

  // --- tar layer state ---
  let tarStage = 'header' // header | data | padding | zeroTail
  let headerBuf = null
  let headerSeen = 0
  let memberName = ''
  let memberSize = 0
  let memberSeen = 0
  let memberPad = 0
  let members = []
  let readmeSize = 0
  let containerMemberSeen = false
  let tarEnded = false

  // --- container layer state ---
  const src = new ByteSource()
  const containerHash = createHash('sha256')
  let tailHold = Buffer.alloc(0) // last ≤32 container bytes
  let containerBytes = 0

  let stage = 'magic'
  let version = null
  let metaLen = 0
  let recordMeta = null
  let payloadLeft = 0n
  let fileHash = null
  let fileSink = null
  let fileSinkSeen = 0
  let manifestLen = 0
  let manifestBuf = null
  let digest = null
  let entries = 0
  let fileEntries = 0
  let fileVerified = 0
  let fileFailures = 0
  const pendingSinks = []

  function containerFeed(part) {
    containerBytes += part.length
    // Hash everything except the trailing ≤32 bytes (the digest itself).
    const joined = tailHold.length ? Buffer.concat([tailHold, part]) : part
    if (joined.length > CONTAINER_TAIL) {
      containerHash.update(joined.subarray(0, joined.length - CONTAINER_TAIL))
      tailHold = joined.subarray(joined.length - CONTAINER_TAIL)
    } else {
      tailHold = joined
    }
    src.push(part)
    containerStage()
  }

  function finishFile() {
    const digestHex = fileHash.digest('hex')
    if (digestHex !== recordMeta.sha256) {
      fileFailures += 1
      throw new Error(`FILE record ${recordMeta.path}: sha256 mismatch (expected ${recordMeta.sha256.slice(0, 12)}…, got ${digestHex.slice(0, 12)}…)`)
    }
    fileVerified += 1
    onRecord(recordMeta, { sha256: digestHex })
    fileHash = null
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
          recordMeta.path = checkPath(String(recordMeta.path ?? ''))
          entries += 1
          if (entries > limits.maxEntries) throw new Error(`more than ${limits.maxEntries} entries`)
          if (recordMeta.kind === 'FILE') {
            fileEntries += 1
            if (!Number.isSafeInteger(recordMeta.size) || recordMeta.size < 0) throw new Error(`FILE record ${recordMeta.path}: bad size`)
            if (typeof recordMeta.sha256 !== 'string' || recordMeta.sha256.length !== 64) throw new Error(`FILE record ${recordMeta.path}: bad sha256`)
            fileHash = createHash('sha256')
            fileSink = makeSink ? makeSink(recordMeta) : null
            fileSinkSeen = 0
          } else if (['DIRECTORY', 'EXCLUDED', 'UNREADABLE', 'LINK', 'PARTIAL'].includes(recordMeta.kind)) {
            fileHash = null
            fileSink = null
          } else {
            throw new Error(`unknown record kind ${JSON.stringify(recordMeta.kind)} at ${recordMeta.path}`)
          }
          // Every record carries an 8-byte payload length (0 for non-FILE).
          stage = 'payloadLen'
          break
        }
        case 'payloadLen': {
          const b = src.take(8)
          if (!b) return
          payloadLeft = b.readBigUInt64BE(0)
          if (payloadLeft > limits.maxPayloadBytes) throw new Error(`FILE record ${recordMeta.path}: payload ${payloadLeft} over limit`)
          if (BigInt(recordMeta.size) !== payloadLeft) {
            throw new Error(`FILE record ${recordMeta.path}: metadata size ${recordMeta.size} != payload length ${payloadLeft}`)
          }
          stage = 'payload'
          break
        }
        case 'payload': {
          while (payloadLeft > 0n) {
            const want = payloadLeft >= 0x100000n ? 0x100000 : Number(payloadLeft)
            const b = src.take(want)
            if (!b) return
            if (fileHash) fileHash.update(b)
            if (fileSink) {
              fileSink.write(b)
              fileSinkSeen += b.length
            }
            payloadLeft -= BigInt(b.length)
            if (payloadLeft === 0n) {
              if (fileSink) {
                if (fileSinkSeen !== recordMeta.size) {
                  throw new Error(`FILE record ${recordMeta.path}: sink size ${fileSinkSeen} != ${recordMeta.size}`)
                }
                pendingSinks.push(sinkEnd(fileSink))
              }
              fileSink = null
              if (fileHash) {
                finishFile()
              } else {
                onRecord(recordMeta, {})
              }
              stage = 'metaLen'
              break
            }
          }
          if (payloadLeft === 0n && stage === 'payload') {
            // zero-length payload edge
            if (fileSink) pendingSinks.push(sinkEnd(fileSink))
            fileSink = null
            if (fileHash) {
              finishFile()
            } else {
              onRecord(recordMeta, {})
            }
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
    return new Promise((resolve, reject) => {
      if (typeof sink.end !== 'function') return resolve()
      sink.on('error', reject)
      sink.end(() => resolve())
    })
  }

  return await new Promise((resolve, reject) => {
    const gunzip = createGunzip()
    const input = createReadStream(filePath, { highWaterMark: 1 << 18 })
    let pending = Buffer.alloc(0)
    let pumping = false
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      input.destroy()
      gunzip.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    async function pump() {
      pumping = true
      try {
        while (pending.length > 0) {
          const data = pending
          pending = Buffer.alloc(0)
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
                tarEnded = true
                tarStage = 'zeroTail'
                continue
              }
              memberName = cleanString(header.subarray(0, 100))
              memberSize = octalField(header.subarray(124, 136))
              const type = header[156]
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
              if (data.subarray(off).some(b => b !== 0)) throw new Error('non-zero bytes after tar end-of-archive block')
              off = data.length
              break
            }
            if (tarStage === 'padding') {
              const take = Math.min(memberPad, data.length - off)
              if (take > 0 && data.subarray(off, off + take).some(b => b !== 0)) throw new Error('non-zero tar padding')
              memberPad -= take
              off += take
              if (memberPad === 0) tarStage = 'header'
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
            } else {
              readmeSize += part.length
              if (readmeSize > limits.maxReadmeBytes) {
                throw new Error(`README.txt is ${readmeSize} bytes, over the source v5 limit ${limits.maxReadmeBytes}`)
              }
            }
            if (memberSeen === memberSize) {
              memberPad = (TAR_BLOCK - (memberSize % TAR_BLOCK)) % TAR_BLOCK
              tarStage = memberPad > 0 ? 'padding' : 'header'
            }
          }
        }
      } catch (error) {
        fail(error)
        return
      }
      pumping = false
    }

    gunzip.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      if (!pumping) void pump()
    })

    gunzip.on('end', () => {
      // Drain anything left buffered by the last pump, then verify.
      const drainAndVerify = async () => {
        try {
          if (pending.length > 0 && !settled) await pump()
          while (!settled && pumping) await new Promise(r => setImmediate(r))
          if (settled) return
          if (!tarEnded) throw new Error('tar stream ended without end-of-archive blocks')
          if (!containerMemberSeen) throw new Error('portable.dshbak member missing')
          if (members.length !== 2) throw new Error(`expected exactly two tar members, got ${members.length}`)
          if (stage !== 'eof') throw new Error(`container ended mid-${stage} (truncated)`)
          if (tailHold.length !== CONTAINER_TAIL) throw new Error(`tail window ${tailHold.length} bytes, expected ${CONTAINER_TAIL}`)
          const digestHex = containerHash.copy().digest('hex')
          if (digestHex !== digest.toString('hex')) throw new Error('container tail sha256 mismatch')
          await Promise.all(pendingSinks)
          const manifest = JSON.parse(manifestBuf.toString('utf8'))
          if (!manifest || manifest.formatVersion !== 5) {
            throw new Error(`manifest formatVersion ${manifest?.formatVersion}, expected 5`)
          }
          if (Number.isSafeInteger(manifest.entries) && manifest.entries !== entries) {
            throw new Error(`manifest claims ${manifest.entries} entries, stream had ${entries}`)
          }
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
              fileFailures,
            },
          })
        } catch (error) {
          fail(error)
        }
      }
      void drainAndVerify()
    })

    input.on('error', fail)
    gunzip.on('error', error => fail(new Error(`gzip layer: ${error.message}`)))
    input.pipe(gunzip)
  })
}
