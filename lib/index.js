// P0 vertical prototype for the DSHA → dsh-Go session migrator.
// Registers the native panel, runs the runtime capability check at boot, and
// exposes P0 probe actions (A-path write probe). No UI polish at this stage.
import { runCapabilityCheck } from './p0/capability.js'
import { runWriteProbeA } from './p0/write-probe.js'
import { runWriteProbeB, runPostRestartCheck } from './p0/write-probe-b.js'
import { runG6Probe } from './p0/g6-probe.js'
import { handlePickedBackup, scanDownloadDir } from './p0/input-probe.js'
import { p0ReportDir } from './p0/report-dir.js'

export const name = 'dsh-dsha-migrator'

const state = { cap: null, write: null, writeB: null, postRestart: null, g6: null, picked: null, scan: null }

// Services the probes need; resolved through lazy injection so the panel can
// register (and the SDK check can load) without them.
let services = null
let notifyServices = null
const servicesReady = new Promise(resolve => { notifyServices = resolve })
// Context injected with dshGo — the pickFile callback must read picked bytes
// through ctx.dshGo, which is only accessible from an inject scope that
// declared it (cordis refuses undeclared properties).
let dshGoCtx = null

function en(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en')
}

function shortCap(cap) {
  if (!cap) return { status: 'pending' }
  if (cap.error) return { status: 'error', error: cap.error }
  return {
    status: cap.locate?.available ? 'locate-available' : 'locate-missing',
    backend: cap.backendName,
    backendClass: cap.backendClass,
    root: cap.root,
    locateKind: cap.locate?.kind ?? null,
    locateUnderRoot: cap.locate?.underRoot ?? null,
    checkedAt: cap.at,
  }
}

export function migrationView(scope, caps) {
  const isEn = en(caps?.locale)
  const cap = state.cap
  const lines = []
  if (!cap) {
    lines.push({ type: 'text', text: isEn ? 'Capability check has not run yet.' : '能力检查尚未运行。', tone: 'muted' })
  } else if (cap.error) {
    lines.push({ type: 'text', text: (isEn ? 'Capability check failed: ' : '能力检查失败：') + cap.error, tone: 'warning' })
  } else {
    lines.push({ type: 'text', text: (isEn ? 'Backend: ' : '后端：') + `${cap.backendName} (${cap.backendClass})` })
    lines.push({ type: 'text', text: (isEn ? 'Persistence root: ' : '持久化根：') + String(cap.root) })
    lines.push({
      type: 'text',
      text: (isEn ? 'runtime locate(): ' : '运行时 locate()：')
        + (cap.locate?.available ? (isEn ? 'present' : '存在') : (isEn ? 'MISSING' : '不存在'))
        + (cap.locate?.kind ? ` (${cap.locate.kind})` : ''),
      tone: cap.locate?.available ? 'positive' : 'warning',
    })
    if (cap.locate?.error) lines.push({ type: 'text', text: 'locate error: ' + cap.locate.error, tone: 'warning' })
  }
  if (state.write) {
    const w = state.write
    lines.push({ type: 'text', text: (isEn ? 'A-path probe: ' : 'A 路径探针：') + (w.error ? 'error' : `${w.pass}/${w.total} pass`), tone: w.error ? 'warning' : 'positive' })
  }
  if (state.picked) {
    const pk = state.picked
    let text = (isEn ? 'Picked: ' : '选择结果：')
    if (pk.status === 'ok' && pk.files?.[0]) {
      const f = pk.files[0]
      text += `${f.name} · ${f.bytes} B · sha256 ${String(f.sha256).slice(0, 12)}… · ${f.ms} ms`
    } else if (pk.status === 'cancelled') {
      text += isEn ? 'cancelled' : '已取消'
    } else {
      text += `${pk.status}${pk.error ? ': ' + pk.error : ''}${pk.files?.[0]?.error ? ': ' + pk.files[0].error : ''}`
    }
    lines.push({ type: 'text', text })
  }
  if (state.scan) {
    const sc = state.scan
    let text = (isEn ? 'Scan: ' : '扫描：')
    if (sc.error) text += 'error: ' + sc.error
    else {
      text += `${sc.entries.length} files`
      for (const e of sc.entries) text += ` · ${e.name.slice(0, 24)} ${e.bytes}B sha ${String(e.sha256).slice(0, 8)}… ${e.dshadata?.version === 5 ? 'v5' : (e.gzipMagic ? 'gz' : 'not-gz')}`
    }
    lines.push({ type: 'text', text, tone: sc.error ? 'warning' : 'positive' })
  }
  return { type: 'stack', children: [
    ...lines,
    { type: 'actions', items: [
      { label: isEn ? 'Capability check' : '能力检查', icon: 'document', action: 'p0cap' },
      { label: isEn ? 'A-path probe' : 'A 路径探针', icon: 'document', action: 'p0write' },
      { label: isEn ? 'B-path probe' : 'B 路径探针', icon: 'document', action: 'p0writeB' },
      { label: isEn ? 'G6 probe' : 'G6 探针', icon: 'document', action: 'p0g6' },
    ] },
    { type: 'actions', items: [
      { label: isEn ? 'Pick backup (files)' : '选择备份（files）', icon: 'document', action: 'pickBackup' },
      { label: isEn ? 'Scan Download/DSHA' : '扫描 Download/DSHA', icon: 'document', action: 'scanDownload' },
    ] },
  ] }
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
  } catch {
    // Reporting must never break the probe itself.
  }
}

async function requireServices() {
  if (!services) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('session persistence services not available')), 15000))
    await Promise.race([servicesReady, timeout])
  }
  if (!services) throw new Error('session persistence services not available')
  return services
}

export function apply(ctx) {
  ctx.inject(['dshGo'], ctx => {
    dshGoCtx = ctx
    ctx.dshGo.panel('migration', {
      view: migrationView,
      data: (scope, emit) => { emit({ cap: shortCap(state.cap), write: state.write && { status: state.write.error ? 'error' : `${state.write.pass}/${state.write.total}` } }) },
      actions: {
        p0cap: async () => {
          const svc = await requireServices()
          state.cap = await runCapabilityCheck(svc)
          await persistReport('capability', state.cap, state.cap.root)
          return { type: 'patch', id: 'p0cap', data: { cap: shortCap(state.cap) } }
        },
        p0write: async () => {
          const svc = await requireServices()
          if (!state.cap) state.cap = await runCapabilityCheck(svc)
          state.write = await runWriteProbeA(svc, state.cap)
          await persistReport('write-a', state.write, state.cap?.root)
          return { type: 'patch', id: 'p0write', data: { write: { status: state.write.error ? 'error' : `${state.write.pass}/${state.write.total}` } } }
        },
        p0writeB: async () => {
          const svc = await requireServices()
          if (!state.cap) state.cap = await runCapabilityCheck(svc)
          state.writeB = await runWriteProbeB(svc, state.cap)
          await persistReport('write-b', state.writeB, state.cap?.root)
          return { type: 'patch', id: 'p0writeB', data: { writeB: { status: state.writeB.error ? 'error' : `${state.writeB.pass}/${state.writeB.total}` } } }
        },
        p0g6: async () => {
          const svc = await requireServices()
          if (!state.cap) state.cap = await runCapabilityCheck(svc)
          state.g6 = await runG6Probe(svc, state.cap)
          await persistReport('g6', state.g6, state.cap?.root)
          return { type: 'patch', id: 'p0g6', data: { g6: state.g6.error ? 'error' : `${state.g6.pass}/${state.g6.total}` } }
        },
        pickBackup: () => ({ type: 'pickFile', action: 'picked', maxFiles: 1 }),
        picked: async (scope, event) => {
          if (!dshGoCtx) throw new Error('dshGo context unavailable')
          const svc = await requireServices()
          if (!state.cap) state.cap = await runCapabilityCheck(svc)
          state.picked = await handlePickedBackup(dshGoCtx, state.cap, event)
          await persistReport('input-picked', state.picked, state.cap?.root)
          const first = state.picked?.files?.[0]
          return { type: 'patch', id: 'picked', data: { picked: state.picked.status === 'ok' ? `${first.name}: ${first.bytes} B sha256 ${first.sha256.slice(0, 12)}` : state.picked.status } }
        },
        scanDownload: async () => {
          const svc = await requireServices()
          if (!state.cap) state.cap = await runCapabilityCheck(svc)
          state.scan = await scanDownloadDir(svc, state.cap)
          await persistReport('input-scan', state.scan, state.cap?.root)
          return { type: 'patch', id: 'scan', data: { scan: state.scan.error ? `error: ${state.scan.error.slice(0, 80)}` : `${state.scan.entries.length} files, ${state.scan.pass} v5` } }
        },
      },
    })
  })

  ctx.inject(['sessionPersistence', 'workspaceRegistry'], svc => {
    services = svc
    notifyServices()
    // Boot-time capability check: runtime evidence without needing the UI.
    // The write probe mutates the target, so it only runs on an explicit
    // action, or on an isolated lab boot that opts in via environment.
    runCapabilityCheck(svc).then(async cap => {
      state.cap = cap
      await persistReport('capability', cap, cap.root)
      if (process.env.DSHA_MIGRATOR_P0_AUTOWRITE === '1') {
        state.write = await runWriteProbeA(svc, cap)
        await persistReport('write-a', state.write, state.cap?.root)
      }
      if (process.env.DSHA_MIGRATOR_P0_AUTOB === '1') {
        state.writeB = await runWriteProbeB(svc, cap)
        await persistReport('write-b', state.writeB, state.cap?.root)
      }
      if (process.env.DSHA_MIGRATOR_P0_B_CHECK_IDS) {
        state.postRestart = await runPostRestartCheck(svc)
        await persistReport('post-restart', state.postRestart, state.cap?.root)
      }
      if (process.env.DSHA_MIGRATOR_P0_AUTOG6 === '1') {
        state.g6 = await runG6Probe(svc, cap)
        await persistReport('g6', state.g6, state.cap?.root)
      }
    }).catch(() => {})
  })
}
