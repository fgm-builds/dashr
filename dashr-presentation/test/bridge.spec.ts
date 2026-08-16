import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { createRunCellTool } from '../src/index.ts'
import { FakeCellRuntime, fakeRuntime, runCell, setup } from './helpers.ts'

/**
 * The `run_cell` dispatch bridge against an in-repo fake `rlmRuntime` — the
 * same tier upstream `code-mode.spec.ts` runs: serialization, the nested
 * scheduler's concurrency contract (ported PendingDispatch driver), abort
 * drain, error mapping, and the audit events — all without a kernel. The
 * real-kernel end-to-end lives in `run-cell.spec.ts`.
 */

/** Register a trivial echo tool; returns the calls it received. */
function registerEcho(ctx: Context, name = 'echo'): unknown[] {
  const calls: unknown[] = []
  ctx.tools.register(defineTool({
    name,
    description: `Echo tool ${name}.`,
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      calls.push(args)
      return Promise.resolve(`${name}:${String((args as { value: string }).value)}`)
    },
  }))
  return calls
}

/** Register a tool whose calls resolve only when the test releases them; returns live-call telemetry. */
function registerGated(ctx: Context, name: string, concurrencySafe: boolean) {
  const gates: (() => void)[] = []
  let live = 0
  let peak = 0
  const order: string[] = []
  ctx.tools.register(defineTool({
    name,
    description: `Gated tool ${name}.`,
    parameters: { id: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    ...concurrencySafe ? { isConcurrencySafe: () => true } : {},
    async execute(args, exec) {
      order.push(`start:${String((args as { id: string }).id)}`)
      live++
      peak = Math.max(peak, live)
      await new Promise<void>((release) => {
        gates.push(release)
        exec.signal.addEventListener('abort', () => { release() }, { once: true })
      })
      live--
      order.push(`end:${String((args as { id: string }).id)}`)
      return `${name}:${String((args as { id: string }).id)}`
    },
  }))
  const release = (): void => { gates.shift()?.() }
  const releaseAll = (): void => { while (gates.length > 0) gates.shift()!() }
  return { order, release, releaseAll, peakLive: () => peak, pending: () => gates.length }
}

describe('the sub-dispatch scheduler (native concurrency contract)', () => {
  it('overlaps concurrency-safe calls under Promise.all and logs a start event per dispatch', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const gated = registerGated(ctx, 'safe_read', true)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const all = Promise.all([
        tools.safe_read!({ id: 'a' }),
        tools.safe_read!({ id: 'b' }),
        tools.safe_read!({ id: 'c' }),
      ])
      await expect.poll(() => gated.pending()).toBe(3)
      gated.releaseAll()
      return { logs: [], value: (await all).map(String).join(',') }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(gated.peakLive()).toBe(3)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ result: 'safe_read:a,safe_read:b,safe_read:c' })
    const starts = agent.events.filter(event => event.type === 'tool/code-dispatch-start').map(event => (event.data as { subCallId: string }).subCallId)
    const settles = agent.events.filter(event => event.type === 'tool/code-dispatch').map(event => (event.data as { subCallId: string }).subCallId)
    expect(starts).toEqual(['call-1:code:1', 'call-1:code:2', 'call-1:code:3'])
    expect(new Set(settles)).toEqual(new Set(starts))
  })

  it('an exclusive call bars overlap: safe calls drain first, it runs alone, later calls wait', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const safe = registerGated(ctx, 'safe_read', true)
    const unsafe = registerGated(ctx, 'writer', false)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const reads = [tools.safe_read!({ id: 'r1' }), tools.safe_read!({ id: 'r2' })]
      const write = tools.writer!({ id: 'w' })
      const tail = tools.safe_read!({ id: 'r3' })
      await expect.poll(() => safe.pending()).toBe(2)
      expect(unsafe.pending()).toBe(0)
      safe.releaseAll()
      await expect.poll(() => unsafe.pending()).toBe(1)
      expect(safe.pending()).toBe(0)
      unsafe.release()
      await expect.poll(() => safe.pending()).toBe(1)
      safe.releaseAll()
      await Promise.all([...reads, write, tail])
      return { logs: [], value: 'ordered' }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(safe.order.slice(0, 2)).toEqual(['start:r1', 'start:r2'])
    expect(unsafe.order).toEqual(['start:w', 'end:w'])
    expect(safe.order.indexOf('start:r3')).toBeGreaterThan(safe.order.indexOf('end:r1'))
  })

  it('maxParallelSubCalls caps the overlap window', async () => {
    const { ctx, agent } = await setup(fakeRuntime, { maxParallelSubCalls: 2 })
    const gated = registerGated(ctx, 'safe_read', true)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const all = Promise.all([
        tools.safe_read!({ id: 'a' }),
        tools.safe_read!({ id: 'b' }),
        tools.safe_read!({ id: 'c' }),
      ])
      await expect.poll(() => gated.pending()).toBe(2)
      expect(gated.pending()).toBe(2)
      gated.release()
      await expect.poll(() => gated.pending()).toBe(2)
      gated.releaseAll()
      await all
      return { logs: [], value: 'capped' }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(gated.peakLive()).toBe(2)
  })

  it('serializes non-concurrency-safe Promise.all dispatches in submission order', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const intervals: [string, string][] = []
    let active = 0
    ctx.tools.register(defineTool({
      name: 'probe',
      description: 'Records execution overlap.',
      parameters: { id: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        active++
        expect(active, 'probe executions overlapped').toBe(1)
        intervals.push(['enter', String((args as { id: string }).id)])
        await new Promise(resolve => setTimeout(resolve, 20))
        intervals.push(['exit', String((args as { id: string }).id)])
        active--
        return String((args as { id: string }).id)
      },
    }))
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const values = await Promise.all([tools.probe!({ id: 'a' }), tools.probe!({ id: 'b' }), tools.probe!({ id: 'c' })])
      return { logs: [], value: values.map(String).join(',') }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(intervals).toEqual([
      ['enter', 'a'], ['exit', 'a'],
      ['enter', 'b'], ['exit', 'b'],
      ['enter', 'c'], ['exit', 'c'],
    ])
  })

  it('a queued-unstarted call abandoned by run settlement logs no start event', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const gated = registerGated(ctx, 'writer', false)
    const abandoned: string[] = []
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      tools.writer!({ id: 'w1' }).catch(() => 'settled-under-abort')
      tools.writer!({ id: 'w2' }).catch((error: unknown) => {
        abandoned.push(error instanceof Error ? error.message : String(error))
      })
      await expect.poll(() => gated.pending()).toBe(1)
      throw new Error('program failed with a queued call')
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(true)
    const starts = agent.events.filter(event => event.type === 'tool/code-dispatch-start').map(event => (event.data as { subCallId: string }).subCallId)
    const settles = agent.events.filter(event => event.type === 'tool/code-dispatch').map(event => (event.data as { subCallId: string }).subCallId)
    expect(starts).toEqual(['call-1:code:1'])
    expect(settles).toEqual(['call-1:code:1'])
    expect(abandoned).toEqual(['run_cell run is over (run_cell settled); writer tool call abandoned'])
  })

  it('an outer abort mid-run aborts in-flight sub-dispatches and still settles their events', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const gated = registerGated(ctx, 'safe_read', true)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    const outer = new AbortController()
    const bindingOutcome: string[] = []
    runtime.behavior = async (request) => {
      void request.bindings[0]!.functions.safe_read!({ id: 'x' })
        .then(() => 'resolved', (error: unknown) => {
          bindingOutcome.push(error instanceof Error ? error.message : String(error))
        })
      await expect.poll(() => gated.pending()).toBe(1)
      outer.abort('turn cancelled')
      // The run-scoped abort releases the tool's gate via its signal; wait
      // for the body to actually settle before letting the program finish.
      await expect.poll(() => gated.order.includes('end:x')).toBe(true)
      return { logs: [], value: 'should-not-matter' }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent, signal: outer.signal })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected abort failure')
    // The registry's cancellation contract supersedes the outer outcome.
    expect(result.error.info).toMatchObject({ name: 'AbortError', code: 'ABORTED' })
    // The program-side binding observed the run-over rejection.
    expect(bindingOutcome).toEqual([expect.stringContaining('safe_read result discarded')])
    // The started call settled with exactly one dispatch event (isError).
    const settles = agent.events.filter(event => event.type === 'tool/code-dispatch')
    expect(settles.map(event => (event.data as { subCallId: string }).subCallId)).toEqual(['call-1:code:1'])
  })
})

describe('the run_cell dispatch bridge (result shaping)', () => {
  it('bridges tool calls, returns only the curated output, and logs events with upstream payload shapes', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const calls = registerEcho(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]!.functions
      const first = await tools.echo!({ value: 'one' })
      const second = await tools.echo!({ value: 'two' })
      if (typeof first !== 'string' || typeof second !== 'string') throw new Error('echo returned a non-string')
      return { logs: [`saw ${first}`], value: second }
    }
    const result = await runCell(ctx, 'const …: string = …', { agent: agent.agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected run_cell success')
    expect(result.value).toEqual({ logs: ['saw echo:one'], result: 'echo:two' })
    expect(result.content).toEqual([{ type: 'text', text: 'saw echo:one\necho:two' }])
    expect(calls).toEqual([{ value: 'one' }, { value: 'two' }])
    expect(agent.events.filter(event => event.type === 'tool/code-dispatch').map(event => event.data)).toEqual([
      {
        rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:code:1', name: 'echo',
        arguments: { value: 'one' }, isError: false, content: [{ type: 'text', text: 'echo:one' }],
      },
      {
        rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:code:2', name: 'echo',
        arguments: { value: 'two' }, isError: false, content: [{ type: 'text', text: 'echo:two' }],
      },
    ])
    expect(result.meta).toBeUndefined()
  })

  it('rejects the program-side call when the tool errors, with the tool error text', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    ctx.tools.register(defineTool({
      name: 'fail',
      description: 'Always fails.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute(): Promise<never> { return Promise.reject(new Error('deliberate failure')) },
    }))
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      try {
        await request.bindings[0]!.functions.fail!({})
        return { logs: [], value: 'unreachable' }
      } catch (error: unknown) {
        return { logs: [], value: `caught: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.content[0]).toEqual({ type: 'text', text: 'caught: deliberate failure' })
    // The settle event carries the error outcome.
    const settle = agent.events.find(event => event.type === 'tool/code-dispatch')?.data as { isError: boolean; name: string }
    expect(settle).toMatchObject({ name: 'fail', isError: true })
  })

  it('rejects a binding argument that is not lossless JSON, dispatching nothing', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const calls = registerEcho(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      try {
        await request.bindings[0]!.functions.echo!({ value: 'x', big: 1n })
        return { logs: [], value: 'unreachable' }
      } catch (error: unknown) {
        return { logs: [], value: error instanceof Error ? error.message : String(error) }
      }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect((result.content[0] as { text: string }).text).toContain('lossless JSON')
    expect(calls).toEqual([])
    expect(agent.events.filter(event => event.type === 'tool/code-dispatch')).toEqual([])
  })

  it('a failed run surfaces as CODE_RUN_FAILED with the failure kind and captured logs', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async () => ({ logs: ['partial output'], error: { kind: 'exception', message: 'boom' } })
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected failure')
    expect(result.error.info).toMatchObject({ name: 'DasherRunFailedError', code: 'CODE_RUN_FAILED' })
    expect((result.content[0] as { text: string }).text).toContain('code run failed (exception): boom')
    expect((result.content[0] as { text: string }).text).toContain('Captured output:\npartial output')
  })

  it('forwards a nested terminal conclusion onto the successful run_cell result', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    ctx.tools.register(defineTool({
      name: 'finalize',
      description: 'Terminal tool.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute(_args, exec) {
        exec.concludeTurn()
        return Promise.resolve('done')
      },
    }))
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.finalize!({})
      return { logs: [], value: 'cell complete' }
    }
    const concluded = await runCell(ctx, 'await tools.finalize({})', { agent: agent.agent })
    expect(concluded.isError).toBe(false)
    expect(concluded.concludesTurn).toBe(true)
  })

  it('defers sub-call additionalContexts onto the outer run_cell result', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    registerEcho(ctx)
    ctx.on('tools/post-execute', (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.name === 'echo') {
        return Promise.resolve({
          kind: 'accept' as const,
          additionalContexts: [createUserMessage({
            content: [{ type: 'text' as const, text: `context for ${String(exec.callId)}` }],
            source: { kind: 'plugin' as const, plugin: 'test' },
          })],
        })
      }
      return next()
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      await request.bindings[0]!.functions.echo!({ value: 'x' })
      await request.bindings[0]!.functions.echo!({ value: 'y' })
      return { logs: [], value: 'done' }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(result.additionalContexts?.map(c => (c.content[0] as { text: string }).text))
      .toEqual(['context for call-1:code:1', 'context for call-1:code:2'])
  })

  it('a throwing tools/code-dispatch-log listener is contained: the original settled content is logged', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    registerEcho(ctx)
    ctx.on('tools/code-dispatch-log', () => { throw new Error('log-content listener failed') })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const value = await request.bindings[0]!.functions.echo!({ value: 'x' })
      return { logs: [], value: String(value) }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(false)
    const settle = agent.events.find(event => event.type === 'tool/code-dispatch')
    expect(settle?.data).toMatchObject({ name: 'echo', isError: false, content: [{ type: 'text', text: 'echo:x' }] })
  })

  it('a tools/code-dispatch-log listener may replace the durable copy without touching the program value', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    registerEcho(ctx)
    ctx.on('tools/code-dispatch-log', (dispatch, next) => {
      if (dispatch.name !== 'echo') return next()
      return Promise.resolve([{ type: 'text', text: 'spilled: locator' }])
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const value = await request.bindings[0]!.functions.echo!({ value: 'x' })
      return { logs: [], value: `program:${String(value)}` }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(false)
    // The program's value is untouched...
    expect(result.value).toMatchObject({ result: 'program:echo:x' })
    // ...only the durable log copy changed.
    const settle = agent.events.find(event => event.type === 'tool/code-dispatch')
    expect(settle?.data).toMatchObject({ content: [{ type: 'text', text: 'spilled: locator' }] })
  })

  it('passes the run-scoped abort signal into runtime.run and forwards binding coverage of the calling agent', async () => {
    const { ctx, agent, other } = await setup(fakeRuntime)
    registerEcho(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const names = Object.keys(request.bindings[0]!.functions)
      return { logs: [], value: { names, signalPresent: request.signal !== undefined, errorClass: request.bindings[0]!.errorClass?.name ?? 'none' } }
    }
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      result: { names: ['echo'], signalPresent: true, errorClass: 'ToolCallError' },
    })
    // run_cell stays invisible to the neighbor agent's binding coverage (its
    // dispatch table has no transport at all).
    expect(ctx.tools.schemas(other.agent).map(tool => tool.name)).toEqual(['echo'])
  })

  it('threads the calling agent\'s session id into runtime.run as the principal (M3-A kernel keying)', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    const result = await runCell(ctx, 'program', { agent: agent.agent })
    expect(result.isError).toBe(false)
    // The identity a stateful backend keys its kernel by: the calling
    // agent's id (the harness fake carries SessionId('dasher-agent')).
    expect(runtime.lastRequest?.principal).toBe('dasher-agent')
  })

  it('omits the principal for an agentless run_cell call (the runtime\'s shared default key)', async () => {
    // Agentless calls never traverse the preset scope (a bare registry
    // execute resolves no scoped registration — documented scope semantics),
    // so the agentless branch is pinned by driving the tool definition
    // directly, the way a composite consumer would.
    const { ctx } = await setup(fakeRuntime)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    const tool = createRunCellTool(ctx.tools, {
      requireRuntime: () => runtime,
      maxParallel: 2,
      shapeDispatchLog: async dispatch => dispatch.content,
    })
    const output = await tool.execute(
      { code: 'program', description: 'agentless cell' },
      {
        callId: CallId('agentless-call'),
        rootCallId: CallId('agentless-call'),
        token: Symbol('agentless-token') as ToolExecutionToken,
        name: 'run_cell',
        arguments: {},
        signal: new AbortController().signal,
        deferContext: () => {},
        concludeTurn: () => {},
      },
    )
    expect(output).toBeDefined()
    expect(runtime.lastRequest?.principal).toBeUndefined()
  })
})
