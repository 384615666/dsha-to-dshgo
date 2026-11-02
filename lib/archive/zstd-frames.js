// Structural zstd multi-frame splitter for staged session logs.
//
// DSHA v5 session logs are CONCATENATED zstd frames (each flush = one frame;
// the first frame carries the single-line session header). Node's
// zstdDecompressSync handles exactly one frame and silently ignores trailing
// frames, so a naive single call would silently drop everything after the
// first frame. Frames are advanced by parsing the frame header descriptor and
// block lengths — the official reader's approach (dsh-session-persistence-jsonl
// "scan frame descriptors and block lengths") — never by scanning for magic
// bytes (compressed payloads can contain the same bytes).
//
// Block size semantics (verified against the official decoder as oracle):
// RLE blocks (type 1) store exactly ONE physical byte repeated `size` times;
// compressed (0) and raw (2) blocks store `size` bytes verbatim.

import zlib from 'node:zlib'

const MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f

export function splitZstdFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error(`trailing ${buf.length - off} bytes after last frame`)
    const magic = buf.readUInt32LE(off)
    if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
      if (off + 8 > buf.length) throw new Error('skippable frame truncated')
      const size = buf.readUInt32LE(off + 4)
      const end = off + 8 + size
      // The declared payload MUST be present: a header claiming N bytes with
      // the buffer ending early is a truncated tail, not a skippable frame —
      // skipping past EOF used to accept amputated sessions silently.
      if (end > buf.length) {
        throw new Error(`skippable frame payload overruns buffer (declared ${size} B, ${buf.length - off - 8} B present)`)
      }
      off = end
      continue
    }
    if (magic !== MAGIC) throw new Error(`bad zstd magic 0x${magic.toString(16)} at ${off}`)
    const start = off
    off += 4
    const fhd = buf[off]; off += 1
    const fcsFlag = (fhd >> 6) & 0b11
    const singleSegment = (fhd >> 5) & 1
    const checksum = (fhd >> 2) & 1
    const dictIdFlag = fhd & 0b11
    if (!singleSegment) off += 1 // window descriptor
    off += [0, 1, 2, 4][dictIdFlag]
    off += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]
    if (off > buf.length) throw new Error('frame header truncated')
    for (;;) {
      if (off + 3 > buf.length) throw new Error('block header truncated')
      const bh = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
      const last = bh & 1
      const type = (bh >> 1) & 0b11
      const size = bh >> 3
      off += 3
      if (type === 3) throw new Error('reserved block type 3')
      off += type === 1 ? 1 : size
      if (off > buf.length) throw new Error('block payload truncated')
      if (last) break
    }
    if (checksum) off += 4
    if (off > buf.length) throw new Error('frame overruns buffer')
    frames.push(buf.subarray(start, off))
  }
  return frames
}

/** Decompress every frame and concatenate the regenerated content. */
export function decompressZstdMultiFrame(buf) {
  return Buffer.concat(splitZstdFrames(buf).map(frame => {
    const out = zlib.zstdDecompressSync(frame)
    if (!out || out.length === 0) throw new Error('empty frame decompression')
    return out
  }))
}
