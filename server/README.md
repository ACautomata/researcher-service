# server — TS/Express 控制面（M0–M5 全域 + M9 生产部署）

Wayfinder map **#308** · 交接规格 **#331** · 切片 **#333（M0+M1）/ #334（M2）/ #335（M3 wiki）/
#336（M4 models）/ #337（M5 对话隧道）/ #341（M9 生产部署 + Django 退役）**。

Express 同进程控制面（替代已退役的 Django 后端；WS 隧道已随 T0 #801 退役，SSE 事件流 #773
为现役传输面）。已交付：
- **M0 骨架 + M1 认证与账号**（#333）：双角色 login / R1 refresh 旋转 + 重放检测 / logout / me /
  password-change / bootstrap B1 + C1 强制改密 / OAuth2 O1 骨架 / admin 账号管理 4 端点。
- **M2 容器生命周期**（#334）：~~容器按用户隔离的完整生命周期（编排器 Port + BullMQ 后台队列
  + 5 态机）~~ **已随 #858 整链退役**（容器行表/CRUD/管理页/NameLeaseMap/BullMQ 生命周期队列）——
  现役容器面 = 会话沙箱（#776）+ wiki 容器（#784），见目录树与 `deploy/README.md`。
- **M3 WIKI**（#335）：5 路由 7 方法逐字节平移——`WikiFileSystem` Port + 纯逻辑
  （`FrontmatterParser`/`CategoryMarkerExtractor`/`WikilinkResolver`）+ compile 去抖 5s（docker exec，best-effort）
  + FS 安全（symlink 不跟随 / SKIP 集合 / path 双保险）。
- **M4 Models**（#336）：provider CRUD + `provider_id` 唯一 40041 + key 零落盘（#775 起事务 =
  mutation + config_meta version bump 热生效，不再渲染落盘；写盘链 configWriter/configBuilder 已随
  T0 #801 物理删除）。
- **M5 对话桥接**（#337/#369/#371/#378/#385）：~~ADR 0006 浏览器直连 WS 隧道~~ **已随 T0 #801 整链
  退役**（chat 隧道/设备配对/bootstrap-token 端点/files 写面）——现役对话面 = REST+SSE（#793）。

生产部署（#341）：`deploy/docker-compose.deploy.yml`（frontend nginx + server + redis 三服务）+
CD 构建 `server` 镜像推 GHCR；Django 后端已退役删除。见下方「生产部署」。

## 技术栈（规格 §A 锁定）

Express 5 + `jose` 5（HS256，显式 `algorithms:['HS256']`）
+ Prisma 7 + SQLite（driver adapter `@prisma/adapter-better-sqlite3`）+ `bcryptjs`(cost=12) + `zod`
+ **BullMQ 6 + ioredis**（runner run 队列 #747，Redis-backed；旧 #313 容器 provisioning 队列随 #858 退役）
+ **dockerode**（docker.sock 编排面板自管容器：会话沙箱 + wiki 容器）。JWT 平移 simplejwt 默认
（HS256、access 5min、refresh 7d）。

## 目录

```
src/
  app.ts                 createApp 装配（全局信封/认证中间件 + 域路由挂载）
  server.ts              进程入口：bootstrap + listen（域装配见各域 assembly）
  config.ts              env 读取（JWT_SECRET / DATA_ROOT / SANDBOX_IMAGE / WIKI_IMAGE / ...，生产 fail-fast）
  prisma.ts              PrismaClient 工厂 + 单例（driver adapter 注入）
  codes.ts               五位分层码常量表（#312 + 各切片新增）
  envelope.ts            唯一错误面：EnvelopeError + ok()/fail()
  auth/                  tokens / authenticate / bootstrap / password / userService（双角色 + R1 旋转 + C1 强制改密）
  middleware/            auth(→10001/10004) / mustChangePasswordGate(→10005) / validate(→90002) / errorHandler
  routes/                health / auth / users / traceLogs（域路由多在各域 routes.ts 自挂）
  validation/schemas.ts  zod schema（输入 0 信任，禁裸读 req.body）
  sessions/              会话 REST 域（#778：消息幂等 / 审批 / rewind·fork / 斜杠命令；reducer 投影零差异）
  events/                SSE 事件流（#773：StreamHub per-user 扇出 + serverSeq 单调 + 事件桥薄投影）
  runner/                LangGraph 运行时（#747 换轨）：providerRegistry / RunService / 审批三层漏斗 /
                         writelock / wikigen / 持久化双件（checkpoint + memory）
  sandboxes/             会话沙箱生命周期（#776：researcher-sandbox-<sessionId>，惰性创建 / 闲置 stop / 级联删）
  wikiContainers/        wiki 容器生命周期（#784：researcher-wiki-<userId>，永久、零出网、export/import 备份还原）
  containers/            面板自管容器共享原语（#858 收敛后 5 件）：constants（researcher.kind/session/owner
                         标签 schema）/ kind 识别 / dockerImage（ensureImagePulled）/ lifecycleQueue
                         （NameSerializer per-name 串行）/ imageRef（浮动引用判定）
  wiki/                  wiki 树 + CRUD + graph（#784 换轨 wiki 容器；#789 OKF 适配）：routes / service /
                         logic（纯逻辑）/ dockerFs
  models/                model provider CRUD（#775：ownerId + config_meta version bump 热生效 + 端点白名单）
  files/                 统一文件读面（#801 只读化：root=lab 经 Docker getArchive，ADR 0012）
  figures/               AutoFigure 读面 + ctx.figures 句柄 + figure_run 审计（#791 / #792）
  attachments/           附件上传（#780：临时区落 DATA_ROOT，run 首步 ingestion 进沙箱）
  plugins/               插件系统骨架（#788：api / registry / surface / tools / runContext）
  officialContent/       官方内容目录（#787：commands / skills，always-on，generated.ts 提交入库）
  openapi/               OpenAPI 文档面（#761：zod 生成式，admin-only）
  traceLogs/             TextTrace 落库查询面（审计/运行轨迹检索）
test/                    vitest 全量（接缝：wiki Port / 信封 REST / hostDeps / files Port / 部署契约
                         文本断言）+ 真 docker daemon / Redis 门控 smoke（自动探测，不可达即 skip）
prisma/                  schema.prisma + init.sql（migrate diff 产出的建表 SQL）
scripts/apply-schema.mjs 把 init.sql 落到 dev DB（不经 prisma CLI，规避 AI 守卫；逐语句 skip-if-exists 幂等）
scripts/upgrade-schema.mjs docker-entrypoint 每次启动 additive 收敛（PRAGMA user_version=SCHEMA_VERSION）
scripts/lib/incremental-schema.mjs 增量 DDL 单一过程（apply/upgrade 两路径共享，与 init.sql 镜像 parity 由测试锁死）
Dockerfile               生产镜像（多阶段；entrypoint 幂等落表 + node dist/server.js，见「生产部署」）
```

## 开发

```bash
npm install
npm run prisma:generate        # 生成 client 到 src/generated/prisma
npm run db:apply               # 把 prisma/init.sql 落到 file:./prisma/panel.db（建表）
cp .env.example .env           # 按需改 JWT_SECRET 等
npm run dev                    # tsx watch，http://localhost:8001；首启 log 输出 admin 临时密码一次
```

> 起服务 / 真编排容器（沙箱 + wiki 容器）一律走容器化 dev 栈
> （`deploy/docker-compose.dev.yml`，server:8001，issue #594 / ADR 0013）；宿主 `npm run dev`
> 仅适合纯逻辑调试（摸不到 named volume）。会话沙箱/wiki 容器惰性创建需 docker daemon 可达；
> REST 认证/账号端点不依赖。

## 接口文档（OpenAPI / Swagger UI，#761）

文档面 = **zod 生成式** OpenAPI 3.1（`src/openapi/`：`paths.ts` 逐端点声明 + 请求体引用
`validation/schemas.ts` 单一来源——零漂移，不手写 openapi.yaml）+ swagger-ui-express UI。
整树 `/api/docs` **requireAuth + requireAdmin**（#758 Q14）。

**网页交互（Swagger UI）**：前端 admin 子应用 → http://localhost:5173/admin/ 登录 admin →
「API 文档」页（前端带认证链拉 spec，TryIt 请求自动注入 token）。浏览器地址栏**直开不了**
`/api/docs`——门控是 `Authorization: Bearer`，导航请求带不上 header（→ 10001）；admin SPA
的内嵌视图就是为此存在（`frontend/src/admin/views/ApiDocsView.vue`）。

```bash
cd server
npm run docs        # = npm run dev，启动前打印文档入口 banner（控制面 :8001）
```

**TryIt 认证**：Swagger UI 右上角 Authorize 粘贴 access token（JWT HS256，默认 5m 过期）：

```bash
curl -s -X POST http://localhost:8001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<admin>","password":"<密码>"}' | jq -r .data.access
```

**程序化消费**：`GET /api/docs/openapi.json`（Bearer admin）——裸 JSON，不包 #312 信封。

- **开关**：`API_DOCS_ENABLED`（默认 true；false → 装配层不注入 docs deps → `/api/docs` 整树 90005）。
- **SSE 不在覆盖面**：`GET /api/v1/events` 是 SSE 流（panel_stream cookie 认证，#773）——流式
  语义超出请求/响应文档模型（`document.ts` description 明文载此决策）。
- **字节例外**：figures png/svg 与附件 download 成功路径直发原生字节（豁免 #312 信封；错误面仍信封）。
- **覆盖守卫**：`test/apiDocsCoverage.test.ts` 对 `createApp` 全量装配做 Express 5 路由栈反射，
  与实际挂载端点**双向**断言（漏登记/幻影登记同红）——新增 REST 端点必须同步登记
  `src/openapi/paths.ts`，否则 CI 红。

### schema 变更

Prisma 7 的 `db push` / `migrate dev` 带 AI 破坏性操作守卫（交互式 consent）。本仓库改用
**`migrate diff` 产出 SQL + better-sqlite3 直连落表**，规避守卫且更快：

```bash
# 1) 改 prisma/schema.prisma
# 2) 重生成建表 SQL：
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/init.sql
npm run prisma:generate
# 3) 新增表 DDL 同步镜像进 scripts/lib/incremental-schema.mjs（既有库走 upgrade 路径补表；
#    镜像与 init.sql 同形状由 test/schemaLanggraphFoundation.test.ts 的 NEW_TABLE_COLUMNS 两路径断言锁死）
# 4) 落库：db:apply 幂等可重跑——空库全量建表、旧库 additive 收敛（新表/新列补齐，旧表形状不动）：
npm run db:apply
#    彻底重建亦可：rm -f prisma/panel.db && npm run db:apply
```

测试库不经 CLI：`test/setup.ts` 用 better-sqlite3 直读 `prisma/init.sql` 建临时库，每文件独立。

## 测试 / 校验

```bash
npm run typecheck              # tsc --noEmit（含测试）
npm test                       # vitest run 全量（接缝 + 部署契约断言 + 门控 smoke）
npm run prisma:validate        # schema 合法性
```

接缝（spec Testing Decisions）：
- **#1 WikiFileSystem Port**：纯逻辑对 fake FS 直测（symlink / 非 regular / 不可读 / SKIP 集合 / 降级）。
- **#2 信封 REST 契约**：注入假身份（admin/user）打路由，断 HTTP 200 + 信封码 + 归属前置。
  防探测用例逐字节断言「不存在 vs 越权」同码；凭证零落盘贯穿断言。
- **#3 events SSE**（#773）：StreamHub per-user 扇出 + serverSeq 单调 + 401 关流语义。
- **部署契约文本断言**（`prodDeploy.test.ts` / `devDeploy.test.ts` / `openclawRetirement.test.ts` /
  `wikiImage.test.ts`）：对 compose / Dockerfile / CD workflow / env 样例 / 部署文档做静态断言，
  防「模板/配置回退到宿主挂载」「退役配置项复活」回归（不触真 docker）。
- **集成 smoke**（`sandboxSmoke.test.ts` / `wikiContainerSmoke.test.ts` 等）：真 docker daemon /
  真 Redis **默认 skip 自动探测门控**（daemon/Redis 不可达 → skip），可达 → 真跑端到端。

## 关键约定

- **统一信封**：所有 REST HTTP 200；成功 `{code:0,data}`，失败 `{code,message,data}`。码表见 `src/codes.ts`。
- **refresh cookie**：`HttpOnly; Secure(prod); SameSite=Lax; Path=/api/v1/auth`；R1 旋转 + 重放族灭。
- **C1 强制改密**：服务端拦截（`mustChangePasswordGate`），放行 me/logout/password-change，余者 mustChange=true → `10005`。
- **防探测**：`/users` 非 admin、目标不存在 → 同码 `10041` 同体；2xxxx 码段（含容器域
  20040「不存在 vs 越权」同码形态）随 #858 容器行表退役整组保留防复用，区分仅进服务端日志。
- **凭证零落盘**：响应体不含 passwordHash / refresh 明文 / private_key。
- **凭证加密（Codex C1）已整链退役**（#858 起 #859 收尾）：AES-256-GCM 链（`crypto.ts`）与
  `CREDENTIAL_ENCRYPTION_KEYS` 仅服务 gateway token 落盘，随 fleet 编排退役——全库零消费面
  （含 cd.yml 注入线摘除），无保留面。
- **容器隔离/并发/补偿（#312/#313 fleet 域）已随 #858 退役**：容器行表/CRUD/NameLeaseMap/BullMQ
  生命周期队列整链删除；现役容器面 = 会话沙箱 + wiki 容器（`sandboxes/` + `wikiContainers/`，
  归属 = 认证身份直派生零容器行查询，per-name 串行 = `containers/lifecycleQueue.ts` NameSerializer）。
- **config 面（#366 → T0 #801）**：openclaw.json 渲染写盘链（configRenderer/configWriter/configBuilder）
  与 openclaw.json 模板已整链退役——models 域经 config_meta version bump 热生效（#775）；
  `GATEWAY_TOKEN` 凭证链已随 #858/#859 退役。
- **共享 key 所有权边界（#336 codex 四轮 P1，已知风险接受）**：`LLM_API_KEY` 值仅管理员部署级配置
  （env/启动配置注入），用户仅配置自己容器的 model provider 条目（含 `base_url`）引用之。**多租户不可信
  场景下**，恶意用户可把自家 provider 的 `base_url` 指向自己端点，诱使容器把共享 key 作为凭证发往该处
  → key 外泄、越配额/影响全体租户。这是 spec §5.2「全面板共享一个 key」决策的既定姿态（Django 前身同
  设计；与 docker.sock §5.4 同理，本地/可信部署可接受）。根治需 per-user 凭证或 admin 白名单 base_url，
  均超出 #336 范围，未实现——多租户部署前需另行决策。

## 生产部署（#341 M9）

生产镜像 `server/Dockerfile`（多阶段：build 全量 npm ci + prisma generate + tsc → runtime `npm ci
--omit=dev` + dist + prisma/scripts）。入口 `docker-entrypoint.sh`：先幂等落表——fresh 库跑
`scripts/apply-schema.mjs` 全量建表（逐语句 skip-if-exists，可重跑）；既有库按 users 表存在判定
跳过全量、每次启动跑 `scripts/upgrade-schema.mjs` additive 收敛（SQLite `user_version` 标记）——
再 `exec node dist/server.js`。

生产 compose：`deploy/docker-compose.deploy.yml` 三服务（frontend nginx → server:8001 → redis）。
**必填 env**（`NODE_ENV=production` 下 fail-fast）：`JWT_SECRET`（≥32 字符）·
`DATABASE_URL`（compose pin `file:/app/db/db.sqlite3`）· `DATA_ROOT`（compose pin `/data`，
落盘根 = 附件上传临时区；#858 前身 `OPENCLAW_FLEET_ROOT`）。LLM_API_KEY 经 provider 解析消费
（#731 §1.3）。`SANDBOX_IMAGE` / `WIKI_IMAGE` 有钉版缺省值故不在上列，但**生产禁浮动 tag**：无
tag 或 `:latest` 启动即 fail-fast（准据见 `server/src/config.ts` 的 `readPinnedImage`；#858 起
fleet 目标镜像 `OPENCLAW_IMAGE` 随编排退役）。部署全流程（CD、secrets、回滚、排障）见
`deploy/DEPLOY.md`。

> 坑：`node:lts-slim`（Debian/glibc）——better-sqlite3 原生模块不兼容 alpine/musl；runtime 阶段
> 需 build-essential + python3（postinstall 编译工具链，Dockerfile 已含）。

## 下游衔接

- WIKI（#335）与 Models（#336）已交付：复用 `createApp`、`authenticate()`、信封中间件、
  zod validate；归属门 #856/#857 起挂 owner 级（req.user.id 直派生，容器行查询随 #858 退役）。
- 配对/对话桥接（#378/#385、#337 ADR 0006）：已随 T0 #801 整链退役（Pairing 表删除、隧道四文件
  删除、bootstrap-token 端点删除）；现役对话面 = REST+SSE（#793）。cookie Secure 由
  `NODE_ENV==='production'` 直接判定，无 CORS 中间件。
- 前端（#340/M5/M8）：信封解析 + `me.role` + R1 双 token 旋转 + ChatView 组件族
  （REST+SSE 编排）；admin 子应用 `/admin/` MPA（#800）。
- 生产（#341）：`deploy/docker-compose.deploy.yml` + CD 构建 `server`/`frontend`/`wiki` 三镜像；
  Django 后端已退役。
