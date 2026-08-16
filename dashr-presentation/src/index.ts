/**
 * `dashr-tool-presentation`: the Dasher RLM agent-plane presentation row
 * (blueprint §7.4) — the `run_cell` transport tool, the generated Python SDK
 * prompt section, the model-direct-call collapse, and the tool→binding bridge
 * that lets a cell call the registry's agent-visible tools as
 * `await tools.name(args)`.
 *
 * Structure mirrors upstream `dsh-agent-tool-presentation` + the Code Mode
 * half of `dsh-tools` (0.1.0-rc.6), re-pointed at our own `ctx.rlmRuntime`
 * Service Definition (vendored in `dashr-code-runtime-ipython`): the host
 * registry stays untouched, and this row composes per scope — a Dasher preset
 * mounts it in its standing scope, so every agent joined under that preset
 * gets the cell surface while PTC / native presets in the SAME process keep
 * their own presentation. One row per composition, not one per session.
 *
 * Deliberate deltas from upstream Code Mode, recorded per blueprint §7.6:
 * - `run_cell` (not `run_code`): the registry reserves `run_code`
 *   unconditionally, and a distinct name is what lets a Dasher preset and a
 *   PTC code preset share one process registry without collision.
 * - The transport is an ORDINARY scoped registration, not the registry's
 *   reserved non-filterable transport: reservation is registry-private
 *   machinery a plugin cannot mint. Under our own scope the effect matches
 *   (visible only to this composition); a nested scope could restrict it
 *   away, which upstream forbids — accepted for M2 Stage A.
 * - The model-direct collapse is a `ctx.tools.guard()` denial (after the
 *   pre-execute waterfall) rather than the registry's pre-pipeline
 *   `UNKNOWN_TOOL`: same model-facing route-back text, different pipeline
 *   stage. `tools.guard` is the published monotonic-denial extension point.
 * - The `system-prompt/assemble` listener that filters `assembly.tools` down
 *   to `run_cell` uses the assembly waterfall's documented authority
 *   (dsh-tools README: "its returned assembly is authoritative").
 *
 * `rlmRuntime` is resolved at USE time, never statically injected: a static
 * inject entry would hold the whole composition hostage to the runtime
 * service existing, while a deployment may legitimately mount this plugin
 * into a scope whose runtime row comes from an `isolate` realm later in the
 * mount sequence. The wait (`ctx.inject(['rlmRuntime'], …)`) is still
 * declared so a Dasher preset against a runtime-less deployment fails AT
 * MOUNT — named in the preset's activation audit — instead of at the first
 * prompt; the `run_cell` execution path re-reads `ctx.get('rlmRuntime')`
 * with an actionable error, mirroring upstream `requireCodeRuntime`.
 * @module dashr-tool-presentation
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import type {
  CodeDispatchLog,
  JsonSchemaNode,
  ToolDefinition,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolRuntime,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
// Type-only: brings the `ctx.tools` Context merge into this program.
import type {} from '@deepseek-ai/dsh-tools'
import { BlockAssembler, CallId, HarnessError, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: brings the `ctx.systemPrompt` Context merge and the
// `system-prompt/assemble` event typing into this program.
import type {} from '@deepseek-ai/dsh-system-prompt'
// The seam surface is mirrored locally (see the module for why the vendored
// Service Definition is depended on structurally, not by import).
import type {
  RlmBindingFunction,
  RlmJsonValue,
  RlmRunResult,
  RlmRuntimeSurface,
} from './runtime-surface.ts'
import { renderToolsSdkPy } from './py-sdk.ts'
import type { DasherSdkSchema } from './py-sdk.ts'
import { snapshotJsonValue } from './snapshot-json.ts'
import type { JsonValue } from './snapshot-json.ts'
import { RLM_PROVIDER, extractTextFromBlocks } from './subagents-surface.ts'
import type { DasherSubagentsSurface } from './subagents-surface.ts'
import { RlmRunRegistry } from './rlm-runs.ts'
import { HarnessStore, renderHarnessSection } from './harness-store.ts'
import type { HarnessApplyReport, HarnessOp } from './harness-store.ts'
import { REFINE_MAX_TOKENS, REFINE_SYSTEM, buildRefineMessages, parseRefineAnswer, resolveRefineTarget } from './refine.ts'
import type { RefineTarget } from './refine.ts'
import type { DasherCompactionResult, DasherCompactionSurface, DasherTokenMeterSurface } from './compaction-surface.ts'

// Public surface for the harness/refine/compact machinery (consumers and
// tests construct stores and inspect routes independently of the bridge).
export { HarnessStore, HARNESS_KINDS, HARNESS_LIMITS, renderHarnessSection } from './harness-store.ts'
export type { HarnessApplyReport, HarnessEntry, HarnessKind, HarnessOp } from './harness-store.ts'
export { REFINE_MAX_TOKENS, REFINE_SYSTEM, buildRefineMessages, parseRefineAnswer, resolveRefineTarget } from './refine.ts'
export type { RefineTarget } from './refine.ts'
export type { DasherCompactionResult, DasherCompactionSurface, DasherTokenMeterSurface } from './compaction-surface.ts'

/** Cordis plugin name. */
export const name = 'dashr-tool-presentation'

/**
 * Required services. `rlmRuntime` is NOT listed: see the module doc — the
 * mode-dependent wait is declared inside {@link apply} instead, and the
 * execution path re-reads the service at use time with an actionable error.
 */
export const inject = ['tools']

/** Plugin config. */
export interface Config {
  /**
   * Concurrency cap for one cell's overlapping sub-calls (default 10, the
   * native loop scheduler's own default). Sub-calls follow the registry's
   * native scheduling contract — only tools that classify concurrency-safe
   * overlap; exclusive calls form barriers — so `1` restores strictly serial
   * dispatch. Must be a positive integer.
   */
  maxParallelSubCalls?: number
  /**
   * Composition-wide default model for rlm()-spawned children (M4-A,
   * blueprint §6): the middle tier of the three-level priority
   * `rlm(model=...) > config.subagentModel > parent-model inheritance`.
   * Absent (the default) plus an absent kwarg means the start request
   * carries NO `agentOptions`, leaving dsh's `resolveChildAgentOptions` to
   * spread the parent's own route — this side never names the parent model.
   * Must be a non-empty string when set.
   */
  subagentModel?: string
  /**
   * Root directory for the Continual Harness store (M4-B, blueprint §6):
   * one JSON file per agent under `<harnessDir>/<agent>/harness.json`,
   * written atomically and restored by the next composition that serves the
   * same agent id. Absent (the default) = memory-only — the harness lives
   * and dies with the composition, exactly the opt-in posture `snapshotDir`
   * takes on the runtime side; a silent default location would persistently
   * alter future prompts without an explicit deployment decision. Must be a
   * non-empty string when set.
   */
  harnessDir?: string
  /**
   * The model route for refine()'s auxiliary call (M4-B): `'provider/model'`
   * selects explicitly, a bare model id pairs with the calling agent's own
   * provider, and absence falls back to the agent's own provider+model —
   * refinement writes DURABLE prompt state, so the default is the agent's
   * own model, never a guessed auxiliary one. Must be a non-empty string
   * when set.
   */
  refineModel?: string
  /**
   * The summarization model for compact() (M4-B): when set, a DASHR-scoped
   * `BasicCompactionEngine` is mounted under `ctx.isolate('compaction')`
   * with this route (so a host-level engine stays untouched and the scoped
   * one resolves only inside this composition). `'provider/model'` selects
   * explicitly; a bare model id pairs with the first calling agent's
   * provider. Absent = inherit the host-mounted engine and its model chain
   * (configured ?? latest-request ?? agent). Must be a non-empty string
   * when set.
   */
  compactModel?: string
}

/** Runtime schema. */
export const Config: z<Config> = z.object({
  maxParallelSubCalls: z.natural().min(1).default(10),
  subagentModel: z.string(),
  harnessDir: z.string(),
  refineModel: z.string(),
  compactModel: z.string(),
})

/**
 * The `dasher:harness` section order: the first section after the 100–199
 * tool-guidance band (upstream's stated convention), where the Continual
 * Harness renders as durable guidance the model reads after its tools.
 */
export const HARNESS_SECTION_ORDER = 200

/** The model-facing name of the Dasher cell transport. */
export const RUN_CELL_NAME = 'run_cell'

/** The `tools:dasher-sdk` section order: the 100–199 tool-guidance band's SDK position, matching upstream `tools:sdk`. */
export const SDK_SECTION_ORDER = 150

/**
 * The `run_cell` tool description the model sees: cell semantics — the
 * persistent kernel — stated up front, unlike upstream's one-shot
 * `PYTHON_FLAVOR` (blueprint §1.1: Dasher is channel ② state codification,
 * and the model's Code-Interpreter prior matches THIS contract).
 */
const RUN_CELL_DESCRIPTION
  = 'Execute one Python cell on the persistent kernel. Takes two required '
    + 'arguments: `code`, the cell (top-level `await` and `return` work; variables, '
    + 'imports, and definitions from earlier cells are still alive), and `description`, '
    + 'a short summary of what the cell does. Call tools as `await tools.name(args)` per '
    + 'the declarations in the system prompt. Only what you print or return comes '
    + 'back — curate it.'

/** The `code` parameter's model-facing description. */
const RUN_CELL_CODE_PARAM_DESCRIPTION
  = 'The cell: one Python program body for the persistent kernel (top-level '
    + '`await` and `return` work).'

/**
 * The `description` parameter's model-facing description: the UI label
 * contract, ported verbatim in shape from upstream `run_code` (the label
 * surfaces on the generic card as the call's always-visible title).
 */
const RUN_CELL_DESCRIPTION_PARAM_DESCRIPTION
  = 'Clear, concise description of what this cell does in active voice, '
    + '5-10 words (shown in the UI). Examples: "Load dataframe and summarize '
    + 'columns"; "Run test file and capture failures"; "Patch config key across '
    + 'cordis.yml files".'

/**
 * Thrown by `run_cell` when the cell itself failed — a program exception, a
 * budget expiry, an abort, or kernel death. Extends {@link HarnessError} with
 * the same `code: 'CODE_RUN_FAILED'` as upstream `CodeRunFailedError`, so
 * registry-side error taxonomy and session-log consumers see the shape they
 * already know; the registry's execution pipeline converts it into a
 * structured `isError` result whose text carries the failure kind plus the
 * captured logs, so the model can self-correct.
 */
export class DasherRunFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RUN_FAILED')
    this.name = 'DasherRunFailedError'
  }
}

/**
 * Snapshot one binding call's argument as lossless JSON, then snapshot that
 * detached value again so dispatch and logging stay independent without
 * reintroducing structured-clone's platform-specific nesting limit. Ported
 * verbatim from upstream `code-mode.ts` (`jsonNormalizeArgs`).
 */
function jsonNormalizeArgs(value: unknown): { dispatched: unknown; logged: unknown } {
  let snapshot: JsonValue | undefined
  try {
    snapshot = snapshotJsonValue(value) as JsonValue | undefined
  } catch (error: unknown) {
    throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (snapshot === undefined) {
    throw new Error('tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)')
  }
  const logged = snapshotJsonValue(snapshot)
  if (logged === undefined) {
    throw new Error('tool arguments could not be detached for durable logging')
  }
  return { dispatched: snapshot, logged }
}

/** One bare-callable binding's packaged arguments, sent by the kernel-side callable proxy. */
type RlmCallParse =
  | { ok: true, args: unknown[], kwargs: Record<string, unknown> }
  | { ok: false, error: string }

/**
 * Parse the kernel-side callable proxy's uniform `{args, kwargs}` packaging.
 * The proxy sends EVERY bare-global call this way (unlike member proxies,
 * which unwrap a single positional argument), so callable bindings own their
 * signature validation — the "host owns the namespace" rule.
 */
function parseRlmCall(rawArgs: unknown): RlmCallParse {
  if (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)) {
    const record = rawArgs as Record<string, unknown>
    if (Array.isArray(record.args)
      && (record.kwargs === undefined
        || (typeof record.kwargs === 'object' && record.kwargs !== null && !Array.isArray(record.kwargs)))) {
      return { ok: true, args: record.args, kwargs: (record.kwargs ?? {}) as Record<string, unknown> }
    }
  }
  return { ok: false, error: 'malformed callable binding arguments' }
}

/** Resolve the run_cell overlap cap at the config boundary (schemastery already validated the range; direct construction in tests bypasses it). */
export function resolveMaxParallelSubCalls(value: number | undefined): number {
  const maxParallelSubCalls = value ?? 10
  if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) {
    throw new Error('dashr-tool-presentation: maxParallelSubCalls must be a positive integer')
  }
  return maxParallelSubCalls
}

/**
 * Resolve the composition default for rlm() child models at the config
 * boundary (M4-A). `undefined` is the legitimate default (parent-model
 * inheritance — no `agentOptions` on the start request), so this only
 * rejects the values that would silently mean something else: a non-string
 * (schemastery already stops these on the preset path; direct construction
 * in tests bypasses it) and the empty string, which is a typo of "unset" in
 * a YAML row, not a model id any provider would resolve.
 */
export function resolveSubagentModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dashr-tool-presentation: subagentModel must be a non-empty string when set, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Resolve the harness storage root at the config boundary. `undefined` is
 * the legitimate memory-only default; the empty string is a typo of "unset"
 * in a YAML row, not a directory any process should write to.
 */
export function resolveHarnessDir(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dashr-tool-presentation: harnessDir must be a non-empty string when set, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Resolve the refine() model tier at the config boundary (same empty-string rejection as {@link resolveSubagentModel}). */
export function resolveRefineModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dashr-tool-presentation: refineModel must be a non-empty string when set, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Resolve the compact() model tier at the config boundary (same empty-string rejection as {@link resolveSubagentModel}). */
export function resolveCompactModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dashr-tool-presentation: compactModel must be a non-empty string when set, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Two-space JSON presentation, matching the shallow `run_cell` text contract (ported). */
const JSON_INDENT = '  '

/** ECMAScript caps `JSON.stringify`'s `space` string at ten characters; total indentation is capped there so formatted output stays linear (ported). */
const MAX_JSON_INDENT_CHARS = 10

/** A pending fragment in the iterative JSON presentation traversal (ported). */
type JsonRenderTask =
  | { kind: 'text'; text: string }
  | { kind: 'value'; value: JsonValue; depth: number; compact: boolean }

/** Render one non-string JSON root without recursive traversal or unbounded indentation growth (ported from upstream code-mode.ts). */
function renderJsonValue(value: Exclude<JsonValue, string>): string {
  const chunks: string[] = []
  const tasks: JsonRenderTask[] = [{ kind: 'value', value, depth: 0, compact: false }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'text') {
      chunks.push(task.text)
      continue
    }

    const current = task.value
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      chunks.push(String(current))
      continue
    }
    if (typeof current === 'string') {
      chunks.push(JSON.stringify(current))
      continue
    }

    const compact = task.compact || (task.depth + 1) * JSON_INDENT.length > MAX_JSON_INDENT_CHARS
    const childDepth = task.depth + 1
    if (Array.isArray(current)) {
      chunks.push('[')
      if (current.length === 0) {
        chunks.push(']')
        continue
      }
      tasks.push({ kind: 'text', text: compact ? ']' : `\n${JSON_INDENT.repeat(task.depth)}]` })
      for (let index = current.length - 1; index >= 0; index--) {
        const item = current[index]
        if (item === undefined) throw new Error('dashr-tool-presentation: cannot render a sparse JSON array')
        tasks.push({ kind: 'value', value: item, depth: childDepth, compact })
        tasks.push({
          kind: 'text',
          text: compact
            ? index === 0 ? '' : ','
            : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}`,
        })
      }
      continue
    }

    const keys = Object.keys(current)
    chunks.push('{')
    if (keys.length === 0) {
      chunks.push('}')
      continue
    }
    tasks.push({ kind: 'text', text: compact ? '}' : `\n${JSON_INDENT.repeat(task.depth)}}` })
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      if (key === undefined) throw new Error('dashr-tool-presentation: cannot render a missing JSON object key')
      const item = current[key]
      if (item === undefined) throw new Error('dashr-tool-presentation: cannot render an undefined JSON object property')
      tasks.push({ kind: 'value', value: item, depth: childDepth, compact })
      tasks.push({
        kind: 'text',
        text: compact
          ? `${index === 0 ? '' : ','}${JSON.stringify(key)}:`
          : `${index === 0 ? '\n' : ',\n'}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `,
      })
    }
  }
  return chunks.join('')
}

/** Render one present cell completion value for the model-facing result text (ported). */
function renderValue(value: JsonValue): string {
  return typeof value === 'string' ? value : renderJsonValue(value)
}

/** Canonical value returned by the outer `run_cell` transport. */
type RunCellOutput = { logs: string[]; result?: JsonValue }

/**
 * Capabilities the `run_cell` bridge closes over, mirroring upstream's
 * `RunCodeBridgeOptions` (the `requireRuntime` idiom): the registry-private
 * staged scheduler travels through the exported `TOOL_RUNTIME_SCHEDULER`
 * symbol-keyed property rather than a closure, because — unlike upstream —
 * the registry does not mint this tool for us.
 */
export interface RunCellBridgeOptions {
  /** Resolves `ctx.rlmRuntime` or throws the loud misconfiguration error (use-time read). */
  requireRuntime: () => RlmRuntimeSurface
  /** The run's overlap cap for parallel-classified sub-calls (validated config). */
  maxParallel: number
  /**
   * Runs the `tools/code-dispatch-log` waterfall over one settled
   * sub-dispatch and returns the content the bridge should log — the
   * consumer-side stand-in for the registry-private `shapeDispatchLog`
   * invoker upstream mints for its own bridge (same carrier, same
   * containment). Built in {@link apply}.
   */
  shapeDispatchLog: (dispatch: CodeDispatchLog) => Promise<ContentBlock[]>
  /**
   * Resolves the host-plane `ctx.subagents` service (or undefined when this
   * composition has no subagent capability). Read at run time so a
   * host-side provider mounted later still becomes visible; absent means
   * rlm() answers with a structured "unavailable" error, never a crash.
   */
  requireSubagents?: () => DasherSubagentsSurface | undefined
  /**
   * The live-run registry shared by every `run_cell` call in this
   * composition — rlm() in one cell and rlm_await() in a LATER cell resolve
   * the same handle. Omitted (direct construction, tests) falls back to a
   * per-call registry, which still serves rlm() + rlm_await() inside ONE cell.
   */
  rlmRuns?: RlmRunRegistry
  /**
   * The composition default model for rlm() children (M4-A): the middle
   * tier of `rlm(model=...) > subagentModel > parent inheritance`. Already
   * validated non-empty at the config boundary; absent (direct construction,
   * tests) is the inheritance default.
   */
  subagentModel?: string
  /**
   * The Continual Harness store shared by every `run_cell` call AND the
   * `dasher:harness` prompt section in this composition (M4-B): refine()
   * edits it, the next assembly re-renders from it. Omitted (direct
   * construction, tests) falls back to a per-call memory-only store, which
   * still serves refine() inside ONE cell.
   */
  harness?: HarnessStore
  /**
   * The refine() model tier: `'provider/model'`, a bare model id, or absent
   * for the agent's own route (validated at the config boundary).
   */
  refineModel?: string
  /**
   * The compact() model tier (validated at the config boundary). When set,
   * {@link scopedCompaction} must also be wired — apply() derives it from
   * this same key.
   */
  compactModel?: string
  /**
   * Resolves the host-plane `ctx.llm` service refine()'s auxiliary call
   * streams through. Read at call time so a host adapter mounted later still
   * becomes visible; absent means refine() answers with a structured
   * "unavailable" error, never a crash.
   */
  requireLlm?: () => LlmStreamSurface | undefined
  /**
   * Resolves the host-plane `ctx.compaction` engine compact() inherits when
   * no {@link compactModel} is configured. Absent (or an engine-less host)
   * means compact() answers with a structured "unavailable" error.
   */
  requireCompaction?: () => DasherCompactionSurface | undefined
  /**
   * Resolves the optional host-plane `ctx.tokenMeter` for compact()'s usage
   * probe (the "check usage" half of the PA semantics). Absent simply omits
   * the `context_tokens` field from the result.
   */
  requireTokenMeter?: () => DasherTokenMeterSurface | undefined
  /**
   * Lazily mounts and returns the DASHR-scoped compaction engine when
   * `compactModel` is configured (design A). Wired by {@link apply}; the
   * bare-model form resolves its provider from the FIRST calling agent
   * (documented semantics). Returns a structured error string when the
   * scoped engine cannot be mounted.
   */
  scopedCompaction?: (agent: Agent) => Promise<ScopedCompactionOutcome>
}

/** The outcome of the lazy scoped-engine mount. */
export type ScopedCompactionOutcome =
  | { engine: DasherCompactionSurface; target: RefineTarget }
  | { error: string }

/** The `ctx.llm` surface refine() streams through (the seam's streaming call alone). */
export interface LlmStreamSurface {
  /** Stream one model call as raw chunks; failures arrive as terminal `finish` chunks, not rejections. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Build the `run_cell` {@link ToolDefinition}: required `code` and
 * `description` parameters, executed through the dispatch bridge described
 * in the module doc. Sub-calls ride the registry's exported staged scheduler
 * (`prepare`/`dispatch`/`finalize`/`finish`) under the native concurrency
 * contract; each sub-dispatch is logged for reconstruction
 * (`tool/code-dispatch-start` / `tool/code-dispatch`) while only the outer
 * curated result enters model history.
 * @param registry - the host tool registry (sub-calls go through its staged
 *   scheduler, bindings cover its registered tools).
 * @param options - the bridge capabilities described above.
 * @returns the registry-ready definition.
 */
export function createRunCellTool(registry: ToolRuntime, options: RunCellBridgeOptions): ToolDefinition {
  const { requireRuntime, maxParallel, shapeDispatchLog, requireSubagents, rlmRuns, subagentModel } = options
  const harness = options.harness ?? new HarnessStore()
  const refineModel = options.refineModel
  const compactModel = options.compactModel
  const requireLlm = options.requireLlm
  const requireCompaction = options.requireCompaction
  const requireTokenMeter = options.requireTokenMeter
  const scopedCompaction = options.compactModel !== undefined ? options.scopedCompaction : undefined
  return defineTool({
    name: RUN_CELL_NAME,
    description: RUN_CELL_DESCRIPTION,
    parameters: {
      code: { type: 'string', required: true, description: RUN_CELL_CODE_PARAM_DESCRIPTION },
      description: {
        type: 'string',
        required: true,
        description: RUN_CELL_DESCRIPTION_PARAM_DESCRIPTION,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logs: { type: 'array', required: true, items: { type: 'string' } },
          result: { type: 'json' },
        },
      },
      render: (_args, value) => {
        const rendered = value.result === undefined ? '' : renderValue(value.result)
        const parts = [value.logs.join('\n'), rendered].filter(part => part.length > 0)
        return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : `(${RUN_CELL_NAME} completed with no output)` }]
      },
    },
    async execute(args, exec): Promise<RunCellOutput> {
      if (args.description.trim().length === 0) {
        throw new Error('dashr-tool-presentation: invalid description: expected a non-empty string')
      }
      const runtime = requireRuntime()

      // The run-scoped abort: follows the outer signal in, and fires when the
      // run settles for ANY reason, so an in-flight sub-dispatch is aborted
      // (its executor kills on this signal) instead of orphaned, and
      // queued-unstarted dispatches are abandoned.
      const runController = new AbortController()
      const onOuterAbort = (): void => { runController.abort(exec.signal.reason) }
      exec.signal.addEventListener('abort', onOuterAbort, { once: true })

      let dispatches = 0
      // The per-run scheduler uses the registry's staged interface and follows
      // the same concurrency rules as the native loop (ported from upstream
      // code-mode.ts): every ordered stage (the dispatch-start append,
      // prepare = pre-execute/guards, finalize/finish = post-execute, context
      // deferral, the settle append) runs inside ONE driver lane, so ordered
      // policy stages never overlap each other and only the
      // around-dispatch/body stage runs concurrently. Starts are strictly
      // submission-ordered; results commit in submission order through the
      // head-of-line cursor. Consecutive parallel-classified calls overlap up
      // to maxParallel; an exclusive call waits for the pool to drain, runs
      // alone, and holds its barrier until its COMMIT (post-execute included)
      // completes, exactly like a native exclusive group. Classification is
      // re-read via executionMode() immediately before each start (a registry
      // mutation while queued can flip a call exclusive), matching the native
      // scheduler's lazy reclassification.
      interface PendingDispatch {
        start(): Promise<void>
        classify(): 'parallel' | 'exclusive'
        abandon(): void
        commit(): Promise<void>
        flight: Promise<void>
        settled: boolean
        mode?: 'parallel' | 'exclusive'
      }
      const pendingQueue: PendingDispatch[] = []
      const inFlight = new Set<Promise<void>>()
      /** Tracked settle-event side work (log-content listener + append), drained at run settlement. */
      const logWork = new Set<Promise<void>>()
      const commitQueue: PendingDispatch[] = []
      let exclusiveActive = false
      let driving = false
      let driverRun: Promise<void> = Promise.resolve()
      let wake: (() => void) | undefined
      const wakeup = (): void => {
        const release = wake
        wake = undefined
        release?.()
      }
      /** The single ordered lane (ported; see the block comment above). */
      const drive = (): Promise<void> => {
        if (driving) return driverRun
        driving = true
        driverRun = (async () => {
          try {
            for (;;) {
              const signal = new Promise<void>((resolve) => { wake = resolve })
              const commitHead = commitQueue[0]
              if (commitHead !== undefined && commitHead.settled) {
                commitQueue.shift()
                await commitHead.commit()
                if (commitHead.mode === 'exclusive') exclusiveActive = false
                continue
              }
              const head = pendingQueue[0]
              if (head !== undefined) {
                if (runController.signal.aborted) {
                  pendingQueue.shift()
                  head.abandon()
                  continue
                }
                const mode = head.classify()
                const capacity = !exclusiveActive
                  && (mode === 'exclusive' ? inFlight.size === 0 : inFlight.size < maxParallel)
                if (capacity) {
                  if (mode === 'exclusive') exclusiveActive = true
                  head.mode = mode
                  pendingQueue.shift()
                  commitQueue.push(head)
                  await head.start()
                  const flight: Promise<void> = head.flight.finally(() => {
                    inFlight.delete(flight)
                    wakeup()
                  })
                  inFlight.add(flight)
                  continue
                }
              }
              if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return
              await signal
            }
          } finally {
            driving = false
            wake = undefined
          }
        })()
        return driverRun
      }
      /** Every dispatch settled AND committed; nothing can start (the run is aborted at call time). */
      const drainDispatches = async (): Promise<void> => {
        await drive()
        while (logWork.size > 0) await Promise.allSettled([...logWork])
      }

      const runOver = (): boolean => runController.signal.aborted

      const binding = (name: string): RlmBindingFunction => async (rawArgs: unknown): Promise<JsonValue> => {
        if (runOver()) {
          throw new Error(`${RUN_CELL_NAME} run is over (${String(runController.signal.reason)}); ${name} not dispatched`)
        }
        const normalized = jsonNormalizeArgs(rawArgs)
        const n = ++dispatches
        const subCallId = CallId(`${String(exec.callId)}:code:${n}`)
        const input: ToolExecutionInput = {
          callId: subCallId,
          rootCallId: exec.rootCallId,
          name,
          arguments: normalized.dispatched,
          ...exec.agent ? { agent: exec.agent } : {},
          parent: exec.token,
          signal: runController.signal,
        }
        type DispatchOutcome = { isError: true; message: string } | { isError: false; value: JsonValue }
        const scheduler = registry[TOOL_RUNTIME_SCHEDULER]
        const outcome = await new Promise<DispatchOutcome>((resolve, reject) => {
          let parked:
            | { kind: 'post-result' | 'final-result'; exec: ToolRunContext; result: ToolExecutionResult }
            | undefined
          const settle = (result: ToolExecutionResult): void => {
            // The program gets its value NOW: the log-content listener (for
            // example, a spill backend) must never delay the binding or
            // occupy a dispatch slot. The event append is tracked side work;
            // the run's settlement drains logWork so every settle event is
            // still appended inside the open turn.
            resolve(result.isError
              ? { isError: true, message: result.error.message }
              : { isError: false, value: result.value as JsonValue })
            const agent = exec.agent
            if (agent === undefined) return
            const task: Promise<void> = (async () => {
              // The registry-private shapeDispatchLog invoker is not callable
              // from a consumer, but the waterfall it drives is a published
              // event: the capability passed in options replicates it (same
              // carrier, same containment) so durable copies keep the
              // reshape extension point.
              const logged = await shapeDispatchLog({ exec, agent, subCallId, name, isError: result.isError, content: result.content })
              agent.session.append('tool/code-dispatch', {
                rootCallId: exec.rootCallId,
                parentCallId: exec.callId,
                subCallId,
                name,
                // The SIBLING parse of the dispatched value: byte-identical JSON,
                // but a separate object — a tool mutating its args cannot desync
                // this record from what it actually received.
                arguments: normalized.logged,
                isError: result.isError,
                content: logged,
              })
            })().finally(() => { logWork.delete(task) })
            logWork.add(task)
          }
          pendingQueue.push({
            flight: Promise.resolve(),
            settled: false,
            classify: () => registry.executionMode(input).kind,
            abandon: () => {
              reject(new Error(`${RUN_CELL_NAME} run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`))
            },
            async start(): Promise<void> {
              exec.agent?.session.append('tool/code-dispatch-start', {
                rootCallId: exec.rootCallId,
                parentCallId: exec.callId,
                subCallId,
                name,
                arguments: normalized.logged,
              })
              // Ordered prepare runs INSIDE the driver lane: the next entry's
              // pre-execute waits for this resolution, as under the native
              // scheduler. Only the launched body below overlaps.
              const prepared = await scheduler.prepare(input)
              if (prepared.kind === 'dispatch') {
                this.flight = scheduler.dispatch(prepared.exec).then((dispatchOutcome) => {
                  parked = { kind: dispatchOutcome.kind, exec: prepared.exec, result: dispatchOutcome.result }
                  this.settled = true
                })
                return
              }
              parked = { kind: prepared.kind, exec: prepared.exec, result: prepared.result }
              this.settled = true
            },
            async commit(): Promise<void> {
              if (parked === undefined) return
              const result = parked.kind === 'post-result'
                ? await scheduler.finalize(parked.exec, parked.result)
                : scheduler.finish(parked.exec, parked.result)
              for (const context of result.additionalContexts ?? []) {
                exec.deferContext(context)
              }
              // Only a successful nested result can carry the terminal
              // marker (ToolExecutionFailure types it never), so a
              // policy-converted failure cannot stop the turn through a
              // recovering program.
              if (result.concludesTurn) exec.concludeTurn()
              settle(result)
              // Backpressure on pending event-append tasks: each task retains
              // a full result while a slow backend stores it, so the pool cap
              // bounds their count.
              while (logWork.size > maxParallel) await Promise.race(logWork)
            },
          })
          wakeup()
          void drive()
        })
        // A budget expiry or outer cancel that occurs while this call was in
        // flight already aborted the dispatch; stop the program now rather
        // than hand it a result from a run that is over.
        if (runOver()) {
          throw new Error(`${RUN_CELL_NAME} run is over (${String(runController.signal.reason)}); ${name} result discarded`)
        }
        // The kernel turns a binding rejection into ToolCallError and adds
        // only the binding name. Native content and internal error metadata
        // stay outside the program-facing failure contract.
        if (outcome.isError) throw new Error(outcome.message)
        return outcome.value
      }

      // Null-prototype + defineProperty, mirroring the kernel-side namespace
      // build: a registered tool named `__proto__` must become an ordinary
      // own key (a plain-object assignment would hit the prototype setter,
      // silently dropping the binding), and the runtime resolves binding
      // names as own properties only.
      const functions: Record<string, RlmBindingFunction> = Object.create(null) as Record<string, RlmBindingFunction>
      // Enumerate the CALLING AGENT's visible set (scoped tools join,
      // restricted globals vanish) — the same view the SDK section declared,
      // so a cell can bind exactly what its prompt promised; sub-dispatch
      // re-resolves per call through the same view (exec.agent threads down).
      for (const schema of registry.schemas(exec.agent)) {
        if (schema.name === RUN_CELL_NAME) continue
        Object.defineProperty(functions, schema.name, { enumerable: true, value: binding(schema.name) })
      }

      // rlm() / rlm_await() bare callable globals (M3-B, blueprint §9): the
      // host-plane ctx.subagents capability, exposed as first-class kernel
      // functions. rlm() is non-blocking admission (returns the handle and
      // the child keeps running after the cell; its optional model kwarg
      // selects the child's model — M4-A priority kwarg > subagentModel
      // config > parent inheritance, resolved inside the callable),
      // rlm_await() blocks the cell until the run settles (interruptible by
      // the run's own abort). Both return structured JSON — an error is a
      // FIELD, never a host crash.
      const runs = rlmRuns ?? new RlmRunRegistry()

      const rlmCallable: RlmBindingFunction = async (rawArgs: unknown): Promise<RlmJsonValue> => {
        const parsed = parseRlmCall(rawArgs)
        if (!parsed.ok) return { error: parsed.error }
        const { args: callArgs, kwargs } = parsed
        if (callArgs.length !== 1 || typeof callArgs[0] !== 'string') {
          return { error: 'rlm(prompt, *, label=None, model=None) expects exactly one positional prompt string' }
        }
        const prompt = callArgs[0]
        const label = kwargs['label']
        const model = kwargs['model']
        const unknownKeys = Object.keys(kwargs).filter(key => key !== 'label' && key !== 'model')
        if (unknownKeys.length > 0) {
          return { error: `rlm() got unexpected keyword argument(s): ${unknownKeys.join(', ')}` }
        }
        if (label !== undefined && label !== null && typeof label !== 'string') {
          return { error: 'rlm() label must be a string or None' }
        }
        // Non-string types and the empty string are both structured errors:
        // '' is a hand-slip, not a provider-resolvable model id — the kwarg
        // layer rejects it exactly like the config layer's boundary does
        // (resolveSubagentModel), keeping both layers symmetric.
        if (model !== undefined && model !== null && (typeof model !== 'string' || model.length === 0)) {
          return { error: 'rlm() model must be a non-empty string or None' }
        }
        if (!exec.agent) {
          return { error: 'rlm() requires an agent session (this run has no parent agent)' }
        }
        const subagents = requireSubagents?.()
        if (!subagents) {
          return { error: 'rlm() is unavailable: no ctx.subagents service is mounted in this composition' }
        }
        // Child-model priority (M4-A, blueprint §6): the per-call kwarg
        // shadows the composition default, and BOTH absent means the start
        // request carries NO agentOptions — dsh's resolveChildAgentOptions
        // then spreads the parent's own provider/model/maxTokens (pure
        // inheritance). The parent's model is deliberately never read and
        // re-sent here: naming it would freeze this bridge to one reading
        // of how inheritance resolves, while omission keeps the zero
        // Dash-side-assumption stance. `model=None` is "unspecified" in the
        // Python signature, so it falls through to the config tier like an
        // omitted kwarg (there is deliberately no "force inherit past the
        // config" escape hatch — recompose the row instead).
        const resolvedModel = model ?? subagentModel
        try {
          const run = await subagents.start(RLM_PROVIDER, {
            ...(label !== undefined && label !== null ? { label } : {}),
            prompt: [{ type: 'text', text: prompt }],
            parent: exec.agent,
            signal: exec.signal,
            ...(resolvedModel !== undefined ? { agentOptions: { model: resolvedModel } } : {}),
          })
          runs.set(run.id, { run, parentId: exec.agent.id })
          return {
            run_id: run.id,
            label: label ?? null,
            provider: RLM_PROVIDER,
            local: run.localAgent !== undefined,
            // What this side resolved, not what the provider accepted: null
            // reports inheritance (the parent route, unnamed here).
            model: resolvedModel ?? null,
          }
        } catch (error: unknown) {
          return { error: `rlm() start failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }

      const rlmAwaitCallable: RlmBindingFunction = async (rawArgs: unknown): Promise<RlmJsonValue> => {
        const parsed = parseRlmCall(rawArgs)
        if (!parsed.ok) return { output: null, stop_reason: 'error', structured: null, error: parsed.error }
        const { args: callArgs, kwargs } = parsed
        if (callArgs.length !== 1 || typeof callArgs[0] !== 'string' || Object.keys(kwargs).length > 0) {
          return { output: null, stop_reason: 'error', structured: null, error: 'rlm_await(run_id) expects exactly one positional string argument' }
        }
        const runId = callArgs[0]
        const record = runs.get(runId)
        if (!record) {
          return { output: null, stop_reason: 'error', structured: null, error: `rlm_await: unknown or already-settled run_id ${JSON.stringify(runId)}` }
        }
        // The wait is interruptible: the run-scoped abort (timeout/abort of the
        // enclosing cell) resolves this race, so a cell blocked on rlm_await is
        // never leaked past its budget.
        const aborted = new Promise<never>((_, reject) => {
          const onAbort = (): void => { reject(new Error(`rlm_await interrupted (${String(runController.signal.reason)})`)) }
          if (runController.signal.aborted) onAbort()
          else runController.signal.addEventListener('abort', onAbort, { once: true })
        })
        try {
          const result = await Promise.race([record.run.result, aborted])
          runs.delete(runId)
          let structured: RlmJsonValue | null = null
          let output = extractTextFromBlocks(result.output)
          if (result.structured !== undefined) {
            const detached = snapshotJsonValue(result.structured)
            if (detached === undefined) {
              output = output.length > 0 ? `${output}\n[structured result was not lossless JSON]` : '[structured result was not lossless JSON]'
            } else {
              structured = detached as RlmJsonValue
            }
          }
          return { output, stop_reason: result.stopReason, structured }
        } catch (error: unknown) {
          // An abort leaves the run in the map (rlm_await did not take its
          // result); an infrastructure rejection settles it, so drop it.
          if (!runController.signal.aborted) runs.delete(runId)
          return {
            output: null,
            stop_reason: runController.signal.aborted ? 'aborted' : 'error',
            structured: null,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }

      // refine() bare callable global (M4-B, blueprint §6): one in-cell
      // instruction → one hand-built auxiliary LLM call → Continual Harness
      // ops. Awaiting it inside the cell blocks that cell until the call
      // settles (under the kernel run's own wall budget); the NEXT system
      // prompt assembly re-renders the harness from the store, so the edit
      // is visible to the next model request — prompt-as-variable. Errors are
      // structured JSON fields; a parse failure leaves the store untouched.
      const refineCallable: RlmBindingFunction = async (rawArgs: unknown): Promise<RlmJsonValue> => {
        const parsed = parseRlmCall(rawArgs)
        if (!parsed.ok) return { error: parsed.error }
        const { args: callArgs, kwargs } = parsed
        if (callArgs.length !== 1 || typeof callArgs[0] !== 'string' || Object.keys(kwargs).length > 0) {
          return { error: 'refine(instruction) expects exactly one positional instruction string' }
        }
        const instruction = callArgs[0]
        if (instruction.trim().length === 0) {
          return { error: 'refine(instruction): the instruction must be a non-empty string' }
        }
        if (!exec.agent) {
          return { error: 'refine() requires an agent session (the harness is per-agent; this run has no parent agent)' }
        }
        const llm = requireLlm?.()
        if (!llm) {
          return { error: 'refine() is unavailable: no ctx.llm service is mounted in this composition' }
        }
        const target = resolveRefineTarget(refineModel, exec.agent)
        if ('error' in target) return { error: `refine() model route unresolved: ${target.error}` }
        const entries = harness.list(exec.agent.id)
        const options: GenerateOptions = {
          provider: target.provider,
          model: target.model,
          messages: buildRefineMessages(entries, instruction),
          system: REFINE_SYSTEM,
          maxTokens: REFINE_MAX_TOKENS,
          signal: exec.signal,
          sessionId: exec.agent.session.id,
        }
        // A hand-built one-shot: no markAgentLoopRequest identity (that
        // belongs to loop-built requests), so llm/stream listeners see an
        // ordinary plugin-authored call whose content is NOT a pure function
        // of the session log.
        let answer: string
        try {
          const assembler = new BlockAssembler()
          for await (const chunk of llm.stream(options)) assembler.push(chunk)
          const finish = assembler.finish
          if (finish.kind === 'error' || finish.kind === 'aborted') {
            return { error: `refine() model call ${finish.kind}: ${finish.failure.message}` }
          }
          if (finish.kind === 'max-tokens') {
            return { error: 'refine() model call hit its token cap before emitting a complete ops array' }
          }
          answer = assembler.blocks().filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n')
        } catch (error: unknown) {
          return { error: `refine() model call failed: ${error instanceof Error ? error.message : String(error)}` }
        }
        let ops: HarnessOp[] | undefined
        try {
          ops = parseRefineAnswer(answer)
        } catch (error: unknown) {
          return { error: `refine() rejected the model's ops (store untouched): ${error instanceof Error ? error.message : String(error)}` }
        }
        if (ops === undefined) {
          return { error: `refine() could not parse a JSON ops array from the model answer (store untouched): ${answer.slice(0, 160)}` }
        }
        let report: HarnessApplyReport
        try {
          report = await harness.applyOps(exec.agent.id, ops)
        } catch (error: unknown) {
          return { error: `refine() ops rejected (store untouched): ${error instanceof Error ? error.message : String(error)}` }
        }
        return {
          refined: true,
          applied: report.applied,
          entries_before: report.before,
          entries_after: report.after,
          model: { provider: target.provider, model: target.model },
        }
      }

      // compact() bare callable global (M4-B): the PA "check usage →
      // summarize → keep working" semantics over the host compaction seam.
      // The seam's compactNow requires an IDLE agent — an in-cell call runs
      // inside a live agent turn, so it answers 'busy' there and the ladder
      // falls through to compactIfNeeded('pressure'), the same policy entry
      // the engine itself runs between steps: below threshold it is an
      // honest no-op, above it the range is summarized NOW and the model's
      // next request in the SAME turn already rides the compacted history.
      const compactCallable: RlmBindingFunction = async (rawArgs: unknown): Promise<RlmJsonValue> => {
        const parsed = parseRlmCall(rawArgs)
        if (!parsed.ok) return { error: parsed.error }
        const { args: callArgs, kwargs } = parsed
        if (callArgs.length > 1 || (callArgs.length === 1 && typeof callArgs[0] !== 'string') || Object.keys(kwargs).length > 0) {
          return { error: 'compact() expects no arguments, or one optional positional reason string' }
        }
        if (!exec.agent) {
          return { error: 'compact() requires an agent session (this run has no parent agent)' }
        }
        const agent = exec.agent
        const result: Record<string, RlmJsonValue> = {}
        const meter = requireTokenMeter?.()
        if (meter !== undefined) {
          try {
            result['context_tokens'] = meter.measure(agent.session).totalTokens
          } catch {
            // The probe is advisory; a failing meter must not mask compaction.
          }
        }
        let engine: DasherCompactionSurface | undefined
        if (scopedCompaction !== undefined) {
          const scoped = await scopedCompaction(agent)
          if ('error' in scoped) {
            return { ...result, error: scoped.error }
          }
          engine = scoped.engine
          result['compact_model'] = { provider: scoped.target.provider, model: scoped.target.model }
        } else {
          engine = requireCompaction?.()
          if (engine === undefined) {
            return { ...result, error: 'compact() is unavailable: no ctx.compaction engine is mounted in this composition (and no compactModel is configured to mount a DASHR-scoped one)' }
          }
          result['compact_model'] = null
        }
        const summarize = (path: 'compact-now' | 'pressure', outcome: DasherCompactionResult | null): RlmJsonValue => {
          if (outcome === null) {
            return { ...result, status: 'no-op', path }
          }
          return {
            ...result,
            status: 'compacted',
            path,
            compaction_id: typeof outcome.compactionId === 'number' ? outcome.compactionId : String(outcome.compactionId),
            summary_seq: outcome.summarySeq,
            shadowed_items: outcome.shadowedSeqs.length,
            shadowed_tokens: outcome.shadowedTokenCount,
          }
        }
        try {
          return summarize('compact-now', await engine.compactNow(agent, exec.signal))
        } catch (error: unknown) {
          if ((error as { code?: unknown }).code !== 'busy') {
            return { ...result, error: `compact() failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        }
        try {
          return summarize('pressure', await engine.compactIfNeeded(agent, 'pressure', exec.signal))
        } catch (error: unknown) {
          return { ...result, error: `compact() pressure compaction failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }

      try {
        let result: RlmRunResult
        try {
          result = await runtime.run({
            program: args.code,
            bindings: [{
              global: 'tools',
              functions,
              errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
            }, {
              global: 'rlm',
              functions: { __call__: rlmCallable },
              callable: true,
            }, {
              global: 'rlm_await',
              functions: { __call__: rlmAwaitCallable },
              callable: true,
            }, {
              global: 'refine',
              functions: { __call__: refineCallable },
              callable: true,
            }, {
              global: 'compact',
              functions: { __call__: compactCallable },
              callable: true,
            }],
            signal: runController.signal,
            // Session identity for kernel-per-session keying: the calling
            // agent's id (a session id). An agentless call leaves it absent
            // and lands on the runtime's shared default key.
            ...exec.agent ? { principal: exec.agent.id } : {},
          })
        } finally {
          // Abort sub-dispatches and drain every in-flight dispatch before
          // closing the turn (queued-unstarted ones are abandoned unlogged).
          // Binding failures remain observable through their individual promises.
          runController.abort(`${RUN_CELL_NAME} settled`)
          await drainDispatches()
        }

        if (result.error) {
          const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join('\n')}` : ''
          throw new DasherRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`)
        }
        return {
          logs: result.logs,
          ...result.value !== undefined ? { result: result.value } : {},
        }
      } finally {
        exec.signal.removeEventListener('abort', onOuterAbort)
      }
    },
    // The model-authored description is the call's always-visible UI label
    // (the bash `description` precedent); the cell itself rides rawInput.
    presentCall: args => ({
      card: 'generic',
      title: args.description,
      kind: 'execute',
      rawInput: args.code,
    }),
    // Deliberately no presentResult: the generic card fallback keeps this
    // title and reads durable result content without duplicating a large raw
    // result into the host view payload.
  })
}

/**
 * Collect one calling scope's SDK schemas through the registry's public
 * projection APIs: `schemas(scope)` for the model-facing view (scoped tools
 * join, restrictions apply), `get(name, scope)` for the canonical output
 * schema, snapshotted so a live definition cannot mutate under the render.
 * `run_cell` itself is excluded — it is the transport, not a binding.
 */
export function collectSdkSchemas(registry: ToolRuntime, scope?: ScopeKey): DasherSdkSchema[] {
  const collected: DasherSdkSchema[] = []
  for (const schema of registry.schemas(scope)) {
    if (schema.name === RUN_CELL_NAME) continue
    const definition = registry.get(schema.name, scope)
    if (definition === undefined) continue
    const output = snapshotJsonValue(definition.output.schema) as JsonSchemaNode | undefined
    if (output === undefined) continue
    collected.push({ name: schema.name, description: schema.description, parameters: schema.parameters, output })
  }
  return collected
}

/**
 * Declare the Dasher cell presentation for every agent this composition
 * covers: the `run_cell` transport tool, the `tools:dasher-sdk` prompt
 * section, the model-direct collapse guard, and the assembly filter that
 * leaves `run_cell` the only contributed tool schema.
 *
 * Mount through a preset's standing scope (`agent.cordis.yml` include row);
 * mounting unscoped is legal for a whole-process Dasher deployment and gives
 * the same shape at the global layer.
 * @param ctx - the mounting composition's context (a preset's standing scope).
 * @param config - the plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dashr-tool-presentation')
  const maxParallel = resolveMaxParallelSubCalls(config.maxParallelSubCalls)
  const subagentModel = resolveSubagentModel(config.subagentModel)
  const harnessDir = resolveHarnessDir(config.harnessDir)
  const refineModel = resolveRefineModel(config.refineModel)
  const compactModel = resolveCompactModel(config.compactModel)

  // The wait is the loud failure: a preset row still pending on `rlmRuntime`
  // is what the preset mount audit reports as an unusable row, naming this
  // plugin. Use-time reads below stay authoritative at execution.
  ctx.inject(['rlmRuntime'], (runtimeCtx: Context) => {
    const requireRuntime = (): RlmRuntimeSurface => {
      // Structural read (see runtime-surface.ts): the Context merge the
      // sibling runtime package declares is deliberately not imported here.
      const runtime = runtimeCtx.get('rlmRuntime') as RlmRuntimeSurface | undefined
      if (!runtime) {
        throw new Error('dashr-tool-presentation: run_cell requires an rlmRuntime service — load a ctx.rlmRuntime implementation (e.g. dashr-code-runtime-ipython) in this composition')
      }
      if (runtime.language !== 'python') {
        throw new Error(`dashr-tool-presentation: no cell SDK for runtime language ${JSON.stringify(runtime.language)} (dashr-tool-presentation presents Python only; got a ${JSON.stringify(runtime.language)} runtime under ctx.rlmRuntime)`)
      }
      return runtime
    }

    const registry = runtimeCtx.tools

    // `systemPrompt` resolves at use time through `get()` — the same
    // optional-backend idiom as `requireCodeRuntime` — rather than a second
    // static inject entry: the tools service itself cannot construct without
    // systemPrompt (its own static inject), so presence is already implied by
    // this plugin's `inject = ['tools']` wait.
    const systemPrompt = runtimeCtx.get('systemPrompt')
    if (!systemPrompt) {
      throw new Error('dashr-tool-presentation: ctx.systemPrompt is required beside ctx.tools (the tools service itself depends on it) — this composition mounted tools without a system prompt registry')
    }

    // The consumer-side stand-in for the registry-private shapeDispatchLog
    // invoker: same scope-targeted carrier over the published
    // `tools/code-dispatch-log` waterfall, same containment — a throwing
    // listener logs a warning and the original settled content is logged.
    const shapeDispatchLog = async (dispatch: CodeDispatchLog): Promise<ContentBlock[]> => {
      try {
        return await runtimeCtx.waterfall(
          scopeTarget(registry, dispatch.agent),
          'tools/code-dispatch-log',
          dispatch,
          () => Promise.resolve(dispatch.content),
        )
      } catch (error: unknown) {
        logger.warn(`dashr-tool-presentation: code-dispatch-log listener failed for ${dispatch.name}: ${error instanceof Error ? error.message : String(error)}; logging the original settled content`)
        return dispatch.content
      }
    }

    // The Continual Harness store (M4-B), shared by every run_cell call AND
    // the dasher:harness prompt section in this composition. `agent/disposed`
    // drops one agent's in-memory cache only — with a harnessDir configured
    // the FILE persists by design, so the agent's next session restores its
    // entries (that is what "continual" means here).
    const harness = new HarnessStore(harnessDir)

    // rlm() live-run registry, shared by every run_cell call in this
    // composition. Cleaned per session on `agent/disposed` (the same untyped
    // event the runtime provider listens for — scope filtering applies to
    // this row identically) and drained on composition teardown.
    const rlmRuns = new RlmRunRegistry()
    runtimeCtx.events.on('agent/disposed', (payload: unknown) => {
      const principal = (payload as { agent?: { id?: unknown } } | null)?.agent?.id
      if (typeof principal === 'string' && principal.length > 0) {
        harness.drop(principal)
        void rlmRuns.disposeFor(principal).catch(() => undefined)
      }
    })
    runtimeCtx.effect(() => () => { void rlmRuns.disposeAll() }, 'dashr rlm run disposal')

    // The compactModel tier's DASHR-scoped engine (design A): an
    // isolation-labelled child context — `ctx.isolate('compaction')` — so the
    // provide can never collide with a host-level engine (cordis keys service
    // registration by isolation label; a same-label provide throws), and the
    // scoped instance never resolves outside this composition. The engine is
    // mounted lazily on the FIRST compact() call: the bare-model form needs a
    // provider then (the first calling agent's), and the dynamic import keeps
    // the optional peer unloaded for deployments that never set compactModel.
    // `auto: false` is load-bearing: the host engine keeps the automatic
    // pressure/overflow listeners for this agent, and a scoped engine with
    // auto:true would double-fire them.
    const scopedCompaction = compactModel === undefined ? undefined : (() => {
      // Captured once, non-optional inside this branch: the isolation label
      // this composition's scoped engine provides (and resolves) under.
      const engineScope = runtimeCtx.isolate('compaction')
      let mounted: Promise<ScopedCompactionOutcome> | undefined
      return (agent: Agent): Promise<ScopedCompactionOutcome> => {
        const slash = compactModel.indexOf('/')
        const provider = slash >= 0
          ? compactModel.slice(0, slash)
          : (typeof agent.options?.provider === 'string' && agent.options.provider.length > 0 ? agent.options.provider : undefined)
        const model = slash >= 0 ? compactModel.slice(slash + 1) : compactModel
        if (slash >= 0 && (provider?.length === 0 || model.length === 0)) {
          return Promise.resolve({ error: `compactModel ${JSON.stringify(compactModel)} has an empty provider or model half; use the full "provider/model" form` })
        }
        if (provider === undefined) {
          return Promise.resolve({ error: `compactModel ${JSON.stringify(compactModel)} is a bare model id and this agent has no provider to pair it with; use the "provider/model" form or configure the agent's provider` })
        }
        mounted ??= (async (): Promise<ScopedCompactionOutcome> => {
          try {
            const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic')
            // A proper plugin fiber, NOT a bare constructor call: the class's
            // static inject (llm/tokenMeter/sessions) is what lets its OWN
            // `this.ctx.tokenMeter` property reads resolve — a directly
            // constructed instance has no fiber, so those reads would demand
            // host services on ANCESTOR fibers (root children never qualify).
            // The fiber also stays PENDING (loudly, via the error below)
            // while a host singleton is missing.
            const fiber = engineScope.plugin(BasicCompactionEngine, {
              summarizationProvider: provider,
              summarizationModel: model,
              auto: false,
            })
            await fiber
            const engine = engineScope.get('compaction') as DasherCompactionSurface | undefined
            if (engine === undefined) {
              return { error: 'compactModel is set but the DASHR-scoped compaction engine did not become available: the host composition must provide llm, tokenMeter, and sessions for it to load' }
            }
            return { engine, target: { provider, model } }
          } catch (error: unknown) {
            return { error: `compactModel is set but the DASHR-scoped compaction engine could not be mounted: ${error instanceof Error ? error.message : String(error)} (is the optional peer @deepseek-ai/dsh-compaction-basic installed next to dashr-tool-presentation?)` }
          }
        })()
        return mounted
      }
    })()

    // ① The transport tool, an ordinary scoped registration (module doc
    // records the reservation delta). Registered through the injected
    // runtime context so the tool's lifetime follows the runtime service's.
    const requireSubagents = (): DasherSubagentsSurface | undefined => runtimeCtx.get('subagents')
    const requireLlm = (): LlmStreamSurface | undefined => runtimeCtx.get('llm') as LlmStreamSurface | undefined
    const requireCompaction = (): DasherCompactionSurface | undefined => runtimeCtx.get('compaction') as DasherCompactionSurface | undefined
    const requireTokenMeter = (): DasherTokenMeterSurface | undefined => runtimeCtx.get('tokenMeter') as DasherTokenMeterSurface | undefined
    runtimeCtx.tools.register(createRunCellTool(registry, { requireRuntime, maxParallel, shapeDispatchLog, requireSubagents, rlmRuns, subagentModel, harness, refineModel, compactModel, requireLlm, requireCompaction, requireTokenMeter, scopedCompaction }))

    // ② The generated-SDK prompt section, regenerated from the CALLING
    // scope's visible tools at assembly time (the same scope-aware shape as
    // upstream's sdkSection: an assembly for a different scope renders its
    // own view, never ours).
    systemPrompt.section({
      name: 'tools:dasher-sdk',
      order: SDK_SECTION_ORDER,
      text: context => renderToolsSdkPy(collectSdkSchemas(registry, context.scope)),
    })

    // ②′ The Continual Harness section (M4-B): prompt-as-variable. The text
    // provider re-reads the CALLING agent's harness at EVERY assembly — the
    // `context.agent` field dsh-agent's `assembleContextFor` carries (typed
    // by its AssembleContext merge; a scope-only assembly has no agent and
    // renders empty, as does an empty harness — `renderPrompt` drops empty
    // sections, so absence costs nothing). A refine() that lands mid-turn is
    // therefore reflected by the next request's system prompt with no
    // restart, which is the whole point of the section.
    systemPrompt.section({
      name: 'dasher:harness',
      order: HARNESS_SECTION_ORDER,
      text: context => renderHarnessSection(harness.list(String(context.agent?.id ?? ''))),
    })

    // ③ Schema collapse: keep only run_cell in the tools the model may call
    // directly. The assembly waterfall's returned value is authoritative
    // (dsh-tools README), and this listener is scoped to the mounting
    // composition — an assembly for any other scope never reaches it, so a
    // PTC preset in the same process keeps its full native schema set.
    runtimeCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return {
        ...assembly,
        tools: assembly.tools.filter(tool => tool.name === RUN_CELL_NAME),
      }
    }, { prepend: true })

    // ④ Model-direct collapse guard: with the schema surface collapsed to
    // run_cell, a model-direct call naming anything else must fail with the
    // route back into a cell — a bare "unknown tool" for a tool the SDK just
    // declared would read as a broken deployment. Nested sub-dispatches (a
    // `parent` token set — exactly what the bridge above mints) and
    // run_cell itself pass.
    runtimeCtx.tools.guard(exec => {
      if (exec.parent === undefined && exec.name !== RUN_CELL_NAME) {
        return `only \`${RUN_CELL_NAME}\` is callable directly — call \`${exec.name}\` from inside a \`${RUN_CELL_NAME}\` program instead`
      }
      return undefined
    })
  })
}

export default { name, inject, Config, apply }
