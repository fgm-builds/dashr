# Bridge the tool layer, not the service layer

DASHR's `rlm()` family dispatches upstream delegation tools through the tool registry (nested sub-dispatch), not `ctx.subagents` service methods. The tool layer carries the deployment's enforcement surface — approval pipeline, sandbox policy, per-instance config (maxDepth, backgroundMode, persona) — that a direct service call would silently bypass. The cost: per-call model selection is impossible, because the tool schema exposes no `model` parameter; `rlm(model=...)` from 0.1.4 is dropped, and `subagentModel` degrades to a static `agentOptions.model` in the preset patch.

## Considered Options

- **Service layer direct** (0.1.4's approach): `ctx.subagents.start()` with a hand-built request. Full control over request fields (including `agentOptions.model` and `maxDepth`), but every policy the tool instance would have applied must be re-implemented or lost.
- **Tool layer nested dispatch** (chosen): `rlm("spawn")` executes the registry's `subagent` tool with a parent token. Upstream policy is inherited wholesale; the schema boundary is the tool's own contract.

## Consequences

- `rlm(mode, prompt, *, label, run_in_background)` — no `model` kwarg. Parent-model inheritance is the default; a different child model requires a preset patch, not a call argument.
- Depth enforcement comes from the tool instance's `maxDepth` config, patched to 10 in the preset (see `dev/kernel-refactoring/V0.1.5-development-plan.md` Q22/Q23).
- The upstream delegation tools (`subagent`, `subagent_fork`, `interrupt_agent`) must stay registered and executable even though the model never sees their names — which is why masking is presentation-only (ADR-0002).
