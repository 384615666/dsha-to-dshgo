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

/**
 * Walk exactly ONE frame starting at `off`. Returns `{ frame, next }` where
 * `frame` is the subarray and `next` the offset after it — or `null` at end
 * of buffer. Kept separate from decoding so the budgeted decompressor can
 * interleave walk/decode: when the budget stops the run, later frames are
 * never even walked, let alone decoded.
 */
function nextFrame(buf, off) {
  if (off >= buf.length) return null
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
    return { frame: buf.subarray(off, end), next: end }
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
  return { frame: buf.subarray(start, off), next: off }
}

/** Walk every frame (full structural validation of the whole buffer). */
export function splitZstdFrames(buf) {
  const frames = []
  let off = 0
  for (;;) {
    const step = nextFrame(buf, off)
    if (!step) return frames
    frames.push(step.frame)
    off = step.next
  }
}

/**
 * Decompress every frame and concatenate the regenerated content.
 *
 * maxBytes (optional) is enforced DURING decoding as a per-frame NATIVE
 * output limit AND a cumulative limit: the remaining budget is passed to the
 * decoder as maxOutputLength, so an oversized frame is rejected by the
 * decoder itself BEFORE its full output is allocated (ERR_BUFFER_TOO_LARGE —
 * never allocate-then-refuse); the run also stops at the first frame that
 * crosses the cumulative budget, and frames after the limit are neither
 * walked nor decoded.
 */
export function decompressZstdMultiFrame(buf, { maxBytes } = {}) {
  const parts = []
  let total = 0
  let off = 0
  // Stable code for every budget refusal (parse layer errors must classify,
  // not just describe): same code as the plaintext/row budgets in
  // inspect-sessions, so the report's error.code is consistent end to end.
  const budgetError = message => {
    const e = new Error(message)
    e.code = 'SESSION_BUDGET'
    return e
  }
  for (;;) {
    const step = nextFrame(buf, off)
    if (!step) break
    if (maxBytes != null && total >= maxBytes) {
      throw budgetError(`decompressed output over budget ${maxBytes} B at frame ${parts.length + 1} — remaining frames not decoded`)
    }
    const remaining = maxBytes != null ? maxBytes - total : null
    let out
    try {
      out = zlib.zstdDecompressSync(step.frame, remaining != null ? { maxOutputLength: remaining } : undefined)
    } catch (error) {
      if (error && (error.code === 'ERR_BUFFER_TOO_LARGE' || /ERR_BUFFER_TOO_LARGE/.test(error.message ?? ''))) {
        throw budgetError(`decompressed output over budget ${maxBytes} B at frame ${parts.length + 1} — native output limit applied before allocation; remaining frames not decoded`)
      }
      throw error
    }
    if (!out || out.length === 0) throw new Error('empty frame decompression')
    total += out.length
    parts.push(out)
    off = step.next
  }
  return Buffer.concat(parts)
}
