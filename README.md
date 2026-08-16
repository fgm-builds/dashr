# DASHR

**DASHR** is an agent preset for the [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness)
that presents the standard coding agent through **one persistent Python
kernel** — the RLM ("research loop machine") interaction model.

Instead of a tool call per step, the model writes a Python program per
*cell*. Every tool in the host's registry is automatically bound inside the
kernel as `tools.<name>(...)`; variables, imports, and definitions persist
across cells, so intermediate computation never has to round-trip through the
conversation context.

```
cell 1:  df = tools.read("data.csv").as_dataframe()   # tools.* = the full catalog
cell 2:  result = expensive_analysis(df)               # df is still alive
cell 3:  tools.write("out.json", result)               # state survives cells
```

## What it gives you

- **Stateful kernel** — one IPython kernel per session; everything assigned
  in cell *N* survives into cell *N+1* (imports, data, classes, open
  connections). Contrast with bash / code-mode workers, which start fresh on
  every run.
- **Schema-driven tool bindings** — the bridge has **no hard-coded tool
  list**. It walks the host tool registry at mount time and generates the
  Python SDK (`TypedDict` args classes + async functions) for whatever
  toolset the host exposes. On a standard host that is ~29 tools: bash,
  web_search, read/write/edit/glob/grep, subagent, skills, goals, jobs, plan
  mode, workflow, ask_user, memory (corti), and everything else registered.
  A plugin you add tomorrow is a `tools.*` binding the same day.
- **Sub-agents** — `rlm("task")` spawns a child agent (non-blocking;
  returns a handle), `rlm_await(handle)` collects its result in-cell.
- **Harness (prompt-as-variable)** — `refine()` writes operating
  guidance/memories into a per-agent store that is re-rendered into the
  system prompt every turn; `compact()` triggers context compaction on
  pressure.
- **Snapshot / revive** — save the kernel namespace to disk and restore it
  in a later session (see `docs` and the presentation package README).
- **Upstream-proof preset** — the `dashr` preset is *not* a copy of the
  `standard` preset. It is an **include** of the installed harness's own
  `standard` composition plus one `dashr-kernel` group, with the persona row
  patched. When upstream dsh adds or changes tools, the preset follows
  automatically — no manual re-sync.

## How it works (and what it is not)

The kernel layer is a **bridge, not a reimplementation**:

- The host plane keeps everything a preset must not own: the tool
  registries, the sandbox and approval stack, persistence, and the model
  route.
- `tools.<name>(...)` calls execute through the host's own
  `ctx.tools.execute` pipeline — sandbox policy and approval apply to them
  exactly as native tool calls do.
- `run_cell` is the only contributed tool; the model writes Python against a
  generated SDK and executes it as one cell.

Architecture detail lives in `dashr-blueprint.md` (design) and the two
package READMEs (`dashr/`, `dashr-presentation/`).

## Security — read this

The dsh sandbox (bwrap/Landlock) confines the **bash tool path**. The DASHR
kernel process itself is spawned as a plain child of the dsh host and
currently runs **outside that sandbox**: Python code in a cell can read and
write any file the dsh user can, and can spawn processes without dsh's
approval or policy layers (and, if the machine has passwordless sudo, the
kernel inherits that too — this applies to *any* unsandboxed process, not
something dsh grants).

`dashr-security-sandbox-analysis.md` documents this boundary with
measurements (`/proc/self/status`, mount views, escape probes) and lists the
mitigation ladder (NoNewPrivs → capability drop → seccomp → mount
namespace). Until those land, **run DASHR only in environments where you
trust the model's generated code with your user account** — i.e., treat it
like running `claude --dangerously-skip-permissions` or a shell open to the
model, not like a sandboxed runner.

## Install

One-liner (installs dsh if missing, then DASHR):

```bash
curl -fsSL https://raw.githubusercontent.com/fgm-builds/dashr/main/install.sh | bash
```

What it does:

1. **Environment scan** — checks node, npm, python3.
2. **dsh** — if `dsh` is not on PATH, installs the latest `@deepseek-ai/dsh`
   via npm (global, with a user-prefix fallback).
3. **Kernel Python** — if the host `python3` lacks `ipykernel`, creates
   `~/.dsh/dashr-kernel-venv` and installs `ipykernel` there; the resolved
   interpreter path is baked into the preset (no env vars needed at runtime).
4. **Plugins** — builds `dashr-code-runtime-ipython` and
   `dashr-tool-presentation` from the pinned release and adds them to the
   profile with `--config.auto-install-peers=false` (mandatory: prevents a
   second, divergent copy of the `@deepseek-ai/*` peers).
5. **Preset localization** — writes the `dashr` agent preset to
   `~/.dsh/.agent-presets/dashr/` with the machine-specific include path to
   dsh's `standard` composition substituted.

Restart a running `dsh web` after installing (plugins load at boot), then
create a session with agent preset **DASHR**.

Env knobs: `DSH_PROFILE` (default `web`), `DSH_HOME` (default `~/.dsh`),
`DASHR_VERSION` (default `v0.1.0`), `DASHR_REPO`, `DASHR_SRC` (use a local
source tree instead of downloading).

### Manual install

```bash
# 1) build both packages
npm install && npm run build && npm pack   # in dashr/ and dashr-presentation/

# 2) add to the profile (auto-install-peers=false is mandatory)
dsh plugin --profile web add --config.auto-install-peers=false \
  ./dashr-code-runtime-ipython-0.1.0.tgz ./dashr-tool-presentation-0.1.0.tgz

# 3) localize the preset: substitute the include path placeholder with your
#    dsh install's standard composition, e.g.
#    ~/.local/lib/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml
#    and the kernel python if your python3 lacks ipykernel, then copy both
#    preset files to ~/.dsh/.agent-presets/dashr/
```

## Requirements

- Node.js ≥ 20, npm
- dsh (auto-installed by `install.sh`)
- python3 + `ipykernel` (venv auto-created by `install.sh` if missing)

## Repository layout

```
dashr/                 dashr-code-runtime-ipython — the stateful kernel
                       provider (published as ctx.rlmRuntime)
dashr-presentation/    dashr-tool-presentation — the run_cell transport,
                       SDK generation, bindings, harness, refine/compact
dashr-presentation/preset/dashr/   the shipped agent preset
dashr-blueprint.md     design document
dashr-security-sandbox-analysis.md   sandbox boundary measurements
dev/                   milestone reports
```

## Development

```bash
cd dashr && npm install && npm test        # 40 tests
cd dashr-presentation && npm install && npm test   # 100 tests
```

Both packages are TypeScript, built with `tsdown`, tested with `vitest`, and
take `@deepseek-ai/schemastery` as their only runtime dependency (the dsh
host supplies everything else).

## License

MIT — see `LICENSE`.
