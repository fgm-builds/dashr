import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { onTestFinished } from 'vitest'
import { RLMRuntime } from 'dashr-code-runtime-ipython'
import type { CodeRunRequest, CodeRunResult } from 'dashr-code-runtime-ipython'
import Presentation from '../src/index.ts'
import type { Config } from '../src/index.ts'

const packageVenv = fileURLToPath(new URL('../.venv-kernel/bin/python', import.meta.url))
// The sibling runtime package's venv (the M1 helper's own resolution target)
// covers the monorepo layout, where the kernel interpreter was created once
// under `dashr/.venv-kernel` via `npm run kernel:venv`.
const siblingVenv = fileURLToPath(new URL('../../dashr/.venv-kernel/bin/python', import.meta.url))

/** Interpreter for real-kernel tests: explicit override, this package's venv, the sibling runtime package's venv, then PATH. */
export const KERNEL_PYTHON = process.env.DASHR_TEST_PYTHON
  ?? (existsSync(packageVenv) ? packageVenv : undefined)
  ?? (existsSync(siblingVenv) ? siblingVenv : 'python3')

/**
 * A scriptable in-repo `rlmRuntime`: each test sets `behavior` to drive the
 * cell bridge without a kernel. Language reports `'python'` — the only
 * language this presentation ships an SDK for.
 */
export class FakeCellRuntime extends RLMRuntime {
  readonly language = 'python'
  readonly isolation = 'fake'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })
  lastRequest?: CodeRunRequest

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    this.lastRequest = request
    return this.behavior(request)
  }
}

/** Mount a fresh `FakeCellRuntime` (for `setup`). */
export async function fakeRuntime(ctx: Context): Promise<unknown> {
  return ctx.plugin(FakeCellRuntime)
}

/** Everything a presentation test needs on one root context. */
export interface Harness {
  ctx: Context
  /** The "preset" standing scope the presentation plugin is mounted into. */
  preset: Scope
  /** The agent scope joined under the preset (the model-facing composition), with session capture. */
  agent: { scope: Scope; agent: Agent; events: { type: string; data: unknown }[] }
  /** A second, unrelated agent scope with NO presentation row (the PTC neighbor). */
  other: { scope: Scope; agent: Agent }
}

/**
 * Boot the full composition: root systemPrompt + tools (native default),
 * the given runtime service, a preset scope carrying the presentation row,
 * one agent joined under it, and one unrelated neighbor agent. Disposal is
 * registered on test finish — kernel children are not killed with the worker
 * process (blueprint §10.9 teardown discipline).
 */
export async function setup(
  runtime: ((ctx: Context) => Promise<unknown>) | false,
  config: Config = {},
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  if (runtime !== false) {
    const runtimeFiber = await runtime(ctx)
    // The runtime service (a real kernel provider owns a subprocess) must be
    // torn down with the test: its fiber disposer snapshots/shuts the kernel
    // down, and skipping it leaks an ipykernel_launcher orphan (§10.9).
    if (runtimeFiber && typeof (runtimeFiber as { dispose?: unknown }).dispose === 'function') {
      onTestFinished(async () => { await (runtimeFiber as { dispose(): Promise<void> }).dispose() })
    }
  }

  // A host fiber that injects the registry services, so contexts derived
  // from it may address `ctx.tools` / `ctx.systemPrompt` as properties (the
  // upstream code-mode spec's `mintAgentScope` does the same).
  let host!: Context
  await ctx.plugin(Object.assign((inner: Context) => { host = inner }, { inject: ['tools', 'systemPrompt'] }))

  // The "preset": a standing scope whose ctx mounts the presentation row.
  const presetKey = { preset: 'dasher' }
  const preset = createScope(host, presetKey)
  onTestFinished(() => preset.dispose())
  const fiber = await preset.ctx.plugin(Presentation, config)
  onTestFinished(() => fiber.dispose())

  // One agent joined under the preset (a structural fake whose session
  // captures appends — the audit assertions read `events`), one neighbor
  // without the row.
  const events: { type: string; data: unknown }[] = []
  const dasherAgent = {
    id: SessionId('dasher-agent'),
    session: {
      header: { cwd: '/workspace' },
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  } as unknown as Agent
  const agentScope = createScope(preset.ctx, dasherAgent, { parent: presetKey })
  onTestFinished(() => agentScope.dispose())
  const otherAgent = { id: SessionId('ptc-agent') } as Agent
  const otherScope = createScope(host, otherAgent)
  onTestFinished(() => otherScope.dispose())
  return { ctx, preset, agent: { scope: agentScope, agent: dasherAgent, events }, other: { scope: otherScope, agent: otherAgent } }
}

/** A structural fake of the owning agent: captures session appends. */
export function fakeAgent(): { agent: Agent; events: { type: string; data: unknown }[] } {
  const events: { type: string; data: unknown }[] = []
  const agent = {
    id: SessionId('audit-agent'),
    session: {
      header: { cwd: '/workspace' },
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  } as unknown as Agent
  return { agent, events }
}

/**
 * Boot the same composition with the REAL kernel provider (M1's
 * `IPythonCodeRuntime` from `dashr-code-runtime-ipython`). One kernel boots
 * per test; the fiber's registered disposer shuts it down
 * (`onTestFinished`), and the acceptance gate asserts no orphan
 * `ipykernel_launcher` processes remain (blueprint §10.9).
 */
export async function setupKernel(
  presentationConfig: Config = {},
  kernelConfig: import('dashr-code-runtime-ipython').Config = {},
): Promise<Harness> {
  const { IPythonCodeRuntime } = await import('dashr-code-runtime-ipython')
  return setup(async (ctx) => ctx.plugin(IPythonCodeRuntime, {
    python: KERNEL_PYTHON,
    // Shorter budgets keep the suite fast while leaving the abort path
    // measurable.
    runTimeoutMs: 30_000,
    ...kernelConfig,
  }), presentationConfig)
}

const toolSignal = new AbortController().signal

/** Dispatch a model-direct `run_cell` call through the registry pipeline, as the loop would. */
export async function runCell(
  ctx: Context,
  code: string,
  extras: { agent?: Agent; signal?: AbortSignal; description?: string } = {},
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: toolSignal,
    callId: CallId('call-1'),
    name: 'run_cell',
    arguments: { code, description: extras.description ?? 'Run the test cell' },
    ...extras.agent ? { agent: extras.agent } : {},
    ...extras.signal ? { signal: extras.signal } : {},
  })
}
