# wiki 中文保证与 category label 体系交接规格（official/ 目录分组退役 · #787 官方内容目录退役）

> Wayfinder 执行票 [#947](https://github.com/ACautomata/researcher-service/issues/947)（map [#926 Wiki 中文保证与 category label 体系](https://github.com/ACautomata/researcher-service/issues/926) C6·task——决议已全部收口，本规格**零新决策**，全部形状以上游票决议原文为最终准据）。
> 上游票链：C1 [#935](https://github.com/ACautomata/researcher-service/issues/935)（迁移触点 25 条）· C2 [#936](https://github.com/ACautomata/researcher-service/issues/936)（值域/字段/中文三层设计九决策）· C3 [#937](https://github.com/ACautomata/researcher-service/issues/937)（UI C 形态定形）· C5 [#939](https://github.com/ACautomata/researcher-service/issues/939)（退役触点 66 条）· C4 [#942](https://github.com/ACautomata/researcher-service/issues/942)（规格收口六决策）+ [#938](https://github.com/ACautomata/researcher-service/issues/938) 补充决议（与 #942 同职责的并行票，已按重复关闭；不重叠项由 #947 承接）。
> 触点细节引用两份 findings 文档（已随 #943 落 main）：[935-official-dir-category-migration.md](../research/935-official-dir-category-migration.md)（行号基线 aa56215）与 [939-official-content-dir-retirement.md](../research/939-official-content-dir-retirement.md)。本规格内嵌五面执行骨架，细节触点一律引用 findings，不重复转录。
> 术语以 GLOSSARY.md 为准（**category（主题分类）** / **页面体裁 (page type)** 词条 + 「官方内容目录」退役决定注）。
> 本规格**不含施工票拆分**（沿 853 §11.2 惯例——开票与打 ready-for-agent 等用户指令）。
> 盲区（运行时容器数据不可勘察、node_modules 依赖面等）以两份 findings 的「盲区」节为准，本规格不重复记录。

## 0. 目标形态与施工轨

**终点形态**（map Destination）：wiki 分类从目录前缀（`official/` 等运行时自由生长目录）迁移到 frontmatter category label（固定中文值域四类 + 未分类，正文零分类输出），目录分组退役；type 枚举按词形三规则重写；OKF status 前端中文化（显示层映射）；wikigen 生成侧「内容中文、结构豁免」约束落 prompt 资产；存量数据不迁移兼容读；**#787 官方内容目录整链退役**。

**两条施工轨，同 PR 落地、互不阻塞**：

- **A 轨·category 迁移**（wiki 域 + 生成侧）：frontmatter 新键 + buildTree 分组键改造 + 前端 C3 形态 + prompt 约束。
- **B 轨·#787 官方内容目录退役**（命令/构建域）：66 条触点（净删 8 文件 + 约 20 处改行），施工第一步有搬家硬约束（§7）。

**「中文保证」三层**：OKF status 中文化（draft/stable/deprecated → 草稿/稳定/已弃用，显示层映射）+ 生成侧中文约束（wikigen prompt 保证正文/tags/description/title 中文）+ category 固定中文值域。

## 1. frontmatter 约定

### 1.1 `category`（新增键）

- **中文单值**；值域固定四类：**论文 / 科学问题 / 假说 / 实验报告**（与页面体裁一一映射）+ 缺省「**未分类**」。单页一组，否决多值。
- critic 页归「科学问题」；「实验方案」不单列——`experiment-plan` 是 run 审批产物卡片（`runner/approval/` + PlanApprovalCard），非 wiki 页面类型。
- 「官方」不入值域（官方体系退役，存量 `official/` 页成无主存量 → 落「未分类」）。
- 值缺失 / 越界 / 通道③自建页一律读面归「未分类」（读面归组，不回写文件）。
- 只写 frontmatter meta，**正文零分类输出**——前端从 frontmatter 解析渲染（复用 type/tags 充当分类已否决：type 是代码消费面的英文体裁枚举，tags[0] 约定脆弱）。
- OpenWiki 校验面无 category 字段，但容忍并 round-trip 保留生产者扩展键——category 键无损穿过生成/校验/重写链（C1 §三-4）。

### 1.2 `type` 重写（词形三规则）

- 新枚举 **`paper / critique / hypothesis / report`**：无连字符、单个名词、动词形态取过去分词。critic→critique 顺修正（critic = 评审者（人），critique = 评审文）。
- 与 category 一一映射：paper→论文 / critique→科学问题 / hypothesis→假说 / report→实验报告。
- 存量旧值（`paper / critic / idea-card / experiment-report`）**不迁移**；读面宽松——reader 不校验枚举、旧值原样渲染；`PLUGIN_PAGE_TYPES`（`server/src/plugins/api.ts:135`）只约束新写入。
- 机读标签撞名修正：853 §4.2 validate² 与 #848 §2 prompt 资产里的 **`category: critic` → `type: critique`**（category 键保持中文值域不被污染；回写清单 §8）。

### 1.3 `tags` 不动

自由检索标签（折进检索标识符），键保留；生成侧中文约束适用（§4.5）。

### 1.4 OKF `status` 显示层映射

数据层 `draft/stable/deprecated` 英文值**不可动**（OpenWiki `okf/frontmatter.js` 校验 + 检索 deprecated 剔除依赖英文值）；前端渲染层映射 **草稿 / 稳定 / 已弃用**，中文徽标内联 h1 右侧（C3 形态，§3.1）。

## 2. 执行骨架·服务面

### 2.1 A 轨：buildTree 分组键改造（触点细节引用 935 §2.1）

- **S1** `server/src/wiki/dockerFs.ts:97-114`：分组键从 tar 条目首段目录（`:104`）改为页 frontmatter `category`。快照已整树在内存且 `titleFromEntry`（:171-179）已在解析 frontmatter——同 pass 提取 category，无额外 IO。
- **S3** `server/src/wiki/fsPort.ts:20-28`：`WikiTreeGroup{kind,name,pages}` 类型不动；kind/name 维持同值 = category 值（口径归一 R1）。
- **S4** `server/src/wiki/routes.ts:86-89`：端点签名不变，注释（「开放目录分组」）与语义同步。
- **S2** `dockerFs.ts:151`：顶层散落页排除（`if (!t.name.includes('/')) return null`）**放开**——「pages/ 平铺 + 不迁移兼容读」下大量散落页必须入树。⚠ 该放开同时改变 buildGraph 节点全集（S6），行为锚进测试（§5.1）。
- **S6** `server/src/wiki/service.ts:64-68`：图节点集 = 树页集；S2 放开后节点集显式变大，锚进测试断言（§5.1）。
- **S5** `server/src/wiki/values.ts:10-11`：SKIP 集**不动**——存量 `official/` 页仍在树中（落「未分类」），退役的目录名不进 SKIP。
- **S7** `server/src/wiki/logic.ts:193-199`：`.claims` 旁车路径映射不动（存量零移动，旁车零风险）。
- **S8** `server/src/wiki/logic.ts:124-145` + `service.ts:85`：frontmatter-only 迁移，页文件零移动 ⇒ 目录相对链接零断裂。
- 读面归组：「未分类」组沉底（C3）；目录名从此不进 UI。

### 2.2 A 轨：插件建页组装（S13）

`server/src/wiki/pluginPage.ts:69-93`（`assemblePageMarkdown`）frontmatter 组装加 `category:` 行——**单点组装、按 type 映射**（§11 R2），四流程自动一致且插件零格式知识（853 §3.3「插件只给 PageDraft 元数据」不被触及）。

### 2.3 B 轨：退役 server 消费面（触点细节引用 939 §2.2 D14–D29）

- **D14–D19** `sessions/service.ts`：import 换源（:1 → `plugins/slash.ts`）/ 快照 import 删行（:6）/ `:391` 命令展开点删行（`runContent = p.content`，头注 :386-390 同步）/ `:393` 插件门禁保留换源 / `:396` 随塌缩改（§7）。
- **D20 + #938 Q2** `plugins/commandResolution.ts`：`mergeCommandDirectories` **内联塌缩**进 :396 消费点，整模块删除（§7）。
- **D21–D23** `registry.ts:41-45` / `surface.ts:45`：注释自洽化（先例已删，措辞不引死物）。
- **D24** `runner/capabilities.ts:2,6,11`：删 `official` 字段；`key = JSON.stringify([official.version, enabledPluginIds])` → `JSON.stringify([enabledPluginIds])`。key 唯一消费面 = `runService.ts:1782` 图缓存键；**key 字段形态保留**（插件目录版本仍在 `plugins.catalogVersion` 键位，勿混）。
- **D25** `runner/assembly.ts:36-37,111-112`：`coreToolNames` 删 `'read_official_skill'`、`reservedCommandNames` 只剩系统三值（`'research'` 名释放、在库插件零占用，无需占位）；`pluginsRegistry.test.ts:196-197` 镜像同步（D37）。
- **D26** `runner/runtime/graphFactory.ts:1,62,80,88-89,99`：`official` 参数全删——`subagentExtras` 收缩为 `joinSections(params.pluginPrompt)`，subagent 条件 :89 收窄为 `params.pluginPrompt`。
- **D27** `runner/runtime/runService.ts:1053`：`metadata.officialContentVersion` 删行（langfuse/callbacks 观测维度，删除影响观测查询——预期内，注明）。
- **D28/D29** `runService.ts:1778,1815,1886`：leader/wiki-update 两条 `buildLeaderAgent` 传参删 `official` 实参 ×3。

## 3. 执行骨架·前端面

### 3.1 C3 定形 UI（#937 用户盲选变体 C，四件套）

- **目录树**：分组 + 计数；「未分类」**沉底 + 默认折叠**，当前页落入的分组自动展开。
- **页头**：category 升 **eyebrow 位**（「未分类」灰显）；type 降级 chips **行首描边 chip**（旧词形原样显示）；status **中文徽标内联 h1 右侧**（el-tag round plain）。
- category chip 与 tags chips **视觉分级**（A 实心 chip 方案落选）；值域命名无微调。

### 3.2 A 轨触点（细节引用 935 §2.2）

- **F1** `frontend/src/wiki/reader.ts:4-20`：加 `category` 解析（单值 string，照 :17 tags 收敛形态同款）。
- **F2** `frontend/src/api/wiki.ts:12-20`：DTO 类型不变、语义变（分组名 = 中文 category 值）。
- **F3** `frontend/src/components/FileTree.vue:21-23`：分组标签 = category 中文值渲染；`data-test="group-${g.kind}"` 选择器复核。
- **F4** `stores/wiki.ts:8,19,45`：纯透传，预计零改动。
- **F5** `views/WikiView.vue:100,210-214`：预计零改动；S2 放开散落页后 emptyMessage 空态语义复核。
- **F6** `components/WikiPreview.vue:40-43`：页头 C 形态落点（:40 eyebrow 从 doc.type 换 doc.category；:43 chips 行同步分级）。
- **F7** `components/WikiGraph.vue:37-55`：**零改动**（现状零目录依赖；按 category 着色/聚簇是增强项，V1 不做）。

### 3.3 B 轨：退役前端面（引用 939 §2.2 D30–D31、测试 D39）

- **D30** `chat/slashCommands.ts:2,13-31`：三源合并 → 二源（系统 + 启用插件）——删 `OFFICIAL_COMMANDS` import 与官方段 :16-22，:12 注释同步。
- **D31** `chat/useChatSession.ts:40`：前端自有 `SYSTEM_COMMANDS` 常量，**不动**。
- **D39** `chat/slashCommands.test.ts:1,8-12`：期望清单 → `['/new','/compact','/model','/figure']`；「插件不遮蔽官方名称」用例改测系统命令侧。

## 4. 执行骨架·prompt 面

### 4.1 通道② wiki-update teammate（S9）

`server/src/runner/wikigen/values.ts:41-56`（`WIKI_UPDATE_TEAMMATE_PROMPT`）：`:49` OKF frontmatter 约定邻位追加——**category 中文值域枚举 + 「正文零分类输出」约束 + 新页 `pages/` 平铺**；`<group>` 路径映射示例措辞随新目录约定复核。

### 4.2 目录命名约定（C2 D6）

- 通道② 强制新页 **`pages/` 平铺**；**S11** `wikisearch.ts:126` 与 **S12** `lifecycleTools.ts:60` 示例路径同步（`openwiki/pages/<name>.md`）——S12 是本仓自建 schema description，是 planner LLM 看到的目录习惯实际杠杆。
- 按 category 派生中文目录名**已否决**（工具链转义风险 + 目录语义复活）。

### 4.3 通道③ 划界（S10，缺口显式接受）

`server/src/wiki/updateRun.ts:117`（`runNativeRepositoryGeneration`）无注入面——openwiki planning LLM 的计划 prompt 在包内，category 值域在通道③**不可强制**；划界 = 接受 planning LLM 自由选目录，仅靠 S12 软示例引导（UI 不显示目录后无害）。

### 4.4 插件四流程 prompt 资产（#848 §1–§4 单一来源 → `plugins/research/prompts.ts`）

- 机读字面量全改新词形：`category: critic` 机读标签 → **`type: critique`**（W2 validate² 检查项 + critic §0–§7 模板同步）。
- 叙事词「critic 页 / idea card 页」**保留**（853 §11.3C 消歧行兜底，§8）。
- wiki-conventions（命名/链接约定）目录措辞随 `pages/` 平铺复核。

### 4.5 生成侧中文约束「内容中文、结构豁免」（C2 D4）

正文 / tags 值 / description / title 全中文；**节标题锚点**（W1 11 节 / W2 12 节是代码对账锚）、**frontmatter 键名**、**type 枚举**保持既有形态；**论文页 title 英文豁免维持**（`prompts.ts:29` 源标题钉死，对账锚不丢）。

## 5. 执行骨架·测试面

### 5.1 A 轨重锚（引用 935 §2.3）

- **树契约全量重锚**：T1 `wikigenMirror.test.ts:36-44,85-125` / T2 `runnerRunService.test.ts:257,275` / T3 `wiki-auth.test.ts:18` / T4 `wikiDocsPortSmoke.test.ts:121,134` / T5 树契约测试（分组键改 frontmatter 后全量重锚）。
- **graph 节点集显式锚**（S2→S6）：顶层散落页放开后 buildGraph 节点集变化写死断言，防静默漂移。

### 5.2 B 轨测试（引用 939 §2.2 D32–D39）

- 夹具换名：D32 `runnerRunService.test.ts:206,225` / D33 `teammateRuntime.test.ts:159` / D34 `figureRun.test.ts:143` / D35 `pluginWikiDocsPort.test.ts:121`（`read_official_skill` 仅「会成功的工具调用」替身，换名即过）。
- **D36** `sessionsApi.test.ts:426-440`：官方内容 e2e 删/重写——**幂等 replay 覆盖必须保住**（唯一真正消费官方内容的 e2e）。
- D37 `pluginsRegistry.test.ts` 镜像同步；D38 `pluginsCommands.test.ts` 随塌缩删；D39 见 §3.3。

### 5.3 防复活（验收口径之一，细则 §9-2）

rg 六模式零命中（扫描面 = 运行面：`server/src` `server/test` `frontend/src` `deploy/` `.github/`、`plugins/`（插件 manifest/prompt 加载面）、`server/package.json`、`server/Dockerfile`；`docs/research/` findings 与本文档自身为决策档案豁免，GLOSSARY 历史注照 :5 先例不含字面量）：`officialContent` / `official-content` / `read_official_skill` / `officialCommands` / `OFFICIAL_COMMANDS|OFFICIAL_SOURCES` / `official=`；`prodDeploy.test.ts:92-94` 与 `devDeploy.test.ts:93-94` 断言翻**否定式**（不含 official——防复活比防漏删更有价值，漏删在现行断言下立即红）。

## 6. 执行骨架·部署面（B 轨，细节引用 939 §2.3）

- ⚠ **清单外触点**：`deploy/docker-compose.dev.yml:34` `additional_contexts: official: ../official` 必须删——漏改则 `docker compose -f deploy/docker-compose.dev.yml up --build` 直接报 context 不存在。
- 票面记的 `deploy/cd.yml` 实为 **`.github/workflows/cd.yml`**（:11 头注 / :118 步骤注释 / :121 build-contexts 删行）。
- `server/Dockerfile:12-13`（布局注释）/ `:28`（`COPY --from=official` 删行）/ `:66`（尾注）。
- `deploy/DEPLOY.md:46` 多 context 描述改单 context。
- CD 存量镜像含 /official COPY 层——自然被后续构建替换，无显式清理义务（盲区接受）。

## 7. B 轨施工顺序硬约束

1. **第一步先搬家 `SYSTEM_COMMANDS` / `parseSlash`** → 新建 **`server/src/plugins/slash.ts`**（#938 Q3 拍板；取代 939 §四-1 的「sessions 域小 util」建议）。**反序则 typecheck 在 `sessions/service.ts:1` 与 `assembly.ts:36` 两处断链**（D51 硬约束）。
2. **`mergeCommandDirectories` 内联塌缩**进 `sessions/service.ts:396` 消费点（#938 Q2 拍板：退役后插件单源，函数壳不留）；`plugins/commandResolution.ts` 与 `pluginsCommands.test.ts` 同步删除；:396 命令目录合并点变插件单源直传。
3. 删官方内容模块与产物（D1–D13：根级 `official/` 源 2 文件整目录删 + `build-official-content.mjs` + `officialContent/` 三件 + `officialCommands.generated.ts` + `officialContent.test.ts`；`server/package.json:10,20-22` prebuild/content 钩子收编）。
4. 收消费面（§2.3 / §3.3 / §5.2）与构建上下文（§6）。
5. A 轨与 B 轨互不依赖，可同 PR 并行；§8 文档回写随落地同 PR（验收五面）。

## 8. 853 与文档回写清单（随施工同 PR）

| # | 文档 | 位置 | 改动 |
|---|---|---|---|
| 1 | 853 规格 | §3.2 DTO | `PageType` 值集 → `paper / critique / hypothesis / report` |
| 2 | 853 规格 | §3.2 L147 | 过期指针「见 §11.3 待拍板项 B」→「项 C」（#938 Q4） |
| 3 | 853 规格 | §3.3 | frontmatter 组装描述增 category 键（核心按 type 映射单点写入，§2.2） |
| 4 | 853 规格 | §4.1 L175 | 「prompt 注入对标 officialContent 两段式」删 officialContent 引用、机制描述自描述化 |
| 5 | 853 规格 | §4.2 validate² | 「`category: critic` 机读标签」→「`type: critique` 机读标签」 |
| 6 | 853 规格 | §4.2 prompt 资产段 | 同改：`category: critic` → `type: critique` |
| 7 | 853 规格 | §11.3C | 词形落定行同步；追加消歧行——「叙事词 critic 页 / idea card 页 = 体裁 critique / hypothesis 的中文指称；机读字面量 = paper / critique / hypothesis / report」 |
| 8 | 模块地图 | `docs/agents/server-modules.md:21` | PluginPageType 词形同步；`:22` officialContent 整行删除（= D61） |
| 9 | GLOSSARY | 三词条（D55–D57） | 官方内容目录转带注记历史词条（照 GLOSSARY :5 退役总注先例）；能力实现层与用户交互层连锁修订（两源 → 插件单源、失义 Avoid 两条修订）；双面板删「官方内容与」枚举项。另：category 词条「未施工」状态随落地更新（D60 下游衔接） |
| 10 | server 目录树 | `server/README.md:63` | officialContent 树行删除（D62） |
| 11 | 部署文档 | `deploy/DEPLOY.md:46` | 多 context → 单 context（= D48，与 §6 同点） |

## 9. 验收口径（五面）

1. **门禁双绿**：server `typecheck` + `vitest` 全绿；frontend `vue-tsc` + 875 测试全绿。
2. **防复活**：rg 六模式零命中（§5.3）；prodDeploy / devDeploy 否定式断言在位。
3. **dev 栈手工四查**（`docker compose -f deploy/docker-compose.dev.yml up -d --build`）：目录树四类分组 + 「未分类」沉底折叠；页头 C 形态（category eyebrow 灰显 / type 描边 chip / status 徽标）；status 中文徽标（草稿/稳定/已弃用）；通道② run 建页 `pages/` 平铺 + category 写入。
4. **行为锚**：树契约全量重锚过（§5.1）；S2 散落页放开后 buildGraph 节点集显式锚在位。
5. **docs 同 PR**：§8 清单全落。

## 10. 范围边界

**三条款**（C4 #942 Q6）：

1. **wiki 域零改动（B 轨）**：#787 退役对 `dockerFs/values/logic/FileTree` **零改动**——`official/` 分组消隐是 A 轨落地下游效果（自然消隐：分组键改 category 后目录名不再进 UI，存量页落「未分类」保留可读可检索；SKIP 无白名单残留）。
2. **不动 `.claims` 旁车**：853 §11.1「.claims 与页内块语义待实证」的未决面不在本施工顺手定案。
3. **存量零移动**：页文件与 frontmatter 零迁移（不迁移兼容读），保 `.claims` 旁车与页间目录相对链接不断。

**划界增补两条**（#938 Q6）：

4. 853 §11.1 未决面（finalization 遇非治理来源页 / 页内 claims 块的行为 + evidence resource 语义重定义 `repo://`）**不随本施工定案**。
5. 历史 `/research` 模板正文**照常显示**——展开产物存 `session_messages.content`（#778 story 7 设计使然；C5 盲区 3）；若产品语义要求「历史消息也隐藏」是新需求，超出本施工。

## 11. 口径归一记录（解读点，非新决策）

- **R1** S3 两候选取「保留 groups 形态仅换分组键」：`WikiTreeGroup.kind/name` 维持同值 = category 值，契约类型不动。
- **R2** S13「在此加 category 行」的落地形态取「核心组装按 type 映射」而非 draft 传参——四流程建页格式单源、插件零格式知识（853 §3.3 约束的交集解读）。
- **R3** type 读面宽松 = reader 不校验枚举 + 旧词形原样渲染（C2 D7 × C3「旧词形原样显示」交集）。
- **R4** 越界 category 值读面归「未分类」（C2 D2「值缺失 / 越界」落在读面归组，不回写文件）。
- **R5** A/B 两轨同 PR 落地（验收五面「docs 同 PR」单数口径 + 门禁双绿覆盖全仓）。
