/**
 * The `ctx.compaction` / `ctx.tokenMeter` seam surfaces, as the compact()
 * binding consumes them — STRUCTURAL MIRRORS (the same standing rule as
 * `subagents-surface.ts`): `@deepseek-ai/dsh-compaction` is deliberately NOT
 * a dependency of this package. The host-plane engine (typically
 * `dsh-compaction-basic`, a deployment choice the Dasher preset documents as
 * host-owned) is read with the untyped `ctx.get('compaction')` escape hatch,
 * and only the operations the binding actually calls are typed here.
 *
 * The DASHR-scoped engine (design A, `compactModel` set) is the one place a
 * real upstream class is used: `BasicCompactionEngine` is dynamically
 * imported from the OPTIONAL peer `@deepseek-ai/dsh-compaction-basic` and
 * constructed under `ctx.isolate('compaction')`, so it never collides with a
 * root-provided engine (cordis keys service registration by isolation label)
 * and never leaks outward. The import being dynamic is what keeps the
 * dependency optional: a deployment that never sets `compactModel` never
 * loads the package.
 * @module dashr-tool-presentation/compaction-surface
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** The compaction vocabulary the binding reports back to the cell (mirrored subset of `CompactionResult`). */
export interface DasherCompactionResult {
  /** Stable identity of the compaction transaction. */
  compactionId: string | number
  /** The seq of the appended `compaction/summary` event. */
  summarySeq: number
  /** The seqs of the shadowed surface nodes, in surface order. */
  shadowedSeqs: number[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
}

/**
 * The agent context the compaction seam requires, mirrored to the subset the
 * engines read: `session`, routing `options`, and (for `compactNow`) the
 * idle-maintenance gate. The live `Agent` from `exec.agent` satisfies this
 * structurally and is what we pass through unchanged.
 */
export type DasherCompactionAgent = Agent

/** The `ctx.compaction` surface the compact() binding calls. */
export interface DasherCompactionSurface {
  /**
   * Explicit idle-session compaction (the human `/compact` entry). Throws a
   * `ManualCompactionError`-shaped error (`code: 'busy' | 'cancelled' | ...`)
   * — notably `busy` whenever the agent has active work, which is ALWAYS the
   * case for an in-cell call (the cell runs inside a live agent turn).
   */
  compactNow(agent: DasherCompactionAgent, signal: AbortSignal, sourceCommandId?: unknown): Promise<DasherCompactionResult | null>
  /**
   * Policy-governed pressure compaction — the between-steps automatic entry.
   * Needs no idle gate, which is what makes it the effective in-cell path:
   * below the engine's threshold it is a `null` no-op, above it the selected
   * range is summarized and shadowed now, so the model's NEXT request in the
   * same turn already rides the compacted history.
   */
  compactIfNeeded(agent: DasherCompactionAgent, trigger: 'pressure' | 'context-overflow', signal: AbortSignal): Promise<DasherCompactionResult | null>
}

/** The `ctx.tokenMeter` surface the usage probe reads (optional host singleton). */
export interface DasherTokenMeterSurface {
  /** Replay-fold measurement of the session's current pressure. */
  measure(session: unknown): { totalTokens: number }
}
