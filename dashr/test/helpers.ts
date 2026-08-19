import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished } from 'vitest'
import { DashrRuntime } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const venvPython = fileURLToPath(new URL('../.venv-kernel/bin/python', import.meta.url))

/** Interpreter for real-kernel tests: explicit override, package venv, then PATH. */
export const KERNEL_PYTHON = process.env.DASHR_TEST_PYTHON ?? (existsSync(venvPython) ? venvPython : 'python3')

/** Boot a fresh context with the ipython provider mounted, worker-thread test style. */
export async function setupRuntime(config: Config = {}): Promise<{ fiber: Awaited<ReturnType<Context['plugin']>>, runtime: DashrRuntime }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(DashrRuntime, { python: KERNEL_PYTHON, ...config })
  const runtime = ctx.rlmRuntime as DashrRuntime
  // Dispose even when a spec forgets to: kernel children are not killed with
  // the worker process, so an undisposed fiber leaks an idle ipykernel
  // subprocess forever (208 leaked orphans were found mid-project). Double
  // disposal is safe — the fiber disposer is single-shot.
  onTestFinished(() => fiber.dispose())
  return { fiber, runtime }
}

import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RLMRuntime } from '../src/vendored/rlm-runtime.ts'
import type { CodeRunRequest, CodeRunResult } from '../src/vendored/rlm-runtime.ts'
import Presentation from '../src/index.ts'

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
export async function setupPresentation(
  runtime: ((ctx: Context) => Promise<unknown>) | false,
  config: Config = {},
  agentRoute?: { provider?: string, model?: string },
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
  const presetKey = { preset: 'dashr' }
  const preset = createScope(host, presetKey)
  onTestFinished(() => preset.dispose())
  const fiber = await preset.ctx.plugin(Presentation, config)
  onTestFinished(() => fiber.dispose())

  // One agent joined under the preset (a structural fake whose session
  // captures appends — the audit assertions read `events`), one neighbor
  // without the row.
  const events: { type: string; data: unknown }[] = []
  const dashrAgent = {
    id: SessionId('dashr-agent'),
    ...agentRoute === undefined ? {} : { options: agentRoute },
    session: {
      header: { cwd: process.cwd() },
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  } as unknown as Agent
  const agentScope = createScope(preset.ctx, dashrAgent, { parent: presetKey })
  onTestFinished(() => agentScope.dispose())
  const otherAgent = { id: SessionId('ptc-agent') } as Agent
  const otherScope = createScope(host, otherAgent)
  onTestFinished(() => otherScope.dispose())
  return { ctx, preset, agent: { scope: agentScope, agent: dashrAgent, events }, other: { scope: otherScope, agent: otherAgent } }
}

/** A structural fake of the owning agent: captures session appends. */
export function fakeAgent(): { agent: Agent; events: { type: string; data: unknown }[] } {
  const events: { type: string; data: unknown }[] = []
  const agent = {
    id: SessionId('audit-agent'),
    session: {
      header: { cwd: process.cwd() },
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  } as unknown as Agent
  return { agent, events }
}

/**
 * Boot the same composition with the REAL kernel provider (M1's
 * `DashrRuntime` from `dsh-rlm-mode`). One kernel boots
 * per test; the fiber's registered disposer shuts it down
 * (`onTestFinished`), and the acceptance gate asserts no orphan
 * `ipykernel_launcher` processes remain (blueprint §10.9).
 */
export async function setupKernel(
  presentationConfig: Config = {},
  kernelConfig: import('../src/runtime.ts').Config = {},
): Promise<Harness> {
  const { DashrRuntime } = await import('../src/runtime.ts')
  return setupPresentation(async (ctx) => ctx.plugin(DashrRuntime, {
    python: KERNEL_PYTHON,
    // Shorter budgets keep the suite fast while leaving the abort path
    // measurable.
    runTimeoutMs: 30_000,
    ...kernelConfig,
  }), presentationConfig)
}

/**
 * One call captured against a fake delegation tool: the registry tool name,
 * the dispatched arguments, and whether the dispatch carried a parent token
 * (the nested sub-dispatch marker — the model-direct guard's pass condition).
 */
export interface FakeDelegationCall {
  tool: string
  args: unknown
  parented: boolean
}

/**
 * Register fake registry tools under the SEVEN tool-layer masked delegation names (the eighth, `report`, is bridged over the service layer), the
 * way the standard preset registers the real ones (ADR-0002: the bridge
 * dispatches the registered tool; masking never touches the registry). Each
 * tool records its calls; `outcomes` overrides a tool's return value and
 * may throw to simulate a failed dispatch. Defaults mirror the real tools'
 * continuable shapes so tests can assert passthrough.
 * @returns the shared call log, in dispatch order.
 */
export function registerFakeDelegationTools(
  ctx: Context,
  outcomes: Partial<Record<string, (args: unknown) => unknown>> = {},
): FakeDelegationCall[] {
  const calls: FakeDelegationCall[] = []
  const defaults: Record<string, unknown> = {
    subagent: { kind: 'continuable', subagentId: 'child-1' },
    subagent_fork: { kind: 'continuable', subagentId: 'fork-1' },
    send_message: { messageId: 'msg-1' },
    interrupt_agent: { accepted: true },
    list_agents: [{ kind: 'child', id: 'child-1', label: 'subagent', status: 'idle' }],
    workflow: { runId: 'wf-1', agentsStarted: 1, result: null },
    ralph: { runId: 'ralph-1', agentsStarted: 2, result: 'done' },
  }
  for (const [name, defaultOutput] of Object.entries(defaults)) {
    ctx.tools.register(defineTool({
      name,
      description: `Fake delegation tool ${name} (test registry).`,
      parameters: { placeholder: { type: 'string', description: 'Ignored placeholder.' } },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute(args, exec) {
        calls.push({ tool: name, args, parented: exec.parent !== undefined })
        const outcome = outcomes[name]
        const output = outcome !== undefined ? outcome(args) : defaultOutput
        return Promise.resolve(output) as Promise<never>
      },
    }))
  }
  return calls
}

/** What the fake `ctx.subagents` service recorded, in call order. */
export interface FakeReportCall {
  child: Agent
  content: { type: string, text?: string }[]
  delivery: string
  signal: AbortSignal
}

/**
 * Mount a fake root-realm `ctx.subagents` service whose `reportFrom` records
 * calls and answers a fixed message id (or throws the given error — e.g. a
 * SubagentError-shaped `{ code: 'UNAUTHORIZED' }` rejection).
 */
export async function fakeSubagentsService(
  ctx: Context,
  reportFrom: (call: FakeReportCall) => Promise<string> = () => Promise.resolve('mid-1'),
): Promise<FakeReportCall[]> {
  const reports: FakeReportCall[] = []
  const fiber = await ctx.plugin({ name: 'fake-subagents', apply(c) {
    c.provide('subagents', {
      reportFrom: (child: Agent, content: FakeReportCall['content'], options: { delivery: string, signal: AbortSignal }) => {
        reports.push({ child, content, delivery: options.delivery, signal: options.signal })
        return reportFrom(reports[reports.length - 1]!)
      },
    })
  } })
  onTestFinished(() => fiber.dispose())
  return reports
}

const toolSignal = new AbortController().signal

/** Dispatch a model-direct `ipython` call through the registry pipeline, as the loop would. */
export async function runCell(
  ctx: Context,
  cell: string,
  extras: { agent?: Agent; signal?: AbortSignal; description?: string } = {},
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: toolSignal,
    callId: CallId('call-1'),
    name: 'ipython',
    arguments: { cell, description: extras.description ?? 'Run the test cell' },
    ...extras.agent ? { agent: extras.agent } : {},
    ...extras.signal ? { signal: extras.signal } : {},
  })
}
