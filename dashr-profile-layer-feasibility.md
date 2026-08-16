# 可行性研究：DASHR 从 Agent Preset 层上升到 Profile 层

> 日期：2026-08-16 · 类型：纯可行性研究（不干预开发、不改 v0.5 蓝图）
> 触发：用户提出——Dash 有 Profile（`dsh --profile`）与 Agent Preset 两层，
> 现蓝图把 DASHR 做成"与内建 PTC 编码模式同级的第五 preset"，能否再拔高
> 一层，到 Profile 层面去做？
> 方法：直读 `deepseek-harness @47f9438` 的 boot / bundle / preset 三层源码 +
> 活体 profile 目录（`~/.dsh/profiles/`）+ DASHR 两包实测，逐条取证。
> v1.1（2026-08-16 补）：新增 §9 决策附录（四模式核实/隔离实测/Web UI 复用）、
> §10 形态收敛（直接做成 Profile）+ TUI 可行性（三条思路源码取证 + 生态实证）。
> 一句话结论：**可行，且机制已内置——Profile 层的可分发原子是 bundle
> （声明 `dsh.bundle.patch` 的包）；"上升到 Profile 层"精确等价于"把
> DASHR 从 plugin+preset 变成 bundle（甚至一个 headless 式的独立运行时
> profile）"。内建先例就是 headless。**

---

## 0. 结论摘要（TL;DR）

1. **用户"两层"直觉需修正为四层 + 一个正交层**（§1）。Profile 与 Agent
   Preset **不是上下级**，而是两个不同阶段的层：Profile 是 boot 层（决定
   挂哪些 bundle/插件），Agent Preset 是 session 层（决定模型看到哪些
   工具/提示）。真正的"Profile 层的可分发插件"原语是 **bundle**。
2. **"上升到 Profile 层" = 成为 bundle**。精确语义是：DASHR 的 runtime
   半边（`rlmRuntime` 服务 + presentation + 生命周期）从 preset 的
   per-session scope 移到 **boot 层 / host realm**；模型面半边（工具 +
   提示）仍是 preset，但借 bundle 覆盖 `agent-presets.default` 变成
   **默认 preset**（甚至像 headless 那样干脆不需要 preset 名册）。
3. **最硬的实证支点**：DASHR 现在两个包 `dsh: null`（非 bundle），装包后
   preset 连注册都要靠手动 `--patch` overlay（`dashr-presentation/README`
   L48-73 实证）。升 bundle 后这一步由 bundle 自己的 `cordis.patch.yml`
   在 boot 时自动完成——一次 `dsh plugin add` 全落。
4. **内建先例 = headless**：`headless` bundle 就是"编码模式做成运行时"的
   官方示范——boot 层直接挂 `code-runtime` worker-thread，无 preset 名册，
   `tools.mode` 走 `DSH_TOOLS_MODE`。DASHR 的"Profile 层"完全可以照抄这
   条，做一个 `dashr` profile：boot 挂 `rlmRuntime`，运行时即 RLM 模式。
5. **代价**：boot 层耦合面变宽（依赖 `agent-presets`/`session`/`sandbox`
   等行 id 稳定），与 v0.5 §7.6"运行时零上游依赖"决策存在**真实张力**，
   需重新权衡（§6）。

---

## 1. 源码证实的真实分层（修正"两层"直觉）

活体 `~/.dsh/profiles/web/package.json` + `packages/boot/app-boot/src/profile.ts`
+ `packages/preset/agent-presets/` 三处对读，实际是**四层 + 一个正交层**：

```
boot 阶段（决定"装了什么运行时"）           session 阶段（决定"模型看到什么"）
┌─ Profile  ~/.dsh/profiles/<name>/         ┌─ Agent Preset（正交，非下级）
│    package.json: dsh.profile.bundles[]       agent.cordis.yml 列表 = 面向模型的
│    cordis.patch.yml（用户层）                 工具行 + 提示行 + scoped 服务
│  └─ Bundle  npm 包，声明 dsh.bundle.patch      发现：roots 扫描（system shipped
│      cordis.patch.yml = insert 行 + 覆盖行        + ~/.dsh/.agent-presets/）
│    └─ Plugin  单个 Cordis entry（id+name+config） 选择：default + 会话头 + 事件，锁
```

**证据**：
- Profile 本体：`profile.ts` L36-96（`Profile`/`ProfileLayer`/`bundles`）；
  `PROFILE_TEMPLATES` L114-117（`web`/`headless` 自动初始化）；
  `DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']` L125。
- Bundle 声明：`profile.ts` L42-45（`dsh.bundle.patch`）；L371-397
  （`loadProfile` 解析 bundle patch，缺 `dsh.bundle` 则 fail-loud L392-394）。
- 装配：空根 `[]` + bundle 层按序 + profile 层 + home 层 + overlay
  （`apps/cli/src/profile-boot.ts` `composeProfile`）。
- Preset 发现：`discovery.ts` `COMPOSITION_FILE='agent.cordis.yml'` L26、
  `USER_PRESET_DIR='.agent-presets'` L41、`discoverPresets` 按 roots 优先级
  L177-186；`preset.ts` `Config{default,roots,includeUserRoot}` L51-62。

---

## 2. 各层"能做什么 / 不能做什么"（层级决定能力）

| 层 | 挂载时机 | realm | 能贡献 | 不能贡献 |
|---|---|---|---|---|
| **Bundle** | boot（进程启动） | root/host | **任何行**：llm、session、sandbox、subagent、system-prompt、`agent-presets` 本身、以及新 runtime 服务 | — |
| **Agent Preset** | session（每会话挂） | scoped（per-session） | 工具行、system-prompt 段、`isolate` realm 的 scoped 服务 | **root realm 服务被拒**（`mount.ts` 头注 + `leakedServices`：泄露到 root realm 的行直接拒载） |

**推论（本研究的核心）**：
- runtime 服务（`rlmRuntime`、kernel 生命周期、sandbox 套壳、subagent 桥）
  **天生是 bundle 的事**——它们要在 boot 时进 host realm、按 Session/Agent
  键控，而不是挤进 preset 的 per-session scope。
- 模型面（`run_cell` transport、py-sdk、工具 schema 抑制）**天生是 preset
  的事**——它们本来就是 per-session 组合。
- DASHR 现状把**两者都塞进 preset**，正是 §7.4.1 realm 勘误（isolate 是
  per-mount 非 per-session）与 root-realm-reject 风险的根因。分层错位，
  不是缺能力。

---

## 3. DASHR 现在到底在哪一层（实测）

| 项 | 实测 | 层 |
|---|---|---|
| `dashr/package.json` | `dsh: null`，deps 仅 schemastery + zeromq | **非 bundle** → plain dependency |
| `dashr-presentation/package.json` | `dsh: null` | **非 bundle** → plain dependency |
| preset 文件 | `dashr-presentation/preset/dashr/{agent.cordis.yml,preset.yml}` | session 层 |
| preset 注册方式 | README L48-73：**手动 `--patch` overlay** 给 `agent-presets` 加 `roots` 指到 `node_modules/dashr-tool-presentation/preset`，再手动设 default | **手动的 boot overlay** |

即现状 = **plugin（依赖）+ preset（会话模式），且 preset 注册是手动的
boot overlay**。`dsh plugin add <pkg>` 对 `dsh: null` 的包只会装成
"plain dependency, not a profile layer"（`plugin.ts` `reconcilePlugins`
L44-47 的 warning 分支），preset 名册根本不会自动知道它。

---

## 4. 上升方案：两级目标

### 4.1 Target 1 — DASHR 成为 bundle（Profile 层，叠加到既有 profile）

最小改动：给一个包声明 bundle，其 `cordis.patch.yml` 在 boot 时完成三件事：

```yaml
# dashr 包 package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }

# dashr 包 cordis.patch.yml（boot 层，root realm）
- insert:
    - id: rlm-runtime
      name: 'dashr-code-runtime-ipython'      # ① runtime 服务，boot 时 host realm
    - id: rlm-presentation
      name: 'dashr-tool-presentation'          # ② run_cell transport + py-sdk

- id: agent-presets                            # ③ 覆盖 preset 名册（web 才有此行）
  config:
    default: dashr
    roots:
      - path: <bundle-dir>/preset               # 本包自带 preset 目录
        trust: system
```

效果：`dsh plugin add dashr-code-runtime-ipython` 一次命令 → `reconcilePlugins`
检测到 `dsh.bundle.patch` → 自动追加进 `dsh.profile.bundles` → boot 时
runtime + presentation 挂 host realm、preset root 注册、default 翻到 dashr。
**手动 `--patch` 消失**。

### 4.2 Target 2 — DASHR 成为独立运行时 profile（headless 式一等运行时）

**没有"profile package"这种可分发原语**——profile 是用户本地目录，创建靠
`dsh plugin --profile dashr add <pkg>`（`DEFAULT_PROFILE_BUNDLES=[dsh-base]`）。
所以"发一个 profile"实际是**发一个 bundle + 安装器/文档**。但语义上可以做
成 headless 的镜像：

```
dashr bundle（照抄 headless/cordis.patch.yml 的结构，~25 行）
- id: system-prompt        → RLM persona 覆盖
- id: tools                → 呈现 RLM cell 界面（对应 headless 的 mode: DSH_TOOLS_MODE）
- insert: rlm-runtime + rlm-presentation + dashr-startup + dashr-runner
```

对比 headless（`packages/bundle/headless/cordis.patch.yml` 全文仅 ~25 行）：
它 **boot 层直接挂 `code-runtime` worker-thread，无 preset 名册**，
`dsh --profile headless "<task>"` 即"编码模式做成一等运行时"。DASHR 照此做
`dsh --profile dashr "<task>"`，即"RLM 做成一等运行时"。这比 Target 1
更进一步：**连 preset 名册都可有可无**（像 headless 那样 tools.mode 直给）。

---

## 5. 价值（为什么上升，按权重）

1. **runtime 逃出 preset scope**（最大）：`rlmRuntime` 从 per-session 的
   isolate realm 挤迫，改为 boot 层 host realm + 显式 Session/Agent 键控。
   直接消除 §7.4.1 的 realm-per-mount 勘误与 root-realm-reject 风险。
2. **身份对齐乃至超越**：PTC 编码模式在 web 里**仍只是五选一的 preset**
   （`default: standard`，会话内切换）；而 DASHR 升 bundle 后拥有 boot 层，
   是"运行时"而非"模式"——比"与 PTC 同级"更进一步，对标的是 headless。
3. **boot 级能力组合解锁**：sandbox 套 kernel、subagent 桥 boot 化、snapshot
   store、persona、compaction——这些现在被 preset 边界挡住的项，全部可在
   bundle 层落地。
4. **装包摩擦归零**：手动 `--patch` overlay（§3 实证痛点）→ 一次
   `dsh plugin add` 自动全落。

## 6. 代价与风险（诚实记录，与 v0.5 决策的张力）

1. **boot 层耦合面变宽**：bundle 依赖 `agent-presets`/`session`/`sandbox`/
   `system-prompt` 等**行 id 与 config 形状稳定**。这与 v0.5 §7.6 换键 +
   vendored SD 换来的"运行时零上游依赖"是**相反方向**——前者买自主，后者
   买 boot 杠杆。这是本路线最需要用户拍板的一处权衡。
2. **`agent-presets` 行只在 `web-app` bundle**（L421-424，`default: standard`），
   `dsh-base` 与 `headless` 都没有（实测）。→ Target 1 的"覆盖 default"只在
   web profile 成立；headless 场景要走 Target 2（tools.mode 直给），不依赖
   preset 名册。这是关键的平台分叉，必须写进方案。
3. **root realm 服务 = process-global**：per-session 键控从"preset 隔离"变为
   "自己 key"。M3-A 已交付 `Map<principal,kernel>` + lazy per-key +
   `agent/disposed` per-key teardown，机械件已具备，语义要重述。
4. **发行面**：bundle 需声明 `dsh.bundle.patch`，且行 id 与 dsh 实际一致
   （pre-release 漂移面，比现在宽）。
5. **两包形态**：bundle 的 patch 按"行名→包名"引用插件，runtime 与
   presentation 两包需一个 bundle 包（或 meta-bundle）统一 insert；要么合并
   成单包，要么增一个壳包。

## 7. 与 v0.5 蓝图的关系

- **不改 v0.5 蓝图**；本研究是**平行的"再拔高"路线**，可作为 M4 之后
  （或独立分支）的选型输入，不排入当前 M3-B/M4 计划。
- 与 §7.4"第五 preset"不冲突：Target 1 把 runtime 半边升到 bundle、preset
  保留为默认 face；Target 2 把 DASHR 整个做成 headless 式运行时 profile。
  两者都是从"五选一模式"走向"一等运行时"的同一条路上不同深度。

## 8. 待决 / 待核清单（供讨论，非本文结论）

| # | 问题 | 现状 |
|---|---|---|
| 1 | 目标选 Target 1（bundle 叠加）还是 Target 2（headless 式独立 profile）？ | 开放 |
| 2 | bundle 内 `rlmRuntime` 用 root realm 还是 isolate realm 的正确 boot 语义 | 开放 |
| 3 | 是否接受 boot 层耦合 dsh 行 id（与 §7.6 零依赖决策的权衡） | 开放，需拍板 |
| 4 | 发行形态：runtime+presentation 两包 + 壳 bundle，还是合并单包 | 开放（包名 scope 仍悬置） |
| 5 | web（Target 1）与 headless（Target 2）是否两条都要，还是先一条 | 开放 |

---

## 9. 决策附录（2026-08-16 补充：四模式核实 / 隔离实测 / Web UI 复用）

### 9.1 四个模式核实（用户"标准/极简/PTC/Creator"四点全对）

实读 `apps/cli/config/agent-presets/<id>/preset.yml`：

| preset id | 显示名 | order | 说明 |
|---|---|---|---|
| `standard` | 标准模式 | 1 | 全功能编码 Agent |
| `code` | PTC 模式 | 2 | Code Mode SDK 呈现工具 |
| `minimal` | 极简模式 | 3 | bash + str_replace_editor 双工具 |
| `cordis` | 创造模式 | 4 | = 你说的 "Creator"；用于创作自定义 preset |

加第 5 preset `dashr`（RLM 模式）到名册 = 正确路径，与现开发一致。

### 9.2 web 是默认 profile、无 TUI 入口

- `web` 是 hardcoded alias（`args.ts` 原文："`web` is a hardcoded alias for
  `--profile web`"）；无参数默认起 web。
- `PROFILE_TEMPLATES` 只有 `web`/`headless`；帮助文本里的 `tui` 只是"自定义
  profile 名"举例，非出厂模板。
- 结论：交互面 = Web UI（web profile）+ headless 一次性；无 TUI。

### 9.3 Web UI = `dsh-web-app` bundle，自包含、原样复用

`web-app/cordis.patch.yml` 内 UI 相关行：`web-startup` / `webserver` /
`web-runtime`（`dsh-web-app` 本体）、`api-gateway`（`dsh-host-apiproxy`）、
`api-remotes`、`ui-theme` / `ui-layout` / `ui-sidebar` / `ui-settings-*` /
`ui-conversation` …。→ 复用 = 把 `@deepseek-ai/dsh-web-app` 写进
`dsh.profile.bundles`，**不 fork 源码**。

### 9.4 profile 之间不隔离（影响"独立 dashr profile"决策）

- session 按 **workspace（cwd）** 隔离：`~/.dsh/sessions/<转义cwd>/session-<uuid>/`；
  session 头记 `agentPreset`，不记 profile。
- `settings.yaml` / credentials **全局**（`~/.dsh/` 下，跨 profile 共享）。
- 含义：独立 `dashr` profile 得到"默认 = RLM + 干净名册"，但**得不到数据
  隔离**；若只要"在 Web UI 里加一个 RLM 模式"，最简做法是直接扩展现有 web
  profile（`dsh plugin --profile web add <dashr-bundle>`），连新 profile 都
  不用建。

### 9.5 现状 ≈ Target 1（升 bundle 是"装法正式化"，非重构）

| | 现状（开发中） | 升 bundle（Target 1） |
|---|---|---|
| 包声明 | 两包 `dsh: null`（普通依赖） | 声明 `dsh.bundle.patch` |
| preset 注册 | 手动 `--patch` overlay | bundle 的 `cordis.patch.yml` boot 自动 |
| Web UI | 复用 `dsh-web-app` | 同左（不变） |
| 安装 | `dsh plugin add` 只装普通依赖 | 同命令，自动进 bundles + 挂 runtime + 注册 preset + 设 default |

---

## 10. 形态收敛：直接做成 Profile（bundle）+ TUI 作为 surface bundle

### 10.1 "直接做成 Profile" 的确认（POFA = Profile 解读）

用户新判断：Profile 也好、preset 也好，如今都按 bundle 发布，DASHR 既然
实质是运行时，就直接做成 Profile 层。**成立，且与 §4 收敛一致**：

- 可分发原语只有 bundle；"Profile 层"与"preset 层"的差别不在发布形态，
  而在**挂载阶段与 realm**（§2）。
- DASHR 的 runtime 半边（`rlmRuntime`/presentation/生命周期）本就该在 boot
  层；模型面半边（`run_cell`/py-sdk）仍是 preset、设为默认。
- 所以"直接做成 Profile"= 把 DASHR 声明成 bundle + 复用 web-app，其余照旧
  （§4.1 Target 1）。不是新路线，是把现开发正式化。

### 10.2 "同一包既借 Web UI 又用 TUI"——架构上天然成立，且已被生态证实

dsh 把"交互面"抽象为 **surface bundle**：`dsh-web-app`（Web）、
`dsh-headless`（一次性）。TUI 只是**第三个 surface bundle**，与 runtime
bundle 正交：

```
dsh-base（核心）+ DASHR runtime bundle（kernel+presentation，surface 无关）
  ├─ + dsh-web-app  → dashr-web（借 Web UI）
  └─ + dsh-tui      → dashr-tui（用 TUI）
```

所以"一个包"= DASHR runtime bundle 一个，同时喂给两个 surface，不需要 fork
任何东西。

**关键实证（web 检索 2026-08-16）**：生态里已有现成 TUI，且正是
"out-of-tree dsh plugin bundle"或"over the one DSH HTTP contract"：

- [openguardrails/dsh-tui](https://github.com/openguardrails/dsh-tui) —
  Claude Code-style TUI，明确是 **out-of-tree dsh plugin bundle**
- [MashedPotato817/dsh-tui](https://github.com/MashedPotato817/dsh-tui) —
  Claude Code-style 对话 + Vim modal + HUD，**走 DSH 单一 HTTP 契约**（即
  复用 web-app 暴露的 `api-gateway`/`api-proxy` RPC，不是 fork Web UI）
- npm [`@dsh-tui/dsh-tui`](https://www.npmjs.com/package/@dsh-tui/dsh-tui)
- [lhjnano/orcatui](https://github.com/lhjnano/orcatui) — 终端多 agent 编排器
  （N agent side-by-side，各自 PTY/worktree）——正是你要的 tmux 式 manager 形态

这直接回答"要不要抄 Web UI 源码"：**TUI 甚至不碰 web-app 源码，它是跑在
同一条 host RPC 上的另一个 client**。思路 #1（参考开源）因此不是"再多参考
一个 repo"，而是**几乎可以直接踩在现成项目上**。

### 10.3 三条 TUI 思路的源码级可行性

| 思路 | 实测依据 | 工作量 | 风险 |
|---|---|---|---|
| 1 参考开源 dsh-tui | 已存在，out-of-tree bundle + DSH HTTP 契约 | **低**（复用/参考） | 协议随 dsh 0.1.x 漂移；社区项目成熟度待核 |
| 2 复用 PA TUI | `@earendil-works/pi-tui` 自研轻量 ANSI（仅 chalk/get-east-asian-width/marked/mime-types 5 依赖），组件系统齐全（box/input/editor/select-list/markdown/image/loader…）+ `modes/`（`interactive-mode`、`agents-view-mode`=多 agent 视图、`daemon`+`agent-connection`） | **中偏高**（组件可抄，渲染循环/数据源要重接 dsh agent loop + session 事件） | pi-tui 耦合 PA 的 session/daemon 模型；双上游维护 |
| 3 自建 TUI | dsh **无 TUI 源码**（`packages/terminal` 是 shell/PTY 后端组 `terminal`/`terminal-bash`/`tool-terminal`，非 UI；无 ink/blessed 依赖）——用户猜测正确 | **高**（全量） | — |

结论：TUI 应作为**独立 surface bundle + 独立里程碑**，与 runtime bundle 解耦；
Web UI（复用 web-app）先跑通，TUI 从思路 #1 起步（参考现成 dsh-tui），
思路 #2 仅在需要 PA 式"agents-view 多 agent 视图"时再评估移植 pi-tui 组件层。

---

## 11. 决策结论（暂缓，留后路）

2026-08-16 用户定调：**暂不决定**，资料落盘存档即可。

1. **暂不深整合 TUI**：官方现处 0.x 早期，bundle 走 Web UI 路径（与 DeepSeek
   Web Chat 一脉相承，更 future-proof）；官方后续（0.7/0.8 附近）可能自出
   TUI。现在 Web UI 已够用，且没有"必须用 TUI 才能完成"的工作。
2. **留后路原则**：GUI 主攻大方向 + CLI/TUI/headless 必须留入口（LLM 本身
   TUI-native / 命令行-native / headless-native，GUI 再成熟也要留尾巴）。
   官方已有 headless 入口，正合此逻辑。
3. **观望两条趋势**（观察项，非任务）：
   - 整体是否"GUI 进发、同时留 TUI 尾巴"；
   - 官方 TUI 是否落地（0.7/0.8）。
4. **再评估触发条件**：官方出 TUI / 官方 bundle 形态定型 / 出现必须 TUI 的
   工作。

对 §8 待决清单的处置：**不关闭、保持开放**，但排期上不主动推进——Target 1
vs 2、TUI 路线选择全部挂起，等官方信号。

---

## 附：证据索引

| 结论 | 出处（clone 内实读） |
|---|---|
| Profile = `dsh.profile.bundles` + 用户 patch | `packages/boot/app-boot/src/profile.ts` L36-96 |
| Bundle = 声明 `dsh.bundle.patch`；缺则 fail-loud | `profile.ts` L42-45, L371-397 |
| `dsh plugin add` 按 `dsh.bundle.patch` 有无 reconcile | `apps/cli/src/plugin.ts` L22-25, L39-75 |
| 空根 + bundle 层按序装配 | `apps/cli/src/profile-boot.ts` `composeProfile` |
| Preset = `agent.cordis.yml` 目录，roots 扫描 + 优先级 | `packages/preset/agent-presets/src/discovery.ts` |
| Preset `default` + `roots` 配置 | `preset.ts` L51-62 |
| Preset 拒 root realm 服务 | `mount.ts` 头注 + `leakedServices` |
| 会话选择 + 锁定 | `session.ts`；agent-presets README L148 |
| `agent-presets` 行只在 web-app，`default: standard` | `packages/bundle/web-app/cordis.patch.yml` L421-424 |
| headless = boot 挂 code-runtime、无 preset 名册 | `packages/bundle/headless/cordis.patch.yml` 全文 |
| DASHR 两包 `dsh: null`（非 bundle） | `dashr/dashr/package.json`、`dashr-presentation/package.json` |
| DASHR preset 注册靠手动 `--patch` | `dashr-presentation/README.md` L48-73 |
| 四预设显示名（标准/PTC/极简/创造） | `apps/cli/config/agent-presets/<id>/preset.yml` |
| `web` = 无参数默认别名 | `apps/cli/src/args.ts` L13, L66-70 |
| Web UI 行全在 web-app bundle（自包含） | `packages/bundle/web-app/cordis.patch.yml` L99-198 |
| session 按 workspace(cwd) 隔离、非 profile | `~/.dsh/sessions/<转义cwd>/session-<uuid>/`（活体） |
| settings/credentials 全局共享 | `~/.dsh/settings.yaml`（活体） |
| PA TUI = `pi-tui` 自研轻量 ANSI（5 依赖）+ `modes/` | `prime-agent/packages/tui/`；`packages/coding-agent/src/modes/` |
| dsh 无 TUI 源码（terminal = PTY 后端组） | `packages/terminal/`（组目录：terminal/terminal-bash/tool-terminal） |
| 生态已有 dsh-tui（out-of-tree bundle / DSH HTTP） | web 检索：openguardrails、MashedPotato817、@dsh-tui、orcatui |
