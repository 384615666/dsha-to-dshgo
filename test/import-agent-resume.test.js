// P2 M4 R3: REAL Agent lifecycle acceptance — resume a migrated session
// through the official AgentFactory with a deterministic local mock provider,
// drive one follow-up turn through the normal driver, and verify the engine
// generated the events. This is NOT a hand-appended event batch: the mock
// adapter supplies the model stream and the agent loop writes the durable log.
//
// Env-gated on DSHA_V5_REAL (the user's backup) + RC4_MODULES. No session id,
// cwd, chat text or digest is printed on success.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { importSessionViaA } from '../lib/import/writer-a.js'

const rc4Dir = process.env.RC4_MODULES
const skip = !rc4Dir || !process.env.DSHA_V5_REAL
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex')

const rc4Require = () => createRequire(join(rc4Dir, 'noop.js'))
const importPkg = async name => import(pathToFileURL(rc4Require().resolve(name)).href)

function mockAdapterClass(LlmAdapter) {
  return class MockAdapter extends LlmAdapter {
    constructor() {
      super()
      this.calls = []
    }
    providerInfo(provider) { return { id: provider, name: 'Mock Provider' } }
    async listModels() { return [] }
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: 128_000 },
        defaultMaxTokens: 1024,
      }
    }
    async *stream(options) {
      this.calls.push({ provider: options.provider, model: options.model, messages: options.messages.length })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'mock agent reply' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'mock agent reply' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function mountAgentStack(sessionsRoot) {
  const { Context } = await importPkg('@deepseek-ai/cordis')
  const { AgentRegistry } = await importPkg('@deepseek-ai/dsh-agent')
  const { SessionStore } = await importPkg('@deepseek-ai/dsh-session')
  const llm = await importPkg('@deepseek-ai/dsh-llm')
  const { SystemPrompt } = await importPkg('@deepseek-ai/dsh-system-prompt')
  const { ToolRuntime } = await importPkg('@deepseek-ai/dsh-tools')
  const { SessionProjectionRegistry } = await importPkg('@deepseek-ai/dsh-session-projection')
  const jsonl = await importPkg('@deepseek-ai/dsh-session-persistence-jsonl')
  const { AgentLoop } = await importPkg('@deepseek-ai/dsh-agent-loop')
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(llm.LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(jsonl, { root: sessionsRoot, compression: 'zstd' })
  const MockAdapter = mockAdapterClass(llm.LlmAdapter)
  const adapter = new MockAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  return {
    ctx,
    adapter,
    createUserMessage: llm.createUserMessage,
    async unmount() {
      try { await ctx.fiber?.dispose?.() } catch { /* best effort */ }
    },
  }
}

async function loadRealCandidate(dir) {
  const { readV5Backup } = await import('../lib/archive/v5-reader.js')
  const { SessionStaging } = await import('../lib/archive/session-staging.js')
  const { decompressZstdMultiFrame } = await import('../lib/archive/zstd-frames.js')
  const cat = (await importPkg('@deepseek-ai/dsh-session-format-catalog')).sessionFormatCatalog
  const staging = new SessionStaging(join(dir, 'staging'))
  staging.prepare()
  await readV5Backup(process.env.DSHA_V5_REAL, { makeSink: staging.makeSinkFactory() })
  const verified = await staging.verifyAll()
  assert.equal(verified.failed.length, 0)
  let chosen = null
  for (const entry of verified.staged) {
    const name = entry.path.split('/').at(-1)
    if (!/^session\.v4\.jsonl(?:\.zstd)?$/.test(name)) continue
    const raw = readFileSync(entry.stagedTo)
    const plain = name.endsWith('.zstd') ? decompressZstdMultiFrame(raw) : raw
    const lines = plain.toString('utf8').split('\n').filter(Boolean)
    const restore = cat.createRestore(JSON.parse(lines[0]), { recovery: 'strict', validation: 'current' })
    for (const line of lines.slice(1)) restore.decodeRow(JSON.parse(line))
    const artifact = restore.finish()
    if (artifact.events.length === 596) {
      chosen = { header: artifact.header, events: artifact.events, inheritedEventCount: artifact.inheritedEventCount ?? 0 }
    }
  }
  assert.ok(chosen, 'the 596-event real session is present')
  return chosen
}

async function readAll(persistence, id) {
  const read = await persistence.open(id, 'read')
  try {
    const slice = await read.read()
    return { header: read.header, events: slice.events }
  } finally {
    await read.close()
  }
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('P2 M4 R3: official Agent resume + deterministic mock provider drives a real migrated session', { skip: skip ? 'DSHA_V5_REAL or RC4_MODULES not set' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm4-agent-real-'))
  const stack = await mountAgentStack(join(dir, 'sessions'))
  try {
    const cand = await loadRealCandidate(dir)
    await importSessionViaA(stack.ctx.sessionPersistence, cand)

    const handle = await stack.ctx.agents.resume({
      resumeSessionId: cand.header.id,
      agentOptions: { provider: 'mock', model: 'mock-model' },
    })
    try {
      // Resume loads the persisted log and appends ONE official fork/seed
      // boundary; the migrated prefix must remain byte-for-byte semantic.
      const afterResume = await readAll(stack.ctx.sessionPersistence, cand.header.id)
      assert.equal(afterResume.events.length, cand.events.length + 1, 'resume adds the official seed boundary')
      assert.equal(sha(afterResume.events.slice(0, cand.events.length)), sha(cand.events), 'the migrated history prefix is intact')
      assert.equal(afterResume.events[cand.events.length]?.type, 'session/end-seed')
      assert.equal(afterResume.header.agentPreset, cand.header.agentPreset, 'resume preserves the source preset')

      // Normal driver entry: a durable user message wakes the agent; the
      // engine builds the request, the mock adapter streams, and the loop
      // writes session events. No hand-built assistant/step events here.
      const prompt = 'continue from the migrated history'
      handle.agent.followup(stack.createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      const gotReply = await waitFor(async () => {
        const now = await readAll(stack.ctx.sessionPersistence, cand.header.id)
        return now.events.some(e => e.type === 'assistant/message' && JSON.stringify(e.data).includes('mock agent reply'))
      })
      assert.equal(gotReply, true, 'the agent loop produced the mock model reply')
      await handle.agent.whenIdle()
      assert.equal(stack.adapter.calls.length, 1, 'exactly one model call reached the mock provider')
      assert.equal(stack.adapter.calls[0].provider, 'mock')
      assert.equal(stack.adapter.calls[0].model, 'mock-model')
      assert.ok(stack.adapter.calls[0].messages > 0, 'the request carried derived history')

      const afterTurn = await readAll(stack.ctx.sessionPersistence, cand.header.id)
      assert.equal(sha(afterTurn.events.slice(0, cand.events.length)), sha(cand.events), 'the migrated prefix survives the driven turn')
      assert.ok(afterTurn.events.some(e => e.type === 'user/message' && JSON.stringify(e.data).includes(prompt)), 'the driver persisted the user message')
      assert.ok(afterTurn.events.some(e => e.type === 'assistant/message' && JSON.stringify(e.data).includes('mock agent reply')), 'the driver persisted the model reply')
      const lastTurnEnd = [...afterTurn.events].reverse().find(e => e.type === 'turn/end')
      assert.equal(lastTurnEnd?.data?.reason?.kind, 'completed', 'the driven turn reached a completed terminal')

      // Fresh process-equivalent instance on the same root: the whole
      // continuation is readable through the official backend.
      const jsonl = await importPkg('@deepseek-ai/dsh-session-persistence-jsonl')
      const { Context } = await importPkg('@deepseek-ai/cordis')
      const ctx2 = new Context()
      await ctx2.plugin(jsonl, { root: join(dir, 'sessions'), compression: 'zstd' })
      try {
        const freshRead = await readAll(ctx2.sessionPersistence, cand.header.id)
        assert.equal(sha(freshRead.events), sha(afterTurn.events), 'a fresh instance reads the complete continuation')
        assert.equal(sha(freshRead.events.slice(0, cand.events.length)), sha(cand.events), 'the fresh instance keeps the migrated prefix')
      } finally {
        await ctx2.fiber?.dispose?.()
      }
    } finally {
      await handle.dispose()
    }
  } finally {
    await stack.unmount()
    rmSync(dir, { recursive: true, force: true })
  }
})
