# 调研报告：OpenWiki 库嵌入面与 OKF 格式适配（#725）

**结论先行**（三条最关键）：

1. **库嵌入可行，且与根决策（#722「LangGraph + deepagentsjs 基座」）天然对接**。openwiki 是单包 npm CLI（`openwiki` 0.6.0），package.json **无 `exports`/`main` 入口**，但 `files: ["dist", ...]` 全量发布 + `declaration: true`，`import { createOpenWikiAgent } from 'openwiki/dist/agent/index.js'` 即得带完整类型的库 API。它返回的就是 `createDeepAgent` 的 LangGraph graph、模型是 LangChain `BaseChatModel`、文件系统面是 deepagents Backend（**可注入**）——与我们自研 runtime 的接缝全部现成。
2. **多租户的真正接缝是 deepagents Backend 注入，不是文件系统 hack**。`createAgentBackend(wikiBackend, {historyDir, skillsDir})` 的 `wikiBackend` 由调用方传入（默认 `OpenWikiLocalShellBackend`=本地 shell/fs）；把它换成走 Docker Archive 的 Backend 实现（**与 #723 已在做的 `fsPort → BackendProtocolV2` 合流**）即指向每容器 wiki 树。剩余硬点：repository 模式硬依赖 git（须用 `outputMode: "local-wiki"` 避开）、checkpoint `SqliteSaver` 与 `OPENWIKI_CONFIG_DIR` 是进程级单例（同进程多容器并发需上游注入口或 per-container 子进程）、Node ≥ 22.22。
3. **OKF v0.2 对现有 wiki 域是「低冲突增量适配」**：OKF 页就是 markdown + YAML front matter，现有 tree/page/categories API 与 MdEditor 几乎不用动；真实改动面集中在四处——graph 派生须支持 markdown 相对链接（OKF 页间关系是 `[text](../dir/page.md)`，**不是** `[[wikilink]]`，现 `WIKILINK_RE` 解析出来 graph 会是空图）、`SKIP_FILES` 须加 `log.md`/`INSTRUCTIONS.md`、`.claims/` 证据旁车要新只读 API + 前端 evidence 展示、wiki 更新进度事件（`OpenWikiRunEvent`）接入新事件模型（→ #726）。

---

## 一、包形态与库嵌入面盘点

openwiki 是 pnpm 仓库里的**单一 npm 包**（不是多 package workspace；`pnpm-workspace.yaml` 只有一个成员）。关键事实：

| 事实 | 证据 |
|---|---|
| 版本 0.6.0，MIT，`bin: openwiki → dist/cli/cli.js`，`type: module`，Node ≥ 22.22 | `package.json` |
| 无 `exports`/`main`/`types` 字段 → 根 import 无入口，**只能 deep-import** `openwiki/dist/<path>.js` | `package.json` |
| `files: ["dist", "integrations", "skills", ...]` 全量发布；`tsconfig.json` `declaration: true` → deep-import 自带 `.d.ts` | `package.json` / `tsconfig.json` |
| 核心依赖：`deepagents 1.13.2`、`@langchain/*`（anthropic/openai/google/aws/openrouter/core）、`@modelcontextprotocol/sdk`、`langchain`、`yaml`、`zod`、`marked`；ink/react 仅 CLI TUI 用（deep-import agent 模块不触发） | `package.json` dependencies |

**导出的编程 API 面**（`src/agent/index.ts`，2662 行，均入 dist）：

- `runOpenWikiAgent(command: "chat"|"init"|"update", cwd, options: OpenWikiRunOptions, telemetryContext)` — 完整运行边界（持久化 run 元数据 + claims finalization）。`cwd` 任意绝对路径可覆盖默认 `~/.openwiki/wiki`（local-wiki 模式）。`outputMode: "local-wiki" | "repository"`；`init/update` + repository 模式走 native page-job runner。
- `createOpenWikiAgent({command, cwd, language, model, onEvent, outputMode})` — **低层工厂**：传现成 `BaseChatModel`，返回 `createDeepAgent` 的 graph，「不拥有持久化 run 元数据与 claims finalization」→ 正适合嵌入我们自己的 runner（我们的 LangGraph runner 拿 graph 自行 stream / checkpointer 由我们管理）。
- `createModel(provider, modelId, retryAttempts, maxOutputTokens, streamIdleTimeout)` — 13 种 provider 的模型工厂；`openai-compatible` 支持 Ollama/LM Studio/网关 → **我们共享 `LLM_API_KEY` 的 OpenAI 兼容网关可直接接**。
- `parseAgentStreamChunk` / `parseStreamEvent` — 流事件解析。
- `resolveModelId` / checkpoint 系（`pruneCheckpointHistory` 等）。

**MCP / 工具面**（`src/integrations/`）：

- `createOpenWikiMcpServer(provider: HostToolProvider): McpServer` — MCP server 是薄适配；`HostToolProvider.tools()` 返回 **transport-neutral 的 `ProtocolTool {name, description, schema, handle}`**，即检索/生命周期工具集可**进程内直调**，不起 stdio 子进程也能用。
- 检索工具（`src/integrations/core/retrieval-tools.ts`）：`openwiki_search`（root+query+paths 路径加权+limit+workspace）、`openwiki_read`（root+page+sections heading anchors）、`openwiki_list_workspaces`、`openwiki_list_wikis`——**只读、无模型调用**（纯 fs + 排序逻辑）。注意输入 schema 要求 `root` 为「包含 openwiki/ 的绝对 Git 仓库根」。
- 生成生命周期工具：`openwiki_begin → openwiki_submit_plan → openwiki_next_page → openwiki_submit_page → … → openwiki_finish`（+`openwiki_inspect_page_claims`）——供宿主 agent 用自己的原生工具写页、openwiki 只管计划/队列/claims 协调。

**流式事件**（`src/agent/types.ts`，`OpenWikiRunEvent`，经 `options.onEvent` 回调）——完整枚举，可直接作为 #726 wiki 更新事件段的参考形状：

- `repository_progress`：`stage: planning|generating|finalizing|replanning|noop`、`resumed?`、`page?`、`pageIndex?`、`pageCount?`、`completedCount?`、`inFlightPages?`（并发页工作者）
- `text`：`{source?: "main"|"subgraph", text}`
- `tool_start` / `tool_end`：`{call?, id, name, input?, status: error|finished, page?}`（带页归属）
- `debug`：`{message}`

## 二、OKF v0.2 bundle 确切结构

以 openwiki 仓库自生成的 wiki（`openwiki/` 目录）为活样例 + `openwiki/concepts/okf-output.md` 自述文档确证：

```
<root>/openwiki/                 # code 模式输出在仓库根下；personal 模式输出 ~/.openwiki/wiki
├── index.md                     # 根索引，front matter 含 okf_version: "0.2"（嵌套目录 index 无 front matter）
├── INSTRUCTIONS.md              # 保留：给 agent 的操作说明
├── log.md                       # 保留：运行日志
├── .last-update.json            # run 元数据 {updatedAt, command, gitHead?, model, status: complete|interrupted, language?}
├── .page-manifest.json          # 页面清单
├── .run.json                    # 可恢复运行状态（durable run）
├── .claims/<dir>/<page>.json    # 证据旁车：与页面目录结构镜像、同名 .json
├── <category>/index.md          # 每目录一个同步索引（Files/Directories 两节，标题链接=页 title+description）
└── <category>/<page>.md         # 概念页
```

**概念页 front matter**（`src/okf/frontmatter.ts` `validateOkfFrontmatter` 校验）：

- 作者拥有：`type`（**唯一必填**，缺失 → `missing_type`）、`title`、`description`、`tags`（非空字符串 YAML 列表）、`resource`
- OpenWiki code-owned（应代码写入，不应手写）：`generated: {by, at}`（actor 事件）、`verified`（单个或事件列表）、`sources`（列表，每项至少非空 `resource`，样例形如 `{id: openwiki-source-<hash>, resource: repo://src/okf/frontmatter.ts}`）、`status: draft|stable|deprecated`、`stale_after`（ISO 8601 **必须带显式 UTC 偏移**，真实日历校验）
- 生产者扩展键容忍并 round-trip 保留（如 `openwiki_translation_pending`）；非法字段的修复是逐行外科手术式（`setFrontmatterField` 等保字节），只有 YAML 整体不可解析才重建最小 front matter

**`.claims/` 旁车确切结构**（`openwiki/.claims/concepts/okf-output.json` 实样）：

```json
{
  "schemaVersion": 1,
  "pageVersion": "sha256:<整页哈希>",
  "claims": [
    {
      "id": "claim_<32位hex>",
      "statement": "一句原子论断",
      "evidence": [
        {
          "resource": "repo://src/okf/frontmatter.ts#L118-L183",
          "version": "repo-lines-v1:sha256:<文件哈希>:<base64url(行选择指纹)>"
        }
      ]
    }
  ]
}
```

- `repo://` 语义：**仓库根相对路径 + 可选 `#L<start>-L<end>` 行区间**。它指向「生成 wiki 的源仓库」里的文件——code 模式下是代码库；这是「页面论断 → 源码行」的证据锚。
- `version` 指纹（repo-lines-v1）记录选中行/上下文行的哈希，用于**漂移检测**：源码变了 claim 失效，驱动 claims reconciliation（无-issue claims 自动保留，过期则进 pending job 重审）。
- 关键机制（对我们友好）：provenance 协调按**正文 SHA-256 hash** 驱动——run 前快照每页 body hash，run 后 body 未变的页保留原 `generated` 戳。**面板手动编辑过的页，下次 openwiki update 只会重盖 provenance 而不丢内容**；未编辑页 claims 继续有效。面板编辑与 OKF 是共存关系，不是冲突关系。

## 三、与现有 wiki 域对照（求证）

现状（本仓库代码）：

- `WikiFileSystem` Port（`server/src/wiki/fsPort.ts:58`）：`buildTree/readPage/listCategoryPages/writePage/createPage/deletePage`；生产适配器 `DockerWikiFileSystem`（`server/src/wiki/dockerFs.ts:81`）经 getArchive/putArchive/exec 读写**容器内 `~/.openclaw/wiki/main`**。
- tree 形态是分组树 `groups[{kind,name,pages[{path,title}]}]`（按顶层目录分组，不收顶层散落页）；title = frontmatter `paper.title`/`title` → stem。
- graph（`server/src/wiki/service.ts:76`）：边 = 正文 `[[wikilink]]`（`values.ts:9` WIKILINK_RE）+ frontmatter `related_pages`；解析顺序 整串id→stem→title→ghost；ghost = 未解析目标（前端 WikiGraph.vue 已消费 `ghost` 淡显）。
- categories（`service.ts:48`）：来自正文 `category:` 行内标记（H1 后、首个 H2 前窗口），开放词表。
- REST：`createWikiRouter` 7 方法（`routes.ts:41`）：tree/page GET/PUT/POST/DELETE/graph/categories，信封错误码 30040/30041/90002；POST/DELETE 触发 5s 去抖 `docker exec openclaw wiki compile`（`compile.ts:52`）。
- 保留名单：`SKIP_DIRS = {.openclaw-wiki, _attachments, _views}`、`SKIP_FILES = {index.md, AGENTS.md, WIKI.md, inbox.md}`（`values.ts:5-6`）。

**逐项交汇判定**：

| OKF 元素 | 现状判定 | 结论 |
|---|---|---|
| `.md` 概念页 + front matter `title` | 现有 title 链兼容；简易逐行解析器对 inline flow mapping（`generated: {by, at}`）解析为字符串、对嵌套列表（`sources:`/`verified:` 块式）跳过——均无副作用 | **无需动**（如需解析 OKF 字段另加专用解析） |
| `index.md` | 已在 SKIP_FILES | **已兼容** |
| `log.md` / `INSTRUCTIONS.md` | **不在 SKIP_FILES** → 会进 tree/graph/categories、可被面板 PUT 覆盖 | **须加 SKIP_FILES** |
| `.claims/`、`.run.json`、`.page-manifest.json`、`.last-update.json` | 非 `.md` 不进树；但 `.claims` 不在 SKIP_DIRS，写路径校验与未来逻辑可能踩 | **建议 SKIP_DIRS += `.claims`**（防御性） |
| 页间链接 `[text](../dir/page.md)` | **现有 graph 派生只认 `[[wikilink]]` → OKF wiki graph 是空图** | **核心改造点**（见下） |
| `tags` front matter | categories 走正文标记，两者并存不冲突 | 可选适配：tags→categories 映射 |
| mermaid 图 | OKF 保证落盘前已校验/降级；前端 MdEditor 照常渲染 | 无需动 |
| 面板编辑 vs provenance | hash 驱动 reconcile：未动页保留戳，动过的页重盖戳 | **共存安全** |
| compile 触发 | openwiki 自带 finalize（index 同步/mermaid/claims 同步），不依赖 `openclaw wiki compile`；但 openwiki run 完成后应手动补一次搜索索引 compile | 小改造（触发链） |

**graph 派生改造方案**（服务端单点，前端零改动）：`wikilinkTargets`（`logic.ts:138`）旁增加 markdown 相对链接目标提取（`[text](target)` 取 target，仅收 `.md` 结尾相对路径），目标解析复用 `WikilinkResolver`（stem/title 已有）；解析不到 → 现有 ghost 机制直接复用（obsidian 死链语义同构）。

## 四、前端适配清单（→ #730 直接引用）

| # | 项 | 改动 | 量级 |
|---|---|---|---|
| 1 | `api/wiki.ts`（`frontend/src/api/wiki.ts:54`） | DTO 不变（tree/page/graph/categories 结构照旧）；**新增** `getClaims(name, path)` → 新端点 | 小 |
| 2 | WikiGraph（`WikiGraph.vue:12`） | **组件不动**——nodes/edges/ghost 契约保持，graph 修正全在服务端派生层 | 零 |
| 3 | WikiView/FileTree | SKIP 文件由后端过滤后前端自动不见；**新增** OKF 徽章：页头展示 front matter `status`（draft/stable/deprecated）+ `stale_after` 过期标记 + `generated.at` | 中 |
| 4 | 证据面板（新） | `.claims/<path>.json` 读侧新 API；页面侧栏 evidence 列表（statement + `repo://` 锚点 + 漂移状态）。`repo://` 在我们场景语义需重定义（见五-4） | 中 |
| 5 | MdEditor | 实时渲染照常；**可选** front matter code-owned 字段的保护提示（编辑 generated/verified/sources 时警示「OpenWiki 所有，下次 update 会被重写」） | 小 |
| 6 | wiki 更新触发 UI | 「更新 wiki」按钮 → 新 REST 端点（触发控制面内 openwiki run）→ 进度事件流接 #726 新事件模型（`repository_progress` 五阶段 → 进度条：planning/generating(页 x/y)/finalizing） | 中 |
| 7 | categories | 保持现状；可选把 OKF `tags` 并入 categories 视图 | 小 |

## 五、多租户改造点清单（每容器一棵 wiki 树 = 一个 workspace）

OpenWiki 的本地文件系统假设点，逐一给接法：

1. **wiki 树读取/写入面**（核心）：`OpenWikiLocalShellBackend`（`src/agent/docs-only-backend.ts`）是 deepagents Backend 的本地 shell/fs 实现，经 `createAgentBackend(wikiBackend, …)` 注入——**注入点现成**。接法：实现 `DockerArchiveBackend`（deepagents Backend 协议，读写走 getArchive/putArchive），每容器实例化一个。**与 #723 已确认的 `fsPort → BackendProtocolV2` 是同一块拼图，合流实施。**
2. **repository 模式的 git 硬依赖**：`resolveRepositoryRoot`（git top-level 探测）、`OpenWikiIgnore.load(cwd)`（.gitignore 语义）、`gitHead` 记账都在 repository 模式；**用 `outputMode: "local-wiki"` 全部绕开**。我们场景（用户知识 wiki，非代码库文档）本来就该用 local-wiki。
3. **checkpoint**：`createCheckpointer`（SqliteSaver）路径固定 `~/.openwiki` 下，`createOpenWikiAgent` 未暴露 checkpointer 注入口 → 同进程多容器并发共享一个 SQLite 文件（锁竞争 + 租户混淆）。接法：a) 每容器独立 runner 子进程 + `OPENWIKI_CONFIG_DIR` env 隔离（零上游改动）；b) 给上游提 PR 暴露 checkpointer/configDir 注入（`createAgentBackend` 的 historyDir/skillsDir 已是先例，补 checkpointer 是顺路改动）。
4. **`repo://` 证据 URI 的语义重定义**：OKF 的 `repo://` 指向「被文档化的源仓库」。我们的 wiki 树不是代码库文档——若走 openwiki 生成，evidence 指向的是容器内源码/知识源路径；`.claims/` 消费端（前端证据面板）需要约定我们的 resource scheme（如 `workspace://` 指容器内文件，或沿用 `repo://` 指容器内路径）。**这是语义决策不是技术阻塞**，建议在事件模型票或单独小票定稿。
5. **模型 provider**：`createModel` 的 `openai-compatible` + base URL env 可指向共享 `LLM_API_KEY` 网关；库形态更直接——传我们自建的 `BaseChatModel`（`createOpenWikiAgent` 的 `model` 参数），**与 models 域 provider registry（#731 方向）直接对接，无需 env**。
6. **运行时版本**：Node ≥ 22.22（控制面基镜像核对）；`deepagents 1.13.2` 与我们 runtime 选型的版本要对齐（同栈共享，反而降低双份依赖）。
7. **状态目录**：`~/.openwiki`（env 文件、skills、conversation history、checkpoint）；historyDir/skillsDir 可注入（`createAgentBackend` 参数），env 目录经 `OPENWIKI_CONFIG_DIR` 可移位——同进程多容器仍受第 3 条约束。
8. **容器内 spawn fallback 形态**：若最终选容器内 CLI，openwiki 需进 researcher 派生镜像（npm 全局装），personal 模式默认写 `~/.openwiki/wiki` → 容器 entrypoint 一行 `ln -s ~/.openclaw/wiki/main ~/.openwiki/wiki` 即落我们的 wiki 树；多租户天然隔离（每容器独立 home）。代价：进度事件只能轮询 `.run.json`/`.last-update.json`（CLI 是 ink TUI，非交互事件流无文档化出口），**#726 的实时进度语义打折**。

## 六、嵌入方案建议

**主线（依 #722 已钉决策）：库导入 `openwiki/dist/agent`，`createOpenWikiAgent` 图谱接入我们的 LangGraph runner。** 理由：

- 导出面完整且类型齐全（deepagents graph / BaseChatModel / onEvent / Backend 注入），与我们自研 runtime 的三个基座（LangGraph runner、ProviderRegistry、DockerArchiveBackend）严丝合缝——**openwiki 不带来第二套运行时，只带来文档 agent 的 prompt + 生命周期 + OKF finalize 管道**。
- `onEvent` 事件枚举完备 → #726 新事件模型的 wiki 更新段直接映射（progress/text/tool_* 等类）。
- 多租户接缝（Backend 注入）与 #723 工作合流，一次投入两处收益。
- 对比 spawn CLI：CLI 是 ink TUI 优先，非交互模式的事件/退出面未文档化，进度只能文件轮询；且把 agent 生命周期放容器内会与「LLM 移控制面」（#722 根决策）矛盾。
- 对比纯 MCP 接入：MCP 面只覆盖检索 + 生命周期协调，页写入靠宿主 agent 原生工具——它不是独立方案，而是库嵌入之上的可选暴露形态（控制面后续可把 retrieval ProtocolTool 包成 MCP 供调试）。

**前置改造（两件，均在我们的仓库）**：

1. `DockerArchiveBackend implements deepagents Backend`（#723 主线，openwiki 侧零改动复用）。
2. wiki 域 OKF 适配包：SKIP 名单扩充 + graph markdown 链接派生 + claims 只读 API（见三/四节清单）。

**风险与 fallback 触发器**：

- 上游无 `exports` 字段 → 依赖 dist 内部路径稳定；openwiki 迭代快（0.4→0.6 数周内）。缓解：锁 minor 版本 + 升级时跑契约测试；若上游结构漂移频繁，再评估提 `exports` PR。
- `createOpenWikiAgent` 不含 claims finalization 与 run 元数据持久化（`runOpenWikiAgent` 才有）→ 嵌入自家 runner 意味着我们要么自己调 finalizer（`src/agent/wiki-finalizer.ts` 导出面待核），要么接受「面板触发的完整 update 走 `runOpenWikiAgent`、chat 内嵌走 graph」。**建议 PoC 时先验证这条边界**（列入 prototype 票验收项）。
- 若 PoC 发现 deepagents Backend 契约与 Docker Archive 语义（无随机写/无原子 rename/getArchive 整树拉取）在 openwiki 写模式下（逐页 put + index 重写）性能不可接受 → fallback 到「容器内 spawn CLI + symlink」形态，事件面降级为文件轮询。此为唯一不可控风险点，PoC 应优先压测。

## 七、给关联票的输入摘要

- **→ #726（事件模型）**：wiki 更新事件段建议直接采用 `OpenWikiRunEvent` 形状：`repository_progress{stage, page, pageIndex, pageCount, completedCount, inFlightPages, resumed}` / `text{source, text}` / `tool_start|tool_end{id, name, page, status}` / `debug`。claim/审批语义 openwiki 侧无对应物（它无 interrupt/approval 面），不要混入。
- **→ #730（前端改造）**：第四节清单；关键判断——WikiGraph/MdEditor/FileTree 三组件本体**零或近零改动**，改动集中在服务端 graph 派生、新 claims API、OKF 徽章与更新进度 UI；「老容器冻结只读」UX 不受 OKF 影响（OKF 适配只服务新 runtime 的 wiki 产物）。

