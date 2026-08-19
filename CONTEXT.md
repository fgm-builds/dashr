# DASHR

DASHR is the RLM (Recursive Language Model) mode plugin for DeepSeek Harness: one persistent IPython kernel per agent session, all tools callable as typed Python objects inside cells.

## Language

**RLM (Recursive Language Model)**:
Recursive self-delegation — an agent spawns sub-agents through a standard function call, and every child is itself a DASHR agent that can spawn further children.
_Avoid_: sub-agent calling, delegation (too generic; delegation is the harness-level mechanism RLM builds on)

**RLM Mode**:
The DASHR preset (`rlm-mode`) — the standard coding agent composition presented through one persistent Python kernel, where ipython is the only wire-level tool.
_Avoid_: DASHR mode, kernel mode

**ipython**:
The single model-facing transport tool (renamed from `run_cell`): its `cell` argument carries the program, `description` labels it.
_Avoid_: run_code (upstream PTC transport), run_cell (the pre-0.1.5 name)

**Tool Catalog**:
The prompt section listing every tool as flat Python signatures the model can call inside cells. Generated from the registry's tool schemas, presentation-only.
_Avoid_: SDK tools, tools:dashr-sdk (the old section name), tools block

**Binding**:
A kernel-side Python name (flat global) whose calls round-trip to the host registry's real tool execution.
_Avoid_: proxy, tool object, tools.* (the pre-0.1.5 namespaced form)

**Masking**:
Presentation-layer exclusion: hiding a tool's name from the Tool Catalog and kernel bindings while the tool stays registered and executable upstream (the bridge dispatches it internally).
_Avoid_: tool removal, disable (a disable patch physically unregisters — different thing)

**DashrDaemon**:
The profile-level daemon concept: a process-global owner for cross-session kernel lifecycle. Empty shell in 0.1.5; the mount-level DashrRuntime is the de facto daemon today.
_Avoid_: KernelManager (the pre-interview working name)

**DashrRuntime**:
The mount-level runtime (renamed from IPythonCodeRuntime): one instance per standing mount, keying one kernel per session and owning spawn/dispose, snapshot/restore, and host-request dispatch.
_Avoid_: IPythonCodeRuntime, kernel runtime

**Kernel**:
The ipykernel Python subprocess itself — a pure interpreter with no harness awareness. Only the TS-side runtime knows about sessions and tools.
_Avoid_: Python runtime, IPython runtime (ambiguous between the subprocess and the TS manager)

**Control Prompt**:
The system-prompt section teaching the model the cell paradigm (single entry, typed errors, kernel-vs-host split, background handles).
_Avoid_: IPython control prompt (that's Prime Agent's section name)

**Standing Mount**:
The preset's per-composition mount: one instance shared by every session joined to it, one level above sessions and below the profile. Child agents join their parent's standing mount — the mechanism that makes recursion work.
_Avoid_: session mount, per-session mount

**Harness (Continual Harness)**:
DASHR's durable per-agent guidance store (`refine`/`compact` write it, the dashr:harness prompt section renders it).
_Avoid_: memory (that's the host's own memory tools)

**agent_message**:
The A2A Python function: `agent_message(receiver, message, *, subagent_id=None)` — `'child'` bridges the send_message tool downlink; `'parent'` bridges the service-layer reportFrom uplink (parent derived from the caller's own session header, no ID). Wakeup delivery, fixed.
_Avoid_: send_message (the upstream tool it wraps), report
