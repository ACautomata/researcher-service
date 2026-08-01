# WIKI 接口 Django→Express 迁移清单（接口不变）

> Wayfinder #315 产出 · 父 map #308。
> 范围：`backend/wiki/` 的 5 个 REST 端点**原样**迁移到 Express，**对外契约逐字节不变**。
> 现状源码：`backend/wiki/{views,urls,service,compile,serializers}.py` + `backend/integration/openclaw/{ports,adapters}.py`（`BindMountWikiFileSystem`）。
> 读者：执行 effort 的实现者。每条都给出「现状锚点 → Express 落点 → 须复刻的坑」。

---

## 0. 总览：5 端点 × 方法矩阵

所有端点挂在 `/api/v1/containers/<name>/wiki/` 下（`config/urls.py:34`），全局 `IsAuthenticated`（JWT Bearer，无 token → 401）。

| # | 方法 + 路径 | 用途 | 成功 | 失败语义（除 401） |
|---|-------------|------|------|--------------------|
| 1 | `GET tree` | 文件树（开放目录分组） | 200 `{groups[]}` | name 非法→400；容器不存在→404 |
| 2 | `GET page?path=` | 读一页 | 200 `{path,title,content}` | name→400/404；path 校验→400；页不存在→404 |
| 3 | `PUT page` | 覆写已存在页 | 200 `{path}` | path→400；页不存在→404（**不触发 compile**） |
| 4 | `POST page` | 新建页 | 201 `{path}` | path→400；已存在→409；父目录缺失→400（**触发 compile 去抖**） |
| 5 | `DELETE page?path=` | 删页 | 204 空 body | path→400；页不存在→404（**触发 compile 去抖**） |
| 6 | `GET graph` | 全库图谱 | 200 `{nodes[],edges[]}` | name→400/404 |
| 7 | `GET categories` | 按 `category:` 标记聚合 | 200 `{<cat>:[items]}` | name→400/404 |

（`page` 一个路径承载 4 方法，故 5 路由 = 7 行。）

**公共前置（每端点都做，对应 `_BaseWikiView._get_instance`）：**
1. `name` 经 `NAME_VALIDATOR` 校验（`^[a-z][a-z0-9-]{2,29}$`）→ 失败返 **400** `{"detail":"非法 name"}`（内部信号 `_InvalidName`，非 DRF 校验）。
2. 按 `name` 查容器行 → 不存在返 **404** `{"detail":"Not found."}`（Django `Http404` 默认形状）。

> ⚠️ **顺序陷阱**：name 格式非法是 400，name 合法但无此容器是 404——两个状态码不可混。

---

## 1. 认证与路由挂载（Express 落点）

| 现状（Django/DRF） | Express 落点 |
|---|---|
| 全局 `IsAuthenticated`，JWT Bearer（`base.py:98-107`） | 挂全局 JWT middleware（map #308 已锁定 `jose`），wiki 路由组**全部**在 middleware 之后，无 token → 401 |
| `path('api/v1/containers/<str:name>/wiki/', include('wiki.urls'))` | `router.use('/api/v1/containers/:name/wiki', wikiRouter)`；wikiRouter 内 `/tree` `/page` `/graph` `/categories` |
| 路径参数 `<str:name>` 贪婪匹配除 `/` 外字符 | Express `:name` 同款；**校验在 handler 内做**（不在路由层），保持「非法→400」而非 Express 默认 404 |

**坑**：Express 默认 `:name` 不匹配含 `.`/`%2F` 等的语义与 Django `<str:>` 略有差异——但因 name 校验只允许 `[a-z0-9-]`，任何「 exotic 字符」都会在 handler 校验阶段变 400，与现状一致。**不要在路由 pattern 里加正则约束**，否则非法 name 会变 404 而非 400，破坏契约。

---

## 2. 请求/响应契约逐项

### 2.1 `GET tree` → 200 `{groups:[{kind,name,pages:[{path,title}]}]}`

- **现状** `WikiTreeView.get`（views.py:68-78）→ `WikiService.build_tree` → `BindMountWikiFileSystem.build_tree`。
- **响应形状**（`WikiTreeSerializer`）：`groups` 数组，每组 `{kind, name, pages[]}`；`kind` 与 `name` **同为目录名**（物理平铺，issue #83）；`pages[]` 每项 `{path, title}`，`path` 是相对 `wiki/main` 的 posix 相对路径。
- **开放词表**：**不写死五分类**，照实平铺磁盘真实子目录；无页的目录不成组；**顶层散落 .md 不收**（区别于 categories）。排序：组按目录名字典序，组内页按 `path` 字典序（`_scan_dir` 末尾重排）。
- **降级（codex #125）**：wiki root 不存在 / root 或其直接父是 symlink / root 不可读 → **返回空树 `{"groups":[]}`，不报 500**。
- **title 来源**：frontmatter `paper.title`→`title`→文件名 stem（`_page_title` 只读前 2000 字符、**不回落 H1**——与 read_page/categories 的 title 语义**不同**，见 §3 坑）。

### 2.2 `GET page?path=` → 200 `{path,title,content}`

- **query 校验** `WikiPathSerializer` → `RelPathField`（见 §4 path 规则），失败 → **400**（DRF ValidationError，detail 为字段对象）。
- `read_page`：`FileNotFoundError`→`PageNotFound`→**404**；`ValueError`(越权)→`InvalidPath`→**400** `{"detail":"非法 path"}`。
- **响应**：`{path, title, content}`，`content` 为**原文全文**（含 frontmatter），`title` 取 `paper.title`→`title`→**H1**→stem（`_page_entry` with_content 语义）。

### 2.3 `PUT page` → 200 `{path}`

- **body 校验** `WikiPageWriteSerializer`：`{path, content}`；`content` `allow_blank=True, trim_whitespace=False`（**逐字保留首尾空白/尾换行**，编辑器逐字落盘）。
- `write_page`：页不存在→404；越权→400。**成功只回 `{path}`**（不回 content）。
- **不触发 compile**（r29 §2.3：编辑类低频人工不主动触发）。

### 2.4 `POST page` → 201 `{path}`

- body 同 PUT。`create_page`：`FileExistsError`→`PageExists`→**409** `{"detail":"页面已存在"}`；`NotADirectoryError`(父目录缺失)→`InvalidPath`→**400** `{"detail":"非法 path"}`；越权→400。
- **201**，成功回 `{path}`。**触发 `CompileFleet.trigger`（异步去抖，见 §5）**。

### 2.5 `DELETE page?path=` → 204 空 body

- query path 校验同 GET。`delete_page`：不存在→404；越权→400。
- **204 No Content，空 body**。**触发 compile 去抖**（清索引残留）。

### 2.6 `GET graph` → 200 `{nodes:[{id,title,ghost?}],edges:[{from,to}]}`

- `WikiService.build_graph`（service.py:193-229）。节点 = 遍历 tree 全部页 `{id:path, title}`；**幽灵节点** `{id:raw, title:raw, ghost:true}`（obsidian 语义：匹配不到的 wikilink 目标）。
- **边来源**：正文 `[[wikilink]]`（`[[target|别名]]` 取 `|` 前）+ frontmatter `related_pages`（可为字符串或列表，字符串归一为单元素列表）。
- **wikilink 解析顺序**（`_WikilinkResolver`，r29 §3.3）：① 目标整串在节点 id 集合 → 命中；② 取末段去 `.md` 后缀按 stem 匹配；③ 按 title 匹配；④ 都不中 → ghost。
- **坑**：边**不去重**——同页对同一目标多次引用会产生多条 `from/to` 相同的边；同一 `from`→`to` 先 resolve 到真节点与后 resolve 到 ghost 也可能并存。前端 `WikiGraph` 依赖此原始输出，Express 侧**保持逐条 push，不做 dedup**。

### 2.7 `GET categories` → 200 `{<category>:[{path,title,category,excerpt}]}`

- `WikiCategoriesView` → `WikiService.list_categories`（service.py:133-153）。
- **响应是 object，键为动态 category 值**（开放词表，扫到什么返回什么），值是条目数组。OpenAPI 用 `additionalProperties`（views.py:41-47）。Express 直接返回该 object。
- **只收带标记页**：无 `` `category:` `` 标记的页不进响应。
- **category 提取窗口**（`CategoryMarkerExtractor`，issue #84 加固）：**只在「第一个 H1 之下、首个 `##` 之前」窗口内**抓 `` `category:值` `` 机读标记（整行、大小写不敏感、剥离尾反引号）；H1 之前/之后的行内提及不抓。值**小写归一**。
- **excerpt**：剥掉 H1 标题行与 category 标记行，压缩空白，截断 **200 字符**。
- **排序**：组名按字典序、组内按 `path` 字典序（响应稳定）。
- **与 tree 的差异**：categories **收顶层散落 .md**（平铺全库每页），tree 不收。

---

## 3. WikiService 纯逻辑（Express/TS 移植清单）

以下为**纯函数/纯逻辑**，与文件系统解耦，TS 逐行平移即可，无副作用：

| 构件 | 现状锚点 | TS 移植要点 |
|---|---|---|
| `FrontmatterParser` | service.py:76-108 | 逐行简易解析，**不引入 yaml 库**。只解析标量 + 行内 `[a,b]` 列表；嵌套键（`paper:`/`claims:`）跳过。**坑**：`content.find('---',3)` 会把正文里任意 `---`（含 `----` 分隔线）当 frontmatter 结束——**原样保留此歧义**，勿「修正」为严格 YAML。 |
| `CategoryMarkerExtractor` | service.py:30-61 | 窗口截取 + `CATEGORY_RE` + excerpt。正则须 TS 等价：`^`category:\s*([^`\s]+)`\s*$` MULTILINE+IGNORECASE；`_H1_RE=^#\s`、`_H2_RE=^##\s`。 |
| `_WikilinkResolver` | service.py:232-258 | stem/title/id 三级解析 + ghost。`WIKILINK_RE=\[\[([^\]]+)\]\]`。`setdefault` 语义：**先见者优先**（重复 stem/title 不覆盖）。 |
| `build_graph` 边构造 | service.py:193-229 | 见 §2.6，逐条 push 不 dedup。 |
| `list_categories` 聚合 | service.py:133-153 | 分组 + 双排序。 |

> **命名建议**：这些是「组合进 service 的纯逻辑协作者」，TS 侧用纯函数或小型不可组合对象即可，勿套类层级。

---

## 4. path 校验双保险（spec §4 零信任）

**两层都要在 Express 复刻，缺一不可：**

**第①层 — 请求校验（对应 `RelPathField` serializers.py:9-26）**，失败 → 400：
- 非空；不以 `/` 或 `\` 开头（拒绝对路径）；
- 不含 `\`（拒反斜杠穿越）；
- 按 `/` 分段、滤掉 `''`/`'.'` 后，任何段为 `..` → 拒（目录穿越）；
- 末段须以 `.md` 结尾；
- 归一化：重新用 `/` join（剥重复斜杠/`.` 段）。

**第②层 — 文件系统 realpath 校验（对应 `BindMountWikiFileSystem._resolve` adapters.py）**，失败 → 400（`InvalidPath`）：
- `_assert_not_managed`：路径任一段命中 `_SKIP_DIRS`、或末段命中 `_SKIP_FILES` → 拒（**插件私有/占位文件不可经 API 读写**）；
- `realpath(root / rel)` 必须等于 root 或落在 root 之内（`root in fpath.parents`），否则拒（symlink 逃逸/穿越）。

> **`_SKIP_DIRS = {'.openclaw-wiki', '_attachments', '_views'}`**
> **`_SKIP_FILES = {'index.md', 'AGENTS.md', 'WIKI.md', 'inbox.md'}`**
> 这两个集合是「managed 文件」黑名单，**写操作（POST/PUT/DELETE）与读操作都拦**（`_resolve` 是所有读写的入口）。

---

## 5. 文件系统直读直写（`WikiFileSystem` Port → Node `fs`）

现状经 `WikiFileSystem` Protocol（ports.py:178）+ `BindMountWikiFileSystem` Adapter，构造注入 `wiki_root = <home_dir>/wiki/main`。Express 侧用 Node `fs/promises` 实现同一 Port。

**必须复刻的防护（codex #125 系列，全是安全坑）：**

1. **symlink 不跟随**：遍历（`_scan_dir`）遇 symlink（目录或文件）一律跳过——防经树遍历泄露 `wiki/main` 之外的文件。Node `Dirent.isSymbolicLink()`。
2. **root 与 root 直接父的 symlink 检查**：`<home>/wiki` 或 `<home>/wiki/main` 被容器换成 symlink（指向其它实例/宿主）→ build_tree/list_category_pages 返回**空**（不报 500）。**更上层不查**（macOS `/var→/private/var` 系统级 symlink 不应误判）。
3. **只收 regular file**：FIFO/socket/device 命名 `.md` 会让读取阻塞 worker——`is_file()` 判定。
4. **不可读降级**：单目录 `readdir` OSError → 跳过该子树；单文件读取/UTF-8 解码失败 → tree 用文件名 fallback、categories 跳过该页（with_content 时返回 None），**不让单个坏文件把整棵树/聚合 500**。
5. **迭代而非递归**：`_scan_dir` 用显式栈 DFS，深度不受限，不触发栈溢出；每层排序、末尾按 `path` 重排保证顺序稳定。
6. **写操作**：`write_text(encoding='utf-8')` 逐字落盘；`create_page` 须先查存在（`FileExistsError`）再查父目录（`NotADirectoryError`）；`delete_page` 直接 `unlink`。

**tree vs categories 的扫描差异**（易混）：
- `build_tree`：只扫**子目录**成组，**不收顶层散落 .md**；title 用 `_page_title`（frontmatter→stem，无 H1 回落）。
- `list_category_pages`：**平铺全库每页**（含顶层散落 .md），带全文 content；title 用 `_page_entry`（frontmatter→**H1**→stem）。

---

## 6. `CompileFleet.trigger` 异步去抖（Express 对应实现）

**现状**（compile.py）：`POST` 新建与 `DELETE` 删除后调用 `CompileFleet.trigger(instance)`，**PUT 编辑不调**。

| 现状（Python） | Express 落点 |
|---|---|
| `DebouncedCompileTrigger`：按容器名去抖，**5 秒窗口**内多次写只触发一次 | JS 用 `Map<name, NodeJS.Timeout>` + `setTimeout`；同 key 先 `clearTimeout` 再重设 |
| `threading.Timer` + `Lock`，`timer.daemon=True` | Node 单线程事件循环，无需锁；timer 用 `.unref()` 等价 daemon（不阻止进程退出） |
| `DockerCompileExecutor`：`Fleet.get().exec_in_container(name, ['openclaw','wiki','compile'])`，**best-effort 失败吞掉不阻断写** | 复用 map #308 的容器 exec 能力（OpenClaw gateway 已交官方包，但 `wiki compile` 是**容器内 exec**，走 Docker exec 通道，**不经 gateway WS**）；`try/catch` 吞错，仅 log |
| `CompileFleet` service locator（lazy + override/reset，测试换 fake） | TS 同样留可注入 seam（模块级可替换触发器），测试断言「触发且去抖」 |

**坑**：去抖窗口与「PUT 不触发」是行为契约，前端/机器视图一致性依赖它，**勿改触发时机**。

---

## 7. 「按用户隔离」结合点（接口不变前提下的归属校验）

- **现状**：`Instance`（containers/models.py）**无 owner 字段**，按 `name` 寻址；wiki 端点只见 `name`，不知「当前用户」。
- **目标**：#310 schema 草案给 `Container` 加 `ownerId`（必填 FK→User，`onDelete: Cascade`）；`name`/`port` **全局唯一**（不随用户分命名空间）；角色 = admin/user 双角色（#311 定边界）。
- **结合点就在公共前置 `_get_instance`**（见 §0）：按 `name` 查到容器后，**追加一行归属判定**——
  - `admin` → 放行所有容器；
  - `user` → 仅当 `container.ownerId === currentUser.id` 放行。
- **越权语义 = 404，不是 403**：容器存在但非本人所有时，返回**与「容器不存在」完全相同的 404**（`{"detail":"Not found."}`），**避免探测他人容器名**。这是「接口不变」的关键——对外仍只有 400(name 非法)/404(查不到=不存在或无权)，**不新增 403 状态码**，前端无需改。
- **实现位置**：Express JWT middleware 把 `currentUser`（含 `role`、`id`）塞进 `req`/`res.locals`；wiki 公共前置在 `Container.findUnique({name})` 之后做 owner 比对。**所有 5 端点共享此前置**，一处改动全覆盖。
- **依赖**：本 ticket 只定「归属校验挂在前置、越权=404」这一结合点；具体 admin/user 谁能看谁的最终规则归 **#311（双角色边界）**，`Container.name` 全局唯一 vs 按用户唯一归 **#312**。本清单按 #310 草案（全局唯一）写。

---

## 8. 迁移清单（执行 checklist）

- [ ] **路由**：`router.use('/api/v1/containers/:name/wiki', wikiRouter)`；`/tree` GET、`/page` GET/PUT/POST/DELETE、`/graph` GET、`/categories` GET。路由层不加 name 正则。
- [ ] **认证**：wiki 路由组全在 JWT middleware 后；401 语义不变。
- [ ] **公共前置**：name 校验（400）→ 查容器（404）→ **owner 归属（404，非 403）**。
- [ ] **校验层**：`RelPathField` 等价（§4 第①层）；`{path, content}` body 校验，content 逐字保留空白。
- [ ] **错误映射**：InvalidPath→400、PageNotFound→404、PageExists→409、父目录缺失→400、name 非法→400、容器/越权→404。
- [ ] **Port/Adapter**：Node `fs/promises` 实现 `WikiFileSystem`；复刻 symlink/regular-file/不可读降级/迭代扫描/两套 title 语义/双 SKIP 集合/realpath 校验。
- [ ] **纯逻辑平移**：`FrontmatterParser`、`CategoryMarkerExtractor`、`_WikilinkResolver`、`build_graph`（边不 dedup）、`list_categories`（双排序）。
- [ ] **CompileFleet**：5s 去抖 + `.unref()`；POST/DELETE 触发、PUT 不触发；docker exec `openclaw wiki compile` best-effort 吞错。
- [ ] **回归锚点**：`backend/wiki/tests/`（含 `test_graph_api.py`/`test_categories*`）的契约断言逐条对 Express 实现跑通。

---

## 9. 不变量速查（迁移后必须仍成立）

1. 401（无 token）/ 400（name 或 path 非法）/ 404（容器不存在**或越权**或页不存在）/ 409（页已存在）/ 201（新建）/ 204（删除）——状态码集合与语义一字不差。
2. **无 403**：越权访问他人容器 = 404。
3. tree 不收顶层散落 .md，categories 收；两者 title 语义不同（tree 无 H1 回落）。
4. graph 边不去重；ghost 节点带 `ghost:true`。
5. PUT 不触发 compile；POST/DELETE 触发且 5s 去抖。
6. managed 文件（`_SKIP_DIRS`/`_SKIP_FILES`）读写全拦。
7. 单个坏文件/坏目录/坏 symlink 不导致 500——降级为空/fallback/跳过。
