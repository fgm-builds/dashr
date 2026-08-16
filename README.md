# Dashr: Recursive Language Model (RLM) Plugin for DSH

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/plugin%20for-dsh-blueviolet.svg?style=flat-square" alt="DSH Plugin" /></a>
  <a href="https://npmjs.com/package/dsh-rlm-mode"><img src="https://img.shields.io/badge/npm-dsh-rlm-mode-CB3837.svg?style=flat-square&logo=npm" alt="npm package" /></a>
  <a href="https://arxiv.org/abs/2512.24601"><img src="https://img.shields.io/badge/paper-arXiv%3A2512.24601-B31B1B.svg?style=flat-square" alt="Paper arXiv:2512.24601" /></a>
  <a href="https://github.com/fgm-builds/dashr"><img src="https://img.shields.io/badge/github-fgm--builds%2Fdashr-black.svg?style=flat-square&logo=github" alt="Repository" /></a>
  <a href="https://github.com/fgm-builds/dashr/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License" /></a>
</p>

---

## ⚡ Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/fgm-builds/dashr/main/install.sh | bash
```

### Alternative: DSH Plugin CLI (NPM)

```bash
dsh plugin --profile web add dashr-plugin
```

> After installation, launch `dsh web` and select the **DASHR** agent preset.

---

## 📖 Overview

**Dashr** is an open-source plugin for the [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) agent runtime. It equips DSH with the **Recursive Language Model (RLM)** interaction paradigm and the **"Context is Variable"** architecture, registering a dedicated `dashr` agent preset upon installation.

Instead of paying massive token costs on every round-trip tool call in standard multi-turn chat, Dashr equips the agent with a **stateful, persistent Python kernel**. The agent writes self-contained Python programs per cell, manipulating context, tools, and memory as native variables.

```
cell 1:  df = tools.read("large_dataset.csv").as_dataframe()   # data stays in kernel memory
cell 2:  summary = df.describe().to_dict()                     # intermediate computation survives
cell 3:  tools.write("report.json", summary)                   # zero prompt context pollution
```

---

## 💡 Background & RLM Architecture

Large Language Models (LLMs) operate under strict context window limits. Even with extended window sizes, standard agent architectures suffer from **quadratic attention overhead, distraction, and context dilution**.

Dashr implements the **Recursive Language Model (RLM)** architecture ([arXiv:2512.24601](https://arxiv.org/abs/2512.24601)) to solve this bottleneck:

```
┌────────────────────────────────────────────────────────────────────────┐
│                          DSH Agent Runtime                             │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                    Dashr Plugin & Preset                       │   │
│   │                                                                │   │
│   │  1. Stateful Python REPL Kernel ("Context is Variable")        │   │
│   │     • In-memory DataFrames, ASTs, file handles, API responses  │   │
│   │     • Zero round-trip prompt pollution for intermediate data   │   │
│   │                                                                │   │
│   │  2. Sliding Context Window                                     │   │
│   │     • Fixed-size active window to bound token overhead         │   │
│   │                                                                │   │
│   │  3. Recursive Sub-Agents (`rlm("subtask")`)                   │   │
│   │     • Spawns child agents in isolated context loops            │   │
│   │     • Returns only synthesized, distilled outcomes             │   │
│   │                                                                │   │
│   │  4. Context Compaction & Summarization                         │   │
│   │     • Evicted window steps are recursively summarized          │   │
│   │     • Long-term trajectory retained via dynamic memory/harness │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### 1. Context is Variable (Stateful Kernel)
In standard agent loops, reading large files or computing complex payloads dumps raw output directly into the conversation history. In Dashr:
- State and computation persist inside a live IPython kernel session.
- Intermediate variables survive across cells (`cell 1: data = load(); cell 2: res = process(data)`).
- Tools are exposed as first-class Python functions (`tools.<name>()`). Intermediate execution data never round-trips through the prompt.

### 2. Recursive Sub-Agents (`rlm()`)
The core mechanism of **Recursive Language Models (RLM)**:
- For token-heavy or exploratory subtasks, the agent spawns child agents (`handle = rlm("Investigate repository history")`).
- Sub-agents operate recursively in their own isolated context loops.
- When finished, `rlm_await(handle)` collects only the final distilled summary back into the parent kernel.

### 3. Sliding Context Window
- Even without spawning sub-agents, Dashr maintains a bounded sliding context window over recent turns.
- Prevents context degradation and eliminates context window saturation on long workflows.

### 4. Compaction & Summarization
- Earlier turns that fall outside the active sliding window are automatically compressed into structured summaries (`compact()`).
- High-level progress, key decisions, and operating guidance are preserved in a dynamic harness (`refine()`) and reinjected into the prompt.

---

## ✨ Features

- 🐍 **Persistent IPython Kernel** — One stateful kernel session per conversation. Variables, imports, and connections persist across cells.
- ⚡ **Dynamic Tool Binding** — Zero hardcoded tool adapters. At startup, Dashr dynamically binds all tools registered in the DSH host (`bash`, `web_search`, file operations, workflows, skills, etc.) into type-safe Python SDK functions under `tools.*`.
- 🔀 **In-Kernel Recursive Sub-Agents** — Call `rlm(task)` to spawn parallel sub-agents and `rlm_await(id)` to collect results inside Python code.
- 🧠 **Dynamic Harness & Compaction** — Built-in `refine()` for operating memory and `compact()` for context reduction under pressure.
- 💾 **State Snapshot & Revival** — Save and restore the kernel namespace across sessions.
- 🔄 **Upstream-Proof Preset** — The `dashr` agent preset dynamically includes DSH's standard composition, staying compatible whenever upstream DSH introduces new capabilities.

---

## 🔒 Security Model

- **Tool Governance**: Calls to `tools.*` run through DSH's host tool pipeline, where approval and sandbox policies apply normally.
- **Kernel Code Execution**: Python code inside cells executes with the permissions of the local user running DSH. Run Dashr in environments where you trust the agent's code execution against your user account (or run DSH within a container).

---

## 🧪 Development & Testing

```bash
# Build & run test suite (140 tests passing)
cd dashr
npm install
npm test
```

---

## 📚 References & Academic Credit

The architecture and design of Dashr build upon groundbreaking research in recursive agent execution and persistent prompt harnesses:

1. **Recursive Language Models (RLM)**  
   *Recursive Language Models*, 2025.  
   Paper: [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)  
   *Establishes the recursive decomposition and sub-agent execution paradigm for bounded context management.*

2. **Continual Harness & Prompt Refinement**  
   *Continual Harness for Autonomous Agents*, 2026.  
   Paper: [arXiv:2605.09998](https://arxiv.org/abs/2605.09998)  
   *Foundational formulation for dynamic prompt refinement and in-loop compaction.*

---

## 🙏 Acknowledgements & Attribution

Dashr is built as an open-source plugin for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).

While Dashr's codebase was developed independently from scratch for the DSH plugin ecosystem, the core design and philosophy are deeply inspired by the pioneering work of **[Prime Agent](https://github.com/primeintellect-ai/prime)** by Prime Intellect. We pay tribute to their introduction of the **"Context is Variable"** paradigm and the **Recursive Language Model (RLM)** execution model, which inspired us to bring these breakthrough capabilities to the DSH agent community.

### ⚖️ License & Compatibility
Both **Dashr** and upstream inspiration **Prime Agent** are licensed under the permissive **[MIT License](https://opensource.org/licenses/MIT)**. Dashr is fully open-source and license-compliant without IP or licensing conflicts.

---

## 📄 License

This project is licensed under the [MIT License](./LICENSE).
