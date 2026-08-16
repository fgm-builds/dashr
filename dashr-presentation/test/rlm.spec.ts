import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import { FakeCellRuntime, fakeRuntime, runCell, setup } from './helpers.ts'

/**
 * M3-B rlm()/rlm_await() binding (blueprint §9): the host-plane subagents
 * capability exposed as bare callable globals inside a run_cell program. The
 * tests register a lightweight stub `ctx.subagents` service on the ROOT realm
 * (the host plane) — the presentation row lives inside the preset's
 * entry-local realm and resolves the root service through cordis's outward
 * realm walk, which is the exact realm-boundary fact these tests also pin.
 */

/** One admitted stub run with controllable settlement. */
interface StubRun {
  id: string
  localAgent: Agent | undefined
  result: Promise<{ output: ContentBlock[], structured?: unknown, stopReason: string }>
  dispose(): Promise<void>
}

/** Mount a stub `ctx.subagents` service (root realm) whose `start` records calls. */
async function registerStubSubagents(
  ctx: Context,
  start: (name: string, request: { label?: string, prompt: ContentBlock[], parent: Agent, signal: AbortSignal }) => Promise<StubRun>,
): Promise<void> {
  const fiber = await ctx.plugin({ name: 'stub-subagents', apply(c) {
    c.provide('subagents', { start })
  } })
  onTestFinished(() => fiber.dispose())
}

/** A stub provider that resolves immediately with a fixed text answer. */
function immediateProvider(label: string): { start: (name: string, request: { label?: string, prompt: ContentBlock[], parent: Agent, signal: AbortSignal }) => Promise<StubRun> } {
  return {
    async start(name, request) {
      const prompt = request.prompt.map(block => (block.type === 'text' ? block.text : '')).join('')
      return {
        id: `stub-${name}-${label}`,
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: `child:${prompt}` }], stopReason: 'completed' }),
        dispose: () => Promise.resolve(),
      }
    },
  }
}

/** Drive one `run_cell` through the registry pipeline, as the agent loop would. */
async function cell(ctx: Context, agent: Agent, code: string): Promise<{ value: { logs: string[], result?: unknown }, content: { type: string, text?: string }[] }> {
  const result = await runCell(ctx, code, { agent })
  expect(result.isError, `cell failed: ${JSON.stringify(result.content)}`).toBe(false)
  return {
    value: result.value as { logs: string[], result?: unknown },
    content: result.content as { type: string, text?: string }[],
  }
}

describe('rlm() / rlm_await() binding', () => {
  it('admits a child non-blocking and awaits its result through the shared registry', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    await registerStubSubagents(ctx, immediateProvider('run-1').start)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime

    runtime.behavior = async (request) => {
      const rlm = request.bindings.find(binding => binding.global === 'rlm')!
      const rlmAwait = request.bindings.find(binding => binding.global === 'rlm_await')!
      const handle = await rlm.functions['__call__']!({ args: ['do the thing'], kwargs: { label: 'worker' } })
      const awaited = await rlmAwait.functions['__call__']!({ args: [(handle as { run_id: string }).run_id], kwargs: {} })
      // A second await on the same id must be an unknown-run error (cleaned up).
      const again = await rlmAwait.functions['__call__']!({ args: [(handle as { run_id: string }).run_id], kwargs: {} })
      return { logs: [], value: { handle, awaited, again } }
    }

    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({
      handle: { run_id: 'stub-spawn-run-1', label: 'worker', provider: 'spawn', local: false },
      awaited: { output: 'child:do the thing', stop_reason: 'completed', structured: null },
      again: { output: null, stop_reason: 'error', structured: null, error: expect.stringContaining('unknown or already-settled') },
    })
  })

  it('returns a structured error (never a host crash) when no ctx.subagents is mounted', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime

    runtime.behavior = async (request) => {
      const rlm = request.bindings.find(binding => binding.global === 'rlm')!
      const handle = await rlm.functions['__call__']!({ args: ['task'], kwargs: {} })
      return { logs: [], value: handle }
    }

    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ error: expect.stringContaining('no ctx.subagents service') })
  })

  it('maps a provider start rejection onto the result error field', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    await registerStubSubagents(ctx, async () => {
      throw new Error('no provider named spawn')
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime

    runtime.behavior = async (request) => {
      const rlm = request.bindings.find(binding => binding.global === 'rlm')!
      const handle = await rlm.functions['__call__']!({ args: ['task'], kwargs: {} })
      return { logs: [], value: handle }
    }

    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ error: expect.stringContaining('rlm() start failed: no provider named spawn') })
  })

  it('validates the bare-callable signature host-side (label is keyword-only)', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    await registerStubSubagents(ctx, immediateProvider('never').start)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime

    runtime.behavior = async (request) => {
      const rlm = request.bindings.find(binding => binding.global === 'rlm')!
      const two = await rlm.functions['__call__']!({ args: ['prompt', 'second'], kwargs: {} })
      const badLabel = await rlm.functions['__call__']!({ args: ['prompt'], kwargs: { label: 42 } })
      return { logs: [], value: { two, badLabel } }
    }

    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({
      two: { error: expect.stringContaining('exactly one positional prompt string') },
      badLabel: { error: expect.stringContaining('label must be a string or None') },
    })
  })

  it('threads the parent agent and the run signal into the subagents start call', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const seen: { parent: Agent | undefined, signal: AbortSignal | undefined, prompt: string }[] = []
    await registerStubSubagents(ctx, async (_name, request) => {
      seen.push({ parent: request.parent, signal: request.signal, prompt: request.prompt[0]!.type === 'text' ? request.prompt[0]!.text : '' })
      return {
        id: 'stub-parent',
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
        dispose: () => Promise.resolve(),
      }
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime

    runtime.behavior = async (request) => {
      const rlm = request.bindings.find(binding => binding.global === 'rlm')!
      const handle = await rlm.functions['__call__']!({ args: ['parent task'], kwargs: {} })
      return { logs: [], value: handle }
    }

    await cell(ctx, agent.agent, 'program')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.parent).toBe(agent.agent)
    expect(seen[0]!.prompt).toBe('parent task')
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it('disposes live runs owned by a session on agent/disposed', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const disposed: string[] = []
    await registerStubSubagents(ctx, async () => ({
      id: 'stub-dispose',
      localAgent: undefined,
      result: new Promise(() => {}), // never settles: still live when the session ends
      dispose: () => { disposed.push('stub-dispose'); return Promise.resolve() },
    }))
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime

    runtime.behavior = async (request) => {
      const rlm = request.bindings.find(binding => binding.global === 'rlm')!
      return { logs: [], value: await rlm.functions['__call__']!({ args: ['task'], kwargs: {} }) }
    }
    await cell(ctx, agent.agent, 'program')

    // The same untyped event the runtime provider listens for.
    ctx.events.emit('agent/disposed', { agent: { id: 'dasher-agent' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(disposed).toEqual(['stub-dispose'])
  })
})
