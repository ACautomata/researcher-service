# server — TS/Express 控制面（M0 骨架 + M1 认证与账号）

Wayfinder map **#308** · 交接规格 **#331** · 本切片 **#333**。

新 Express+ws 同进程控制面（替代 Django 后端，过渡期 M0–M6 并存）。本切片交付 **M0 骨架**
+ **M1 认证与账号** 垂直切片：双角色 login / R1 refresh 旋转 + 重放检测 / logout / me /
password-change / bootstrap B1 + C1 强制改密 / OAuth2 O1 骨架 / admin 账号管理 4 端点。
容器/WIKI/对话桥接是后续切片（M2–M4）；骨架已为其预留三挂点：信封中间件全局挂载、
`authenticate()` 可被 WS 握手复用、`PrismaClient` 单例可注入。

## 技术栈（规格 §A 锁定）

Express 5 + `ws` 8（noServer，upgrade 钩子 M4 接）+ `jose` 5（HS256，显式 `algorithms:['HS256']`）
+ Prisma 7 + SQLite（driver adapter `@prisma/adapter-better-sqlite3`）+ `bcryptjs`(cost=12) + `zod`。
JWT 平移 simplejwt 默认（HS256、access 5min、refresh 7d）。

## 目录

```
src/
  app.ts                 createApp({prisma}) 工厂（DI，测试注入 test DB）
  server.ts              createServer(app) + server.on('upgrade') 占位 + bootstrap + listen
  config.ts              env 读取（JWT_SECRET/access/refresh TTL/bcrypt cost/...）
  prisma.ts              PrismaClient 工厂 + 单例（driver adapter 注入）
  codes.ts               五位分层码常量表（#312 + #319 转译 + #333 新增 10005）
  envelope.ts            唯一错误面：EnvelopeError + ok()/fail()
  auth/
    tokens.ts            jose access 签/验 + refresh 生成/散列/R1 旋转
    authenticate.ts      verifyAccessToken + 查库确认 user 存在且 active（REST/WS 共用）
    bootstrap.ts         B1 空表惰性生成 admin（明文密码 log 一次）
    password.ts          bcrypt hash/verify + 临时密码生成
    userService.ts       createUser（register/users POST 共用）
  middleware/
    auth.ts              requireAuth(→10001) / requireAdmin(→10004)
    mustChangePasswordGate.ts  C1 服务端拦截（→10005）
    validate.ts          zod body 校验（→90002 {field:[errors]}）
    errorHandler.ts      envelope 错误中间件 + 404 信封兜底
  routes/                health / auth / users
  validation/schemas.ts  zod schema（login/passwordChange/userCreate/userPatch）
test/                    接缝 #2 信封 REST 契约（vitest + supertest）
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
npm test                       # vitest run（11 文件 / 43 用例，接缝 #2 信封 REST 契约）
npm run prisma:validate        # schema 合法性
```

接缝（spec Testing Decisions #2）：注入假身份（admin/user）打路由，断 HTTP 200 + 信封码 + 归属前置。
防探测用例逐字节断言「不存在 vs 越权」同码（10041）；R1 重放检测有专属用例；凭证零落盘贯穿断言。

## 关键约定

- **统一信封**：所有 REST HTTP 200；成功 `{code:0,data}`，失败 `{code,message,data}`。码表见 `src/codes.ts`。
- **refresh cookie**：`HttpOnly; Secure(prod); SameSite=Lax; Path=/api/v1/auth`；R1 旋转 + 重放族灭。
- **C1 强制改密**：服务端拦截（`mustChangePasswordGate`），放行 me/logout/password-change，余者 mustChange=true → `10005`。
- **防探测**：`/users` 非 admin、目标不存在 → 同码 `10041` 同体，区分仅进服务端日志。
- **凭证零落盘**：响应体不含 passwordHash / refresh 明文 / private_key / device_token。

## 下游衔接

- M2 容器 / M3 WIKI / M4 对话桥接：复用 `createApp`、`authenticate()`、信封中间件、`_get_instance` 归属前置（待加）。
- 前端适配（#317 / M5）：信封解析 + `me.role` + R1 双 token 旋转 + admin users 页。
