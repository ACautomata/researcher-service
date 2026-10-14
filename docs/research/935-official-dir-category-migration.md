# 935 — C1·research：`official/` 目录约定溯源 + 目录分组→category label 迁移面盘点

> wayfinder #926 的研究票。三个问题：(a) `official/` 目录约定从哪来；(b) 「顶层目录分组 → frontmatter category」迁移触点清单；(c) OpenWiki（npm `openwiki@~0.6.1`）对目录结构/前缀有没有功能性依赖。
>
> 信源分级：本仓源码/docs/git 全历史（最高）· `node_modules` 不可用（依赖未安装），openwiki 取证走 unpkg `openwiki@0.6.1` dist 逐文件 + `langchain-ai/openwiki` GitHub code search（同为包源码，一手）· 旧 researcher 仓库 `/Users/junran/Documents/researcher` workspace skills（一手）· GitHub issues #926/#848/#935（决策记录）。

## Agreements

以下为 #926 会话定稿的决策记录（本研究的上游语境，迁移规格票直接继承）：

- The user agreed that 「退役现有标签 - Official」指退役 `official/` 目录前缀分组方式（分类从目录迁移到 category label）。
- The user agreed that 「OpenWiki 原生 category label」以自定 frontmatter 约定落地（勘察结论：OpenWiki 无原生 label/category 系统，最接近形态 = frontmatter tags）。
- The user agreed that category 只放 meta（frontmatter），不写入页面正文——正文零分类输出，前端从 frontmatter 解析渲染。
- The user agreed that 「中文保证」覆盖三层：OKF status 中文化 + 生成侧中文约束（wikigen prompt 保证 type/tags/正文中文）+ category 固定中文值域。

---

## 一、`official/` 溯源结论

**一句话结论：`official/` 不是任何在库约定——代码、生成 prompt 资产、docs、GLOSSARY、测试 fixtures、git 全历史（`git log --all -S 'official/'`）零命中；它只存在于运行时用户 wiki 容器数据中，是生成链（planning LLM 自由选目录名）的产物，本仓对它没有任何强制或文档化约定点。**

### 1.1 排查面与结果

| 排查面 | 手段 | `official/`（wiki 目录义）命中 |
|---|---|---|
| 全仓源码/docs（`*.ts/*.vue/*.md/*.json/*.mjs`） | `grep -rn -i 'official'`（排除 node_modules/.git） | 0（命中全部属下述三族无关语义） |
| git 全历史 | `git log --all -S 'official/' --name-only` | 0（命中文件 = `deploy/DEPLOY.md`、`.github/workflows/cd.yml`、`server/Dockerfile`、`server/scripts/build-official-content.mjs`、`server/src/officialContent/generated.ts` 等，全是 #787 官方内容目录的**构建上下文**义） |
| wikigen 生成 prompt 资产（#848 产线） | `plugins/research/prompts.ts` + `plugins/research/components/` 全量 grep；`server/src/runner/wikigen/values.ts:41-56`（WIKI_UPDATE_TEAMMATE_PROMPT） | 0——prompt 里路径是泛化形态 `openwiki/<group>/<name>.md`（values.ts:48），无具体目录分类法；#848 抽取的是四流程步骤/模板资产，不涉 wiki 目录约定 |
| docs/research/320（#858 交接规格汇编） | grep | 0——:105 story 37 只说「按目录分组（开放词表，无硬编码分类）」，未点名任何目录 |
| GLOSSARY.md | grep | 0——「官方插件目录/官方内容目录」（:292/:296）是 #787 commands/skills 概念 |
| 测试 fixtures | `server/test/` grep 目录名字面量 | 0——fixtures 用 `concepts/`（wikigenMirror.test.ts:36、wiki-auth.test.ts:18、runnerRunService.test.ts:257）与 `papers/`（wikiDocsPortSmoke.test.ts:121、researchPrompts.test.ts:117-154），无 `official/` |
| openwiki@0.6.1 包 + upstream `langchain-ai/openwiki` | unpkg dist 逐文件 + `gh search code 'official' --repo langchain-ai/openwiki` | 0——upstream 全部 "official" 命中是 build-channel/telemetry 语义（`src/telemetry/*`、`scripts/stamp-build-channel.cjs`）；无 wiki 目录分类法 |
| 旧 researcher 仓库 workspace skills | `grep -rn official /Users/junran/Documents/researcher/workspace` | 0——其 wiki 约定 = 五核心目录 `concepts/entities/sources/syntheses/reports` + `domains/<domain>/papers/` 子树（`docs/research/r7-wiki-read-mechanism.md:19-27,97` 实测），无 `official/` |
| wiki 容器种子 | GLOSSARY.md:243「wiki 树**零初始化**——OpenWiki 工具按需自行生成，骨架不烤进镜像」 | 镜像/种子不携带任何目录约定 |

### 1.2 仓内 "official" 三族无关命中（甄别记录，防后续误引）

1. **#787 官方内容目录**（`officialContent/`、`read_official_skill`、repo 根构建上下文 `official/`）——面板自带 commands/skills 静态目录，与 wiki 内容目录无关（GLOSSARY.md:296；#858 后仅存构建上下文引用，`deploy/DEPLOY.md:46`）。
2. **`frontend/src/wiki/reader.ts:3` 注释 "Official visualize reader shape"**——声明该解析器形状抄自 openwiki 的 visualize 页阅读器（`openwiki/dist/visualize/`，读 title/type/tags），是**出处声明**不是目录约定。
3. **deploy/CI 构建上下文 `official/ + plugins/`**（`server/test/prodDeploy.test.ts:92-94`、`devDeploy.test.ts:93-94`）——Docker build context 目录，#858 已大半退役。

### 1.3 `official/` 目录的实际产生机制（推断 + 证据）

生成链上**没有任何一层**强制目录名：

- 通道②（wiki-update teammate）：`WIKI_UPDATE_TEAMMATE_PROMPT`（`server/src/runner/wikigen/values.ts:41-56`）路径映射是泛化 `<group>`，无目录白名单。
- 通道③（面板更新 run）：`runNativeRepositoryGeneration`（`server/src/wiki/updateRun.ts:117`）——页路径由 openwiki 内部 planning LLM 决定；上游 `PlanPageInput.path` 仅 `z.string().trim().min(1)`（`integrations/core/protocol.js` 实测），零目录约束。
- 插件写面（#908）：四流程建页路径由 draft 传入，仓内 prompt 无目录字面量。

→ `official/` 最可能是 planning LLM / 早期 agent 在无约束下的自由选名（如把「官方导入内容」放 `official/`），经 buildTree 顶层分组（dockerFs.ts:104 首段即组）固化为前端可见分组标签。**运行时用户容器数据无法勘察（盲区，见 §四）**，此推断无法在本仓内闭环验证。

---

## 二、迁移触点清单（顶层目录分组 → frontmatter category）

> 现状基线：树分组 = tar 条目首段目录（`buildTree`）；前端 FileTree 直接把目录名渲染为分组标签；页内分类另有 Django 时代 `category:` 正文标记机制，**现行 Express 代码已整体退役**（`server/src/wiki/` + `frontend/src/wiki/` grep `categor` 零命中；725:98 记录的是旧形态），category label 是全新 frontmatter 键。

### 2.1 服务端

| # | 触点 | 位置 | 迁移时要动什么 |
|---|---|---|---|
| S1 | buildTree 顶层分组 | `server/src/wiki/dockerFs.ts:97-114`（分组键 `t.name.split('/')[0]` 在 :104） | 分组依据从「tar 条目首段」改为「页 frontmatter `category` 字段」。快照已整树在内存且 titleFromEntry（:171-179）已在解析 frontmatter——同 pass 提取 category 即可，无额外 IO |
| S2 | 顶层散落页排除 | `server/src/wiki/dockerFs.ts:151`（`if (!t.name.includes('/')) return null`） | 「无目录 = 不可见」语义与 category 世界冲突（无目录页也可有 category）——该过滤要随分组语义重审；注意 S2 放开会同时改变 buildGraph 节点全集（见 S6） |
| S3 | tree/graph 契约形状 | `server/src/wiki/fsPort.ts:20-28`（`WikiTreeGroup{kind,name,pages}` / `WikiTree{groups}`） | 若保留 groups 形态仅换分组键则类型不动；若分组名带中文值域，`kind`/`name` 语义要重定义（现二者同值 = 目录名） |
| S4 | GET /wiki/tree 端点 | `server/src/wiki/routes.ts:86-89`（注释「开放目录分组；不收顶层散落页」:86） | 端点签名不变；注释与语义同步 |
| S5 | SKIP 集与 `official/` 残留 | `server/src/wiki/values.ts:10-11`（SKIP_DIRS/SKIP_FILES）；消费面 `logic.ts:118-122`（isManagedRelPath，读写双侧 + wikisearch 镜像 + wikiToolPort 写面共用单源） | 存量 `official/` 页迁移策略若选「不迁移兼容读」，退役的目录名不需要进 SKIP（页仍在树中）；若选「物理迁移」，迁移脚本须整树重写。SKIP 集本身大概率不动 |
| S6 | buildGraph 节点全集 | `server/src/wiki/service.ts:64-68`（`tree.groups.flatMap(g => g.pages)`） | 图节点集 = 树页集。S2 若放开顶层散落页，graph 节点静默变多——行为变化要有测试锚 |
| S7 | `.claims` 旁车路径映射 | `server/src/wiki/logic.ts:193-199`（claimsSidecarPath：`concepts/a.md → .claims/concepts/a.json` 目录镜像） | 映射本身与 category 无关、不动；**但若迁移涉及移动页文件，必须同步搬旁车**，否则 claims 只读面（`dockerFs.ts:136-144` readClaimsFile）静默丢证据（旁车缺失 = 「无证据面板」不报错） |
| S8 | 相对链接断裂风险 | `server/src/wiki/logic.ts:124-145`（markdownLinkTargets 收 `[text](../dir/page.md)` 相对目标）+ `service.ts:85`（图边） | OKF 页间关系是**目录相对链接**——若迁移移动页文件，相对链接全断（ghost 节点暴涨）。frontmatter-only 迁移（文件不动）可完全规避；这是迁移策略的关键输入 |
| S9 | 通道② prompt 注入点 | `server/src/runner/wikigen/values.ts:41-56`（WIKI_UPDATE_TEAMMATE_PROMPT；`:48` 路径映射、`:49` OKF frontmatter 约定「type/title/description/tags」） | category 中文值域 + 「正文零分类输出」约束落进此 prompt（`:49` 邻位追加）；`<group>` 示例措辞随新目录约定复核 |
| S10 | 通道③生成侧 | `server/src/wiki/updateRun.ts:117-123`（runNativeRepositoryGeneration，openwiki 内部 planning） | **无注入面**——openwiki planning LLM 的计划 prompt 在包内，本仓只能靠 `language` 参数（lifecycleTools.ts:51 begin schema）与镜像内既有 frontmatter 惯例间接影响。category 值域约束在通道③不可强制（缺口，规格票要显式划界） |
| S11 | 检索工具示例路径 | `server/src/runner/wikisearch.ts:126`（ReadSchema description `"openwiki/concepts/attention.md"`） | 软提示，随新目录约定复核措辞（非功能依赖） |
| S12 | 生命周期工具示例路径 | `server/src/runner/wikigen/lifecycleTools.ts:60`（PlanPageModelSchema description `"openwiki/concepts/demo.md"`——**本仓自建 description，非上游原文**，上游 protocol.js 无此示例） | 同 S11；这是 planner LLM 看到的目录示例来源之一，是引导生成侧目录习惯的实际杠杆 |
| S13 | 插件建页 frontmatter 组装 | `server/src/wiki/pluginPage.ts:69-93`（assemblePageMarkdown：type/title/status/stale_after/generated/source/toolCallId/workflow/related_pages）；类型集 `server/src/plugins/api.ts:135`（`PLUGIN_PAGE_TYPES = ['paper','critic','idea-card','experiment-report']`） | 插件四流程建页若纳入 category 体系，在此加 `category:` 行（单点组装，四流程自动一致）；`type`（页面体裁）与新 `category`（主题分类）两键的关系要在规格票定稿（建议并存不合并） |

### 2.2 前端

| # | 触点 | 位置 | 迁移时要动什么 |
|---|---|---|---|
| F1 | frontmatter 解析 | `frontend/src/wiki/reader.ts:4-20`（返回 type/title/description/tags；:17 tags 数组形态） | 加 `category` 字段解析（照 :17 tags 同款 string[] 收敛；若值域单值则 string） |
| F2 | tree DTO | `frontend/src/api/wiki.ts:12-20`（WikiTreeGroupDTO/WikiTreeDTO） | 随 S3 契约同步（分组名 = 中文 category 值时类型不变、语义变） |
| F3 | 分组渲染（目录名 = 分组标签的**唯一用户可见面**） | `frontend/src/components/FileTree.vue:21-23`（`v-for g in groups` → `group-name`） | 目录名原文 → category 中文值渲染；`data-test="group-${g.kind}"` 选择器随之复核 |
| F4 | store 透传 | `frontend/src/stores/wiki.ts:8,19,45`（groups 状态） | 纯透传，预计零改动（契约不变时） |
| F5 | 视图消费 | `frontend/src/views/WikiView.vue:100,210-214`（emptyMessage 判 groups 非空 + FileTree props） | 预计零改动；S2 放开散落页时空态文案语义复核 |
| F6 | 页头 chips 渲染 | `frontend/src/components/WikiPreview.vue:40-43`（:40 eyebrow = doc.type；:43 `.tags` chips = doc.tags） | category chip 渲染点（:43 邻位）；注意 category 与 tags 是两个键，视觉上是否合并/区分要设计决策 |
| F7 | 图视图 | `frontend/src/components/WikiGraph.vue:37-55`（扁平 nodes/edges，无分组/目录消费） | **现状零目录依赖**——图不直接吃目录分组；若要按 category 着色/聚簇是增强项非迁移必需（V1 可不动） |

### 2.3 测试锚（fixtures 里的目录字面量）

| # | 位置 | 内容 |
|---|---|---|
| T1 | `server/test/wikigenMirror.test.ts:36-44,85-125` | fixtures 顶层目录 `concepts/`（+ `.claims/concepts/` 旁车镜像断言） |
| T2 | `server/test/runnerRunService.test.ts:257,275` | `concepts/attention.md` fixture + `openwiki/concepts/attention.md#` ref 断言 |
| T3 | `server/test/wiki-auth.test.ts:18` | fake FS `concepts/a.md` |
| T4 | `server/test/wikiDocsPortSmoke.test.ts:121,134` | `papers/smoke.md` |
| T5 | `server/test/wikiContainerRest.test.ts` 等树契约测试 | buildTree 分组断言（分组键改 frontmatter 后全量重锚） |

---

## 三、OpenWiki 目录依赖结论

**结论：openwiki@0.6.1 对目录结构的唯一功能性依赖是 `<root>/openwiki/` 单层前缀（基础设施义），对业务子目录（concepts/official/…）零代码依赖、零分类法；frontmatter 校验面无 category/label 字段，但容忍并 round-trip 保留生产者扩展键——自定 `category:` frontmatter 键可无损穿过 openwiki 校验/重写链。**

逐点证据（openwiki@0.6.1 dist 实测，unpkg）：

1. **布局硬约束只有 openwiki/ 前缀**：`OPEN_WIKI_DIR = "openwiki"`（`dist/config/constants.js`）；`normalizeWikiPagePath`（`dist/claims/brains/code/paths.js`）要求路径 `/openwiki/` 前缀 + `.md` 结尾，拒 traversal 段、保留名（`index.md`/`log.md`/`instructions.md`）与 `.claims` 段；检索面 `normalizeRetrievableWikiPage`（`dist/retrieval/wiki.js`）再加「非隐藏段、≤1000 字符」。本仓 `wikisearch.ts:75-111` pullWikiMirror 已按此把容器 `/wiki` 树映射为 `<tmp>/openwiki/**`——迁移对这层透明。
2. **submit_plan 路径零目录约束**：`PlanPageInput.path: CanonicalString = z.string().trim().min(1)`（`dist/integrations/core/protocol.js`）——无扩展名/目录规则；`openwiki/concepts/demo.md` 示例只存在于**本仓自建**的模型面 schema description（lifecycleTools.ts:60）与工具 description（wikisearch.ts:126），是软提示不是上游契约。
3. **检索完全不看目录**：`searchWiki` 对全部页扁平排序（`dist/retrieval/wiki.js`），目录不参与分组/加权；frontmatter 只消费 `status`（deprecated 剔除）/`title`/`description`/`tags`（折进检索标识符）/`sources`（repo:// 加权）——**不读 type，更无 category**。
4. **frontmatter 校验面**（`dist/okf/frontmatter.js`）：必填 `type`（自由字符串，**无枚举**——本仓 PLUGIN_PAGE_TYPES 是插件 port 层自己的收敛）+ `title`；可选 `description/resource/timestamp/tags/generated/verified/sources`；`status ∈ draft|stable|deprecated`（缺省 stable）；`stale_after` 须 ISO 8601 显式 UTC 偏移。**无 category/label 字段**；扩展键「容忍并 round-trip 保留」（725:64 实测结论一致）。
5. **保留/结构面**（与本仓 SKIP 集已对齐，values.ts:10-11）：`index.md`/`log.md`/`INSTRUCTIONS.md` 文件 + `.claims/`、`.run.json`、`.page-manifest.json`、`.last-update.json` 基础设施件——category 迁移不触碰。
6. **生成侧无目录注入面**：通道③ `runNativeRepositoryGeneration` 的 planning prompt 在包内，无目录分类法参数（参见 S10 缺口）。

---

## 四、盲区标注（运行时数据）

以下事实无法在本仓内核实，规格票决策时须以生产/真实环境勘察为准或显式接受风险：

1. **存量 `official/` 页的实际形态**：数量、frontmatter 现状（有无 type/tags）、是否已被检索/图谱消费——运行时用户 wiki 容器数据不可勘察（#926 亦仅记「存量 wiki 数据（含 official/ 页）」）。§1.3 的产生机制是推断。
2. **存量页的目录分布全貌**：除 `official/` 外还有哪些自由生长的顶层目录（fixtures 的 concepts/papers 只是测试惯用，不代表运行时分布）——影响迁移脚本覆盖面与 FileTree 现网显示。
3. **存量 `.claims` 旁车与页的一致性**：若迁移移动页文件，旁车同步搬迁的正确性无法离线验证（S7 风险放大系数未知）。
4. **通道③ planning LLM 的实际目录习惯**：openwiki 包内 planning prompt 的目录倾向（是否复现 `concepts/` 惯例）无法静态确证——只能经真实 run 观测（复跑需 LLM_API_KEY + 真 docker daemon，见 AGENTS.md 门控）。

---

## 附：信源索引

| 主题 | 位置 |
|---|---|
| buildTree 顶层分组 | `server/src/wiki/dockerFs.ts:97-114`（:104 分组键、:151 顶层散落排除） |
| tree 端点 | `server/src/wiki/routes.ts:86-89` |
| graph 节点全集 | `server/src/wiki/service.ts:64-68` |
| SKIP 集 / isManagedRelPath | `server/src/wiki/values.ts:10-11` / `server/src/wiki/logic.ts:118-122` |
| claims 旁车映射 | `server/src/wiki/logic.ts:193-199` |
| 通道② prompt | `server/src/runner/wikigen/values.ts:41-56` |
| 生命周期工具 schema | `server/src/runner/wikigen/lifecycleTools.ts:49-106`（:60 示例路径） |
| 检索工具 | `server/src/runner/wikisearch.ts:75-130`（:126 示例路径） |
| 通道③ | `server/src/wiki/updateRun.ts:104-144` |
| 插件建页组装 | `server/src/wiki/pluginPage.ts:69-93`；`server/src/plugins/api.ts:135` |
| 前端解析/chips/分组 | `frontend/src/wiki/reader.ts:4-20`；`frontend/src/components/WikiPreview.vue:40-43`；`frontend/src/components/FileTree.vue:21-23` |
| 现行代码无 category 机制 | `server/src/wiki/`、`frontend/src/wiki/`、`frontend/src/api/wiki.ts` grep `categor` 零命中 |
| Django 时代双机制（历史） | `docs/research/320-implementation-spec.md:105,111,275`；`docs/research/725-openwiki-embedding-okf.md:96-98` |
| openwiki 样例 `<category>/index.md` 布局（目录统称义） | `docs/research/725-openwiki-embedding-okf.md:56-57` |
| 旧 openclaw 五核心目录 | `docs/research/r7-wiki-read-mechanism.md:19-27,97,216` |
| wiki 树零初始化 | GLOSSARY.md:243 |
| 决策语境 | GitHub issue #926（Agreements 转录来源）、#935、#848 |
| openwiki 上游 | unpkg `openwiki@0.6.1` dist（constants/claims/brains/code/paths、retrieval/wiki、integrations/core/protocol、okf/frontmatter）；`gh search code` langchain-ai/openwiki |
