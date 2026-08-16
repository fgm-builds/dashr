import { describe, expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { FakeCellRuntime, fakeRuntime, runCell, setup } from './helpers.ts'
import type { DasherCompactionResult, DasherCompactionSurface } from '../src/index.ts'

/**
 * M4-B Work 2: the compact() binding — the PA "check usage → summarize →
 * keep working" semantics over the compaction seam. The host engine is a stub
 * `ctx.compaction` service capturing every call; the design-A path mounts the
 * REAL `BasicCompactionEngine` under `ctx.isolate('compaction')` exactly as
 * apply() does, with host llm/tokenMeter stubs proving the scoped engine
 * resolves OUTWARD through its isolation label.
 */

/** A canonical fake compaction result. */
function fakeResult(over: Partial<DasherCompactionResult> = {}): DasherCompactionResult {
  return {
    compactionId: 'cmp-1',
    summarySeq: 42,
    shadowedSeqs: [1, 2, 3],
    shadowedTokenCount: 1234,
    ...over,
  }
}

/** Mount a stub `ctx.compaction` engine capturing compactNow / compactIfNeeded. */
async function registerStubCompaction(ctx: Context, behavior: {
  compactNow?: (agent: Agent, signal: AbortSignal) => Promise<DasherCompactionResult | null>
  compactIfNeeded?: (agent: Agent, trigger: string, signal: AbortSignal) => Promise<DasherCompactionResult | null>
}): Promise<{ nowCalls: Array<{ agent: Agent, signal: AbortSignal }>, pressureCalls: Array<{ agent: Agent, trigger: string, signal: AbortSignal }> }> {
  const nowCalls: Array<{ agent: Agent, signal: AbortSignal }> = []
  const pressureCalls: Array<{ agent: Agent, trigger: string, signal: AbortSignal }> = []
  const fiber = await ctx.plugin({ name: 'stub-compaction', apply(c) {
    c.provide('compaction', {
      async compactNow(agent: Agent, signal: AbortSignal) {
        nowCalls.push({ agent, signal })
        return behavior.compactNow?.(agent, signal) ?? null
      },
      async compactIfNeeded(agent: Agent, trigger: 'pressure' | 'context-overflow', signal: AbortSignal) {
        pressureCalls.push({ agent, trigger, signal })
        return behavior.compactIfNeeded?.(agent, trigger, signal) ?? null
      },
    } satisfies DasherCompactionSurface)
  } })
  onTestFinished(() => fiber.dispose())
  return { nowCalls, pressureCalls }
}

/** A busy-style error, structurally what ManualCompactionError('busy') looks like. */
function busyError(): Error & { code: string } {
  const error = new Error('manual compaction requires an idle agent with no waking queued work') as Error & { code: string }
  error.code = 'busy'
  return error
}

async function cell(ctx: Context, agent: Agent, code: string): Promise<unknown> {
  const result = await runCell(ctx, code, { agent })
  expect(result.isError, `cell failed: ${JSON.stringify(result.content)}`).toBe(false)
  return (result.value as { result?: unknown }).result
}

describe('compact() binding', () => {
  it('routes an idle agent through compactNow and reports the compaction result', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const signal = new AbortController().signal
    const { nowCalls } = await registerStubCompaction(ctx, {
      compactNow: async () => fakeResult(),
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      return { logs: [], value: await compact.functions['__call__']!({ args: [], kwargs: {} }) }
    }
    // runCell's fixed signal would not be observable; pass our own.
    const result = await runCell(ctx, 'program', { agent: agent.agent, signal })
    expect((result as { isError: boolean }).isError).toBe(false)
    expect(nowCalls.length).toBe(1)
    expect(nowCalls[0]!.agent).toBe(agent.agent)
    expect(nowCalls[0]!.signal).toBe(signal)
    expect(((result as { value: { result?: unknown } }).value.result)).toEqual({
      status: 'compacted',
      path: 'compact-now',
      compaction_id: 'cmp-1',
      summary_seq: 42,
      shadowed_items: 3,
      shadowed_tokens: 1234,
      compact_model: null,
    })
  })

  it('falls through busy compactNow to compactIfNeeded(pressure) — the in-cell path', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const { nowCalls, pressureCalls } = await registerStubCompaction(ctx, {
      compactNow: () => { throw busyError() },
      compactIfNeeded: async () => fakeResult({ shadowedTokenCount: 900 }),
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      const via = await compact.functions['__call__']!({ args: ['context is filling'], kwargs: {} })
      return { logs: [], value: via }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(nowCalls.length).toBe(1)
    expect(pressureCalls.length).toBe(1)
    expect(pressureCalls[0]!.trigger).toBe('pressure')
    expect(pressureCalls[0]!.agent).toBe(agent.agent)
    expect(result).toMatchObject({ status: 'compacted', path: 'pressure', shadowed_tokens: 900 })
  })

  it('reports an honest no-op when the engine finds nothing worth compacting', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    await registerStubCompaction(ctx, {
      compactNow: () => { throw busyError() },
      compactIfNeeded: async () => null,
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      return { logs: [], value: await compact.functions['__call__']!({ args: [], kwargs: {} }) }
    }
    expect(await cell(ctx, agent.agent, 'program')).toEqual({ status: 'no-op', path: 'pressure', compact_model: null })
  })

  it('answers a structured unavailable error without an engine, still carrying the usage probe', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const meterFiber = await ctx.plugin({ name: 'stub-token-meter', apply(c) {
      c.provide('tokenMeter', { measure: () => ({ totalTokens: 4321 }) })
    } })
    onTestFinished(() => meterFiber.dispose())
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      return { logs: [], value: await compact.functions['__call__']!({ args: [], kwargs: {} }) }
    }
    expect(await cell(ctx, agent.agent, 'program')).toEqual({
      context_tokens: 4321,
      error: expect.stringContaining('compact() is unavailable: no ctx.compaction engine'),
    })
  })

  it('validates the signature: no args or one reason string, nothing else', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    await registerStubCompaction(ctx, { compactNow: async () => null })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      const two = await compact.functions['__call__']!({ args: ['a', 'b'], kwargs: {} })
      const kwarg = await compact.functions['__call__']!({ args: [], kwargs: { reason: 'x' } })
      const nonString = await compact.functions['__call__']!({ args: [1], kwargs: {} })
      const reason = await compact.functions['__call__']!({ args: ['wrapping up'], kwargs: {} })
      return { logs: [], value: { two, kwarg, nonString, reason } }
    }
    const result = await cell(ctx, agent.agent, 'program') as Record<string, { error?: string }>
    expect(result['two']?.error).toContain('compact() expects no arguments')
    expect(result['kwarg']?.error).toContain('compact() expects no arguments')
    expect(result['nonString']?.error).toContain('compact() expects no arguments')
    expect(result['reason']).toMatchObject({ status: 'no-op' })
  })

  it('surfaces non-busy engine failures as structured errors', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    await registerStubCompaction(ctx, {
      compactNow: () => { throw new Error('persistence backend down') },
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      return { logs: [], value: await compact.functions['__call__']!({ args: [], kwargs: {} }) }
    }
    expect(await cell(ctx, agent.agent, 'program')).toEqual({
      compact_model: null,
      error: expect.stringContaining('compact() failed: persistence backend down'),
    })
  })
})

describe('compact() design A: the DASHR-scoped engine', () => {
  it('mounts a real BasicCompactionEngine under ctx.isolate with the compactModel route and auto off', async () => {
    const { ctx } = await setup(fakeRuntime, { compactModel: 'zai/glm-5.2' })
    // The isolation-label mount recipe apply() uses, verified directly.
    const scope = ctx.isolate('compaction')
    const engine = new BasicCompactionEngine(scope, { summarizationProvider: 'zai', summarizationModel: 'glm-5.2', auto: false })
    expect(engine.config.summarizationProvider).toBe('zai')
    expect(engine.config.summarizationModel).toBe('glm-5.2')
    expect(engine.config.auto).toBe(false)
    // The scoped provide does not disturb a root engine (the label differs).
    const { nowCalls } = await registerStubCompaction(ctx, { compactNow: async () => fakeResult() })
    void nowCalls
    expect(scope.get('compaction')).toBeDefined()
    expect(ctx.get('compaction')).toBeDefined()
  })

  it('resolves the scoped engine, not the host one, and reaches host llm/tokenMeter outward through it', async () => {
    const { ctx, agent } = await setup(fakeRuntime, { compactModel: 'zai/glm-5.2' }, { provider: 'deepseek', model: 'dsv3' })
    // Host-plane stubs the scoped engine must resolve OUTWARD to reach.
    const resolvedModels: Array<{ provider: string, model: string }> = []
    const llmFiber = await ctx.plugin({ name: 'stub-llm-pressure', apply(c) {
      c.provide('llm', {
        async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          yield { type: 'text-delta', index: 0, text: '## checkpoint' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
        async resolveModelInfo(provider: string, model: string) {
          resolvedModels.push({ provider, model })
          return { provider, id: model, name: model, context: { contextWindow: 1_000_000 } }
        },
      })
    } })
    onTestFinished(() => llmFiber.dispose())
    const meterFiber = await ctx.plugin({ name: 'stub-token-meter', apply(c) {
      c.provide('tokenMeter', { measure: () => ({ totalTokens: 100 }) })
    } })
    onTestFinished(() => meterFiber.dispose())
    const sessionsFiber = await ctx.plugin({ name: 'stub-sessions', apply(c) {
      c.provide('sessions', { flush: () => Promise.resolve() })
    } })
    onTestFinished(() => sessionsFiber.dispose())
    // A session whose routed request says deepseek/dsv3; 100 tokens of
    // pressure against an 800k threshold: an honest pressure no-op. The
    // agent object itself stays the setup one (its identity is the subject
    // the scope registry resolves run_cell for); only its session surface is
    // enriched with what the real engine reads: the routed request header,
    // the compaction-lock event log, and the busy maintenance gate.
    const session = agent.agent.session as unknown as {
      requestHeader?: () => { config: { provider: string, model: string } }
      events?: unknown[]
    }
    session.requestHeader = () => ({ config: { provider: 'deepseek', model: 'dsv3' } })
    session.events = []
    const looping = agent.agent as unknown as { runMaintenance?: () => never }
    looping.runMaintenance = (): never => { throw new Error('agent "dasher-agent" already has active work') }
    const { nowCalls, pressureCalls } = await registerStubCompaction(ctx, {})
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      return { logs: [], value: await compact.functions['__call__']!({ args: [], kwargs: {} }) }
    }
    const result = await cell(ctx, agent.agent, 'program')
    // The HOST engine was never consulted (the scoped one shadowed it).
    expect(nowCalls.length).toBe(0)
    expect(pressureCalls.length).toBe(0)
    // The scoped engine ran the ladder: its own compactNow hit the busy gate
    // (the in-cell truth), fell to compactIfNeeded('pressure'), which priced
    // the routed conversation target through the host llm — the outward
    // resolution through the isolation label — and no-op'd below threshold.
    expect(result).toEqual({
      status: 'no-op',
      path: 'pressure',
      compact_model: { provider: 'zai', model: 'glm-5.2' },
      context_tokens: 100,
    })
    expect(resolvedModels).toEqual([{ provider: 'deepseek', model: 'dsv3' }])
  })

  it('pairs a bare compactModel with the calling agent provider; without one it errors structurally', async () => {
    const bare = await setup(fakeRuntime, { compactModel: 'glm-5.2' }, { provider: 'zai', model: 'parent' })
    // Host-plane singles the scoped engine's static inject resolves outward to.
    for (const [key, service] of [
      ['llm', { async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } } }],
      ['tokenMeter', { measure: () => ({ totalTokens: 0 }) }],
      ['sessions', { flush: () => Promise.resolve() }],
    ] as const) {
      const fiber = await bare.ctx.plugin({ name: `stub-${key}-bare`, apply(c) { c.provide(key, service) } })
      onTestFinished(() => fiber.dispose())
    }
    const bareSession = bare.agent.agent.session as unknown as { events?: unknown[] }
    bareSession.events = []
    const bareRuntime = bare.ctx.get('rlmRuntime') as FakeCellRuntime
    bareRuntime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      return { logs: [], value: await compact.functions['__call__']!({ args: [], kwargs: {} }) }
    }
    // The engine mounts and the ladder runs; without a routed request the
    // pressure entry no-ops immediately (routedTarget undefined).
    const result = await cell(bare.ctx, bare.agent.agent, 'program')
    expect(result).toMatchObject({ compact_model: { provider: 'zai', model: 'glm-5.2' } })

    const unprovided = await setup(fakeRuntime, { compactModel: 'glm-5.2' })
    const unprovidedRuntime = unprovided.ctx.get('rlmRuntime') as FakeCellRuntime
    unprovidedRuntime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      return { logs: [], value: await compact.functions['__call__']!({ args: [], kwargs: {} }) }
    }
    expect(await cell(unprovided.ctx, unprovided.agent.agent, 'program')).toEqual({
      error: expect.stringContaining('bare model id and this agent has no provider'),
    })
  })

  it('rejects a leading-slash compactModel as an empty provider half (acceptance fix P1)', async () => {
    // '/glm-5.2' must NOT slip into the bare-id branch as a model id that
    // contains a slash; indexOf('/') === 0 enters the split branch and the
    // empty provider half is rejected there.
    const bad = await setup(fakeRuntime, { compactModel: '/glm-5.2' }, { provider: 'zai', model: 'parent' })
    const badRuntime = bad.ctx.get('rlmRuntime') as FakeCellRuntime
    badRuntime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      return { logs: [], value: await compact.functions['__call__']!({ args: [], kwargs: {} }) }
    }
    expect(await cell(bad.ctx, bad.agent.agent, 'program')).toEqual({
      error: expect.stringContaining('empty provider or model half'),
    })
  })
})
