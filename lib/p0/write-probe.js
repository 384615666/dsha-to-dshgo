// P0 A-path write probe: sessionPersistence.create → append(validated events)
// → flush → close → open(read) full readback → workspace attach.
// Runs only against the sessionPersistence instance of the booted Host; safe
// against a live home only insofar as IDs are p0-probe-* and probe cwd is a
// dedicated directory. The lab boots with an isolated DSH_HOME.
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

// Version stamped into every report so old reports stay distinguishable.
export const PROBE_VERSION = createRequire(import.meta.url)('../../package.json').version

const REQUIRED_STEPS = {
  'empty-session': ['create', 'flush', 'close', 'readback', 'list', 'stat', 'attach'],
  'real-v4-events': ['create', 'append', 'flush', 'close', 'readback', 'list', 'attach', 'reopenWrite'],
  'real-v4-events-new-id-negative-control': ['create', 'appendFlushClose', 'readbackRefused'],
}

// A probe passes only when (a) every REQUIRED step ran and asserted true
// (missing steps are recorded as skipped failures, so an early exception can
// never yield pass===total) and (b) the probe did not itself throw.
function score(r) {
  const required = REQUIRED_STEPS[r.name] ?? []
  for (const key of required) {
    if (!r.steps?.[key]) r.steps[key] = { ok: false, skipped: true }
  }
  const keys = Object.keys(r.steps)
  r.total = keys.length
  r.pass = keys.filter(k => r.steps[k]?.ok === true).length
  r.verdict = !r.error && r.pass === r.total ? 'pass' : 'failed'
  if (r.error) r.verdictError = r.error
  return r
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function resolveProbeCwd(persistence) {
  const configured = process.env.DSHA_MIGRATOR_P0_CWD
  const cwd = configured || join(dirname(persistence.root || process.cwd()), 'p0-probe-cwd')
  await mkdir(cwd, { recursive: true })
  return cwd
}

async function workspaceFor(ctx, cwd) {
  const registry = ctx.workspaceRegistry
  if (!registry || typeof registry.create !== 'function') return { ok: false, error: 'workspaceRegistry.create unavailable' }
  const workspace = await registry.create(cwd, 'DSHA 迁移 P0 探针')
  return { ok: true, id: workspace?.id ?? null, class: workspace?.constructor?.name ?? null }
}

// Probe 1: empty session end-to-end (create/flush/close/read/list/stat/attach).
async function probeEmpty(ctx, persistence, cwd, stamp) {
  const r = { name: 'empty-session', id: `p0-probe-empty-${stamp}`, steps: {}, pass: 0, total: 6 }
  try {
    const header = {
      version: 4,
      id: r.id,
      createdAt: Date.now(),
      cwd,
      isSeeded: false,
      agentPreset: 'standard',
    }
    const handle = await persistence.create(header, { inheritedEventCount: 0 })
    r.steps.create = { ok: handle.access === 'write', access: handle.access, inheritedEventCount: handle.inheritedEventCount }
    await handle.flush()
    r.steps.flush = { ok: true }
    await handle.close()
    r.steps.close = { ok: true }

    const read = await persistence.open(r.id, 'read')
    const slice = await read.read()
    const h = read.header
    const headerMatch = h.version === header.version && h.id === header.id && h.cwd === header.cwd
      && h.isSeeded === header.isSeeded && h.agentPreset === header.agentPreset
    r.steps.readback = {
      ok: headerMatch && slice.events.length === 0,
      headerMatch,
      eventCount: slice.events.length,
    }
    await read.close()

    const list = await persistence.list()
    const visible = list.some(s => s.header.id === r.id)
    r.steps.list = { ok: visible, visible, total: list.length }
    const snap = await persistence.stat(r.id)
    r.steps.stat = { ok: Boolean(snap), found: Boolean(snap), eventCount: snap?.eventCount ?? null, formatStatus: snap?.formatStatus ?? null }

    const reg = await ctx.workspaceRegistry.create(cwd, 'DSHA 迁移 P0 探针')
    await reg.attachSession(r.id)
    r.steps.attach = { ok: true, workspace: reg.id ?? null }
  } catch (error) {
    r.error = `${error.name}: ${error.message}`
  }
  return score(r)
}

// Probe 2: pre-validated real v4 events appended through the service, full
// readback compared by count/seq/hash. Preserves the SOURCE session id — the
// migration plan keeps original session/message/call/job IDs, and real logs
// carry cross-session references (delivery markers) that must name the same
// session. Never logs event content.
async function probeRealEvents(ctx, persistence, cwd, fixture) {
  const r = {
    name: 'real-v4-events',
    id: fixture.name,
    source: fixture.name,
    steps: {},
    pass: 0,
    total: 7,
  }
  try {
    const events = fixture.events
    r.sentCount = events.length
    r.sentHash = hash(events)
    const header = {
      version: 4,
      id: r.id,
      createdAt: fixture.header?.createdAt ?? Date.now(),
      cwd,
      isSeeded: fixture.header?.isSeeded ?? false,
      agentPreset: fixture.header?.agentPreset ?? 'standard',
    }
    const handle = await persistence.create(header, { inheritedEventCount: 0 })
    r.steps.create = { ok: true }
    await handle.append(events)
    r.steps.append = { ok: true }
    await handle.flush()
    r.steps.flush = { ok: true }
    await handle.close()
    r.steps.close = { ok: true }

    const read = await persistence.open(r.id, 'read')
    const slice = await read.read()
    const countMatch = slice.events.length === events.length
    const hashMatch = hash(slice.events) === r.sentHash
    const seqContiguous = slice.events.every((e, i) => e.seq === i)
    r.steps.readback = {
      ok: countMatch && hashMatch && seqContiguous,
      eventCount: slice.events.length,
      countMatch,
      hashMatch,
      seqContiguous,
    }
    await read.close()

    const list = await persistence.list()
    const visible = list.some(s => s.header.id === r.id)
    r.steps.list = { ok: visible, visible }

    const reg = await ctx.workspaceRegistry.create(cwd, 'DSHA 迁移 P0 探针')
    await reg.attachSession(r.id)
    r.steps.attach = { ok: true, workspace: reg.id ?? null }
    r.steps.reopenWrite = await (async () => {
      try {
        const wh = await persistence.open(r.id, 'write')
        await wh.close()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: `${error.name}: ${error.message}` }
      }
    })()
  } catch (error) {
    r.error = `${error.name}: ${error.message}`
  }
  return score(r)
}

// Negative control: same real events written under a NEW session id. Real
// logs carry cross-session references (delivery markers) naming the source
// session, so the service must refuse the readback. Documents why the
// migration preserves source session IDs (plan §8) instead of inventing IDs.
async function probeRealEventsNewId(ctx, persistence, cwd, fixture) {
  const r = {
    name: 'real-v4-events-new-id-negative-control',
    id: `p0-renamed-${fixture.name}`,
    source: fixture.name,
    expected: 'readback refused (delivery marker names the original session)',
    steps: {},
    pass: 0,
    total: 2,
  }
  try {
    const header = {
      version: 4,
      id: r.id,
      createdAt: Date.now(),
      cwd,
      isSeeded: false,
      agentPreset: fixture.header?.agentPreset ?? 'standard',
    }
    const handle = await persistence.create(header, { inheritedEventCount: 0 })
    r.steps.create = { ok: true }
    await handle.append(fixture.events)
    await handle.flush()
    await handle.close()
    r.steps.appendFlushClose = { ok: true }
    try {
      const read = await persistence.open(r.id, 'read')
      const slice = await read.read()
      r.steps.readbackRefused = { ok: false, unexpectedCount: slice.events.length, note: 'readback unexpectedly succeeded' }
      await read.close()
    } catch (error) {
      r.steps.readbackRefused = { ok: true, errorClass: error.constructor?.name ?? error.name, message: error.message.slice(0, 200) }
    }
  } catch (error) {
    r.error = `${error.name}: ${error.message}`
  }
  r.pass = Object.values(r.steps).filter(s => s && s.ok).length
  return r
}

export async function runWriteProbeA(ctx, cap) {
  void cap
  const startedAt = new Date().toISOString()
  const result = { at: startedAt, evidenceKind: 'real', probeVersion: PROBE_VERSION, path: 'A-service-replay', probes: [], pass: 0, total: 0, verdict: 'pass', error: null }
  try {
    const persistence = ctx.sessionPersistence
    const cwd = await resolveProbeCwd(persistence)
    result.cwd = cwd
    // A registry failure must not abort the whole probe run: record it and
    // keep scoring the persistence steps.
    try {
      result.workspace = await workspaceFor(ctx, cwd)
    } catch (error) {
      result.workspace = { ok: false, error: `${error.name}: ${error.message}` }
    }
    const stamp = Date.now().toString(36)

    result.probes.push(await probeEmpty(ctx, persistence, cwd, stamp))

    const eventsPath = process.env.DSHA_MIGRATOR_P0_EVENTS
    if (eventsPath) {
      const data = JSON.parse(await readFile(eventsPath, 'utf8'))
      const fixtures = data.fixtures ?? [data]
      const st = await stat(eventsPath)
      for (const fixture of fixtures) {
        result.probes.push(await probeRealEvents(ctx, persistence, cwd, { name: fixture.name, header: fixture.header, events: fixture.events, bytes: st.size }))
      }
      result.probes.push(await probeRealEventsNewId(ctx, persistence, cwd, { name: fixtures[0].name, header: fixtures[0].header, events: fixtures[0].events }))
    } else {
      result.probes.push({ name: 'real-v4-events', skipped: 'DSHA_MIGRATOR_P0_EVENTS not set' })
    }
  } catch (error) {
    result.error = `${error.name}: ${error.message}`
  }
  const scored = result.probes.filter(p => p.total)
  result.total = scored.reduce((a, p) => a + p.total, 0)
  result.pass = scored.reduce((a, p) => a + p.pass, 0)
  // Aggregate verdict: any probe that threw or is not a full pass fails the
  // whole run — pass/total alone must never read as success.
  const failedProbes = scored.filter(p => p.verdict !== 'pass')
  if (result.error || failedProbes.length > 0) {
    result.verdict = 'failed'
    result.error = result.error
      ?? failedProbes.map(p => `${p.name}: ${p.error ?? `incomplete (${p.pass}/${p.total})`}`).join('; ')
  }
  return result
}
