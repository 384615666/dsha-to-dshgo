// Immutable import plan (plan §7.1 step 4): the preview artifact the user
// confirms. It is built from a completed read-only inspection, carries the
// source digest, the target instance fingerprint, the path/preset mapping and
// the selected session groups, and is persisted atomically with a content
// digest. Re-validation before writing is mandatory: if the source backup,
// the target identity or the conflict set changed, the preview is STALE and
// the job must re-plan — never write from a stale preview.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

function digestOf(plan) {
  const { digest, ...content } = plan
  void digest
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

/**
 * Recompute the content digest of a plan object, IGNORING its `digest`
 * field. Callers must never trust a stored digest without this check: a plan
 * object with altered content can still carry an old digest string.
 */
export function planContentDigest(plan) {
  return digestOf(plan)
}

/**
 * Full self-validation of a plan OBJECT in memory: content must produce the
 * digest it claims, and the source/target binding must be present.
 */
export function validatePlanContent(plan) {
  if (!plan || typeof plan !== 'object') throw coded('PLAN_INVALID', 'plan must be an object')
  const actual = digestOf(plan)
  if (!plan.digest || actual !== plan.digest) {
    throw coded('PLAN_CORRUPT', 'plan content does not match its digest (content changed or digest missing)')
  }
  if (!plan.sourceDigest || !plan.target?.instanceFingerprint) {
    throw coded('PLAN_INVALID', 'plan is missing its source/target binding')
  }
  return { digest: actual }
}

const sortKey = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))

/**
 * Canonical, order-insensitive evidence signature for the parts of an
 * inspection that affect the official recovery result: parent/child
 * identities, bound vs unavailable-fact mode, missing canonical slots, and
 * ambiguous/unavailable generations. Counts alone are NOT a content proof —
 * swapping child identities or degrading a fact keeps the count identical.
 */
function evidenceSignature(report) {
  const canonical = {
    declared: [...(report.childEvidence?.declared ?? [])]
      .map(d => ({ parent: d.parent ?? null, child: d.child ?? null, mode: d.mode ?? null, sourceDirectory: d.sourceDirectory ?? null }))
      .sort(sortKey),
    unmatchedFacts: [...(report.childEvidence?.unmatchedFacts ?? [])]
      .map(u => ({ child: u.child ?? null, parent: u.parent ?? null }))
      .sort(sortKey),
    declaredMissing: [...(report.childEvidence?.declaredMissing ?? [])]
      .map(m => ({ path: m.path ?? null, kind: m.kind ?? null }))
      .sort(sortKey),
    ambiguous: [...(report.ambiguous ?? [])]
      .map(a => ({ relDir: a.relDir ?? null, generation: a.generation ?? null, candidates: [...(a.candidates ?? [])].sort() }))
      .sort(sortKey),
    unavailableDirs: [...(report.unavailableDirs ?? [])]
      .map(u => ({ relDir: u.relDir ?? null, generation: u.generation ?? null, kinds: [...(u.kinds ?? [])].sort() }))
      .sort(sortKey),
  }
  return { canonical, digest: createHash('sha256').update(JSON.stringify(canonical)).digest('hex') }
}

/**
 * Apply the approved plan's cwd mapping to one write header.
 * Message text is never rewritten: only the header's cwd is a mapped
 * location; the plan binds the mapping (its digest covers cwdMapping).
 * Unmapped/unusable values keep the source cwd unchanged.
 */
export function applyCwdMapping(header, cwdMapping = {}) {
  if (!header || typeof header !== 'object' || cwdMapping == null || typeof cwdMapping !== 'object') return header
  const target = cwdMapping[header.cwd]
  if (typeof target !== 'string' || target === '') return header
  return { ...header, cwd: target }
}

/**
 * Build a plan from an inspect report.
 * @param {object} params
 * @param {string} params.sourceDigest - digest of the backup FILE bytes.
 * @param {string} params.instanceFingerprint - target instance identity.
 * @param {object} params.report - inspectSessions() result (sanitized).
 * @param {string[]} [params.selectedIds] - sessions the user selected;
 *   defaults to every importable session.
 * @param {object[]} [params.excluded] - [{ id, reason }] explicit exclusions.
 * @param {object} [params.cwdMapping] - { sourceCwd: targetCwd } (applied to
 *   the output header only; message text is never rewritten).
 * @returns {object} the plan with its digest.
 */
export function buildPlan({ sourceDigest, instanceFingerprint, report, selectedIds, excluded = [], cwdMapping = {} }) {
  if (!sourceDigest || !instanceFingerprint) throw coded('PLAN_INVALID', 'plan needs a source digest and a target instance fingerprint')
  const importable = (report.sessions ?? []).filter(s => s.importable === true)
  const selected = selectedIds ?? importable.map(s => s.id)
  const importableIds = new Set(importable.map(s => s.id))
  for (const id of selected) {
    if (!importableIds.has(id)) throw coded('PLAN_INVALID', `selected session ${id} is not importable in this inspection`)
  }
  const excludedIds = new Set()
  for (const e of excluded) {
    if (!e?.id || !e?.reason) throw coded('PLAN_INVALID', 'every exclusion needs an id and a reason')
    if (selected.includes(e.id)) throw coded('PLAN_INVALID', `session ${e.id} is both selected and excluded`)
    excludedIds.add(e.id)
  }
  const plan = {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceDigest,
    target: { instanceFingerprint },
    // Sanitized per-session preview (no chat content, no private paths).
    sessions: (report.sessions ?? []).map(s => ({
      id: s.id,
      sourceGeneration: s.sourceGeneration ?? null,
      headerVersion: s.headerVersion ?? null,
      status: s.status,
      importable: s.importable === true,
      code: s.code ?? null,
      locationVerified: s.locationVerified ?? null,
      selected: selected.includes(s.id),
      excluded: excludedIds.has(s.id) ? (excluded.find(e => e.id === s.id)?.reason ?? null) : null,
    })),
    selected,
    excluded,
    cwdMapping,
    conflicts: (report.ambiguous ?? []).map(a => ({ relDir: a.relDir, generation: a.generation, kind: 'ambiguous-generation' })),
    unavailableDirs: report.unavailableDirs ?? [],
    childEvidence: report.childEvidence ?? { declared: [], unmatchedFacts: [], declaredMissing: [] },
    // Content proof for the freshness check (never chat payloads).
    evidence: evidenceSignature(report),
    counts: report.counts ?? {},
  }
  plan.digest = digestOf(plan)
  return plan
}

/**
 * Persist the plan atomically (0600) and return its path.
 *
 * Frozen plans are immutable VERSIONS: an existing file with the same digest
 * is an idempotent rewrite; replacing a DIFFERENT frozen version requires the
 * caller to name the exact digest it is superseding (`supersedes`). A silent
 * re-plan over a confirmed version is refused (PLAN_VERSION_CONFLICT).
 */
export function freezePlan(file, plan, { supersedes } = {}) {
  if (digestOf(plan) !== plan.digest) throw coded('PLAN_INVALID', 'plan content does not match its digest')
  if (existsSync(file)) {
    let existing = null
    try { existing = JSON.parse(readFileSync(file, 'utf8')) } catch { existing = null }
    const existingDigest = existing?.digest ?? null
    if (existingDigest && existingDigest !== plan.digest && supersedes !== existingDigest) {
      throw coded('PLAN_VERSION_CONFLICT', 'a different frozen plan already exists — name its digest with supersedes to re-plan explicitly', { existingDigest })
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(plan, null, 1))
    try { fs.fsyncSync(fd) } catch (error) { if (error?.code !== 'ENOSYS') throw error }
    closeSync(fd)
    renameSync(tmp, file)
  } catch (error) {
    try { closeSync(fd) } catch { /* closed */ }
    throw error
  }
  return { file, digest: plan.digest }
}

/**
 * Load and validate a frozen plan against the CURRENT source/target identity.
 * Throws PLAN_CORRUPT (content/digest mismatch), PLAN_EXPIRED (different
 * source backup or target instance). A stale preview must be re-planned.
 */
export function loadPlan(file, { sourceDigest, instanceFingerprint }) {
  if (!existsSync(file)) throw coded('PLAN_MISSING', 'no frozen plan exists for this job')
  let plan
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw coded('PLAN_CORRUPT', 'the frozen plan is not valid JSON')
  }
  if (!plan?.digest || digestOf(plan) !== plan.digest) throw coded('PLAN_CORRUPT', 'the frozen plan does not match its digest')
  if (plan.sourceDigest !== sourceDigest) throw coded('PLAN_EXPIRED', 'the source backup changed since this preview — re-plan before writing')
  if (plan.target?.instanceFingerprint !== instanceFingerprint) throw coded('PLAN_EXPIRED', 'the target instance changed since this preview — re-plan before writing')
  return plan
}

/**
 * Re-validate a loaded plan against the CURRENT inspection: any new conflict
 * (ambiguity, unavailable highest generation, missing child evidence for a
 * selected session) makes the preview stale.
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function verifyPlanFresh(plan, currentReport) {
  const reasons = []
  const nowAmbiguous = (currentReport.ambiguous ?? []).map(a => a.relDir)
  const wasAmbiguous = new Set((plan.conflicts ?? []).map(c => c.relDir))
  for (const relDir of nowAmbiguous) {
    if (!wasAmbiguous.has(relDir)) reasons.push(`new ambiguity in ${relDir}`)
  }
  const nowUnavailable = (currentReport.unavailableDirs ?? []).map(u => u.relDir)
  const wasUnavailable = new Set((plan.unavailableDirs ?? []).map(u => u.relDir))
  for (const relDir of nowUnavailable) {
    if (!wasUnavailable.has(relDir)) reasons.push(`newly unavailable highest generation in ${relDir}`)
  }
  const importableNow = new Set((currentReport.sessions ?? []).filter(s => s.importable === true).map(s => s.id))
  for (const id of plan.selected ?? []) {
    if (!importableNow.has(id)) reasons.push(`selected session ${id} is no longer importable`)
  }
  // CONTENT proof, not a count: identical counts with different identities,
  // bound/unavailable mode changes, or new missing slots all invalidate the
  // preview (they change what the official chain will produce).
  const now = evidenceSignature(currentReport)
  const was = plan.evidence?.digest ?? null
  if (was !== now.digest) {
    const before = plan.evidence?.canonical ?? {}
    const reasonsForArray = (label, a = [], b = []) => {
      const sa = new Set(a.map(x => JSON.stringify(x)))
      const sb = new Set(b.map(x => JSON.stringify(x)))
      for (const x of sb) if (!sa.has(x)) reasons.push(`${label} changed: ${x}`)
      for (const x of sa) if (!sb.has(x)) reasons.push(`${label} removed: ${x}`)
    }
    reasonsForArray('child evidence', before.declared, now.canonical.declared)
    reasonsForArray('unmatched child fact', before.unmatchedFacts, now.canonical.unmatchedFacts)
    reasonsForArray('declared missing slot', before.declaredMissing, now.canonical.declaredMissing)
    reasonsForArray('ambiguous generation', before.ambiguous, now.canonical.ambiguous)
    reasonsForArray('unavailable directory', before.unavailableDirs, now.canonical.unavailableDirs)
    if (reasons.length === 0) reasons.push('inspection evidence changed since the preview')
  }
  return { ok: reasons.length === 0, reasons }
}
