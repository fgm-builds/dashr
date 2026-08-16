# DASHR

**DASHR is a plugin for the [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness)**
that gives the agent a **persistent Python kernel** — the RLM ("research loop
machine") interaction model. Everything the plugin contributes is the
kernel runtime plus its presentation (the `run_cell` transport, the
generated Python SDK, the tool bindings, the harness). The repository also
ships the `dashr` **agent preset**, a small configuration file that wires
the plugin into an otherwise standard dsh deployment.

Instead of one tool call per step, the model writes a Python program per
*cell*. Every tool in the host's registry is automatically bound inside the
kernel as `tools.<name>(...)`; variables, imports, and definitions persist
across cells, so intermediate computation never has to round-trip through
the conversation context.

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
  in a later session (see the package README).
- **Upstream-proof preset** — the `dashr` preset is *not* a copy of the
  `standard` preset. It is an **include** of the installed harness's own
  `standard` composition plus one `dashr-kernel` group, with the persona row
  patched. When upstream dsh adds or changes tools, the preset follows
  automatically — no manual re-sync.

## How it works (and what it is not)

The kernel layer is a **bridge, not a reimplementation**:

- The host plane keeps everything a plugin must not own: the tool
  registries, the sandbox and approval stack, persistence, and the model
  route.
- `tools.<name>(...)` calls execute through the host's own
  `ctx.tools.execute` pipeline — sandbox policy and approval apply to them
  exactly as native tool calls do.
- `run_cell` is the only contributed tool; the model writes Python against a
  generated SDK and executes it as one cell.

Architecture detail lives in `docs/dashr-blueprint.md` (design) and the
package README (`dashr/README.md`).

## Security model

What the plugin changes and what it does not:

- **`tools.*` calls stay governed.** They run through the host's tool
  pipeline, so the host's sandbox and approval policies apply to them just
  as if the agent had called the tools natively.
- **Python code in cells runs as the dsh user, like any locally executed
  code.** The kernel process is a plain child of the dsh host, not confined
  by dsh's bash-tool sandbox. This is the same trust model as any agent
  runtime that executes generated code on your machine (Claude Code, Open
  Interpreter, etc.): the code can do whatever your user account can do.
  This is inherent to running a local code executor — it is not specific to
  DASHR, and it is exactly why such executors belong in a container or VM
  when the workload is untrusted.

In short: install DASHR wherever you would let the model run commands as
your user. For anything less trusted, containerize the dsh host (or the
kernel) first.

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
   interpreter path is baked into the preset (no env vars needed at
   runtime).
4. **Plugin** — builds `dashr-plugin` from the pinned release and adds it to
   the profile with `--config.auto-install-peers=false` (mandatory:
   prevents a second, divergent copy of the `@deepseek-ai/*` peers).
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
# 1) build the plugin
cd dashr && npm install && npm run build && npm pack

# 2) add to the profile (auto-install-peers=false is mandatory)
dsh plugin --profile web add --config.auto-install-peers=false \
  ./dashr-plugin-0.1.0.tgz

# 3) localize the preset: substitute the include path placeholder with your
#    dsh install's standard composition, e.g.
#    ~/.local/lib/node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml
#    (and the kernel python if your python3 lacks ipykernel), then copy both
#    preset files to ~/.dsh/.agent-presets/dashr/
```

## Requirements

- Node.js ≥ 20, npm
- dsh (auto-installed by `install.sh`)
- python3 + `ipykernel` (venv auto-created by `install.sh` if missing)

## Repository layout

```
dashr/                 the dashr-plugin package — kernel runtime + run_cell
                       presentation, SDK generation, bindings, harness,
                       refine/compact, snapshots
dashr/preset/dashr/    the shipped agent preset (include-based stacking)
docs/                  design and analysis documents
```

## Development

```bash
cd dashr && npm install && npm test        # 140 tests
```

TypeScript, built with `tsdown`, tested with `vitest`. Runtime dependencies:
`@deepseek-ai/schemastery` and `zeromq`; everything else is a peer the dsh
host supplies.

## License

MIT — see `LICENSE`.
