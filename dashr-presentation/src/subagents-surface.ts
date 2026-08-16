/**
 * The `ctx.subagents` seam surface, as this presentation plugin consumes it —
 * a STRUCTURAL mirror of the host-plane `@deepseek-ai/dsh-subagent` Service
 * Definition (0.1.0-rc.6), which is deliberately NOT in this package's
 * dependency graph: subagents is a host-plane root-realm singleton (the
 * preset delegates its registration to the host composition), and importing
 * the package here would pull a host-plane capability into an agent-plane
 * plugin for typing alone. The rlm() bridge reads it with the untyped
 * `ctx.get('subagents')` escape hatch (the same optional-capability pattern
 * upstream's child-agent.ts uses for `agentPresets`/`sandboxPolicy`), and
 * this file only types the few operations the bridge actually calls.
 *
 * Realm note (M3-B, blueprint §9): this row lives inside the preset's
 * entry-local `isolate: { rlmRuntime: true }` realm. An inner realm resolves
 * outer (root) services for names it does NOT isolate — verified against
 * cordis 4.0.1 `reflect.ts`/`context.ts` and with a live probe — so
 * `ctx.get('subagents')` reaches the root singleton from here, while the
 * realm-private `rlmRuntime` never leaks OUT to the root. The rlm() host
 * callback therefore lives in THIS presentation layer: it is the one place
 * that can simultaneously reach `ctx.subagents` (outward), the parent
 * `Agent` (`exec.agent`), and the run's abort signal.
 * @module dashr-tool-presentation/subagents-surface
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Provider name the rlm() bridge starts: the in-process spawn backend (blueprint §9, M3-B). */
export const RLM_PROVIDER = 'spawn'

/** Why a subagent run ended (the known cases; unknown variants pass through as strings). */
export type DasherSubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | (string & {})

/** The terminal outcome of one subagent run. */
export interface DasherSubagentResult {
  /** The child's final assistant content. */
  output: ContentBlock[]
  /** A provider-validated structured capture, when an output schema was requested. */
  structured?: unknown
  /** Why the run ended. */
  stopReason: DasherSubagentStopReason
}

/** A published one-shot subagent run handle. */
export interface DasherSubagentRun {
  /** Parent-scoped run id (the in-process backend's child session id). */
  id: string
  /** The exact published in-process child, when local. */
  localAgent: Agent | undefined
  /** Settles with the terminal result; rejects only on an infrastructure fault. */
  result: Promise<DasherSubagentResult>
  /** Cancel remaining work and release resources (idempotent). */
  dispose(): Promise<void>
}

/** The subset of `SubagentStartRequest` the rlm() bridge constructs. */
export interface DasherSubagentStartRequest {
  label?: string
  prompt: ContentBlock[]
  parent: Agent
  signal: AbortSignal
}

/** The `ctx.subagents` service surface the rlm() bridge calls. */
export interface DasherSubagentsSurface {
  start(name: string, request: DasherSubagentStartRequest): Promise<DasherSubagentRun>
}

/**
 * The `output: str` text of a subagent result: every text block in order,
 * with non-text blocks folded to a compact marker so a child that ended on a
 * tool call still produces a readable answer.
 */
export function extractTextFromBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(block.text)
    } else if (block.type === 'reasoning') {
      parts.push(`[reasoning] ${block.text}`)
    } else if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name} ${block.arguments}]`)
    } else if (block.type === 'tool-result') {
      parts.push('[tool-result]')
    } else {
      // 'image' and any merge-extended block type.
      parts.push(`[${String(block.type)}]`)
    }
  }
  return parts.join('\n')
}
