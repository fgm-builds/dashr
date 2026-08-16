import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FakeCellRuntime, fakeRuntime, runCell, setupPresentation } from './helpers.ts'
import { resolveMaxParallelSubCalls } from '../src/index.ts'

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

/** Dispatch one model-direct tool call (no parent token) through the registry. */
async function modelDirect(ctx: Context, name: string, agent: Agent, arguments_: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('call-direct'),
    name,
    arguments: arguments_,
    agent,
  })
}

describe('assembly — the DASHR row collapses its scope, and only its scope', () => {
  it('a preset-scope mount leaves run_cell the only contributed tool and ships the SDK section', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    registerEcho(ctx)
    const assembly = await ctx.systemPrompt.assemble({ scope: agent.agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['run_cell'])
    const sdk = assembly.sections.find(section => section.name === 'tools:dashr-sdk')
    expect(sdk).toBeDefined()
    expect(sdk?.text).toContain('## Writing cells for run_cell')
    expect(sdk?.text).toContain('async def echo(self, args: EchoArgs) -> str')
    expect(sdk?.text).not.toContain('run_cell(')
  })

  it('a neighbor scope WITHOUT the row keeps its full native schema set (PTC coexistence, part one)', async () => {
    const { ctx, agent, other } = await setupPresentation(fakeRuntime)
    registerEcho(ctx)
    const neighbor = await ctx.systemPrompt.assemble({ scope: other.agent })
    expect(neighbor.tools.map(tool => tool.name)).toEqual(['echo'])
    expect(neighbor.sections.some(section => section.name === 'tools:dashr-sdk')).toBe(false)
    // And the joining agent's own view of the registry still names every
    // tool — the collapse lives in the assembly, not in dispatch visibility.
    expect(ctx.tools.schemas(other.agent).map(tool => tool.name)).toEqual(['echo'])
    expect(ctx.tools.schemas(agent.agent).map(tool => tool.name).sort()).toEqual(['echo', 'run_cell'])
  })

  it('a global assembly (no scope) is untouched by the preset-scope row', async () => {
    const { ctx } = await setupPresentation(fakeRuntime)
    registerEcho(ctx)
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['echo'])
    expect(assembly.sections.some(section => section.name === 'tools:dashr-sdk')).toBe(false)
  })

  it('the SDK section regenerates from the calling scope: a restricted agent loses the tool from its SDK', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    registerEcho(ctx)
    ctx.tools.register(defineTool({
      name: 'secret',
      description: 'Scoped-only tool.',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: args => Promise.resolve(`secret:${String((args as { value: string }).value)}`),
    }))
    // The joined agent restricts the GLOBAL `secret` tool away for itself.
    agent.scope.ctx.tools.restrict({ deny: ['secret'] })
    const assembly = await ctx.systemPrompt.assemble({ scope: agent.agent })
    const sdk = assembly.sections.find(section => section.name === 'tools:dashr-sdk')
    expect(sdk?.text).toContain('async def echo(')
    expect(sdk?.text).not.toContain('secret')
  })
})

describe('the model-direct collapse guard', () => {
  it('denies a model-direct call to another tool with the route-back text', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerEcho(ctx)
    const result = await modelDirect(ctx, 'echo', agent.agent, { value: 'x' })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected denial')
    expect(result.error.message).toBe('only `run_cell` is callable directly — call `echo` from inside a `run_cell` program instead')
    expect((result.content[0] as { text: string }).text).toContain('only `run_cell` is callable directly')
    expect(calls).toEqual([])
  })

  it('lets the neighbor agent call the same tool model-direct (the guard is scoped)', async () => {
    const { ctx, other } = await setupPresentation(fakeRuntime)
    const calls = registerEcho(ctx)
    const result = await modelDirect(ctx, 'echo', other.agent, { value: 'ptc' })
    expect(result.isError).toBe(false)
    expect(calls).toEqual([{ value: 'ptc' }])
  })

  it('passes run_cell itself model-direct, and nested sub-dispatches (parent token) through the bridge', async () => {
    const { ctx, agent } = await setupPresentation(fakeRuntime)
    const calls = registerEcho(ctx)
    const runtime = ctx.rlmRuntime as FakeCellRuntime
    runtime.behavior = async request => {
      const value = await request.bindings[0]!.functions.echo!({ value: 'nested' })
      return { logs: [], value: String(value) }
    }
    const result = await runCell(ctx, 'await tools.echo({ "value": "nested" })', { agent: agent.agent })
    expect(result.isError).toBe(false)
    expect(calls).toEqual([{ value: 'nested' }])
  })
})

describe('config', () => {
  it('resolves the max-parallel cap with the same validation as upstream', () => {
    expect(resolveMaxParallelSubCalls(undefined)).toBe(10)
    expect(resolveMaxParallelSubCalls(1)).toBe(1)
    expect(() => resolveMaxParallelSubCalls(0)).toThrow('dsh-rlm-mode: maxParallelSubCalls must be a positive integer')
    expect(() => resolveMaxParallelSubCalls(1.5)).toThrow('dsh-rlm-mode: maxParallelSubCalls must be a positive integer')
  })

  it('mounts against a composition with no rlmRuntime by staying pending, not crashing the registry', async () => {
    // The wait is declared, not a static inject: a runtime-less deployment
    // simply never activates the row's registrations.
    const { ctx, other } = await setupPresentation(false)
    registerEcho(ctx)
    const neighbor = await ctx.systemPrompt.assemble({ scope: other.agent })
    expect(neighbor.tools.map(tool => tool.name)).toEqual(['echo'])
    expect(ctx.tools.schemas(undefined).map(tool => tool.name)).toEqual(['echo'])
  })
})
