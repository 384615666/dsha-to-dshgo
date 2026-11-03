// Product migration controller: ONE flow from a real backup file to the
// unified A-path job, shared by the native panel and the desktop harness.
//
//   backup → private source (inspect kernel + attachments)
//   → preview/selection/preset+cwd mapping → frozen approved plan
//   → runImportJob(A) with real host services → terminal report / recovery
//
// Private artifacts (events, staging paths) never enter the public snapshot;
// the snapshot is UI state only. Staging and the picked input copy are
// removed on terminal states; the journal + content-addressed snapshot remain
// as the recovery point.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { loadBackupSource } from './source.js'
import { collectAttachmentDependencies } from './attachments.js'
import { buildPlan, freezePlan, loadPlan } from './plan.js'
import { resolvePresetMapping, applyPresetMapping } from './preset.js'
import { ImportJournal } from './journal.js'
import { runImportJob } from './job.js'
import { createWorkspaceUnitProvider } from './workspace-unit.js'
import { createJsonlWithdrawalAdapter } from './withdraw.js'
import { setLocationAdapter } from '../migration/location.js'
import { peekJobLock, peekGuard, breakStaleLock, clearStaleGuard } from './lock.js'
import { listBackupCandidates, stageBackupFile, commitStagedFile, MAX_BACKUP_BYTES } from './input.js'

const sha256 = value => createHash('sha256').update(value).digest('hex')

function safeName(name) {
  return String(name || 'backup').replace(/[^\w.-]+/g, '_').slice(-80) || 'backup'
}

function firstUserTitle(events, fallback) {
  for (const event of events ?? []) {
    if (event?.type !== 'user/message') continue
    const parts = Array.isArray(event.data?.content) ? event.data.content : []
    const text = parts.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join(' ').replace(/\s+/g, ' ').trim()
    if (text) return text.length > 48 ? `${text.slice(0, 48)}…` : text
  }
  return fallback
}

export function instanceLockDirFor(dataRoot) {
  return join(dataRoot, 'instance-lock')
}

/**
 * Internal recovery identity view: the approved plan's selected set is the
 * authority (a fresh controller has no in-memory plan), plus any open-intent
 * session id. Public summaries may omit ids; this view must not.
 */
export function recoveryCandidateIds(plan, recovery) {
  const ids = new Set(plan?.selected ?? [])
  for (const intent of recovery?.openIntents ?? []) {
    if (intent?.sessionId) ids.add(intent.sessionId)
  }
  return ids
}

export function createMigrationController({ onUpdate } = {}) {
  const listeners = new Set()
  const state = {
    phase: 'idle',
    error: null,
    report: null,
    preview: [],
    selected: new Set(),
    page: 0,
    plan: null,
    planDigest: null,
    mappedCandidates: null,
    result: null,
    recovery: null,
    existing: [],
    sourceDigest: null,
    jobDir: null,
    progress: null,
    notice: null,
    services: null,
    instanceFingerprint: null,
    dataRoot: null,
    workspaceRoot: null,
    targetCwd: null,
    workspaceTitle: null,
    source: null,
    abort: null,
    inspecting: false,
    large: { root: null, entries: [], error: null },
    largeBusyIndex: null,
  }

  const STALE_LOCK_MS = (() => {
    const n = Number(process.env.DSHA_MIGRATOR_STALE_LOCK_MS ?? 30000)
    return Number.isFinite(n) && n >= 0 ? n : 30000
  })()

  function emit() {
    const snap = snapshot()
    for (const fn of listeners) {
      try { fn(snap) } catch { /* a listener must not break the job */ }
    }
    try { onUpdate?.(snap) } catch { /* optional host hook */ }
  }

  function setPhase(phase, extra = {}) {
    state.phase = phase
    Object.assign(state, extra)
    emit()
  }

  function snapshot() {
    const importable = state.preview.filter(s => s.importable)
    return {
      phase: state.phase,
      error: state.error,
      notice: state.notice,
      counts: state.report?.counts ?? null,
      childEvidence: state.report?.childEvidence ?? null,
      dependencyIsolation: state.report?.dependencyIsolation ?? [],
      archive: state.report ? {
        integrity: state.report.archive?.manifest?.integrity ?? null,
        entries: state.report.archive?.manifest?.entries ?? null,
        bytes: state.report.archive?.manifest?.bytes ?? null,
        formatVersion: state.report.archive?.manifest?.formatVersion ?? null,
      } : null,
      sessions: state.preview.map(s => ({ ...s, selected: state.selected.has(s.id) })),
      refused: state.report
        ? [
            ...(state.report.sessions ?? []).filter(s => s.importable !== true).map(s => ({
              status: s.status ?? null,
              code: s.code ?? null,
              reason: s.reason ?? null,
              directory: s.directory ?? null,
              generation: s.sourceGeneration ?? null,
              lowerGenerationsPresent: Array.isArray(s.lowerGenerationsPresent) ? s.lowerGenerationsPresent.length : 0,
            })),
            ...state.preview.filter(s => !s.importable).map(s => ({
              status: 'blocked',
              code: s.blockReason ?? null,
              generation: s.sourceGeneration ?? null,
              title: s.title,
            })),
          ]
        : [],
      locationAdmission: state.report?.locationAdmission ?? null,
      page: state.page,
      pageCount: Math.max(1, Math.ceil(importable.length / 8)),
      selectedCount: state.selected.size,
      importableCount: importable.length,
      targetWorkspace: state.targetCwd ? { title: state.workspaceTitle } : null,
      planDigest: state.planDigest,
      canApprove: canApprove(),
      canStart: state.phase === 'approved' && Boolean(state.plan) && blockedReasons().length === 0,
      blockedReasons: blockedReasons(),
      result: state.result ? {
        status: state.result.status,
        attachments: state.result.attachments ?? null,
        verificationOk: state.result.verification?.ok ?? null,
        rollback: state.result.rollback ? {
          outcome: state.result.rollback.outcome,
          actionOutcome: state.result.rollback.actionOutcome,
          workspaceOutcome: state.result.rollback.workspaceOutcome,
          finalOk: state.result.rollback.finalVerification?.ok ?? null,
          failures: state.result.rollback.failures ?? 0,
        } : null,
        errorCode: state.result.error?.code ?? null,
        journalState: state.result.journal?.batchState ?? null,
      } : null,
      recovery: state.recovery ? {
        batchState: state.recovery.batchState,
        openIntents: state.recovery.openIntents?.length ?? 0,
        snapshotDigest: state.recovery.snapshotDigest ?? null,
      } : null,
      existing: state.existing.map(e => ({ id: e.id, classification: e.classification })),
      progress: state.progress,
      sourceDigest: state.sourceDigest ? state.sourceDigest.slice(0, 16) : null,
      busy: state.phase === 'staging' || state.phase === 'inspecting' || state.phase === 'running',
      large: {
        root: state.large?.root ?? null,
        entries: (state.large?.entries ?? []).map((entry, index) => ({
          index,
          name: entry.name,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
        })),
        error: state.large?.error ?? null,
        busyIndex: state.largeBusyIndex,
      },
      lock: lockSnapshot(),
      warnings: state.result?.warnings ?? [],
      canPurge: ['done', 'already_done', 'target_modified', 'cancelled', 'failed'].includes(state.phase) && Boolean(state.jobDir),
    }
  }

  function lockSnapshot() {
    if (!state.instanceLockDir) return { held: false, guardHeld: false, canBreak: false, ageMs: null, guardAgeMs: null }
    let lock = { held: false }
    let guard = { held: false }
    try { lock = peekJobLock(state.instanceLockDir) } catch { /* inspection must not break the panel */ }
    try { guard = peekGuard(state.instanceLockDir) } catch { /* inspection must not break the panel */ }
    const ageMs = lock.ageMs ?? null
    const guardAgeMs = guard.ageMs ?? null
    return {
      held: Boolean(lock.held),
      ageMs,
      guardHeld: Boolean(guard.held),
      guardAgeMs,
      canBreak: Boolean(lock.held && (ageMs == null || ageMs >= STALE_LOCK_MS))
        || Boolean(!lock.held && guard.held && guardAgeMs != null && guardAgeMs >= STALE_LOCK_MS),
    }
  }

  function requireServices() {
    if (!state.services) throw new Error('migration services are not available yet')
    return state.services
  }

  function persistHome() {
    const persistence = requireServices().sessionPersistence
    return dirname(persistence.root)
  }

  function buildAdapter() {
    const services = requireServices()
    const persistence = services.sessionPersistence
    const attachments = services.attachments
    const home = persistHome()
    const storageRoot = process.env.DSHA_MIGRATOR_STORAGE_ROOT || join(home, 'storages')
    const attachmentRoot = attachments?.root
      || process.env.DSHA_MIGRATOR_ATTACHMENT_ROOT
      || join(home, 'attachments', 'v1')
    const locateDir = header => {
      const located = persistence.locate({ cwd: header.cwd, id: header.id })
      return relative(persistence.root, located.path).split(sep).slice(0, -1).join('/')
    }
    const target = {
      persistence,
      workspaceRegistry: services.workspaceRegistry,
      attachments,
      attachmentRoot,
      workspaceUnitProvider: createWorkspaceUnitProvider({ storageRoot }),
    }
    const withdrawSession = createJsonlWithdrawalAdapter({
      persistence,
      sessionsRoot: persistence.root,
      locateDir,
      quarantineRoot: join(state.jobDir, 'quarantine'),
    })
    const attachmentExists = object => {
      try {
        if (!attachments) return false
        if (object.kind === 'image' && typeof attachments.imageHostPath === 'function') {
          return existsSync(attachments.imageHostPath(object.ref))
        }
        if (object.kind === 'file' && typeof attachments.fileHostPath === 'function') {
          return existsSync(attachments.fileHostPath(object.ref))
        }
      } catch { /* unreadable target object is treated as absent */ }
      return false
    }
    return { target, withdrawSession, attachmentExists }
  }

  function jobDirFor(digest) {
    return join(state.dataRoot, 'jobs', digest.slice(0, 16))
  }

  async function readPresetEnvironment() {
    const svc = requireServices().agentPresets
    if (!svc || typeof svc.list !== 'function') {
      return { available: null, defaultPreset: null, error: 'preset-service-unavailable' }
    }
    try {
      const list = await svc.list()
      const ids = (Array.isArray(list) ? list : []).map(p => p?.id).filter(id => typeof id === 'string' && id !== '')
      const defaultPreset = typeof svc.defaultId === 'string' && svc.defaultId !== ''
        ? svc.defaultId
        : (ids.includes('standard') ? 'standard' : (ids[0] ?? null))
      if (!defaultPreset) return { available: null, defaultPreset: null, error: 'preset-service-empty' }
      return { available: ids, defaultPreset, error: null }
    } catch {
      // Never echo the service error text: it can carry environment details.
      return { available: null, defaultPreset: null, error: 'preset-service-error' }
    }
  }

  function buildPreview(source, presetEnv) {
    const importableRows = (source.report.sessions ?? []).filter(s => s.importable === true)
    const missingBySession = new Map()
    for (const missing of source.missingAttachments ?? []) {
      for (const id of missing.usedBy ?? []) {
        if (!missingBySession.has(id)) missingBySession.set(id, [])
        missingBySession.get(id).push(missing.key)
      }
    }
    let attachmentCounts = new Map()
    let invalidBySession = new Map()
    try {
      const graph = collectAttachmentDependencies(source.candidates)
      attachmentCounts = new Map([...graph.bySession.entries()].map(([id, list]) => [id, list.length]))
      for (const invalid of graph.invalid) {
        if (!invalidBySession.has(invalid.sessionId)) invalidBySession.set(invalid.sessionId, [])
        invalidBySession.get(invalid.sessionId).push(invalid)
      }
    } catch { /* counts are advisory */ }
    const preview = []
    for (const row of importableRows) {
      const candidate = source.candidates.find(c => c.id === row.id)
      if (!candidate) continue
      const preset = resolvePresetMapping(candidate.header?.agentPreset, presetEnv.available, presetEnv.defaultPreset ?? 'standard')
      const missing = missingBySession.get(row.id) ?? []
      const invalid = invalidBySession.get(row.id) ?? []
      const importable = preset.writable && missing.length === 0 && invalid.length === 0
      preview.push({
        index: preview.length,
        id: row.id,
        title: firstUserTitle(candidate.events, `会话 ${preview.length + 1}`),
        events: candidate.events.length,
        sourceGeneration: row.sourceGeneration ?? candidate.sourceGeneration,
        presetSource: preset.sourcePreset,
        presetTarget: preset.targetPreset,
        presetReason: preset.reason,
        presetWritable: preset.writable,
        attachments: attachmentCounts.get(row.id) ?? 0,
        missingAttachments: missing.length,
        invalidAttachments: invalid.length,
        importable,
        blockReason: !preset.writable
          ? 'preset-unavailable'
          : (invalid.length > 0
              ? 'attachment-ref-invalid'
              : (missing.length > 0 ? 'attachment-source-missing' : null)),
        selected: false,
      })
    }
    return preview
  }

  function blockedReasons() {
    const reasons = []
    if (state.phase === 'preview' || state.phase === 'approved' || state.phase === 'replan_required') {
      if (state.workspaceUnitUnavailable) reasons.push('workspace-unit-unavailable')
      if (state.preview.length === 0) reasons.push('no-importable-sessions')
      if (state.selected.size === 0) reasons.push('no-session-selected')
      if (state.preview.some(s => s.importable && s.presetReason === 'unavailable-presets' && state.selected.has(s.id))) reasons.push('preset-service-unavailable')
      if (state.preview.some(s => s.importable === false && state.selected.has(s.id))) reasons.push('selected-session-blocked')
      const missing = state.preview.filter(s => state.selected.has(s.id) && s.missingAttachments > 0)
      if (missing.length > 0) reasons.push('attachment-source-missing')
      if (state.services && !state.services.attachments
        && state.preview.some(s => state.selected.has(s.id) && s.importable && s.attachments > 0)) {
        reasons.push('attachment-store-unavailable')
      }
    }
    return [...new Set(reasons)]
  }

  function canApprove() {
    return ['preview', 'replan_required'].includes(state.phase)
      && state.selected.size > 0
      && blockedReasons().length === 0
  }

  function setSelection(values) {
    const importable = state.preview.filter(s => s.importable)
    const start = state.page * 8
    const pageIds = new Set(importable.slice(start, start + 8).map(s => s.id))
    // Multi-select is rendered per page: keep selections on other pages and
    // replace only the current page's set.
    const next = new Set([...state.selected].filter(id => !pageIds.has(id)))
    for (const value of Array.isArray(values) ? values : []) {
      const index = Number(value)
      if (!Number.isInteger(index) || index < start || index >= start + 8) continue
      const item = state.preview.find(s => s.index === index && s.importable)
      if (item) next.add(item.id)
    }
    state.selected = next
    emit()
  }

  function toggle(id) {
    const item = state.preview.find(s => s.id === id)
    if (!item?.importable) return false
    if (state.selected.has(id)) state.selected.delete(id)
    else state.selected.add(id)
    emit()
    return true
  }

  function setPage(page) {
    const count = Math.max(1, Math.ceil(state.preview.filter(s => s.importable).length / 8))
    state.page = Math.min(count - 1, Math.max(0, Number(page) || 0))
    emit()
  }

  async function inspectBackup(inputPath, jobDir, digest, reimportPlan = null) {
    const services = requireServices()
    const persistence = services.sessionPersistence
    if (typeof persistence.locate !== 'function') {
      throw new Error('the target backend has no locate capability; import cannot start')
    }
    await setLocationAdapter(header => {
      const located = persistence.locate({ cwd: header.cwd, id: header.id })
      return relative(persistence.root, located.path).split(sep).slice(0, -1).join('/')
    })
    setPhase('inspecting', { progress: { label: 'verify', value: 0, max: 1 } })
    const source = await loadBackupSource(inputPath, { stagingRoot: join(jobDir, 'source') })
    state.source = source
    state.report = source.report
    state.sourceDigest = digest
    state.jobDir = jobDir
    if (source.report.archiveFailed) {
      setPhase('failed', {
        error: 'backup verification failed',
        progress: null,
        preview: [],
      })
      return false
    }
    const presetEnv = await readPresetEnvironment()
    const date = new Date().toISOString().slice(0, 10)
    state.targetCwd = join(state.workspaceRoot, `dsha-import-${date}`)
    await mkdir(state.targetCwd, { recursive: true, mode: 0o700 })
    state.workspaceTitle = `DSHA 导入 ${date}`
    const preview = buildPreview(source, presetEnv)
    // A session already registered in a DIFFERENT workspace must not be
    // attached again: the target workspace domain refuses duplicate
    // membership on the next boot. Check BOTH the visible registry and the
    // RAW persisted unit — the visible getter hides members whose session log
    // is missing, which is exactly the accident shape.
    state.workspaceUnitUnavailable = false
    let persistedWorkspaces = []
    try {
      const provider = buildAdapter().target.workspaceUnitProvider
      const unit = await provider()
      persistedWorkspaces = Object.entries(unit.projection.workspaces ?? {}).map(([id, record]) => ({
        id,
        path: record.path,
        sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds : [],
      }))
    } catch {
      state.workspaceUnitUnavailable = true
    }
    try {
      const registry = services.workspaceRegistry
      const visible = typeof registry?.list === 'function' ? registry.list() : []
      for (const item of preview) {
        const owners = [
          ...visible.filter(w => w.path !== state.targetCwd && Array.isArray(w.sessionIds) && w.sessionIds.includes(item.id)),
          ...persistedWorkspaces.filter(w => w.path !== state.targetCwd && w.sessionIds.includes(item.id)),
        ]
        if (owners.length > 0) {
          item.workspaceDuplicate = true
          item.importable = false
          item.blockReason = 'workspace-duplicate'
        }
      }
    } catch { /* preview remains conservative if the registry cannot be read */ }
    state.preview = preview
    state.selected = new Set(preview.filter(s => s.importable).map(s => s.id))
    state.page = 0
    state.plan = null
    state.planDigest = null
    state.mappedCandidates = null
    state.result = null
    state.recovery = null
    state.existing = []
    state.progress = null
    state.error = null
    state.notice = presetEnv.error ? 'preset-service-unavailable' : null
    setPhase(preview.some(s => s.importable) ? 'preview' : 'failed',
      preview.some(s => s.importable) ? {} : { error: 'no importable sessions' })
    if (reimportPlan) {
      // A persisted DONE journal re-checks the target with the SAME approved
      // plan and candidates; the job decides ALREADY_DONE vs recovery.
      const selectedIds = new Set(reimportPlan.selected ?? [])
      const items = preview.filter(s => selectedIds.has(s.id) && s.importable)
      state.selected = new Set(items.map(s => s.id))
      if (items.length !== selectedIds.size) {
        setPhase('failed', { error: 'reimport-candidate-unavailable' })
        return true
      }
      try {
        const { mapped } = buildMappedCandidates(items)
        state.plan = reimportPlan
        state.planDigest = reimportPlan.digest
        state.mappedCandidates = mapped
        state.notice = 'reimport-check'
        setPhase('approved')
      } catch {
        setPhase('failed', { error: 'reimport-candidate-unavailable' })
      }
    }
    return true
  }

  async function loadJournal(jobDir, digest) {
    try {
      return ImportJournal.load(join(jobDir, 'journal.json'), {
        instanceFingerprint: state.instanceFingerprint,
        sourceDigest: digest,
      })
    } catch {
      return null
    }
  }

  async function prepareStaged(name, digest, writeInput) {
    const jobDir = jobDirFor(digest)
    await mkdir(join(jobDir, 'input'), { recursive: true, mode: 0o700 })
    const journal = await loadJournal(jobDir, digest)
    let reimportPlan = null
    if (journal) {
      if (journal.state.batchState === 'DONE') {
        // Re-read the source so the DONE re-verification has real candidates;
        // the persisted plan stays the approved version.
        try {
          reimportPlan = await loadPlan(join(jobDir, 'plan.json'), {
            sourceDigest: digest,
            instanceFingerprint: state.instanceFingerprint,
          })
        } catch {
          state.sourceDigest = digest
          state.jobDir = jobDir
          setPhase('failed', { error: 'approved-plan-unavailable' })
          return
        }
      } else if (journal.state.batchState !== 'ROLLED_BACK') {
        state.sourceDigest = digest
        state.jobDir = jobDir
        state.recovery = {
          batchState: journal.state.batchState,
          openIntents: journal.state.actions.filter(a => a.stage === 'intent').map(a => ({ type: a.type, sessionId: a.sessionId ?? null })),
          snapshotDigest: journal.state.snapshot?.digest ?? null,
        }
        setPhase('recovery_required')
        return
      } else {
        // ROLLED_BACK is terminal: a fresh plan may reuse this source identity.
        await rm(join(jobDir, 'journal.json'), { force: true })
        await rm(join(jobDir, 'plan.json'), { force: true })
      }
    }
    const inputPath = join(jobDir, 'input', safeName(name))
    await writeInput(inputPath)
    await inspectBackup(inputPath, jobDir, digest, reimportPlan)
  }

  async function prepareBytes(name, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('empty backup selection')
    if (bytes.length > MAX_BACKUP_BYTES) throw new Error('backup exceeds the accepted size')
    const digest = sha256(bytes)
    await prepareStaged(name, digest, inputPath => writeFile(inputPath, bytes, { mode: 0o600 }))
  }

  /**
   * Product large-backup entry: stream the selected file into the private job
   * directory (never read it whole into memory), then run the same v5 inspect
   * kernel. The system picker remains the ≤8 MiB path.
   */
  async function preparePath(path, name = null) {
    let staged = null
    try {
      staged = await stageBackupFile({
        sourcePath: path,
        destinationDirectory: join(state.dataRoot, 'tmp'),
      })
      await prepareStaged(name ?? staged.name, staged.digest, async inputPath => {
        await commitStagedFile(staged.tmpPath, inputPath)
        staged.tmpPath = null // committed; the finally-cleanup must not delete it
      })
    } finally {
      if (staged?.tmpPath) await rm(staged.tmpPath, { force: true }).catch(() => {})
    }
  }

  async function scanLargeBackups() {
    state.large = { ...state.large, error: null }
    emit()
    try {
      const result = await listBackupCandidates()
      state.large = { root: result.root, entries: result.entries, error: null }
      emit()
      return result
    } catch (error) {
      state.large = {
        root: process.env.DSHA_MIGRATOR_SCAN_DIR || '/sdcard/Download/DSHA',
        entries: [],
        error: error?.code ?? 'INPUT_SCAN_FAILED',
      }
      emit()
      throw error
    }
  }

  async function prepareLarge(index) {
    const entry = state.large?.entries?.[Number(index)]
    if (!entry) throw codedController('INPUT_SELECTION_INVALID', 'selected download candidate is no longer available')
    state.largeBusyIndex = Number(index)
    emit()
    try {
      await preparePath(entry.path, entry.name)
      state.large = { root: state.large.root, entries: [], error: null }
    } finally {
      state.largeBusyIndex = null
      emit()
    }
  }

  function codedController(code, message, extra = {}) {
    const e = new Error(message)
    e.code = code
    Object.assign(e, extra)
    return e
  }

  /** Inspect the instance lock/guard for the recovery panel (no mutation). */
  function inspectLock() {
    return lockSnapshot()
  }

  /**
   * Explicitly reclaim a crashed job's lock/guard after the user confirms, then
   * resume the persisted rollback. Never breaks a lock younger than the
   * configured stale threshold, and never targets a newer generation.
   */
  async function unlockAndResume() {
    if (!state.jobDir) throw codedController('IMPORT_RECOVERY_UNAVAILABLE', 'no job to recover')
    const lock = peekJobLock(state.instanceLockDir)
    let guard = peekGuard(state.instanceLockDir)
    if (guard.held) {
      // Never remove a guard that may belong to a live operation. Only a
      // guard at least as old as the stale threshold is reclaimable.
      if (guard.ageMs == null || guard.ageMs < STALE_LOCK_MS) {
        throw codedController('IMPORT_JOB_LOCKED', 'the lock guard is recent — another operation may still be running')
      }
      clearStaleGuard(state.instanceLockDir, { olderThanMs: STALE_LOCK_MS })
      guard = peekGuard(state.instanceLockDir)
      if (guard.held) throw codedController('IMPORT_JOB_LOCKED', 'could not clear the abandoned lock guard')
    }
    if (!lock.held) return resumeRollback()
    if (lock.ageMs != null && lock.ageMs < STALE_LOCK_MS) {
      throw codedController('IMPORT_JOB_LOCKED', 'the import lock is recent — another job may still be running')
    }
    const broken = breakStaleLock(state.instanceLockDir, {
      instanceFingerprint: state.instanceFingerprint,
      olderThanMs: STALE_LOCK_MS,
      expect: { ownerId: lock.holder?.ownerId, generation: lock.holder?.generation },
    })
    if (!broken.broken) {
      throw codedController('IMPORT_JOB_LOCKED', 'the import lock changed while waiting — refusing to break a newer holder', { reason: broken.reason })
    }
    return resumeRollback()
  }

  /**
   * Explicit user-requested deletion of this task's private data. Imported
   * target sessions are NEVER touched; only input/staging/journal/snapshot/
   * quarantine and legacy P0 copies under our own data root.
   */
  async function purgePrivateData() {
    const lock = peekJobLock(state.instanceLockDir)
    if (lock.held) throw codedController('IMPORT_JOB_LOCKED', 'an import job lock is held — finish or recover it before purging')
    const jobDir = state.jobDir
    try {
      if (jobDir) await rm(jobDir, { recursive: true, force: true })
    } catch { /* report through the caller's UI state */ }
    try { await rm(join(state.dataRoot, 'p0', 'input'), { recursive: true, force: true }) } catch { /* optional legacy path */ }
    try { await rm(join(state.dataRoot, 'dsha-devlist.json'), { force: true }) } catch { /* optional dev output */ }
    state.jobDir = null
    state.source = null
    state.report = null
    state.recovery = null
    state.result = null
    state.error = null
    state.progress = null
    state.notice = null
    state.phase = 'idle'
    emit()
    return true
  }

  function buildMappedCandidates(selectedItems) {
    const source = state.source
    const cwdMapping = {}
    const mapped = []
    for (const item of selectedItems) {
      const candidate = source.candidates.find(c => c.id === item.id)
      if (!candidate) throw new Error('a selected session has no verified candidate')
      const presetMapping = {
        sourcePreset: item.presetSource,
        targetPreset: item.presetTarget,
        reason: item.presetReason,
        writable: item.presetWritable,
      }
      const header = applyPresetMapping(candidate.header, presetMapping)
      mapped.push({
        ...candidate,
        header,
        workspace: { path: state.targetCwd, title: state.workspaceTitle },
      })
      if (candidate.header?.cwd) cwdMapping[candidate.header.cwd] = state.targetCwd
    }
    return { mapped, cwdMapping }
  }

  async function approve() {
    if (!canApprove()) throw new Error('the current selection is not approvable')
    const selected = state.preview.filter(s => state.selected.has(s.id) && s.importable)
    if (selected.length === 0) throw new Error('no sessions selected')
    const { mapped, cwdMapping } = buildMappedCandidates(selected)
    const plan = buildPlan({
      sourceDigest: state.sourceDigest,
      instanceFingerprint: state.instanceFingerprint,
      report: state.report,
      selectedIds: selected.map(s => s.id),
      cwdMapping,
    })
    const planFile = join(state.jobDir, 'plan.json')
    freezePlan(planFile, plan)
    const journal = ImportJournal.init(join(state.jobDir, 'journal.json'), {
      instanceFingerprint: state.instanceFingerprint,
      sourceDigest: state.sourceDigest,
    }, { requirePlanApproval: true })
    journal.approvePlan({ digest: plan.digest, file: planFile })
    journal.transitionBatch('PLANNED')
    state.plan = plan
    state.planDigest = plan.digest
    state.mappedCandidates = mapped
    state.notice = null
    setPhase('approved')
  }

  async function start() {
    if (state.phase !== 'approved' || !state.plan) throw new Error('approve the plan before starting')
    const adapter = buildAdapter()
    const abort = new AbortController()
    state.abort = abort
    state.phase = 'running'
    state.error = null
    state.progress = { label: 'import', value: 0, max: 1 }
    emit()
    let result
    try {
      result = await runImportJob({
        jobDir: state.jobDir,
        instanceLockDir: state.instanceLockDir,
        instanceFingerprint: state.instanceFingerprint,
        sourceDigest: state.sourceDigest,
        approvedPlan: state.plan,
        target: adapter.target,
        sessions: state.mappedCandidates,
        readAttachmentSource: state.source.readAttachmentSource,
        attachmentExists: adapter.attachmentExists,
        withdrawSession: adapter.withdrawSession,
        signal: abort.signal,
      })
    } catch (error) {
      result = { status: 'FAILED', error: { code: error?.code ?? 'RUNTIME_FAILURE' } }
    } finally {
      state.abort = null
    }
    state.result = result
    state.progress = null
    await settle(result)
  }

  async function settle(result) {
    const status = result?.status
    if (status === 'DONE' || status === 'NO_WRITES' || status === 'ALREADY_DONE') {
      await cleanupSource()
      setPhase(status === 'ALREADY_DONE' ? 'already_done' : 'done', { notice: null })
      return
    }
    if (status === 'RECOVERY_REQUIRED') {
      const recovery = result.recovery ?? { batchState: 'UNKNOWN', openIntents: [] }
      if (recovery.batchState === 'DONE') {
        // A COMPLETED batch whose target sessions were changed after import is
        // not a rollback candidate: its journal is DONE and there are no open
        // intents. Offer a terminal "target modified" result instead of the
        // recovery panel (which would imply an unfinished write).
        await cleanupSource()
        state.recovery = null
        state.result = { ...result, status: 'TARGET_MODIFIED' }
        state.notice = 'target-modified'
        setPhase('target_modified')
        return
      }
      state.recovery = recovery
      await cleanupSource()
      setPhase('recovery_required')
      return
    }
    if (status === 'REPLAN_REQUIRED' || status === 'CONFLICT') {
      // No target writes happened: keep the staged source so the user can
      // confirm a re-frozen plan for the remaining set.
      state.existing = result.existing ?? []
      await resetJournalForReplan()
      const existingIds = new Set(state.existing.map(e => e.id))
      state.selected = new Set(state.preview.filter(s => s.importable && !existingIds.has(s.id)).map(s => s.id))
      state.plan = null
      state.planDigest = null
      state.mappedCandidates = null
      state.notice = status === 'CONFLICT' ? 'conflict-detected' : 'replan-required'
      setPhase('replan_required')
      return
    }
    if (status === 'CANCELLED' || status === 'CANCELLED_ROLLBACK_PENDING' || status === 'CANCELLED_ROLLBACK_INCOMPLETE') {
      await cleanupSource()
      setPhase('cancelled')
      return
    }
    if (status === 'ATTACHMENT_BLOCKED') {
      // No target writes happened (job refused before beginImport). Drop the
      // zero-action journal so the user can deselect blocked rows and approve
      // again; the staged source is kept for that replan.
      await resetJournalForReplan()
      const importable = state.preview.filter(s => s.importable)
      if (importable.length === 0) {
        await cleanupSource()
        setPhase('failed', { error: 'no-importable-sessions' })
        return
      }
      state.selected = new Set(importable.map(s => s.id))
      state.plan = null
      state.planDigest = null
      state.mappedCandidates = null
      state.notice = 'attachment-ref-invalid'
      setPhase('preview')
      return
    }
    await cleanupSource()
    setPhase('failed', { error: result?.error?.code ?? 'IMPORT_FAILED' })
  }

  async function resetJournalForReplan() {
    try {
      const journal = await loadJournal(state.jobDir, state.sourceDigest)
      // Only a zero-action PLANNED journal is safe to discard.
      if (journal && journal.state.actions.length === 0 && ['PLANNED', 'SNAPSHOT_READY', 'NEW'].includes(journal.state.batchState)) {
        await rm(join(state.jobDir, 'journal.json'), { force: true })
        await rm(join(state.jobDir, 'plan.json'), { force: true })
      }
    } catch { /* leave the journal for recovery if it cannot be proven empty */ }
  }

  async function cleanupSource() {
    try { await state.source?.cleanup?.() } catch { /* best effort */ }
    try {
      const inputDir = join(state.jobDir, 'input')
      await rm(inputDir, { recursive: true, force: true })
    } catch { /* best effort */ }
  }

  async function cancel() {
    if (state.abort) {
      state.abort.abort()
      state.notice = 'cancelling'
      emit()
      return true
    }
    return false
  }

  async function resumeRollback() {
    const jobDir = state.jobDir
    if (!jobDir) throw new Error('no job to recover')
    const plan = await loadPlan(join(jobDir, 'plan.json'), {
      sourceDigest: state.sourceDigest,
      instanceFingerprint: state.instanceFingerprint,
    })
    // R4: use the PERSISTED approved plan, not the fresh controller's empty
    // in-memory state. The public recovery summary may omit ids; the internal
    // identity view must not.
    const ids = recoveryCandidateIds(plan, state.recovery)
    // The rollback gate needs only candidate identity; events are never written.
    const sessions = [...ids].map(id => ({ id, header: { version: 4, id, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }, events: [], inheritedEventCount: 0 }))
    const adapter = buildAdapter()
    state.phase = 'running'
    state.progress = { label: 'rollback', value: 0, max: 1 }
    emit()
    let result
    try {
      result = await runImportJob({
        jobDir,
        instanceLockDir: state.instanceLockDir,
        instanceFingerprint: state.instanceFingerprint,
        sourceDigest: state.sourceDigest,
        approvedPlan: plan,
        target: adapter.target,
        sessions,
        readAttachmentSource: async () => { throw new Error('source already cleaned') },
        attachmentExists: adapter.attachmentExists,
        withdrawSession: adapter.withdrawSession,
        recoveredJudgment: { resolveOpenIntents: 'rollback' },
      })
    } catch (error) {
      result = { status: 'FAILED', error: { code: error?.code ?? 'ROLLBACK_FAILURE' } }
    }
    state.result = result
    state.progress = null
    await settle(result)
  }

  async function resumePending() {
    const jobsRoot = join(state.dataRoot, 'jobs')
    let names = []
    try {
      const { readdir } = await import('node:fs/promises')
      names = await readdir(jobsRoot)
    } catch { return false }
    for (const name of names) {
      const jobDir = join(jobsRoot, name)
      let raw
      try {
        raw = JSON.parse(await readFile(join(jobDir, 'journal.json'), 'utf8'))
      } catch { continue }
      const digest = raw?.binding?.sourceDigest
      if (typeof digest !== 'string' || digest === '') continue
      let journal
      try {
        journal = ImportJournal.load(join(jobDir, 'journal.json'), {
          instanceFingerprint: state.instanceFingerprint,
          sourceDigest: digest,
        })
      } catch { continue }
      if (!journal) continue
      const batch = journal.state.batchState
      if (batch === 'DONE' || batch === 'ROLLED_BACK') continue
      state.sourceDigest = digest
      state.jobDir = jobDir
      state.recovery = {
        batchState: batch,
        openIntents: journal.state.actions.filter(a => a.stage === 'intent').map(a => ({ type: a.type, sessionId: a.sessionId ?? null })),
        snapshotDigest: journal.state.snapshot?.digest ?? null,
      }
      setPhase('recovery_required')
      return true
    }
    return false
  }

  async function reset() {
    if (['staging', 'inspecting', 'running'].includes(state.phase)) {
      throw codedController('IMPORT_BUSY', 'cannot reset while a migration job is running')
    }
    // Drop the staged source/input copy before clearing UI state. Journal /
    // snapshot are not touched here (recovery must still be able to find them).
    try { await cleanupSource() } catch { /* best effort */ }
    state.phase = 'idle'
    state.error = null
    state.report = null
    state.preview = []
    state.selected = new Set()
    state.plan = null
    state.planDigest = null
    state.mappedCandidates = null
    state.result = null
    state.recovery = null
    state.existing = []
    state.sourceDigest = null
    state.jobDir = null
    state.notice = null
    state.progress = null
    state.source = null
    state.abort = null
    state.large = { root: state.large?.root ?? null, entries: [], error: null }
    state.largeBusyIndex = null
    emit()
  }

  function setError(code) {
    setPhase('failed', { error: code, progress: null })
  }

  function setServices(services) {
    state.services = services
    const persistence = services.sessionPersistence
    const home = dirname(persistence.root)
    state.instanceFingerprint = sha256(`dsha-migrator|${persistence.root}|${persistence.name ?? ''}`)
    state.dataRoot = process.env.DSHA_MIGRATOR_DATA_DIR || join(home, 'dsha-migrator')
    // ONE lock directory per target instance, shared by every source/job.
    // jobDir only holds private journal/plan/snapshot files.
    state.instanceLockDir = instanceLockDirFor(state.dataRoot)
    try { mkdir(state.instanceLockDir, { recursive: true, mode: 0o700 }).catch(() => {}) } catch { /* best effort */ }
    // The imported sessions live in a dedicated NEW workspace UNDER the App's
    // real workspace root (default ~/workspace), never inside DSH_HOME: the
    // App's session listing is scoped to that root.
    state.workspaceRoot = process.env.DSH_WORKSPACE_ROOT || join(homedir(), 'workspace')
    try { mkdir(state.workspaceRoot, { recursive: true, mode: 0o700 }).catch(() => {}) } catch { /* best effort */ }
    // A pending journal from a previous process is surfaced, not replayed.
    void resumePending()
    emit()
  }

  const unsubscribe = fn => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return {
    subscribe: unsubscribe,
    snapshot,
    setServices,
    prepareBytes,
    preparePath,
    scanLargeBackups,
    prepareLarge,
    inspectLock,
    unlockAndResume,
    purgePrivateData,
    setSelection,
    toggle,
    setPage,
    approve,
    start,
    cancel,
    resumeRollback,
    reset,
    setError,
  }
}
