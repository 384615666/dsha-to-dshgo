// Protected session withdrawal adapter (P2 batch 3) — closes the
// probe→close→move window: exclusivity is HELD ACROSS the move instead of
// being probed and released first.
//
// Contract with the rollback orchestrator (lib/import/g6.js):
//   withdraw(id, { expectedRevision, cwd }) — resolves when the session
//   object has been moved out of the active namespace into the job's
//   quarantine area. Throws:
//     code WITHDRAW_NOT_SAFE  — cannot prove safety (active owner, revision
//                               changed, unknown evidence): nothing was moved
//                               and the batch must stay pending;
//     any other error          — a real failure (I/O), also not a success.
//   The function carries `protected = true`, telling the orchestrator that
//   the exclusivity proof is part of the adapter (no external open→close
//   probe is added).
//
// The measured mechanism for the jsonl backend is a directory MOVE (rename)
// of the backend-located session directory into the quarantine root; the
// payload stays recoverable, never deleted. SessionPersistence has no delete
// or transaction API — this adapter is the backend-specific measured
// capability, not an assumed generic one.
//
// Ownership is the service's own write lease: a second write open is refused
// with SessionAlreadyOwnedError while an owner exists. Holding OUR write
// lease for the whole critical section means no other caller can acquire
// ownership, so no user append can land between the checks and the move.
// Revision is re-verified AFTER acquisition (and again after any async work)
// so content that changed before we acquired the lease is not withdrawn.
//
// `hooks.afterAcquire` is a TEST SEAM: it runs while the lease is held and
// before the move, letting a test schedule a competing writer deterministically.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

function coded(code, message, extra = {}) {
  const e = new Error(message)
  e.code = code
  Object.assign(e, extra)
  return e
}

// Quarantine objects get a SAFE single-segment name derived from the id's
// content digest — NEVER the raw session id (a legal official id may contain
// slashes or dot segments; joining it into a path either fails or escapes the
// quarantine root). The id itself is preserved in the ownership record.
export function quarantineNameFor(id) {
  return `object-${createHash('sha256').update(String(id)).digest('hex').slice(0, 32)}`
}

// Strictly-inside check on the RESOLVED path: not the root itself, no escape
// after normalization.
function assertInside(parent, child, what) {
  const p = resolve(parent)
  const c = resolve(child)
  if (c === p || !c.startsWith(p + sep)) {
    throw coded('WITHDRAW_UNSAFE_PATH', `${what} resolves outside the permitted root`)
  }
  return c
}

/**
 * @param {object} params
 * @param {object} params.persistence - the target sessionPersistence.
 * @param {string} params.sessionsRoot - the backend's configured root.
 * @param {(header: {cwd: string, id: string}) => string} params.locateDir -
 *   official locate() projection: '/'-separated directory relative to root.
 * @param {string} params.quarantineRoot - job-private rollback area.
 * @param {{ afterAcquire?: (ctx: {id: string}) => Promise<void> }} [params.hooks]
 */
export function createJsonlWithdrawalAdapter({ persistence, sessionsRoot, locateDir, quarantineRoot, hooks = {} }) {
  const root = resolve(sessionsRoot)
  const quarantine = resolve(quarantineRoot)

  const withdraw = async (id, { expectedRevision, cwd } = {}) => {
    if (typeof expectedRevision !== 'string' || expectedRevision === '') {
      throw coded('WITHDRAW_NOT_SAFE', 'no write-after revision evidence — cannot prove the session is unchanged since our write')
    }
    if (typeof cwd !== 'string' || cwd === '') {
      throw coded('WITHDRAW_NOT_SAFE', 'no cwd evidence for the official location — cannot derive the session directory safely')
    }
    // 1) Acquire the write lease. If another owner exists, the service
    //    refuses — that is the exclusivity proof the probe could not hold.
    let handle
    try {
      handle = await persistence.open(id, 'write')
    } catch (error) {
      if (/already owned|SessionAlreadyOwned/i.test(`${error?.name ?? ''} ${error?.message ?? ''}`)) {
        throw coded('WITHDRAW_NOT_SAFE', 'an active write owner holds this session — withdrawal withheld')
      }
      throw error
    }
    let moved = false
    try {
      // 2) Verify the revision WHILE holding the lease.
      const snap = await persistence.stat(id)
      if ((snap?.revision ?? null) !== expectedRevision) {
        throw coded('WITHDRAW_NOT_SAFE', `session revision changed (expected ${expectedRevision}, current ${snap?.revision ?? 'none'}) — withdrawal withheld`)
      }
      // 3) Test seam: a competing writer may try to acquire during this
      //    window; with our lease held the service must refuse it.
      if (typeof hooks.afterAcquire === 'function') await hooks.afterAcquire({ id })
      // 4) Re-verify after any async work — still unchanged and still ours.
      const snap2 = await persistence.stat(id)
      if ((snap2?.revision ?? null) !== expectedRevision) {
        throw coded('WITHDRAW_NOT_SAFE', 'session revision changed during the critical section — withdrawal withheld')
      }
      // 5) Move the backend-located directory into quarantine WHILE the lease
      //    is still held. No probe→close gap exists.
      const rel = locateDir({ cwd, id })
      const src = assertInside(root, resolve(root, rel), 'the source session directory')
      if (!existsSync(src)) throw new Error(`session directory not found for ${id}`)
      mkdirSync(quarantine, { recursive: true, mode: 0o700 })
      const dest = assertInside(quarantine, join(quarantine, quarantineNameFor(id)), 'the quarantine target')
      if (existsSync(dest)) {
        // Never overwrite an earlier quarantined payload; a previous attempt
        // already holds it and needs a judgment, not a second move.
        throw coded('WITHDRAW_NOT_SAFE', `quarantine already holds a payload for ${id} — manual judgment required`)
      }
      try {
        renameSync(src, dest)
      } catch (error) {
        if (error?.code === 'EXDEV') {
          cpSync(src, dest, { recursive: true })
          rmSync(src, { recursive: true, force: true })
        } else throw error
      }
      moved = true
      // Ownership record NEXT TO (not inside) the payload: the raw id lives
      // in a semantic field, never in a path, and the moved directory stays
      // byte-identical for a later restore. Written after the move so a
      // failed move never claims an object.
      const name = quarantineNameFor(id)
      writeFileSync(join(quarantine, `${name}.owner.json`), JSON.stringify({
        sourceId: id,
        object: name,
        revision: expectedRevision,
        cwd,
        quarantinedAt: new Date().toISOString(),
      }), { mode: 0o600 })
      return { id, quarantinedTo: dest, revision: expectedRevision }
    } finally {
      // 6) Release the lease AFTER the move. A close failure here cannot undo
      //    the move and must not be read as a safety proof either way.
      try {
        await handle.close()
      } catch (error) {
        if (!moved) throw error
      }
    }
  }
  // Marker consumed by the rollback orchestrator: exclusivity is inside.
  withdraw.protected = true
  return withdraw
}
