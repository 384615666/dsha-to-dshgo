// F8: the PUBLIC error report publishes a CLOSED SET of codes.
//
// Character format alone is NOT a safety property: a runtime credential made
// of uppercase hex (e.g. DEADBEEF0123456789ABCDEF) satisfies any
// "uppercase / digit / underscore" regex, yet it is exactly the kind of
// value that must never reach a public report. Therefore only these exact
// constants — all of them fixed text from this package's own coded() errors —
// may pass through; every unknown value maps to the generic fallback.
//
// Adding a new public code is a deliberate edit to this list (a fixed string
// cannot smuggle data). Codes from lower layers / foreign exceptions are
// intentionally absent.

export const PUBLIC_ERROR_CODES = Object.freeze([
  // job orchestration
  'IMPORT_APPEND_FAILED',
  'IMPORT_CANDIDATE_INVALID',
  'IMPORT_CAPABILITY_MISSING',
  'IMPORT_CREATE_REFUSED',
  'IMPORT_ID_CONFLICT',
  'IMPORT_JOB_LOCKED',
  'IMPORT_LOCK_BUSY',
  'IMPORT_LOCK_INVALID',
  'IMPORT_PLAN_BINDING',
  'IMPORT_PLAN_MISSING',
  'IMPORT_READBACK_MISMATCH',
  'IMPORT_STATE_UNSUPPORTED',
  'IMPORT_TARGET_INVALID',
  'IMPORT_WORKSPACE_DUPLICATE',
  // plan
  'PLAN_CORRUPT',
  'PLAN_EXPIRED',
  'PLAN_INVALID',
  'PLAN_MISSING',
  'PLAN_VERSION_CONFLICT',
  // journal
  'JOURNAL_ALREADY_EXISTS',
  'JOURNAL_BINDING_MISMATCH',
  'JOURNAL_DURABILITY_UNKNOWN',
  'JOURNAL_MALFORMED',
  'JOURNAL_PLAN_BINDING',
  'JOURNAL_PLAN_INVALID',
  'JOURNAL_PLAN_MISMATCH',
  'JOURNAL_RECOVERY_REQUIRED',
  // G6 snapshot / workspace recovery
  'G6_SNAPSHOT_CORRUPT',
  'G6_SNAPSHOT_INVALID',
  'G6_SNAPSHOT_MISSING',
  'G6_SNAPSHOT_PENDING',
  'G6_SNAPSHOT_UNSUPPORTED',
  'WORKSPACE_RECOVERY_INVALID',
  // attachments
  'ATTACHMENT_IO',
  'ATTACHMENT_PATH_UNSAFE',
  'ATTACHMENT_READBACK_MISMATCH',
  'ATTACHMENT_REF_INVALID',
  'ATTACHMENT_REF_MISMATCH',
  'ATTACHMENT_SOURCE_MISMATCH',
  'ATTACHMENT_UNSUPPORTED',
  'SESSION_BLOCKED_ATTACHMENT',
  // source log inspection
  'SESSION_BINARY',
  'SESSION_BUDGET',
  'SESSION_EMPTY',
  'SESSION_HEADER_MALFORMED',
  'SESSION_NOT_UTF8',
  'SESSION_ROW_MALFORMED',
  'SESSION_STAGING_MISSING',
  // legacy chain / location binding
  'LEGACY_CHILD_EVIDENCE_INCOMPLETE',
  'LEGACY_CHRONOLOGY_UNREACHABLE',
  'LEGACY_DUPLICATE_SESSION_ID',
  'LEGACY_GENERATION_MISMATCH',
  'LEGACY_GENERATION_UNAVAILABLE',
  'LEGACY_HEADER_UNSUPPORTED',
  'LEGACY_LOCATION_MISMATCH',
  'LEGACY_ROUNDTRIP_MISMATCH',
  'LEGACY_ROW_DECODE_FAILED',
  // protected withdrawal
  'WITHDRAW_NOT_SAFE',
  'WITHDRAW_UNSAFE_PATH',
  // B-path writer (same fixed constants; used by the experiment entry)
  'B_APPEND_MISMATCH',
  'B_CANDIDATE_INVALID',
  'B_ID_CONFLICT',
  'B_IO',
  'B_PATH_UNSAFE',
  'B_READBACK_MISMATCH',
  'B_UNAVAILABLE_LOCATE',
  'B_UNSUPPORTED',
])

const PUBLIC_CODE_SET = new Set(PUBLIC_ERROR_CODES)

/**
 * Classify an error code for the PUBLIC report.
 * Unknown / lower-layer / marker-carrying codes publish only the fallback.
 * @param {unknown} error
 * @param {string} fallback - one of the fixed *_FAILURE category constants.
 */
export function publicErrorCode(error, fallback = 'RUNTIME_FAILURE') {
  const raw = error?.code
  return typeof raw === 'string' && PUBLIC_CODE_SET.has(raw) ? raw : fallback
}
