/**
 * The refine() machinery (M4-B, blueprint §6): one hand-built auxiliary LLM
 * call that turns an in-cell instruction into Continual Harness operations.
 *
 * The call is deliberately NOT `markAgentLoopRequest`-marked: that identity
 * belongs to loop-built requests whose content is a pure function of the
 * session log, while this one-shot is plugin-authored (the same standing
 * distinction the `llm/stream` waterfall contract draws). It resolves its own
 * route — the `refineModel` config tier or the agent's own provider/model —
 * and its answer is parsed under a strict all-or-nothing op schema: anything
 * unparseable leaves the store untouched and surfaces as a structured cell
 * error, never a half-applied prompt mutation.
 * @module dashr-tool-presentation/refine
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HARNESS_LIMITS } from './harness-store.ts'
import type { HarnessEntry, HarnessKind, HarnessOp } from './harness-store.ts'
import { HARNESS_KINDS } from './harness-store.ts'

/** Generation cap for the one-shot refine call (reasoning-capable models spend headroom before the JSON). */
export const REFINE_MAX_TOKENS = 4096

/** A resolved provider/model route for the refine call. */
export interface RefineTarget {
  provider: string
  model: string
}

/**
 * Resolve the refine call's route. `refineModel` accepts a `provider/model`
 * selector or a bare model id (the bare form pairs with the calling agent's
 * own provider — the same fallback philosophy `rlm()`'s model kwarg and the
 * subagent tier inherit through). Unset falls back to the agent's own
 * provider+model entirely: refinement writes DURABLE prompt state, so the
 * composition's default is "the agent summarizes for itself".
 * @returns the route, or an error string when no route can be named.
 */
export function resolveRefineTarget(configured: string | undefined, agent: Agent): RefineTarget | { error: string } {
  const provider = stringOption(agent, 'provider')
  const model = stringOption(agent, 'model')
  if (configured === undefined) {
    if (provider === undefined || model === undefined) {
      return { error: 'refine() has no model route: set refineModel (provider/model or a bare model id), or give the agent provider+model options' }
    }
    return { provider, model }
  }
  const slash = configured.indexOf('/')
  if (slash >= 0) {
    const provider = configured.slice(0, slash)
    const model = configured.slice(slash + 1)
    if (provider.length === 0 || model.length === 0) {
      return { error: `refineModel ${JSON.stringify(configured)} has an empty provider or model half; use the full "provider/model" form` }
    }
    return { provider, model }
  }
  if (provider === undefined) {
    return { error: `refineModel ${JSON.stringify(configured)} is a bare model id and this agent has no provider to pair it with; use the "provider/model" form or configure the agent's provider` }
  }
  return { provider, model: configured }
}

/** Read one non-empty string field off the agent's route options, tolerating structural agents. */
function stringOption(agent: Agent, key: 'provider' | 'model'): string | undefined {
  const value = (agent.options as { provider?: unknown, model?: unknown } | undefined)?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The refinement directive: the op schema and the answer contract the aux model sees. */
export const REFINE_SYSTEM = [
  'You are the refinement engine of a DASHR agent\'s Continual Harness — the durable notes, memories, and skills that are carried into that agent\'s every future system prompt.',
  'You receive the agent\'s current harness entries and one instruction the agent issued from inside a code cell. Emit the minimal durable edits the instruction justifies.',
  '',
  'Answer with ONLY a JSON array of operation objects — no prose, no code fence:',
  '[{"op":"add","kind":"memory","title":"...","content":"..."}',
  ' {"op":"update","id":"memory-1","title":"...","content":"..."}',
  ' {"op":"delete","id":"note-2"}]',
  '',
  'Kinds: "memory" = durable facts, preferences, decisions; "note" = behavioral addenda for future sessions; "skill" = pointers to reusable procedures.',
  'Rules: "add" needs kind, title, and content; "update" patches the title and/or content of one existing id; "delete" removes one existing id; emit [] when the instruction justifies no durable change. Keep titles plain and specific; keep content self-contained plain text.',
].join('\n')

/** Build the one-shot user message: the full current harness (the model refines against ground truth) plus the instruction. */
export function buildRefineMessages(entries: readonly HarnessEntry[], instruction: string): Message[] {
  const dump = entries.length === 0
    ? '[]'
    : JSON.stringify(entries.map(({ id, kind, title, content }) => ({ id, kind, title, content })), null, 2)
  return [createUserMessage({
    content: [{
      type: 'text',
      text: `Current harness entries:\n${dump}\n\nInstruction:\n${instruction}`,
    }],
    source: { kind: 'plugin', plugin: 'dashr-tool-presentation' },
  })]
}

/** Extract the ops array from the aux model's answer, tolerating fences and surrounding prose. */
function extractJsonArray(text: string): unknown[] | undefined {
  const candidates: string[] = [text.trim()]
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text.trim())
  if (fenced !== null) candidates.push(fenced[1]!.trim())
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Try the next candidate shape.
    }
  }
  return undefined
}

/**
 * Validate a parsed ops array against the op schema. Throws a descriptive
 * error naming the offending index — refine() converts that into a
 * structured cell error with the store untouched (all-or-nothing).
 * @param raw - the parsed JSON array.
 * @returns the typed operations, in submission order.
 */
export function validateRefineOps(raw: unknown[]): HarnessOp[] {
  return raw.map((item, index) => {
    const name = `refine op #${index + 1}`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${name}: expected an object, got ${JSON.stringify(item)?.slice(0, 80)}`)
    }
    const record = item as Record<string, unknown>
    if (record['op'] === 'add') {
      const kind = record['kind']
      if (typeof kind !== 'string' || !(HARNESS_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`${name}: add needs kind one of ${HARNESS_KINDS.join('|')}`)
      }
      const title = boundedString(record['title'], 'title', name, HARNESS_LIMITS.maxTitleChars)
      const content = boundedString(record['content'], 'content', name, HARNESS_LIMITS.maxContentChars)
      return { op: 'add', kind: kind as HarnessKind, title, content }
    }
    if (record['op'] === 'update') {
      const id = idString(record['id'], name)
      const hasTitle = Object.hasOwn(record, 'title')
      const hasContent = Object.hasOwn(record, 'content')
      if (!hasTitle && !hasContent) throw new Error(`${name}: update needs at least one of title/content`)
      return {
        op: 'update',
        id,
        ...hasTitle ? { title: boundedString(record['title'], 'title', name, HARNESS_LIMITS.maxTitleChars) } : {},
        ...hasContent ? { content: boundedString(record['content'], 'content', name, HARNESS_LIMITS.maxContentChars) } : {},
      }
    }
    if (record['op'] === 'delete') {
      return { op: 'delete', id: idString(record['id'], name) }
    }
    throw new Error(`${name}: unknown op ${JSON.stringify(record['op'])}`)
  })
}

/** Parse + validate the model answer in one step; undefined means "no JSON array found". */
export function parseRefineAnswer(text: string): HarnessOp[] | undefined {
  const raw = extractJsonArray(text)
  if (raw === undefined) return undefined
  return validateRefineOps(raw)
}

/** Require a non-empty bounded string field. */
function boundedString(value: unknown, field: string, name: string, cap: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name}: ${field} must be a non-empty string`)
  }
  if (value.length > cap) {
    throw new Error(`${name}: ${field} exceeds the ${cap}-character harness cap (${value.length})`)
  }
  return value
}

/** Require a non-empty id field. */
function idString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name}: id must be a non-empty string`)
  }
  return value
}
