import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm'
import { FakeCellRuntime, fakeRuntime, runCell, setup, setupKernel } from './helpers.ts'
import type { RlmJsonValue } from '../src/runtime-surface.ts'

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
      handle: { run_id: 'stub-spawn-run-1', label: 'worker', provider: 'spawn', local: false, model: null },
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

describe('rlm() child-model selection (M4-A three-level priority)', () => {
  /**
   * The priority ladder `rlm(model=...) > config.subagentModel > parent
   * inheritance` reduces to what the start request carries: `agentOptions:
   * { model }` with the winning value, or NO `agentOptions` key at all —
   * the omission IS the inheritance tier, because dsh's
   * `resolveChildAgentOptions` spreads the parent's route only when the
   * request leaves it unset. Every case below captures the request through
   * a recording stub and asserts exactly that observable.
   */
  interface CapturedStart {
    label?: unknown
    agentOptions?: { model?: string }
    hasAgentOptionsKey: boolean
  }

  async function admitWith(config: { subagentModel?: string }, kwargs: Record<string, unknown>): Promise<{ handle: RlmJsonValue | undefined, starts: CapturedStart[] }> {
    // The RAW request objects are kept: key-presence must be observed on
    // what the bridge actually sent, before any recording layer could
    // re-add an `agentOptions: undefined` key of its own.
    const rawStarts: { label?: unknown, agentOptions?: { model?: string } }[] = []
    const { ctx, agent } = await setup(fakeRuntime, config)
    await registerStubSubagents(ctx, async (_name, request) => {
      rawStarts.push(request)
      return {
        id: 'stub-model',
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
        dispose: () => Promise.resolve(),
      }
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    let handle: RlmJsonValue | undefined
    runtime.behavior = async (request) => {
      const rlm = request.bindings.find(binding => binding.global === 'rlm')!
      handle = await rlm.functions['__call__']!({ args: ['task'], kwargs })
      return { logs: [], value: handle }
    }
    await cell(ctx, agent.agent, 'program')
    const starts: CapturedStart[] = rawStarts.map(request => ({
      label: request.label,
      agentOptions: request.agentOptions,
      // Key presence, not truthiness: the bridge omits the field entirely
      // on the inheritance tier instead of sending an empty object.
      hasAgentOptionsKey: Object.prototype.hasOwnProperty.call(request, 'agentOptions'),
    }))
    return { handle, starts }
  }

  it('a per-call model kwarg overrides a configured subagentModel', async () => {
    const { handle, starts } = await admitWith({ subagentModel: 'cfg/default-model' }, { model: 'kwarg/model-x' })
    expect(starts).toHaveLength(1)
    expect(starts[0]!.agentOptions).toEqual({ model: 'kwarg/model-x' })
    expect(starts[0]!.hasAgentOptionsKey).toBe(true)
    expect(handle).toMatchObject({ model: 'kwarg/model-x' })
  })

  it('with no kwarg, a configured subagentModel is sent', async () => {
    const { handle, starts } = await admitWith({ subagentModel: 'cfg/default-model' }, {})
    expect(starts[0]!.agentOptions).toEqual({ model: 'cfg/default-model' })
    expect(handle).toMatchObject({ model: 'cfg/default-model' })
  })

  it('model=None is unspecified and falls through to the configured default', async () => {
    const { starts } = await admitWith({ subagentModel: 'cfg/default-model' }, { model: null })
    expect(starts[0]!.agentOptions).toEqual({ model: 'cfg/default-model' })
  })

  it('with neither kwarg nor config, the start request carries no agentOptions at all (parent inheritance)', async () => {
    const { handle, starts } = await admitWith({}, {})
    expect(starts[0]!.hasAgentOptionsKey).toBe(false)
    expect(starts[0]!.agentOptions).toBeUndefined()
    expect(handle).toMatchObject({ model: null })
  })

  it('rejects non-string model values as a result error without starting a child', async () => {
    let started = 0
    const { ctx, agent } = await setup(fakeRuntime)
    await registerStubSubagents(ctx, async () => {
      started++
      return {
        id: 'stub-never',
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
        dispose: () => Promise.resolve(),
      }
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime

    runtime.behavior = async (request) => {
      const rlm = request.bindings.find(binding => binding.global === 'rlm')!
      const intModel = await rlm.functions['__call__']!({ args: ['task'], kwargs: { model: 42 } })
      const listModel = await rlm.functions['__call__']!({ args: ['task'], kwargs: { model: ['a', 'b'] } })
      const emptyModel = await rlm.functions['__call__']!({ args: ['task'], kwargs: { model: '' } })
      return { logs: [], value: { intModel, listModel, emptyModel } }
    }

    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({
      intModel: { error: 'rlm() model must be a non-empty string or None' },
      listModel: { error: 'rlm() model must be a non-empty string or None' },
      // O1 (M4-A acceptance): the empty string is a hand-slip, not a model id —
      // the kwarg layer rejects it exactly like the config boundary does.
      emptyModel: { error: 'rlm() model must be a non-empty string or None' },
    })
    expect(started).toBe(0)
  })

  it('rejects an empty-string subagentModel at the config boundary (plugin mount fails loudly)', async () => {
    await expect(setup(fakeRuntime, { subagentModel: '' })).rejects.toThrow('subagentModel must be a non-empty string')
  })
})

describe('rlm_await cancellation chain (real kernel, M4-A N2)', () => {
  it('an outer abort while the cell is blocked in rlm_await settles the cell and keeps the run disposable', async () => {
    const { ctx, agent } = await setupKernel()
    let startSignal: AbortSignal | undefined
    const disposed: string[] = []
    await registerStubSubagents(ctx, async (_name, request) => {
      startSignal = request.signal
      return {
        id: 'stub-hanging',
        localAgent: undefined,
        // Never settles: the cell stays genuinely blocked inside the kernel.
        result: new Promise(() => {}),
        dispose: () => { disposed.push('stub-hanging'); return Promise.resolve() },
      }
    })

    // One cell, both calls: admission (non-blocking) and then the wait.
    // The start request carries THIS cell's exec signal, so the same abort
    // that breaks the wait is the cancellation signal a real provider would
    // use to cancel the published child.
    const outer = new AbortController()
    setTimeout(() => { outer.abort('turn cancelled') }, 300)
    const startedAt = Date.now()
    const blocked = await runCell(ctx, [
      'handle = await rlm("hang task")',
      'await rlm_await(handle["run_id"])',
    ].join('\n'), { agent: agent.agent, signal: outer.signal })
    const elapsedMs = Date.now() - startedAt
    expect(blocked.isError).toBe(true)
    if (!blocked.isError) throw new Error('expected the blocked cell to fail')
    // The chain (outer signal → run-scoped abort → kernel interrupt ladder)
    // must settle the cell as the CODE_RUN_FAILED abort taxonomy, quickly —
    // a broken chain would ride the full run timeout instead.
    expect(blocked.error.info).toMatchObject({ name: 'DasherRunFailedError', code: 'CODE_RUN_FAILED' })
    expect((blocked.content[0] as { text: string }).text).toContain('code run failed (abort)')
    expect(elapsedMs).toBeLessThan(10_000)

    // The cancellation reached the subagent request itself: a real provider
    // cancels the published child on this signal.
    expect(startSignal?.aborted).toBe(true)

    // The aborted rlm_await did NOT take the run's result, so the run
    // stays tracked and the session-disposal path still reaches it.
    ctx.events.emit('agent/disposed', { agent: { id: 'dasher-agent' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(disposed).toEqual(['stub-hanging'])
  }, 30_000)
})
