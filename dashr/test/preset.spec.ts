/**
 * Preset smoke tier: the shipped `preset/dashr/agent.cordis.yml`, mounted for
 * real by `@deepseek-ai/dsh-agent-presets` (0.1.0-rc.6) the way a deployment
 * does — the roster's `mount()` under an agent factory `setup`, plus the
 * exported per-agent `mountPreset` primitive where the test needs one
 * composition per agent.
 *
 * The composition resolves its rows as BARE specifiers from the HOST
 * composition's baseUrl (the roster's loader sends package names to the
 * recorded host base, never to the preset directory), so `ctx.baseUrl` points
 * inside this package: `dsh-rlm-mode` resolves by package
 * self-reference and the `@deepseek-ai/dsh-*`
 * rows through `node_modules`. That resolution is Node's own ESM loader
 * (`cordis-plugin-loader`'s internal loader, which needs
 * `node-addon-require-builtin` — a devDependency here, a real harness ships
 * it), so the rows load the BUILT `lib/` entry points — `npm run build`
 * before `npm test` (the `pretest` script chains it, including the sibling
 * provider package whose packed file: copy must carry `lib/`).
 *
 * Real kernels run throughout (no mocks, per dsh's real-over-mock policy);
 * each test disposes its whole context on finish, which tears the standing
 * mount down with the kernel subprocess (§10.9 orphan discipline).
 * @module test/preset.spec
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets, { mountPreset, standingMountFor } from '@deepseek-ai/dsh-agent-presets'
import { leakedServices } from '@deepseek-ai/dsh-agent-presets'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import WorkerThreadCodeRuntime from '@deepseek-ai/dsh-code-runtime-worker-thread'
import { apply as presentAs, inject as presentationInject, Config as presentationConfig } from '@deepseek-ai/dsh-agent-tool-presentation'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'

/**
 * The kernel interpreter, most stable first. `DASHR_KERNEL_PYTHON` is the
 * knob the preset file itself reads; `DASHR_TEST_PYTHON` is the M1/M2A test
 * convention. The `/tmp` venv is this dev box's stable copy — workspace venvs
 * are uv-cache symlinks that concurrent dev processes can tear down
 * mid-run — and on machines without it the chain falls through to the
 * package venvs, then `python3`.
 */
function kernelPython(): string {
  const candidates = [
    process.env.DASHR_KERNEL_PYTHON,
    process.env.DASHR_TEST_PYTHON,
    '/tmp/dashr-kernel-venv/bin/python',
    fileURLToPath(new URL('../.venv-kernel/bin/python', import.meta.url)),
    fileURLToPath(new URL('../../dashr/.venv-kernel/bin/python', import.meta.url)),
    'python3',
  ]
  return candidates.find(candidate => candidate !== undefined && existsSync(candidate)) ?? 'python3'
}

// The preset's `!!js` env knobs, resolved once per test FILE (each spec
// file runs in its own worker; the roster reads them at mount time).
process.env.DASHR_KERNEL_PYTHON = kernelPython()
// The include row's path is a LITERAL placeholder in the shipped file (group
// rows skip `!!js` interpolation, so it cannot be an env expression). Mirror
// `install.sh`: stage a temp copy of the shipped preset root with the
// placeholder replaced by the pinned `@deepseek-ai/dsh` devDependency's
// standard composition (its npm tarball ships `config/agent-presets`).
const STANDARD_PRESET_PATH = fileURLToPath(
  new URL('../node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml', import.meta.url),
)
const PLACEHOLDER = 'DASHR_PLACEHOLDER_standard_preset_path_install_script_required'
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../preset', import.meta.url))
const PRESET_ROOT = mkdtempSync(join(tmpdir(), 'dashr-preset-root-'))
mkdirSync(join(PRESET_ROOT, 'rlm-mode'), { recursive: true })
copyFileSync(join(SHIPPED_PRESET_ROOT, 'rlm-mode', 'agent.cordis.yml'), join(PRESET_ROOT, 'rlm-mode', 'agent.cordis.yml'))
copyFileSync(join(SHIPPED_PRESET_ROOT, 'rlm-mode', 'preset.yml'), join(PRESET_ROOT, 'rlm-mode', 'preset.yml'))
writeFileSync(
  join(PRESET_ROOT, 'rlm-mode', 'agent.cordis.yml'),
  readFileSync(join(PRESET_ROOT, 'rlm-mode', 'agent.cordis.yml'), 'utf8').replace(PLACEHOLDER, STANDARD_PRESET_PATH),
)
const WORKDIR = mkdtempSync(join(tmpdir(), 'dashr-preset-'))
process.env.DSH_CWD = WORKDIR


/** The base bare preset rows resolve from: inside this package, so the walk reaches its node_modules. */
const HOST_BASE = new URL('.', import.meta.url).href

/**
 * Boot the minimal host composition the roster's own test suite uses
 * (mount.spec.ts's harness): the registries a preset contributes to, the
 * agent registry + loop (an assembly consumer), and the preset roster over
 * this package's shipped `preset/` root.
 * @param extras - optional extra host rows (the PTC runtime, a workdir).
 * @returns the context, with whole-tree disposal registered on test finish.
 */
async function harness(extras: { ptcRuntime?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = HOST_BASE
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  // The HOST fs backend the restacked preset's `tool-fs` row resolves (the
  // standard-preset shape — the deployment's host owns fs, not the preset;
  // the e2e test below writes and reads real bytes through it).
  await ctx.plugin(LocalFileSystem, { cwd: process.env.DSH_CWD })
  // Host-plane stubs for the services the stacked preset's STANDARD rows
  // resolve (the rename-era restack, 2026-08-16: this preset now carries the
  // full standard tool set whose backends are host-plane singletons). The
  // real deployment supplies these (shell/fs/subprocess/…), so the test
  // host mirrors just the surfaces the rows touch at MOUNT time — every
  // remaining call is execution-time and these spec tests never drive those
  // tools. The two group-internal services (compaction, workflowEngine) are
  // provided by the preset's own rows inside their isolate realms, exactly
  // as on the real host.
  await ctx.plugin({ name: 'host-services-for-stacked-preset', apply(c) {
    c.provide('shell', { sandboxMode: undefined })
    c.provide('shellEnv', { collect: () => ({}) })
    c.provide('subprocess', {})
    c.provide('jobs', {
      attachController() {},
      onJobDone() {},
    })
    // skill-filesystem registers its provider at mount and disposes it on
    // teardown, so the stub must actually invoke the factory — an ignored
    // factory leaves `provider` undefined and the cleanup throws.
    let skillProvider: { dispose(): Promise<void> } | undefined
    c.provide('skills', {
      registerProvider(factory: (control: unknown) => { dispose(): Promise<void> }) {
        skillProvider = factory({ invalidate() {}, signal: new AbortController().signal })
      },
      list: async () => [],
      get: async () => undefined,
      snapshot: async () => ({ skills: [], complete: true }),
    })
    onTestFinished(async () => { await skillProvider?.dispose() })
    c.provide('goals', { get: () => undefined })
    c.provide('userQuestions', {})
    c.provide('web', {})
    c.provide('tokenMeter', { measure: () => ({ totalTokens: 0 }) })
    c.provide('commands', { register: () => undefined })
    // getProvider → undefined defers the subagent TOOL rows gracefully (the
    // upstream tool logs "not registered yet"); rlm() still resolves this
    // service directly. Tests that need spawn behavior mutate `start`.
    c.provide('subagents', {
      getProvider: () => undefined,
      async start() { throw new Error('harness subagents stub: start not configured for this test') },
    })
  } })
  if (extras.ptcRuntime) {
    // Host-plane PTC runtime, exactly where the `code` preset expects it.
    await ctx.plugin(WorkerThreadCodeRuntime, {})
  }
  await ctx.plugin(AgentPresets, {
    default: 'rlm-mode',
    roots: [{ path: PRESET_ROOT, trust: 'user' }],
    includeUserRoot: false,
  })
  // Disposing the ROOT fiber unwinds the roster's standing mount (which
  // outlives every agent by design) and with it the kernel provider's
  // teardown — the orphan-free path this suite relies on.
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return ctx
}

/** True when the pid names a live process we can signal. */
function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: exists but not signalable — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Count live `ipykernel_launcher` subprocesses on the machine (the §10.9
 * orphan-gate pattern; the bracketed `-m` keeps pgrep from matching itself).
 * The harness's own notebook kernels run under a fork-server `-c` template
 * and never match, so the count isolates this suite's kernels.
 */
function kernelProcessCount(): number {
  try {
    return Number(execFileSync('pgrep', ['-cf', '--', '-[m] ipykernel_launcher'], { encoding: 'utf8' }).trim())
  } catch {
    return 0
  }
}

/** Create one agent composed from the dashr preset, exactly as a factory `setup` would. */
async function agentOn(ctx: Context, id: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => { void await ctx.agentPresets.mount(agentCtx, 'rlm-mode') },
  })
  return handle.agent
}

/** The handle variant, for tests that dispose the agent (per-key kernel teardown). */
async function agentHandleOn(ctx: Context, id: string): Promise<{ handle: { dispose(): Promise<void> }, agent: Agent }> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => { void await ctx.agentPresets.mount(agentCtx, 'rlm-mode') },
  })
  return { handle, agent: handle.agent }
}

/** Model-direct tool dispatch through the registry pipeline, as the loop would drive it. */
function execute(
  ctx: Context,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`preset-${name}`),
    name,
    arguments: args,
    agent,
  })
}

/** The model-visible text of one dispatch's content blocks. */
function contentText(result: ToolExecutionResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

/** `run_cell` shorthand. */
function runCell(ctx: Context, agent: Agent, code: string): Promise<ToolExecutionResult> {
  return execute(ctx, agent, 'run_cell', { code, description: 'preset smoke cell' })
}

/** Strip ipykernel's one-time Comm DeprecationWarning noise from captured logs (M2A precedent). */
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

/** The success value of one `run_cell` dispatch, with warning noise removed. */
function cellValue(result: ToolExecutionResult): { logs: string[]; result?: unknown } {
  expect(result.isError, `cell failed: ${String(result.content)}`).toBe(false)
  const value = result.value as { logs: string[]; result?: unknown }
  return { ...value, logs: stripWarnings(value.logs) }
}

/** Every `rlmRuntime` implementation currently in the service store, raw values. */
function rlmRuntimeImpls(ctx: Context): unknown[] {
  return Object.getOwnPropertySymbols(ctx.reflect.store)
    .map(key => ctx.reflect.store[key])
    .filter(impl => impl !== undefined && impl.name === 'rlmRuntime')
    .map(impl => impl!.value)
}

/** Whether the ROOT realm maps `name` to a live registration. */
function rootResolves(ctx: Context, name: string): boolean {
  const key = ctx.root[Context.isolate][name]
  return key !== undefined && ctx.reflect.store[key] !== undefined
}

describe('the dashr preset roster', () => {
  it('lists and resolves the shipped composition without a broken flag', async () => {
    const ctx = await harness()
    const listed = await ctx.agentPresets.list()

    expect(listed.map(preset => preset.id)).toEqual(['rlm-mode'])
    expect(listed[0]!.broken).toBeUndefined()
    expect(listed[0]!.path).toBe(join(PRESET_ROOT, 'rlm-mode', 'agent.cordis.yml'))
    expect((await ctx.agentPresets.resolve('rlm-mode')).id).toBe('rlm-mode')
  })

  it('mounts the real composition for two sessions and scopes the assembly to them', async () => {
    const ctx = await harness()
    const dashr = await agentOn(ctx, 'sess-dashr-a')
    const second = await agentOn(ctx, 'sess-dashr-b')
    const bare = await ctx.agents.create({ sessionId: SessionId('sess-bare') })

    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(dashr))
    // Model-facing tools collapse to the transport; every registered tool
    // lives in the Python SDK section instead.
    expect(prompt.tools.map(schema => schema.name)).toEqual(['run_cell'])
    const sdk = prompt.sections.find(section => section.name === 'tools:dashr-sdk')
    expect(sdk).toBeDefined()
    expect(String(sdk!.text)).toContain('run_cell')
    expect(String(sdk!.text)).toContain('Python')
    // Mode-defining check: the PTC transport name must not appear in the
    // Python SDK (tool descriptions legitimately mention the word
    // TypeScript now that the standard catalog rides the bindings).
    expect(String(sdk!.text)).not.toContain('run_code')
    // The preset persona shadows the deployment default for this agent.
    expect(prompt.sections.map(section => section.name)).toContain('deployment:persona')

    // A second session joins the same standing mount without colliding.
    const secondPrompt = await ctx.systemPrompt.assemble(assembleContextFor(second))
    expect(secondPrompt.tools.map(schema => schema.name)).toEqual(['run_cell'])
    expect(secondPrompt.sections.map(section => section.name)).toContain('tools:dashr-sdk')

    // A neighbor that joined no preset sees none of it: empty global layer,
    // no run_cell, no SDK section. It still sees the HOST's deployment persona
    // section (the harness mounts SystemPrompt with an empty persona), which
    // is exactly what the preset's persona shadows for joined agents — so the
    // leak check is on the TEXT, not the section name.
    const barePrompt = await ctx.systemPrompt.assemble(assembleContextFor(bare.agent))
    expect(barePrompt.tools.map(schema => schema.name)).toEqual([])
    expect(barePrompt.sections.map(section => section.name)).not.toContain('tools:dashr-sdk')
    const barePersona = barePrompt.sections.find(section => section.name === 'deployment:persona')
    expect(String(barePersona?.text ?? '')).not.toContain('DASHR agent')
    const dashrPersona = prompt.sections.find(section => section.name === 'deployment:persona')
    expect(String(dashrPersona?.text ?? '')).toContain('DASHR agent')
  })

  it('keeps the kernel runtime out of the root realm (isolate realm) and leak-free at mount', async () => {
    const ctx = await harness()
    const dashr = await agentOn(ctx, 'sess-realm-a')
    await agentOn(ctx, 'sess-realm-b')

    // Realm isolation: the host plane never resolves rlmRuntime…
    expect(rootResolves(ctx, 'rlmRuntime')).toBe(false)
    expect(ctx.reflect.get('rlmRuntime', false)).toBeUndefined()
    // …but a caller holding the agent addresses the standing instance, and a
    // non-dashr agent addresses nothing.
    expect(ctx.agentPresets.serviceFor(dashr, 'rlmRuntime')).toBeDefined()
    const bare = await ctx.agents.create({ sessionId: SessionId('sess-realm-bare') })
    expect(ctx.agentPresets.serviceFor(bare.agent, 'rlmRuntime')).toBeUndefined()
    // The mount audit's own leak check is empty for this composition.
    const mount = standingMountFor(dashr.ctx)
    expect(mount).toBeDefined()
    expect(leakedServices(ctx, mount!.fiber)).toEqual([])
  })

  it('keys kernels by session under one shared roster mount (the M3 flip of the shared model)', async () => {
    // The roster still mounts a preset ONCE per process under a standing
    // scope and sessions join it; an entry-local realm is therefore ONE
    // service instance per standing mount, shared by every joined session
    // (the upstream roster's own documented model: "sessions stay apart
    // inside one shared instance … not by instance count"). Since M3-A the
    // PROVIDER honors that model: it keys one kernel per Session/Agent
    // inside the shared instance, so joined sessions share the service but
    // never the namespace. This test pins the flipped behavior that the
    // pre-M3 suite documented as shared (the "M3 flips it" pin).
    const ctx = await harness()
    const first = await agentOn(ctx, 'sess-shared-a')
    const second = await agentOn(ctx, 'sess-shared-b')

    // Still ONE service instance — the keying is provider-internal.
    expect(rlmRuntimeImpls(ctx)).toHaveLength(1)
    await runCell(ctx, first, 'shared_marker = "from-a"')
    // The second session's kernel has its own namespace: reading the first
    // session's variable is a NameError, not a leaked value.
    const leaked = await runCell(ctx, second, 'print(shared_marker)')
    expect(leaked.isError).toBe(true)
    expect(contentText(leaked)).toContain("NameError: name 'shared_marker' is not defined")
    // Two sessions that ran code → two kernels behind the one instance.
    const runtime = ctx.agentPresets.serviceFor(first, 'rlmRuntime') as unknown as { kernelPids: number[] } | undefined
    expect(runtime?.kernelPids).toHaveLength(2)
    // And each session's own kernel keeps working.
    expect(cellValue(await runCell(ctx, second, 'print("second is clean")')).logs)
      .toEqual(['second is clean'])
    expect(cellValue(await runCell(ctx, first, 'print(shared_marker)')).logs).toEqual(['from-a'])
  })

  it('tears exactly the disposed session\'s kernel down (agent/disposed per-key teardown)', async () => {
    // dsh-agent emits `agent/disposed` after driver quiescence and the
    // agent\'s own scope unwind; the standing-mounted provider outlives the
    // agent and hears the event (scope-filtered: the agent\'s scope key
    // chains to the mount\'s). Its per-key teardown must destroy exactly the
    // kernel keyed by that session id — the roster-path lifecycle that was
    // M3\'s gap (before per-key keying, the kernel could only die with the
    // whole mount).
    const ctx = await harness()
    const { handle: firstHandle, agent: first } = await agentHandleOn(ctx, 'sess-end-a')
    const second = await agentOn(ctx, 'sess-end-b')

    await runCell(ctx, first, 'a_state = 1')
    await runCell(ctx, second, 'b_state = 1')
    const runtime = ctx.agentPresets.serviceFor(first, 'rlmRuntime') as unknown as { kernelPids: number[] } | undefined
    expect(runtime?.kernelPids).toHaveLength(2)
    const [pidA, pidB] = runtime!.kernelPids as [number, number]
    expect(isAlive(pidA) && isAlive(pidB)).toBe(true)

    await firstHandle.dispose()
    // The kernel is killed asynchronously by the listener; poll for it.
    await new Promise(resolve => setTimeout(resolve, 100))
    const goneBy = Date.now() + 5_000
    while (isAlive(pidA) && Date.now() < goneBy) await new Promise(resolve => setTimeout(resolve, 50))
    expect(isAlive(pidA)).toBe(false)
    // The surviving session\'s kernel is untouched and still works.
    expect(isAlive(pidB)).toBe(true)
    const survivor = cellValue(await runCell(ctx, second, 'print(b_state)'))
    expect(survivor.logs).toEqual(['1'])
  }, 30_000)

  it('spawns no kernel for composeFrom children that never run code (lazy-start gate)', async () => {
    // The subagent fan-out risk (blueprint §9): a child composed from its
    // parent via `composeFrom` inherits the same standing composition, so
    // N children mount nothing new — but if kernels spawned eagerly per
    // composition, rlm() ×N would fan out N idle subprocesses. The provider
    // keys lazily: nothing spawns until a principal\'s first run. Asserted
    // with the REAL process count (the orphan-gate pgrep pattern), not the
    // provider\'s own bookkeeping.
    const before = kernelProcessCount()
    const ctx = await harness()
    const parent = await agentOn(ctx, 'sess-lazy-parent')
    expect(cellValue(await runCell(ctx, parent, 'lazy_marker = 1')).logs).toEqual([])
    // The parent\'s run cost exactly one kernel.
    const withParent = kernelProcessCount()
    expect(withParent - before).toBe(1)

    // Three children inherit the parent\'s composition (the roster\'s
    // composeFrom semantics — join, do not mount) and never run code.
    for (let i = 0; i < 3; i++) {
      const child = await ctx.agents.create({ sessionId: SessionId(`sess-lazy-child-${i}`) })
      expect(ctx.agentPresets.composeFrom(child.agent.ctx, parent.ctx)).toBe('rlm-mode')
    }
    // Any eager spawn would appear here; lazy keys hold nothing.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(kernelProcessCount()).toBe(withParent)
  }, 30_000)

  it('keeps the host kernel count at one after rlm() ×3 (children inherit the provider but never run code)', async () => {
    // The rlm() end-to-end form of the lazy-start gate: the presentation
    // bridge calls the host-plane ctx.subagents service (stubbed here with
    // the one behavior that matters — real composeFrom inheritance, the same
    // call the in-process spawn provider makes), three children join the
    // parent's standing composition, and none run code. The DASHR provider's
    // per-key lazy spawn therefore holds no extra kernel for any of them.
    const before = kernelProcessCount()
    const ctx = await harness()
    const parent = await agentOn(ctx, 'sess-rlm-parent')
    let childIndex = 0

    // The harness-level subagents stub owns the service; this test only
    // configures the start behavior (a second provide would throw).
    const subagents = ctx.get('subagents') as {
      getProvider: (provider: string) => unknown
      start: (name: string, request: { parent: Agent }) => Promise<unknown>
    }
    subagents.start = async (_name: string, request: { parent: Agent }) => {
      for (let i = 0; i < 3; i++) {
        const child = await ctx.agents.create({ sessionId: SessionId(`rlm-child-${++childIndex}`) })
        expect(ctx.agentPresets.composeFrom(child.agent.ctx, request.parent.ctx)).toBe('rlm-mode')
      }
      return {
        id: SessionId('rlm-stub-run'),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
        async dispose() {},
      }
    }

    // Warm the parent's kernel first (lazy spawn happens on its first cell).
    expect(cellValue(await runCell(ctx, parent, 'rlm_parent_warm = 1')).logs).toEqual([])
    const withParent = kernelProcessCount()
    expect(withParent - before).toBe(1)

    const result = await runCell(ctx, parent, [
      'handles = []',
      'for label in ("a", "b", "c"):',
      '    handles.append(await rlm("task-" + label, label=label))',
      'return [h["run_id"] for h in handles]',
    ].join('\n'))
    expect(result.isError, `cell failed: ${contentText(result)}`).toBe(false)

    // Real process count stays at the parent's single kernel.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(kernelProcessCount()).toBe(withParent)
  }, 30_000)

  it('executes real kernels end-to-end through the mounted preset', async () => {
    const ctx = await harness()
    const agent = await agentOn(ctx, 'sess-e2e')

    // Persistent state across cells on the preset's own kernel.
    expect(cellValue(await runCell(ctx, agent, 'x = 41')).logs).toEqual([])
    expect(cellValue(await runCell(ctx, agent, 'print("x is", x)')).logs).toEqual(['x is 41'])

    // A real dsh tool through the binding bridge: todo_write → registry
    // dispatch → the agent's durable session event.
    expect(cellValue(await runCell(ctx, agent,
      'await tools.todo_write({"todos": [{"content": "M2B preset smoke", "status": "in_progress"}]})',
    )).logs).toEqual([])
    expect(agent.session.events.some(event => event.type === 'todo/write')).toBe(true)

    // Another real tool: fs write/read through the HOST's local filesystem
    // backend (cwd = DSH_CWD; the restacked preset resolves host fs like the
    // standard preset) → bytes on disk.
    expect(cellValue(await runCell(ctx, agent,
      'await tools.write({"file_path": "preset-smoke.txt", "content": "hi from dashr"})',
    )).logs).toEqual([])
    const read = cellValue(await runCell(ctx, agent,
      'print(await tools.read({"file_path": "preset-smoke.txt"}))',
    ))
    expect(read.logs.join('\n')).toContain('hi from dashr')
    expect(await import('node:fs/promises').then(fs => fs.readFile(join(WORKDIR, 'preset-smoke.txt'), 'utf8')))
      .toBe('hi from dashr')
  })
})

describe('kernel-per-session across per-agent mounts', () => {
  it('gives a second mounted session its own runtime instance and isolated kernel state', async () => {
    // The roster's standing mount is deliberately ONE composition per
    // process; the per-agent primitive (`mountPreset` on each agent's scope)
    // is the mount granularity that gives each session its own entry-local
    // realm — the code preset's "one private instance per mounted session".
    // Two agents → two realms → two kernels → no state bleed. Authoritative
    // conclusion for blueprint §7.4.1 (see dev/m2b-report.md): an entry-local
    // realm is per-MOUNT, so kernel-per-session holds at this granularity
    // and, under the roster, needs provider-side Session/Agent keying.
    const ctx = await harness()
    const preset = await ctx.agentPresets.resolve('rlm-mode')
    const create = async (id: string): Promise<Agent> => {
      const handle = await ctx.agents.create({ sessionId: SessionId(id) })
      await mountPreset(handle.agent.ctx, preset)
      return handle.agent
    }
    const first = await create('sess-per-a')
    const second = await create('sess-per-b')

    expect(rlmRuntimeImpls(ctx)).toHaveLength(2)

    expect(cellValue(await runCell(ctx, first, 'secret = 99')).logs).toEqual([])
    // The second session's kernel has its own namespace: reading the first
    // session's variable is a NameError, not a leaked value.
    const result = await runCell(ctx, second, 'print(secret)')
    expect(result.isError).toBe(true)
    expect(contentText(result)).toContain("NameError: name 'secret' is not defined")
    // And each session's own kernel still works.
    expect(cellValue(await runCell(ctx, second, 'print("second is clean")')).logs)
      .toEqual(['second is clean'])
  })
})

describe('coexistence with a PTC Code-Mode session', () => {
  /** The worker-thread provider strips TypeScript in-process; a Node built without TS support degrades at run. */
  const ptcExecutable = process.features.typescript !== false

  it('presents run_code + TS SDK to the PTC neighbor and run_cell + Python SDK to dashr', async () => {
    const ctx = await harness({ ptcRuntime: true })
    const dashr = await agentOn(ctx, 'sess-ptc-dashr')
    // The PTC neighbor: host-plane codeRuntime + a mode:code presentation row
    // on its own scope (the `code` preset's row shape, mounted directly).
    const ptc = await ctx.agents.create({ sessionId: SessionId('sess-ptc') })
    const ptcScope: Scope = createScope(ctx, ptc.agent)
    await ptcScope.ctx.plugin({ apply: presentAs, inject: presentationInject, Config: presentationConfig }, { mode: 'code' })

    const dashrPrompt = await ctx.systemPrompt.assemble(assembleContextFor(dashr))
    const ptcPrompt = await ctx.systemPrompt.assemble(assembleContextFor(ptc.agent))

    expect(dashrPrompt.tools.map(schema => schema.name)).toEqual(['run_cell'])
    expect(ptcPrompt.tools.map(schema => schema.name)).toEqual(['run_code'])
    expect(dashrPrompt.sections.map(section => section.name)).toContain('tools:dashr-sdk')
    const tsSdk = ptcPrompt.sections.find(section => section.name === 'tools:sdk')
    expect(tsSdk).toBeDefined()
    expect(String(tsSdk!.text)).toContain('run_code')
    expect(String(tsSdk!.text)).toContain('TypeScript')

    // No cross-leak in either direction.
    expect(dashrPrompt.tools.some(schema => schema.name === 'run_code')).toBe(false)
    expect(ptcPrompt.tools.some(schema => schema.name === 'run_cell')).toBe(false)

    // DASHR executes Python in the same process, on its own kernel.
    expect(cellValue(await runCell(ctx, dashr, 'print("dashr says hi")')).logs).toEqual(['dashr says hi'])

    // The PTC side executes on ITS runtime. With a TS-capable Node this is a
    // real worker-thread run; this host's Node 22 binary is compiled without
    // TypeScript support (`process.features.typescript === false`), so the
    // provider's documented failure shape is asserted instead — recorded in
    // dev/m2b-report.md; the same spec passes the real-run branch under a
    // TS-capable Node 24 (verified during M2B).
    const run = await execute(ctx, ptc.agent, 'run_code', {
      code: 'const n: number = 6 * 7; console.log("ts says", n); return n;',
      description: 'ptc smoke program',
    })
    if (ptcExecutable) {
      expect(run.isError).toBe(false)
      expect((run.value as { result: unknown }).result).toBe(42)
    } else {
      expect(run.isError).toBe(true)
      expect(contentText(run)).toContain('Node.js is not compiled with TypeScript support')
    }
  })
})
