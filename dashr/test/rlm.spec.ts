import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FakeCellRuntime, fakeRuntime, fakeSubagentsService, registerFakeDelegationTools, runCell, setupPresentation, setupKernel } from './helpers.ts'

/**
 * The v0.1.5 rlm()/agent_message()/agent_list()/rlm_workflow()/rlm_ralph()
 * bridges (ADR-0001 + plan Q6/Q19/Q25): mode dispatch THROUGH the tool layer.
 * The seven tool-layer delegation tools (the eighth, `report`, is bridged over the service layer) are registered in the test registry the
 * way the standard preset registers the real ones (masking never touches the
 * registry), and every assertion below checks the observable contract of a
 * registry sub-dispatch: the parent token (guard pass), the code-dispatch
 * audit events, argument mapping, foreground/background passthrough, and the
 * tool's own JSON output returning unchanged. The service layer appears ONLY
 * where no tool covers the direction: agent_message(receiver='parent')
 * bridging reportFrom (now one flat object-form call).
 */

import type { RlmJsonValue } from '../src/runtime-surface.ts'

/** One bare callable binding function of a run request (the {args, kwargs} packaging). */
type Callable = (args: unknown) => Promise<RlmJsonValue>

/** Resolve one bare callable from a fake run request by its global name. */
function callableOf(request: { bindings: { global: string, functions: Record<string, (args: unknown) => Promise<RlmJsonValue>> }[] }, global: string): Callable {
  const found = request.bindings.find(binding => binding.global === global)
  if (!found) throw new Error(`no binding global ${JSON.stringify(global)}; have ${request.bindings.map(b => b.global).join(', ')}`)
  const fn = found.functions['__call__']
  if (!fn) throw new Error(`binding global ${JSON.stringify(global)} has no __call__`)
  return fn
}

/** Drive one `ipython` through the registry pipeline and return its value. */
async function cell(ctx: Context, agent: Agent, code: string): Promise<{ value: { logs: string[], result?: unknown } }> {
  const result = await runCell(ctx, code, { agent })
  expect(result.isError, `cell failed: ${JSON.stringify(result.content)}`).toBe(false)
  return { value: result.value as { logs: string[], result?: unknown } }
}

describe('rlm() mode dispatch through the tool layer', () => {
  it("rlm({\"mode\": \"spawn\"}) dispatches the subagent tool with the required default description", async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const result = await callableOf(request, 'rlm')({ args: [{ mode: 'spawn', prompt: 'do the thing' }], kwargs: {} })
      return { logs: [], value: result }
    }
    const result = await cell(ctx, agent.agent, 'program')
    // The tool's own JSON output, unchanged (信息量不减).
    expect(result.value.result).toEqual({ kind: 'continuable', subagentId: 'child-1' })
    expect(calls).toEqual([{ tool: 'subagent', args: { description: 'subagent', prompt: 'do the thing' }, parented: true }])
  })

  it("label forwards as the tool's display description; run_in_background passes through both ways", async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const rlm = callableOf(request, 'rlm')
      const labeled = await rlm({ args: [{ mode: 'spawn', prompt: 'p1', label: 'worker bee' }], kwargs: {} })
      const foreground = await rlm({ args: [{ mode: 'spawn', prompt: 'p2', run_in_background: false }], kwargs: {} })
      const background = await rlm({ args: [{ mode: 'spawn', prompt: 'p3', run_in_background: true }], kwargs: {} })
      return { logs: [], value: { labeled, foreground, background } }
    }
    await cell(ctx, agent.agent, 'program')
    // Omitted run_in_background stays ABSENT (the tool's own backgroundMode
    // config decides); explicit values pass through verbatim.
    expect(calls.map(call => call.args)).toEqual([
      { description: 'worker bee', prompt: 'p1' },
      { description: 'subagent', prompt: 'p2', run_in_background: false },
      { description: 'subagent', prompt: 'p3', run_in_background: true },
    ])
    expect(calls.every(call => call.parented)).toBe(true)
  })

  it("rlm({\"mode\": \"fork\"}) dispatches subagent_fork with the same mapping", async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const result = await callableOf(request, 'rlm')({ args: [{ mode: 'fork', prompt: 'fork me', label: 'twin' }], kwargs: {} })
      return { logs: [], value: result }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ kind: 'continuable', subagentId: 'fork-1' })
    expect(calls).toEqual([{ tool: 'subagent_fork', args: { description: 'twin', prompt: 'fork me' }, parented: true }])
  })

  it("rlm({\"mode\": \"interrupt\"}) dispatches interrupt_agent via agent_id", async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const rlm = callableOf(request, 'rlm')
      const positional = await rlm({ args: [{ mode: 'interrupt', agent_id: 'agent-7' }], kwargs: {} })
      const keyword = await rlm({ args: [{ mode: 'interrupt', agent_id: 'agent-8' }], kwargs: {} })
      return { logs: [], value: { positional, keyword } }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ positional: { accepted: true }, keyword: { accepted: true } })
    expect(calls.map(call => [call.tool, call.args])).toEqual([
      ['interrupt_agent', { agent_id: 'agent-7' }],
      ['interrupt_agent', { agent_id: 'agent-8' }],
    ])
  })

  it('a failed dispatch rejects the binding (ToolCallError at the kernel), carrying the tool error', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    registerFakeDelegationTools(ctx, { subagent: () => { throw new Error('depth limit exceeded') } })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      try {
        await callableOf(request, 'rlm')({ args: [{ mode: 'spawn', prompt: 'p' }], kwargs: {} })
        return { logs: [], value: 'unreachable' }
      } catch (error: unknown) {
        return { logs: [], value: `caught: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toBe('caught: depth limit exceeded')
  })

  it('rejects the removed model kwarg with the structured replacement guidance', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const result = await callableOf(request, 'rlm')({ args: [{ mode: 'spawn', prompt: 'p', model: 'other/model' }], kwargs: {} })
      return { logs: [], value: result }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ error: expect.stringContaining('unexpected key(s): model') })
    expect(calls).toEqual([])
  })

  it('rejects unknown modes, malformed signatures, and stray kwargs as structured errors', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const rlm = callableOf(request, 'rlm')
      const remove = await rlm({ args: [{ mode: 'remove' }], kwargs: {} })
      const kwargMode = await rlm({ args: [], kwargs: { mode: 'spawn' } })
      const missingPrompt = await rlm({ args: [{ mode: 'spawn' }], kwargs: {} })
      const extraPositional = await rlm({ args: [{ mode: 'spawn', prompt: 'p' }, 'x'], kwargs: {} })
      const badLabel = await rlm({ args: [{ mode: 'spawn', prompt: 'p', label: 42 }], kwargs: {} })
      const badBackground = await rlm({ args: [{ mode: 'spawn', prompt: 'p', run_in_background: 'yes' }], kwargs: {} })
      const missingAgentId = await rlm({ args: [{ mode: 'interrupt' }], kwargs: {} })
      const strayKey = await rlm({ args: [{ mode: 'spawn', prompt: 'p', depth: 3 }], kwargs: {} })
      return { logs: [], value: { remove, kwargMode, missingPrompt, extraPositional, badLabel, badBackground, missingAgentId, strayKey } }
    }
    const result = await cell(ctx, agent.agent, 'program')
    const errors = result.value.result as Record<string, { error: unknown }>
    expect(errors['remove']).toEqual({ error: expect.stringContaining('"spawn" | "fork" | "interrupt"') })
    expect(errors['kwargMode']).toEqual({ error: expect.stringContaining('not keyword arguments') })
    expect(errors['missingPrompt']).toEqual({ error: expect.stringContaining('requires {"prompt"') })
    expect(errors['extraPositional']).toEqual({ error: expect.stringContaining('exactly one positional') })
    expect(errors['badLabel']).toEqual({ error: expect.stringContaining('label must be a string') })
    expect(errors['badBackground']).toEqual({ error: expect.stringContaining('run_in_background must be a boolean') })
    expect(errors['missingAgentId']).toEqual({ error: expect.stringContaining('requires {"agent_id"') })
    expect(errors['strayKey']).toEqual({ error: expect.stringContaining('unexpected key(s): depth') })
    expect(calls).toEqual([])
  })

  it('logs code-dispatch audit events for the bridged tool (nested sub-dispatch pipeline)', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      await callableOf(request, 'rlm')({ args: [{ mode: 'spawn', prompt: 'audited' }], kwargs: {} })
      return { logs: [], value: 'done' }
    }
    await cell(ctx, agent.agent, 'program')
    const starts = agent.events.filter(event => event.type === 'tool/code-dispatch-start').map(event => (event.data as { name: string }).name)
    const settles = agent.events.filter(event => event.type === 'tool/code-dispatch').map(event => (event.data as { name: string }).name)
    expect(starts).toEqual(['subagent'])
    expect(settles).toEqual(['subagent'])
  })
})

describe('agent_message() — the dual-use A2A bridge', () => {
  it("receiver='child' dispatches the send_message tool with the required subagent_id", async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const result = await callableOf(request, 'agent_message')({ args: [{ receiver: 'child', message: 'here is more work', subagent_id: 'child-1' }], kwargs: {} })
      return { logs: [], value: result }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ messageId: 'msg-1' })
    expect(calls).toEqual([{ tool: 'send_message', args: { subagent_id: 'child-1', message: 'here is more work' }, parented: true }])
  })

  it("receiver='child' without subagent_id is a structured error, dispatching nothing", async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const result = await callableOf(request, 'agent_message')({ args: [{ receiver: 'child', message: 'hi' }], kwargs: {} })
      return { logs: [], value: result }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ error: expect.stringContaining('requires {"subagent_id"') })
    expect(calls).toEqual([])
  })

  it("receiver='parent' bridges the service layer: reportFrom with zero ids, wakeup delivery", async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const reports = await fakeSubagentsService(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const result = await callableOf(request, 'agent_message')({ args: [{ receiver: 'parent', message: 'task complete' }], kwargs: {} })
      return { logs: [], value: result }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ delivered: true, message_id: 'mid-1' })
    expect(reports).toHaveLength(1)
    expect(reports[0]!.child).toBe(agent.agent)
    expect(reports[0]!.content).toEqual([{ type: 'text', text: 'task complete' }])
    expect(reports[0]!.delivery).toBe('wakeup')
    expect(reports[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it("receiver='parent' surfaces a service UNAUTHORIZED rejection as a structured error value", async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    await fakeSubagentsService(ctx, () => {
      const error = new Error('agent "dashr-agent" is not a live continuable subagent and cannot report') as Error & { code: string }
      error.code = 'UNAUTHORIZED'
      return Promise.reject(error)
    })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const result = await callableOf(request, 'agent_message')({ args: [{ receiver: 'parent', message: 'root tries to report' }], kwargs: {} })
      return { logs: [], value: result }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ error: expect.stringContaining('only a live continuable child agent can report') })
  })

  it("receiver='parent' with no ctx.subagents service is a structured unavailable error", async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const result = await callableOf(request, 'agent_message')({ args: [{ receiver: 'parent', message: 'hello?' }], kwargs: {} })
      return { logs: [], value: result }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ error: expect.stringContaining('no ctx.subagents service') })
  })

  it('unknown receivers and malformed signatures are structured errors', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const agentMessage = callableOf(request, 'agent_message')
      const sibling = await agentMessage({ args: [{ receiver: 'sibling', message: 'm' }], kwargs: {} })
      const oneArg = await agentMessage({ args: [{ receiver: 'child' }], kwargs: {} })
      const stray = await agentMessage({ args: [{ receiver: 'child', message: 'm', urgent: true }], kwargs: {} })
      return { logs: [], value: { sibling, oneArg, stray } }
    }
    const result = await cell(ctx, agent.agent, 'program')
    const errors = result.value.result as Record<string, { error: unknown }>
    expect(errors['sibling']).toEqual({ error: expect.stringContaining("expected 'child' or 'parent'") })
    expect(errors['oneArg']).toEqual({ error: expect.stringContaining('requires {"receiver"') })
    expect(errors['stray']).toEqual({ error: expect.stringContaining('unexpected key(s): urgent') })
    expect(calls).toEqual([])
  })
})

describe('agent_list / rlm_workflow / rlm_ralph bridges', () => {
  it("agent_list({\"scope\": ...}) dispatches list_agents with the default 'children' scope", async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const rlmList = callableOf(request, 'agent_list')
      const byDefault = await rlmList({ args: [], kwargs: {} })
      const explicit = await rlmList({ args: [{ scope: 'descendants' }], kwargs: {} })
      const invalid = await rlmList({ args: [{ scope: 'everywhere' }], kwargs: {} })
      return { logs: [], value: { byDefault, explicit, invalid } }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({
      byDefault: [{ kind: 'child', id: 'child-1', label: 'subagent', status: 'idle' }],
      explicit: [{ kind: 'child', id: 'child-1', label: 'subagent', status: 'idle' }],
      invalid: { error: expect.stringContaining("'children' or 'descendants'") },
    })
    expect(calls.filter(call => call.tool === 'list_agents').map(call => call.args)).toEqual([
      { scope: 'children' }, { scope: 'descendants' },
    ])
  })

  it('rlm_workflow({"meta", "script"}) dispatches the workflow tool with both fields verbatim', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    const meta = { name: 'audit', description: 'audit many files' }
    runtime.behavior = async (request) => {
      const result = await callableOf(request, 'rlm_workflow')({ args: [{ meta, script: 'return 1' }], kwargs: {} })
      return { logs: [], value: result }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toEqual({ runId: 'wf-1', agentsStarted: 1, result: null })
    expect(calls).toEqual([{ tool: 'workflow', args: { meta, script: 'return 1' }, parented: true }])
  })

  it('rlm_ralph({"objective", "max_rounds"}) maps keys 1:1, omitting None', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerFakeDelegationTools(ctx)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const ralph = callableOf(request, 'rlm_ralph')
      const plain = await ralph({ args: [{ objective: 'finish the migration' }], kwargs: {} })
      const capped = await ralph({ args: [{ objective: 'finish the migration', max_rounds: 3 }], kwargs: {} })
      const explicitNone = await ralph({ args: [{ objective: 'finish the migration', max_rounds: null }], kwargs: {} })
      const bad = await ralph({ args: [{ objective: 'finish the migration', max_rounds: 0 }], kwargs: {} })
      return { logs: [], value: { plain, capped, explicitNone, bad } }
    }
    const result = await cell(ctx, agent.agent, 'program')
    expect(result.value.result).toMatchObject({ plain: { runId: 'ralph-1' }, capped: { runId: 'ralph-1' }, explicitNone: { runId: 'ralph-1' } })
    expect((result.value.result as Record<string, { error?: string }>)['bad']).toEqual({ error: expect.stringContaining('max_rounds must be a positive integer') })
    expect(calls.map(call => call.args)).toEqual([
      { objective: 'finish the migration' },
      { objective: 'finish the migration', maxRounds: 3 },
      { objective: 'finish the migration' },
    ])
  })
})

describe('the flat binding surface (v0.1.5 shape)', () => {
  it('binds no masked name and no rlm_await; glob binds as file_glob', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    registerFakeDelegationTools(ctx)
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    ctx.tools.register(defineTool({
      name: 'glob',
      description: 'Glob tool (test).',
      parameters: { pattern: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: () => Promise.resolve('globbed'),
    }))
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const globalsSeen = request.bindings.map(binding => binding.global)
      const fileGlob = callableOf(request, 'file_glob')
      const globbed = await fileGlob({ args: [{ pattern: '*.ts' }], kwargs: {} })
      return { logs: [], value: { globalsSeen, globbed } }
    }
    const result = await cell(ctx, agent.agent, 'program')
    const { globalsSeen, globbed } = result.value.result as { globalsSeen: string[], globbed: string }
    expect(globalsSeen).toContain('file_glob')
    expect(globalsSeen).not.toContain('glob')
    expect(globalsSeen).not.toContain('rlm_await')
    expect(globalsSeen).not.toContain('tools')
    for (const masked of ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent', 'workflow', 'ralph']) {
      expect(globalsSeen).not.toContain(masked)
    }
    expect(globbed).toBe('globbed')
  })
})

describe('rlm() end-to-end on a real kernel (foreground through the tool layer)', () => {
  it("run_in_background=False blocks the cell until the bridged tool's result arrives", async () => {
    const { ctx, agent } = await setupKernel()
    const calls = registerFakeDelegationTools(ctx, {
      subagent: () => ({ kind: 'foreground', runId: 'run-9', output: [{ type: 'text', text: 'child finished the work' }] }),
    })
    const result = await runCell(ctx, [
      "result = await rlm({'mode': 'spawn', 'prompt': 'do it synchronously', 'run_in_background': False})",
      'result',
    ].join('\n'), { agent: agent.agent })
    expect(result.isError, `cell failed: ${JSON.stringify(result.content)}`).toBe(false)
    expect((result.value as { result: unknown }).result).toEqual({
      kind: 'foreground', runId: 'run-9', output: [{ type: 'text', text: 'child finished the work' }],
    })
    expect(calls).toEqual([{ tool: 'subagent', args: { description: 'subagent', prompt: 'do it synchronously', run_in_background: false }, parented: true }])
  }, 60_000)
})
