# server — TS/Express 控制面（M0–M5 全域 + M9 生产部署）

Wayfinder map **#308** · 交接规格 **#331** · 切片 **#333（M0+M1）/ #334（M2）/ #335（M3 wiki）/
#336（M4 models）/ #337（M5 对话隧道）/ #341（M9 生产部署 + Django 退役）**。

Express 同进程控制面（替代已退役的 Django 后端；WS 隧道已随 T0 #801 退役，SSE 事件流 #773
为现役传输面）。已交付：
- **M0 骨架 + M1 认证与账号**（#333）：双角色 login / R1 refresh 旋转 + 重放检测 / logout / me /
  password-change / bootstrap B1 + C1 强制改密 / OAuth2 O1 骨架 / admin 账号管理 4 端点。
- **M2 容器生命周期**（#334）：容器按用户隔离的完整生命周期——编排器 Port + BullMQ(Redis) 后台队列
  + 5 态机 + 异步 delete + 取消标志（T0 #801 起端口池废除：行 port 恒 0，不做宿主端口发布）。
  `GET /containers/`（user 自己 / admin 全部）、`POST /containers/`（同步返 creating 快照）、
  `DELETE /containers/<name>`（异步信封、置取消标志）。
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
+ **BullMQ 6 + ioredis**（#313 容器后台 provisioning 队列，Redis-backed）+ **dockerode**（docker.sock
容器编排）。JWT 平移 simplejwt 默认（HS256、access 5min、refresh 7d）。

## 目录

```
src/
  app.ts                 createApp({prisma, orchestrator?}) 工厂（DI，测试注入 test DB + 假编排）
  server.ts              createServer(app) + bootstrap + assembleFleet + listen
  config.ts              env 读取（JWT_SECRET/access/refresh TTL/bcrypt cost/fleet/redis/...，生产 fail-fast）
  prisma.ts              PrismaClient 工厂 + 单例（driver adapter 注入）
  codes.ts               五位分层码常量表（#312 + #319 转译 + 各切片新增）
  envelope.ts            唯一错误面：EnvelopeError + ok()/fail()
  auth/                  tokens / authenticate / bootstrap / password / userService / quota
  middleware/            auth(→10001/10004) / mustChangePasswordGate(→10005) / validate(→90002) / errorHandler
  routes/                health / auth / users / containers
  validation/schemas.ts  zod schema（login/passwordChange/userCreate/userPatch/containerCreate）
  wiki/                  #335 WIKI：routes / service（纯逻辑）/ nodeFs（WikiFileSystem Port 实现）/
                         compile（docker exec 去抖）
  models/                #336 Models：routes / service / endpoints（#775 挂 ownerId + 热生效）
  containers/            #334 编排域：
    constants.ts         纯常量（openclaw-gw- 前缀/label/卷前缀/GATEWAY_BIND）
    errors.ts            领域错误族（携带信封码；errorHandler 统一转译）
    runtime.ts           ContainerRuntime Port（docker 接触面）+ ContainerSpec/ContainerInfo
    dockerRuntime.ts     DockerRuntime（dockerode，真 daemon 接触面）
    values.ts            FleetConfig + HEALTH_* 枚举
    provisioner.ts       HomeProvisioner（cp -a 模板预填充 home）
    imageRef.ts          镜像引用钉版判定（isFloatingImageRef / imageTag 纯知识；#695）
    leaseMap.ts          NameLeaseMap 进程内互斥（不依赖 Redis，防双创建/双删除）
    lifecycleQueue.ts    LifecycleQueue Port + InlineLifecycleQueue + NameSerializer（按 name 串行）
    bullmqQueue.ts       BullMqLifecycleQueue（Redis-backed，worker 并发默认 2，stalled 重跑）
    deps.ts              FleetDeps 组合根（单点装配 + 测试替换）
    command.ts           FleetCommand 写侧（create_reserve/create_complete/delete + 取消标志 + 补偿）
    readModel.ts         FleetReadModel 读侧（list 聚合 + creating 对账 + ContainerSummary）
    orchestrator.ts      Orchestrator 薄 facade + getInstanceForUser 归属前置
    fleetAssembly.ts     生产装配（DockerRuntime + BullMQ + FleetDeps + Orchestrator）
test/                    接缝 #1–#5（wiki Port / 信封 REST / WS 桥 / hostDeps / 编排器 Port）+ 集成 smoke
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

> M2 起 `npm run dev` 会装配真编排（DockerRuntime 挂 docker.sock + BullMQ 连 REDIS_URL）。
> 本地需 docker daemon 与 Redis 可达才能 create/delete 容器；REST 认证/账号端点不依赖它们。

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
npm test                       # vitest run（49 文件 / ~497 用例，接缝 #1–#5）
npm run prisma:validate        # schema 合法性
```

接缝（spec Testing Decisions）：
- **#1 WikiFileSystem Port**：纯逻辑对 fake FS 直测（symlink / 非 regular / 不可读 / SKIP 集合 / 降级）。
- **#2 信封 REST 契约**：注入假身份（admin/user）打路由，断 HTTP 200 + 信封码 + 归属前置。
  防探测用例逐字节断言「不存在 vs 越权」同码（10041 / 20040）；凭证零落盘贯穿断言。
- **#3 events SSE**（#773）：StreamHub per-user 扇出 + serverSeq 单调 + 401 关流语义。
- **#5 编排器 Port**：注入假 docker（FakeRuntime）+ 内存假队列（InlineLifecycleQueue），断
  5 态机 + 取消标志 + 补偿（REMOVING 可重试 / 残留目录 / seedWorkspace 灌卷顺序）。
- **集成 smoke**（`containers-smoke.test.ts` / `bullmqQueue.test.ts`）：真 docker daemon / 真 Redis
  **默认 skip 自动探测门控**（daemon/Redis 不可达 → skip），可达 → 真跑端到端。

## 关键约定

- **统一信封**：所有 REST HTTP 200；成功 `{code:0,data}`，失败 `{code,message,data}`。码表见 `src/codes.ts`。
- **refresh cookie**：`HttpOnly; Secure(prod); SameSite=Lax; Path=/api/v1/auth`；R1 旋转 + 重放族灭。
- **C1 强制改密**：服务端拦截（`mustChangePasswordGate`），放行 me/logout/password-change，余者 mustChange=true → `10005`。
- **防探测**：`/users` 非 admin、目标不存在 → 同码 `10041` 同体；容器「不存在 vs 越权」→ 同码 `20040` 同体，区分仅进服务端日志。
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
  `getInstanceForUser` 归属前置（containers/wiki/models 全域单点）。
- 配对/对话桥接（#378/#385、#337 ADR 0006）：已随 T0 #801 整链退役（Pairing 表删除、隧道四文件
  删除、bootstrap-token 端点删除）；现役对话面 = REST+SSE（#793）。cookie Secure 由
  `NODE_ENV==='production'` 直接判定，无 CORS 中间件。
- 前端（#340/M5/M8）：信封解析 + `me.role` + R1 双 token 旋转 + 异步 delete 轮询 + ChatView 拆分
  （8 组件）+ admin users 页。
- 生产（#341）：`deploy/docker-compose.deploy.yml` + CD 构建 `server` 镜像；Django 后端已退役。
