import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { FakeCellRuntime, fakeRuntime, runCell, setup } from './helpers.ts'
import {
  HarnessStore,
  HARNESS_SECTION_ORDER,
  renderHarnessSection,
  resolveHarnessDir,
  resolveRefineModel,
  resolveCompactModel,
  resolveRefineTarget,
} from '../src/index.ts'

/**
 * M4-B Work 1: the Continual Harness (prompt-as-variable) and the refine()
 * binding. The LLM is a stub service provided under `llm` on the root realm —
 * refine()'s host callback resolves it outward through the preset's realm
 * exactly like ctx.subagents for rlm() — and every store/assembly assertion
 * runs against the real harness-store implementation.
 */

/** Mount a stub `ctx.llm` whose stream records every request; the answer is a mutable out-param. */
async function registerStubLlm(ctx: Context, respond: { text: string }): Promise<{ captured: GenerateOptions[] }> {
  const captured: GenerateOptions[] = []
  const fiber = await ctx.plugin({ name: 'stub-llm', apply(c) {
    c.provide('llm', {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        captured.push(options)
        yield { type: 'text-delta', index: 0, text: respond.text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
  } })
  onTestFinished(() => fiber.dispose())
  return { captured }
}

/** Drive one binding call through the fake runtime, as rlm.spec does. */
async function cell(ctx: Context, agent: Agent, code: string): Promise<{ logs: string[], result?: unknown }> {
  const result = await runCell(ctx, code, { agent })
  expect(result.isError, `cell failed: ${JSON.stringify(result.content)}`).toBe(false)
  return result.value as { logs: string[], result?: unknown }
}

/** The harness section text one assembly renders for an agent. */
async function harnessSectionText(ctx: Context, agent: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
  return assembly.sections.find(section => section.name === 'dasher:harness')?.text ?? ''
}

describe('Continual Harness store + section', () => {
  it('renders entries at every assembly and drops the section text when empty', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    expect(await harnessSectionText(ctx, agent.agent)).toBe('')

    const store = new HarnessStore()
    await store.applyOps('dasher-agent', [
      { op: 'add', kind: 'memory', title: 'Prefers tabs', content: 'The user prefers tabs.' },
    ])
    const rendered = renderHarnessSection(store.list('dasher-agent'))
    expect(rendered).toContain('[memory-1] memory — Prefers tabs')
    expect(rendered).toContain('The user prefers tabs.')
    expect(renderHarnessSection([])).toBe('')
  })

  it('sits after the tool-guidance band and neutralizes literal {{ against the prompt-variable machinery', async () => {
    const { ctx, agent } = await setup(fakeRuntime, { refineModel: 'zai/glm-5.2' })
    await registerStubLlm(ctx, { text: '[{"op":"add","kind":"note","title":"Templates","content":"Use {{var}} syntax in prompts."}]' })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      const value = await refine.functions['__call__']!({ args: ['note the template syntax'], kwargs: {} })
      return { logs: [], value }
    }
    await cell(ctx, agent.agent, 'program')

    const assembly = await ctx.systemPrompt.assemble({ agent: agent.agent, scope: agent.agent })
    const harness = assembly.sections.find(section => section.name === 'dasher:harness')
    expect(harness?.text).toContain('Use { {var}} syntax in prompts.')
    // After the tool-guidance band: the assembly sorts sections by order, so
    // the SDK section (order 150) precedes the harness section (order 200),
    // and interpolation over the entry's braces does not throw.
    const names = assembly.sections.map(section => section.name)
    expect(names.indexOf('dasher:harness')).toBeGreaterThan(names.indexOf('tools:dasher-sdk'))
    expect(() => renderPrompt(assembly)).not.toThrow()
    expect(HARNESS_SECTION_ORDER).toBe(200)
  })
})

describe('refine() binding', () => {
  it('applies validated ops, reports the summary, and the NEXT assembly carries the new entry', async () => {
    const { ctx, agent } = await setup(fakeRuntime, { refineModel: 'zai/glm-5.2' })
    const { captured } = await registerStubLlm(ctx, { text: JSON.stringify([
      { op: 'add', kind: 'memory', title: 'Deployment fact', content: 'dev3 runs Ubuntu 26.04.' },
      { op: 'add', kind: 'note', title: 'Tone', content: 'Keep answers terse.' },
    ]) })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      const value = await refine.functions['__call__']!({ args: ['remember the deployment facts'], kwargs: {} })
      return { logs: [], value }
    }
    const result = await cell(ctx, agent.agent, 'program') as { result: unknown }
    expect(result.result).toEqual({
      refined: true,
      applied: [
        { op: 'add', id: 'memory-1', kind: 'memory', title: 'Deployment fact' },
        { op: 'add', id: 'note-1', kind: 'note', title: 'Tone' },
      ],
      entries_before: 0,
      entries_after: 2,
      model: { provider: 'zai', model: 'glm-5.2' },
    })
    // The request the aux model saw: route from the config tier, the harness
    // dump, the instruction, and the op-schema directive.
    expect(captured.length).toBe(1)
    expect(captured[0]!.provider).toBe('zai')
    expect(captured[0]!.model).toBe('glm-5.2')
    expect(captured[0]!.system).toContain('JSON array of operation objects')
    const user = JSON.stringify(captured[0]!.messages)
    expect(user).toContain('remember the deployment facts')
    expect(user).toContain('Current harness entries')
    // Prompt-as-variable: the very next assembly reflects the store change.
    const text = await harnessSectionText(ctx, agent.agent)
    expect(text).toContain('[memory-1] memory — Deployment fact')
    expect(text).toContain('dev3 runs Ubuntu 26.04.')
  })

  it('leaves the store untouched and answers a structured error on unparseable or invalid ops', async () => {
    const { ctx, agent } = await setup(fakeRuntime, { refineModel: 'zai/glm-5.2' })
    const respond = { text: 'I would rather not emit JSON today, sorry.' }
    const { captured } = await registerStubLlm(ctx, respond)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      const unparseable = await refine.functions['__call__']!({ args: ['x'], kwargs: {} })
      return { logs: [], value: { unparseable } }
    }
    const first = await cell(ctx, agent.agent, 'program') as { result: { unparseable?: unknown } }
    expect((first.result.unparseable as { error: string }).error).toContain('could not parse a JSON ops array')
    expect(captured.length).toBe(1)

    respond.text = '[{"op":"add","kind":"vibe","title":"x","content":"y"}]'
    runtime.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      const rejected = await refine.functions['__call__']!({ args: ['x'], kwargs: {} })
      return { logs: [], value: { rejected } }
    }
    const second = await cell(ctx, agent.agent, 'program') as { result: { rejected?: unknown } }
    expect((second.result.rejected as { error: string }).error).toContain('refine() rejected the model\'s ops (store untouched)')
    expect(await harnessSectionText(ctx, agent.agent)).toBe('')
  })

  it('resolves the model route: the agent route when unset, with a structured error when no route exists', async () => {
    const { ctx, agent } = await setup(fakeRuntime, {}, { provider: 'deepseek', model: 'dsv3' })
    const { captured } = await registerStubLlm(ctx, { text: '[]' })
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      const agentRoute = await refine.functions['__call__']!({ args: ['x'], kwargs: {} })
      return { logs: [], value: { agentRoute } }
    }
    await cell(ctx, agent.agent, 'program')
    expect(captured.at(-1)).toMatchObject({ provider: 'deepseek', model: 'dsv3' })

    // No route anywhere: structured error, no llm call.
    const bare = await setup(fakeRuntime)
    await registerStubLlm(bare.ctx, { text: '[]' })
    const bareRuntime = bare.ctx.get('rlmRuntime') as FakeCellRuntime
    let llmCalls = 0
    bare.ctx.on('llm/stream', function countingListener(options, next) {
      llmCalls += 1
      return next()
    })
    bareRuntime.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      const noRoute = await refine.functions['__call__']!({ args: ['x'], kwargs: {} })
      return { logs: [], value: { noRoute } }
    }
    const noRouteCell = await cell(bare.ctx, bare.agent.agent, 'program') as { result: { noRoute?: unknown } }
    expect((noRouteCell.result.noRoute as { error: string }).error).toContain('refine() model route unresolved')
    expect(llmCalls).toBe(0)
  })

  it('pairs a bare refineModel with the agent provider, and forwards exec.signal into the model call', async () => {
    const { ctx, agent } = await setup(fakeRuntime, { refineModel: 'glm-5.2' }, { provider: 'zai', model: 'parent-model' })
    const controller = new AbortController()
    const captured: GenerateOptions[] = []
    const fiber = await ctx.plugin({ name: 'stub-llm-abort', apply(c) {
      c.provide('llm', {
        async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          captured.push(options)
          yield { type: 'text-delta', index: 0, text: '[]' }
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) resolve()
            else options.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled by test' } } }
        },
      })
    } })
    onTestFinished(() => fiber.dispose())
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      const pending = refine.functions['__call__']!({ args: ['x'], kwargs: {} })
      controller.abort()
      await pending
      return { logs: [], value: null }
    }
    // The outer abort settles the run as failed (the bridge discards results
    // from a run that is over — the M3-B contract); the abort-chain proof is
    // in what the model call received: the resolved route AND the signal.
    const result = await runCell(ctx, 'program', { agent: agent.agent, signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(captured[0]!.provider).toBe('zai')
    expect(captured[0]!.model).toBe('glm-5.2')
    expect(captured[0]!.signal?.aborted).toBe(true)
  })


  it('rejects malformed selectors at the route layer: a leading or trailing slash names an empty half', () => {
    const agent = { options: { provider: 'zai', model: 'parent-model' } } as unknown as Agent
    // Well-formed forms keep their routes.
    expect(resolveRefineTarget('zai/glm-5.2', agent)).toEqual({ provider: 'zai', model: 'glm-5.2' })
    expect(resolveRefineTarget('glm-5.2', agent)).toEqual({ provider: 'zai', model: 'glm-5.2' })
    // '/glm-5.2' must NOT slip through as a bare id containing a slash
    // (acceptance fix P1: indexOf('/') === 0 enters the split branch and the
    // empty provider half is rejected there, instead of becoming a model id).
    const leading = resolveRefineTarget('/glm-5.2', agent)
    expect('error' in leading && leading.error).toContain('empty provider or model half')
    const trailing = resolveRefineTarget('zai/', agent)
    expect('error' in trailing && trailing.error).toContain('empty provider or model half')
  })

  it('validates the binding signature and requires an agent + llm service', async () => {
    const { ctx, agent } = await setup(fakeRuntime)
    const runtime = ctx.get('rlmRuntime') as FakeCellRuntime
    runtime.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      const noArgs = await refine.functions['__call__']!({ args: [], kwargs: {} })
      const kwargs = await refine.functions['__call__']!({ args: ['x'], kwargs: { label: 'y' } })
      const empty = await refine.functions['__call__']!({ args: ['   '], kwargs: {} })
      return { logs: [], value: { noArgs, kwargs, empty } }
    }
    const result = await cell(ctx, agent.agent, 'program') as { result: Record<string, { error?: string }> }
    expect(result.result['noArgs']?.error).toContain('exactly one positional instruction string')
    expect(result.result['kwargs']?.error).toContain('exactly one positional instruction string')
    expect(result.result['empty']?.error).toContain('non-empty string')

    // No ctx.llm mounted: structured unavailability, never a crash.
    runtime.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      const value = await refine.functions['__call__']!({ args: ['x'], kwargs: {} })
      return { logs: [], value }
    }
    const noLlm = await cell(ctx, agent.agent, 'program') as { result?: { error?: string } }
    expect(noLlm.result?.error).toContain('no ctx.llm service')
  })
})

describe('harness persistence', () => {
  it('round-trips through harnessDir: a fresh composition restores the same agent\'s entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashr-harness-'))
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })

    const first = await setup(fakeRuntime, { harnessDir: dir }, { provider: 'zai', model: 'glm-5.2' })
    await registerStubLlm(first.ctx, { text: '[{"op":"add","kind":"skill","title":"Rebuild","content":"npm run build in both packages."}]' })
    const runtimeOne = first.ctx.get('rlmRuntime') as FakeCellRuntime
    runtimeOne.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      const value = await refine.functions['__call__']!({ args: ['remember the rebuild step'], kwargs: {} })
      return { logs: [], value }
    }
    await cell(first.ctx, first.agent.agent, 'program')

    // A completely fresh composition (new Context, new store) over the same
    // directory: the same agent id ('dasher-agent' in both setups) restores
    // its entries on first touch.
    const second = await setup(fakeRuntime, { harnessDir: dir })
    const text = await harnessSectionText(second.ctx, second.agent.agent)
    expect(text).toContain('[skill-1] skill — Rebuild')
    expect(text).toContain('npm run build in both packages.')
  })

  it('is memory-only without harnessDir: a fresh composition starts empty', async () => {
    const first = await setup(fakeRuntime, {}, { provider: 'zai', model: 'glm-5.2' })
    await registerStubLlm(first.ctx, { text: '[{"op":"add","kind":"note","title":"N","content":"C"}]' })
    const runtimeOne = first.ctx.get('rlmRuntime') as FakeCellRuntime
    runtimeOne.behavior = async (request) => {
      const refine = request.bindings.find(binding => binding.global === 'refine')!
      await refine.functions['__call__']!({ args: ['x'], kwargs: {} })
      return { logs: [], value: null }
    }
    await cell(first.ctx, first.agent.agent, 'program')
    const second = await setup(fakeRuntime)
    expect(await harnessSectionText(second.ctx, second.agent.agent)).toBe('')
  })
})

describe('config boundary (empty strings are typos, not unset)', () => {
  it('rejects empty strings for all three new keys at the resolver and mount layers', () => {
    expect(() => resolveHarnessDir('')).toThrow('harnessDir must be a non-empty string')
    expect(() => resolveRefineModel('')).toThrow('refineModel must be a non-empty string')
    expect(() => resolveCompactModel('')).toThrow('compactModel must be a non-empty string')
    expect(resolveHarnessDir(undefined)).toBeUndefined()
    expect(resolveRefineModel(undefined)).toBeUndefined()
    expect(resolveCompactModel(undefined)).toBeUndefined()
  })

  it('fails the preset mount loudly on an empty key', async () => {
    await expect(setup(fakeRuntime, { refineModel: '' })).rejects.toThrow('refineModel must be a non-empty string')
    await expect(setup(fakeRuntime, { compactModel: '' })).rejects.toThrow('compactModel must be a non-empty string')
    await expect(setup(fakeRuntime, { harnessDir: '' })).rejects.toThrow('harnessDir must be a non-empty string')
  })
})
