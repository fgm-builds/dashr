/** `dsh-rlm-mode`: the DASHR RLM mode — one plugin, one row.
 *
 * Naming (v0.1.5 layer model): the runtime class is `DashrRuntime`, the
 * standing-mount-layer component — one instance per mount holding the
 * cross-session kernel map, hence the de facto daemon while the
 * profile-level `DashrDaemon` concept stays an empty shell; the session
 * layer is each ipykernel subprocess, a pure interpreter with no harness
 * awareness.
 *
 * This package merges what were two sibling plugins into a single
 * composition row: `DashrRuntime` (the stateful kernel runtime — the
 * `ctx.rlmRuntime` implementation, mounted first, below) and the RLM
 * agent-plane presentation
 * (blueprint §7.4) — the `ipython` transport tool, the generated Tool
 * Catalog prompt section, the model-direct-call collapse, the tool→binding
 * bridge that binds the registry's agent-visible tools as FLAT top-level
 * `await name(args)` functions (v0.1.5 Q8: no `tools` holder, no prefix), the
 * masked-tool bridges (`rlm`/`agent_message`/`agent_list`/`rlm_workflow`/
 * `rlm_ralph`, ADR-0001 tool-layer dispatch), the Continual Harness
 * (`refine`), and the compaction surface (`compact`).
 *
 * The presentation row registers against the harness tool registry the way
 * any dsh tool row must (shape-mirroring `dsh-agent-tool-presentation` and
 * the code-mode half of `dsh-tools`, 0.1.0-rc.6), but it re-points execution
 * at our own `ctx.rlmRuntime` (the harness's runtime seam, vendored from
 * `@deepseek-ai/dsh-code-runtime` in `src/vendored/rlm-runtime.ts` as an
 * interface only): the host registry stays untouched, and this row composes
 * per scope — a DASHR preset mounts it in its standing scope, so every agent
 * joined under that preset gets the cell surface while PTC / native presets
 * in the SAME process keep their own presentation. One row per composition,
 * not one per session. The seam is transport only: the KERNEL semantics —
 * resident IPython REPL, context as variables, last-expression completion —
 * are ours, not the upstream code mode's.
 *
 * Registration deltas from the upstream code-mode row, recorded per
 * blueprint §7.6:
 * - `ipython` (not `run_code`): the registry reserves `run_code`
 *   unconditionally, and a distinct name is what lets a DASHR preset and a
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
 *   to `ipython` uses the assembly waterfall's documented authority
 *   (dsh-tools README: "its returned assembly is authoritative").
 *
 * The runtime is mounted at the TOP of `apply` (before the presentation
 * injects), so a DASHR preset against a runtime-less composition fails AT
 * MOUNT — named in the preset's activation audit — instead of at the first
 * prompt. The presentation resolves `ctx.rlmRuntime` at USE time (never a
 * static inject): a static inject entry would hold the whole composition
 * hostage to the runtime service existing, and the `ipython` execution
 * path re-reads `ctx.get('rlmRuntime')` with an actionable error,
 * mirroring upstream `requireCodeRuntime`.
 * @module dsh-rlm-mode
 */


import { Context } from '@deepseek-ai/cordis'
import { DashrRuntime } from './runtime.ts'
import type { Config as RuntimeConfig } from './runtime.ts'
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
  RlmBindingErrorClass,
  RlmBindingFunction,
  RlmBindingNamespace,
  RlmJsonValue,
  RlmRunResult,
  RlmRuntimeSurface,
} from './runtime-surface.ts'
import { isFlatBindableName, renderToolsSdkPy } from './py-sdk.ts'
import type { DASHRSdkSchema } from './py-sdk.ts'
import { snapshotJsonValue } from './snapshot-json.ts'
import type { JsonValue } from './snapshot-json.ts'
import type { DASHRSubagentsSurface } from './subagents-surface.ts'
import { HarnessStore, renderHarnessSection } from './harness-store.ts'
import type { HarnessApplyReport, HarnessOp } from './harness-store.ts'
import { REFINE_MAX_TOKENS, REFINE_SYSTEM, buildRefineMessages, parseRefineAnswer, resolveRefineTarget } from './refine.ts'
import type { RefineTarget } from './refine.ts'
import type { DASHRCompactionResult, DASHRCompactionSurface, DASHRTokenMeterSurface } from './compaction-surface.ts'
import { DASHR_CONTROL_PROMPT } from './control-prompt.ts'

// Public surface for the harness/refine/compact machinery (consumers and
// tests construct stores and inspect routes independently of the bridge).
export { HarnessStore, HARNESS_KINDS, HARNESS_LIMITS, renderHarnessSection } from './harness-store.ts'
export type { HarnessApplyReport, HarnessEntry, HarnessKind, HarnessOp } from './harness-store.ts'
export { REFINE_MAX_TOKENS, REFINE_SYSTEM, buildRefineMessages, parseRefineAnswer, resolveRefineTarget } from './refine.ts'
export type { RefineTarget } from './refine.ts'
export type { DASHRCompactionResult, DASHRCompactionSurface, DASHRTokenMeterSurface } from './compaction-surface.ts'

/** Cordis plugin name. */
export const name = 'dsh-rlm-mode'

/**
 * Required services. `rlmRuntime` is NOT listed: see the module doc — the
 * mode-dependent wait is declared inside {@link apply} instead, and the
 * execution path re-reads the service at use time with an actionable error.
 */
export const inject = ['tools']

/** Plugin config. */
export interface Config extends RuntimeConfig {
  /**
   * Concurrency cap for one cell's overlapping sub-calls (default 10, the
   * native loop scheduler's own default). Sub-calls follow the registry's
   * native scheduling contract — only tools that classify concurrency-safe
   * overlap; exclusive calls form barriers — so `1` restores strictly serial
   * dispatch. Must be a positive integer.
   */
  maxParallelSubCalls?: number
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
  /**
   * The Context Recency Window (Feature 1): an absolute token ceiling for
   * the passive pressure compaction. When set, a `RecencyAwareCompactionEngine`
   * (a `BasicCompactionEngine` subclass) mounts under `ctx.isolate('compaction')`
   * with `auto: true` — its `agent/pre-step` check compacts whenever the
   * session's measured pressure exceeds this value, regardless of how much
   * headroom the model's own context window still has. The upstream
   * ratio threshold (0.8 × model window) stays active as a second,
   * independent trigger arm: whichever ceiling is lower fires first.
   * Requires `compactModel` in the full `'provider/model'` form (the
   * engine mounts before any agent exists to pair a bare model id) and an
   * absolute `retainTokens`. Must be a positive integer when set; absent =
   * upstream behavior only.
   */
  recencyWindowTokens?: number
  /**
   * The absolute post-compaction retained tail, in tokens, for the recency
   * engine (upstream's own `retainTokens` key passed through). Kept below
   * `recencyWindowTokens` — the invariant the engine machine-checks at
   * mount. Only meaningful with `recencyWindowTokens`; must be a positive
   * integer when set.
   */
  retainTokens?: number
}

/** Runtime schema. */
export const Config: z<Config> = z.intersect([
  DashrRuntime.Config,
  z.object({
    maxParallelSubCalls: z.natural().min(1).default(10),
    harnessDir: z.string(),
    refineModel: z.string(),
    compactModel: z.string(),
    recencyWindowTokens: z.natural().min(1),
    retainTokens: z.natural().min(1),
  }),
])

/**
 * The `dashr:harness` section order: the first section after the 100–199
 * tool-guidance band (upstream's stated convention), where the Continual
 * Harness renders as durable guidance the model reads after its tools.
 */
export const HARNESS_SECTION_ORDER = 200

/** The model-facing name of the DASHR cell transport. */
export const IPYTHON_NAME = 'ipython'

/**
 * The upstream delegation tool names masked from the model's surface
 * (ADR-0002: masking is presentation-only). These tools stay REGISTERED,
 * EXECUTABLE, and dispatchable, but they appear in NEITHER the Tool Catalog
 * text NOR the kernel binding names. The registry itself is never touched
 * (no `restrict()`, no disable patch). Seven of them are dispatched by the
 * `rlm`/`agent_message`/`agent_list`/`rlm_workflow`/`rlm_ralph` bridges
 * through the nested sub-dispatch pipeline with a parent token; `report`
 * (the child-scoped uplink tool the host's subagent-report package installs
 * into every continuable child) is covered by `agent_message({"receiver": "parent", ...})`,
 * which calls the same `ctx.subagents.reportFrom` service directly — the
 * model sees ONE dual-direction channel, never a separate report tool.
 */
export const MASKED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'subagent',
  'subagent_fork',
  'send_message',
  'list_agents',
  'interrupt_agent',
  'workflow',
  'ralph',
  'report',
])

/**
 * The ONLY renamed unmasked tool (plan Q8/Q13): the registry's `glob` binds
 * and renders as `file_glob`, because a bare `glob` global would shadow the
 * stdlib `glob` module in the kernel namespace. Every other unmasked tool
 * keeps its registered name.
 */
export const TOOL_NAME_RENAMES: ReadonlyMap<string, string> = new Map([['glob', 'file_glob']])

/**
 * The typed-rejection contract declared on EVERY flat tool namespace: a
 * failed tool call raises `ToolCallError` with `.toolName` set to the
 * binding global (= the tool name the model knows). Identical descriptors
 * may repeat across namespaces; the runtime materializes the class once.
 */
const TOOL_CALL_ERROR_CLASS: RlmBindingErrorClass = { name: 'ToolCallError', memberNameProperty: 'toolName' }

/** The `dashr:control-prompt` section order: the FIRST section in the 100–199 tool-guidance band, so the cell paradigm is taught before the Tool Catalog renders its signatures. */
export const CONTROL_SECTION_ORDER = 100

/** The `dashr:tool-catalog` section order: the 100–199 tool-guidance band's SDK position, matching upstream `tools:sdk`. */
export const SDK_SECTION_ORDER = 150

/**
 * The bridge tools rendered INTO the Tool Catalog as if they were
 * registry tools: each is a hand-written {@link DASHRSdkSchema} fed to the
 * SAME `renderToolsSdkPy` as the registry schemas, so the catalog shows one
 * flat `async def name(args: XArgs) -> Output` surface — no second calling
 * convention, no separate "bridge tools" block. The bridge enforces these
 * shapes per call (the bridge tools below); the schemas here are the
 * model-facing declaration only. Descriptions must stay truthful about
 * requiredness and semantics.
 */
const BRIDGE_TOOL_SCHEMAS: DASHRSdkSchema[] = [
  {
    name: 'rlm',
    description: 'Spawn, fork, or interrupt a sub-agent. mode selects the operation. Children run in the background by default (admission returns a durable subagent id and the child reports up when it settles as a wakeup notice); run_in_background=false blocks for the result.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: "'spawn' (fresh child), 'fork' (child seeded with this conversation's completed turns), or 'interrupt' (cancel an agent's current turn)." },
        prompt: { type: 'string', description: "The child's task. Required for 'spawn' and 'fork'." },
        label: { type: 'string', description: 'Short display label (defaults to subagent).' },
        run_in_background: { type: 'boolean', description: 'false blocks until the child settles; default runs in the background.' },
        agent_id: { type: 'string', description: "The running agent to cancel. Required for 'interrupt'." },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    output: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'agent_message',
    description: "The single agent-to-agent message channel, both directions: receiver 'child' delivers down to a child; receiver 'parent' reports up to this agent's parent (live continuable children only; a root agent gets a structured UNAUTHORIZED instead).",
    parameters: {
      type: 'object',
      properties: {
        receiver: { type: 'string', description: "'child' (deliver down) or 'parent' (report up)." },
        message: { type: 'string', description: 'The message text.' },
        subagent_id: { type: 'string', description: "The child's durable id (required when receiver is 'child')." },
      },
      required: ['receiver', 'message'],
      additionalProperties: false,
    },
    output: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'agent_list',
    description: "List sub-agents: scope 'children' (direct children, the default) or 'descendants' (the whole tree).",
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: "'children' or 'descendants'." },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'rlm_workflow',
    description: 'Run a JavaScript orchestration script over sub-agents.',
    parameters: {
      type: 'object',
      properties: {
        meta: { type: 'object', properties: {}, additionalProperties: true, description: 'The workflow meta identity block.' },
        script: { type: 'string', description: 'The JavaScript orchestration script.' },
      },
      required: ['meta', 'script'],
      additionalProperties: false,
    },
    output: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'rlm_ralph',
    description: 'Drive iterative fresh-agent rounds toward an objective.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'The objective to drive toward.' },
        max_rounds: { type: 'integer', description: 'Optional positive cap on rounds.' },
      },
      required: ['objective'],
      additionalProperties: false,
    },
    output: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'refine',
    description: 'Apply Continual Harness edits (add/update/delete durable notes, memories, skills).',
    parameters: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'The harness edit instruction.' },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
    output: { type: 'object', properties: {}, additionalProperties: true },
  },
  {
    name: 'compact',
    description: 'Check context usage and compact the conversation.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Optional reason for compacting.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { type: 'object', properties: {}, additionalProperties: true },
  },
]

/**
 * The `ipython` tool description the model sees: cell semantics — the
 * persistent kernel — stated up front, unlike upstream's one-shot
 * `PYTHON_FLAVOR` (blueprint §1.1: DASHR is channel ② state codification,
 * and the model's Code-Interpreter prior matches THIS contract).
 */
const IPYTHON_DESCRIPTION
  = 'Execute one Python cell on the persistent kernel. Takes two required '
    + 'arguments: `cell`, one Python program body (top-level `await` and `return` work; variables, '
    + 'imports, and definitions from earlier cells are still alive), and `description`, '
    + 'a short summary of what the cell does. Call tools as plain `await name(args)` '
    + 'functions per the declarations in the system prompt. Only what you print or '
    + 'return comes back — curate it.'

/** The `cell` parameter's model-facing description. */
const IPYTHON_CELL_PARAM_DESCRIPTION
  = 'The cell: one Python program body for the persistent kernel (top-level '
    + '`await` and `return` work).'

/**
 * The `description` parameter's model-facing description: the UI label
 * contract, ported verbatim in shape from upstream `run_code` (the label
 * surfaces on the generic card as the call's always-visible title).
 */
const IPYTHON_DESCRIPTION_PARAM_DESCRIPTION
  = 'Clear, concise description of what this cell does in active voice, '
    + '5-10 words (shown in the UI). Examples: "Load dataframe and summarize '
    + 'columns"; "Run test file and capture failures"; "Patch config key across '
    + 'cordis.yml files".'

/**
 * Thrown by `ipython` when the cell itself failed — a program exception, a
 * budget expiry, an abort, or kernel death. Extends {@link HarnessError} with
 * the same `code: 'CODE_RUN_FAILED'` as upstream `CodeRunFailedError`, so
 * registry-side error taxonomy and session-log consumers see the shape they
 * already know; the registry's execution pipeline converts it into a
 * structured `isError` result whose text carries the failure kind plus the
 * captured logs, so the model can self-correct.
 */
export class DASHRRunFailedError extends HarnessError {
  constructor(message: string) {
    super(message, 'CODE_RUN_FAILED')
    this.name = 'DASHRRunFailedError'
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

/**
 * Unwrap one bare-callable {@link parseRlmCall} packaging into the single
 * arguments object a registry dispatch expects. The kernel's callable
 * channel packages EVERY call as `{args, kwargs}`; a tool call — registry
 * tool or bridge tool alike — is exactly ONE positional arguments
 * object, mirroring the member-proxy unwrapping the pre-0.1.5
 * `tools.name(args)` form performed kernel-side. Keyword form and
 * multi-positional form reject (the rejection becomes ToolCallError, whose
 * member names the binding the model called).
 */
function flatToolArgs(rawArgs: unknown): unknown {
  const parsed = parseRlmCall(rawArgs)
  if (!parsed.ok) throw new Error(parsed.error)
  const { args: callArgs, kwargs } = parsed
  if (Object.keys(kwargs).length > 0) {
    throw new Error('tool bindings take one positional arguments object, not keyword arguments — call e.g. name({"field": 1})')
  }
  if (callArgs.length === 1) return callArgs[0]
  if (callArgs.length === 0) return null
  return callArgs
}

/**
 * Unwrap one bridge-tool {@link parseRlmCall} packaging into its single
 * arguments object. Same one-object contract as {@link flatToolArgs}, but
 * bridge tools return a structured `{ error }` value instead of throwing, and
 * a call with no arguments reads as an empty object (agent_list()/compact()
 * are all-optional). Keyword and multi-positional forms are rejected.
 */
function flatBridgeToolArgs(rawArgs: unknown): { ok: true, args: Record<string, unknown> } | { ok: false, error: string } {
  const parsed = parseRlmCall(rawArgs)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const { args: callArgs, kwargs } = parsed
  if (Object.keys(kwargs).length > 0) {
    return { ok: false, error: 'tools take one positional arguments object, not keyword arguments — call e.g. name({"field": value})' }
  }
  if (callArgs.length > 1) {
    return { ok: false, error: 'tools take exactly one positional arguments object — call e.g. name({"field": value})' }
  }
  const arg = callArgs[0]
  if (arg === undefined || arg === null) return { ok: true, args: {} }
  if (typeof arg !== 'object' || Array.isArray(arg)) {
    return { ok: false, error: 'tools take one positional arguments object, not a bare value — call e.g. name({"field": value})' }
  }
  return { ok: true, args: arg as Record<string, unknown> }
}

/** Resolve the ipython overlap cap at the config boundary (schemastery already validated the range; direct construction in tests bypasses it). */
export function resolveMaxParallelSubCalls(value: number | undefined): number {
  const maxParallelSubCalls = value ?? 10
  if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) {
    throw new Error('dsh-rlm-mode: maxParallelSubCalls must be a positive integer')
  }
  return maxParallelSubCalls
}

/**
 * Resolve the harness storage root at the config boundary. `undefined` is
 * the legitimate memory-only default; the empty string is a typo of "unset"
 * in a YAML row, not a directory any process should write to.
 */
export function resolveHarnessDir(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dsh-rlm-mode: harnessDir must be a non-empty string when set, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Resolve the refine() model tier at the config boundary (same empty-string rejection as {@link resolveHarnessDir}). */
export function resolveRefineModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dsh-rlm-mode: refineModel must be a non-empty string when set, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Resolve the compact() model tier at the config boundary (same empty-string rejection as {@link resolveHarnessDir}). */
export function resolveCompactModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dsh-rlm-mode: compactModel must be a non-empty string when set, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Resolve the Context Recency Window at the config boundary (positive integer or absent). */
export function resolveRecencyWindowTokens(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`dsh-rlm-mode: recencyWindowTokens must be a positive integer when set, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Resolve the recency engine's retained tail at the config boundary (positive integer or absent). */
export function resolveRetainTokens(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`dsh-rlm-mode: retainTokens must be a positive integer when set, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Two-space JSON presentation, matching the shallow `ipython` text contract (ported). */
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
        if (item === undefined) throw new Error('dsh-rlm-mode: cannot render a sparse JSON array')
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
      if (key === undefined) throw new Error('dsh-rlm-mode: cannot render a missing JSON object key')
      const item = current[key]
      if (item === undefined) throw new Error('dsh-rlm-mode: cannot render an undefined JSON object property')
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

/** Canonical value returned by the outer `ipython` transport. */
type RunCellOutput = { logs: string[]; result?: JsonValue }

/**
 * Capabilities the `ipython` bridge closes over, mirroring upstream's
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
   * composition has no subagent capability) for the agent_message()
   * receiver='parent' UPLINK alone — every downlink bridges the tool layer
   * instead (ADR-0001). Read at run time so a host-side provider mounted
   * later still becomes visible; absent means the uplink answers with a
   * structured "unavailable" error, never a crash.
   */
  requireSubagents?: () => DASHRSubagentsSurface | undefined
  /**
   * The Continual Harness store shared by every `ipython` call AND the
   * `dashr:harness` prompt section in this composition (M4-B): refine()
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
  requireCompaction?: () => DASHRCompactionSurface | undefined
  /**
   * Resolves the optional host-plane `ctx.tokenMeter` for compact()'s usage
   * probe (the "check usage" half of the PA semantics). Absent simply omits
   * the `context_tokens` field from the result.
   */
  requireTokenMeter?: () => DASHRTokenMeterSurface | undefined
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
  | { engine: DASHRCompactionSurface; target: RefineTarget }
  | { error: string }

/** The `ctx.llm` surface refine() streams through (the seam's streaming call alone). */
export interface LlmStreamSurface {
  /** Stream one model call as raw chunks; failures arrive as terminal `finish` chunks, not rejections. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Build the `ipython` {@link ToolDefinition}: required `cell` and
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
  const { requireRuntime, maxParallel, shapeDispatchLog, requireSubagents } = options
  const harness = options.harness ?? new HarnessStore()
  const refineModel = options.refineModel
  const compactModel = options.compactModel
  const requireLlm = options.requireLlm
  const requireCompaction = options.requireCompaction
  const requireTokenMeter = options.requireTokenMeter
  const scopedCompaction = options.compactModel !== undefined ? options.scopedCompaction : undefined
  return defineTool({
    name: IPYTHON_NAME,
    description: IPYTHON_DESCRIPTION,
    parameters: {
      cell: { type: 'string', required: true, description: IPYTHON_CELL_PARAM_DESCRIPTION },
      description: {
        type: 'string',
        required: true,
        description: IPYTHON_DESCRIPTION_PARAM_DESCRIPTION,
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
        return [{ type: 'text', text: parts.length > 0 ? parts.join('\n') : `(${IPYTHON_NAME} completed with no output)` }]
      },
    },
    async execute(args, exec): Promise<RunCellOutput> {
      if (args.description.trim().length === 0) {
        throw new Error('dsh-rlm-mode: invalid description: expected a non-empty string')
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
          throw new Error(`${IPYTHON_NAME} run is over (${String(runController.signal.reason)}); ${name} not dispatched`)
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
              reject(new Error(`${IPYTHON_NAME} run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`))
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
          throw new Error(`${IPYTHON_NAME} run is over (${String(runController.signal.reason)}); ${name} result discarded`)
        }
        // The kernel turns a binding rejection into ToolCallError and adds
        // only the binding name. Native content and internal error metadata
        // stay outside the program-facing failure contract.
        if (outcome.isError) throw new Error(outcome.message)
        return outcome.value
      }

      // FLAT per-tool binding namespaces (plan Q8): every bindable, unmasked
      // tool becomes its own top-level callable global — no `tools` holder,
      // no prefix. Masking is presentation-only (ADR-0002): the masked
      // upstream delegation names stay registered and executable but appear
      // in neither this binding surface nor the Tool Catalog — the bridges
      // below dispatch them internally through the SAME nested sub-dispatch
      // pipeline as any other tool. `glob` binds as `file_glob` (the one
      // rename, Q13). Names that cannot serve as flat globals (exotic,
      // reserved, underscore-leading — the policy shared with the renderer's
      // isFlatBindableName) are simply not bound; the catalog renders them
      // as not-callable comments. Enumerate the CALLING AGENT's visible set
      // (scoped tools join, restricted globals vanish) — the same view the
      // Tool Catalog declared, so a cell binds exactly what its prompt
      // promised; sub-dispatch re-resolves per call through the same view
      // (exec.agent threads down). A tool whose binding name collides with a
      // bridge tool or the error class fails the run loudly at the
      // runtime's duplicate-global validation — the contract-misuse channel.
      const toolNamespaces: RlmBindingNamespace[] = []
      for (const schema of registry.schemas(exec.agent)) {
        if (schema.name === IPYTHON_NAME) continue
        if (MASKED_TOOL_NAMES.has(schema.name)) continue
        const bindingName = TOOL_NAME_RENAMES.get(schema.name) ?? schema.name
        if (!isFlatBindableName(bindingName)) continue
        toolNamespaces.push({
          global: bindingName,
          // The dispatch target stays the REGISTERED name; only the global
          // the program calls is renamed. Identical errorClass descriptors
          // repeat across namespaces by design (single materialization).
          functions: { __call__: async (rawArgs: unknown) => binding(schema.name)(flatToolArgs(rawArgs)) },
          callable: true,
          errorClass: TOOL_CALL_ERROR_CLASS,
        })
      }

      // rlm() bare callable global (ADR-0001: bridge the TOOL layer): mode
      // dispatch over the registry's delegation tools, executed through the
      // nested sub-dispatch pipeline above — inheriting upstream policy
      // wholesale (approval, sandbox, maxDepth, per-instance config).
      // 'spawn'/'fork' → the subagent/subagent_fork tools (one-shot vs
      // continuable follows the tool layer's run_in_background parameter
      // plus its backgroundMode config); 'interrupt' → interrupt_agent.
      // The TOOL's own JSON output returns unchanged; a failed dispatch
      // rejects the binding, which the kernel materializes as ToolCallError
      // — the same contract as a direct flat tool call. Signature
      // validation errors are structured return values instead.
      const rlmCallable: RlmBindingFunction = async (rawArgs: unknown): Promise<RlmJsonValue> => {
        const parsed = flatBridgeToolArgs(rawArgs)
        if (!parsed.ok) return { error: parsed.error }
        const a = parsed.args
        const unknownKeys = Object.keys(a).filter(key => !['mode', 'prompt', 'label', 'run_in_background', 'agent_id'].includes(key))
        if (unknownKeys.length > 0) return { error: `rlm() got unexpected key(s): ${unknownKeys.join(', ')}` }
        const mode = a['mode']
        if (typeof mode !== 'string' || (mode !== 'spawn' && mode !== 'fork' && mode !== 'interrupt')) {
          return { error: "rlm() requires {\"mode\": \"spawn\" | \"fork\" | \"interrupt\", ...}" }
        }
        if (mode === 'interrupt') {
          const agentId = a['agent_id']
          if (typeof agentId !== 'string' || agentId.length === 0) {
            return { error: 'rlm() interrupt mode requires {"agent_id": "..."}' }
          }
          return await binding('interrupt_agent')({ agent_id: agentId })
        }
        const prompt = a['prompt']
        if (typeof prompt !== 'string') {
          return { error: `rlm() ${mode} mode requires {"prompt": "..."}` }
        }
        const label = a['label']
        if (label !== undefined && label !== null && typeof label !== 'string') {
          return { error: 'rlm() label must be a string or null' }
        }
        const runInBackground = a['run_in_background']
        if (runInBackground !== undefined && runInBackground !== null && typeof runInBackground !== 'boolean') {
          return { error: 'rlm() run_in_background must be a boolean or null' }
        }
        // The upstream tool's `description` is REQUIRED (a 3-5 word display
        // label): default it to 'subagent' when the caller gave none.
        return await binding(mode === 'spawn' ? 'subagent' : 'subagent_fork')({
          description: label ?? 'subagent',
          prompt,
          ...(runInBackground !== undefined && runInBackground !== null ? { run_in_background: runInBackground } : {}),
        })
      }

      // agent_message() bare callable global (plan Q25): one dual-use A2A
      // function. receiver='child' bridges the send_message TOOL downlink
      // (subagent_id required — the id a spawn call returned). receiver=
      // 'parent' bridges the SERVICE-layer reportFrom uplink — the only
      // direction no tool covers — with zero ids: the child (exec.agent) is
      // the authority credential and the service bootstraps the parent from
      // the child's own session header. delivery stays FIXED at 'wakeup'
      // (the upstream default; a scheduling policy, not model-facing). A
      // root caller fails the service's authorizeReporter with SubagentError
      // 'UNAUTHORIZED', surfaced here as a structured error value.
      const agentMessageCallable: RlmBindingFunction = async (rawArgs: unknown): Promise<RlmJsonValue> => {
        const parsed = flatBridgeToolArgs(rawArgs)
        if (!parsed.ok) return { error: parsed.error }
        const a = parsed.args
        const unknownKeys = Object.keys(a).filter(key => !['receiver', 'message', 'subagent_id'].includes(key))
        if (unknownKeys.length > 0) return { error: `agent_message() got unexpected key(s): ${unknownKeys.join(', ')}` }
        const receiver = a['receiver']
        const message = a['message']
        if (typeof receiver !== 'string' || typeof message !== 'string') {
          return { error: 'agent_message() requires {"receiver": "child" | "parent", "message": "..."}' }
        }
        if (receiver === 'child') {
          const subagentId = a['subagent_id']
          if (typeof subagentId !== 'string' || subagentId.length === 0) {
            return { error: 'agent_message() receiver "child" requires {"subagent_id": "..."} — the durable subagent id a spawn returned' }
          }
          return await binding('send_message')({ subagent_id: subagentId, message })
        }
        if (receiver === 'parent') {
          if (!exec.agent) {
            return { error: 'agent_message(receiver=\'parent\') requires an agent session (this run has no agent to report from)' }
          }
          const subagents = requireSubagents?.()
          if (!subagents) {
            return { error: "agent_message(receiver='parent') is unavailable: no ctx.subagents service is mounted in this composition" }
          }
          try {
            const messageId = await subagents.reportFrom(exec.agent, [{ type: 'text', text: message }], { delivery: 'wakeup', signal: exec.signal })
            return { delivered: true, message_id: messageId }
          } catch (error: unknown) {
            if ((error as { code?: unknown }).code === 'UNAUTHORIZED') {
              return { error: `agent_message(receiver='parent') rejected: only a live continuable child agent can report to its parent (a root agent has none) — ${error instanceof Error ? error.message : String(error)}` }
            }
            return { error: `agent_message(receiver='parent') failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        }
        return { error: `agent_message() unknown receiver ${JSON.stringify(receiver)}: expected 'child' or 'parent'` }
      }

      // agent_list() bare callable global: the list_agents tool bridge
      // (scope 'children' = direct children, 'descendants' = the whole tree).
      const agentListCallable: RlmBindingFunction = async (rawArgs: unknown): Promise<RlmJsonValue> => {
        const parsed = flatBridgeToolArgs(rawArgs)
        if (!parsed.ok) return { error: parsed.error }
        const a = parsed.args
        const unknownKeys = Object.keys(a).filter(key => key !== 'scope')
        if (unknownKeys.length > 0) return { error: `agent_list() got unexpected key(s): ${unknownKeys.join(', ')}` }
        const scope = (a['scope'] ?? 'children') as string
        if (scope !== 'children' && scope !== 'descendants') {
          return { error: `agent_list() scope must be 'children' or 'descendants', got ${JSON.stringify(scope)}` }
        }
        return await binding('list_agents')({ scope })
      }

      // rlm_workflow() bare callable global: the workflow tool bridge —
      // a JavaScript orchestration script plus its meta identity block.
      const rlmWorkflowCallable: RlmBindingFunction = async (rawArgs: unknown): Promise<RlmJsonValue> => {
        const parsed = flatBridgeToolArgs(rawArgs)
        if (!parsed.ok) return { error: parsed.error }
        const a = parsed.args
        const unknownKeys = Object.keys(a).filter(key => !['meta', 'script'].includes(key))
        if (unknownKeys.length > 0) return { error: `rlm_workflow() got unexpected key(s): ${unknownKeys.join(', ')}` }
        const meta = a['meta']
        const script = a['script']
        if (typeof meta !== 'object' || meta === null || Array.isArray(meta) || typeof script !== 'string') {
          return { error: 'rlm_workflow() requires {"meta": {...}, "script": "..."}' }
        }
        return await binding('workflow')({ meta, script })
      }

      // rlm_ralph() bare callable global: the ralph tool bridge (fresh-agent
      // iterative rounds). kwargs map 1:1 onto the tool's own optional
      // fields; None means "omit the key" (the tool's configured default).
      const rlmRalphCallable: RlmBindingFunction = async (rawArgs: unknown): Promise<RlmJsonValue> => {
        const parsed = flatBridgeToolArgs(rawArgs)
        if (!parsed.ok) return { error: parsed.error }
        const a = parsed.args
        const unknownKeys = Object.keys(a).filter(key => !['objective', 'max_rounds'].includes(key))
        if (unknownKeys.length > 0) return { error: `rlm_ralph() got unexpected key(s): ${unknownKeys.join(', ')}` }
        const objective = a['objective']
        if (typeof objective !== 'string') return { error: 'rlm_ralph() requires {"objective": "..."}' }
        const maxRounds = a['max_rounds']
        if (maxRounds !== undefined && maxRounds !== null
          && (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1)) {
          return { error: 'rlm_ralph() max_rounds must be a positive integer or null' }
        }
        return await binding('ralph')({
          objective,
          ...(maxRounds !== undefined && maxRounds !== null ? { maxRounds } : {}),
        })
      }

      // refine() bare callable global (M4-B, blueprint §6): one in-cell
      // instruction → one hand-built auxiliary LLM call → Continual Harness
      // ops. Awaiting it inside the cell blocks that cell until the call
      // settles (under the kernel run's own wall budget); the NEXT system
      // prompt assembly re-renders the harness from the store, so the edit
      // is visible to the next model request — prompt-as-variable. Errors are
      // structured JSON fields; a parse failure leaves the store untouched.
      const refineCallable: RlmBindingFunction = async (rawArgs: unknown): Promise<RlmJsonValue> => {
        const parsed = flatBridgeToolArgs(rawArgs)
        if (!parsed.ok) return { error: parsed.error }
        const unknownKeys = Object.keys(parsed.args).filter(key => key !== 'instruction')
        if (unknownKeys.length > 0) return { error: `refine() got unexpected key(s): ${unknownKeys.join(', ')}` }
        const instruction = parsed.args['instruction']
        if (typeof instruction !== 'string' || instruction.trim().length === 0) {
          return { error: 'refine() requires {"instruction": "..."} (a non-empty string)' }
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
        const parsed = flatBridgeToolArgs(rawArgs)
        if (!parsed.ok) return { error: parsed.error }
        const unknownKeys = Object.keys(parsed.args).filter(key => key !== 'reason')
        if (unknownKeys.length > 0) return { error: `compact() got unexpected key(s): ${unknownKeys.join(', ')}` }
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
        let engine: DASHRCompactionSurface | undefined
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
        const summarize = (path: 'compact-now' | 'pressure', outcome: DASHRCompactionResult | null): RlmJsonValue => {
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
            program: args.cell,
            bindings: [
              ...toolNamespaces,
              {
                global: 'rlm',
                functions: { __call__: rlmCallable },
                callable: true,
                errorClass: TOOL_CALL_ERROR_CLASS,
              },
              {
                global: 'agent_message',
                functions: { __call__: agentMessageCallable },
                callable: true,
                errorClass: TOOL_CALL_ERROR_CLASS,
              },
              {
                global: 'agent_list',
                functions: { __call__: agentListCallable },
                callable: true,
                errorClass: TOOL_CALL_ERROR_CLASS,
              },
              {
                global: 'rlm_workflow',
                functions: { __call__: rlmWorkflowCallable },
                callable: true,
                errorClass: TOOL_CALL_ERROR_CLASS,
              },
              {
                global: 'rlm_ralph',
                functions: { __call__: rlmRalphCallable },
                callable: true,
                errorClass: TOOL_CALL_ERROR_CLASS,
              },
              {
                global: 'refine',
                functions: { __call__: refineCallable },
                callable: true,
                errorClass: TOOL_CALL_ERROR_CLASS,
              },
              {
                global: 'compact',
                functions: { __call__: compactCallable },
                callable: true,
                errorClass: TOOL_CALL_ERROR_CLASS,
              },
            ],
            signal: runController.signal,
            // Session identity for kernel-per-session keying: the calling
            // agent's id (a session id). An agentless call leaves it absent
            // and lands on the runtime's shared default key.
            ...exec.agent ? { principal: exec.agent.id } : {},
            // The kernel's working directory = the session's workspace. The
            // presentation layer is the per-session surface: it already holds
            // `exec.agent` (the calling Agent), so it reads the same source
            // the upstream `{{cwd}}` prompt variable reads and threads it down
            // to the kernel spawn. An agentless call leaves it absent → the
            // kernel inherits the daemon's cwd (the pre-fix leak, retained
            // only for the no-session edge).
            ...exec.agent ? { cwd: exec.agent.session.header.cwd } : {},
          })
        } finally {
          // Abort sub-dispatches and drain every in-flight dispatch before
          // closing the turn (queued-unstarted ones are abandoned unlogged).
          // Binding failures remain observable through their individual promises.
          runController.abort(`${IPYTHON_NAME} settled`)
          await drainDispatches()
        }

        if (result.error) {
          const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join('\n')}` : ''
          throw new DASHRRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`)
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
      rawInput: args.cell,
    }),
    // Deliberately no presentResult: the generic card fallback keeps this
    // title and reads durable result content without duplicating a large raw
    // result into the host view payload.
  })
}

/**
 * Collect one calling scope's Tool Catalog schemas through the registry's
 * public projection APIs: `schemas(scope)` for the model-facing view (scoped
 * tools join, restrictions apply), `get(name, scope)` for the canonical
 * output schema, snapshotted so a live definition cannot mutate under the
 * render. `ipython` itself is excluded — it is the transport, not a
 * binding. Masked names are excluded HERE (ADR-0002: the catalog text is
 * one of the two presentation points DASHR owns; the registry is never
 * touched), and `glob` is renamed to `file_glob` (the single rename, Q13)
 * so the catalog teaches exactly the name the kernel binds.
 */
export function collectSdkSchemas(registry: ToolRuntime, scope?: ScopeKey): DASHRSdkSchema[] {
  const collected: DASHRSdkSchema[] = []
  for (const schema of registry.schemas(scope)) {
    if (schema.name === IPYTHON_NAME) continue
    if (MASKED_TOOL_NAMES.has(schema.name)) continue
    const definition = registry.get(schema.name, scope)
    if (definition === undefined) continue
    const output = snapshotJsonValue(definition.output.schema) as JsonSchemaNode | undefined
    if (output === undefined) continue
    collected.push({ name: TOOL_NAME_RENAMES.get(schema.name) ?? schema.name, description: schema.description, parameters: schema.parameters, output })
  }
  return collected
}

/**
 * Declare the DASHR cell presentation for every agent this composition
 * covers: the `ipython` transport tool, the `dashr:tool-catalog` prompt
 * section, the model-direct collapse guard, and the assembly filter that
 * leaves `ipython` the only contributed tool schema.
 *
 * Mount through a preset's standing scope (`agent.cordis.yml` include row);
 * mounting unscoped is legal for a whole-process DASHR deployment and gives
 * the same shape at the global layer.
 * @param ctx - the mounting composition's context (a preset's standing scope).
 * @param config - the plugin config.
 */
/** The runtime slice's config keys, mirrored from `DashrRuntime.Config` in `./runtime.ts`. */
const RUNTIME_CONFIG_KEYS = [
  'python', 'cwd', 'startupTimeoutMs', 'runTimeoutMs', 'interruptGraceMs',
  'interruptConfirmMs', 'disposeTimeoutMs', 'snapshotTimeoutMs',
  'maxOutputBytes', 'snapshotDir', 'snapshotSizeCapBytes', 'username',
] as const
/** The runtime slice of the merged config — the keys `DashrRuntime` owns. */
function pickRuntimeConfig(config: Config): RuntimeConfig {
  const out: Record<string, unknown> = {}
  for (const key of RUNTIME_CONFIG_KEYS) out[key] = (config as Record<string, unknown>)[key]
  return out as RuntimeConfig
}

export function apply(ctx: Context, config: Config): void {
  // Mount the stateful kernel runtime FIRST: it provides `ctx.rlmRuntime` in
  // this row's scope (the preset's entry-local `rlmRuntime` realm), which the
  // presentation inject below resolves. Both halves were separate plugin rows
  // before the merge; one row now owns the whole lifecycle.
  ctx.plugin(DashrRuntime, pickRuntimeConfig(config))
  const logger = ctx.logger('dsh-rlm-mode')
  const maxParallel = resolveMaxParallelSubCalls(config.maxParallelSubCalls)
  const harnessDir = resolveHarnessDir(config.harnessDir)
  const refineModel = resolveRefineModel(config.refineModel)
  const compactModel = resolveCompactModel(config.compactModel)
  const recencyWindowTokens = resolveRecencyWindowTokens(config.recencyWindowTokens)
  const retainTokens = resolveRetainTokens(config.retainTokens)
  // The recency engine mounts EAGERLY (its pre-step listener must exist
  // before any session runs), so its summarizer route cannot pair a bare
  // model id with "the first calling agent" — the full form is required,
  // and the engine's selector needs an absolute tail to price.
  if (recencyWindowTokens !== undefined) {
    if (compactModel === undefined) {
      throw new Error('dsh-rlm-mode: recencyWindowTokens requires compactModel — the recency engine summarizes with it and mounts before any agent exists to inherit a route from')
    }
    if (!compactModel.includes('/')) {
      throw new Error(`dsh-rlm-mode: recencyWindowTokens requires the full "provider/model" compactModel form (bare model ids pair with the first calling agent, which does not exist at eager mount); got ${JSON.stringify(compactModel)}`)
    }
    if (retainTokens === undefined) {
      throw new Error('dsh-rlm-mode: recencyWindowTokens requires retainTokens — the recency selector prices a concrete post-compaction tail')
    }
  }

  // The wait is the loud failure: a preset row still pending on `rlmRuntime`
  // is what the preset mount audit reports as an unusable row, naming this
  // plugin. Use-time reads below stay authoritative at execution.
  ctx.inject(['rlmRuntime'], (runtimeCtx: Context) => {
    const requireRuntime = (): RlmRuntimeSurface => {
      // Structural read (see runtime-surface.ts): the Context merge the
      // sibling runtime package declares is deliberately not imported here.
      const runtime = runtimeCtx.get('rlmRuntime') as RlmRuntimeSurface | undefined
      if (!runtime) {
        throw new Error('dsh-rlm-mode: ipython requires an rlmRuntime service — load a ctx.rlmRuntime implementation in this composition (dsh-rlm-mode mounts one at apply)')
      }
      if (runtime.language !== 'python') {
        throw new Error(`dsh-rlm-mode: no cell SDK for runtime language ${JSON.stringify(runtime.language)} (dsh-rlm-mode presents Python only; got a ${JSON.stringify(runtime.language)} runtime under ctx.rlmRuntime)`)
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
      throw new Error('dsh-rlm-mode: ctx.systemPrompt is required beside ctx.tools (the tools service itself depends on it) — this composition mounted tools without a system prompt registry')
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
        logger.warn(`dsh-rlm-mode: code-dispatch-log listener failed for ${dispatch.name}: ${error instanceof Error ? error.message : String(error)}; logging the original settled content`)
        return dispatch.content
      }
    }

    // The Continual Harness store (M4-B), shared by every ipython call AND
    // the dashr:harness prompt section in this composition. `agent/disposed`
    // drops one agent's in-memory cache only — with a harnessDir configured
    // the FILE persists by design, so the agent's next session restores its
    // entries (that is what "continual" means here).
    const harness = new HarnessStore(harnessDir)

    // Child lifecycle is the harness's job (plan Q16): no live-run registry
    // here anymore — the tool layer owns admission and the parent's teardown
    // drains continuable descendants. The per-session cleanup that remains
    // is the harness store's in-memory cache (files persist by design).
    runtimeCtx.events.on('agent/disposed', (payload: unknown) => {
      const principal = (payload as { agent?: { id?: unknown } } | null)?.agent?.id
      if (typeof principal === 'string' && principal.length > 0) {
        harness.drop(principal)
      }
    })

    // The compactModel tier's DASHR-scoped engine (design A), and Feature 1's
    // Context Recency Window engine: an isolation-labelled child context —
    // `ctx.isolate('compaction')` — so the provide can never collide with a
    // host-level engine (cordis keys service registration by isolation
    // label; a same-label provide throws), and the scoped instance never
    // resolves outside this composition. Both share ONE engineScope and ONE
    // mount promise: the recency engine mounts EAGERLY (its pre-step
    // listener must exist before any session runs), and the design-A lazy
    // path reuses it when it is already there.
    //
    // Engine choice:
    //  - `recencyWindowTokens` set → `RecencyAwareCompactionEngine` with
    //    `auto: true` + the absolute `retainTokens` tail. Its pre-step check
    //    adds the recency arm to the host engine's own ratio arm; the first
    //    compaction drops the measurement under both thresholds, so the
    //    host engine's listener no-ops — the min() semantics fall out of
    //    the two sequential checks, no coordination needed.
    //  - design A only → upstream `BasicCompactionEngine` with `auto: false`
    //    (the host engine keeps the automatic listeners; the scoped engine
    //    serves explicit compact() calls), mounted lazily on the FIRST
    //    compact() call because the bare-model form needs a provider then
    //    (the first calling agent's).
    // Both branches keep the optional peer unloaded until needed: the
    // recency engine lives in its own module that is only dynamically
    // imported here.
    const engineScope = runtimeCtx.isolate('compaction')
    let engineMount: Promise<ScopedCompactionOutcome> | undefined
    // The eager recency mount (validated above: full provider/model form).
    if (recencyWindowTokens !== undefined && compactModel !== undefined && retainTokens !== undefined) {
      const slash = compactModel.indexOf('/')
      const provider = compactModel.slice(0, slash)
      const model = compactModel.slice(slash + 1)
      engineMount = (async (): Promise<ScopedCompactionOutcome> => {
        try {
          const { RecencyAwareCompactionEngine } = await import('./compaction/recency-engine.js')
          const fiber = engineScope.plugin(RecencyAwareCompactionEngine, {
            summarizationProvider: provider,
            summarizationModel: model,
            retainTokens,
            recencyWindowTokens,
            auto: true,
          })
          await fiber
          const engine = engineScope.get('compaction') as DASHRCompactionSurface | undefined
          if (engine === undefined) {
            return { error: 'recencyWindowTokens is set but the recency engine did not become available: the host composition must provide llm, tokenMeter, and sessions for it to load' }
          }
          logger.info('dsh-rlm-mode: recency engine mounted (ceiling %d tokens, tail %d tokens, summarizer %s/%s)', recencyWindowTokens, retainTokens, provider, model)
          return { engine, target: { provider, model } }
        } catch (error: unknown) {
          return { error: `recencyWindowTokens is set but the recency engine could not be mounted: ${error instanceof Error ? error.message : String(error)} (is the optional peer @deepseek-ai/dsh-compaction-basic installed next to dsh-rlm-mode?)` }
        }
      })().then((outcome) => {
        if ('error' in outcome) logger.warn(outcome.error)
        return outcome
      })
    }
    const scopedCompaction = compactModel === undefined ? undefined : (() => {
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
        engineMount ??= (async (): Promise<ScopedCompactionOutcome> => {
          // The eager recency mount may have completed between checks.
          const existing = engineScope.get('compaction') as DASHRCompactionSurface | undefined
          if (existing !== undefined) {
            return { engine: existing, target: { provider, model } }
          }
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
            const engine = engineScope.get('compaction') as DASHRCompactionSurface | undefined
            if (engine === undefined) {
              return { error: 'compactModel is set but the DASHR-scoped compaction engine did not become available: the host composition must provide llm, tokenMeter, and sessions for it to load' }
            }
            return { engine, target: { provider, model } }
          } catch (error: unknown) {
            return { error: `compactModel is set but the DASHR-scoped compaction engine could not be mounted: ${error instanceof Error ? error.message : String(error)} (is the optional peer @deepseek-ai/dsh-compaction-basic installed next to dsh-rlm-mode?)` }
          }
        })()
        return engineMount
      }
    })()

    // ① The transport tool, an ordinary scoped registration (module doc
    // records the reservation delta). Registered through the injected
    // runtime context so the tool's lifetime follows the runtime service's.
    const requireSubagents = (): DASHRSubagentsSurface | undefined => runtimeCtx.get('subagents')
    const requireLlm = (): LlmStreamSurface | undefined => runtimeCtx.get('llm') as LlmStreamSurface | undefined
    const requireCompaction = (): DASHRCompactionSurface | undefined => runtimeCtx.get('compaction') as DASHRCompactionSurface | undefined
    const requireTokenMeter = (): DASHRTokenMeterSurface | undefined => runtimeCtx.get('tokenMeter') as DASHRTokenMeterSurface | undefined
    runtimeCtx.tools.register(createRunCellTool(registry, { requireRuntime, maxParallel, shapeDispatchLog, requireSubagents, harness, refineModel, compactModel, requireLlm, requireCompaction, requireTokenMeter, scopedCompaction }))

    // ①′ The Control Prompt section (plan Q3): static, scope-independent
    // text teaching the cell paradigm BEFORE the Tool Catalog renders its
    // signatures (order 100 < 150) — the single entry + guard contract, the
    // flat-binding paradigm, the delegation foreground/background
    // semantics, and flat examples. The same text serves the root and every
    // child (children inherit this composition), so it renders as a constant.
    systemPrompt.section({
      name: 'dashr:control-prompt',
      order: CONTROL_SECTION_ORDER,
      text: DASHR_CONTROL_PROMPT,
    })

    // ② The Tool Catalog prompt section (plan Q4/Q7; the pre-0.1.5 name
    // was `tools:dashr-sdk`), regenerated from the CALLING scope's visible tools at
    // assembly time (the same scope-aware shape as upstream's sdkSection:
    // an assembly for a different scope renders its own view, never ours).
    // The bridge tools are fed into the SAME renderer as registry tools
    // (BRIDGE_TOOL_SCHEMAS), so the catalog is one flat surface: every tool —
    // registry tool or bridge tool — is `await name(args)`.
    systemPrompt.section({
      name: 'dashr:tool-catalog',
      order: SDK_SECTION_ORDER,
      text: context => renderToolsSdkPy([...collectSdkSchemas(registry, context.scope), ...BRIDGE_TOOL_SCHEMAS]),
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
      name: 'dashr:harness',
      order: HARNESS_SECTION_ORDER,
      text: context => renderHarnessSection(harness.list(String(context.agent?.id ?? ''))),
    })

    // ③ Schema collapse: keep only ipython in the tools the model may call
    // directly, and drop the masked `report` tool's child-scoped guidance
    // section. The assembly waterfall's returned value is authoritative
    // (dsh-tools README), and this listener is scoped to the mounting
    // composition — an assembly for any other scope never reaches it, so a
    // PTC preset in the same process keeps its full native schema set.
    runtimeCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return {
        ...assembly,
        tools: assembly.tools.filter(tool => tool.name === IPYTHON_NAME),
        // `tool:report` is the upstream report tool's own guidance, installed
        // into every continuable child by the host's subagent-report package.
        // agent_message({"receiver": "parent"}) covers that uplink and the tool itself
        // is masked above, so the section would otherwise instruct a child to
        // call a function it can no longer reach.
        sections: assembly.sections.filter(section => section.name !== 'tool:report'),
      }
    }, { prepend: true })

    // ④ Model-direct collapse guard: with the schema surface collapsed to
    // ipython, a model-direct call naming anything else must fail with the
    // route back into a cell — a bare "unknown tool" for a tool the SDK just
    // declared would read as a broken deployment. Nested sub-dispatches (a
    // `parent` token set — exactly what the bridge above mints) and
    // ipython itself pass.
    runtimeCtx.tools.guard(exec => {
      if (exec.parent === undefined && exec.name !== IPYTHON_NAME) {
        return `only \`${IPYTHON_NAME}\` is callable directly — call \`${exec.name}\` from inside an \`${IPYTHON_NAME}\` cell instead`
      }
      return undefined
    })
  })
}

export default { name, inject, Config, apply }

export { DashrRuntime, RLMRuntime } from './runtime.ts'
export type { Config as RuntimeConfig } from './runtime.ts'
