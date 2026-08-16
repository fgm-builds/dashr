# dashr-plugin

The DASHR plugin for the DeepSeek Harness — the RLM mode: a **stateful
`ctx.rlmRuntime` provider** (one persistent IPython kernel subprocess **per
session**, the run's `principal`, held in a map inside the one service
instance per mount — the upstream "plugins key
their state by Session/Agent" model, which a per-mount realm cannot provide
on its own. Each `run()` is one cell on the calling session's kernel;
variables, imports, and definitions assigned in run N survive into run N+1 —
*state codification* (blueprint §1.1 channel ②), deliberately NOT the
per-run isolation a one-shot execution backend provides — and two sessions
sharing one service instance never see each other's variables.

This is M1 of DASHR: the provider half of the seam. The consumer half —
the `run_cell` transport tool, the Python SDK renderer, and the presentation
plugin that binds them to the dsh tool registry — lives in the sibling
package `dashr-plugin` (`../dashr-presentation`). The provider
registers the service key `rlmRuntime` through its own vendored Service
Definition (see `src/vendored/rlm-runtime.ts`), so it carries **zero dsh
runtime package dependencies**: only `@deepseek-ai/cordis` (peer),
`schemastery`, and `zeromq`.

## Package positioning

- npm name: `dashr-plugin` (local `--patch` development;
  publish scope still open — blueprint §11 #4).
- A standard Cordis plugin (`Context` + schemastery `Config`, every tunable
  configurable from `cordis.yml`, no hardcoded tunables).
- "Registrations are effects": the kernel lifecycle (lazy spawn on a key's
  first `run()`, teardown on that session's `agent/disposed`, optional
  snapshot at either teardown) is effect-owned, so plugin disposal tears
  every subprocess down.
- Published surface: `lib/` only (`files: ["lib"]`, `main`/`types`/`exports`
  pointing at `lib/index.js` / `lib/index.d.ts`) — the build emits beside the
  manifest (`outDir: 'lib'`; the tsdown default `dist/` left the exports map
  dangling, fixed in M2B). The root also re-exports the vendored Service
  Definition's public contract (`RLMRuntime` plus the `CodeRun*` /
  `CodeBinding*` / `CodeJsonValue` types) so consumers depend on the
  published shape instead of reaching into sources. The declaration keeps
  dependency imports external (`dts: { resolve: false }`): bundled copies
  would create duplicate type identities in a consumer's program.

## Install

```sh
npm install dashr-plugin
```

The provider needs a Python interpreter with `ipykernel` (and `dill` for
snapshots). For development and tests, create a dedicated kernel venv:

```sh
npm run kernel:venv        # uv venv .venv-kernel + ipykernel + dill
```

Tests pick the kernel interpreter from `DASHR_TEST_PYTHON`, falling back to
`./.venv-kernel/bin/python`, then `python3` — see `test/helpers.ts`.

## Configuration

Every field of the plugin `Config` (schemastery defaults shown):

| Field | Default | Meaning |
| --- | --- | --- |
| `python` | `python3` | Interpreter with `ipykernel` installed; spawned with `-m ipykernel_launcher`. |
| `cwd` | *(unset)* | Working directory for the kernel subprocess. |
| `startupTimeoutMs` | `30000` | Budget for kernel spawn → ready, in milliseconds. |
| `runTimeoutMs` | `120000` | Wall budget per run; expiry interrupts the kernel then force-settles. |
| `interruptGraceMs` | `2000` | Grace between a timeout/abort interrupt and the force-settle. |
| `interruptConfirmMs` | `250` | Confirm window between the control-channel interrupt and the SIGALRM escalation (must be `< interruptGraceMs`); see "Interrupts" below. |
| `disposeTimeoutMs` | `5000` | Budget for graceful kernel teardown (shutdown_request → SIGKILL). |
| `snapshotTimeoutMs` | `30000` | Budget for internal snapshot/restore cells (dill dump/load). |
| `maxOutputBytes` | `67108864` | Hard cap for serialized log-array, completion-value, and failure-message payloads. |
| `snapshotDir` | *(unset)* | Base directory for per-session namespace snapshots (`<dir>/<principal>/state.dill` + `manifest.json`); none when absent. |
| `snapshotSizeCapBytes` | `268435456` | Serialized-size cap for a turn-end snapshot; over-cap snapshots are skipped (one-time model warning). |
| `username` | `dashr` | Jupyter username stamped on wire messages. |

## Persistent-state semantics

- **Cell semantics**: each `run({ program })` is one cell on the calling
  session's kernel namespace (`user_ns`). Top-level `await` and `return`
  work; the completion value crosses the lossless-JSON boundary (explicit
  `return None` → `null`; no `return` → no `value` field).
- **Session keying** (M3-A): one kernel per distinct `request.principal`
  (the presentation bridge passes the calling agent's session id); runs
  without a principal share one default key, preserving M1 semantics. The
  service instance count is unchanged — one per mount — the keying is a
  `Map<principal, kernel>` inside the provider.
- **Kernel lifetime**: lazy start on a key's first `run()`; teardown when
  that session's agent is disposed (the dsh `agent/disposed` event, payload
  `{ agent: { id } }`, listened through the untyped cordis event service to
  keep this package's zero-dsh-dependency rule) and on plugin disposal
  (`shutdown_request`, then SIGKILL after `disposeTimeoutMs`). A kernel that
  dies unexpectedly is never reused in-process: it respawns onto its nearest
  replayable snapshot (or a fresh empty kernel when none exists) and the run
  that observed the death gets an explicit `worker-exit` naming what was lost.
- **Turn-end snapshots** (M3-B): with `snapshotDir` configured, every
  successful run is followed by a size-capped snapshot cell that dumps the
  user namespace to `<snapshotDir>/<principal>/state.dill` + `manifest.json`
  (`turn`, `pythonVersion`, `venvPath` = the kernel's own `sys.executable`,
  `skills`, `names`, `sizeBytes`). A namespace whose serialized size exceeds
  `snapshotSizeCapBytes` is skipped — estimated BEFORE any dill IO by a
  bounded walk that reads numpy/pandas in-memory footprints, then confirmed
  against the actual `.part` dump — and the model is warned once through the
  run's own logs. Skipped snapshots never replace the previous good one.
- **Restore-on-first-boot** (M3-B): a key's first kernel boot restores its
  on-disk snapshot before running user code. The kernel validates the
  manifest itself (python version, interpreter identity, skills); a
  non-replayable snapshot degrades to an EMPTY namespace and the first run
  tells the model so. Variable state and the append-only transcript are NOT
  transactionally consistent (blueprint §8.3): the snapshot is a point-in-time
  namespace capture that can lag the transcript, and a degraded restore never
  fabricates variables the transcript once saw.
- **Interrupts** (M3-A hardened): aborts/timeouts escalate in two phases —
  the zmq control `interrupt_request` first, then SIGALRM only after
  `interruptConfirmMs` if the cell has still not settled. The kernel-side
  bootstrap installs a busy guard that only raises `KeyboardInterrupt` while
  a dashr cell is actually executing, so a signal landing on an idle or
  booting kernel is swallowed instead of terminating the process (the M1
  same-tick dual send killed idle kernels deterministically — 10/10
  same-tick, 8/10 at +1-2ms, 40/40 during cold boot; see
  `test/interrupt-race.spec.ts`). The hard-abort contract is intact: a busy
  `while True: pass` still breaks inside the grace (blueprint §10.4).
- **Concurrency**: the bridge serializes cells per kernel (`executeCell`
  awaits the previous cell), so concurrent `run()` calls on one session
  queue rather than interleave; see `test/parallel.spec.ts`. Runs on
  DIFFERENT principals execute on their own kernels concurrently.
- **What snapshots do NOT carry** (M4-B): the Continual Harness — the
  presentation-side durable prompt store behind the `dashr:harness` section
  and the `refine()` binding — lives OUTSIDE the kernel namespace and
  `snapshotDir`, persisted under its own `harnessDir` by the presentation
  package. A snapshot/restore cycle therefore never rolls harness entries
  back (and a harness edit never invalidates a snapshot): the two persistence
  channels are keyed by the same agent id but are otherwise independent
  (blueprint §8.4). Anything a cell stores in ordinary variables follows the
  snapshot rules above as before.

## Testing

```sh
npm install
npm run kernel:venv     # once; or export DASHR_TEST_PYTHON=/path/to/python
npm run typecheck       # tsc --noEmit
npm test                # vitest --run (fileParallelism: false)
```

Teardown discipline: every test context is disposed through
`onTestFinished`, and CI must assert no orphan kernels remain:

```sh
pgrep -cf -- '-[m] ipykernel_launcher' || echo no-orphans
```

(The `-[m]` trick prevents `pgrep` from matching itself; 208 orphaned
kernels once exhausted machine memory while every unit test stayed green —
blueprint §10.8/§10.9.)

---

# Presentation half (run_cell transport, SDK, bindings, harness)

# dashr-plugin

The DASHR agent-plane presentation row (blueprint §7.4): the plugin an agent
preset carries to present the RLM runtime's tools to the model as **cells on a
persistent IPython kernel**.

Mounted in a preset's standing scope, it contributes:

- **`run_cell`** — the only tool the model may call directly. One call = one
  cell on the persistent kernel (`ctx.rlmRuntime`, provided by the sibling
  package `dashr-plugin`). Variables, imports, and definitions
  survive across calls. Nested tool calls ride the host registry's native
  scheduling pipeline (`await tools.name({...})` inside the cell; member
  bindings are positional, keyword arguments are rejected). Two BARE callable
  globals are also installed per cell: `await rlm(prompt, label=None)` and
  `await rlm_await(run_id)` (see "rlm() subagent binding").
- **`tools:dashr-sdk`** — a generated Python SDK prompt section: one named
  `TypedDict` per tool argument/output object, one awaitable method per
  visible tool on a `Tools` protocol, and the cell contract (persistent
  namespace, completion-value rules, `ToolCallError`, sub-call concurrency).
- **The model-direct collapse** — an assembly filter leaves `run_cell` the
  only contributed tool schema, and a monotonic guard denies a model-direct
  call naming anything else with the route back into a cell. Both are scoped
  to the mounting composition, so a PTC (native Code Mode) preset in the same
  process keeps its own presentation.

## Install

```sh
dsh plugin add dashr-plugin
```

That installs this package — and, through its peer chain, the
`dashr-plugin` kernel provider — into the dsh profile. `--patch`
variants (`dsh plugin --patch ...` / a profile overlay) work the same way;
the package is a plain npm install from the profile's perspective.

Two more setup facts:

1. **Kernel interpreter.** The provider spawns a Python interpreter with
   `ipykernel` installed (plus `dill` if you want dispose-time state
   snapshots). The shipped preset resolves it from `DASHR_KERNEL_PYTHON`,
   falling back to `python3`. A dedicated venv keeps it clean:

   ```sh
   python3 -m venv ~/.dashr-kernel && ~/.dashr-kernel/bin/pip install ipykernel dill
   # then: export DASHR_KERNEL_PYTHON=~/.dashr-kernel/bin/python
   ```

2. **Preset root.** A preset is a directory holding `agent.cordis.yml`; the
   roster (`@deepseek-ai/dsh-agent-presets`) only scans its configured
   `roots`. This package ships the preset at `preset/dashr/`, so expose it
   to the roster by adding that directory as a root — the same mechanism the
   CLI uses for its own shipped set (`apps/cli/src/profile-boot.ts` pins
   `config/agent-presets/` with `trust: system` via a boot overlay). With a
   `--patch` overlay (or the profile's `cordis.patch.yml`):

   ```yaml
   # dashr-preset-root.yml — passed as `--patch dashr-preset-root.yml`
   - id: agent-presets
     config:
       roots:
         - path: <profile-dir>/node_modules/dashr-plugin/preset
           trust: system
   ```

   `roots` entries are scanned in order (earlier wins a duplicate id), each
   `path` may expand a leading `~`, and `trust` marks shipped (`system`) vs
   locally authored (`user`) presets — display-only, not a capability
   boundary. The roster always appends its own user root
   (`<dshHome>/.agent-presets`) unless `includeUserRoot: false`.

Once the root is configured, the preset appears in the roster and can be
picked for a session (`dashr`), copied for local authoring, or set as the
`agent-presets` default.

## The `dashr` preset

`preset/dashr/agent.cordis.yml` (display metadata in `preset.yml`) is an
AGENT-PLANE composition in the shape of the upstream `code` preset. Its rows:

| Row | Package | Notes |
| --- | --- | --- |
| `persona` | `@deepseek-ai/dsh-persona` | Same shape as `code`; describes the persistent-kernel mode. |
| `agent-instructions` | `@deepseek-ai/dsh-agent-instructions` | Same as `code`. |
| `dashr-kernel` (group, `isolate: { rlmRuntime: true }`) | `dashr-plugin` + `dashr-plugin` | The provider publishes `ctx.rlmRuntime` behind an entry-local realm; the presentation row sits INSIDE the group because realm-private services resolve only for rows sharing the realm. |
| `filesystem` (group, `isolate: { fs: true }`) | `@deepseek-ai/dsh-fs-local` + `@deepseek-ai/dsh-tool-fs` | The `minimal` preset's bare-local pattern (the `code` preset instead uses the host's sandboxed `fs`). `read`/`write`/`edit` register on a bare host; `read_image` waits for an `attachments` service the host owns. |
| `tool-todo` | `@deepseek-ai/dsh-tool-todo` | Registers into the registry's preset layer; also the binding-bridge material (`tools.todo_write(...)` inside a cell). |

Deliberately absent, with reasons (the upstream `code` preset carries them):

- `dsh-tool-bash` / `dsh-tool-pwsh` — their executors (`bash-sandbox` /
  `pwsh-sandbox`) are host-plane services a bare host does not supply, and
  shell work belongs inside the kernel anyway.
- `dsh-tool-fs-search` — its ripgrep/subprocess/spill stack is host-plane
  weight with a native dependency; kernel-side Python covers search.
- The jobs/skills/goals/plan/compaction/delegation sections — each either
  owns host-plane singletons or adds host services; a DASHR deployment
  composes them on the host when wanted.

The provider row's config carries only the tunables worth overriding from a
preset: `python` (from `DASHR_KERNEL_PYTHON`, else `python3`), `cwd`
(unset → the host process cwd), `snapshotDir` (unset → no snapshots). See the
sibling package's README for the full table.

### Realm semantics (read this before relying on isolation)

An entry-local realm (`isolate: { rlmRuntime: true }`) is **one instance per
mounted composition**, not per session. The roster mounts a preset ONCE per
process under a standing scope and every session joins it, so under the
roster **all `dashr` sessions share one provider instance**. That is the
upstream roster's documented model ("its plugins key their state by
Session/Agent, so sessions stay apart inside one shared instance") — and
since M3-A the provider honors exactly that: it keys **one kernel per
Session/Agent inside the shared instance** (the run's `principal`, threaded
from the calling agent's id by this package's bridge), spawns each lazily on
that session's first `run_cell`, and tears it down on `agent/disposed`. State
set by session A is therefore NOT visible to session B under either mount
granularity; mounting per agent (the exported `mountPreset` primitive)
additionally gives each session its own realm instance.
`test/preset.spec.ts` proves both directions (shared instance + keyed
kernels under the roster; separate instances under per-agent mounting).

What the realm does guarantee, and what the tests assert: the provider is
invisible to the host plane (`ctx.get`/root realm never resolve it), a mount
publishing an un-realm'd service is rejected by `dsh-agent-presets`, and a
PTC Code-Mode session in the same process still resolves the host's
`codeRuntime`.

## Coexistence with a PTC Code-Mode session

`run_cell` is our own transport name (the registry reserves `run_code`), so a
Code-Mode preset (`@deepseek-ai/dsh-agent-tool-presentation` with
`mode: code` over the host-plane worker-thread `codeRuntime`) composes beside
the `dashr` preset in one process: the PTC agent's assembly shows `run_code`
plus the TS `tools:sdk` section, the dashr agent's shows `run_cell` plus the
Python `tools:dashr-sdk`, and neither execution path touches the other's
runtime. One environmental caveat: the worker-thread provider strips
TypeScript in-process, so a Node build without TS support
(`process.features.typescript === false`, e.g. this dev box's v22 binary)
runs Python cells fine but answers a `run_code` with the provider's
documented "Node.js is not compiled with TypeScript support" error — the
same spec passes the real-run branch under a TS-capable Node 24.

## Composition

```ts
import Presentation from 'dashr-plugin'

// Inside a preset's standing scope context:
scope.ctx.plugin(Presentation, { maxParallelSubCalls: 10 })
```

The row waits for `ctx.rlmRuntime` at mount (`ctx.inject`) and re-reads it at
use time: a preset against a runtime-less deployment fails at mount, named in
the preset's activation audit, instead of at the first prompt.

## rlm() subagent binding (M3-B; model selection added in M4-A)

Each cell installs two bare callable globals on top of the `tools` namespace:

- `handle = await rlm(prompt, label=None, model=None)` — non-blocking ADMISSION
  of a child agent through the host-plane `ctx.subagents` service, in-process
  provider `spawn` first (blueprint §9). The `await` resolves when the child is
  PUBLISHED, not when it finishes — the same admission semantics as the RLM
  runtime's own `rlm()`. Returns
  `{run_id, label, provider: 'spawn', local, model}`; the child keeps running
  after the cell returns and is cancelled by the enclosing `run_cell`'s outer
  signal.
- Child-model selection (M4-A) is a three-level priority:
  `rlm(model="...")` > the composition's `subagentModel` config > the parent
  agent's own model. The first two tiers reach the harness as
  `agentOptions: { model }` on the start request (the handle's `model` field
  reports what was resolved, `null` for inheritance); when BOTH are unset the
  request carries no `agentOptions` at all and the harness's own
  parent-inheritance applies — this plugin never names the parent model
  itself. `model=None` is "unspecified" (falls through to the config tier),
  and any non-string value is rejected as a result error, never a host crash.
- `result = await rlm_await(run_id)` — blocks the cell until that run settles
  and returns `{output: str, stop_reason: str, structured: Any|None}`
  (`output` is the child's final text, with non-text blocks folded to compact
  markers). The wait is interruptible by the cell's own timeout/abort.

Both bindings return structured JSON; errors are a FIELD on the result, never
a host crash — no `ctx.subagents` service, no `spawn` provider, an unsupported
capability, a depth cap, an unknown `run_id`, or an infrastructure rejection
all map to an `error` string (or `rlm_await`'s `stop_reason: 'error'`). Live
handles are held host-side per composition, settled/removed by `rlm_await`,
and every unsettled run owned by a session is disposed on that session's
`agent/disposed` (and all of them on composition teardown).

Realm boundary: `ctx.subagents` is a HOST-PLANE root-realm singleton (the
`dashr` preset deliberately does not carry the subagent rows), while this row
sits inside the preset's `isolate: { rlmRuntime: true }` realm. Cordis resolves
outer-realm services for names the inner realm does NOT isolate, so this row
reaches `ctx.subagents` outward through `ctx.get('subagents')` while the
realm-private `rlmRuntime` stays invisible to the root — which is why the
rlm() host callback lives HERE (it is the one layer that can simultaneously
see `ctx.subagents`, the parent `Agent` on `exec.agent`, and the abort signal).

## Continual Harness + refine() (M4-B)

The Continual Harness is per-agent DURABLE PROMPT STATE — notes, memories, and
skills carried into every future system prompt of the same agent id. It is
prompt-as-variable: the `dashr:harness` prompt section (order 200, the first
slot after the 100–199 tool-guidance band) re-renders from the CURRENT store at
EVERY assembly, so a refine() that lands mid-turn is visible to the very next
model request with no restart. An empty harness renders an empty section
(`renderPrompt` drops it), and entries are brace-neutralized at render time so
a literal `{{var}}` inside a memory can never throw (or silently interpolate)
the prompt-variable machinery.

Each cell exposes `summary = await refine(instruction)` — one bare callable
global:

1. The host resolves the aux model route: `refineModel` config (`'provider/model'`,
   or a bare model id paired with the calling agent's own provider) or, unset,
   the agent's own provider+model (refinement writes durable state, so the
   default is the agent's own model).
2. One hand-built `ctx.llm.stream` call (NOT `markAgentLoopRequest`-marked —
   that identity belongs to loop-built requests) carries the full current
   harness, the instruction, and a strict op-schema directive.
3. The answer is parsed under an all-or-nothing schema
   (`add {kind,title,content} | update {id,title?,content?} | delete {id}`);
   anything unparseable or invalid leaves the store UNTOUCHED and returns a
   structured `error` field.
4. Validated ops apply atomically and the cell gets
   `{refined: true, applied: [...], entries_before, entries_after, model}`.

Storage: `harnessDir` set → one JSON file per agent
(`<harnessDir>/<agent>/harness.json`), written tmp-sibling + rename (atomic),
restored by the next composition serving the same agent id; `agent/disposed`
drops only the in-memory cache — the file survives by design ("continual").
`harnessDir` unset → memory-only, dying with the composition (the same opt-in
posture as the runtime's `snapshotDir`; a silent default location would
persistently alter future prompts without a deployment decision). Soft caps:
64 entries, 200-char titles, 8000-char content. Entry text is foreign model
output; the caps bound what a runaway refine can add to every future prompt.
The `await` blocks the cell until the aux call settles, under the kernel run's
own wall budget (`runTimeoutMs`), and the abort chain follows `exec.signal` —
an aborted refine is a structured `error`, never a partial store mutation.

## compact() (M4-B)

`result = await compact()` (or `compact(reason)`) exposes the PA
check-usage→summarize→keep-working semantics over the compaction seam. It
first attaches the session's current pressure as `context_tokens` when a
`ctx.tokenMeter` is mounted (the probe is advisory — a failing meter never
masks compaction), then resolves an engine:

- `compactModel` SET → a DASHR-scoped `BasicCompactionEngine` is lazily
  mounted once per composition under `ctx.isolate('compaction')` (a proper
  plugin fiber so the engine's own `llm/tokenMeter/sessions` injects resolve
  OUTWARD to the host singletons) with `summarizationProvider/Model` derived
  from the key (`'provider/model'` explicit; a bare model id pairs with the
  first calling agent's provider) and `auto: false` — the host engine, if any,
  keeps the automatic pressure/overflow listeners and is never disturbed
  (cordis keys service registration by isolation label, so the scoped provide
  cannot collide with it and never resolves outside this composition). The
  dynamic import keeps the optional peer `@deepseek-ai/dsh-compaction-basic`
  unloaded for deployments that never set the key.
- `compactModel` UNSET → the host-mounted `ctx.compaction` engine, inheriting
  its model chain (configured ?? latest-request ?? agent — "follows the
  session model"). No engine mounted → a structured `unavailable` error (with
  `context_tokens` still reported), never a crash.

Execution is a two-step ladder, because the seam's `compactNow` requires an
IDLE agent and an in-cell call always runs inside a live agent turn: it tries
`compactNow` first (an idle-path deployment or a future seam change benefits),
and on the expected `busy` falls through to `compactIfNeeded('pressure')` —
the same policy entry the engine itself runs between steps: below threshold an
honest `{status: 'no-op'}`, above it the selected range is summarized NOW and
the model's next request in the SAME turn already rides the compacted history.
Success reports `{status: 'compacted', path, compaction_id, summary_seq,
shadowed_items, shadowed_tokens, compact_model}`; non-busy failures are
structured `error` fields.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `maxParallelSubCalls` | `10` | Cap on one cell's overlapping sub-calls (native scheduler contract; `1` = strictly serial). |
| `subagentModel` | unset | Composition-wide default model for `rlm()` children — the middle tier of `rlm(model=...) > subagentModel > parent inheritance`. Unset means pure parent inheritance (no `agentOptions` on the start request). Must be a non-empty string when set. |
| `harnessDir` | unset | Root for the Continual Harness store: one `harness.json` per agent, atomically written, restored by the next composition of the same agent id. Unset = memory-only (dies with the composition). Must be a non-empty string when set. |
| `refineModel` | unset | Aux model route for `refine()`: `'provider/model'` explicit, a bare model id paired with the calling agent's provider, or unset for the agent's own route. Must be a non-empty string when set. |
| `compactModel` | unset | Summarization model for `compact()`: mounts a DASHR-scoped `BasicCompactionEngine` (design A — see above) under `ctx.isolate('compaction')` with this route and `auto: false`. Unset inherits the host engine and its model chain. Requires the optional peer `@deepseek-ai/dsh-compaction-basic` when set. Must be a non-empty string when set. |

Dependencies note: `@deepseek-ai/dsh-compaction-basic` is an OPTIONAL peer
dependency (dev-installed for the design-A tests). Nothing loads it unless
`compactModel` is set; a deployment that sets the key without the peer gets a
structured error naming the missing package, never a crash at import time.

## Tests

```sh
npm install
npm run typecheck
npm test        # pretest builds this package AND the sibling provider first
npm run build
```

The suite needs a Python interpreter with `ipykernel` for the real-kernel
tiers. It resolves one from `DASHR_KERNEL_PYTHON` (the preset's own knob),
then `DASHR_TEST_PYTHON`, then `/tmp/dashr-kernel-venv/bin/python`, then this
package's or the sibling's `.venv-kernel`, then `python3`. `test/preset.spec.ts`
mounts the shipped preset through the real roster, so `npm test` also requires
the sibling package built (`pretest` handles the order).

## Relationship to upstream

Structure mirrors `@deepseek-ai/dsh-agent-tool-presentation` and the Code Mode
half of `@deepseek-ai/dsh-tools` (0.1.0-rc.6), re-pointed at the vendored
`rlmRuntime` Service Definition. See the module docs in `src/index.ts` for
the deliberate deltas (`run_cell` vs `run_code`, ordinary scoped registration,
guard-based collapse, mirrored `tools/code-dispatch-log` waterfall).
