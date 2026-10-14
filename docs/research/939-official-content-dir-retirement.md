# 939 — C5·research：`#787` 官方内容目录退役触点盘点

> wayfinder #939 C5 research 票（上游：map #926 C2 → #936 D1 已拍板**官方内容目录完全退役**，
> 退役决定注已落 GLOSSARY.md:301）。任务：盘点退役触点全清单，产出 C4 交接规格（退役部分）素材。
>
> 盘点基线 = master @ aa56215（#941）。方法：全库 `rg` 六模式闭合（`officialContent` /
> `official-content` / `read_official_skill` / `officialCommands` / `OFFICIAL_COMMANDS|OFFICIAL_SOURCES` /
> `official=`）+ 符号级闭合（`SYSTEM_COMMANDS` / `parseSlash` / `officialSkillTools` /
> `snapshotOfficialContent` / `OfficialCatalog` / `createOfficialCatalog` / `content:build` /
> `mergeCommandDirectories`）+ 全库 `official` 文件级清单（51 个含命中文件逐一甄别）。
>
> 信源分级：本仓源码/docs/git（最高）· GitHub issues #926/#935/#936/#939（决策记录，经
> GLOSSARY 转录）· node_modules 未安装（依赖引用面走语义甄别，见 §四盲区 2）。

## Agreements

以下为本次研究的上游决策记录（C4 交接规格直接继承）：

- The user agreed that #787 官方内容目录**完全退役**——整链删除（源目录 + 构建脚本 +
  `officialContent/` 模块 + `read_official_skill` + 前端命令目录 + cd.yml 构建上下文），
  `/research` 斜杠命令与技能随之退场、**不搬家**（#936 D1；GLOSSARY.md:301 已录退役决定注）。
- The user agreed that wiki 运行时 `official/` 分组按「随 C2 D5 不迁移决策**自然消隐**、不进
  SKIP、UI 不显示」判断——盘点确认成立，佐证见 §2.6-D63。
- The user agreed that `SYSTEM_COMMANDS`（/new /compact /model）与官方内容**无耦合、退役不受
  影响**——**盘点修正**：语义上成立，但代码上 `SYSTEM_COMMANDS`/`parseSlash` 的定义地在
  `officialContent/catalog.ts:5-9` 内，退役施工**必须先搬家**（§2.4-D51）。这是本盘点最重要的
  清单外修正。
- The user agreed that 本次为只读盘点——唯一写入 = 本文档；GLOSSARY 与源码一律不改。

---

## 一、结论摘要

1. **触点总数 66 条**（D1–D66，含 13 条「确认无耦合/甄别不动」关闭项），覆盖票面六面全部；
   净删 8 个文件 = official/ 源 2 + 构建脚本 1 + officialContent/ 模块 3（含 server generated）+ 前端 generated 1 + 模块测试 1。
2. **票面预期修正（最重要）**：`SYSTEM_COMMANDS`/`parseSlash` 定义在将删模块
   `officialContent/catalog.ts:5-9` 内——语义与官方内容无关（系统命令走
   `executeSystemCommand` 独立分派，不触官方快照），但**代码同文件**。退役施工第一步必须
   先搬家这两个符号（消费方仅 sessions/service.ts:1 一处 + assembly.ts:36 的
   SYSTEM_COMMANDS，前端同名常量是独立定义不受影响）。
3. **清单外触点 2 个**：① `deploy/docker-compose.dev.yml:34` 的
   `additional_contexts: official: ../official`（票面只列了 cd.yml/DEPLOY.md）；② 票面记的
   `deploy/cd.yml` 路径有误——实际文件是 `.github/workflows/cd.yml`（:11/:118/:121）。
4. **wiki 运行时 `official/` 分组「自然消隐」判断成立**：wiki 代码 official 字面量零命中
   （C1 §1.1 已证），分组键是运行时数据的首段目录（dockerFs.ts:104），SKIP 集不含
   `official`（values.ts:10-11）；category 迁移（GLOSSARY.md:356-357，拍板**未施工**）落地后
   目录分组机制整体退场，存量页落「未分类」保留可读可检索——本退役票对 wiki 域**零改动**，
   无 SKIP 白名单残留需要显式处理。
5. **测试面 8 处**：1 个整删（officialContent.test.ts）+ 7 处改行。其中 4 处测试只是把
   `read_official_skill` 当「核心工具名夹具」替身（figureRun/pluginWikiDocsPort/
   runnerRunService/teammateRuntime），换名即过；sessionsApi.test.ts:426-440 是唯一真正消费
   官方内容的 e2e（须删/重写，但幂等 replay 覆盖要保住）。
6. **无 DB 数据迁移面**：官方内容 always-on 无表、生成产物提交入库、历史会话落行存原文
   （模板展开产物在 message content 里，退役后照常显示——#778 story 7 设计使然）。

---

## 二、六面触点清单

> 处置性质五类：【删文件】【删行】【改行】【改逻辑】【确认无耦合】。行号 = 盘点基线 aa56215。

### 2.1 源与构建链（D1–D13）

| # | 触点 | 位置 | 现状 | 处置 |
|---|---|---|---|---|
| D1 | 官方命令源 | `official/commands/research.md`（7 行，frontmatter name/description + `$ARGUMENTS` 模板） | 唯一官方命令 `/research` 的源 | 【删文件】（随目录整删） |
| D2 | 官方技能源 | `official/skills/research/SKILL.md`（12 行） | 唯一官方技能 `research` 的源 | 【删文件】；D1+D2 ⇒ 根级 `official/` 目录整体删除（`find` 全量确证仅这 2 个文件） |
| D3 | 构建脚本 | `server/scripts/build-official-content.mjs`（30 行） | 编译期把 official/ markdown 生成两处 generated.ts | 【删文件】 |
| D4 | prebuild 钩子 | `server/package.json:10` `"prebuild": "npm run content:build && prisma generate"` | Docker build 内经 npm hook 触发 content:build（Dockerfile:28 COPY 的 /official 只被它消费） | 【改行】→ `"prisma generate"` |
| D5 | 三条 content 钩子 | `server/package.json:20-22` `content:build` / `predev` / `pretest` | 宿主 dev/test 防漂移再生成 | 【删行】×3 |
| D6 | catalog 模块 | `server/src/officialContent/catalog.ts`（47 行）：`SYSTEM_COMMANDS:5` `parseSlash:6-9` 护栏/快照构造 `createOfficialCatalog:13-47` | 官方目录核心逻辑 + ⚠ 系统命令符号定义地 | 【删文件】但 :5-9 先搬家（见 D51） |
| D7 | runtime 模块 | `server/src/officialContent/runtime.ts`（25 行）：`snapshotOfficialContent:14-16` `officialSkillTools(read_official_skill):20-25` | 快照 memo + 渐进披露工具 | 【删文件】 |
| D8 | 生成产物（server） | `server/src/officialContent/generated.ts`（`OFFICIAL_SOURCES`，提交入库） | 仅被 runtime.ts:9 import | 【删文件】 |
| D9 | 模块测试 | `server/test/officialContent.test.ts`（护栏 50/4KB/64KB/重名/保留名/名字法断言） | 测 catalog 构造期护栏 | 【删文件】（护栏随模块死） |
| D10 | 生成产物（前端） | `frontend/src/chat/officialCommands.generated.ts`（`OFFICIAL_COMMANDS`，提交入库） | 仅被 slashCommands.ts:2 import | 【删文件】 |
| D11 | .gitignore | 根 `.gitignore:42` = `server/src/generated/` | 两处官方 generated 产物**均提交入库、无 ignore 规则**；:42 是另一无关模块（运行时生成物） | 【确认无耦合】 |
| D12 | 构建配置 | `frontend/vite.config.ts`、`frontend/tsconfig*.json`、`server/tsconfig*.json` | grep 零命中——生成文件走普通 TS import，无构建特判 | 【确认无耦合】 |
| D13 | 前端 npm 钩子 | `frontend/package.json` | 零命中——前端无生成钩子（同源提交、Docker 独立构建直读，build-official-content.mjs:26 注释自述） | 【确认无耦合】 |

### 2.2 消费面（D14–D39）

#### server 消费面（D14–D29）

| # | 触点 | 位置 | 现状 | 处置 |
|---|---|---|---|---|
| D14 | 斜杠解析 import | `server/src/sessions/service.ts:1` | `import { parseSlash, SYSTEM_COMMANDS } from '../officialContent/catalog'` | 【改行】→ 搬家新址 |
| D15 | 快照 import | `server/src/sessions/service.ts:6` | `import { snapshotOfficialContent } from '../officialContent/runtime'` | 【删行】 |
| D16 | 斜杠识别 | `server/src/sessions/service.ts:361` | `parseSlash(p.content)`——系统命令分派（:364-365）与插件门禁（:393）共用 | 【改逻辑】保留调用、换 import 源 |
| D17 | **命令展开点** | `server/src/sessions/service.ts:391` | `snapshotOfficialContent().expand(p.content)`——官方模板 `$ARGUMENTS` 插值进 run 的唯一消费方；头注 :386-390 叙述 | 【删行】`runContent = p.content`；注释同步 |
| D18 | 保留名判断 | `server/src/sessions/service.ts:393` | `!(SYSTEM_COMMANDS…).includes(slash.name)` 插件命令门禁 | 【改逻辑】保留、换源 |
| D19 | 命令目录合并 | `server/src/sessions/service.ts:396` | `mergeCommandDirectories({ official: snapshotOfficialContent().commands, plugin: … })` | 【删行】official 实参 |
| D20 | 两源合并纯函数 | `server/src/plugins/commandResolution.ts:3-34`（`OfficialCommandRef:8-11`、`source:'official'`:13、`official` 参数 :19-22） | 退役后塌缩为插件单源——`mergeCommandDirectories` 失去存在意义 | 【改逻辑】整模块塌缩/内联 sessions；文件头注释 :3-10 两源序叙述同步；测试 D38 同步 |
| D21 | registry 注释① | `server/src/plugins/registry.ts:41-42` | 「核心工具名集（…+ official read_official_skill…）」 | 【改行】注释 |
| D22 | registry 注释② | `server/src/plugins/registry.ts:45` | 「保留命令名（系统命令 + 官方目录命令名…）」 | 【改行】注释 |
| D23 | surface 注释 | `server/src/plugins/surface.ts:45` | 「目录行形态对齐 officialContent catalog.prompt 先例」 | 【改行】注释（先例已删，措辞自洽化） |
| D24 | capabilities 快照 | `server/src/runner/capabilities.ts:2,6,11` | `official` 字段 + `key = JSON.stringify([official.version, enabledPluginIds])` | 【改逻辑】删字段；key → `[enabledPluginIds]`。key 唯一消费面 = runService.ts:1782 图缓存键 |
| D25 | 装配期校验 | `server/src/runner/assembly.ts:36-37,111-112` | `coreToolNames` 含 `'read_official_skill'`；`reservedCommandNames` 含官方命令名（`assertValidPluginCatalog` 注册期校验） | 【改行】两数组删相应成员；pluginsRegistry.test.ts:196-197 镜像同步（D37） |
| D26 | 图构建（leader+teammate） | `server/src/runner/runtime/graphFactory.ts:1,62,80,88-89,99` | `official?: OfficialCatalog` 参数；目录行 prompt 注入 leader systemPrompt(:88) + GENERAL_PURPOSE_SUBAGENT 继承(:80)；`officialSkillTools` 进工具面(:99)；subagent 条件 :89 | 【改逻辑】全删——subagentExtras 收缩为 `joinSections(params.pluginPrompt)`，条件 :89 收窄为 `params.pluginPrompt` |
| D27 | 观测 metadata | `server/src/runner/runtime/runService.ts:1053` | `metadata.officialContentVersion`（streamEvents metadata，观测面） | 【删行】 |
| D28 | leader 图传参 | `server/src/runner/runtime/runService.ts:1778,1815` | `const official = capabilities.official` → `buildLeaderAgent({ official, … })` | 【删行】×2 |
| D29 | wiki-update teammate 图传参 | `server/src/runner/runtime/runService.ts:1886` | 第二条 `buildLeaderAgent` 调用（`official: p.capabilities.official`） | 【删行】 |

#### 前端消费面（D30–D31）

| # | 触点 | 位置 | 现状 | 处置 |
|---|---|---|---|---|
| D30 | **三源合并逻辑** | `frontend/src/chat/slashCommands.ts:2,13-31`（官方段 :16-22） | `mergeSlashCommands` = 系统常量(:6-10) + `OFFICIAL_COMMANDS` 静态 import + 启用插件命令三源合并，先 set 者赢 | 【删行】:2 与 :16-22 + :12 注释同步——变二源（系统 + 启用插件） |
| D31 | SYSTEM_COMMANDS re-export | `frontend/src/chat/useChatSession.ts:40` | re-export 前端**自有**常量（slashCommands.ts:6-10），与官方内容无关 | 【确认无耦合】 |

#### 测试锚（D32–D39）

| # | 触点 | 位置 | 现状 | 处置 |
|---|---|---|---|---|
| D32 | 工具夹具 | `server/test/runnerRunService.test.ts:206,225` | `read_official_skill` 仅作「会成功的工具调用」替身（gate 并发 + trace 断言） | 【改行】换夹具工具名 |
| D33 | teammate 夹具 | `server/test/teammateRuntime.test.ts:159` | 同上（worker 工具调用脚本） | 【改行】换名 |
| D34 | coreToolNames 夹具 | `server/test/figureRun.test.ts:143` | `['task', 'read_official_skill']` 占位核心名 | 【改行】换名 |
| D35 | coreToolNames 夹具 | `server/test/pluginWikiDocsPort.test.ts:121` | 同上 | 【改行】换名 |
| D36 | **官方内容 e2e** | `server/test/sessionsApi.test.ts:426-440` | `/research 电池寿命` → 展开到 runner + `read_official_skill` 渐进披露 + 幂等 replay | 【删/重写】e2e 删除，幂等 replay 覆盖用普通输入重写保留 |
| D37 | registry 测试 | `server/test/pluginsRegistry.test.ts:10-11,73,196-197` | imports + 「rejects commands colliding with reserved names (system incl. official)」+ coreToolNames/reservedCommandNames 镜像 | 【改行】reservedCommandNames 只剩 SYSTEM_COMMANDS；撞名用例保留系统侧 |
| D38 | 合并函数测试 | `server/test/pluginsCommands.test.ts:20,31-38` | official 源优先序/不遮蔽用例 | 【删/收缩】随 D20 塌缩 |
| D39 | 前端合并测试 | `frontend/src/chat/slashCommands.test.ts:1,8-12` | 期望清单含 `/research` + 官方 description/argumentHint 断言 + 「插件不遮蔽官方名称」用例 | 【改行】期望清单 → `['/new','/compact','/model','/figure']`；不遮蔽断言改测系统命令侧 |

### 2.3 构建上下文（D40–D50）

| # | 触点 | 位置 | 现状 | 处置 |
|---|---|---|---|---|
| D40 | cd.yml 头注 | `.github/workflows/cd.yml:11` | 「多 context 现仅 official/ + plugins/」 | 【改行】注释 |
| D41 | cd.yml 步骤注释 | `.github/workflows/cd.yml:118` | 「official（#787 官方内容目录）+ plugins…」 | 【改行】注释 |
| D42 | cd.yml build-contexts | `.github/workflows/cd.yml:121` | `official=${{ github.workspace }}/official` | 【删行】（⚠ 票面记的 `deploy/cd.yml` 路径有误，实际文件在此） |
| D43 | dev compose 注释 | `deploy/docker-compose.dev.yml:31` | 「构建多 context：official/plugins 兄弟目录」 | 【改行】注释 |
| D44 | dev compose additional_contexts | `deploy/docker-compose.dev.yml:34` | `official: ../official` | 【删行】（⚠ 票面清单外触点——漏改则 `docker compose -f deploy/docker-compose.dev.yml up --build` 直接报 context 不存在） |
| D45 | Dockerfile 布局注释 | `server/Dockerfile:12-13` | 「content:build 亦按 '../official' 兄弟解析…两个 named context」 | 【改行】注释（残留 official 字样会误导 hotfix 布局推理） |
| D46 | Dockerfile COPY | `server/Dockerfile:28` | `COPY --from=official / /official` | 【删行】 |
| D47 | Dockerfile 尾注 | `server/Dockerfile:66` | 「构建多 context 现仅 official/ + plugins/ 两个」 | 【改行】注释 |
| D48 | 部署文档 | `deploy/DEPLOY.md:46` | 「server 镜像构建多 context = official/（#787 官方内容）+ plugins/」 | 【改行】 |
| D49 | prod 部署测试锚 | `server/test/prodDeploy.test.ts:92-94` | 断言 cd.yml 含 `official=${{…}}/official` | 【改行】断言（建议改否定式防复活） |
| D50 | dev 部署测试锚 | `server/test/devDeploy.test.ts:93-94` | 断言 dev compose 含 `official: ../official` | 【改行】同上 |

### 2.4 SYSTEM_COMMANDS 确认（D51–D54）

| # | 触点 | 位置 | 现状 | 处置 |
|---|---|---|---|---|
| D51 | ⚠ 符号定义地 | `server/src/officialContent/catalog.ts:5-9` | `SYSTEM_COMMANDS = ['new','compact','model']` + `parseSlash`——语义上是系统命令设施，**代码上与官方内容同文件** | 【改逻辑】退役施工**第一步先搬家**（建议 sessions 域小 util 或 plugins/commandResolution 邻位）；消费方 = sessions/service.ts:1（parseSlash+SYSTEM_COMMANDS）与 runner/assembly.ts:36（SYSTEM_COMMANDS） |
| D52 | 保留名校验 | `server/src/officialContent/catalog.ts:20` | 官方命令禁占系统名（`SYSTEM_COMMANDS` 唯一反向耦合点） | 【删行】随目录消失自然消解 |
| D53 | 前端同名常量 | `frontend/src/chat/slashCommands.ts:6-10` | 前端独立定义的 `/new /compact /model`（含中文 description/argumentHint），与官方内容零依赖 | 【确认无耦合】不动 |
| D54 | 系统命令链路 | `server/src/sessions/service.ts:364-365`（executeSystemCommand 分派）+ `server/src/runner/assembly.ts:112`（reserved 侧） | /new 事务建会话、/compact 转内核 cmd.operation=compact、/model 落 preferredModelJson——全链不触官方内容快照 | 【确认无耦合】语义独立成立 |

### 2.5 GLOSSARY 连锁词条与现役文档（D55–D62）

| # | 词条/文档 | 位置 | 现状 | 处置 |
|---|---|---|---|---|
| D55 | 官方内容目录 | `GLOSSARY.md:300-303`（退役决定注 :301） | 注内已预告「施工随 #787 退役规格；落地后转决策历史」 | 【改逻辑】落地后照 :5 OpenClaw 总注先例保留为带注记历史词条 |
| D56 | 能力实现层与用户交互层 | `GLOSSARY.md:309-311` | 「官方静态目录…同形并存——用户视角一个命令模型，实现层**两源**」；Avoid「插件不取代官方内容目录」「技能是内容级扩展（目录注入），无代码，不是插件的特例」（:311） | 【改逻辑】**需连锁修订**：交互层失一源（仅剩插件贡献）；两条 Avoid 随退役失义（「插件收编」从禁忌变终态、「技能」概念退场） |
| D57 | 双面板 | `GLOSSARY.md:313-314` | admin 运营面枚举「用户管理与配额、审计检索、用量核算、**官方内容**与 API 文档」 | 【改行】删「官方内容与」枚举项 |
| D58 | figure 工具 | `GLOSSARY.md:280-281` | 「/figure 系统命令…宿主：由**官方插件目录**首个插件贡献」——「官方插件目录」是 :296 另一词条；/figure 实是 AutoFigure 插件命令（plugins/autofigure/manifest.ts:55-57） | 【确认无耦合】不需连锁修订（「系统命令」措辞与现实现有出入，属词条自身问题，非本票义务） |
| D59 | 官方插件目录 | `GLOSSARY.md:296-298` | 插件静态清单（#788），与官方**内容**目录是不同概念 | 【确认无耦合】 |
| D60 | category（主题分类） | `GLOSSARY.md:356-357` | 「拍板，**未施工**…顶层目录前缀分组（official/ 等）随之退役」 | 【确认无耦合】本票不动；落地后可随 category 施工把「未施工」状态更新（下游衔接项） |
| D61 | 模块地图 | `docs/agents/server-modules.md:16,:18,:22` | :22 = officialContent 整行；:16/:18 sessions 行含「官方命令展开只在命令构造点」措辞 | 【删行】+【改行】（sessions 行斜杠段叙述去官方面） |
| D62 | server 目录树 | `server/README.md:63` | `officialContent/ 官方内容目录…` 树行 | 【删行】 |

### 2.6 无关语义甄别（D63–D66）

| # | 触点 | 位置 | 甄别结论 |
|---|---|---|---|
| D63 | wiki 运行时 `official/` 分组 | 分组键 `server/src/wiki/dockerFs.ts:104`（buildTree :97-113，首段目录 `t.name.split('/')[0]`）；UI 渲染 `frontend/src/components/FileTree.vue:21-22`（目录名 = 分组标签唯一用户可见面）；SKIP 集 `server/src/wiki/values.ts:10-11`（**不含** official）；写面判定 `server/src/wiki/logic.ts:118-122` | 「自然消隐」成立：wiki 代码 official 字面量零命中（C1 §1.1），分组纯运行时数据；category 迁移（GLOSSARY.md:356-357，**未施工**）落地后目录分组机制整体退场 ⇒ `official/` 分组标签消隐、存量页落「未分类」**保留可读可检索**（检索不看目录、graph 走相对链接）；**无 SKIP 白名单残留**需要显式处理。本退役票对 wiki 域零改动 |
| D64 | toolRender「official」族 | `docs/research/555-official-tool-call-files.md` 被 `frontend/src/chat/toolRender/` 5 个文件注释引用（tool-call-diff/grouping/patch/view.test.ts、i18n.ts:4） | 「official」= tool-call 文件渲染研究（#555），与官方内容目录无关族，不动 |
| D65 | official-file-panel 族 | `docs/research/617-official-file-panel.md`（文件名含 official） | #617 文件面板研究，无关族；docs/research/ 归档不回改 |
| D66 | 其他已甄别族 | `frontend/src/wiki/reader.ts:3`（openwiki 出处声明注释，C1 已甄别）；GLOSSARY OpenClaw 「官方镜像/官方包」族（:44-48 等）；`LICENSE:118`（许可证文本 official Standard Interface）；ADR 0004:46/0013:45（openclaw-official-browser-image 文件名）；`docs/research/` 目录名、`plugins/research/` 插件名与 `/research` 命令同名异义——插件命令实为 ingest/discover/hypothesize/experiment（plugins/research/manifest.ts:58-63），无 'research' 命令 | 全部无关。附注：官方 `/research` 退役后 `'research'` 名从保留命令集释放，在库插件零占用，无需补占位 |

---

## 三、遗漏风险与边界

**1. grep 零命中记录（闭合证据）**

| 排查模式 | 结果 |
|---|---|
| `officialContent` / `official-content` / `read_official_skill` / `officialCommands` / `OFFICIAL_SOURCES` / `OFFICIAL_COMMANDS` / `SYSTEM_COMMANDS` / `parseSlash` / `officialSkillTools` / `snapshotOfficialContent` / `OfficialCatalog` / `createOfficialCatalog` / `content:build` / `mergeCommandDirectories` | 全部命中已落入 D1–D62，无清单外幸存者 |
| `ContentEntry` / `OfficialSources`（catalog 另两个导出） | 模块外零消费 |
| `official=` / `official:`（deploy/CI 传参形态） | 全部命中 = D42/D44/D46/D48/D49/D50 |
| `official/`（路径义） | 命中文件 = official/ 源目录自身 + 构建脚本/Dockerfile/cd.yml/compose/DEPLOY.md 构建上下文 + docs/research/ 归档（历史记录不回改）+ GLOSSARY/D63 wiki 叙述 |
| 全库文件级 `official`（大小写不敏感，排除 node_modules） | 51 个文件逐一甄别完毕（本节各表 + D64–D66）；`.github/workflows/ci.yml` 零命中 |
| 构建配置（vite/tsconfig/前端 package.json） | 零命中（D12/D13） |

**2. 盲区标注**

1. **node_modules 依赖面**：依赖未安装，无法机械验证第三方包是否反向引用这些符号——但官方内容目录为纯自研模块（零 npm 依赖，deepagents `tool()` 是通用 API），依赖反向引用风险≈0，语义甄别可兜。
2. **运行时用户 wiki 容器中的 `official/` 页**：与 C1 §四同源盲区——页数量/frontmatter 实况不可勘察；本票不动 wiki 域（D63），存量页命运由 category 迁移票承接（落「未分类」）。
3. **历史会话数据**：已展开的 `/research` 模板正文存在 session_messages.content 里——退役后照常显示（设计使然），无迁移面；但若产品语义要求「/research 历史消息也隐藏」则是新需求，超出 D1 范围。
4. **CD 上的存量镜像**：退役前构建的 server 镜像含 /official COPY 层——自然被后续构建替换，无显式清理义务。

**3. 同名异义已甄别（防 C4 误删）**：`officialContent`（本票对象）≠ `official plugin catalog`（D59，插件目录）≠ `555-official-tool-call-files`（D64，工具渲染研究）≠ `617-official-file-panel`（D65，文件面板）≠ `openclaw-official-*`（D66，镜像/ADR）≠ wiki 运行时目录（D63，运行时数据）≠ `plugins/research` 插件（D66，同名异义）。

---

## 四、对 C4 规格的建议摘录

1. **施工顺序（硬约束）**：先搬家 `SYSTEM_COMMANDS`/`parseSlash`（D51，建议落 sessions 域小 util）→ 删官方内容模块与产物 → 再收消费面。反序则 typecheck 在 sessions/service.ts:1 与 assembly.ts:36 两处断链。
2. **capabilities.key 语义变化**（D24）：`[official.version, enabledPluginIds] → [enabledPluginIds]`——key 唯一消费点 runService.ts:1782 图缓存键，无其他读方；规格建议保留 key 字段形态（插件目录版本仍在 plugins.catalogVersion 键位，勿混）。
3. **mergeCommandDirectories 塌缩决策**（D20/D38）：退役后只剩插件单源——建议保留函数壳收 plugin 源（测试锁不变形）还是内联 sessions，由 C4 拍板；无论哪种，pluginsCommands.test.ts 同步收敛。
4. **保留名释放**：reservedCommandNames 只剩 `['new','compact','model']`（D25/D37）；`'research'` 名释放、在库插件零占用，无需占位。
5. **部署测试锚改否定式**（D49/D50）：断言从「含 official=」翻转为「不含 official」——防复活比防漏删更有价值（漏删会在 deploy 测试现行断言下立即红）。
6. **观测面删除注明**（D27）：`metadata.officialContentVersion` 是 langfuse/callbacks 维度，删除影响观测查询——规格注明预期。
7. **docs 连锁修订随落地 PR**（D55–D62）：GLOSSARY 三词条（官方内容目录转历史 / 能力-交互层修订 / 双面板删枚举项）+ server-modules.md + server/README.md + DEPLOY.md——GLOSSARY.md:301 注内已自述「施工随 #787 退役规格」，建议同 PR 完成避免术语漂移。
8. **wiki 域显式划界**：本票对 dockerFs/values/logic/FileTree **零改动**（D63）——`official/` 分组消隐是 category 迁移票（未施工）的下游效果，C4 规格应写明「不随本票处理 wiki 侧」以防施工越界。

---

## 附：信源索引

| 主题 | 位置 |
|---|---|
| 官方内容模块全貌 | `server/src/officialContent/catalog.ts` `runtime.ts` `generated.ts`（基线 aa56215） |
| 构建脚本与钩子 | `server/scripts/build-official-content.mjs`；`server/package.json:10,20-22` |
| 源目录 | `official/commands/research.md`、`official/skills/research/SKILL.md`（find 全量 2 文件） |
| 服务端消费面 | `server/src/sessions/service.ts:1,6,361,364-365,391-396`；`server/src/plugins/commandResolution.ts:3-34`；`registry.ts:41-45`；`surface.ts:45`；`server/src/runner/capabilities.ts:2-12`；`assembly.ts:36-37,111-112`；`graphFactory.ts:1,55-105`；`runService.ts:1053,1778-1784,1815,1886` |
| 前端消费面 | `frontend/src/chat/slashCommands.ts:2,6-10,13-31`；`officialCommands.generated.ts`；`useChatSession.ts:40` |
| 构建上下文 | `.github/workflows/cd.yml:11,118,121`；`deploy/docker-compose.dev.yml:31,34`；`server/Dockerfile:12-13,28,66`；`deploy/DEPLOY.md:46` |
| 测试锚 | `server/test/officialContent.test.ts`；`sessionsApi.test.ts:426-440`；`pluginsRegistry.test.ts:10-11,73,196-197`；`pluginsCommands.test.ts:20,31-38`；`runnerRunService.test.ts:206,225`；`teammateRuntime.test.ts:159`；`figureRun.test.ts:143`；`pluginWikiDocsPort.test.ts:121`；`prodDeploy.test.ts:92-94`；`devDeploy.test.ts:93-94`；`frontend/src/chat/slashCommands.test.ts:1,8-12` |
| GLOSSARY 连锁 | `GLOSSARY.md:280-281`（figure 工具）、`:296-298`（官方插件目录）、`:300-303`（官方内容目录+退役决定注）、`:309-311`（能力-交互层）、`:313-314`（双面板）、`:356-357`（category，未施工） |
| wiki 自然消隐佐证 | `server/src/wiki/dockerFs.ts:97-113`（:104 分组键、:151 顶层散落排除）；`frontend/src/components/FileTree.vue:21-22`；`server/src/wiki/values.ts:10-11`（SKIP 无 official）；`server/src/wiki/logic.ts:118-122` |
| 决策语境 | GitHub issues #939（本票）/#926（map）/#936（C2 D1 拍板，GLOSSARY.md:301 转录）；C1 甄别 `research/c1-wiki-category:docs/research/935-official-dir-category-migration.md` §1.2/§四 |
