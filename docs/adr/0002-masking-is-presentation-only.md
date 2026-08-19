# Masking is presentation-only

Hiding upstream tool names (`subagent`, `subagent_fork`, `send_message`, `list_agents`, `interrupt_agent`, `workflow`, `ralph`) from the model is done by excluding them from the generated Tool Catalog text and from the kernel binding names — nothing else. The upstream tools stay registered, executable, and dispatchable; the bridge dispatches them internally under the DASHR names (`rlm(...)`, `agent_message`, `agent_list`, `rlm_workflow`, `rlm_ralph`).

## Considered Options

- **`restrict()` at runtime**: hides names in the registry's model-facing view, but validates against the live view at call time — ordering hazards against late tool registration can fail the whole preset mount.
- **`disabled: true` include patches**: physically unregisters the tool, which also removes the bridge's dispatch target. Masking must not break the bridge.
- **Presentation-only exclusion** (chosen): the registry is never touched. The model's surface (wire schema collapse to `ipython`, Tool Catalog text, kernel bindings) is entirely DASHR-generated, so exclusion happens at the two points DASHR owns.

## Consequences

- The masked tools remain in the registry and are reachable via nested sub-dispatch with a parent token, which passes the model-direct guard.
- Zero upstream mutation means zero interference with host-plane modules that enumerate or interact with the delegation tools.
