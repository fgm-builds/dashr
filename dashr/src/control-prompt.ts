/**
 * The DASHR Control Prompt (plan Q3): the `dashr:control-prompt` section,
 * registered BEFORE the Tool Catalog (order 100 < 150), teaching the model
 * the cell paradigm it must already know on turn one — that `ipython` is
 * the ONLY directly-callable tool and every other action is a flat
 * `await name(args)` program inside a cell. Adapted to the v0.1.5 flat
 * surface (no `tools.` holder, `glob` → `file_glob`, the
 * `rlm`/`agent_message`/`agent_list`/`rlm_workflow`/`rlm_ralph` bridges).
 *
 * Every claim here must match what the bridge enforces (src/index.ts +
 * src/py-sdk.ts): EVERY callable — registry tool or bridge — takes ONE
 * positional arguments object; a failed tool call raises `ToolCallError`;
 * `ipython` alone is model-direct; children run in the background by
 * default. This section teaches the one calling convention (the REPL cell
 * paradigm); delegation semantics live entirely in the Tool Catalog, where
 * the rlm/agent_message/agent_list/rlm_workflow/rlm_ralph bridges are
 * rendered as flat stubs like every other tool.
 * @module dsh-rlm-mode/control-prompt
 */

/**
 * The model-facing Control Prompt text: a single static block. The bridge
 * contract it teaches is identical for the root agent and every child
 * (children inherit the same composition), so it needs no scope-dependent
 * rendering.
 */
export const DASHR_CONTROL_PROMPT = [
  "## The Dashr IPython interface",
  "",
  "The IPython kernel is the one actionable interface of your agent runtime — a",
  "persistent control environment for reasoning, context management, state, tool",
  "orchestration, and recursive subcalls. The ONLY function call the runtime",
  "accepts directly is `ipython`, whose schema is:",
  "",
  "  { \"name\": \"ipython\", \"arguments\": { \"cell\": \"<one IPython cell>\", \"description\": \"<description>\" } }",
  "",
  "Every action you take is one program you write inside `cell` — one call, one",
  "cell, executed top-to-bottom. Every other tool is called from inside a cell,",
  "as `await name(args)` (see below).",
  "",
  "Use the kernel to keep intermediate variables, inspect and transform outputs,",
  "write small helper functions, and preserve useful state across turns or",
  "compaction.",
  "",
  "## Tools as Functions in REPL",
  "",
  "Every tool in the Tool Catalog is a flat top-level function in IPython kernel: await name(args) with ONE positional arguments object — `await read({\"file_path\": \"x\"})`, never `read(file_path=\"x\")`.",
  "",
  "One program in one cell — write it, Shift+Enter (one `ipython` call), get the result back (print or final expression), like a REPL scratchpad.",
  "",
  "```",
  "┌── cell ─ \"Read the project README\" ───────────────────-──┐",
  "│                                                          │",
  "│    # One step cell                                       │",
  "│    await read({\"file_path\": \"docs/README.md\"})          │",
  "│                                                          │",
  "└──────────────────────────────────────────────────────────┘",
  "```",
  "",
  "To execute it via the only `ipython` entrance:",
  "",
  "  { \"name\": \"ipython\", \"arguments\": { \"cell\": \"await read({\\\"file_path\\\": \\\"docs/README.md\\\"})\", \"description\": \"Read the project README\" } }",
  "",
  "Never call tools directly as a function-call like:",
  "",
  "  ❌ ~~{ \"name\": \"read\", \"arguments\": { \"file_path\": \"docs/README.md\", \"description\": \"Read the project README\" } }~~",
  "",
  "",
  "## Examples",
  "",
  "```python",
  "# One step cell",
  "print(await read({\"file_path\": \"docs/README.md\"}))",
  "",
  "# shell is just another typed callable",
  "r = await bash({\"command\": \"ls -la src/\", \"description\": \"List source directory\"})",
  "print(r[\"stdout\"][\"text\"])",
  "",
  "# typed tools in script",
  "for old in (\"DEBUG = False\", \"DEBUG=False\"):",
  "    try:",
  "        await edit({\"file_path\": \"src/config.py\", \"old_string\": old, \"new_string\": \"DEBUG = True\"})",
  "        break",
  "    except ToolCallError as e:",
  "        print(f\"retrying ({e})\")",
  "",
  "# import, fan-out with gather",
  "import asyncio",
  "matches, files = await asyncio.gather(",
  "    grep({\"pattern\": \"TODO\", \"path\": \"src\"}),",
  "    file_glob({\"pattern\": \"**/*.ts\", \"path\": \"src\"}),",
  ")",
  "",
  "# variables persist across cells and turns — the kernel is your working memory",
  "cfg = await read({\"file_path\": \"config.yaml\"})   # cfg stays alive in later cells",
  "child = await rlm({\"mode\": \"spawn\", \"prompt\": \"summarize the failing tests\", \"label\": \"summarizer\"})",
  "print(child[\"subagentId\"])                        # background admission — keep working",
  "```",
  "",
  "## Rules",
  "",
  "- Do not assume IPython is the native runtime of the external thing being investigated. Evaluate external systems through their own interface, then use IPython to coordinate the process and analyze what comes back.",
  "- Only print or return what you need next; everything else stays in the kernel.",
  "- Variables persist across cells and turns, but they live in the kernel",
  "  subprocess: keep durable state in files or the Continual Harness (refine",
  "  writes it).",
].join('\n')
