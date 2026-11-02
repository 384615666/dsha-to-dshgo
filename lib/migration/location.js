// Official location binding (F4): the authoritative session directory for a
// header comes from the official JSONL persistence backend's OWN locate() —
// projectKey/encodeSegment semantics are never reimplemented here, because
// copied private helpers drift silently from the target's real encoding.
//
// The adapter is injected (setLocationAdapter) by the entry that has the
// backend available (dev CLI: the rc.4 jsonl plugin mounted on an isolated
// throwaway root; the host: its own session backend). When no adapter is
// available the binding is reported as UNVERIFIED and the session is NOT
// admitted as importable — importable must imply full verification.
//
// locate() only computes paths; it never touches the filesystem.

let locateFn = null

export async function setLocationAdapter(fn) {
  locateFn = typeof fn === 'function' ? fn : null
}

export function locationAvailable() {
  return typeof locateFn === 'function'
}

/**
 * The official session directory for a header, '/'-separated, relative to
 * the sessions root (e.g. '--w--/my-session'), or null when no adapter is
 * available.
 */
export function officialSessionDirectory(header) {
  if (typeof locateFn !== 'function') return null
  const dir = locateFn(header)
  if (typeof dir !== 'string' || dir.length === 0) return null
  return dir.split('\\').join('/')
}
