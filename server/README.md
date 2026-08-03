# server — TS/Express 控制面（M0 骨架 + M1 认证与账号 + M2 容器生命周期）

Wayfinder map **#308** · 交接规格 **#331** · 切片 **#333（M0+M1）/ #334（M2）**。

新 Express+ws 同进程控制面（替代 Django 后端，过渡期 M0–M6 并存）。已交付：
- **M0 骨架 + M1 认证与账号**（#333）：双角色 login / R1 refresh 旋转 + 重放检测 / logout / me /
  password-change / bootstrap B1 + C1 强制改密 / OAuth2 O1 骨架 / admin 账号管理 4 端点。
- **M2 容器生命周期**（#334）：容器按用户隔离的完整生命周期——编排器 Port + BullMQ(Redis) 后台队列
  + 端口池 + 5 态机 + 异步 delete + 取消标志。`GET /containers/`（user 自己 / admin 全部 + pairing
  预取）、`POST /containers/`（同步返 creating 快照、端口入队前分配）、`DELETE /containers/<name>`
  （异步信封、置取消标志）。

WIKI/对话桥接是后续切片（M3/M4）；骨架已为其预留：`authenticate()` 可被 WS 握手复用、
`getInstanceForUser` 归属前置单点（containers/wiki/models/chat/pairing 复用）、`onEvict` 钩子
（delete 完成后触发 chat pool 逐出，ADR 0006 下为空挂点）。

## 技术栈（规格 §A 锁定）

Express 5 + `ws` 8（noServer，upgrade 钩子 M4 接）+ `jose` 5（HS256，显式 `algorithms:['HS256']`）
+ Prisma 7 + SQLite（driver adapter `@prisma/adapter-better-sqlite3`）+ `bcryptjs`(cost=12) + `zod`
+ **BullMQ 6 + ioredis**（#313 容器后台 provisioning 队列，Redis-backed）+ **dockerode**（docker.sock
容器编排）。JWT 平移 simplejwt 默认（HS256、access 5min、refresh 7d）。

## 目录

```
src/
  app.ts                 createApp({prisma, orchestrator?}) 工厂（DI，测试注入 test DB + 假编排）
  server.ts              createServer(app) + server.on('upgrade') 占位 + bootstrap + assembleFleet + listen
  config.ts              env 读取（JWT_SECRET/access/refresh TTL/bcrypt cost/fleet/redis/...）
  prisma.ts              PrismaClient 工厂 + 单例（driver adapter 注入）
  codes.ts               五位分层码常量表（#312 + #319 转译 + #333/#334 新增）
  envelope.ts            唯一错误面：EnvelopeError + ok()/fail()
  auth/                  tokens / authenticate / bootstrap / password / userService / quota
  middleware/            auth(→10001/10004) / mustChangePasswordGate(→10005) / validate(→90002) / errorHandler
  routes/                health / auth / users / containers
  validation/schemas.ts  zod schema（login/passwordChange/userCreate/userPatch/containerCreate）
  containers/            #334 编排域：
    constants.ts         纯常量（18789/openclaw-gw- 前缀/label/bind 路径/占位）
    errors.ts            领域错误族（携带信封码；errorHandler 统一转译）
    runtime.ts           ContainerRuntime Port（docker 接触面）+ ContainerSpec/ContainerInfo
    dockerRuntime.ts     DockerRuntime（dockerode，真 daemon 接触面）
    ports.ts             PortAllocator（最小空闲端口）
    values.ts            FleetConfig + HEALTH_* 枚举
    configRenderer.ts    openclaw.json 渲染（强制 port/bind/token 占位安全不变量）
    configStore.ts       config 原子写（tmp + chmod 0644 + rename）
    provisioner.ts       HomeProvisioner（cp -a 模板预填充 home）
    leaseMap.ts          NameLeaseMap 进程内互斥（不依赖 Redis，防双创建/双删除）
    lifecycleQueue.ts    LifecycleQueue Port + InlineLifecycleQueue + NameSerializer（按 name 串行）
    bullmqQueue.ts       BullMqLifecycleQueue（Redis-backed，worker 并发默认 2，stalled 重跑）
    deps.ts              FleetDeps 组合根（单点装配 + 测试替换）
    command.ts           FleetCommand 写侧（create_reserve/create_complete/delete + 取消标志 + 补偿）
    readModel.ts         FleetReadModel 读侧（list 聚合 + creating 对账 + ContainerSummary）
    orchestrator.ts      Orchestrator 薄 facade + getInstanceForUser 归属前置
    fleetAssembly.ts     生产装配（DockerRuntime + BullMQ + FleetDeps + Orchestrator）
test/                    接缝 #2 信封 REST 契约 + #5 编排器 Port + 集成 smoke + BullMQ 联通
prisma/                  schema.prisma + init.sql（migrate diff 产出的建表 SQL）
scripts/apply-schema.mjs 把 init.sql 落到 dev DB（不经 prisma CLI，规避 AI 守卫）
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
# 3) 落到 dev DB（清库重建）：
rm -f prisma/panel.db && npm run db:apply
```

测试库不经 CLI：`test/setup.ts` 用 better-sqlite3 直读 `prisma/init.sql` 建临时库，每文件独立。

## 测试 / 校验

```bash
npm run typecheck              # tsc --noEmit（含测试）
npm test                       # vitest run（17 文件 / 111 用例，接缝 #2 信封 + #5 编排器）
npm run prisma:validate        # schema 合法性
```

接缝（spec Testing Decisions）：
- **#2 信封 REST 契约**：注入假身份（admin/user）打路由，断 HTTP 200 + 信封码 + 归属前置。
  防探测用例逐字节断言「不存在 vs 越权」同码（10041 / 20040）；凭证零落盘贯穿断言。
- **#5 编排器 Port**：注入假 docker（FakeRuntime）+ 内存假队列（InlineLifecycleQueue），断
  5 态机 + 取消标志 + 端口入队前分配 + 补偿（bind 换端口重试 / REMOVING 可重试 / 端口耗尽 / 残留目录）。
- **集成 smoke**（`containers-smoke.test.ts` / `bullmqQueue.test.ts`）：真 docker daemon / 真 Redis
  **默认 skip 自动探测门控**（daemon/Redis 不可达 → skip），可达 → 真跑端到端。

## 关键约定

- **统一信封**：所有 REST HTTP 200；成功 `{code:0,data}`，失败 `{code,message,data}`。码表见 `src/codes.ts`。
- **refresh cookie**：`HttpOnly; Secure(prod); SameSite=Lax; Path=/api/v1/auth`；R1 旋转 + 重放族灭。
- **C1 强制改密**：服务端拦截（`mustChangePasswordGate`），放行 me/logout/password-change，余者 mustChange=true → `10005`。
- **防探测**：`/users` 非 admin、目标不存在 → 同码 `10041` 同体；容器「不存在 vs 越权」→ 同码 `20040` 同体，区分仅进服务端日志。
- **凭证零落盘**：响应体不含 passwordHash / refresh 明文 / 容器 token / private_key / device_token。
- **凭证加密（Codex C1）**：gateway token 落盘为 AES-256-GCM 密文（`CREDENTIAL_ENCRYPTION_KEYS`，
  逗号分隔 base64(32 字节)，首个 = active 加密、余者仅解密支持轮换）。**生产必填**（缺失启动
  fail-fast），生成示例 `openssl rand -base64 32`；dev/test 未设置时回退到固定密钥（勿用于生产）。
- **容器隔离（#312）**：user 仅自己容器、admin 跨用户全部；归属前置 `getInstanceForUser` 单点（admin 全放行 / user 仅本人）。
- **容器并发（#313）**：进程内 `NameLeaseMap` 互斥（不依赖 Redis）防双创建/双删除；create/delete 按 name 串行入队；端口入队前分配（SQLite 唯一约束仲裁、四来源已用集）；delete 异步 + 取消标志（provisioning 检查点检出统一回滚）；BullMQ(Redis) worker 并发默认 2 + stalled-job 崩溃重跑。
- **容器补偿**：ERROR 行保留 / bind 端口冲突就地换端口重试（预算=池大小）/ 清理失败标 REMOVING 可重试（20045）/ 端口池耗尽 90004。
- **config 目录方案（#366）**：openclaw.json 落 `instances/<id>/config/`（目录 ro bind + `OPENCLAW_CONFIG_PATH`
  指其内文件）——宿主 rename 换 inode 容器内可见（热加载保留）+ 容器内进程不可写（恢复只读边界）。
  **升级要求**：由「单文件 bind」时代（config 落 `instances/<id>/openclaw.json`、无 `OPENCLAW_CONFIG_PATH`）
  升上来的既有容器没有 `instances/<id>/config` 目录——provider 写盘落新路径不在容器 mount 内 → 热加载
  断链但 API 报成功。写盘已 fail-fast（缺目录 → 90003 + 提示重建，见 `models/configWriter.ts`）；
  **升级后须重建旧容器**（删除重建走新 mount）才能配置模型。
- **共享 key 所有权边界（#336 codex 四轮 P1，已知风险接受）**：`LLM_API_KEY` 值仅管理员部署级配置
  （env/启动配置注入），用户仅配置自己容器的 model provider 条目（含 `base_url`）引用之。**多租户不可信
  场景下**，恶意用户可把自家 provider 的 `base_url` 指向自己端点，诱使容器把共享 key 作为凭证发往该处
  → key 外泄、越配额/影响全体租户。这是 spec §5.2「全面板共享一个 key」决策的既定姿态（Django 前身同
  设计；与 docker.sock §5.4 同理，本地/可信部署可接受）。根治需 per-user 凭证或 admin 白名单 base_url，
  均超出 #336 范围，未实现——多租户部署前需另行决策。

## 下游衔接

- M3 WIKI / M4 对话桥接：复用 `createApp`、`authenticate()`、信封中间件、`getInstanceForUser` 归属前置。
- 配对（M4）：`Pairing` 表经 `onDelete: Cascade` 级联；list 的 pairing 预取签名已就位（M2 恒 unpaired 默认）。
- 对话桥接（M4）：`onEvict` 钩子（delete 完成后触发 chat pool 逐出，ADR 0006 B-直连下为空挂点）。
- 前端适配（#317 / M5）：信封解析 + `me.role` + R1 双 token 旋转 + 异步 delete 轮询 + admin users 页。
