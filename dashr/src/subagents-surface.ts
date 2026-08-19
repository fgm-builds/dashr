/**
 * The `ctx.subagents` seam surface, as this presentation plugin consumes it —
 * a STRUCTURAL mirror of the host-plane `@deepseek-ai/dsh-subagent` Service
 * Definition (0.1.0-rc.6), which is deliberately NOT in this package's
 * dependency graph: subagents is a host-plane root-realm singleton (the
 * preset delegates its registration to the host composition), and importing
 * the package here would pull a host-plane capability into an agent-plane
 * plugin for typing alone. The agent_message(receiver='parent') uplink reads
 * it with the untyped `ctx.get('subagents')` escape hatch (the same
 * optional-capability pattern upstream's child-agent.ts uses for
 * `agentPresets`/`sandboxPolicy`), and this file only types the one
 * operation the bridge actually calls.
 *
 * Realm note (M3-B, blueprint §9): this row lives inside the preset's
 * entry-local `isolate: { rlmRuntime: true }` realm. An inner realm resolves
 * outer (root) services for names it does NOT isolate — verified against
 * cordis 4.0.1 `reflect.ts`/`context.ts` and with a live probe — so
 * `ctx.get('subagents')` reaches the root singleton from here, while the
 * realm-private `rlmRuntime` never leaks OUT to the root. The uplink
 * callback therefore lives in THIS presentation layer: it is the one place
 * that can simultaneously reach `ctx.subagents` (outward), the reporting
 * child `Agent` (`exec.agent`), and the run's abort signal.
 *
 * Downlink note (ADR-0001): spawn/fork/send_message/list_agents/interrupt
 * bridging goes through the TOOL layer, not this surface — the delegation
 * tools carry the deployment's enforcement surface (approval, sandbox,
 * maxDepth, config) that a direct service call would bypass. This mirror
 * exists only for the ONE direction no tool covers: a continuable child
 * reporting up to its parent.
 * @module dsh-rlm-mode/subagents-surface
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'

/**
 * The subset of upstream `SubagentReportOptions` the bridge constructs.
 * `delivery` is FIXED at `'wakeup'` (the upstream default): it is a parent
 * scheduling policy, deliberately not exposed to the model.
 */
export interface DASHRSubagentReportOptions {
  /** Already-resolved parent scheduling policy (always `'wakeup'` from this bridge). */
  readonly delivery: 'wakeup'
  /** Caller cancellation, owning authorization and admission until acceptance. */
  readonly signal: AbortSignal
}

/**
 * The `ctx.subagents` service surface the agent_message() uplink calls.
 * `reportFrom` delivers content from one LIVE continuable child to its
 * durable direct parent — the child IS the authority credential (callers
 * cannot name a recipient), and the parent is bootstrapped by the service
 * from the child's own session header (zero ids on either side). A root
 * caller (no live continuable Activation) is rejected by the service's
 * `authorizeReporter` with a `SubagentError` code `'UNAUTHORIZED'`, which
 * the bridge surfaces as a structured error value.
 */
export interface DASHRSubagentsSurface {
  /**
   * Report content up to this child's direct parent. Resolves with the
   * stable identity of the parent-accepted message; rejects on
   * authorization failure (`'UNAUTHORIZED'` for a non-child caller), an
   * absent parent, or admission failure.
   */
  reportFrom(child: Agent, content: ContentBlock[], options: DASHRSubagentReportOptions): Promise<MessageId>
}
