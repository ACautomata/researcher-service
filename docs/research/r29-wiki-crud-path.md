# R29 — Wiki CRUD 路径：后端如何对每个 OpenClaw 容器的 `wiki/main` 做增删改查

> 对应 **issue #29**。在 r7（`docs/research/r7-wiki-read-mechanism.md`，读取机制）基础上，回答「写入/编辑后 wiki 搜索与图谱何时一致」「graph 数据如何提取」，并给出最终 CRUD 路径推荐。
>
> 信源分级：本仓库实测代码（`routes/openclaw.py`、`config.py`、`deploy/docker-compose.yml`、`public/js/pages/wiki.js`）＋ researcher 浅克隆 `/tmp/researcher-probe`（真实 wiki 骨架）＋ OpenClaw 官方文档（memory-wiki 插件页、Wiki CLI 页）。区分【事实】（可查证）与【决策】（设计权衡）。

---

## 0. 前置澄清：后端栈与本仓库的真实部署形态

**【事实】本仓库后端是 FastAPI，不是 Django。** team-lead 任务书里写「Django 后端」，但本仓库（`ai-research-pipeline`）后端是 FastAPI（`main.py` + `routes/openclaw.py`）。无 Django 代码。下文按 FastAPI 现状论述；若另有一个规划中的 Django 服务要接同一批容器，`§1` 的「直读文件系统 vs 经网关」权衡结论不变（与语言无关），仅需把具体路由实现换成 Django view。

**【事实】本仓库的挂载形态与 r7 笔记引用的 bench compose 不同，且更直接。**

`deploy/docker-compose.yml:57`：

```yaml
volumes:
  - ${RESEARCHER_DIR:-../researcher}:/home/node/.openclaw   # researcher 仓库根 → 容器 OpenClaw home
  - ./openclaw.json:/home/node/.openclaw/openclaw.json
```

即把 **researcher 仓库根**（含 `wiki/`、`workspace/`、`skills/`）整体 bind-mount 进容器的 `/home/node/.openclaw`。后端进程跑在**宿主**上，配置默认：

`config.py:51`：

```python
RESEARCHER_WIKI_ROOT = os.getenv("RESEARCHER_WIKI_ROOT", "./researcher/wiki/main")
```

也就是后端直读**宿主上同级 `./researcher` 浅克隆下的 `wiki/main`**——与 team-lead 提供的 `/tmp/researcher-probe` 是同一种东西（researcher 仓库 clone）。bind-mount 语义下，宿主 `./researcher/wiki/main` 与容器内 `/home/node/.openclaw/wiki/main` 是**同一个目录**：容器内 memory-wiki 插件写入立即反映到宿主，后端直读立即可见，反之亦然。

**多容器注意**：题面说「每个 OpenClaw 容器」。当前 compose 是**单容器单 main-agent**（r7 §4.1：researcher 已收敛为单 main，无 `workspace-autoresearch`）。若未来一域一容器，则每个容器对应宿主一份独立 `RESEARCHER_DIR` 克隆，`RESEARCHER_WIKI_ROOT` 需按容器/域参数化（见 `§1.3`）。这是【决策】待办，非现状。

---

## 1. 问题 1：读取路径 —— 直读宿主 bind-mount 文件系统，还是经容器内 gateway 接口？

### 1.1 结论

**【决策/推荐】直读宿主 bind-mount 的 `wiki/main` 文件系统，不经容器内 gateway / memory-wiki 插件 API。** 这正是现有 `routes/openclaw.py` 的做法，予以保留。

### 1.2 两条路径的利弊

| 维度 | 直读文件系统（推荐） | 经 gateway / 插件 API（`wiki_get`/`wiki_search`） |
|---|---|---|
| 依赖 | 只需文件系统挂载，**gateway 停了也能读** | 需 gateway 在线 + `memory-wiki` 插件已加载 |
| 信息损失 | 无——vault 就是「纯 markdown + YAML frontmatter」（官方文档原文），`wiki_get` 也只是解析到这些 `.md` | 无正文损失，但拿到的是插件加工后的视图 |
| 索引新鲜度 | 读到的是**磁盘当前态**，永远最新 | 读到的是**编译快照**（见 `§2`，可能滞后于磁盘） |
| 写回语义 | 整页覆盖写 = 「人类编辑」，被 `render.preserveHumanBlocks=true` 保留 | `wiki_apply` 只支持 narrow 修改（synthesis/metadata），**不支持 freeform 整页编辑** |
| 耦合/移植 | 与语言/框架无关（FastAPI/Django/任何后端都行） | 强耦合 OpenClaw 网关协议 |

**【事实】** 官方 Wiki CLI 页明确 `wiki_apply` 的能力边界："Apply narrow mutations without freeform page surgery"，仅 `apply synthesis`（managed summary body）与 `apply metadata` 两类。也就是说**插件 API 根本无法完成后端需要的「整页编辑」**——后端编辑页只能直写文件。这是排除「经 gateway 写入」的决定性事实。

**【事实】** 官方 memory-wiki 插件页："Prompt preparation does not poll the vault or install file watchers." —— 插件自己不监听文件系统，所以后端直写不会被插件立刻感知（这正是 `§2` 的核心）。

### 1.3 多容器下的读取（设计决策）

- 单容器现状：`RESEARCHER_WIKI_ROOT` 一个 env 指向 `./researcher/wiki/main`，足够。
- 多容器/多域【决策】：按 `container_id → RESEARCHER_DIR` 建映射表（配置或 DB），后端读取时按目标容器解析对应 `wiki/main` 绝对路径。**不要**为每个容器起一个 gateway 客户端去拉 wiki——直读在各容器独立的 bind-mount 源上同样成立，代价只是多维护一份路径映射。

---

## 2. 问题 2：写入/编辑何时生效 —— memory-wiki 不监听文件变化，需触发重索引

这是本任务最关键的「事实缺口」补齐。r7 因浅克隆 0 页面无法实测，本节以官方文档为准。

### 2.1 核心事实：无文件监听，直写后索引不自动更新

**【事实】** 官方 memory-wiki 插件页原文（compile pipeline 一节）：

> "Prompt preparation does not poll the vault or install file watchers."
> "Source edits and vault restores become machine-facing only after the next compile."

**含义**：memory-wiki **不监听 vault 文件系统**。后端绕过 `wiki_apply` 直接编辑/新建/删除 `.md` 文件后：

- **磁盘上的 markdown（人类视图）**：立即更新。后端 `GET /wiki`/`GET /wiki/{kind}/{name}/{page_id}` 直读文件系统，**立刻看到最新内容**。前端浏览页（`wiki.js` 源码/预览 tab）**保存即所见**，无需等待。
- **插件的搜索索引 / compiled digest / 机器读 claims（机器视图）**：**不更新**，直到下次 compile。这期间 `wiki_search`、agent prompt 注入的 digest、`.openclaw-wiki/cache/agent-digest.json`、`claims.jsonl` 都是**旧快照**。

**【事实】** compile 的产物去向：官方 Wiki CLI 页 `wiki compile`："Rebuild indexes, related blocks, dashboards, and the compiled query/prompt snapshot. The snapshot is persisted in OpenClaw's shared SQLite plugin state ... it does not create cache files in the vault." 即编译快照存 **SQLite 插件状态**，不落 vault；`agent-digest.json`/`claims.jsonl` 属另一类机器读 cache（见 r7 §2.2，AGENTS.md:7 指向它们做机器读）。

### 2.2 重索引的三种触发方式

**【事实】** 重索引只在以下时机发生：

| 触发 | 机制 | 何时一致 |
|---|---|---|
| `openclaw wiki compile`（CLI） | 全量重建索引/related blocks/dashboards/compiled snapshot | 命令返回后即一致 |
| `wiki_apply`（工具/CLI） | narrow 修改后顺带刷新 | 受 `ingest.autoCompile` 门控 |
| `ingest` skill 入库 | `ingest/SKILL.md` 明确「产出通过 `wiki_apply` 写入」并「更新索引」 | 受 `ingest.autoCompile=true`（本仓库 `deploy/openclaw.json:167-170` 已开）门控 |

**【事实】** `ingest.autoCompile` 是门控开关（官方 Wiki CLI 页："Index refresh after import is gated by `ingest.autoCompile`."）。本仓库 `deploy/openclaw.json` 已设 `ingest.autoCompile=true`、`render.createBacklinks=true`、`render.createDashboards=true`。

### 2.3 后端 CRUD 各操作的一致性时间表（决策建议）

**【决策】** 后端对磁盘直写后，按操作类型决定是否需要主动触发 compile：

| 后端操作 | 落盘行为 | 人类视图（浏览页） | 机器视图（wiki_search/digest） | 建议 |
|---|---|---|---|---|
| **读**（list/get） | 无写 | 实时 | 读旧快照（不影响展示） | 不需触发 |
| **编辑**（PUT 整页覆盖） | 覆盖已存在 `.md` | **立即一致** | 滞后到下次 compile | 浏览类编辑可**不**触发（低频人工，下一次 ingest/compile 自然带上）；若要求 agent 立即检索到，则触发 compile |
| **新建**（新 `.md`） | 新增文件 | 立即出现在 list（后端直扫目录） | **不会进搜索索引**直到 compile | 需触发 compile 才能被 agent 检索到 |
| **删除**（删 `.md`） | 删文件 | 立即从 list 消失 | **索引残留**直到 compile（search 可能返回死链） | 需触发 compile 清理索引 |

**关键区分**（【事实】支撑）：本仓库 Wiki 页是**给人浏览/编辑**的（r7 §2.2：markdown 是人类视图，digest 是机器视图），所以**编辑后浏览页立即一致**，唯一滞后的是「agent 经 `wiki_search` 检索」这条链路。是否触发 compile 取决于「这次编辑是否需要立刻被 agent 检索到」。

### 2.4 触发 compile 的具体做法（决策）

**【决策】** 后端写完文件后，**异步**触发一次 `openclaw wiki compile`，而非阻塞等待：

- **触发通道**：经容器 exec（`docker compose exec <svc> openclaw wiki compile`）或宿主持有的 OpenClaw CLI（若 CLI 在宿主可用）。注意 **compile 要作用于容器内运行的插件进程**——官方文档提示「a compile in the running process clears the owner immediately; a separate compiler process requires plugin lifecycle refresh」，即独立 CLI 进程编译后需插件生命周期刷新才被运行中的 daemon 采用。**需实测**确认在本部署形态下外部 `wiki compile` 是否即时生效（见 `§5` 实测项 T2）。
- **去抖**：编辑是低频人工操作，但连续保存多次时不应每次全量 compile。建议仿照 `memory.qmd.update` 的去抖思路（`openclaw.json:206` `debounceMs: 15000`），对 compile 触发做**数秒级去抖/合并**（如编辑后 5–15s 内只触发一次）。这是【决策】，非插件内建行为。
- **并发安全**：r7 §3.3 已述——后端整页写回落在 `render.preserveHumanBlocks=true` 的「人类编辑」语义内，插件重生成时不覆盖；若担心与插件并发写撞 `.openclaw-wiki/locks/`，可标注「编辑前最好暂停 ingest」。维持该结论。

---

## 3. 问题 3：graph 数据提取 —— 文件树遍历 + wikilink 解析

### 3.1 现状（已落地）

**【事实】** 前端 `wiki.js` 已实现 obsidian 风格 graph：

- **节点**：`wikiAllPapers`（`wiki.js:245`），来自 `GET /wiki` 返回的 `groups[].pages[]`，每页一个节点（`{id: kind/pageId, label: title, kind, name, pageId}`）。
- **边**：解析**当前页 body** 的 `[[wikilinks]]`（`wiki.js:254-274`，正则 `/\[\[([^\]]+)\]\]/g`），按 `title` 或 `id` 匹配到已加载页面则连实边，匹配不到则生成 `ghost` 虚节点。
- **渲染**：D3 force layout（`wiki.js:281-312`）。

### 3.2 节点提取（文件树遍历）——后端职责

**【事实】** 节点集 = vault 内全部 `.md` 页面，由后端 `GET /wiki` 遍历产生（`openclaw.py:464-504`）：

- 五核心目录 `concepts/entities/sources/syntheses/reports`（各扫一层，跳过 `index.md`）。
- `domains/<domain>/papers/*.md`（两层子树，`id` 带 `<domain>/` 前缀）。
- **统一跳过**：`.openclaw-wiki/`、`_attachments/`、`_views/`、各目录 `index.md`、顶层 `AGENTS.md/WIKI.md/inbox.md`（`_WIKI_SKIP_DIRS`/`_WIKI_SKIP_FILES`，`openclaw.py:398-403`）。
- 节点 `title` 取自 frontmatter（`paper.title` 优先，兼容插件 `title`，`openclaw.py:436-443`）。

**【事实·局限】** 官方 PR #82534 与 issue #90869 揭示：memory-wiki 的 `wiki_search`/`wiki_get` 目前**会漏掉查询目录下嵌套子目录的页面**（"wiki_search silently drops pages in subfolders"），且 pageGroups 可配置化（自定义目录名、递归多级扫描）仍在 review。对本仓库的含义：后端**自己**做文件树遍历（`os.listdir` 递归）反而比依赖插件的 `wiki_search` 更可靠——当前后端正是直扫文件系统，不受插件递归缺陷影响。这是「直读文件系统」的又一佐证。

### 3.3 边提取（wikilink 解析）——两种放置位置

**【决策】** 边的 `[[...]]` 解析有两个可选位置：

| 方案 | 位置 | 优点 | 缺点 |
|---|---|---|---|
| **A. 前端解析（现状）** | `wiki.js:254` 仅解析**当前打开页**的 body | 零后端改动；与 render 同处 | 只画「当前页的出边」，非全库图谱；节点全集虽在，但无边就退化成当前页 ego-graph |
| **B. 后端预解析全库** | 后端扫所有 `.md` body，提取 `[[x]]` 建全局邻接表，`GET /wiki/graph` 返回 `{nodes, edges}` | 一次渲染**全库图谱**（obsidian 全局 graph 形态）；可结合 frontmatter `related_pages`/`source_pages` 作补充边 | 后端多一个端点 + 一次全量正则扫描（页面多时需缓存/增量） |

**推荐**：保留 A 作为「单页 ego-graph」；如需 obsidian 式全局图谱再加 B。两者解析语法一致（obsidian renderMode 的 wikilink 与 `wiki.js` 正则天然契合，r7 §5.5 已确认可保留）。

**【决策】** 若做 B，边的两个来源都要解析：

1. **正文 `[[wikilinks]]`**：obsidian renderMode 页面内的双链。注意 obsidian wikilink 目标可以是**路径**（`[[资料/技术/AI/foo.md]]`，见 PR #82534 样例）或 **id/title**，后端匹配需兼容（先按路径末段去 `.md`，再按 title/id 兜底）。
2. **frontmatter 交叉链接字段**：researcher schema 的 `related_pages`（非证据性交叉链接）与 `source_pages`（支撑来源，见 r7 §1.2 schema B）。这些是 YAML 列表，需 `yaml.safe_load`（见 `§4.3`）。`related_pages` → 无向关联边；`source_pages` → 指向 sources 的证据边。

### 3.4 frontmatter 提取（graph 节点属性 + 标题）

**【事实】** 现有 `_parse_frontmatter`（`openclaw.py:406-433`）是手写 `key: value` 拆分，能处理**点号平铺标量**（`paper.title`、`evidence_level`）与**行内列表**（`[a, b]`），但**不能**处理 YAML 块式列表（`key:\n  - a`）或嵌套（`claims`/`paper.*` 的嵌套映射若用缩进写法）。

**【决策】** 若 graph/搜索只需 `title` 与标量标签（现状），保持手写解析即可；若要提取 `related_pages`/`source_pages`/`tags`（块式列表）或 `claims`（嵌套）作边或节点属性，**引入 `yaml.safe_load`**。判定标准：用到列表/嵌套字段就上 pyyaml，否则维持零依赖现状（与 r7 §5.3 一致）。

---

## 4. 最终 CRUD 路径推荐（汇总）

### 4.1 一句话

**后端（FastAPI）经宿主 bind-mount 直读/直写各容器的 `wiki/main` 文件系统完成全部 CRUD——读与整页编辑即时生效（人类视图），新建/删除后异步去抖触发一次 `openclaw wiki compile` 以同步机器视图（搜索索引/digest）；graph 由后端遍历文件树出节点、解析 `[[wikilinks]]`（+可选 `related_pages`/`source_pages`）出边。**

### 4.2 分操作

| 操作 | 路径 | 生效时机 |
|---|---|---|
| **List / Get** | 后端 `os.listdir`+`open()` 直读 `RESEARCHER_WIKI_ROOT`，跳过插件私有目录 | 实时 |
| **Update**（整页覆盖） | `open(fpath,"w")` 覆盖已存在 `.md`；禁写 `index.md` 生成块；依赖 `preserveHumanBlocks` | 浏览即时；agent 检索待下次 compile（可不主动触发） |
| **Create** | 直写新 `.md` 到对应分组目录（沿用插件目录约定，勿自造命名） | 浏览即时；**需 compile** 才进搜索索引 |
| **Delete** | `os.remove` 目标 `.md` | 浏览即时；**需 compile** 清索引残留 |
| **Graph** | 后端遍历出节点；边前端解析当前页（现状）或后端预解析全库（可选增强） | 依赖 List/Get 数据 |

### 4.3 与本仓库现状的差距（落地待办）

**【事实】** 读取侧 `routes/openclaw.py` 已完整实现 `§4.1` 的 List/Get/Update 与 graph 节点提取，前端 `wiki.js` 已实现 ego-graph。**尚缺**：

1. **Create / Delete 路由**：现仅 `wiki_save`（覆盖已存在页，`openclaw.py:553-571`），无新建/删除端点。需新增 `POST /wiki/{kind}/{name}` 与 `DELETE /wiki/{kind}/{name}/{page_id}`，并复用 `_resolve_page_path` 的防目录穿越。
2. **compile 触发器**：写操作后异步去抖调用 `wiki compile` 的机制（`§2.4`）。
3. **（可选）全局 graph 端点** `GET /wiki/graph`（`§3.3` 方案 B）。
4. **（可选）`yaml.safe_load`**：仅当要读列表/嵌套字段时引入（`§3.4`）。
5. **多容器路径参数化**（`§1.3`）：当前单容器，留作扩展点。

---

## 5. 需实测项（一手资料未覆盖）

| # | 待验证 | 原因 |
|---|---|---|
| **T1** | 后端直写 `.md` 后，运行中的 gateway 的 `wiki_search` 是否立即可见？（预期：不可见，需 compile） | 官方文档说「无 watcher」，但宜在本部署形态实测确认 |
| **T2** | 外部 `openclaw wiki compile`（独立进程）触发后，运行中 daemon 是否即时采用新快照，还是需「plugin lifecycle refresh」？官方原文暗示后者 | 决定 `§2.4` 触发器用「容器内 exec」还是需额外刷新步骤 |
| **T3** | `render.createBacklinks/createDashboards` 在后端直写后，是否仅由 compile 重建？直写的整页是否被 backlink/dashboard 生成正确纳入 | 官方未明说外部写入页是否被 compile 正常索引（PR #82534/issue #90869 提示嵌套目录有遗漏风险） |
| **T4** | researcher 实际 ingest 落盘后 `domains/<domain>/papers/` 的真实目录深度与 `related_pages`/`source_pages` 字段写法（块式 or 行内列表） | 浅克隆 0 页面，无法实测；决定 `§3.4` 是否需 `yaml.safe_load` |
| **T5** | 多容器并行时，后端对多个 bind-mount 源直读是否有文件锁/一致性边界 | 当前单容器，属扩展前验证 |

---

## 关键文件与信源索引

| 主题 | 位置 |
|---|---|
| 后端 wiki 路由（List/Get/Update、分组、防穿越） | `routes/openclaw.py:385-571`（`_WIKI_GROUP_DIRS:391`、`_WIKI_SKIP_*:398-403`、`wiki_list:464`、`_resolve_page_path:507`、`wiki_paper:525`、`wiki_save:553`） |
| Wiki 根配置 | `config.py:50-51,86`（`RESEARCHER_WIKI_ROOT`，默认 `./researcher/wiki/main`） |
| 挂载形态（researcher 根 → 容器 home） | `deploy/docker-compose.yml:53-62`（`${RESEARCHER_DIR:-../researcher}:/home/node/.openclaw`） |
| memory-wiki 配置（autoCompile/backlinks/dashboards） | `deploy/openclaw.json:145-185`（`ingest.autoCompile:167`、`render.*:179-183`） |
| 前端 graph / wikilink / frontmatter 标签 | `public/js/pages/wiki.js:44-46,245-313,140-149` |
| 读取机制（本任务前身） | `docs/research/r7-wiki-read-mechanism.md` |
| 无文件监听 / 直写需 compile | OpenClaw memory-wiki 插件页（"does not poll the vault or install file watchers"、"machine-facing only after the next compile"） |
| `wiki compile` 产物 / `wiki_apply` 能力边界 / autoCompile 门控 | OpenClaw Wiki CLI 页 |
| 嵌套子目录搜索遗漏 / pageGroups 可配置 | GitHub openclaw/openclaw PR #82534、issue #90869 |
| researcher ingest 用 `wiki_apply` 写页并更新索引 | `/tmp/researcher-probe/workspace/skills/ingest/SKILL.md`（「产出通过 wiki_apply 写入 wiki」「更新 wiki 索引和日志」） |
