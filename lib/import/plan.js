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
    counts: report.counts ?? {},
  }
  plan.digest = digestOf(plan)
  return plan
}

/** Persist the plan atomically (0600) and return its path. */
export function freezePlan(file, plan) {
  if (digestOf(plan) !== plan.digest) throw coded('PLAN_INVALID', 'plan content does not match its digest')
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
  const declaredNow = (currentReport.childEvidence?.declared ?? []).length
  const declaredBefore = (plan.childEvidence?.declared ?? []).length
  if (declaredNow !== declaredBefore) reasons.push('child evidence changed since the preview')
  return { ok: reasons.length === 0, reasons }
}
