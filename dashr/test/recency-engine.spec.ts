import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { RecencyAwareCompactionEngine, selectRecencyRange } from '../src/compaction/recency-engine.ts'
import type { RecencyMeasurement } from '../src/compaction/recency-engine.ts'
import { resolveRecencyWindowTokens, resolveRetainTokens } from '../src/index.ts'
import { FakeCellRuntime, fakeRuntime, runCell, setupPresentation } from './helpers.ts'

/**
 * Feature 1 — the Context Recency Window: an absolute-token trigger arm on
 * top of upstream's ratio threshold. These tests cover the DASHR-owned
 * surface only: the constructor peel + invariants, the compare-and-delegate
 * shape of `compactIfNeeded`, the range selector (the one reimplemented
 * upstream walk), and the event-path wiring (pre-step reaches the engine
 * through its isolation realm and dispatches dynamically). The native
 * compaction transaction downstream of `compactRegion` stays upstream's
 * coverage.
 */

/** A surface event with zero tool-call delta — every cut around it is balanced. */
function plainEvent(seq: number, type = 'user/message'): { type: string; seq: number; data: unknown } {
  return { type, seq, data: {} }
}

/** A structural session: the surface fold + the events indexed by seq the pairing guard reads. */
function fakeSession(seqs: number[], extra: Partial<Session> = {}): Session {
  const events: Array<{ type: string; seq: number; data: unknown }> = []
  for (const seq of seqs) events[seq] = plainEvent(seq)
  return {
    surface: { nodes: seqs, replaceGeneration: 0 },
    events,
    ...extra,
  } as unknown as Session
}

/** A structural agent whose session is the fake above. */
function fakeAgent(session: Session, route?: { provider: string; model: string }): Agent {
  return {
    id: 'recency-agent' as never,
    options: route,
    session: route === undefined ? session : Object.assign(session, {
      requestHeader: () => ({ config: route }),
    }),
  } as unknown as Agent
}

/** A fake compaction result shaped like the seam's vocabulary. */
function fakeCompactionResult(over: Record<string, unknown> = {}): never {
  return { compactionId: 'cmp-r1', summarySeq: 9, shadowedSeqs: [1], shadowedTokenCount: 100, ...over } as never
}

/** Meter stub: measure returns the given snapshot (callable per-invocation via the queue). */
async function registerMeter(ctx: Context, snapshots: RecencyMeasurement[] | (() => RecencyMeasurement)): Promise<{ calls: number }> {
  const state = { calls: 0 }
  await ctx.plugin({ name: 'recency-stub-meter', apply(c) {
    c.provide('tokenMeter', {
      measure: () => {
        state.calls++
        return typeof snapshots === 'function' ? snapshots() : (snapshots[Math.min(state.calls - 1, snapshots.length - 1)] ?? snapshots[0]!)
      },
    })
  } })
  return state
}

/** LLM stub the engine's static inject resolves; resolveModelInfo reports a 1M window. */
async function registerLlm(ctx: Context, resolved: Array<{ provider: string; model: string }>): Promise<void> {
  await ctx.plugin({ name: 'recency-stub-llm', apply(c) {
    c.provide('llm', {
      async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
      async resolveModelInfo(provider: string, model: string) {
        resolved.push({ provider, model })
        return { provider, id: model, name: model, context: { contextWindow: 1_000_000 } }
      },
    })
  } })
}

/** Mount the recency engine as a plugin fiber with host services, like apply() does. */
async function mountEngine(ctx: Context, config: Record<string, unknown>): Promise<RecencyAwareCompactionEngine> {
  // The engine's static inject is llm/tokenMeter/sessions — all three must
  // exist on the host plane or the fiber stays pending.
  await ctx.plugin({ name: 'recency-stub-sessions', apply(c) {
    c.provide('sessions', { flush: () => Promise.resolve() })
  } })
  const scope = ctx.isolate('compaction')
  const fiber = await scope.plugin(RecencyAwareCompactionEngine, config as never)
  onTestFinished(() => fiber.dispose())
  return scope.get('compaction') as RecencyAwareCompactionEngine
}

describe('selectRecencyRange', () => {
  it('keeps the tail that meets retainTokens and compacts everything before it', () => {
    const session = fakeSession([10, 11, 12, 13])
    const measurement: RecencyMeasurement = {
      totalTokens: 900,
      nodes: [
        { seq: 10, tokens: 100 },
        { seq: 11, tokens: 100 },
        { seq: 12, tokens: 100 },
        { seq: 13, tokens: 100 },
      ],
    }
    expect(selectRecencyRange(session, measurement, 150)).toEqual({ start: 10, end: 11 })
  })

  it('returns null when the whole surface fits inside the retained tail', () => {
    const session = fakeSession([10, 11])
    const measurement: RecencyMeasurement = {
      totalTokens: 900,
      nodes: [
        { seq: 10, tokens: 10 },
        { seq: 11, tokens: 10 },
      ],
    }
    expect(selectRecencyRange(session, measurement, 500)).toBeNull()
  })

  it('returns null on an empty surface', () => {
    const session = fakeSession([])
    const measurement: RecencyMeasurement = { totalTokens: 0, nodes: [] }
    expect(selectRecencyRange(session, measurement, 50)).toBeNull()
  })

  it('throws when the meter surface disagrees with the session surface', () => {
    const session = fakeSession([10, 11])
    const measurement: RecencyMeasurement = {
      totalTokens: 900,
      nodes: [
        { seq: 10, tokens: 10 },
        { seq: 99, tokens: 10 },
      ],
    }
    expect(() => selectRecencyRange(session, measurement, 50)).toThrow('does not match the current session surface')
  })
})

describe('RecencyAwareCompactionEngine', () => {
  it('peels recencyWindowTokens before super() and enforces the retainTokens invariant', () => {
    // A retention at/above the recency ceiling would make every compaction
    // a no-op — the machine-checked invariant.
    expect(() => new RecencyAwareCompactionEngine(new Context(), {
      recencyWindowTokens: 500,
      retainTokens: 500,
      summarizationProvider: 'zai',
      summarizationModel: 'glm-5.2',
      auto: false,
    } as never)).toThrow('retainTokens (500) must be less than recencyWindowTokens (500)')
    // No absolute tail → the recency selector cannot price its retention.
    expect(() => new RecencyAwareCompactionEngine(new Context(), {
      recencyWindowTokens: 500,
      summarizationProvider: 'zai',
      summarizationModel: 'glm-5.2',
      auto: false,
    } as never)).toThrow('requires an absolute retainTokens')
    // The sane configuration constructs (and the unknown key never reached
    // upstream's validateKeys).
    const engine = new RecencyAwareCompactionEngine(new Context(), {
      recencyWindowTokens: 500,
      retainTokens: 50,
      summarizationProvider: 'zai',
      summarizationModel: 'glm-5.2',
      auto: false,
    } as never)
    expect(engine.config.retainTokens).toBe(50)
    expect(engine.config.auto).toBe(false)
  })

  it('below the recency ceiling hands back to upstream wholesale (delegation, not intervention)', async () => {
    const ctx = new Context()
    const resolved: Array<{ provider: string; model: string }> = []
    await registerLlm(ctx, resolved)
    await registerMeter(ctx, () => ({ totalTokens: 100, nodes: [] }))
    const engine = await mountEngine(ctx, {
      recencyWindowTokens: 500,
      retainTokens: 50,
      summarizationProvider: 'zai',
      summarizationModel: 'glm-5.2',
      auto: false,
    })
    const session = fakeSession([])
    const agent = fakeAgent(session, { provider: 'deepseek', model: 'v4-pro' })
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    // Upstream's pressure path ran (it resolved the routed target against
    // the host llm) and no-op'd below its own 0.8 x 1M threshold.
    expect(resolved).toEqual([{ provider: 'deepseek', model: 'v4-pro' }])
    expect(result).toBeNull()
  })

  it('above the recency ceiling selects the range and hands it to upstream compactRegion', async () => {
    const ctx = new Context()
    const pruned: unknown[] = []
    void ctx.plugin({ name: 'recency-stub-pruner', apply(c) {
      c.provide('toolResultPruner', { pruneSession: (session: unknown) => { pruned.push(session) } })
    } })
    await registerLlm(ctx, [])
    await registerMeter(ctx, [
      { totalTokens: 900, nodes: [
        { seq: 10, tokens: 100 },
        { seq: 11, tokens: 100 },
        { seq: 12, tokens: 100 },
        { seq: 13, tokens: 100 },
      ] },
    ])
    const engine = await mountEngine(ctx, {
      recencyWindowTokens: 500,
      retainTokens: 150,
      summarizationProvider: 'zai',
      summarizationModel: 'glm-5.2',
      auto: false,
    })
    const session = fakeSession([10, 11, 12, 13])
    const agent = fakeAgent(session)
    // The recency path must hand the SELECTED RANGE to the native public
    // compactRegion; the transaction itself is upstream's (instance-level
    // override keeps this test on DASHR-owned logic).
    const handedOff: Array<{ start: number; end: number }> = []
    ;(engine as unknown as { compactRegion: (start: number, end: number) => Promise<unknown> }).compactRegion = async (start, end) => {
      handedOff.push({ start, end })
      return fakeCompactionResult()
    }
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    expect(pruned.length).toBe(1)
    expect(handedOff).toEqual([{ start: 10, end: 11 }])
    expect(result).toMatchObject({ compactionId: 'cmp-r1' })
  })

  it('the prune alone can drop the session back under the ceiling — an honest no-op', async () => {
    const ctx = new Context()
    const calls: number[] = []
    void ctx.plugin({ name: 'recency-stub-pruner', apply(c) {
      c.provide('toolResultPruner', { pruneSession: () => { calls.push(1) } })
    } })
    await registerLlm(ctx, [])
    await registerMeter(ctx, [
      { totalTokens: 900, nodes: [] },
      { totalTokens: 100, nodes: [] },
    ])
    const engine = await mountEngine(ctx, {
      recencyWindowTokens: 500,
      retainTokens: 50,
      summarizationProvider: 'zai',
      summarizationModel: 'glm-5.2',
      auto: false,
    })
    const session = fakeSession([])
    const agent = fakeAgent(session)
    const handedOff: unknown[] = []
    ;(engine as unknown as { compactRegion: (...args: unknown[]) => Promise<unknown> }).compactRegion = async () => {
      handedOff.push(1)
      return fakeCompactionResult()
    }
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    expect(calls.length).toBe(1)
    expect(handedOff.length).toBe(0)
    expect(result).toBeNull()
  })

  it('context-overflow keeps upstream maximum-reduction semantics (full delegation)', async () => {
    const ctx = new Context()
    await registerLlm(ctx, [])
    await registerMeter(ctx, () => ({ totalTokens: 400, nodes: [
      { seq: 10, tokens: 100 },
      { seq: 11, tokens: 100 },
      { seq: 12, tokens: 100 },
      { seq: 13, tokens: 100 },
    ] }))
    const engine = await mountEngine(ctx, {
      recencyWindowTokens: 500,
      retainTokens: 50,
      summarizationProvider: 'zai',
      summarizationModel: 'glm-5.2',
      auto: false,
    })
    const session = fakeSession([10, 11, 12, 13])
    const agent = fakeAgent(session, { provider: 'deepseek', model: 'v4-pro' })
    const handedOff: Array<{ start: number; end: number }> = []
    ;(engine as unknown as { compactRegion: (start: number, end: number) => Promise<unknown> }).compactRegion = async (start, end) => {
      handedOff.push({ start, end })
      return fakeCompactionResult()
    }
    // Overflow never touches the recency arm: its selector retains ZERO
    // tokens (maximum reduction), so the range spans everything but the
    // newest node — NOT the 50-token tail the recency path would keep.
    await engine.compactIfNeeded(agent, 'context-overflow', new AbortController().signal)
    expect(handedOff).toEqual([{ start: 10, end: 12 }])
  })

  it('agent/pre-step reaches the engine through its isolation realm and dispatches the override', async () => {
    const ctx = new Context()
    registerLlm(ctx, [])
    registerMeter(ctx, () => ({ totalTokens: 100, nodes: [] }))
    const engine = await mountEngine(ctx, {
      recencyWindowTokens: 500,
      retainTokens: 50,
      summarizationProvider: 'zai',
      summarizationModel: 'glm-5.2',
      auto: true,
    })
    // The upstream listener calls `this.compactIfNeeded` dynamically; spy
    // through an instance override, then emit the event at the ROOT — the
    // isolated realm must still receive it (spike 1 codified).
    let dispatched = 0
    ;(engine as unknown as { compactIfNeeded: () => Promise<unknown> }).compactIfNeeded = async () => {
      dispatched++
      return null
    }
    await ctx.waterfall('agent/pre-step', { agent: fakeAgent(fakeSession([])), messages: [], turn: 0, step: 0, signal: new AbortController().signal } as never, (() => undefined) as never)
    expect(dispatched).toBe(1)
  })
})

describe('recency config resolution', () => {
  it('resolves positive integers only', () => {
    expect(resolveRecencyWindowTokens(undefined)).toBeUndefined()
    expect(resolveRetainTokens(undefined)).toBeUndefined()
    expect(resolveRecencyWindowTokens(500_000)).toBe(500_000)
    expect(resolveRetainTokens(50_000)).toBe(50_000)
    expect(() => resolveRecencyWindowTokens(0)).toThrow('positive integer')
    expect(() => resolveRetainTokens(1.5)).toThrow('positive integer')
  })
})

describe('recency config at the apply() boundary', () => {
  it('rejects recencyWindowTokens without compactModel', async () => {
    await expect(setupPresentation(fakeRuntime, { recencyWindowTokens: 500, retainTokens: 50 }))
      .rejects.toThrow('recencyWindowTokens requires compactModel')
  })

  it('rejects recencyWindowTokens with a bare compactModel (eager mount has no agent to pair)', async () => {
    await expect(setupPresentation(fakeRuntime, { compactModel: 'glm-5.2', recencyWindowTokens: 500, retainTokens: 50 }))
      .rejects.toThrow('requires the full "provider/model" compactModel form')
  })

  it('rejects recencyWindowTokens without an absolute retainTokens', async () => {
    await expect(setupPresentation(fakeRuntime, { compactModel: 'zai/glm-5.2', recencyWindowTokens: 500 }))
      .rejects.toThrow('requires retainTokens')
  })

  it('mounts the recency engine eagerly and the design-A compact() path reuses it', async () => {
    // Valid recency config: apply() starts the EAGER recency-engine mount
    // (auto: true, 500-token ceiling, 50-token tail). The design-A lazy
    // factory must then DETECT the existing engine instead of mounting a
    // second one — proven by compact()'s compact_model reporting the
    // recency engine's summarization target.
    const { ctx, agent } = await setupPresentation(
      fakeRuntime,
      { compactModel: 'zai/glm-5.2', recencyWindowTokens: 500, retainTokens: 50 },
      { provider: 'deepseek', model: 'dsv3' },
    )
    const resolvedModels: Array<{ provider: string, model: string }> = []
    const llmFiber = await ctx.plugin({ name: 'stub-llm-recency-apply', apply(c) {
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
    const meterFiber = await ctx.plugin({ name: 'stub-meter-recency-apply', apply(c) {
      c.provide('tokenMeter', { measure: () => ({ totalTokens: 100, nodes: [] }) })
    } })
    onTestFinished(() => meterFiber.dispose())
    const sessionsFiber = await ctx.plugin({ name: 'stub-sessions-recency-apply', apply(c) {
      c.provide('sessions', { flush: () => Promise.resolve() })
    } })
    onTestFinished(() => sessionsFiber.dispose())
    const session = agent.agent.session as unknown as {
      requestHeader?: () => { config: { provider: string, model: string } }
      events?: unknown[]
    }
    session.requestHeader = () => ({ config: { provider: 'deepseek', model: 'dsv3' } })
    session.events = []
    const looping = agent.agent as unknown as { runMaintenance?: () => never }
    looping.runMaintenance = (): never => { throw new Error('agent "dashr-agent" already has active work') }
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const compact = request.bindings.find(binding => binding.global === 'compact')!
      return { logs: [], value: await compact.functions['__call__']!({ args: [], kwargs: {} }) }
    }
    // Give the eager mount a tick to complete (dynamic import + fiber).
    await new Promise(resolve => setTimeout(resolve, 50))
    const cellResult = await runCell(ctx, 'program', { agent: agent.agent })
    const result = ((cellResult as { value: { result?: unknown } }).value.result ?? {}) as { status?: string, compact_model?: unknown }
    // 100 tokens: below the 500 recency ceiling AND below upstream's
    // 0.8 x 1M — an honest no-op THROUGH the recency engine, whose
    // summarization route (zai/glm-5.2) identifies the reused engine.
    expect(result.status).toBe('no-op')
    expect(result.compact_model).toEqual({ provider: 'zai', model: 'glm-5.2' })
    expect(resolvedModels).toEqual([{ provider: 'deepseek', model: 'dsv3' }])
  })
})
