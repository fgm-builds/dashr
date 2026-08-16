# dashr-code-runtime-ipython

A **stateful `ctx.rlmRuntime` provider** for the DASHR project: one persistent
IPython kernel subprocess **per session** (the run's `principal`), held in a
map inside the one service instance per mount — the upstream "plugins key
their state by Session/Agent" model, which a per-mount realm cannot provide
on its own. Each `run()` is one cell on the calling session's kernel;
variables, imports, and definitions assigned in run N survive into run N+1 —
*state codification* (blueprint §1.1 channel ②), deliberately NOT the
per-run isolation a one-shot execution backend provides — and two sessions
sharing one service instance never see each other's variables.

This is M1 of DASHR: the provider half of the seam. The consumer half —
the `run_cell` transport tool, the Python SDK renderer, and the presentation
plugin that binds them to the dsh tool registry — lives in the sibling
package `dashr-tool-presentation` (`../dashr-presentation`). The provider
registers the service key `rlmRuntime` through its own vendored Service
Definition (see `src/vendored/rlm-runtime.ts`), so it carries **zero dsh
runtime package dependencies**: only `@deepseek-ai/cordis` (peer),
`schemastery`, and `zeromq`.

## Package positioning

- npm name: `dashr-code-runtime-ipython` (local `--patch` development;
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
npm install dashr-code-runtime-ipython
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
