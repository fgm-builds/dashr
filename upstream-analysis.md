# DASHR 上游源码分析（dsh × prime-agent）

> 日期：2026-08-16 · 工具：Graphify (graphify-http-mcp :4749, AST 模式)
> 用途：DASHR 自研运行时选型底图。两部分来源 + 结合方式蓝图见后续文档。

## 0. 前置事实

| 项 | deepseek-harness (dsh) | prime-agent (PI) |
|---|---|---|
| Clone | `dashr/deepseek-harness` @ `47f9438` (2026-08-13, npm-public PR #2519) | `dashr/prime-agent` @ `97b994c` (2026-08-14, daemon spawn ledger #1387) |
| 语言主体 | TypeScript (ESM), Node ≥22.19 / ≥24 | TS host + Python runtime（模型面 Python，调度面 TS） |
| 规模 | ~85MB 源码, 2319 ts + 19 py | ~30MB, 925 ts + 23 py（+runtime） |
| pnpm workspaces | `packages/<group>/<pkg>` 两级, 50 组 ~230 包 | `packages/{agent,ai,coding-agent,tui}` 4 包 + `prime-agent-runtime/` (py) |
| 许可 | MIT（预发布期承诺） | MIT |

## 1. Graphify 图谱（AST，无 LLM 语义增强）

| 指标 | dsh | prime-agent |
|---|---|---|
| nodes | 54,318 | 13,676 |
| edges | 72,496 | 29,765 |
| communities | 4,110 | 775 |
| code 节点 | 33,026 | 10,784 |
| graph.json | 44.9 MB | 15.4 MB |

产物：各库 `graphify-out/{graph.json, GRAPH_REPORT.md, manifest.json}`。
graph.html 因 >5000 节点未生成（GRAPHIFY_VIZ_NODE_LIMIT），交互视图需切子图或提限。
增量更新：`update_graph(project_path)`；Graphify 缓存于 `graphify-out/cache/`。

`.graphifyignore` 已写入两库（排除 node_modules/.git/dist/test fixtures/snapshots）。

## 2. deepseek-harness 结构

### 2.1 布局（依据 AGENTS.md + 实测目录）

```
vendor/      vendored Cordis 内核（manifest+sync procedure）
packages/    @deepseek-ai/dsh-<name>，50 组 ~230 包
  core/        agent, agent-loop, session, system-prompt, tools, scope
  llm/         llm, llm-deepseek, llm-pi-ai, llm-retry, token-meter
  subagent/    subagent + acp/claude-code/codex/dsh-sdk/fork-in-process/... 11 包
  其他能力组:  fs, shell, subprocess, terminal, lsp, skill, web, mcp, acp,
               compaction, context, workflow, todo, plan, preset, guard,
               self-modification, hooks, session, identity, settings,
               credentials, interaction, boot, sdk, typert, api, sandbox, ...
apps/       cli + web
python/     Python SDK + bundled runtime
native/     node-addon-landlock-run（Landlock 沙箱 addon）
.agents/    notes/（设计笔记，一手取证源）
docs/       architecture, cordis-api, postmortem, subsystems
```

### 2.2 图谱枢纽（god_nodes, by degree）

- `Context` (790) — Cordis 上下文，全库交汇点
- `InvariantInstaller` (216), `Service` (138) — 插件注册骨架
- `createSnapshotStore()` (97), `SnapshotStore` (79), `bindSnapshotSelector()` (88) — 会话快照存储链
- `launchWebScaffold()` / `WebScaffold` / `watchConsole()` — web 测试脚手架
- tsconfig `paths` (139) + package `scripts` (124) — workspace 胶水节点多，体现 monorepo 复杂度

### 2.3 关键机制（docs/cordis-api 图谱查询 + AGENTS.md）

- 插件注册原语：`ctx.plugin()` / `ctx.inject()` / `Registry`（docs/cordis-api/registry.md）
- Registrations are effects：所有贡献走 `ctx.effect()` / `ctx.on()`，`register()` 返回 disposer（时空可组合性的实现基础；即 Cordis 论文「可逆效应」机制，论文仓库 `github.com/cordiverse/paper`，解读见 deepseek-dsh.md §1.4）
- 能力三层拆分：Service Definition（接口）/ provider（实现）/ Consumer（消费者）→ 换实现不动消费者
- per-session preset：`preset/` 包，agent.cordis.yml 组装，会话锁 `agent-preset-locked`

## 3. prime-agent 结构

### 3.1 布局

```
packages/
  agent/         5 文件：agent-loop.ts, agent.ts, proxy.ts, types.ts（薄）
  ai/            provider 层：api-registry, bedrock, stream, oauth,
                 models.generated, openrouter-reasoning, mcp
  coding-agent/  主体：src/core/{kernel, tools, session-manager, ...}
                 skills/（Python 技能：rlm, refine, compact, goal, edit,
                 websearch, agent-message, rlm-heartbeat, ...）
  tui/           终端 UI
prime-agent-runtime/   Python 侧 RLM runtime
  src/rlm/{__init__, harness, skill, mcp_base}.py
  test/           subagent_registry, mcp_base, agent_message_skill, harness
```

### 3.2 图谱枢纽（god_nodes）

- `AgentSession` (430) — 核心会话对象
- `InteractiveMode` (388), `TUI` (139), `Component` (134) — 交互层重
- `AgentDaemon` (184), `DaemonSupervisor` (134), `DaemonAgentConnection` (122) — daemon 体系（最新 commit 正是 supervisor-owned rlm spawn ledger）
- `SettingsManager` (172), `SessionManager` (108)

### 3.3 关键链路（query_graph 取证）

**子 agent spawn（rlm()）**：
`rlm/__init__.py` → `run()` → `host_request()`（comm 通道发 TS host）→ `_spawn_handle_from_payload()` → `RLMSpawnHandle`；Python 侧 `HarnessState/HarnessScope/HarnessEntry/RefinementEvent`（harness.py, community 70/90）构成 Continual Harness 状态。TS 侧 `fork-server.ts SpawnParams`（community 157）承接。

**IPython kernel（Context as Variable）**：
- `core/tools/ipython.ts`：`IpythonKernelProvisioner` → `.startKernel()` / `.ensure()`
- `core/kernel/index.ts` `KernelManager`：`.doStart()`, `.enqueueExecute()`, `.runIopubPump()`, `.handleExecutionMessage()`, `.shutdown()`
- 状态持久化：`state-snapshot.ts` `.snapshotState()` / `.restoreState()` / `RestoreResult`（community 217）→ 变量级 checkpoint
- fork：`fork-server.ts` `forkKernel()`（community 157，与 SpawnParams 同社区 → fork 复用 kernel 状态）

## 4. 结合面初步观察（待蓝图输入）

| 维度 | 取 dsh | 取 prime-agent |
|---|---|---|
| 内核/装配 | Cordis 插件体系, preset, 能力三层 | — |
| 模型面 | — | 持久 IPython kernel + state-snapshot |
| 子 agent | subagent 11 包矩阵 | `rlm()` 函数式 + fork-server |
| 记忆 | — | Continual Harness (ρ,G,K,M) |
| 沙箱 | bwrap+Landlock (native addon) | — |
| LLM 接入 | llm-deepseek/pi-ai/retry/token-meter | ai/ 包多 provider |

风险点：两库语言运行时不同（dsh 纯 TS vs PA 模型面 Python）；结合方式决定桥接层（PA 式 comm channel 或 dsh 式 in-process SDK）。

## 5. 图谱查询备忘

MCP endpoint `http://127.0.0.1:4749/mcp`（Streamable HTTP, 需 `Accept: application/json, text/event-stream`）。
`graph_path` 参数 = `graphify-out/` 目录（含尾 graph.json 解析）。常用：
`graph_stats / god_nodes / query_graph / get_neighbors / shortest_path / graph_affected(影响面) / graph_tree / surprising_connections`。

增量：代码改动后 `update_graph`；LLM 语义增强需 API key（可选 gemini）。

## 6. 相关档案

- 调研/实测：`agent-harness/21_CLI-Agent/03_deepseek-dsh/deepseek-dsh.md`
- `agent-harness/21_CLI-Agent/04_prime-agent/prime-agent-{research,deployment-experiment,rlm-analysis,paradigm-discussion,continual-harness}.md`
