# 752 插件系统契约规格（官方目录 / 启用模型 / 三件套能力面）

> Wayfinder 票 [#752](https://github.com/ACautomata/researcher-service/issues/752)，map：[#750 插件系统与 AutoFigure 插件化](https://github.com/ACautomata/researcher-service/issues/750)。
> 根决策 [#749](https://github.com/ACautomata/researcher-service/issues/749)（16 决策全录）是本规格的钉定前提；Pi 能力面证据见 [#751](https://github.com/ACautomata/researcher-service/issues/751)（[docs/research/751](./751-pi-extension-system.md)）。
> 接缝引述 #726（SSE 事件面）/ #729（审批漏斗）/ #730（前端单管线渲染）/ #731（ProviderRegistry）/ #742（commands/skills）/ #744（AutoFigure）/ #747（交接规格）。
> 状态：grilling 会话定稿（2026-09-29，两轮 9 决策 + 6 推导全录见票 resolution）。术语以 CONTEXT.md 为准（插件 / 官方插件目录 / 插件启用 / 能力实现层与用户交互层，PR #748——本票核对后零改动）。
> **#758 修订**（2026-09-29，方向修订，#762 执行）：R4 命令命名空间三源改两源（系统含官方内容目录 > 插件），用户创建撞名拒绝随创建端点退役消失；§2.3 autocomplete 面、§4.2 SQL 注释先例引用、§7 #742 接缝行、§8 S3 用例行随改。commands/skills 的 per-user 表与 REST 域退役本体归 #747 G 节与 #758，本契约只动插件接缝面——零新决策。

## 0. 上游决策与本票钉定

### 0.1 决策谱系

根决策 16 条（#749）不重开；本票在其上钉规格级 9 决策：

| # | 决策点 | 选定 |
|---|---|---|
| R1 | 插件包物理位置 | 根级 `plugins/<id>/` 源目录直引；双 app 经 `@plugins/*` 路径别名引 TS/Vue 源，零 workspace 基建 |
| R2 | Plugin API 形状 | 声明式 `export default definePlugin({...})` 纯数据 manifest，无 factory 动态性 |
| R3 | 启用位数据面 | `plugin_enablements` 表（复合主键 ownerId+pluginId） |
| R4 | 命令命名空间 | 系统（含官方内容目录）> 插件 两源无遮蔽（**#758 修订**：用户源随创建端点退役消失）；系统/官方/插件命令名 = 保留字，插件发版撞名 → 收录评审插件侧改名 |
| R5 | 渲染接缝数据流 | attachmentsJson v1 `tools[]` 加 `details?`（≤4KB）；SSE `tool.end` 同形状带 details；实时/回放同一字段 |
| R6 | content/渲染一致性 | 双面契约 + **事实同源不变量**：卡上每个结论性事实 ⊆ content，details 只承载呈现形态 |
| R7 | env 校验 | 启动期全目录校验（不看启用位）；生产 fail-fast / dev 警告 |
| R8 | REST 码段 | 8xxxx plugins 段；`GET /api/v1/plugins` + `PUT /api/v1/plugins/:id/enablement` |
| R9 | 命令 handler 契约 | 两类 outcome：`{inject}` 注入 user message / `{execute}` 直达本插件工具执行面 |

推导项（从已钉决策直接推出，非新决策）：类别→漏斗路由（§3）、注册期强校验清单（§2.2）、teammate 继承 = per-run 快照（§4.2）、`onUpdate` 收录但通用进度事件留 V2（§2.2）、`ctx` 最小面（§2.2）、usage 并入口径（§2.2）。

### 0.2 概念对齐，机制不对齐（Pi-agent）

对齐 Pi 扩展系统的**能力分类学**（注册工具/命令/渲染，及其契约细节——content/details 双面、promptSnippet、参数补全）；**不对齐**其加载机制（jiti 进程内热载）与信任模型（无沙箱同进程）。

| | Pi | 本项目 |
|---|---|---|
| 信任锚 | 运行时（用户决定是否加载进自己进程的代码） | **发布流程**（git 审查 + 发版；多租户控制面下插件代码 = 核心代码） |
| 加载 | jiti 热载，reload 重建 runtime | **编译期打包**，无运行时代码加载 |
| 「安装」 | `pi install`（npm/git/local 代码获取） | 目录一键**启用**（enable/disable 位，非代码获取） |
| 注册形状 | 命令式 factory `(pi: ExtensionAPI) => void` | **声明式 manifest**（R2；无运行时加载则 factory 动态性无消费场景，且引入注册期任意代码执行死角） |

第三方插件、self-extensible、providers 注册面：根决策出局，本文只在 §6 重申边界。

## 1. 物理形态：单包双面与 monorepo 目录约定

一个插件 = 一个包 = 仓库根一个目录，双面入口，双 app 源码直引：

```
researcher-service/
├─ server/                          # tsconfig paths: @plugins/* → ../plugins/*
├─ frontend/                        # vite alias:  @plugins/* → ../plugins/*（vue-tsc 同步）
├─ plugins/
│  ├─ index.ts                      # 目录清单：显式 import 全部插件 manifest，export catalog（编译期常量）
│  └─ autofigure/                   # 目录首成员（V1 唯一成员；id = 目录名，kebab-case）
│     ├─ manifest.ts                # server 面声明入口：export default definePlugin({...})
│     ├─ server.ts / graph.ts / …   # 实现体自由组织（execute / 命令 handler / LangGraph graph）
│     ├─ web.ts                     # 前端面入口：export default definePluginWeb({...})
│     └─ components/                # Vue 组件（FigureCard.vue 等）
```

- **契约类型出口**：`server/src/plugins/api.ts` 导出 `definePlugin` 与全部 server 面类型（插件 `@server/plugins/api` 或相对别名 import）；前端面类型由 `frontend/src/plugins/` 导出（web 面类型极小——组件注册表 + props）。
- **收录 = 显式 import 行**：新插件进目录须改 `plugins/index.ts`（server 侧收录）与 `frontend/src/plugins/index.ts`（前端收录）各一行。**不用 glob 自动发现**——显式收录行是收录评审的动作面（名字冲突、类别正确性、env 需求在 diff 上可见），自动发现让收录静默。
- **前端收录零运行时成本**：Vue 组件编译期静态 import 进 bundle，运行时按注册表挂载（R15 根决策）；server 只 import manifest（不触 web 面），frontend 不 import manifest（目录页数据经 REST 从 server 拿）。
- **graph 不设独立注册面**：LangGraph 固定 graph 作为某工具 `execute` 的实现体存在（figure 先例，#744），manifest 只声明工具。
- 工作区基建为零：两 app 均从源码编译（server tsc/tsx、frontend vite/vue-tsc），路径别名直引即可；不为插件引入 npm workspaces。

## 2. Plugin API 契约（三件套）

### 2.1 manifest 总形

```ts
// plugins/autofigure/manifest.ts
import { definePlugin } from '@server/plugins/api'

export default definePlugin({
  id: 'autofigure',                  // kebab-case，与目录名一致，全局唯一
  name: 'AutoFigure',
  description: '方法示意图生成（AutoFigure-Edit 流水线）',
  version: '1.0.0',
  tools: [/* PluginToolDefinition */],
  commands: [/* PluginCommandDefinition */],
  configSchema: { env: [/* §5 */] },
})
```

### 2.2 工具注册

```ts
interface PluginToolDefinition<TParams, TDetails> {
  name: string                      // LLM 工具调用名；全局唯一（核心 + 跨插件），注册期校验
  description: string               // 给 LLM
  category: 'file' | 'exec' | 'domain'   // 必填——核心拒绝未声明类别的工具（根决策 Q11）
  pathParams?: string[]             // file 类必填：路径参数名清单，漏斗规则层校验目标（§3）
  parameters: ZodSchema<TParams>    // zod → JSON schema（项目校验纪律；LangChain 工具面等价）
  promptSnippet?: string            // 一行摘要，runner 组装系统 prompt 的 Available tools 段；不提供则该段省略
  promptGuidelines?: string[]       // 工具激活时追加进 Guidelines 段的 bullet
  execute: (toolCallId: string, params: TParams, exec: {
    signal: AbortSignal,            // run abort 传播（#726 abort 语义）
    onUpdate?: (partial: unknown) => void,   // 部分结果上报；通用 SSE 进度事件 = V2（§6），域 run 事件族归域规格
    ctx: PluginToolContext,         // V1 = { config（configSchema 解析后）, logger }
  }) => Promise<PluginToolResult<TDetails>>
}

interface PluginToolResult<TDetails> {
  content: (TextContent | ImageContent)[]   // 给模型 + 审计；大结果截断并在 content 指引读全文
  details?: TDetails                        // 仅渲染/状态重建，不进模型上下文；undefined 合法
  usage?: LlmUsage                          // 嵌套 LLM 调用 usage 须并入——归会话总量（审计口径）
}
```

- **content/details 双面契约 + 事实同源不变量（R6，本票新增约束）**：双面保留（#751 建议），但写死硬不变量——**渲染卡上展示的每一个结论性事实（产物 id、成功/失败、数量、路径）必须同样出现在 content 里**；details 只承载呈现形态（预览引用、布局数据），不得引入 content 之外的结论。审计口径：用户在卡上看到的每个事实都能在 content 里对上证，无第二真相。
- **截断预算独立**：给模型的 `result`（≤1k，attachmentsJson）与给渲染的 `details`（≤4KB，§2.4）互不挤占。
- **promptSnippet / promptGuidelines**（#751 收录）：插件往系统 prompt 注引导的**声明式**通道——runner 组装时统一注入，插件不碰 prompt 运行时（#751 §7#1）。
- **注册期强校验**（registry 装配 assert + TS 类型层）：category 必填；file 类 `pathParams` 必填；工具名全局唯一（核心 + 跨插件）；zod schema 合法。校验失败 = 启动失败（编译期信任下无「装了一半」状态）。
- **`ctx` 最小面与扩展**：V1 = `{ config, logger }`。插件需要核心服务（如 ProviderRegistry 句柄）时经 ctx 注入（可测接缝），随首个消费者（figure，#753）校准形状；插件同为编译期核心代码、直接 import server 模块不被禁止，但**推荐接缝是 ctx**。不给插件直连口：files 域 fsPort、沙箱 exec、凭证面（#751 §7#19 不迁移）。

### 2.3 命令注册

```ts
interface PluginCommandDefinition {
  name: string                      // 不含斜杠；保留字命名空间（R4）
  description?: string
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | Promise<AutocompleteItem[]>
                                    // #751 收录：参数级补全，经 REST 补全面按需（debounce）调用
  handler: (args: string, ctx: PluginCommandContext) => Promise<PluginCommandOutcome>
}

type PluginCommandOutcome =
  | { inject: string }                          // 以 user message 注入会话（#742 用户命令同形，agent 可追问）
  | { execute: { tool: string; args: unknown } } // 直达本插件工具执行面（R9）
```

- **`execute` 语义**：server 在该会话的 run 内直接调用声明的工具，结果以标准工具事件流（`tool.start` / `tool.end` + details）入会话，**不经 agent 自由裁量**——/figure「两条触发面一条执行面」（#744）的契约落位。handler 只能 execute **本插件已注册的工具**（引用在注册期可静态校验）。
- **`inject` 语义**：与官方目录命令同形（模板插值 → user message 注入；**#758 修订**：交互层内容全部官方维护——插件贡献 + 官方内容目录两源，CONTEXT 词条）。
- **命名空间与冲突（R4）**：命令目录解析序 = 系统命令（核心：/new /compact /model… + 官方内容目录并入系统层语义）> 插件命令（启用位过滤）两源，**无遮蔽**（**#758 修订**：用户命令源随 commands/skills REST 域整域退役消失）。系统/官方/插件命令名是保留字：插件发版新增命令撞系统/官方名 → 收录评审可见、插件侧改名（原「用户自建撞名创建拒绝」随创建端点退役消失）。
- **autocomplete**：命令清单 = 前端常量 + 静态 import + `GET /api/v1/plugins` 启用插件命令合并（**#758 修订**：两源合并，commands REST 域整域退役，无「REST 读目录」端点）；参数级补全经 `getArgumentCompletions` 由 REST 按需调用。

### 2.4 渲染注册（web 面）

```ts
// plugins/autofigure/web.ts
import { definePluginWeb } from '@frontend/plugins/api'   // 路径别名同义
export default definePluginWeb({
  components: {                      // key = 工具名；缺省工具走默认工具行渲染（零成本回退）
    figure_generate: FigureCard,
  },
})
```

- **props 契约**：`{ details, input, state, expanded, isPartial, toolCallId }`（对齐 pi `ToolRenderContext` 精简；`isPartial` 仅实时路径的进行态装饰，回放路径不构造——#730）。
- **挂点**：工具行展开位（ToolLine 展开区）与附件卡位两处；注册组件两处生效，未注册走默认渲染。
- **数据流（R5）**：SSE `tool.end` 事件载荷带 `details` → 前端投影归约器原样落 attachmentsJson v1 `tools[].details?`（≤4KB 截断 + 截断标记）→ 回放读同一字段 → 同组件。
- **单管线约束**：插件组件是归约产物的 **custom-render 分支，不是第二条管线**——组件只消费上述投影输出，不得自行拉取或维护独立状态；验收沿 #730「流式终态 ≡ 刷新回放」零差异，天然覆盖插件卡。

## 3. 类别与审批漏斗路由

类别是插件契约一部分，核心强制校验（根决策 Q11：不信插件自觉）；路由为 #729/#744 已钉事实，本契约正式收录：

| category | 规则层 | judge | 审计落点 |
|---|---|---|---|
| `file` | `pathParams` 声明的参数经 normalizeFilePath 过**路径白名单**（`wiki/**` `lab/**` `/tmp/**`，#729 §1.2） | 白名单外进灰区 | `tool_approval_logs`（ADR 0015） |
| `exec` | shell 词法拆解过**命令黑名单四条**（#729 §1.3）+ 沙箱只读根兜底 | 灰区 | `tool_approval_logs` |
| `domain` | **不进三层漏斗**（#744 钉：漏斗对象是 file/exec 工具参数；domain 工具输入是域内数据） | 不进 | 会话审计域（TextTrace）+ 域自身审计面；**无** `tool_approval_logs` 行 |

- 插件 file/exec 工具与核心工具**同一漏斗同一闸门**——插件注册不产生平行审批路径。
- V2 事件钩子的唯一可行形态 = **漏斗规则层的插件扩展点**（插件声明路径/命令类规则，执行仍归漏斗统一闸门 + 全量审计），禁平行闸门（§6；#751 §7#7 裁决框架）。

## 4. 官方插件目录与启用模型

### 4.1 目录

- 目录 = `plugins/index.ts` 汇出的**编译期静态清单**（manifest 数组），非 JSON 文件、非数据库表、无运行时上传。
- manifest 字段（id/name/description/version + 能力声明 + configSchema）即目录数据源；`GET /api/v1/plugins` 由此渲染目录页。
- **收录流程** = 发版：plugins/<id>/ 目录 + 两处收录行 + env 进 `server/src/config.ts` + 本文档族更新；收录评审把关名字冲突、类别正确性、env 需求（§1 显式收录行动作面）。
- V1 目录仅 AutoFigure 一个成员；第二个插件不预设（map fog）。

### 4.2 启用位

```sql
-- prisma/init.sql 新增（per-user 插件启用位表；#758 修订：command_defs/skill_defs 表不建，原先例引用失效）
CREATE TABLE plugin_enablements (
  ownerId   TEXT NOT NULL REFERENCES users(id),
  pluginId  TEXT NOT NULL,
  enabled   INTEGER NOT NULL DEFAULT 1,
  enabledAt TEXT NOT NULL,
  PRIMARY KEY (ownerId, pluginId)
);
```

- **启用语义**（根决策 Q12）：per-user、跨会话持久——工具/命令在会话中的可用性由 owner 启用集决定。
- **teammate 继承 = per-run 快照**：run 装配时读 owner 当前启用集（#742 技能目录快照同语义）；与禁用语义自洽（run 中途禁用不影响进行中 run）。配额按会话计不变（teammate 不额外占额度）。
- **禁用语义**（根决策 Q12）：新 run 装配不再纳入该插件的工具/命令/promptSnippet；**进行中 run 不中断**（工具集已随 run 快照）；**历史回放不受影响**（投影行自带渲染数据，§2.4 数据流）。
- **runner 装配**：run 启动 → 读 owner 启用集 → 从编译期全量目录**静态过滤** tools/commands/promptSnippet → deepagents tools 集 = 核心工具 + 启用插件工具。即 Pi `setActiveTools`「先全量注册 + 激活集选择」的零子集静态实现（#751 §7#15）；run 内动态激活 = V2。

### 4.3 REST 面（R8）

| 端点 | 语义 |
|---|---|
| `GET /api/v1/plugins` | 目录清单 + 当前用户启用位（`{plugins:[{id,name,description,version,enabled}]}`） |
| `PUT /api/v1/plugins/:id/enablement` | body `{enabled: boolean}`；幂等；写 `plugin_enablements` |

- 码段 **8xxxx plugins 段**（沿 7xxxx figures 先例）：`0` 成功 · `80001` 参数校验失败 · `80040` 不存在/越权**同码防探测**。
- 信封 #312 沿用（HTTP 200 + `{code,message,data}`）。
- 目录页产品细则（UX/管理入口/启用文案）留实施拉动（map fog），不在本契约。

## 5. 配置面

- **V1 只面板级**（根决策 Q13）：管理员经 env 配置，沿 #744 `AUTOFIGURE_*` 形态（env 注入、不落盘、不入日志、不进事件载荷），全部经 `server/src/config.ts` 单一来源。
- **configSchema 声明位**：manifest 声明所需 env 键（名/必填/说明）。V1 语义 = 启动校验依据 + 文档；V2 预留 per-user 插件配置的 schema 载体（随第二个需要它的插件启动，map fog）。
- **启动期校验（R7）**：registry 装配时对**全部目录插件**按 configSchema 断言 env 完备性（不看启用位——任何用户随时可启用 = 面板必须永远备好）；生产缺 env → fail-fast（对齐 config.ts 现行纪律），dev 缺 env → 警告照常收录。

## 6. V2 roadmap 与不迁移面

**V2 候选**（map「Not yet specified」承接；启动前先对 #751 映射表复审）：

1. **事件钩子**（V2 首项）：唯一可行形态 = 漏斗规则层扩展点（§3）；须同时回答事件可见性权限边界（用户消息原文/工具参数脱敏）与「续跑一次」的 runner 语义（#751 §7#9/#10）。
2. **run 内动态工具激活**：Pi 语义整包可借（激活集 delta、teammate 继承时机对齐；#751 §7#15）。
3. **消息面**（appendEntry/sendMessage 类）：从 #751 §5.1 状态选型表起步（details=分支态 / appendEntry=耐久非上下文 / sendMessage=上下文内容 / 外部存储=跨会话，四分法与 #726/#727 分层同构）。
4. **per-user 插件配置**：configSchema 载体已留，随第二个需要它的插件启动。

**不开（根决策重申）**：

- **providers 注册面 / virtual model**（插件自带 LLM provider）：ProviderRegistry 单出口 + 凭证纪律（#731/#744）；多模型路由若做归核心域，不归插件贡献。
- **第三方插件与生态开放**（运行时代码加载/签名/审核/市场）、**self-extensible**（agent 会话内自写自装）：等价 docker.sock 级风险，V1 不碰。

**不迁移面明示**（评估过 Pi 对应面，架构不适用——#751 §8.4，避免重复开题）：

- `registerShortcut` / `registerFlag`（终端/CLI 概念，Web 面板无对应物；面板级偏好归面板级配置）。
- TUI 组件面（setWidget/setFooter/custom overlay/主题）——Web 渲染面被 #730 单管线收口，插件渲染由三件套渲染件覆盖。
- `pi.events` EventBus（插件间直连通信）——无场景；真需要经核心事件面中转。
- 便利设施直连（`ctx.exec` / `withFileMutationQueue` / streamSimple 等）——核心已有对应域，插件经注册的工具间接使用，不给直连口。

## 7. 接缝清单

| 票 | 接缝 | 本契约落位 |
|---|---|---|
| #726 SSE 事件面 | 通用事件目录**不动**：插件工具走标准 `tool.start`/`tool.end`（name=工具名）。两处扩展：① `tool.end` 载荷与 attachmentsJson v1 `tools[]` 增加 `details?`（≤4KB 截断+截断标记）——schema 版本化内 v1 扩展；② 通用 `tool.progress` 事件 = V2（`onUpdate` 先进签名）。域 run 事件族（figure_run.* 类，对齐 wiki_run 先例）= 域规格职责（#753），不进本契约 |
| #729 审批漏斗 | 类别声明 = 漏斗路由键（§3 路由表）；file 类 `pathParams` = 规则层校验目标；domain 不进漏斗（#744 钉，本文正式收录进类别映射）；V2 钩子 = 规则层扩展点 |
| #730 单管线渲染 | 插件组件 = 归约产物 custom-render 分支，非第二条管线（§2.4）；实时/回放同一 `details` 字段；`isPartial` = 进行态装饰仅实时构造 |
| #742 commands/skills（#758 修订） | 两源命令目录（系统含官方内容目录 > 插件，R4 修订）；`{inject}` 与官方目录命令同形；`getArgumentCompletions` 接 autocomplete 面；skills 是内容级扩展**不归插件**（CONTEXT 词条 Avoid 项）；commands/skills 的 per-user 表与 REST 域退役本体归 #747 G 节与 #758，本契约只动插件接缝面 |
| #731 ProviderRegistry | 插件不带 provider（根决策）；插件工具需 LLM 时经 ctx 服务句柄用核心出口，形状随 #753 校准 |
| #744 AutoFigure | 目录首成员：默认未启用、一键启用（根决策 Q16）；env 配置形态延续（AUTOFIGURE_*）；`/figure` = `{execute}` outcome 先例；figure 工具 = domain 类别先例；**迁移细节（#744 修订面）归 #753** |
| #747 交接规格 | 本契约并入由 #754 汇编：M3 区间插插件骨架（Plugin API + 目录 + 启用模型），不阻塞整体（根决策 Q14）；AutoFigure 六票拆分相应修订 |

**术语核对**：CONTEXT.md 四词条（插件 / 官方插件目录 / 插件启用 / 能力实现层与用户交互层）零改动——本票全部新概念（manifest、双面契约、保留字、启用位表）均为实现细节，属规格不属词汇表；figure 工具词条已随 PR #748 预修订为插件宿主表述。

## 8. 测试接缝（沿 #747 四层定稿）

- **S1 信封 REST**：`GET /api/v1/plugins` / `PUT …/enablement`（8xxxx 码、鉴权边界、80040 防探测、幂等）。
- **S3 纯逻辑**：注册期强校验（类别必填 / file 类 pathParams / 工具名·命令名全局唯一 / execute 引用合法）；启用集过滤（run 装配纯函数）；命令目录两源合并（#758 修订：系统含官方目录 > 插件）；双面契约截断（result ≤1k / details ≤4KB + 截断标记）。
- **前端 vitest**：渲染注册表挂载与默认渲染回退；插件卡实时/回放零差异验收（#730 验收延伸）。

## 9. 开放点（不阻塞 #754 汇编）

1. `ctx` 服务句柄形状（ProviderRegistry 等）——随 #753 首个消费者校准。
2. 域 run 事件族（figure_run.* 类）形状——归 #753（wiki_run 先例）。
3. per-user 插件配置 schema 载体语义——V2，随第二个需要它的插件启动。
4. 事件钩子最小集定义——V2 启动前对 #751 映射表复审（map fog）。
5. 目录页产品细则（UX/文案）——实施拉动（map fog）。
