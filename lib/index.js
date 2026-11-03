// dsh-Go native panel: the product migration flow.
//
// Default surface: pick a DSHA v5 backup → verify/preview → select sessions →
// approve the frozen plan → run the unified A-path job → result/recovery.
// The P0 probes remain available under the Dev section for diagnostics.
import { createMigrationController } from './import/controller.js'
import { runCapabilityCheck } from './p0/capability.js'
import { runWriteProbeA } from './p0/write-probe.js'
import { runWriteProbeB, runPostRestartCheck } from './p0/write-probe-b.js'
import { runG6Probe } from './p0/g6-probe.js'
import { handlePickedBackup, scanDownloadDir } from './p0/input-probe.js'
import { p0ReportDir } from './p0/report-dir.js'

export const name = 'dsh-dsha-migrator'

const probes = { cap: null, write: null, writeB: null, postRestart: null, g6: null, picked: null, scan: null }
const ui = { showDev: false, toast: null, lastPick: null }
const controller = createMigrationController({ onUpdate: () => bump() })
let services = null
let notifyServices = null
const servicesReady = new Promise(resolve => { notifyServices = resolve })
let dshGoCtx = null
let panelEmit = null
let revision = 0

function bump() {
  revision += 1
  try { panelEmit?.({ rev: revision }) } catch { /* panel not ready */ }
  try { dshGoCtx?.dshGo?.refresh?.('migration') } catch { /* bridge not ready */ }
}

function en(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en')
}

const REASON_TEXT = {
  'no-importable-sessions': { zh: '没有可导入的会话。', en: 'No importable sessions.' },
  'no-session-selected': { zh: '至少选择一个会话。', en: 'Select at least one session.' },
  'preset-service-unavailable': { zh: '目标预设服务不可读，已阻止写入。', en: 'The target preset service is unavailable; writing is blocked.' },
  'selected-session-blocked': { zh: '所选会话存在未解决的校验问题。', en: 'A selected session has an unresolved validation problem.' },
  'attachment-source-missing': { zh: '备份中缺少被引用的附件对象。', en: 'A referenced attachment object is missing from the backup.' },
  'attachment-store-unavailable': { zh: '目标附件存储不可用，无法发布附件。', en: 'The target attachment store is unavailable.' },
  'workspace-duplicate': { zh: '该会话已属于另一个工作区；为避免工作区数据不一致，已阻止再次挂接。', en: 'The session already belongs to another workspace; attaching it again is blocked to avoid an inconsistent workspace domain.' },
  'conflict-detected': { zh: '目标已有同 ID 但内容不同的会话，已排除；请确认剩余集合。', en: 'Conflicting target sessions were excluded; confirm the remaining set.' },
  'replan-required': { zh: '目标已有相同会话，已排除；请确认剩余集合后重新批准。', en: 'Identical target sessions were excluded; confirm and approve the remaining set.' },
  'reimport-check': { zh: '该备份已导入过；开始将重新核验目标。', en: 'This backup was imported before; starting re-checks the target.' },
  'preset-service-empty': { zh: '目标没有任何可用预设。', en: 'The target exposes no presets.' },
  'preset-service-error': { zh: '读取目标预设失败。', en: 'Reading target presets failed.' },
  'cancelling': { zh: '正在取消…', en: 'Cancelling…' },
}

function reason(locale, code) {
  const entry = REASON_TEXT[code]
  if (!entry) return code
  return en(locale) ? entry.en : entry.zh
}

function statusText(locale, status) {
  const map = {
    DONE: { zh: '导入完成', en: 'Import complete' },
    NO_WRITES: { zh: '没有需要写入的内容', en: 'Nothing to write' },
    ALREADY_DONE: { zh: '之前已完成（目标核验一致）', en: 'Already completed (target verified)' },
    RECOVERY_REQUIRED: { zh: '需要恢复判断', en: 'Recovery decision required' },
    CANCELLED: { zh: '已取消', en: 'Cancelled' },
    CANCELLED_ROLLBACK_PENDING: { zh: '已取消，回滚待完成', en: 'Cancelled, rollback pending' },
    CANCELLED_ROLLBACK_INCOMPLETE: { zh: '已取消，回滚未完成', en: 'Cancelled, rollback incomplete' },
    FAILED: { zh: '失败', en: 'Failed' },
    ROLLED_BACK: { zh: '已回滚', en: 'Rolled back' },
    ROLLBACK_PENDING: { zh: '回滚待完成', en: 'Rollback pending' },
  }
  const entry = map[status]
  return entry ? (en(locale) ? entry.en : entry.zh) : String(status ?? '—')
}

function sessionRows(snap, locale) {
  const importable = snap.sessions.filter(s => s.importable)
  const start = snap.page * 8
  return importable.slice(start, start + 8)
}

function previewView(snap, locale) {
  const isEn = en(locale)
  const rows = sessionRows(snap, locale)
  const selectedValues = rows.filter(row => row.selected).map(row => String(row.index))
  const children = []
  children.push({
    type: 'keyValue',
    items: [
      [isEn ? 'Total / importable' : '总数 / 可导入', `${snap.counts?.total ?? 0} / ${snap.importableCount}`],
      [isEn ? 'Selected' : '已选', String(snap.selectedCount)],
      [isEn ? 'Target workspace' : '目标工作区', snap.targetWorkspace?.title ?? '—'],
    ],
  })
  children.push({
    type: 'options',
    id: 'toggle',
    multi: true,
    options: rows.map(row => ({
      label: row.title,
      description: `${row.events} ${isEn ? 'events' : '事件'} · ${row.presetSource ?? '—'} → ${row.presetTarget ?? '—'}`,
      value: String(row.index),
    })),
    selected: selectedValues,
  })
  if (snap.pageCount > 1) {
    children.push({
      type: 'actions',
      items: [
        { label: isEn ? 'Previous' : '上一页', action: 'pagePrev' },
        { label: isEn ? 'Next' : '下一页', action: 'pageNext' },
      ],
    })
  }
  const mappingItems = snap.sessions.map(row => [
    row.title,
    `${row.presetSource ?? '—'} → ${row.presetTarget ?? '—'}${row.presetReason === 'missing-custom-preset' ? (isEn ? ' (fallback)' : '（回落）') : ''}`,
  ])
  if (mappingItems.length > 0) children.push({ type: 'keyValue', items: mappingItems.slice(0, 8) })
  if (snap.notice) children.push({ type: 'callout', tone: 'info', text: reason(locale, snap.notice) })
  if (snap.blockedReasons.length > 0) {
    children.push({ type: 'callout', tone: 'warn', text: snap.blockedReasons.map(r => reason(locale, r)).join(' ') })
  }
  children.push({
    type: 'actions',
    items: [
      { label: isEn ? 'Approve plan' : '确认计划', style: 'primary', action: 'approve' },
      { label: isEn ? 'Start over' : '重新选择', action: 'reset' },
    ],
  })
  return { type: 'stack', children }
}

function resultView(snap, locale) {
  const isEn = en(locale)
  const children = []
  const status = snap.result?.status ?? (snap.phase === 'failed' ? 'FAILED' : null)
  children.push({ type: 'callout', tone: status === 'DONE' || status === 'ALREADY_DONE' ? 'good' : (snap.phase === 'failed' ? 'bad' : 'info'), text: statusText(locale, status) })
  if (snap.error) children.push({ type: 'callout', tone: 'bad', text: String(snap.error) })
  const items = [
    [isEn ? 'Sessions' : '会话', String(snap.sessions.length)],
    [isEn ? 'Attachments published' : '附件发布', String(snap.result?.attachments?.published ?? 0)],
    [isEn ? 'Target verification' : '目标核验', snap.result?.verificationOk === true ? (isEn ? 'passed' : '通过') : (isEn ? 'not passed' : '未通过')],
  ]
  if (snap.result?.rollback) {
    items.push([isEn ? 'Rollback' : '回滚', `${snap.result.rollback.outcome} (${snap.result.rollback.actionOutcome}/${snap.result.rollback.workspaceOutcome})`])
  }
  children.push({ type: 'keyValue', items })
  if (snap.refused?.length > 0) {
    children.push({
      type: 'list',
      items: snap.refused.slice(0, 8).map(row => ({
        title: `gen ${row.generation ?? '?'} · ${row.status ?? 'refused'}`,
        subtitle: row.code ?? '',
        trailing: '',
        tone: 'bad',
      })),
    })
  }
  if (ui.showDev) {
    children.push({ type: 'text', text: `locationAdmission: ${snap.locationAdmission ?? '—'}`, tone: 'muted' })
  }
  if (ui.showDev && ui.lastPick) {
    children.push({ type: 'text', text: JSON.stringify(ui.lastPick).slice(0, 500), tone: 'muted' })
  }
  children.push({
    type: 'list',
    items: snap.sessions.map(row => ({
      title: row.title,
      subtitle: `${row.events} ${isEn ? 'events' : '事件'}`,
      trailing: row.presetTarget ?? '',
      tone: 'good',
    })),
  })
  children.push({
    type: 'actions',
    items: [
      { label: isEn ? 'New migration' : '新的迁移', style: 'primary', action: 'reset' },
    ],
  })
  return { type: 'stack', children }
}

function recoveryView(snap, locale) {
  const isEn = en(locale)
  return {
    type: 'stack',
    children: [
      { type: 'callout', tone: 'warn', text: isEn ? 'An unfinished or unverified migration was found. The target was not replayed automatically.' : '发现未完成或未核验的迁移任务，目标未被自动重放。' },
      { type: 'keyValue', items: [
        [isEn ? 'Journal state' : 'Journal 状态', snap.recovery?.batchState ?? '—'],
        [isEn ? 'Open intents' : '未收口意图', String(snap.recovery?.openIntents ?? 0)],
      ] },
      { type: 'actions', items: [
        { label: isEn ? 'Roll back open work' : '回滚未完成写入', style: 'primary', action: 'resume' },
        { label: isEn ? 'Start over' : '重新选择', action: 'reset' },
      ] },
    ],
  }
}

function runningView(snap, locale) {
  const isEn = en(locale)
  return {
    type: 'stack',
    children: [
      { type: 'progress', value: 0, max: 1, label: isEn ? 'Importing' : '正在导入', caption: isEn ? 'writing sessions / attachments' : '写入会话 / 附件' },
      { type: 'text', text: isEn ? 'The job continues if you leave this panel.' : '切换面板不会中断任务。', tone: 'muted' },
      { type: 'actions', items: [{ label: isEn ? 'Cancel' : '取消', action: 'cancel' }] },
    ],
  }
}

export function migrationView(scope, caps) {
  const locale = caps?.locale ?? scope?.locale
  const snap = controller.snapshot()
  const isEn = en(locale)
  const phase = snap.phase
  if (phase === 'staging' || phase === 'inspecting') {
    return {
      type: 'stack',
      children: [
        { type: 'progress', value: 0, max: 1, label: isEn ? 'Verifying backup' : '正在校验备份', caption: isEn ? 'archive + sessions + attachments' : '归档 + 会话 + 附件' },
        { type: 'text', text: isEn ? 'This can take a moment on a large backup.' : '较大的备份可能需要一点时间。', tone: 'muted' },
      ],
    }
  }
  if (phase === 'preview' || phase === 'approved' || phase === 'replan_required') {
    const view = previewView(snap, locale)
    if (phase === 'approved') {
      view.children.push({
        type: 'actions',
        items: [
          { label: isEn ? 'Start import' : '开始迁移', style: 'primary', action: 'start' },
          { label: isEn ? 'Reset' : '重置', action: 'reset' },
        ],
      })
    }
    return view
  }
  if (phase === 'running') return runningView(snap, locale)
  if (phase === 'recovery_required') return recoveryView(snap, locale)
  if (['done', 'already_done', 'cancelled', 'failed'].includes(phase)) return resultView(snap, locale)
  // idle
  const children = [
    { type: 'callout', tone: 'info', text: isEn ? 'Choose a DSHA v5 backup. The backup is read only; credentials and settings are never migrated.' : '选择 DSHA v5 备份。备份只读；凭据与设置不会迁移。' },
    { type: 'actions', items: [{ label: isEn ? 'Choose backup' : '选择备份', style: 'primary', action: 'pick' }] },
  ]
  if (snap.error) children.push({ type: 'callout', tone: 'bad', text: String(snap.error) })
  children.push({ type: 'actions', items: [{ label: ui.showDev ? (isEn ? 'Hide dev tools' : '收起开发工具') : (isEn ? 'Dev tools' : '开发工具'), action: 'devtoggle' }] })
  if (ui.showDev) {
    if (ui.lastPick) children.push({ type: 'text', text: `pick: ${JSON.stringify(ui.lastPick).slice(0, 300)}`, tone: 'muted' })
    children.push({
      type: 'actions',
      items: [
        { label: isEn ? 'Capability' : '能力检查', action: 'p0cap' },
        { label: isEn ? 'A probe' : 'A 探针', action: 'p0write' },
        { label: isEn ? 'B probe' : 'B 探针', action: 'p0writeB' },
        { label: isEn ? 'G6 probe' : 'G6 探针', action: 'p0g6' },
      ],
    })
    children.push({
      type: 'actions',
      items: [
        { label: isEn ? 'Pick (P0)' : '选择（P0）', action: 'pickBackup' },
        { label: isEn ? 'Scan Download' : '扫描 Download', action: 'scanDownload' },
        { label: isEn ? 'List sessions' : '会话列表', action: 'devlist' },
        { label: isEn ? 'Repair workspace' : '修复工作区', action: 'repairWorkspace' },
      ],
    })
  }
  return { type: 'stack', children }
}

async function persistReport(kind, payload, persistenceRoot) {
  try {
    const dir = await p0ReportDir(persistenceRoot)
    if (!dir) return
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${kind}-${Date.now()}.json`)
    await writeFile(file, JSON.stringify(payload, null, 2), { mode: 0o600 })
    payload._reportFile = file
  } catch { /* reporting never breaks the action */ }
}

async function requireServices() {
  if (!services) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('session persistence services not available')), 15000))
    await Promise.race([servicesReady, timeout])
  }
  if (!services) throw new Error('session persistence services not available')
  return services
}

function shortCap(cap) {
  if (!cap) return { status: 'pending' }
  if (cap.error) return { status: 'error' }
  return { status: cap.locate?.available ? 'locate-available' : 'locate-missing', backend: cap.backendName }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], panelCtx => {
    dshGoCtx = panelCtx
    panelCtx.dshGo.panel('migration', {
      view: migrationView,
      data: (_scope, emit) => {
        panelEmit = emit
        emit({ rev: revision })
        return () => { panelEmit = null }
      },
      actions: {
        pick: () => ({ type: 'pickFile', action: 'picked', maxFiles: 1 }),
        picked: (_scope, event) => {
          if (!dshGoCtx) throw new Error('dshGo context unavailable')
          const selection = event?.value
          ui.lastPick = {
            status: selection?.status ?? 'missing',
            files: (selection?.files ?? []).map(f => ({ name: f?.name ?? null, bytes: f?.bytes ?? null, hasHandle: Boolean(f?.handle) })),
            error: selection?.error ?? null,
          }
          bump()
          try {
            if (!selection || selection.status === 'cancelled') return { type: 'toast', text: '已取消' }
            if (selection.status === 'error') throw new Error(String(selection.error ?? 'picker error'))
            const file = selection.files?.[0]
            if (!file) throw new Error('no file selected')
            const started = Date.now()
            const bytes = dshGoCtx.dshGo.readPickedFile(file.handle)
            const ms = Date.now() - started
            ui.lastPick.readMs = ms
            ui.lastPick.readBytes = bytes?.byteLength ?? 0
            bump()
            if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('empty file')
            if (bytes.length > 8 * 1024 * 1024) throw new Error('file exceeds the 8 MiB picker budget')
            // Return immediately; verification continues in the background and
            // the panel is updated through the controller subscription.
            void controller.prepareBytes(file.name, bytes).catch(error => {
              ui.lastPick.error = `${error?.name ?? 'Error'}: ${error?.message ?? ''}`.slice(0, 300)
              controller.setError(typeof error?.code === 'string' ? error.code : 'prepare-failed')
              bump()
            })
            return { type: 'toast', text: `已选择 ${file.name}（${bytes.length} B, ${ms} ms），正在校验` }
          } catch (error) {
            ui.lastPick.error = `${error?.name ?? 'Error'}: ${error?.message ?? ''}`
            bump()
            throw error
          }
        },
        toggle: (_scope, event) => {
          const values = event?.value?.values
          controller.setSelection(Array.isArray(values) ? values : [])
          return { type: 'patch', data: { rev: ++revision } }
        },
        pagePrev: () => { controller.setPage(controller.snapshot().page - 1); return { type: 'patch', data: { rev: ++revision } } },
        pageNext: () => { controller.setPage(controller.snapshot().page + 1); return { type: 'patch', data: { rev: ++revision } } },
        approve: async () => {
          await requireServices()
          await controller.approve()
          return { type: 'toast', text: '计划已批准，可以开始迁移' }
        },
        start: async () => {
          await requireServices()
          void controller.start().catch(() => bump())
          return { type: 'toast', text: '迁移已开始' }
        },
        cancel: async () => {
          const ok = await controller.cancel()
          return { type: 'toast', text: ok ? '正在取消' : '当前没有可取消的任务' }
        },
        resume: async () => {
          await requireServices()
          void controller.resumeRollback().catch(() => bump())
          return { type: 'toast', text: '正在回滚未完成写入' }
        },
        reset: () => { controller.reset(); return { type: 'toast', text: '已重置' } },
        devtoggle: () => { ui.showDev = !ui.showDev; bump(); return { type: 'patch', data: { rev: ++revision } } },
        devlist: async () => {          const svc = await requireServices()
          const rows = []
          try {
            const q = ctx.get('sessionQuery')
            if (q?.listSessions) {
              for (const r of await q.listSessions()) {
                rows.push({ source: 'query', id: r.header.id.slice(0, 12), cwd: r.header.cwd, live: r.live, persisted: r.persisted })
              }
            }
          } catch (error) { rows.push({ source: 'query', error: error?.name ?? 'Error' }) }
          try {
            const api = ctx.get('sessionController')
            if (api?.list) {
              for (const s of await api.list()) {
                rows.push({ source: 'api', id: String(s.sessionId).slice(0, 12), blank: s.blank, sub: s.isSubagent, origin: s.origin, cwd: s.cwd, updatedAt: s.updatedAt })
              }
            }
          } catch (error) { rows.push({ source: 'api', error: error?.name ?? 'Error' }) }
          const { writeFile } = await import('node:fs/promises')
          const { join, dirname } = await import('node:path')
          const payload = JSON.stringify({ rows }, null, 2)
          try {
            await writeFile('/sdcard/Download/dsha-devlist.json', payload, { mode: 0o600 })
          } catch {
            await writeFile(join(dirname(svc.sessionPersistence.root), 'dsha-devlist.json'), payload, { mode: 0o600 })
          }
          return { type: 'toast', text: `会话列表 ${rows.length}` }
        },
        repairWorkspace: async () => {
          // Emergency repair for a duplicated workspace membership: the
          // registry refuses to load when one session is accounted by two
          // workspaces, which takes the session list and terminal down.
          // Keep the membership in the App workspace root and prune the
          // stale private migration workspace.
          const { readFile, writeFile, rename } = await import('node:fs/promises')
          const { join } = await import('node:path')
          const home = process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh')
          const file = join(home, 'storages', 'workspace.json')
          const raw = JSON.parse(await readFile(file, 'utf8'))
          const ws = raw.tables?.workspaces ?? {}
          const counts = new Map()
          for (const rec of Object.values(ws)) for (const sid of rec.sessionIds ?? []) counts.set(sid, (counts.get(sid) ?? 0) + 1)
          const duplicates = [...counts].filter(([, n]) => n > 1).map(([sid]) => sid)
          const appRoot = process.env.DSH_WORKSPACE_ROOT || join(process.env.HOME || '/root', 'workspace')
          const underAppRoot = p => typeof p === 'string' && (p === appRoot || p.startsWith(appRoot + '/'))
          const removed = []
          for (const sid of duplicates) {
            const keeper = Object.entries(ws).find(([, rec]) => underAppRoot(rec.path) && (rec.sessionIds ?? []).includes(sid))
            for (const [id, rec] of Object.entries(ws)) {
              if (keeper && id === keeper[0]) continue
              if ((rec.sessionIds ?? []).includes(sid)) {
                rec.sessionIds = rec.sessionIds.filter(x => x !== sid)
                removed.push({ workspace: id.slice(0, 12), session: sid.slice(0, 12) })
              }
            }
          }
          for (const [id, rec] of Object.entries(ws)) {
            if ((rec.sessionIds ?? []).length === 0 && typeof rec.path === 'string' && rec.path.includes('/.dsh/dsha-migrator/')) {
              delete ws[id]
              raw.global.workspaceIds = (raw.global.workspaceIds ?? []).filter(x => x !== id)
              removed.push({ workspace: id.slice(0, 12), pruned: true })
            }
          }
          const tmp = `${file}.repair.tmp`
          await writeFile(tmp, JSON.stringify(raw), { mode: 0o600 })
          await rename(tmp, file)
          try {
            await writeFile('/sdcard/Download/dsha-repair.json', JSON.stringify({ duplicates: duplicates.length, removed }, null, 2), { mode: 0o600 })
          } catch { /* best effort */ }
          return { type: 'toast', text: `修复 ${duplicates.length} 个重复成员` }
        },
        // ---- P0 development probes (kept as a diagnostic entry) ----
        p0cap: async () => {
          const svc = await requireServices()
          probes.cap = await runCapabilityCheck(svc)
          await persistReport('capability', probes.cap, probes.cap.root)
          return { type: 'patch', id: 'p0cap', data: { cap: shortCap(probes.cap) } }
        },
        p0write: async () => {
          const svc = await requireServices()
          if (!probes.cap) probes.cap = await runCapabilityCheck(svc)
          probes.write = await runWriteProbeA(svc, probes.cap)
          await persistReport('write-a', probes.write, probes.cap?.root)
          return { type: 'patch', id: 'p0write', data: { write: { status: probes.write.error ? 'error' : `${probes.write.pass}/${probes.write.total}` } } }
        },
        p0writeB: async () => {
          const svc = await requireServices()
          if (!probes.cap) probes.cap = await runCapabilityCheck(svc)
          probes.writeB = await runWriteProbeB(svc, probes.cap)
          await persistReport('write-b', probes.writeB, probes.cap?.root)
          return { type: 'patch', id: 'p0writeB', data: { writeB: { status: probes.writeB.error ? 'error' : `${probes.writeB.pass}/${probes.writeB.total}` } } }
        },
        p0g6: async () => {
          const svc = await requireServices()
          if (!probes.cap) probes.cap = await runCapabilityCheck(svc)
          probes.g6 = await runG6Probe(svc, probes.cap)
          await persistReport('g6', probes.g6, probes.cap?.root)
          return { type: 'patch', id: 'p0g6', data: { g6: probes.g6.error ? 'error' : `${probes.g6.pass}/${probes.g6.total}` } }
        },
        pickBackup: () => ({ type: 'pickFile', action: 'pickedP0', maxFiles: 1 }),
        pickedP0: async (_scope, event) => {
          if (!dshGoCtx) throw new Error('dshGo context unavailable')
          const svc = await requireServices()
          if (!probes.cap) probes.cap = await runCapabilityCheck(svc)
          probes.picked = await handlePickedBackup(dshGoCtx, probes.cap, event)
          await persistReport('input-picked', probes.picked, probes.cap?.root)
          return { type: 'toast', text: probes.picked.status === 'queued' ? 'P0 选择已排队' : probes.picked.status }
        },
        scanDownload: async () => {
          const svc = await requireServices()
          if (!probes.cap) probes.cap = await runCapabilityCheck(svc)
          probes.scan = await scanDownloadDir(svc, probes.cap)
          await persistReport('input-scan', probes.scan, probes.cap?.root)
          return { type: 'toast', text: probes.scan.error ? `扫描失败` : `扫描到 ${probes.scan.entries.length} 个文件` }
        },
      },
    })
  })

  ctx.inject(['sessionPersistence', 'workspaceRegistry'], svc => {
    services = {
      sessionPersistence: svc.sessionPersistence,
      workspaceRegistry: svc.workspaceRegistry,
      attachments: ctx.get('attachments'),
      agentPresets: ctx.get('agentPresets'),
    }
    controller.setServices(services)
    notifyServices()
    runCapabilityCheck(svc).then(async cap => {
      probes.cap = cap
      await persistReport('capability', cap, cap.root)
      if (process.env.DSHA_MIGRATOR_P0_AUTOWRITE === '1') probes.write = await runWriteProbeA(svc, cap)
      if (process.env.DSHA_MIGRATOR_P0_AUTOB === '1') probes.writeB = await runWriteProbeB(svc, cap)
      if (process.env.DSHA_MIGRATOR_P0_B_CHECK_IDS) probes.postRestart = await runPostRestartCheck(svc)
      if (process.env.DSHA_MIGRATOR_P0_AUTOG6 === '1') probes.g6 = await runG6Probe(svc, cap)
    }).catch(() => {})
  })
}
