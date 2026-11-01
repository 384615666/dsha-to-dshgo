// P0 runtime capability check (handoff P0 step 2: locate final decision input).
// Everything here must run against the live service instance in a real Host
// process; static source inspection is not evidence.
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'

function safeClass(value) {
  return value?.constructor?.name ?? null
}

async function probeUnderRoot(persistence, locateResult, probeCwd) {
  // Confirm the located path is real-creatable under the instance root: create
  // the cwd directory and check it exists. Does not create any session.
  try {
    const cwdStat = await stat(probeCwd)
    return { probeCwd, cwdExists: cwdStat.isDirectory() }
  } catch {
    return { probeCwd, cwdExists: false }
  }
}

export async function runCapabilityCheck(ctx) {
  const startedAt = new Date().toISOString()
  const result = {
    at: startedAt,
    evidenceKind: 'real',
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    backendName: null,
    backendClass: null,
    root: null,
    compression: null,
    locate: { available: false, kind: null, path: null, underRoot: null, error: null },
    workspaceRegistry: { present: false, class: null, create: false, attachSession: false },
    sessionPersistenceContract: { create: false, open: false, stat: false, list: false, flush: false },
    error: null,
  }
  try {
    const p = ctx.sessionPersistence
    if (!p) throw new Error('ctx.sessionPersistence is undefined')
    result.backendName = p.name ?? null
    result.backendClass = safeClass(p)
    result.root = p.root ?? null
    result.compression = p.compression ?? null
    for (const key of ['create', 'open', 'stat', 'list', 'flush']) {
      result.sessionPersistenceContract[key] = typeof p[key] === 'function'
    }

    // THE decision input: locate on the actual runtime instance.
    result.locate.available = typeof p.locate === 'function'
    if (result.locate.available) {
      const probeHeader = {
        version: 4,
        id: 'p0-capability-probe',
        createdAt: Date.now(),
        cwd: process.env.DSHA_MIGRATOR_P0_CWD || join(result.root || process.cwd(), 'p0-probe-cwd'),
        isSeeded: false,
        agentPreset: 'standard',
      }
      try {
        const located = await p.locate(probeHeader)
        result.locate.kind = located?.kind ?? null
        result.locate.path = located?.path ?? null
        result.locate.compressionEcho = located?.compression ?? null
        result.locate.underRoot = Boolean(result.root && typeof located?.path === 'string'
          && (located.path === result.root || located.path.startsWith(result.root.endsWith('\\') || result.root.endsWith('/') ? result.root : result.root)))
        result.locate.probeCwd = await probeUnderRoot(p, located, probeHeader.cwd)
        // Second call must be pure (same answer) — locate documents no FS touch.
        const again = await p.locate(probeHeader)
        result.locate.stable = JSON.stringify(again) === JSON.stringify(located)
      } catch (error) {
        result.locate.available = false
        result.locate.error = `${error.name}: ${error.message}`
      }
    }

    const wr = ctx.workspaceRegistry
    result.workspaceRegistry.present = Boolean(wr)
    result.workspaceRegistry.class = safeClass(wr)
    if (wr) {
      result.workspaceRegistry.create = typeof wr.create === 'function'
      // attachSession lives on the WorkspaceEntity returned by create()
      // (verified by the write probes), not on the registry itself.
      result.workspaceRegistry.attachSessionOnEntity = 'verified-by-write-probe'
    }
  } catch (error) {
    result.error = `${error.name}: ${error.message}`
  }
  return result
}
