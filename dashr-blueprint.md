# DASHR 架构蓝图 v0.5 — RLM 运行时（与内建编码模式同级的第五 preset）

> 日期：2026-08-16 · 状态：M1 ✅、M2 ✅（2026-08-16 交付并三重验收：③④⑤⑥⑦ 全落，
> presentation 57/57 + dashr 24/24 绿、preset 真挂载冒烟、PTC 共存真 worker-thread 实证、
> 发布形态 tarball 装包+消费者 typecheck 全过、零孤儿）；M3-A ✅（键控+lazy+中断竞态，2026-08-16 验收）、
> M3-B ✅（rlm() binding + turn-end 快照/restore + 死亡 revive 链，2026-08-16 验收）、M4-A ✅（子代理模型三级优先级 + N1/N2 加固，2026-08-16 验收）、
> M4-B ✅（Continual Harness + refine()/compact() + refineModel/compactModel 拆键 + compactModel→scoped 引擎映射（设计 A），2026-08-16 验收：Verifier PASS + 父代理验收，P1 选择子前导斜杠边界修复，presentation 100/100）。
> M3 新增两项 P1 硬性项（§5 风险表升级 + §6 M3 验收补充）。§7.4.1 勘误（realm 实测语义）。
> v0.5：定位升级（用户拍板）——vendored Service Definition + 自有键
> `rlmRuntime` + 自有 presentation plugin。与内建编码模式（code preset）同级、
> 同规则；不再注册 `codeRuntime` 键。§1.2 契约冲突因此消解（§7.6）。
> v0.4.1：§7.4 DASHR 模式 + 工具两层策略。v0.4：peer review 吸收 + §10 实现定案。
> 演进：v0.1 三层分层 → v0.2 单插件中间层。
> 决策者：用户。

## 0. 方案形态（用户 2026-08-16 修订思路）

```
dsh 原有上下游（完全不动）
├─ Web UI / CLI / Cordis host / skills / MCP / sandbox / session log
└─ packages/code-runtime ── Service Definition: ctx.codeRuntime
        ▲ provider 接口（现挂 worker-thread JS 后端）
        │
┌───────┴────────────────────────────────────┐
│ DASHR 中间层（一个 Cordis 插件，仿既有 provider 模式）│
│  ① ipython provider：持久 IPython kernel 子进程     │
│     （PA KernelManager 原样，Python）               │
│  ② tool→binding 桥：dsh 工具注册表 → Python SDK     │
│  ③ rlm() binding：dsh subagent 能力 → Python 函数   │
│  ④ state-snapshot：kernel namespace 持久化         │
└────────────────────────────────────────────┘
```

原则：**"只要它变成 dsh 的 Skill / MCP / tool，DASHR 就在 provider 边界
把它代码化"**（用户原话思路）。dsh 上层管理、下层装配全部不改。

## 1. 决定性证据：dsh code-runtime 就是为此设计的接缝

`packages/code-runtime` README + `.agents/notes/implemented/feature/2026-06-15-code-mode.md`：

- Service Definition = "执行一段模型写的程序，对抗 host 提供的 async bindings，
  捕获 print 与 return" —— 与 PA kernel 语义同构
- **provider 可替换**：现挂 `code-runtime-worker-thread`（JS）。
  DASHR = 新增 `code-runtime-ipython` provider，Consumer（`run_code` 工具 +
  按语言生成 SDK）零改动
- dsh 已有"工具注册表 → SDK 生成"机制（Code Mode TS SDK 生成器）→
  tool→Python binding 桥的最大构件可复用

### 1.1 契约取证：双通道而非替换（2026-08-16 补充，v0.2.1）

直读 `docs/subsystems/code-runtime.md` + `core/tools/src/code-mode.ts`：

- `CodeRunRequest.program` 契约 = **"runs as the body of an async function"**：
  每次 run_code 是一次性程序运行，无跨调用状态。dsh Code Mode 是
  **编排代码化**（一次写程序批量调工具，减少往返）
- PA kernel 是**状态代码化**（`x=5` 跨 cell 存活，变量即上下文）。
  两者语义不同层，IPython provider 不是 TS Code Mode 的替换，是第二条通道

| 通道 | 语义 | 状态模型 | 来源 |
|---|---|---|---|
| ① dsh Code Mode（TS） | 编排代码化 | 每次 run 独立程序 | dsh 原生，保留不动 |
| ② IPython kernel provider | 状态代码化 | 跨 run 持久 namespace | DASHR 新增 |

**② 的可行性依据**：
- `language` 是 Service Definition 只读描述符；`RunCodeFlavor` 按 language
  注册（`code-mode.ts` L82-127），未写死 TS。新 provider 注册
  `language: "python"` 后，模型可见的 `run_code` schema 自动切换 python
  flavor——模型看到的即 IPython cell 界面（与 PA 原生一致）
- binding namespace 跨语言移植规则已定义（保留字 = ECMAScript ∪ Python
  并集，`[A-Za-z_][A-Za-z0-9_]*`）——JS-only 命名（如 `$tools`）被设计性拒绝
- cell 语义兼容函数体契约：IPython cell 本就是可作函数体执行的表达式/语句序列

**② 是有状态 provider，超出 worker-thread 先例**：多个 run_code 请求打到
同一 kernel 实例（每次 program 作为一个 cell 喂 `enqueueExecute()`），kernel
生命周期挂 session（`KernelManager` 构造参数即 `sessionId`）。

### 1.2 契约冲突的真实等级与处置（v0.4，peer review §1 升格）

`CodeRuntime` 抽象类 doc 对实现者的**明文 invariant**（不是"隐含假设"）：

> "Implementations bridge structured-cloneable bindings, materialize each
> declared namespace rejection class, **treat programs as hostile peers,
> isolate runs from one another**, and terminate and await in-flight runs
> during disposal."

通道② 跨 run 持久 namespace **直接违反书面契约**。"provider 可替换、
Consumer 零改动"只在机械层面成立，语义层面是违约实现——恰是上游升级时
最易静默坏掉的类型（上游按契约优化时不会通知违约者）。

处置路线（review §1 表）：
- **A（采纳，推荐）**：上游提 issue/PR，给 Service Definition 加
  `stateful` / `sessionAffinity` capability descriptor。时机好：dsh
  kernel 文件首行官方 TODO（"RLM-1 weights 落地后重估 persistent kernel
  vs stateless python -c"）说明上游本就在想此方向，DASHR 是现成数据点
- B（备选）：插件私有分叉契约、文档化 divergence——可行但脆弱
- C（否决）：换 service 名自立门户，失去 Consumer 零改动红利

**M1 期间该风险已被验证为可控**：实测 dsh Consumer 对有状态 provider 连续
多次 run 无假设冲突（Phase A 22/22 绿，含状态化/生命周期/中断全套）。
但"实测可行"≠"契约允许"——上游 PR（路线 A）仍须启动。

### 1.3 上游利好四项（v0.4，peer review §2 核实）

- **Python 是预留 portability target**：`PORTABLE_RESERVED_WORDS` 注释
  明文 "Python is a portability target here even though only the
  TypeScript worker has a published backend"——② 不是蹭道，是官方预留位
- **Python bootstrap wrapper 上游已设计**：`RESERVED_BINDING_GLOBALS`
  含 `__dsh_main__`，注释明说 reserved for "the Python backend's
  bootstrap wrapper"——async-function-body 契约到 Python 的适配上游有
  设计稿，§1.1 "cell 语义兼容函数体契约"论证因此更硬
- **`mode: 'code'` / `'both'` 是内置机制**（py-types.ts 头注）：code 模式
  下原生 tool schema 从请求中省略，生成 SDK 是模型唯一工具源——§7.2
  "唯一工具界面"无需自研 schema 抑制，组 preset 即得；同时消解"双界面
  导致模型重复调用"隐患
- **工具桥比预估便宜**：嵌套执行调度 + 审计 logging 全在 Consumer 侧
  （code-mode.ts 头注），provider 只需把 bindings 物化为 Python async
  函数（JSON in/out，与 PA host_request 同形）——§5 工具桥风险降级

**LLM 侧红利**：模型对"持久变量"的先验来自 Code Interpreter / PA 类产品，
弱于 TS 一次性程序模型。切 Python cell 是界面先验**提升**非翻译成本
（呼应 8/15 范式讨论：RLM 界面先验优势）。

## 2. 第二决定性证据：PA KernelManager 构造器即接缝

```ts
new KernelManager({ python, cwd, env, sessionId,
                    hostHandlers,   // kernel→TS host 回调（comm 通道）
                    pythonSkills,   // kernel 内 venv editable install
                    snapshot })     // namespace dill 快照（1500ms debounce）
```

`hostHandlers` + `snapshot` 正是需要对接 dsh 的两个口。fork-server（子agent
复用父 kernel 状态）可选接入。首行有官方 TODO："RLM-1 weights 落地后重估
persistent kernel vs stateless python -c"。

## 3. TS vs Python 分工（回答"直接写 TS 版可不可行"）

| 层 | 语言 | 依据 |
|---|---|---|
| agent loop、工具桥、rlm binding、SDK 生成 | **TS，写进 dsh** | code-runtime provider 接口纯 TS |
| kernel 本体（IPython 持久 namespace） | **Python 原样** | 价值核心即 Python namespace；TS 重写=自弃核心 |
| 桥协议 | PA 既有 `host_request()` 模式 | 不发明新桥 |

结论：**可行，且不是"TS 重写 PA"，而是"TS 写 provider 胶水 + Python kernel
子进程原样嵌入"**。语言桥接问题被 provider 接口消解。

## 4. PA 特性清单 → 取/弃/后续

| 特性 | 处置 | 说明 |
|---|---|---|
| 持久 IPython kernel + context-as-variable | **取（核心）** | 经 provider 挂入 |
| 工具/技能/MCP 代码化方法 | **取** | 模式照抄：markdown + Python 函数 |
| rlm() 子agent 代码化 | **取** | ③：dsh subagent 能力（含 subagent-claude-code）→ rlm() binding |
| **state-snapshot/restore（dill）** | **必取** | dsh session log 不记 Python 变量；无此层则会话恢复后变量全丢 |
| refinement / Continual Harness | phase 2 | system prompt 每 turn 从 refinement 状态重建（prompt-as-variable） |
| fork-server | 可选 | 子agent 廉价并行 |
| PA TUI / daemon / session 胶水 | 弃 | dsh 壳替代 |
| PA fork 的 pi-ai | 弃/旁路 | dsh llm 层自有（含 llm-pi-ai） |
| compact 语义 | 后补 | 先用 dsh packages/compaction；PA compact 语义 phase 2 |

用户已确认的简化项：system prompt 每次原样发（v0.2 起步阶段）；压缩 = 模型
上下文上限（200K/按 modelId）+ 滑动窗口。

## 5. 风险登记（v0.4 改写：M1 实测结果 + peer review 定级）

| 风险 | 等级 | 缓解 | 状态 |
|---|---|---|---|
| **有状态 provider 违反明文 invariant**（"isolate runs from one another"，见 §1.2） | 高 | 路线 A：上游 `stateful` descriptor PR（M1 后启动）；M1 实测 Consumer 无冲突 | 实测可控，契约层未解 |
| dsh 0.1.x provider 接口漂移（pre-release 随意 rename） | 高 | 标准插件面最小依赖（只 import Service Definition 类型 + cordis ctx）；锁版本；CI 契约快照测试；fork 最后手段 | 未触发 |
| **kernel 死亡放大损失**：worker 死丢一次 run；kernel 死丢整会话变量且模型无感知（`df` 还在上下文里） | 高（review §4 新增） | kernel death → snapshot 自动 revive → error 明确告知模型"namespace 已从 turn-N 快照恢复，最近 K 轮变量操作需重放"（PA KernelManager 已有 revive 链） | M3 设计点 |
| **abort 软中断 vs dsh "hard, even mid-loop" 契约**：IPython interrupt 无法打断 C 扩展内 busy loop | 中（review §4 新增） | M1 已落地双通道（zmq interrupt + SIGALRM）；升级链 interrupt → grace → restart(revive) 进 M3 | M1 部分解决 |
| **SIGALRM-at-idle 双重窗口**（M2A 实证升格 P1）：abort 与 run() 同 tick = 10/10、+1-2ms = 8/10、cold boot 期 = 40/40 **确定性击杀 kernel**（SIGALRM 落在 idle/启动期 kernel 顶层 KeyboardInterrupt → 干净退出 → 会话内永久 worker-exit，无 respawn）；完成期窗口 30 次 0 死亡（M2A 已修 listener 泄漏主路径） | **高（M3 P1 硬性项）** | 两阶段 grace（control 先发、短 grace 未 idle 才补 SIGALRM）或 kernel 侧 busy 守卫 + respawn 纵深防御；回归测试 abort-at-start/boot（M2 验证轮 Doer 原建议"interrupt() 内 activeExec 守卫"经证伪无效——窗口内 activeExec 仍存在） | M2 定案，待 M3 实施 |
| 工具桥并行语义 | 低-中（§1.3 降级） | 嵌套调度+审计 logging 在 Consumer 侧现成；provider 只做 bindings 物化 | M2 落地 |
| 沙箱边界穿透（kernel 内 pip/网络不受 dsh sandbox 管） | 中 | kernel 启动参数收窄 + dsh sandbox 对 kernel 子进程整体套用 | M2/M3 |
| 双持久化语义（append-only log vs dill snapshot） | 中 | 分工见 §8；**非事务一致**已明文化（§8.3） | M3 |
| PA skills 的 TS host 依赖 | 中 | hostHandlers 同名回调集；PA runtime 935 行测试可回归 | M3+ |
| snapshot 体积/IO 风暴（GB 级 DataFrame × 1500ms debounce） | 中（review §6 升格） | serialize 黑名单 → size-cap + turn-end snapshot 混合策略（M3 设计点） | M3 |
| **子代理 kernel 扩散**：dsh subagent 经 composeFrom() 继承父 composition，rlm() ×N = N 个 kernel 子进程 | 中（review §5 新增） | kernel 必须 **lazy-start**（首个 run_code 才拉起；PA IpythonKernelProvisioner.ensure() 已是此形态），写为 M3 硬性要求 | M3 |

## 6. 里程碑（v0.4：M1 已交付 + 验收标准补充）

- **M1（✅ 2026-08-16 完成，Phase A）**：`code-runtime-ipython` provider +
  持久 kernel + `run_code` 全链路。产出 `dashr/dashr/` 插件包，22/22 测试
  绿 ×2（含状态化/绑定回调/生命周期/中断/快照），tsc clean，零孤儿进程。
  实现定案见 §11。
- **M2（✅ 2026-08-16 完成，Stage A+B）**：① 键迁移：provider 注册 `codeRuntime` → `rlmRuntime`
  （内核零改动，测试保持绿）；② vendored Service Definition（去 dsh-code-runtime peer 依赖）；
  ③ 自写 `dashr-tool-presentation` plugin；④ Python SDK 渲染器精简版（自有 cell 持久语义
  instructions）；⑤ 工具→binding 组装（PendingDispatch driver 与上游 code-mode.ts 逐 token
  等价移植，嵌套调度+审计无降级）；⑥ DASHR preset 文件（照抄 code preset 骨架 + isolate
  realm）；⑦ M1 补遗：并行 run ×2 断言、README
  验收：PTC 共存（同进程真 worker-thread provider + mode:code 邻居，run_code/TS SDK 与
  run_cell/Python SDK 双向无泄漏、各自执行）、DASHR preset 挂载冒烟（roster 真挂载、
  assembly 抑制、邻居不受影响、真 kernel e2e 含真 dsh 工具全栈）、22/22→24/24 原测试保持绿
  + presentation 57/57、发布形态验证（tarball 装包 + 消费者 typecheck 无 skipLibCheck exit 0）
  实现定案见 §12。报告：dev/m2a-{report,verify-report}.md、dev/m2b-{report,verify-report}.md
- **M3-A** ✅（2026-08-16 验收，Doer→Verifier→父代理闭环）：kernel per-session 键控
  + lazy-start 硬化 + 中断双通道竞态修复（两阶段 grace + busy 守卫 + fresh respawn）。
  dashr 36/36、presentation 61/61、零孤儿。报告 dev/m3a-{report,verify-report}.md。
  验收修正（父代理）：F1 sendInterrupt 改读 execution.opts.interruptConfirmMs（死代码消除）；
  F2 冷启回归用例补 pid 钉定。
- **M3-B** ✅（2026-08-16 验收，Doer→Verifier→父代理闭环）：rlm() binding 对接 dsh subagent（presentation 层落点，
  `callable` vendored delta + `_dashr_make_callable`，in-process provider `spawn` 先行，claude-code
  provider 后接）+ state-snapshot/restore（turn-end size-cap + manifest 升级 + 首次启动 restore）+
  kernel revive 链（死亡 → 最近快照 revive + turn-N 错误文案）。dashr 40/40、presentation 68/68。
  报告 dev/m3b-report.md。
- **M4**（2026-08-16 计划定稿，分三期，见 dev/m4-plan.md）：
  - **M4-A** ✅（2026-08-16 验收，Doer→Verifier→父代理闭环）：子代理模型配置路径——rlm() `model` kwarg →
    `SubagentStartRequest.agentOptions.model`（dsh `resolveChildAgentOptions` 既有摊开，
    零上游改动）；配置默认 `subagentModel`（**落 `dashr-tool-presentation` 行 config**——
    rlm() 归属行，非 provider 行，键名不变）；缺省继承父模型。优先级
    rlm(model=) > subagentModel > 父模型。附 N1/N2 测试加固（M3-B 验收遗留）。
  - **M4-B** ✅（2026-08-16 验收 PASS，Doer→Verifier→父代理闭环）：refinement / Continual Harness（prompt-as-variable：harness 状态持久化 +
    system prompt 每轮从 refinement 状态重建）+ PA compact 语义（dsh `ctx.compaction` 之上）。
    **辅助模型拆键定稿**：`refineModel` / `compactModel` 独立可选配置键，各自缺省回退父模型
    （不用共用 auxModel——refinement 质量敏感、compaction 成本敏感，独立键分别调优）。
    **与 dsh compaction-basic `summarizationModel` 的映射定稿（设计 A 采纳）**：`compactModel`
    设定时，presentation 用 `ctx.isolate('compaction')` 隔离标签程序化挂一个 DASHR scope 内的
    `BasicCompactionEngine`（单键驱动：yml 只写 `compactModel`，引擎的 summarizationProvider/Model
    由代码派生，`auto: false` 不与宿主引擎的自动监听双发；隔离标签保证与宿主引擎无 provide
    冲突、不向组合外解析）；unset 时继承宿主已挂引擎（configured ?? latest ?? agent 模型链）。
    细节与证据见 dev/m4b-report.md。
  - **M4-C**（可选，后置）：fork-server——子代理廉价并行、复用父 kernel 状态。与
    profile-layer 可行性研究（dashr-profile-layer-feasibility.md §10）的 bundle 化决策
    联动，收益模型依赖部署形态，待其落定再动工。

M3 新增硬性项（M2 验证阶段实证，P1）：
- **kernel per-session 键控**：isolate realm 实测为 per-mount 非 per-session（§7.4.1 勘误），
  roster 路径同进程所有 dashr 会话共享一个 kernel；provider 须按 Session/Agent 键控 kernel
  实例（官方 "plugins key their state by Session/Agent" 模式），与 lazy-start 同批落地
- **中断双通道竞态修复**（abort-at-cell-start 窗口 100% 击杀 kernel，量化见 §5 风险表）：
  两阶段 grace（control-channel 先发、短 grace 后未 idle 才补 SIGALRM）或 kernel 侧 busy
  守卫 + worker-exit respawn 纵深防御；回归测试补 abort-at-start / abort-during-boot
  （当前测试集无覆盖，P3 顺带：kernel 解释器探测含可用性检查而非仅存在）

验收补充（review §8，未完成项进 M2/M3）：
- M1 补遗（进 M2 首批）：并行 run_code ×2 行为断言（enqueue 串行化+结果归属）；
  README（kernel.ts 已引用未建）
- M3 硬性要求：lazy-start 落地；子代理 kernel 计数断言（rlm() ×3 后宿主
  kernel 数 ≤1）；session end disposer → `shutdown({snapshot:true})` 落盘；
  上游 stateful descriptor issue/PR 发出（路线 A）

## 7. 发布形态：一等 Cordis 插件（v0.3 新增，用户 2026-08-16 定调）

### 7.1 目标

DASHR 以**标准 Cordis 插件包**发布（非 fork 补丁、非源码修改）。收益：
- 上游 dsh 更新零摩擦：只要插件规则不变，原生可用（用户原话："摩擦力会小很多"）
- 双重身份：既是 dsh 生态插件（`dsh plugin --profile <p> add <pkg>`），
  也是独立自研运行时的核心组件
- 生态兼容：dsh 第三方插件生态爆发中（8/14 调研：dsh-plugin topic 2115 repos、
  create-dsh-plugin 脚手架、awesome 列表）——DASHR 蹭生态、不造生态

### 7.2 蓝本已核实（源码证据）

- **include meta-plugin**：`@deepseek-ai/cordis-plugin-include`
  （preset/mount.ts `import { Include }`；preset 目录即 `agent.cordis.yml`
  + include 子树挂载，~3ms/600KB per session）。四个运行模式（standard/
  minimal/code/creator）本质 = 四份 preset cordis.yml——**DASHR 可发一份
  第五 preset**：以 IPython kernel 为唯一工具界面的组合
- **worker-thread provider 蓝本**：`code-runtime-worker-thread/src/index.ts`
  = 标准 Cordis 插件结构（`Context` + schemastery z config + `Config` 全部
  可从 cordis.yml 调、无硬编码 tunables）——DASHR provider 照抄此骨架：
  - 包名规约：`@deepseek-ai/dsh-<name>` 系（第三方插件发布 npm 包即可，
    `dsh plugin add <pkg>` 安装；`--patch` 本地路径开发模式）
  - "Registrations are effects"：`ctx.effect()`/`ctx.on()`，register 返回
    disposer——kernel 生命周期（spawn/snapshot/dispose）全部走 ctx 效果，
    卸载即撤销（时空可组合性对 DASHR 生效：插件卸载 = kernel 快照+关闭）
    （= Cordis 论文「可逆效应」的源码实证；论文 DeepSeek×北大，
    `github.com/cordiverse/paper`，解读沉淀于
    `agent-harness/21_CLI-Agent/03_deepseek-dsh/deepseek-dsh.md` §1.4）
- **会话锁**：`agent-preset-locked`——产生内容后 preset 锁定，DASHR preset
    同受此规则（会话中途不能卸载 kernel provider，符合预期）

勘误两处（v0.4，review §7）：
1. "四个运行模式（standard/minimal/code/creator）"——standard/minimal 已在
   `packages/preset/agent-presets/tests/fixtures/` 核实；code/creator 名字
   未在 clone 的 `packages/preset` 内定位（疑在 apps/cli 或发布文档），
   出处待修准，不影响第五 preset 结论
2. 包名规约勘误：`@deepseek-ai/dsh-<name>` 是**官方包** npm scope，第三方
   不能发布。DASHR 用自有 scope（具体名待定，见 §12 待决清单）；
   `dsh plugin add <pkg>` 对任意 npm 包成立，不受影响
3. 第五 preset 的"唯一工具界面"由上游 `mode: 'code'` 内置机制获得（§1.3
   第三条），无需自研 schema 抑制——§7.2 原表述据此修正

### 7.4 DASHR 模式：第五 Agent Preset（v0.5 重定位：RLM 运行时）

安装与使用流（用户定调）：
1. 用户安装 Dash Agent
2. 安装 DASHR 插件（`dsh plugin add <pkg>` 或 `--patch`）
3. 原四模式之上新增 **DASHR 模式（RLM 模式）** = 第五 Agent Preset，
   与内建 PTC 编码模式**同级、同规则**——它 = host codeRuntime +
   presentation 行 + 注册表；我们 = rlmRuntime + 自有 presentation
   plugin + 同一注册表
4. 对 Dash Core 零改动——上游持续迭代，本插件独立 survive；基底（cordis）
   不变则无须跟进上游

结构（与内建 code preset 逐项对照）：

| 构件 | 内建 PTC 模式 | DASHR/RLM 模式 |
|---|---|---|
| runtime 服务键 | `ctx.codeRuntime`（worker-thread） | `ctx.rlmRuntime`（我们的 kernel provider） |
| Service Definition | dsh-code-runtime 包 | **vendored 进插件源码**（294 行裁剪：弃 invariant.ts，保留类型形状） |
| presentation | `dsh-agent-tool-presentation` (`mode: code`) | **自写** `dashr-tool-presentation`（解析 rlmRuntime，参考蓝本同在） |
| 工具 SDK 渲染器 | ts-types + py-types（Consumer 侧） | **自写精简版**（单语言 Python、无 flavor 表；参考 py-types.ts 818 行） |
| 工具注册表 | host 平面注册表，preset 层组合 | **同一个**（复用 dsh tools registry 的分层作用域） |
| 隔离 | preset 层 + realm | 同左：isolate realm 保证 kernel-per-session（§7.4.1） |

M2 迁移项：M1 交付的 provider 从注册 `codeRuntime` 键改为 `rlmRuntime`
（内核逻辑零改动——kernel/bridge/bootstrap 均在服务边界内侧，22/22 测试
应保持绿，注册层适配即可）。

#### 7.4.1 隔离设计（realm 三合一）

工具行写进 DASHR preset 层 → 只进本 preset 的 scope 层 → PTC/standard/
minimal 会话的 catalog 与 SDK 不可见（注册表分层作用域，preset 文件
注释原文背书 "layered per scope"）。provider 服务行进 isolate realm：

```yaml
- id: dashr-kernel
  name: cordis:group
  group: true
  isolate:
    rlmRuntime: true      # entry-local realm：每会话私有实例
```

效果：① PTC 会话仍解析 host worker-thread，同进程互不干扰（不发生
"PTC 被换脑"——M2B 真 worker-thread 实证）；② ~~第二个 DASHR 会话 → Cordis
自动新 realm 实例 → kernel-per-session 官方语义~~ **（勘误 2026-08-16，M2B 四层
验证：loader 源码 + agent-presets 源码 + 双路径 spike 实证 + 负向对照）**：
`isolate: true` 是 **per-mount** 实例而非 per-session——cordis 无 per-session
原语。roster 路径（`agentPresets.mount` 单飞 standing mount，会话经
composeFrom 父链加入）下同进程所有 dashr 会话**共享一个 rlmRuntime/kernel**
（会话 B 可读会话 A 的变量；上游 mount.spec 自证 "sessions stay apart inside
it by the plugin's own Session/Agent keying, not by instance count"）；
per-agent 挂载路径才每会话一个 realm/kernel。**kernel-per-session 改由 M3
provider 内按 Session/Agent 键控实现**（§6 M3 硬性项，紧邻 lazy-start）；
③ 无 realm 的服务行 dsh-agent-presets 挂载时直接拒载（上游防线，实证成立）。
M2B 的 preset.spec 两条测试已钉住双向现行语义（共享测试标注 "M3 flips it"）。

PTC 共存验证 ✅（M2B 验收：真挂载 + 双分支执行实证）。

### 7.6 依赖与契约终态（v0.5 定案：vendored + 自有键）

决策链（用户逐轮拍板）：依赖包 → vendored 源码（A 档）→ vendored +
自有键 `rlmRuntime` + 自有 presentation（v0.5 终态）。

**依赖清零路线**：
- `@deepseek-ai/dsh-code-runtime`（peer）→ **vendored**：抄 294 行
  Service Definition 进插件源码。裁剪：invariant.ts（30 行，monorepo
  内部测试门）可弃；类型签名形状**必须保留**——它是我们自写
  presentation/SDK 与 dsh 生态互操作的参考契约
- `@deepseek-ai/dsh-session`（peer，仅 snapshotJsonValue）→ 内联
- 剩余：`@deepseek-ai/cordis` peer（宿主基底，不可也不应摆脱）+
  schemastery + zeromq（运行依赖）
- 运行时对 dsh 上游包依赖 = **0**；上游 code-runtime 0.1.x 任何调整
  与我们无关，仅 cordis 基底变更需跟进

**§1.2 契约冲突消解**：换键后我们不再是 `codeRuntime` 的 provider，
"isolate runs from one another" invariant 管不到 `rlmRuntime`——状态化
语义成为我们自己 Service Definition 的**合法自有契约**。peer review
待决 #1 就此结案（无须上游 PR；PR 从"保险"降为"可选社区贡献"）。

**代价（诚实记录）**：dsh Consumer 自动流不再白拿——工具注册表→bindings
物化、嵌套执行调度、审计 logging、schema 自动切换须自写。简化面：
单语言 Python（无 TS 渲染器/flavor 表）、状态化语义固定（无跨后端兼容）。
参考蓝本：code-mode.ts 673 行 + py-types.ts 818 行，精简版估几百行。
换来：cell 语义、完成值语义、binding 规则全部自主，永不被 Consumer
预期约束。

**决策 reversal 记录**：peer review 曾否决"换 service 名"（理由：失去
Consumer 零改动红利）。v0.5 重启此路线的依据：上游 0.1.x 处于剧烈
调整期，"白拿红利"的隐性维护成本被重新计价；解耦 + 语义自主 > 复用
红利。非对错反转，是权衡参数变化。

### 7.7 风险表对应缓解更新（v0.5 修订）

- "dsh 0.1.x provider 接口漂移" 风险**整体消解**：运行时零 dsh 包依赖
  （§7.6），漂移无从影响。仅剩 cordis 基底变更需跟进
- 新增风险：自写 presentation/SDK 与 dsh 注册表协作面的**语义漂移**
  （我们参考的是 0.1.x 快照；dsh 注册表分层作用域/preset mount 规则若
  变，DASHR preset 组合需 re-verify）——CI 保留 preset 挂载冒烟测试
- `peerDependency @deepseek-ai/cordis` 版本对齐：每次 dsh 升级
  re-verify，CI 契约快照测试

## 8. Session 变量持久化设计（v0.3 新增，用户点名要求）

问题定义：kernel 变量不在 LLM 上下文、不在 dsh append-only session log——
DASHR 必须自管变量态的落盘与重载。

### 8.1 机制复用

- **PA 侧现成**：`KernelManager({ snapshot })`——namespace dill 快照，
  1500ms debounce 自动落盘 + `shutdown({ snapshot: true })` 收尾 +
  `RestoreResult` 恢复链（state-snapshot.ts 297 行全套）
- **dsh 侧挂点已核实**：worker-thread provider 已 import
  `snapshotJsonValue` from `@deepseek-ai/dsh-session`——session 持久化
  体系（session-persistence-jsonl / -sqlite / projection）可承载 DASHR 的
  变量快照引用

### 8.2 设计（M3-B 已定稿，2026-08-16）

```
session 目录
├─ dsh session log（append-only，transcript/审计）——原生
└─ <snapshotDir>/（DASHR 新增，config.snapshotDir）
   └─ <encodeURIComponent(principal)>/state.dill + manifest.json
   恢复序：resume session → provider 起内核 → restore(state.dill)
```

- 快照归 DASHR 插件私有目录（不污染 dsh session 格式，符合 SESSION_FORMAT_
  VERSION=0 无兼容承诺的现状）；manifest 记 dill 之外的元数据保证可重放，
  M3-B 定稿字段：`snapshotFormat=1`、`turn`（第几轮 run 后快照）、
  `pythonVersion`、`venvPath`（kernel 自己的 `sys.executable`）、`skills`
  （DASHR 暂不装 skills → 空清单，非空则拒重放）、`names`、`sizeBytes`、
  `skipped`、`createdAt`
- dsh session log 不追加记录（DASHR 自管目录，不写 session log——transcript
  完整性零改动；"snapshot @ turn N" 由 manifest.turn 表达，恢复/revive 的
  告知经 run 结果 logs 回给模型）
- 卸载/会话结束：`ctx.effect` disposer → 快照 + `shutdown`；**每轮成功 run
  之后也快照一次（turn-end）**，size-cap 超限跳过并 warn 模型一次（§8.3）

### 8.3 一致性边界（v0.4 新增，review §6 收紧）

- **变量态与 transcript 非事务一致**：1500ms debounce + 崩溃 ⇒ snapshot
  必然落后 transcript 若干 turn；dill 是不透明 blob，无法随 transcript
  历史编辑/回滚联动。resume 校验以 **snapshot + manifest**（python 版本/
  venv/skills 清单）为准，不匹配则降级为空 namespace 并告知模型
- 大对象策略（M3-B 定稿）：**turn-end 快照 + size-cap**（弃 debounce——
  turn 号与快照落点一一对应，revive 的 "turn-N" 语义才无歧义）。cap =
  `snapshotSizeCapBytes`（默认 256 MiB）。dump 前无法精确知道体积，故双层
  门：先做有界深度 namespace 规模估算（容器 len 累计 + numpy `nbytes` /
  pandas `memory_usage(deep=True)`，GB 级 DataFrame 在 dill IO 之前即被
  跳过），再 dump 到 `.part` 临时文件测真实字节数、超限即删——估算防 IO
  风暴，实测守 cap 精确。跳过快照保留上一份 good snapshot，warn 模型一次
- kernel death 行为链（review §4）：死亡 → 自动 revive（最近 snapshot）→
  error 告知模型"namespace 已从 turn-N 快照恢复，最近 K 轮变量操作需
  重放"——模型对 `df` 存在性的认知由此纠正

### 8.4 Continual Harness 的独立持久化通道（M4-B 新增）

M4-B 的 harness 存储（`harnessDir`，presentation 侧 per-agent JSON）与
§8 的 kernel snapshot（`snapshotDir`，provider 侧 dill namespace）是**两条
独立的持久化通道**：同一 agent id 键控，但互不参与对方的失效判定——
snapshot/restore 往环**从不回滚 harness 条目**（harness 是刻意的 durable
prompt 状态，refine 落地即持久，模型"已记住"的认知不因 kernel 死亡复活
而丢失），harness 编辑也**从不使 snapshot 失效**（harness 不进 namespace、
不进 manifest 校验集）。代价是显式接受的非一致：revive 后的 namespace
（turn-N）与 harness（refine 最新态）分属不同时间线，由 §8.3 的既有措辞
风格约束——恢复告知只陈述 namespace 侧，不承诺 prompt 侧同步。

## 9. 子 Agent 函数化归属（M3-B 已定稿实现形态，2026-08-16）

rlm() binding 归属通道② "kernel 代码化"的组成部分（用户确认）：桥 =
kernel 内 Python 函数 `rlm()` → hostHandlers 回调 → dsh `ctx.subagent`
能力（in-process provider `spawn` 先行，claude-code/codex provider 后接）。
不另立层。

**M3-B 定稿实现形态**：

- **落点 = presentation 层**（`dashr-tool-presentation` 的 `run_cell`
  execute），不是 provider 的 `dispatchHostRequest`。cordis 4.0.1 realm
  解析实测（`reflect.ts` 的 fiber 链上溯 + `context.ts` 的 isolate 标签，
  加真挂载探针）：entry-local realm 对**未隔离的名字**向外解析 root 服务，
  因此 presentation 行在 `isolate:{rlmRuntime:true}` 内仍能 `ctx.get('subagents')`
  取到 host-plane root 单例；而 parent `Agent` 与 abort signal 在 `exec` 上
  直接可得——三样（subagents 服务、parent Agent、abort signal）只有这一层
  同时拿得到。provider 层缺 parent Agent 对象（只有 principal 字符串），
  需要跨 runtime 边界线程透传 live Agent，是不必要的 seam 加宽。
- **裸可调用 global 的 binding delta**：vendored `CodeBindingNamespace`
  加 `callable?: true`（delta #3；`functions` 恰一条），bootstrap 侧
  `_dashr_make_callable` 物化为可调用函数，调用以 `{args, kwargs}` 统一
  打包（rlm 的 `label` 是 keyword-only，签名校验归 host）。
- **契约**：`await rlm(prompt, *, label=None)` → 入场 handle JSON
  `{run_id, label, provider:'spawn', local}`（`await` 在子代理 PUBLISH 时
  即返回，不等待完成）；`await rlm_await(run_id)` → `{output, stop_reason,
  structured}`。错误映射（无 provider/能力不支持/深度超限/基础设施拒绝）
  一律进 JSON `error` 字段，绝不 host 崩溃。run 句柄存 host 侧
  `RlmRunRegistry`（每组合一个），`rlm_await` 结算后清理，parent session
  `agent/disposed` 时 dispose 全部未 settle 的 run。

**v0.4 补充（review §5）**：dsh subagent 子代理经 `composeFrom()` 继承
父 composition——rlm() 派生的每个子代理都会挂 DASHR provider。因此：
- kernel 必须 **lazy-start**（首个 run_code 才拉起；M3 硬性要求），
  否则一次并行 rlm() ×N = N 个 IPython kernel 子进程
- 反面是机会：子代理跑新 kernel、变量不共享——抬高了 M4 fork-server
  （复用父 kernel 状态）的接入价值

## 10. M1 实现定案（v0.4 新增，Phase A 三轮 Doer-Verifier-验收产出）

源码级结论，M2+ 直接复用：

1. **TLA 执行** = IPython 自家模式：`await eval(code, user_ns, user_ns)`。
   CPython 事实：`exec()` 静默丢弃 top-level-await module 协程（代码不
   执行、无报错）；eval 在 await 下返回协程并真正运行
2. **REPL 语义** = AST rewriter 解包 `async def` 包装（module body 即
   程序语句）+ user_ns 兼作 globals/locals——`count = count + ...` 读
   到先前 run 状态，无 UnboundLocalError
3. **top-level return** = rewriter 改写为 `_DashrReturn`（BaseException）
   sentinel raise——用户 `except Exception` 无法吞掉
4. **busy-cell interrupt 双通道**：zmq control `interrupt_request` +
   `SIGALRM`（bootstrap 装 handler）。实证：单线程 loop 中 busy sync cell
   永不处理控制消息，唯 SIGALRM 可断 `while True: pass`
5. **多行字符串安全缩进** = tokenize-aware：只缩进非 STRING token 的
   物理行（逐行盲缩进会腐蚀 docstring/SQL/JSON 模板——verifier 揪出的
   HIGH bug）
6. **完成值语义**：显式 `return None` 保留为 null（value 字段 present），
   无 return 则 value absent——与 worker-thread 后端一致
7. **快照 pickle 卫生**：namespace 过滤规则 `/^_+dashr/i` + 排除
   IPython hidden（曾因 `sqlite3.Connection` 混入致 manifest 缺失）
8. **测试环境**：`DASHR_TEST_PYTHON` 指定 kernel 解释器；孤儿进程检测
   `pgrep -cf -- '-[m] ipykernel_launcher'`（防自匹配）
9. **操作性教训**：208 个孤儿 kernel 进程曾耗尽内存 6.7G 致全量测试
   挂死（单测绿）——teardown 纪律 + 孤儿检测必须进 CI

## 11. 待决清单（v0.5 更新）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 契约冲突处置路线（§1.2） | **结案（v0.5 新终态）**：换键 `rlmRuntime` + 自有 presentation → 不再是 `codeRuntime` provider，invariant 不适用。上游 PR 降为可选社区贡献 |
| 2 | 完成值语义 | **结案**：kernel 层严格守约（对 Consumer 的承诺）；SDK/instructions 自研，服务"一切代码化"LLM 思维，不跟 PTC 路径（用户 2026-08-16 定调） |
| 3 | lazy-start | **结案**：写死，M3 硬性要求 |
| 4 | 包名 scope | **悬置**：本地 `--patch` 开发不需要；发布时三选一（裸名 `dashr` / `@<id>/dashr` / 描述性前缀名）。产品名 DASHR 已定，包名仅 npm 拼写 |
| 5 | 四模式出处修准 | **已结**：creator 出处 = `.agents/notes/implemented/feature/2026-08-10-creator-guidance-introduce-cue.md` + `architecture/2026-08-03-per-session-agent-presets.md`；四模式真实，第五 preset 结论不变 |

## 12. M2 实现定案（2026-08-16，Stage A+B 三重验收产出）

源码级结论，M3+ 直接复用：

1. **transport 名 = `run_cell`**：上游注册表对 `run_code` 无条件保留（register 直接
   throw）；自有名保证与 PTC code 模式同进程共存，且契合 IPython cell 语义
2. **普通 scoped 注册替代 reserved transport**：上游 reservation 机制 registry-private
   不可铸造；代价（嵌套 scope 理论可 restrict 掉 run_cell）已接受并文档化
3. **schema 抑制 = scoped `system-prompt/assemble` listener**（prepend）：上游 README
   明文 "its returned assembly is authoritative"；邻居 scope/全局不受影响（实证）
4. **直呼封锁 = `ctx.tools.guard`**：唯一公开 monotonic denial 点；文案与上游 collapse
   同形；nested（parent token）放行。已知 delta：缺 UNKNOWN_TOOL info taxonomy（P3 可选）
5. **seam 类型 = 结构化镜像 + 双向 compat 断言**（正向 8 锁镜像接受契约、反向 7 锁上游
   新增必填字段即红；Service 类反向结构性不可满足、刻意缺省）：dts bundler 无法穿越
   src exports subpath 的 .ts specifier（oxc/tsc 双 resolver 实证）；Cordis 服务按 key
   解析、按形状依赖是 seam-correct
6. **发布 d.ts 必须 `resolve: false`**（两包）：resolve:true 内联会在消费者程序造
   S$1/T$1/K$1 孤立类型名（无 skipLibCheck 时 TS2304×6）+ 跨包 cordis 双副本；修复后
   presentation d.ts 273.9kB→9.5kB、消费者 typecheck exit 0
7. **presentation 行必须在 isolate group 内侧**：realm 私有服务只对共享 realm 的行可见，
   移出 = run_cell/SDK **静默消失**（mount 无诊断、assembly 退化原生视图——负向实验实证，
   警告已入 preset 注释）
8. **PendingDispatch driver 经公开 `TOOL_RUNTIME_SCHEDULER` staged API 移植**：与上游
   逐 token 等价（submission-order starts / head-of-line commit / parallel-exclusive
   屏障 / maxParallel / logWork 背压）；审计事件 `tool/code-dispatch{-start,}` payload
   逐键对齐上游
9. **node22 编译期关 TS**（features.typescript===false）下 PTC run_code 走 provider 文档化
   失败路径；node24 真执行——preset.spec 按 features.typescript 双分支
10. **realm 粒度**：见 §7.4.1 勘误；M3 会话键控前，preset persona 已如实声明共享语义

## 13. 与 v0.1 的差异记录
- v0.1 需维护独立 PA 剥离层 + 独立内核选型；v0.2 全部价值经 dsh 原生
  capability seam 注入，上下游零改动，维护面最小
- v0.1 方案 B（子进程 SDK）的隔离优点被保留——kernel 本就是子进程
- PiAgent core 不再需要显式引入：dsh core 即 agent loop（v0.1 §4 的
  "dsh core vs pi-agent-core" 选型题随之消失）
