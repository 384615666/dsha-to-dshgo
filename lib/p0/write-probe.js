// P0 A-path write probe: sessionPersistence.create → append(validated events)
// → flush → close → open(read) full readback → workspace attach.
// Runs only against the sessionPersistence instance of the booted Host; safe
// against a live home only insofar as IDs are p0-probe-* and probe cwd is a
// dedicated directory. The lab boots with an isolated DSH_HOME.
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'

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
    r.steps.create = { ok: true, access: handle.access, inheritedEventCount: handle.inheritedEventCount }
    await handle.flush()
    r.steps.flush = { ok: true }
    await handle.close()
    r.steps.close = { ok: true }

    const read = await persistence.open(r.id, 'read')
    const slice = await read.read()
    const h = read.header
    r.steps.readback = {
      ok: true,
      headerMatch: h.version === header.version && h.id === header.id && h.cwd === header.cwd
        && h.isSeeded === header.isSeeded && h.agentPreset === header.agentPreset,
      eventCount: slice.events.length,
    }
    await read.close()

    const list = await persistence.list()
    r.steps.list = { ok: true, visible: list.some(s => s.header.id === r.id), total: list.length }
    const snap = await persistence.stat(r.id)
    r.steps.stat = { ok: true, found: Boolean(snap), eventCount: snap?.eventCount ?? null, formatStatus: snap?.formatStatus ?? null }

    const reg = await ctx.workspaceRegistry.create(cwd, 'DSHA 迁移 P0 探针')
    await reg.attachSession(r.id)
    r.steps.attach = { ok: true, workspace: reg.id ?? null }
  } catch (error) {
    r.error = `${error.name}: ${error.message}`
  }
  r.pass = Object.values(r.steps).filter(s => s && s.ok).length
  return r
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
    r.steps.readback = {
      ok: true,
      eventCount: slice.events.length,
      countMatch: slice.events.length === events.length,
      hashMatch: hash(slice.events) === r.sentHash,
      seqContiguous: slice.events.every((e, i) => e.seq === i),
    }
    await read.close()

    const list = await persistence.list()
    r.steps.list = { ok: true, visible: list.some(s => s.header.id === r.id) }

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
  r.pass = Object.values(r.steps).filter(s => s && s.ok).length
  return r
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
  const result = { at: startedAt, evidenceKind: 'real', path: 'A-service-replay', probes: [], pass: 0, total: 0, error: null }
  try {
    const persistence = ctx.sessionPersistence
    const cwd = await resolveProbeCwd(persistence)
    result.cwd = cwd
    const ws = await workspaceFor(ctx, cwd)
    result.workspace = ws
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
  return result
}
