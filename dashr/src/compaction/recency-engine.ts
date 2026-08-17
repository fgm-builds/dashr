/**
 * Feature 1 — the Context Recency Window engine.
 *
 * Upstream `BasicCompactionEngine`'s pressure threshold is
 * `thresholdRatio × model contextWindow` (default 0.8): the model limit's
 * passive projection, with no absolute trigger an operator can set. This
 * subclass adds exactly ONE knob on top of it: `recencyWindowTokens`, an
 * absolute token ceiling compared BEFORE the upstream check, so the trigger
 * becomes "either threshold":
 *
 *   totalTokens > recencyWindowTokens    (operator-set recency ceiling)
 *   totalTokens > thresholdRatio × window (upstream projection, untouched)
 *
 * No comparison between the two values is needed: whichever is smaller
 * fires first, and the other side's no-op guard makes the `min()` semantics
 * fall out of the two sequential checks. A 250K model with a 500K recency
 * ceiling compacts at the upstream 200K point; a 1M model compacts at 500K.
 *
 * The official subclassing surface is used throughout:
 * `compactIfNeeded` stays dynamically dispatched (subclass overrides are
 * honored at event time), the only selector guard dependency
 * (`toolPairingBalancedBefore`) is a public export of the abstract
 * `@deepseek-ai/dsh-compaction` package, and when recency fires the
 * selected [start, end] range is handed to upstream's public
 * `compactRegion` — region validation, the durable compaction lock,
 * summarization, and the surface replacement all stay native.
 *
 * This module statically imports the OPTIONAL peer
 * `@deepseek-ai/dsh-compaction-basic`, so it must only ever be loaded
 * through the dynamic import in `index.ts` (the same discipline as design
 * A): deployments that never configure `recencyWindowTokens` never load
 * the package.
 * @module dsh-rlm-mode/compaction/recency-engine
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import z from '@deepseek-ai/schemastery'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

/** The measurement vocabulary the recency check prices (the token-meter surface's richer subset). */
export interface RecencyMeasurement {
  /** Whole-request pressure: system prompt, tools, and the conversation surface. */
  totalTokens: number
  /** The priced surface fold, in model-visible order. */
  nodes: ReadonlyArray<{ seq: number; tokens: number }>
}

/** The token-meter surface the recency check reads (structurally satisfied by the host singleton). */
export interface RecencyTokenMeterSurface {
  measure(session: unknown): RecencyMeasurement
}

/** The recency trigger's extra constructor keys (stripped before `super()`). */
export interface RecencyEngineConfig extends BasicCompactionConfig {
  /**
   * The Context Recency Window: an absolute token ceiling. When the
   * session's measured pressure exceeds it, the passive pressure path
   * compacts with the configured `retainTokens` tail — regardless of how
   * much headroom the model's own context window still has.
   */
  recencyWindowTokens: number
}

/**
 * BasicCompactionEngine with one added absolute trigger: the Context
 * Recency Window. See the module doc for the full semantics.
 */
export class RecencyAwareCompactionEngine extends BasicCompactionEngine {
  /** The upstream config schema plus the recency key (the cordis plugin() mounting surface). */
  static override Config = z.intersect([
    BasicCompactionEngine.Config,
    z.object({ recencyWindowTokens: z.natural().min(1) }),
  ])

  /** The absolute recency ceiling; the constructor guarantees it is set and sane. */
  private readonly recencyWindowTokens: number

  constructor(ctx: Context, config: RecencyEngineConfig) {
    // Upstream resolveConfig → validateKeys rejects unknown keys, so the
    // recency key must be peeled off BEFORE super() sees the config.
    const { recencyWindowTokens, ...upstreamConfig } = config
    super(ctx, upstreamConfig)
    this.recencyWindowTokens = recencyWindowTokens
    // The recency selector prices a CONCRETE retained tail, and a retention
    // at/above the trigger would make every compaction a no-op — the same
    // invariant upstream machine-checks between retainTokens and its own
    // thresholdTokens.
    if (this.config.retainTokens === undefined) {
      throw new Error(`dsh-rlm-mode: recencyWindowTokens (${recencyWindowTokens}) requires an absolute retainTokens config (the post-compaction tail the selector prices)`)
    }
    if (this.config.retainTokens >= recencyWindowTokens) {
      throw new Error(`dsh-rlm-mode: retainTokens (${this.config.retainTokens}) must be less than recencyWindowTokens (${recencyWindowTokens})`)
    }
  }

  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    // The recency ceiling only participates in the passive pressure path;
    // context-overflow keeps its maximum-reduction semantics untouched.
    if (trigger !== 'pressure') {
      return super.compactIfNeeded(agent, trigger, signal)
    }
    const meter = (this.ctx as Context & { tokenMeter: RecencyTokenMeterSurface }).tokenMeter
    let measurement = meter.measure(agent.session)
    if (measurement.totalTokens < this.recencyWindowTokens) {
      // Below the recency ceiling: hand back to upstream's own threshold
      // check (the second arm of the OR trigger) — the pure
      // compare-and-delegate shape.
      return super.compactIfNeeded(agent, trigger, signal)
    }
    // Above the recency ceiling: mirror upstream's pressure flow — prune
    // tool results first; the prune alone may drop the session back under
    // the ceiling, in which case this round is an honest no-op.
    const prune = this.ctx.get('toolResultPruner') as { pruneSession(session: unknown): void } | undefined
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < this.recencyWindowTokens) {
      return null
    }
    const range = selectRecencyRange(agent.session, measurement, this.config.retainTokens!)
    if (range === null) {
      // The whole surface fits inside the retained tail — nothing compactable.
      return null
    }
    // Everything downstream (region validation, the durable compaction
    // lock, summarization, the surface replacement) is upstream's public
    // compactRegion.
    return this.compactRegion(range.start, range.end, agent, signal)
  }
}

/**
 * The recency selector: translate `retainTokens` into a [start, end]
 * surface range, reimplementing upstream's module-private
 * `selectCompactableRange` walk. The ONLY guard dependency is the public
 * `toolPairingBalancedBefore` export; the returned range feeds upstream's
 * public `compactRegion` unchanged.
 * @param session - the agent session whose surface is walked.
 * @param measurement - the priced surface fold, in model-visible order.
 * @param retainTokens - the absolute post-compaction tail budget.
 * @returns the inclusive compaction range, or `null` when nothing is compactable.
 */
export function selectRecencyRange(
  session: Session,
  measurement: RecencyMeasurement,
  retainTokens: number,
): { start: number; end: number } | null {
  const nodes = measurement.nodes
  const surfaceSeqs = session.surface.nodes
  if (nodes.length === 0) {
    return null
  }
  if (nodes.length !== surfaceSeqs.length || nodes.some((node, index) => node.seq !== surfaceSeqs[index])) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }
  // 1) Walk backward from the newest node, accumulating tokens until the
  //    retained tail budget is met — keepFrom becomes the tail's first node.
  let accumulated = 0
  let keepFrom = nodes.length
  for (let index = nodes.length - 1; index >= 0; index--) {
    accumulated += nodes[index]!.tokens
    keepFrom = index
    if (accumulated >= retainTokens) {
      break
    }
  }
  if (keepFrom === 0) {
    // The entire surface fits inside the retained tail: no compaction range.
    return null
  }
  // 2) Walk the cut downward until it no longer splits a tool-call/result
  //    pair (the public pairing guard; it throws when a seq is off-surface,
  //    which the equality check above has already excluded).
  while (keepFrom > 0 && !toolPairingBalancedBefore(session, surfaceSeqs[keepFrom]!)) {
    keepFrom--
  }
  if (keepFrom === 0) {
    return null
  }
  // 3) Compaction range = [surface head, the node before the retained tail].
  return { start: surfaceSeqs[0]!, end: surfaceSeqs[keepFrom - 1]! }
}
