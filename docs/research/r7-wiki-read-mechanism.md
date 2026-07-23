# R7 — Researcher Wiki 读取机制

> wayfinder ticket #7。目的：搞清 `ACautomata/researcher` 的 wiki（`wiki/main/`，memory-wiki 插件管理，obsidian 渲染模式，容器内 `~/.openclaw/wiki/main`）如何被**本仓库 FastAPI 后端**读取，为「改造保留的 Wiki 知识库页以读 researcher」提供事实依据。
>
> 信源：本地浅克隆 `/tmp/researcher-probe/`（最高信源）+ OpenClaw 官方文档。本仓库基线代码：`routes/openclaw.py`（`_WIKI_ROOT` + 三个 wiki 路由）、`public/js/pages/wiki.js`。

---

## 问题 1：`wiki/main/` 磁盘布局与单篇 frontmatter

### 1.1 顶层布局（实测浅克隆 `/tmp/researcher-probe/wiki/main/`）

```
wiki/main/
  AGENTS.md            # agent 维护守则（generated blocks 归插件所有，机器读 claims.jsonl/agent-digest）
  WIKI.md              # vault 元说明：vault mode=isolated, render mode=obsidian, search corpus=wiki
  index.md             # 总索引，含 openclaw:wiki:index 生成块（见问题 4）
  inbox.md             # 「丢原始想法/问题/源链接」的入口
  concepts/  index.md  # 抽象知识：ideas/patterns/policies
  entities/  index.md  # 持久具体对象：people/systems/projects/tools
  sources/   index.md  # 导入的原始材料 / bridge 导入页
  syntheses/ index.md  # 编译后的综述、汇总、维护中的 rollup
  reports/   index.md  # 自动生成的 dashboard（freshness/contradiction/stale-claim 报告）
  _attachments/        # 附件（空，仅 .gitkeep）
  _views/              # 视图（空，仅 .gitkeep）
  .openclaw-wiki/      # 插件内部状态（见问题 2）
```

依据：`ls /tmp/researcher-probe/wiki/main/`；各目录职责对照官方文档 [Memory Wiki · OpenClaw](https://docs.openclaw.ai/plugins/memory-wiki)（entities=durable things、concepts=ideas/abstractions、syntheses=compiled summaries/rollups、sources=imported raw material、reports=generated dashboards）。

**注意**：浅克隆是 `Total pages: 0` 的全新骨架（见 `index.md:6`），五个分类目录各只有一个 `index.md` 占位（内容形如 `- No concepts yet.`），没有任何真实页面实例。frontmatter 字段结构因此来自两类权威文字描述，而非真实样本。

### 1.2 单篇页面 frontmatter —— 两套 schema 并存（关键）

researcher 的 wiki 同时受**两层 schema** 约束，后端解析时都要兼容：

**(A) OpenClaw memory-wiki 插件官方 schema**（`wiki_apply`/`wiki get` 机器读所用）：

```yaml
pageType: entity | concept | synthesis | source | report
id: concept.example-topic
title: "Example Topic"
status: active            # active / review / stale / deprecated ...
updatedAt: "2026-04-14T10:00:00.000Z"
sourceType: swarm-curate  # / okf-import / bridge / manual ...
claims:                   # 结构化 claim 数组，使 wiki 成为「信念层」
  - id: claim.example.001
    text: "..."
    status: supported     # supported / contested / refuted / uncertain
    confidence: 0.92
    evidence:
      - { sourceId, path, lines, weight, note, updatedAt }
    updatedAt: "..."
```

依据：官方文档 entity 页示例与 claims/evidence 字段表（[memory-wiki 插件页](https://docs.openclaw.ai/plugins/memory-wiki)、[Wiki CLI](https://docs.openclaw.ai/id/cli/wiki)）。entity 页另有 `entityType/canonicalId/aliases/privacyTier/relationships/personCard/lastRefreshedAt` 等专属字段。

**(B) researcher 自定义论文页 schema**（`workspace/skills/ingest/references/page-templates.md`，`ingest` skill 入库时按此填）：

通用字段（每条持久页）：
```yaml
title: ...
type: paper | method | dataset | task | metric | concept | entity | topic | comparison | analysis | reading-note
domain: ...               # 必填，所属领域
status: seed | active | stable | superseded
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [...]
source_pages: [...]       # 支撑本页的论文页路径
raw_sources: [...]        # 原始文件路径（论文页必填）
related_pages: [...]      # 非证据性交叉链接
```

论文页额外字段（`page-templates.md`「论文页 Frontmatter」一节）：
```yaml
paper.title / paper.authors / paper.year / paper.venue
paper.arxiv / paper.doi / paper.code / paper.project
classification.label / classification.task / classification.method_family
classification.modality / classification.datasets / classification.metrics
evidence_level: abstract-only | skimmed | full-paper | reproduced
```

依据：`/tmp/researcher-probe/wiki/main/../../../../workspace/skills/ingest/references/page-templates.md`（通用字段列表、论文页字段列表、Evidence Level 含义）。`ingest/SKILL.md:60` 明确「填写全部通用 frontmatter 与论文专属 frontmatter（`paper.*`、`classification.*`、`evidence_level`）」。

> 与本仓库旧 `_WIKI_ROOT` 的衔接点：researcher 的论文页 frontmatter（`paper.title`、`paper.year`、`paper.venue`、`paper.arxiv`、`paper.doi`、`evidence_level`）与现有 `wiki.js:140-149` 渲染所读的字段**完全同名**。前端「标题 + 标签条 + DOI/arXiv 链接」的渲染逻辑几乎可以原样复用。

### 1.3 论文页落在哪个目录 —— domains 子树 vs 五核心目录

researcher 的 ingest 规范把论文页组织在 **domain 子树** 下，且使用 `papers/` 与 `sources/` 两类目录：

- `ingest/SKILL.md:52` 输入 `target_domain`：「论文所属领域子树」。
- `wiki-conventions.md:9`：「Domain 文件夹使用小写 kebab-case」。
- `wiki-conventions.md:81`（维护启发式）：「迁移期间保留旧的 `sources/` 链接，直到对应的 `papers/` 页面存在且入站链接已更新」。
- `wiki-conventions.md`：「页面放错位置时，优先在 **domains 子树**内用 wiki 工具移动而非复制」。
- `ideate/scripts/validate_idea_cards.py:162-163`、`write_idea_markdown.py:66` 均把 `/papers/`、`/domains/` 当作 wiki 锚点路径的标志子串。

也就是说 researcher 实际产出倾向于 `wiki/main/domains/<domain>/papers/<slug>.md`（外加 `sources/` 放原始材料）。这与 memory-wiki 插件的五个核心目录（`concepts/entities/sources/syntheses/reports`）**并存**——核心目录是插件机器/综合层，domains 子树是 researcher 按领域组织的论文页层。浅克隆骨架因 0 pages 还没有 `domains/` 目录，故无法给出实测路径样例。

**对后端的意义**：列表维度不能只扫五个核心目录，也要扫 `domains/<domain>/papers/`。最稳妥是「按顶层目录分组 + 兼容 domains 两层子树」，详见末节。

---

## 问题 2：memory-wiki 写到哪个目录；`.openclaw-wiki/` 是否需关心

### 2.1 确切写入目录

researcher `openclaw.json` 的 `plugins.entries.memory-wiki.config`：

```json
"vaultMode": "isolated",
"vault": { "path": "~/.openclaw/wiki/main", "renderMode": "obsidian" }
```

依据：`/tmp/researcher-probe/openclaw.json:173-180`。`vaultMode=isolated`（自带 vault、不依赖 memory-core）、`renderMode=obsidian`（输出 Obsidian 兼容 markdown：wikilinks + frontmatter）。`obsidian.enabled=true`、`bridge.enabled=false`、`ingest.autoCompile=true`、`search.backend=shared, corpus=wiki`。

容器内展开 `~` → **`/home/node/.openclaw/wiki/main`**（`HOME=/home/node`，见问题 3）。这与浅克隆里的相对路径 `wiki/main/` 一一对应。

### 2.2 `.openclaw-wiki/` 不需后端关心

实测内容（`/tmp/researcher-probe/wiki/main/.openclaw-wiki/`）：

```
.openclaw-wiki/
  state.json        # {"version":1,"createdAt":"...","renderMode":"obsidian"}
  cache/            # 空（仅 .gitkeep）；真实部署含 agent-digest.json、claims.jsonl
  locks/            # 空（仅 .gitkeep）
```

依据：`cat .openclaw-wiki/state.json`、`find .openclaw-wiki`。

结论：**后端列出/读取页面时应整个跳过 `.openclaw-wiki/` 目录**，理由：
1. 它是插件私有状态（`state.json` 只有 version/createdAt/renderMode），不含页面正文。
2. `cache/` 下的 `agent-digest.json`、`claims.jsonl` 是**面向机器/agent 的编译产物**——`AGENTS.md:7` 明确「用 `agent-digest.json` 和 `claims.jsonl` 做机器读；markdown 页面才是人类视图」。本仓库 Wiki 页是给人浏览/编辑的，应读 markdown，不是 digest。
3. `locks/` 是插件并发锁，与只读浏览无关。
4. 官方文档亦说明 plugin state 另存于 SQLite，`.openclaw-wiki/` 内的具体文件不属公开契约。

（可选增值：日后若要「机器检索/claims 视图」，可单独读 `.openclaw-wiki/cache/claims.jsonl`，但不在本 ticket 范围。）

---

## 问题 3：后端能否直读文件系统（挂载共享）—— 能，且应直读

**结论：后端直接读文件系统即可，与现有 `_WIKI_ROOT` 的做法一致，无需经 memory-wiki 插件 API。**

### 3.1 挂载证据：宿主与容器共享同一目录

`docker/docker-compose.bench.yml:63-64`：

```yaml
volumes:
  - ${OPENCLAW_DATA_DIR}:/home/node/.openclaw
```

即宿主机的 `${OPENCLAW_DATA_DIR}` 整体 **bind-mount** 到容器 `/home/node/.openclaw`。bind mount 语义下两者是**同一个目录**：容器内对 `/home/node/.openclaw/wiki/main/...` 的写入，立即可见于宿主 `${OPENCLAW_DATA_DIR}/wiki/main/...`，反之亦然。

`OPENCLAW_DATA_DIR` 取值：CI 中由 `env_setup.sh:188,561` 设为 `${ENV_DIR}/openclaw-data`（`BENCH_DATA_DIR`）；生产/手工部署同理指向宿主某个真实目录。本仓库后端进程跑在宿主上，只要把 `_WIKI_ROOT` 指向该宿主的 `${OPENCLAW_DATA_DIR}/wiki/main`（即挂载源），就能直读。

### 3.2 路径里的 `~` = `/home/node`，不是 `/root`

- compose `user: ${OPENCLAW_RUN_USER:-0:0}`（默认 root，`env_setup.sh` 也设 `OPENCLAW_RUN_USER=0:0`），**但** `environment: HOME: /home/node`（`docker-compose.bench.yml:14,17`）。
- 容器内 `~` 由 `HOME` 决定，解析为 `/home/node`，故 wiki 实际路径是 **`/home/node/.openclaw/wiki/main`**，**不是** `/root/.openclaw/...`。
- `run_clawprobench.sh` 通篇用 `/home/node/.openclaw/openclaw.json`、`/home/node/.openclaw/results`（`:126,175,220,249`），进一步坐实 state 根是 `/home/node/.openclaw`。

> **这是现有 `_WIKI_ROOT = "/root/.openclaw/workspace-autoresearch/wiki"`（`routes/openclaw.py:535`）必须改的双重原因**：既因 researcher 不再有 `workspace-autoresearch`（见问题 4），也因容器 state 根是 `/home/node/.openclaw` 而非 `/root/.openclaw`。

### 3.3 为何不必走 memory-wiki 插件 API

1. **可读性**：官方文档确认 vault 就是「磁盘上的纯 markdown 文件 + YAML frontmatter」，`.md` 扩展名，`openclaw wiki get <id>` 也只是解析到这些页路径。直读无任何信息损失。
2. **先例**：现有 `routes/openclaw.py:538-592` 已用 `os.listdir` + `open(...)` 直读 `_WIKI_ROOT`，新机制只需换根目录与扫描维度，模式不变。
3. **解耦**：插件 API（`wiki_apply`/`wiki_search`/`wiki get`）需要 OpenClaw 网关在线且加载 memory-wiki（`OPENCLAW_PLUGINS_ENABLED=true` 才启用，见 `docker-compose.bench.yml:62` 与 `run_clawprobench.sh`）。后端浏览知识库不应依赖网关/插件存活；直读文件系统即使网关停了也能看。
4. **写回**：保存是简单覆盖写 `.md` 文件（现有 `PUT` 路由就是这么做的）。memory-wiki 的 `render.preserveHumanBlocks=true`（`openclaw.json:207-210`）保证插件重生成时不覆盖 managed 块之外的人类编辑——后端把整页写回，落在「人类编辑」语义内，安全。

唯一注意：若后端**写**文件时插件并发也在写，理论上需要 `.openclaw-wiki/locks/` 的锁协调。但 Wiki 页是低频人工编辑，且 `render.preserveHumanBlocks` 本就是为此设计，风险可接受；如需更强一致可在文档中标注「编辑前最好暂停 ingest」。

---

## 问题 4：是否还有 `workspace-autoresearch`；`openclaw:wiki:index` 标记块

### 4.1 没有 `workspace-autoresearch`

实测浅克隆只有一个 workspace：`/tmp/researcher-probe/workspace/`（`ls -d workspace*/` 只返回 `workspace/`），**无 `workspace-autoresearch`**。

原因（架构演进）：researcher 已收敛为**单 main agent**——`openclaw.json:73-80` 的 `agents.list` 只含一个 `main`（workspace=`~/.openclaw/workspace`），`agents.defaults.subagents.allowAgents=[]`（`:70`）。`CONTEXT.md` 与 `CLAUDE.md` 说明 judge 等子 agent 已退役删除，所有领域工作（ingest/extract/critic/validate/audit）由 main 自己用 skill 完成。

> 因此现有 `_AGENT_WORKSPACES` 里的 `autoresearch → workspace-autoresearch`（`routes/openclaw.py:79`）对 researcher 已无对应物；`_WIKI_ROOT` 指向的 `workspace-autoresearch/wiki` 在 researcher 上根本不存在。

### 4.2 `openclaw:wiki:index` 标记块是插件「生成区」分隔符

`wiki/main/index.md` 实测：

```markdown
# Wiki Index

## Generated
<!-- openclaw:wiki:index:start -->
- Render mode: `obsidian`
- Total pages: 0
- Claims: 0
- Sources: 0 / Entities: 0 / Concepts: 0 / Syntheses: 0 / Reports: 0
<!-- openclaw:wiki:index:end -->
```

依据：`cat wiki/main/index.md:4-13`。

含义：`<!-- openclaw:wiki:index:start -->` ... `:end -->` 是 memory-wiki 插件的 **managed block（受管生成块）标记**——插件每次 compile 会重写这对标记之间的内容（这里是 vault 统计），而标记之外的内容（以及 `<!-- openclaw:human:start/end -->` 之类，见 `WIKI.md:15-16`）保留不改。同理各分类 `index.md` 有 `<!-- openclaw:wiki:concepts:index:start -->` 等（`concepts/index.md:4-6`）。`AGENTS.md:3`：「Treat generated blocks as plugin-owned」。

**对后端的意义**：
- 读 `index.md` 时若只想展示统计，可直接取这对标记之间的文本；现有 `wiki_list` 已把 `index.md` 前 5000 字原样返回前端展示（`openclaw.py:584-592`），无需额外解析即可用。
- **写回时切勿破坏这些标记**，否则插件下次 compile 的增量更新会错位。最稳妥：后端编辑只针对 `domains/.../papers/*.md` 与五个核心目录下的页面（这些页面正文在 managed content 块内，但整页覆盖写回是「人类编辑」语义，插件接受），不要改 `index.md` 的生成块。

---

## 问题 5：最终结论

1. **写入目录**：memory-wiki 把 wiki 写到容器内 `~/.openclaw/wiki/main` = `/home/node/.openclaw/wiki/main`；经 bind mount（`${OPENCLAW_DATA_DIR}:/home/node/.openclaw`）与宿主共享同一目录，后端可**直读文件系统**列出/读取，无需插件 API。
2. **布局**：五核心目录（`concepts/entities/sources/syntheses/reports`，各含 `index.md`）+ researcher 按领域的 `domains/<domain>/papers/` 子树并存；顶层另有 `AGENTS.md/WIKI.md/index.md/inbox.md`、`_attachments/`、`_views/`、`.openclaw-wiki/`。
3. **frontmatter**：双 schema——插件官方 `pageType/id/title/status/updatedAt/sourceType/claims` + researcher `type/domain/status/created/updated/paper.*/classification.*/evidence_level`。论文页字段名与本仓库前端已渲染的字段同名。
4. **`.openclaw-wiki/`**（state.json/cache/locks）是插件私有状态与机器 digest，后端浏览**应跳过**。
5. **无 `workspace-autoresearch`**（单 main agent）；`openclaw:wiki:index` 块是插件 managed 生成区标记，读可用、写勿破坏。

---

## 对后端路由的直接影响（改造建议）

> 目标：让保留的 Wiki 知识库页（`routes/openclaw.py` + `public/js/pages/wiki.js`）改读 researcher 的 `wiki/main`。

### 5.1 `_WIKI_ROOT` 新值

```python
# routes/openclaw.py:535 —— 旧值（researcher 上不存在，且容器 state 根不是 /root）
_WIKI_ROOT = "/root/.openclaw/workspace-autoresearch/wiki"

# 建议新值：指向宿主挂载源下的 wiki/main。
# 推荐做成可配置（env），默认落到 researcher 的挂载点：
_WIKI_ROOT = os.environ.get(
    "RESEARCHER_WIKI_ROOT",
    "/home/node/.openclaw/wiki/main",   # 若后端跑在容器内同 state 根
    # 或宿主侧： "<OPENCLAW_DATA_DIR>/wiki/main"  —— 后端跑在宿主时用挂载源绝对路径
)
```

要点：必须指向 **bind-mount 的源头目录**（后端在宿主）或 **容器内 `/home/node/.openclaw/wiki/main`**（后端同容器）。二选一，取决于后端进程部署位置；务必不再用 `/root/.openclaw/...`，也不要再拼 `workspace-autoresearch`。

### 5.2 列表维度：`GET /wiki` 怎么扫

现有实现只认 `domains/<domain>/papers/*.md`（`openclaw.py:546-581`）。researcher 需扩展为「**多分组**」：

| 分组维度 | 扫描路径 | 说明 |
|---|---|---|
| 领域论文（主） | `_WIKI_ROOT/domains/<domain>/papers/*.md` | researcher ingest 主产物，frontmatter 含 `paper.*`、`evidence_level` |
| 概念 | `_WIKI_ROOT/concepts/*.md` | 跳过 `index.md` 占位 |
| 实体 | `_WIKI_ROOT/entities/*.md` | 跳过 `index.md` |
| 来源 | `_WIKI_ROOT/sources/*.md` | 原始材料页 |
| 综述 | `_WIKI_ROOT/syntheses/*.md` | 编译综述 |
| 报告 | `_WIKI_ROOT/reports/*.md` | dashboard |
| （可选）原始 inbox | `_WIKI_ROOT/inbox.md` | 单文件 |

建议返回结构从 `{domains:[{name,papers,paper_count}]}` 泛化为 `{groups:[{kind:"domain"|"concept"|..., name, pages:[{id,filename,title,path}]}], index, wiki_root}`，前端按 `kind` 渲染分组侧栏。**统一跳过**：`.openclaw-wiki/`、`_attachments/`、`_views/`、各目录的 `index.md`（占位/生成块），以及 `_WIKI_ROOT/index.md` 不当作普通页（单独作 `index` 字段返回，沿用现状）。

若 researcher 实际只用五核心目录而无 domains（取决于其 ingest 落盘习惯），则 domains 分组自然为空、核心目录分组有内容——按目录是否存在动态出分组即可，向后兼容。

### 5.3 frontmatter 解析：兼容双 schema

现有 `wiki_paper` 的简易 YAML 解析（`openclaw.py:608-631`）按 `key: value` 拆，已能处理 `paper.title`、`paper.year`、`evidence_level` 这类**点号平铺键**——researcher 论文页正是这种平铺风格，**直接兼容**。

需要补的两点：
1. **列表值**：researcher 的 `tags/source_pages/raw_sources/classification.task` 等是 YAML 列表。现有解析已处理 `[a, b]` 行内写法（`openclaw.py:625-626`），但 YAML 块式列表（`key:\n  - a\n  - b`）会被漏掉。如需展示这些字段，要么改用 `yaml.safe_load`（引入 pyyaml，最稳），要么扩展简易解析支持块式列表。鉴于 `models.py`/AI 调用都刻意避免重依赖、且现有代码手写解析，**建议：仅当确需列表字段时才引入 `yaml.safe_load`；否则保持现状，只展示标量字段**（title/year/venue/arxiv/doi/evidence_level 都是标量，够用）。
2. **`claims` 嵌套结构**（插件 schema A）：简易解析无法表达。本 ticket 的人读浏览页不需要 claims；如日后要展示，用 `yaml.safe_load`。

**单页读取路由** `GET /wiki/{domain}/{paper_id}` 的路径拼接要从 `domains/{domain}/papers/{paper_id}.md` 泛化为按分组映射：`{kind}` → 子目录（`domain`→`domains/{name}/papers/`，`concept`→`concepts/` …）。建议路由改为 `GET /wiki/{kind}/{name}/{page_id}`（`name` 对非 domain 类可为 `_`）或直接 `GET /wiki/page?path=<相对路径>`（需校验防目录穿越）。

### 5.4 写回路径：`PUT /wiki/...`

现有 `wiki_save` 覆盖写 `domains/{domain}/papers/{paper_id}.md`（`openclaw.py:646-658`）。改造后写回路径 = 同一分组映射下的 `.md` 文件绝对路径，约束：
- 只允许写已存在的 `.md` 文件（沿用现状的 404 语义），不新建——避免与 `wiki_apply` 的命名/索引约定冲突（researcher 的 index/log 由 skill 维护，后端不代写）。
- 不触碰 `index.md` 的 `openclaw:wiki:*:start/end` 生成块与各分类 `index.md`。
- 依赖 memory-wiki `render.preserveHumanBlocks=true`（`openclaw.json:208`）：整页覆盖写回被视作人类编辑，插件重生成时保留。

### 5.5 前端 `wiki.js` 的最小改动

- 数据结构从 `res.domains` 改为 `res.groups`；侧栏按 `kind` 分组（domain 文件夹图标 / concept / entity …），沿用现有 `toggleWikiDomain/openWikiPaper` 交互，仅把「domain」语义换成「kind+name」。
- 标题栏标签渲染（`wiki.js:140-149`）已读 `paper.title/paper.year/paper.venue/paper.doi/paper.arxiv/evidence_level`，researcher 论文页同名字段**零改动可用**；对 concept/entity 页这些字段缺省时优雅降级（现有 `if (fm[...])` 已判空）。
- `[[wikilinks]]` 图谱解析（`wiki.js:224-244`）与 obsidian renderMode 的 wikilink 语法天然契合，可保留。

---

### 关键文件与信源索引

| 主题 | 位置 |
|---|---|
| 现有后端 wiki 路由 | `routes/openclaw.py:533-658`（`_WIKI_ROOT:535`、`wiki_list:538`、`wiki_paper:595`、`wiki_save:646`） |
| 现有前端 wiki 页 | `public/js/pages/wiki.js`（分组渲染 `:42-99`、frontmatter 标签 `:140-149`） |
| memory-wiki 配置 | `/tmp/researcher-probe/openclaw.json:173-213`（`vault.path:177`、`renderMode:179`、`preserveHumanBlocks:208`） |
| 挂载共享 | `/tmp/researcher-probe/docker/docker-compose.bench.yml:63-64`（`${OPENCLAW_DATA_DIR}:/home/node/.openclaw`）；容器 user/HOME `:14,17` |
| 单 main agent / 无 autoresearch | `/tmp/researcher-probe/openclaw.json:70,73-80`；`ls /tmp/researcher-probe/workspace*/` |
| index 生成块 | `/tmp/researcher-probe/wiki/main/index.md:4-13`；`AGENTS.md:3` |
| `.openclaw-wiki` 内容 | `/tmp/researcher-probe/wiki/main/.openclaw-wiki/{state.json,cache,locks}`；`AGENTS.md:7` |
| 论文页 frontmatter | `/tmp/researcher-probe/workspace/skills/ingest/references/page-templates.md`；`ingest/SKILL.md:60` |
| domains/papers 子树 | `ingest/references/wiki-conventions.md:9,81`；`ideate/scripts/validate_idea_cards.py:162-163` |
| 官方 schema/布局/claims | [Memory Wiki · OpenClaw](https://docs.openclaw.ai/plugins/memory-wiki)、[Wiki CLI](https://docs.openclaw.ai/id/cli/wiki) |
