// P0 B-path probe (B1 confirmed by the runtime locate check): place
// pre-validated v4 bytes at the path computed by THIS backend instance's
// locate(header) — no path constructor replication — then verify cold
// list/open(read) visibility while the Host is running. Bytes variants:
// 'original' (no header mapping, original cwd) and 'remapped' (re-encoded
// header with mapped cwd, re-validated by the catalog during prep).
import { mkdir, readFile, stat, open as fsOpen } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

export const PROBE_VERSION = createRequire(import.meta.url)('../../package.json').version

// Every step's ok must BE the assertion result (visible/found/hash match...),
// never "the call did not throw".
function score(r) {
  const keys = Object.keys(r.steps ?? {})
  r.total = keys.length
  r.pass = keys.filter(k => r.steps[k]?.ok === true).length
  return r
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function placeFileNoOverwrite(destPath, bytes) {
  await mkdir(dirname(destPath), { recursive: true })
  const handle = await fsOpen(destPath, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function runWriteProbeB(ctx, cap) {
  void cap
  const result = { at: new Date().toISOString(), evidenceKind: 'real', probeVersion: PROBE_VERSION, path: 'B-file-placement', probes: [], pass: 0, total: 0, error: null }
  try {
    const persistence = ctx.sessionPersistence
    const manifestPath = process.env.DSHA_MIGRATOR_P0_B_MANIFEST
    if (!manifestPath) throw new Error('DSHA_MIGRATOR_P0_B_MANIFEST not set')
    const baseDir = process.env.DSHA_MIGRATOR_P0_B_BYTES
    if (!baseDir) throw new Error('DSHA_MIGRATOR_P0_B_BYTES not set')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const mode = process.env.DSHA_MIGRATOR_P0_B_MODE || 'remapped'

    for (const entry of manifest.entries) {
      const r = { name: `b-placement-${mode}`, id: entry.id, source: entry.relDir, steps: {}, pass: 0, total: 5 }
      try {
        const bytesPath = join(baseDir, mode, entry.id, 'session.v4.jsonl.zstd')
        const bytes = await readFile(bytesPath)
        const cwd = mode === 'original' ? entry.cwdOriginal : entry.cwdMapped
        const located = await persistence.locate({ version: 4, id: entry.id, cwd, isSeeded: false })
        r.locatedPath = located?.path ?? null
        r.locatedKind = located?.kind ?? null
        let pre = null
        try { pre = await stat(located.path) } catch { /* absent — required */ }
        r.steps.precheckAbsent = { ok: !pre }
        await placeFileNoOverwrite(located.path, bytes)
        r.steps.placed = { ok: true, bytes: bytes.length }

        const list = await persistence.list()
        const visible = list.some(s => s.header.id === entry.id)
        r.steps.list = { ok: visible, visible, total: list.length }

        const read = await persistence.open(entry.id, 'read')
        const slice = await read.read()
        const countMatch = slice.events.length === entry.eventCount
        const hashMatch = hash(slice.events) === entry.eventsSha256
        const seqContiguous = slice.events.every((e, i) => e.seq === i)
        r.steps.readback = {
          ok: countMatch && hashMatch && seqContiguous,
          eventCount: slice.events.length,
          expectedCount: entry.eventCount,
          countMatch,
          hashMatch,
          seqContiguous,
          headerCwd: read.header.cwd ?? null,
        }
        await read.close()

        const snap = await persistence.stat(entry.id)
        const formatCurrent = snap?.formatStatus === 'current'
        r.steps.stat = { ok: Boolean(snap) && formatCurrent, found: Boolean(snap), formatStatus: snap?.formatStatus ?? null }
      } catch (error) {
        r.error = `${error.name}: ${error.message}`
      }
      result.probes.push(score(r))
    }

    // Workspace attach for the mapped cwd only (original cwd does not exist on
    // this machine — realpath validation must refuse it; that refusal is
    // expected and recorded as its own evidence).
    // Workspace attach is a scored branch step: the mapped cwd MUST succeed;
    // the original Android cwd attach is EXPECTED to fail here (realpath
    // validation), and expected-failure counts as a passing assertion.
    result.workspaceAttach = { name: 'workspace-attach', steps: {} }
    try {
      const registry = ctx.workspaceRegistry
      const mapped = manifest.entries[0]
      const ws = await registry.create(mapped.cwdMapped, 'DSHA 迁移 P0 探针')
      await ws.attachSession(mapped.id)
      result.workspaceAttach.steps.mappedAttach = { ok: true, workspace: ws.id ?? null }
      try {
        const wsOrig = await registry.create(manifest.entries[1].cwdOriginal ?? manifest.entries[0].cwdOriginal, 'DSHA 迁移 P0 原始 cwd')
        await wsOrig.attachSession(manifest.entries[0].id)
        result.workspaceAttach.steps.originalRefused = { ok: false, note: 'original cwd unexpectedly resolved' }
      } catch (error) {
        result.workspaceAttach.steps.originalRefused = { ok: true, expected: true, refused: true, errorClass: error.constructor?.name ?? error.name }
      }
    } catch (error) {
      result.workspaceAttach.steps.mappedAttach = { ok: false, error: `${error.name}: ${error.message}` }
    }
    result.probes.push(score(result.workspaceAttach))
  } catch (error) {
    result.error = `${error.name}: ${error.message}`
  }
  const scored = result.probes.filter(p => p.total)
  result.total = scored.reduce((a, p) => a + p.total, 0)
  result.pass = scored.reduce((a, p) => a + p.pass, 0)
  return result
}

// Post-restart visibility check: B-placed files must still be listable and
// readable after a full Host restart (cache/index rebuild by the target).
export async function runPostRestartCheck(ctx) {
  const result = { at: new Date().toISOString(), evidenceKind: 'real', path: 'B-post-restart', checks: [], pass: 0, total: 0, error: null }
  try {
    const persistence = ctx.sessionPersistence
    const idsPath = process.env.DSHA_MIGRATOR_P0_B_CHECK_IDS
    if (!idsPath) throw new Error('DSHA_MIGRATOR_P0_B_CHECK_IDS not set')
    const { expected } = JSON.parse(await readFile(idsPath, 'utf8'))
    const list = await persistence.list()
    for (const item of expected) {
      const check = { id: item.id, inList: list.some(s => s.header.id === item.id) }
      try {
        const read = await persistence.open(item.id, 'read')
        const slice = await read.read()
        check.openRead = true
        check.eventCount = slice.events.length
        check.countMatch = slice.events.length === item.eventCount
        check.hashMatch = hash(slice.events) === item.eventsSha256
        await read.close()
      } catch (error) {
        check.openRead = false
        check.error = `${error.name}: ${error.message.slice(0, 200)}`
      }
      result.checks.push(check)
      result.total += 2
      result.pass += (check.inList ? 1 : 0) + (check.openRead && check.countMatch && check.hashMatch ? 1 : 0)
    }
  } catch (error) {
    result.error = `${error.name}: ${error.message}`
  }
  return result
}
