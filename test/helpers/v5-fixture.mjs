// TEST-ONLY v5 archive builder for synthetic fixtures. Not imported by
// production code: the reader is the verifier; this exists so tests can
// construct both valid and deliberately malformed archives without any
// private data. Byte layout mirrors DSHA BackupArchive.Writer (verified
// byte-identical against a real backup in p0-lab).
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'

const TAR_BLOCK = 512

function ustarHeader(name, size, { corruptChecksum = false } = {}) {
  const h = Buffer.alloc(TAR_BLOCK)
  h.write(name, 0, Math.min(100, name.length), 'utf8')
  h.write('0000644\0', 100, 'utf8')
  h.write('0000000\0', 108, 'utf8')
  h.write('0000000\0', 116, 'utf8')
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8')
  h.write(Math.floor(1793500000).toString(8).padStart(11, '0') + '\0', 136, 'utf8')
  h.write('        ', 148, 'utf8')
  h.write('0', 156, 'utf8')
  h.write('ustar\0', 257, 'utf8')
  h.write('00', 263, 'utf8')
  let sum = 0
  for (const b of h) sum += b
  const checksum = sum.toString(8).padStart(6, '0') + '\0 '
  h.write(corruptChecksum ? '000000\0 ' : checksum, 148, 'utf8')
  return h
}

function tarAppend(parts, name, data, options) {
  parts.push(ustarHeader(name, data.length, options))
  parts.push(data)
  const rem = data.length % TAR_BLOCK
  if (rem) parts.push(Buffer.alloc(TAR_BLOCK - rem))
}

/**
 * Build a complete v5 backup file.
 * entries: [{ meta: {root, path, kind, scope, size, sha256, mode?, target?}, payload?: Buffer }]
 * options:
 *   manifest    — overrides merged into the summary (e.g. integrity, roots, bytes)
 *   corruptChecksum — corrupt the first tar header checksum
 *   singleZeroBlock — emit one 512-byte zero end block instead of two
 *   truncateBytes   — cut the final buffer short
 */
export function buildV5Archive(entries, options = {}) {
  // --- container ---
  const payloadTotal = entries.reduce((a, e) => a + (e.payload?.length ?? 0), 0)
  const rootMap = new Map()
  for (const e of entries) rootMap.set(e.meta.root, { id: e.meta.root, scope: e.meta.scope, external: false, logicalKind: 'dsh-child', name: e.meta.root })
  const manifest = {
    operation: 'EXPORT',
    createdAt: 1793500000000,
    requestedScope: 'application',
    appVersion: '0.2.1-rc.2-test',
    runtime: '0.2.1-rc.2',
    dataFormat: 'UNINSPECTED',
    sensitivePolicy: 'UNENCRYPTED',
    plugins: { version: 2, runtimeProof: '00', nodes: {} },
    dataCompatibility: { schema: 1, status: 'unknown', formatId: '', formatEpoch: '', observedRuntimeId: '00', observedReaderWriter: '00', evidence: 'NO_COMPLETE_FORMAT_INSPECTION' },
    roots: [...rootMap.values()],
    changedSources: {},
    integrity: 'QUIESCENT',
    formatVersion: 5,
    entries: entries.length,
    bytes: payloadTotal,
    ...(options.manifest ?? {}),
  }
  const containerParts = []
  containerParts.push(Buffer.from('DSHADATA', 'utf8'))
  const v = Buffer.alloc(4)
  v.writeUint32BE(5)
  containerParts.push(v)
  for (const e of entries) {
    const metaJson = Buffer.from(JSON.stringify(e.meta), 'utf8')
    const ml = Buffer.alloc(4)
    ml.writeInt32BE(metaJson.length)
    containerParts.push(ml, metaJson)
    const pl = Buffer.alloc(8)
    pl.writeBigUInt64BE(BigInt(e.payload?.length ?? 0))
    containerParts.push(pl, e.payload ?? Buffer.alloc(0))
  }
  const term = Buffer.alloc(4)
  term.writeInt32BE(-1)
  containerParts.push(term)
  const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf8')
  const ml = Buffer.alloc(4)
  ml.writeUint32BE(manifestJson.length)
  containerParts.push(ml, manifestJson)
  const body = Buffer.concat(containerParts)
  const container = Buffer.concat([body, createHash('sha256').update(body).digest()])

  // --- outer tar ---
  const readme = Buffer.from('synthetic v5 fixture\n', 'utf8')
  const tarParts = []
  tarAppend(tarParts, 'portable.dshbak', container, options)
  tarAppend(tarParts, 'README.txt', readme, options)
  tarParts.push(Buffer.alloc(TAR_BLOCK))
  if (!options.singleZeroBlock) tarParts.push(Buffer.alloc(TAR_BLOCK))
  let tar = Buffer.concat(tarParts)
  if (options.truncateBytes) tar = tar.subarray(0, tar.length - options.truncateBytes)
  return zlib.gzipSync(tar, { level: 1 })
}

export function fileEntry(root, path, payload, scope = 'plugins', metaOverride = {}) {
  return {
    meta: { root, path, kind: 'FILE', scope, size: payload.length, sha256: createHash('sha256').update(payload).digest('hex'), mode: 384, ...metaOverride },
    payload,
  }
}

/** A declared-but-missing slot (non-FILE record: size 0, empty digest). */
export function missingEntry(root, path, scope = 'plugins') {
  return {
    meta: { root, path, kind: 'MISSING', scope, size: 0, sha256: '' },
    payload: Buffer.alloc(0),
  }
}
