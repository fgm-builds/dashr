import { describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runCell, setupKernel } from './helpers.ts'

/**
 * End-to-end tier over a REAL IPython kernel (no mocks — kernels are local
 * and cheap once booted, per dsh's real-over-mock policy): the full stack —
 * the model-direct `ipython` call through the registry pipeline, the bridge,
 * the kernel-side `tools` binding over the host-request comm channel, and the
 * persistent namespace — is exercised as the agent loop would drive it. Each
 * test boots one kernel; disposal on test finish shuts it down.
 */
/**
 * Strip interpreter warning noise from captured logs: the installed ipykernel
 * emits a one-time DeprecationWarning about its Comm class on the FIRST
 * host-request binding call of a kernel (message line plus indented source
 * context lines), and which cell captures it depends on test order. User
 * program output is never warning-shaped, so dropping it is exact.
 */
function stripWarnings(logs: string[]): string[] {
  const kept: string[] = []
  let inWarning = false
  for (const line of logs) {
    if (/^\S.*(?:Deprecation|Future)Warning:/.test(line)) {
      inWarning = true
      continue
    }
    if (inWarning && /^\s+/.test(line)) continue
    inWarning = false
    kept.push(line)
  }
  return kept
}

/** Extract the outer result's success value with warning noise removed from logs. */
function valueOf(result: { isError: boolean; value?: unknown }): unknown {
  const value = result.value as { logs: string[]; result?: unknown }
  return { ...value, logs: stripWarnings(value.logs) }
}

describe('ipython end-to-end on a real kernel', () => {
  it('runs a cell: logs and completion value shape the outer result', async () => {
    const { ctx, agent } = await setupKernel()
    const result = await runCell(ctx, [
      'print("log-line-1")',
      'print("log-line-2")',
      '{"answer": 42}',
    ].join('\n'), { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ logs: ['log-line-1', 'log-line-2'], result: { answer: 42 } })
    expect(result.content).toEqual([{
      type: 'text',
      text: 'log-line-1\nlog-line-2\n{\n  "answer": 42\n}',
    }])
  })

  it('a cell with no output renders the empty marker', async () => {
    const { ctx, agent } = await setupKernel()
    const result = await runCell(ctx, 'nothing = 1', { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ logs: [] })
    expect(result.content).toEqual([{ type: 'text', text: '(ipython completed with no output)' }])
  })

  it('a None final expression yields no completion value (REPL displayhook)', async () => {
    const { ctx, agent } = await setupKernel()
    const result = await runCell(ctx, 'None', { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ logs: [] })
  })

  it('is stateful through the whole stack: a variable survives between two ipython calls', async () => {
    const { ctx, agent } = await setupKernel()
    const calls: unknown[] = []
    ctx.tools.register(defineTool({
      name: 'remember',
      description: 'Record a value and echo it with a counter.',
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute(args) {
        calls.push(args)
        return Promise.resolve(`recorded#${calls.length}:${String((args as { value: string }).value)}`)
      },
    }))
    // Cell one: call the tool and KEEP its answer in the kernel namespace.
    const first = await runCell(ctx, [
      'answer = await remember({"value": "first"})',
      'answer',
    ].join('\n'), { agent: agent.agent })
    expect(first.isError).toBe(false)
    expect(valueOf(first)).toEqual({ logs: [], result: 'recorded#1:first' })
    // Cell two (a SEPARATE tool execution): the variable is still there.
    const second = await runCell(ctx, [
      'print(answer)',
      'answer + "|second"',
    ].join('\n'), { agent: agent.agent })
    expect(second.isError).toBe(false)
    expect(valueOf(second)).toEqual({ logs: ['recorded#1:first'], result: 'recorded#1:first|second' })
  })

  it('a failed tool call raises ToolCallError with toolName, catchable in the cell', async () => {
    const { ctx, agent } = await setupKernel()
    ctx.tools.register(defineTool({
      name: 'boom',
      description: 'Always explodes.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute(): Promise<never> { return Promise.reject(new Error('the tool exploded')) },
    }))
    const result = await runCell(ctx, [
      'try:',
      '    await boom({})',
      '    outcome = {"caught": "none"}',
      'except ToolCallError as e:',
      '    outcome = {"caught": e.toolName, "message": str(e)}',
      'outcome',
    ].join('\n'), { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(valueOf(result)).toEqual({ logs: [], result: { caught: 'boom', message: 'the tool exploded' } })
  })

  it('an uncaught ToolCallError fails the cell with the CODE_RUN_FAILED taxonomy', async () => {
    const { ctx, agent } = await setupKernel()
    ctx.tools.register(defineTool({
      name: 'boom',
      description: 'Always explodes.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute(): Promise<never> { return Promise.reject(new Error('the tool exploded')) },
    }))
    const result = await runCell(ctx, 'await boom({})', { agent: agent.agent })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected failure')
    expect(result.error.info).toMatchObject({ name: 'DASHRRunFailedError', code: 'CODE_RUN_FAILED' })
    expect((result.content[0] as { text: string }).text).toContain('code run failed (exception)')
    expect((result.content[0] as { text: string }).text).toContain('the tool exploded')
  })

  it('overlaps concurrency-safe sub-calls from an asyncio.gather on the real comm channel', async () => {
    const { ctx, agent } = await setupKernel()
    let live = 0
    let peak = 0
    const intervals: string[] = []
    ctx.tools.register(defineTool({
      name: 'slow_read',
      description: 'A slow read for overlap measurement.',
      parameters: { id: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      ...{ isConcurrencySafe: () => true },
      async execute(args) {
        const id = String((args as { id: string }).id)
        intervals.push(`enter:${id}`)
        live++
        peak = Math.max(peak, live)
        await new Promise(resolve => setTimeout(resolve, 150))
        live--
        intervals.push(`exit:${id}`)
        return `read:${id}`
      },
    }))
    const result = await runCell(ctx, [
      'import asyncio',
      'values = await asyncio.gather(*[',
      '    slow_read({"id": tag}) for tag in ("a", "b", "c")',
      '])',
      '",".join(values)',
    ].join('\n'), { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(valueOf(result)).toEqual({ logs: [], result: 'read:a,read:b,read:c' })
    // All three sub-calls were live at once (the kernel serialized only the
    // dispatch submissions; the bridge overlapped the bodies).
    expect(peak).toBe(3)
    // Submission order is preserved as start order.
    expect(intervals.slice(0, 3)).toEqual(['enter:a', 'enter:b', 'enter:c'])
    const starts = agent.events.filter(event => event.type === 'tool/code-dispatch-start').map(event => (event.data as { subCallId: string }).subCallId)
    expect(starts).toEqual(['call-1:code:1', 'call-1:code:2', 'call-1:code:3'])
  })

  it('an outer abort interrupts the kernel cell and settles the outer result as aborted', async () => {
    const { ctx, agent } = await setupKernel()
    const outer = new AbortController()
    setTimeout(() => { outer.abort('turn cancelled') }, 1_000)
    const result = await runCell(ctx, 'import time\ntime.sleep(60)', { agent: agent.agent, signal: outer.signal })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected abort failure')
    // The cell's own failure rides the CODE_RUN_FAILED taxonomy (abort kind)…
    expect(result.error.info).toMatchObject({ name: 'DASHRRunFailedError', code: 'CODE_RUN_FAILED' })
    expect((result.content[0] as { text: string }).text).toContain('code run failed (abort)')
    // …and the kernel stays usable afterwards.
    const after = await runCell(ctx, '"still-alive"', { agent: agent.agent })
    expect(after.isError).toBe(false)
    expect(after.value).toEqual({ logs: [], result: 'still-alive' })
  })

  it('appends code-dispatch audit events with the upstream payload shapes on the real path', async () => {
    const { ctx, agent } = await setupKernel()
    ctx.tools.register(defineTool({
      name: 'echo',
      description: 'Echo a value.',
      parameters: { value: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      execute: args => Promise.resolve(`echo:${String((args as { value: string }).value)}`),
    }))
    const result = await runCell(ctx, [
      'first = await echo({"value": "one"})',
      'second = await echo({"value": "two"})',
      'second',
    ].join('\n'), { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(valueOf(result)).toEqual({ logs: [], result: 'echo:two' })
    expect(agent.events.filter(event => event.type === 'tool/code-dispatch-start').map(event => event.data)).toEqual([
      {
        rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:code:1',
        name: 'echo', arguments: { value: 'one' },
      },
      {
        rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:code:2',
        name: 'echo', arguments: { value: 'two' },
      },
    ])
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
  })
})
