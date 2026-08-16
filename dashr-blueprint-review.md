# DASHR 蓝图评审 v1.0 — 对 dashr-blueprint.md v0.3

> 日期：2026-08-16 · 评审对象：`dashr-blueprint.md` v0.3（2026-08-16）
> 方法：不评观点、评证据——蓝图引用的每处"源码证据"到两个 clone
> （`deepseek-harness @47f9438` / `prime-agent @97b994c`）逐条核实，
> 再核对推理是否用满了证据。讨论底稿为 2026-08-16 会话，本文为其档存。
> 一句话结论：**方向判断与证据链质量高，抽查引用全部属实；另发现 4 处
> 上游利好、1 处被低估的明文契约冲突、4 个蓝图未触到的决策点。**

## 0. 验证记录（蓝图引用核实）

| 蓝图引用 | 出处（clone 内实读） | 结果 |
|---|---|---|
| `CodeRunRequest.program` = async function body，一次性 run | `packages/code-runtime/code-runtime/src/types.ts` | ✅ |
| `RunCodeFlavor` 按 language 注册、`PYTHON_FLAVOR` 已存在 | `packages/core/tools/src/code-mode.ts`（`RUN_CODE_FLAVORS` + `resolveFlavor`） | ✅ |
| worker provider = 标准 Cordis 插件（Context + schemastery z） | `code-runtime-worker-thread/src/index.ts` | ✅ |
| provider 已 import `snapshotJsonValue` from `@deepseek-ai/dsh-session` | 同上 L18 | ✅ |
| preset 会话锁 `agent-preset-locked` | `packages/host/apiproxy/src/*`；agent-presets README | ✅ |
| PA `KernelManager` 构造参数（sessionId/hostHandlers/pythonSkills/snapshot） | `prime-agent/.../core/kernel/index.ts` L160-164, L625 | ✅ |
| state-snapshot.ts 297 行；1500ms debounce；cleanup → `shutdown({snapshot:true})` | 同上（wc=297；L151；L551-565） | ✅ |

---

## 1. 核心异议：run 隔离是**明文契约**，不是"隐含假设"（风险表第 1 条需改写）

`CodeRuntime` 抽象类 doc（`code-runtime/src/index.ts`）对实现者的明文要求：

> "Implementations bridge structured-cloneable bindings, materialize each
> declared namespace rejection class, **treat programs as hostile peers,
> isolate runs from one another**, and terminate and await in-flight runs
> during disposal."

蓝图 §5 风险表第 1 条把它写成"契约**隐含**一次性 run"——低估了严重性。
run 间隔离是 Service Definition 的书面 invariant，DASHR 的立身之本
（跨 run 持久 namespace）**直接与之抵触**。后果：

- "provider 可替换、Consumer 零改动"在**机械层面**成立（接口签名满足），
  在**语义层面**是违反书面契约的第三方实现——恰恰是最容易在上游升级时
  静默坏掉的那类（上游按契约优化 Consumer/清理逻辑时不会通知违约者）。

**处置选项**：

| 路线 | 说明 | 评估 |
|---|---|---|
| A（推荐） | 上游提 issue/PR：给 Service Definition 加 `stateful` / `sessionAffinity` capability descriptor | 时机好——kernel 文件首行官方 TODO（"RLM-1 weights 落地后重估 persistent kernel vs stateless python -c"）说明上游本就在想此方向，DASHR 是现成数据点。M1 即启动对话 |
| B | 插件私有分叉契约、文档化 divergence | 可行但脆弱，升级靠人肉 re-verify |
| C | 换 service 名（如 `ctx.kernelRuntime`）自立门户 | 失去 Consumer 零改动红利，不推荐 |

蓝图动作：§5 风险表第 1 条"缓解"从"M1 实测"升格为"M1 实测 **+ 上游
stateful descriptor 对话启动**"。

## 2. 利好：上游比蓝图以为的更友好（4 项，可入蓝图加强论证）

### 2.1 Python 是预留 portability target，不是蹭道

`PORTABLE_RESERVED_WORDS` 注释（`code-runtime/src/index.ts`）：

> "Python is a portability target here **even though only the TypeScript
> worker has a published backend**."

### 2.2 Python backend 的 bootstrap wrapper 上游已设计过

`RESERVED_BINDING_GLOBALS` 含 `__dsh_main__` / `__builtins__` / `__name__`，
注释明说 reserved for "the Python backend's bootstrap wrapper and seeded
module globals"。即 **async-function-body 契约到 Python 的 wrapper 适配
上游已有设计稿**——§1.1 "cell 语义兼容函数体契约"论证可直接引这条，
比现有论证更硬。

### 2.3 `mode: 'code'` / `'both'` 是内置机制，§7.2 "唯一界面"免费获得

`py-types.ts` 头部：

> "Under `mode: 'code'` the native tool schemas are omitted from the
> request, so this generated SDK is the model's ONLY source... under
> `mode: 'both'` the native schemas ship alongside it."

§7.2 设想的"以 IPython kernel 为唯一工具界面的第五 preset"无需自研
schema 抑制机制——组 `mode: 'code'` 的 preset 即可。这同时消解了
"原生工具 + run_code 双界面导致模型重复调用"的潜在隐患。

### 2.4 工具桥比蓝图估的便宜，风险表可降级

`code-mode.ts` 头部：

> "Programs call the registry's agent-visible tools through **nested
> executions scheduled under the native concurrency contract**; each
> sub-dispatch is **logged for reconstruction**, while only the outer
> curated result enters model history."

嵌套执行调度 + 审计 logging 全在 **Consumer 侧**（不用 provider 重做）。
provider 只需把 `CodeBindingNamespace[]` 物化为 Python async 函数
（JSON in/out，与 PA `host_request` 同形）。§5 风险表"工具桥并行语义"
可从 中 降为 低-中。

## 3. 决策点：完成值语义（PA repr 习惯 vs dsh fail-the-run 契约）

`types.ts`（`CodeRunResult.value` doc）：

> "Invalid or over-limit completions **fail the run instead of
> substituting a rendered string**."

- PA 范式：cell 最后表达式的 repr 自动展示（`df` 直接可见）
- dsh 契约：`return df` → `invalid-output` **run 失败**
- `PYTHON_FLAVOR` schema 文案已在训练模型 "only that comes back, so
  curate it"，但 PA 迁移来的习惯会踩坑

**建议**：严格守约（与上游一致），在 py-types SDK instructions 层补一条
PA→dsh 迁移提示（"repr 不会自动展示；显式 print/repr 或 return 可 JSON
化的小结"）。**不建议** wrapper 兜底 repr——违反契约字面义，回到 §1
违约实现的老路。

## 4. 决策点：`'worker-exit'` 与 abort 在持久 kernel 上被放大

- worker-thread 死了丢**一次 run**；kernel 死了丢**整个会话的变量**，
  且模型还以为 `df` 存在（上下文无感知）
- 好在 PA `KernelManager` L163 已有 "Persist/revive the user namespace
  across kernel **restarts** and session resume"
- DASHR 应把以下写成明确行为：**kernel death → 从 snapshot 自动 revive
  → error message 告知模型"namespace 已从 turn-N 快照恢复，最近 K 轮
  变量操作需重放"**
- abort：dsh 契约要 "hard, even mid-loop"；IPython interrupt 是控制通道
  **软**中断（C 扩展内不可中断；PA L46 有 busy-kernel 提示文案）。
  需要 interrupt → grace → restart(revive) 升级策略，建议进 §8 设计

## 5. 蓝图未触：子代理继承 preset 的连带效应

agent-presets README：

> "A subagent's child joins its parent's standing composition through
> `composeFrom()`, never through `mount()`."

即 dsh subagent **继承父 composition**——rlm() 派生的每个子代理都会挂
DASHR provider。若 kernel 非 lazy，一次并行 rlm() ×N = N 个 IPython
kernel 子进程。

- **要求**：kernel 必须 **lazy-start**（首个 run_code 才拉起；PA
  `IpythonKernelProvisioner.ensure()` 已是此形态）——建议写进 §9 与 M3
- **反面是机会**：子代理跑的是新 kernel，变量不共享——这反而抬高了
  phase 2 fork-server（复用父 kernel 状态）的接入价值

## 6. §8 快照一致性可以再进一步

- 1500ms debounce + 崩溃 ⇒ snapshot 必然落后 transcript 若干 turn；
  dsh 若支持历史编辑/中途回滚，dill 是**不透明 blob**、无法随 transcript
  回滚
- 建议蓝图明确一句：**变量态与 transcript 非事务一致；resume 以
  snapshot + manifest（python 版本/venv/skills 清单）校验为准，不匹配则
  降级为空 namespace 并告知模型**
- 大对象（GB 级 DataFrame）× 1500ms debounce = IO 风暴：现有"serialize
  黑名单"建议升格为 **size-cap + turn-end snapshot 混合策略**，列为
  M3 设计点

## 7. 勘误两处

1. §7.2 "四个运行模式（standard/minimal/code/creator）"：本次抽查仅在
   `packages/preset/agent-presets/tests/fixtures/` 核实了
   standard/minimal；code/creator 两个名字未在 clone 的 `packages/preset`
   内定位（可能在 apps/cli 或发布版文档）。不影响结论，引用出处建议修准。
2. §7.2 "包名规约 `@deepseek-ai/dsh-<name>` 系"：那是**官方包**的 npm
   scope，第三方不能发布。DASHR 应用自有 scope（如
   `@<user>/dashr-code-runtime-ipython`）；`dsh plugin add <pkg>` 对任意
   npm 包成立，不受影响。

## 8. 里程碑验收补充

- **M1 加四项**：
  1. 并行 run_code ×2 的行为（`enqueueExecute` 串行化 + 结果归属正确）
  2. abort 中断后 namespace 一致性
  3. session end 时 disposer → `shutdown({snapshot:true})` 落盘验证
  4. 上游 stateful descriptor 的 issue/PR 发出（对应 §1 路线 A）
- **M3 加两项**：
  1. lazy-start 要求落地
  2. 子代理 kernel 计数断言（rlm() ×3 后宿主 kernel 数 ≤1）

## 9. 待决清单（需用户拍板）

| # | 决策 | 选项与倾向 |
|---|---|---|
| 1 | 契约冲突处置路线（§1） | A 上游 descriptor PR（推荐）/ B 私有分叉 / C 换 service 名 |
| 2 | 完成值语义（§3） | 严格守约 + SDK 迁移提示（推荐）/ wrapper 兜底 repr |
| 3 | lazy-start 是否作为 M3 硬性要求（§5） | 建议是 |
| 4 | 包名 scope（§7.2） | 自有 scope（建议），具体名待定 |
| 5 | §7.2 四模式表述出处修准（§7） | 待定位 code/creator 实际出处后改写 |

---

## 附：与蓝图章节的对应

| 本文章 | 对应蓝图章节 | 性质 |
|---|---|---|
| §1 | §5 风险表第 1 条 | 改写（严重性升格） |
| §2 | §1.1 / §7.2 | 加强论证 |
| §3 | （新） | 决策点 |
| §4 | §5 / §8 | 补充设计 |
| §5 | §9 / §6 M3 | 补充要求 |
| §6 | §8 | 收紧定义 |
| §7 | §7.2 | 勘误 |
| §8 | §6 | 验收补充 |

下一步二选一：本文保持独立评审档、蓝图另行吸收出 v0.3.1；或直接把
待决清单拍板后合并。默认前者（评审与蓝图分层，便于追溯）。
