# Dashr: RLM Plugin for DSH

<p align="center">
  <a href="https://github.com/fgm-builds/dashr/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License" /></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/plugin%20for-dsh-blueviolet.svg?style=flat-square" alt="dsh plugin" /></a>
  <a href="https://npmjs.com/package/dsh-rlm-mode"><img src="https://img.shields.io/badge/npm-dsh--rlm--mode-CB3837.svg?style=flat-square&logo=npm" alt="npm package" /></a>
  <a href="https://arxiv.org/abs/2512.24601"><img src="https://img.shields.io/badge/arXiv-2512.24601-B31B1B.svg?style=flat-square" alt="arXiv:2512.24601" /></a>
  <a href="https://github.com/fgm-builds/dashr"><img src="https://img.shields.io/badge/github-fgm--builds%2Fdashr-black.svg?style=flat-square&logo=github" alt="Repository" /></a>
</p>

---

## ⚡ Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/fgm-builds/dashr/main/install.sh | bash
```

### Alternative: DSH Plugin CLI (NPM)

```bash
dsh plugin --profile web add dsh-rlm-mode
```

> After installation, launch `dsh web` and select the **Dashr** agent preset.

---

## 📖 Overview

DeepSeek Harness (`dsh`): Everything is a plugin (Cordis framework).  
Prime Agent: Context is variable (RLM paradigm).  
**Why not both?** That's `dsh` in RLM mode — that's **Dashr**.

**Dashr** is an open-source plugin for the [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) agent runtime. It brings **RLM (Recursive Language Models)** and the **"Context is Variable"** paradigm to `dsh`, registering a dedicated `rlm-mode` agent preset upon installation.

Instead of paying massive token costs on every round-trip tool call in standard multi-turn chat, Dashr equips the agent with a **stateful, persistent Python kernel**. The agent writes self-contained Python programs per cell, manipulating context, tools, and memory as native variables.

---

## 💡 RLM

Reference: [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)

### 1. Context is Variable (Stateful Kernel)
In standard agent loops, reading large files or computing complex payloads dumps raw output directly into the conversation history. In Dashr:
- State and computation persist inside a live IPython kernel session.
- Intermediate variables survive across cells without re-entering the prompt.
- Tools are exposed as first-class Python functions (`tools.<name>()`). Intermediate execution data never round-trips through the prompt.

### 2. Recursive Sub-Agents (`rlm()`)
The core mechanism of **Recursive Language Models**:
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
- ⚡ **Dynamic Tool Binding** — Zero hardcoded tool adapters. At startup, Dashr dynamically binds all tools registered in the `dsh` host (`bash`, `web_search`, file operations, workflows, skills, etc.) into type-safe Python SDK functions under `tools.*`.
- 🔀 **In-Kernel Recursive Sub-Agents** — Call `rlm(task)` to spawn parallel sub-agents and `rlm_await(id)` to collect results inside Python code.
- 🧠 **Dynamic Harness & Compaction** — Built-in `refine()` for operating memory and `compact()` for context reduction under pressure.
- 💾 **State Snapshot & Revival** — Save and restore the kernel namespace across sessions.
- 🔄 **Upstream-Proof Preset** — The `rlm-mode` agent preset dynamically includes `dsh`'s standard composition, staying compatible whenever upstream `dsh` introduces new capabilities.

---

## 🔒 Security Model

- **Tool Governance**: Calls to `tools.*` run through `dsh`'s host tool pipeline, where approval and sandbox policies apply normally.
- **Kernel Code Execution**: Python code inside cells executes with the permissions of the local user running `dsh`. Run Dashr in environments where you trust the agent's code execution against your user account (or run `dsh` within a container).

---

## 📚 References & Academic Credit

The design of Dashr builds upon groundbreaking research in recursive agent execution and persistent prompt harnesses:

1. **Recursive Language Models (RLM)**  
   *Recursive Language Models*, 2025.  
   Paper: [arXiv:2512.24601](https://arxiv.org/abs/2512.24601)  
   *Establishes the recursive decomposition and sub-agent execution paradigm for ultra-long context and bounded prompt management.*

2. **Continual Harness & Prompt Refinement**  
   *Continual Harness for Autonomous Agents*, 2026.  
   Paper: [arXiv:2605.09998](https://arxiv.org/abs/2605.09998)  
   *Formulation for dynamic prompt refinement and in-loop compaction.*

---

## 🙏 Acknowledgements & Attribution

Dashr is built as an open-source plugin for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).

While Dashr's codebase was developed independently from scratch for the `dsh` plugin ecosystem, the core design and philosophy are deeply inspired by the pioneering work of **[Prime Agent](https://github.com/primeintellect-ai/prime)** by Prime Intellect. We pay tribute to their introduction of the **"Context is Variable"** paradigm and the **Recursive Language Model (RLM)** execution model, which inspired us to bring these breakthrough capabilities to the `dsh` agent community.

### ⚖️ License & Compatibility
Both **Dashr** and upstream inspiration **Prime Agent** are licensed under the permissive **[MIT License](https://opensource.org/licenses/MIT)**. Dashr is fully open-source and license-compliant without IP or licensing conflicts.

---

## 📄 License

This project is licensed under the [MIT License](./LICENSE).
