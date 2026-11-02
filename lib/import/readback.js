// Semantic read-back comparison for imported sessions (plan §7.4 A-path):
// a successful append proves nothing about compaction/fork/seeded recovery
// or Agent writability — the imported session must be opened read and
// compared SEMANTICALLY against the verified candidate: complete header
// (every key, after applied mappings) and every event (seq, type, time,
// data, surfaceOp, references, extensions), plus the inherited cut.
// Key order is irrelevant; values compare structurally.

function deepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a !== 'object') return a === b
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
}

/**
 * Compare a read-back session against the verified candidate.
 * @param {object} candidate - { header, events, inheritedEventCount }
 * @param {object} readback - { header, events, inheritedEventCount }
 * @returns {{ ok: boolean, headerMatch: boolean, eventsMatch: boolean,
 *   inheritedVerifiable: boolean, inheritedMatch: boolean|null,
 *   seedMarkerPresent: boolean, firstHeaderDiff: string|null, firstEventDiff: string|null,
 *   eventCount: number }}
 *
 * The rc.4 public read surface does NOT expose the inherited event count
 * (read.header/stat drop the physical header's inherited field); when the
 * read-back cannot provide it, `inheritedVerifiable` is false and the count
 * is verified instead through the create-time handle echo plus the
 * session/end-seed marker (see writer-a).
 */
export function compareReadback(candidate, readback) {
  const headerMatch = deepEqual(candidate.header, readback.header)
  const eventsMatch = deepEqual(candidate.events, readback.events)
  const candInherited = candidate.inheritedEventCount ?? 0
  const readInherited = readback.inheritedEventCount
  const inheritedVerifiable = typeof readInherited === 'number'
  const inheritedMatch = inheritedVerifiable ? (candInherited === readInherited) : null
  // Marker rule (official catalog semantics): a seeded session's LAST
  // inherited end-seed marker marks the accepted cut, so its seq must equal
  // the candidate cut; an unseeded session must contain no marker. "A marker
  // somewhere" is not enough — the review's fixture had a marker at seq 0
  // (the true cut 0) while claiming 7.
  const seeded = candidate.header?.isSeeded === true
  const markerSeqs = Array.isArray(readback.events)
    ? readback.events.filter(x => x?.type === 'session/end-seed' && x?.data?.inherited === true).map(x => x.seq)
    : []
  const seedMarkerPresent = markerSeqs.length > 0
  const lastMarkerSeq = markerSeqs.length ? markerSeqs[markerSeqs.length - 1] : null
  const seedMarkerOk = seeded
    ? (lastMarkerSeq != null && lastMarkerSeq === candInherited)
    : (markerSeqs.length === 0)
  const ok = headerMatch && eventsMatch && seedMarkerOk && (!inheritedVerifiable || inheritedMatch)
  const firstHeaderDiff = headerMatch ? null : firstDiffPath(candidate.header, readback.header, 'header')
  const firstEventDiff = eventsMatch ? null : firstDiffPath(candidate.events, readback.events, 'events')
  return {
    ok,
    headerMatch,
    eventsMatch,
    inheritedVerifiable,
    inheritedMatch,
    seedMarkerPresent,
    seedMarkerOk,
    lastMarkerSeq,
    firstHeaderDiff,
    firstEventDiff,
    eventCount: Array.isArray(readback.events) ? readback.events.length : -1,
  }
}

// First differing path for diagnostics — STRUCTURAL paths only (indices and
// keys), never values: a diff message must not carry chat content into a
// report.
function firstDiffPath(a, b, prefix) {
  if (deepEqual(a, b)) return null
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${prefix}.length ${a.length}!=${b.length}`
    for (let i = 0; i < a.length; i++) {
      const sub = firstDiffPath(a[i], b[i], `${prefix}[${i}]`)
      if (sub) return sub
    }
    return prefix
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = new Set(Object.keys(a))
    const kb = new Set(Object.keys(b))
    for (const k of ka) if (!kb.has(k)) return `${prefix}.${k}: missing in readback`
    for (const k of kb) if (!ka.has(k)) return `${prefix}.${k}: unexpected in readback`
    for (const k of ka) {
      const sub = firstDiffPath(a[k], b[k], `${prefix}.${k}`)
      if (sub) return sub
    }
    return prefix
  }
  return `${prefix}: values differ`
}
