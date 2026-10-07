# deploy —— 面板编排契约（生产栈 + dev 栈 + 镜像构建）

本目录承载多 OpenClaw 容器面板的**编排契约**：

- `docker-compose.deploy.yml` —— **生产栈**（frontend nginx + server + redis + autofigure sidecar；
  由 CD scp 落盘宝塔宿主 `/www/panel/`）。
- `docker-compose.dev.yml` —— **dev 栈**（server+redis 容器化，与 prod 同形态，issue #594 / ADR 0013）。
- `.env.example` —— 生产栈环境变量模板（`LLM_API_KEY` / `JWT_SECRET` 等；真实 `.env` 经 CD 渲染，
  不进版本库）。
- `wiki-image/` —— wiki 容器镜像构建源（#784，busybox 级 + 零初始化）。
- `autofigure-sidecar/` —— AutoFigure sidecar 镜像构建源（T08/T11；服务段删除归 #802）。

> **T0 legacy 清退（#801）**：`openclaw.json` 配置模板、`docker-compose.yml` 单容器联调栈、
> `openclaw-image/` 派生镜像构建源均已删除——config 渲染写盘链、端口池、设备配对、bootstrap-token、
> 升级编排、健康探针对账整链退役。fleet 目标镜像 = `config.ts` 的 `OPENCLAW_IMAGE` 钉版存量
> GHCR 引用（存量镜像可继续拉取，可覆盖回官方基线）；容器读镜像内默认配置，`GATEWAY_TOKEN`
> 经 env 注入、AES 密文落盘；行 `port` 恒 0 记账（端口池废除，不做宿主端口发布）。

## fleet 目标镜像（钉版纪律，T0 #801 起为存量引用）

- **生产禁浮动 tag**：`OPENCLAW_IMAGE` 为浮动引用（无 tag 或 `:latest`）→ server 启动 fail-fast
  （机器强制，准据 `isFloatingImageRef`）。滚动 tag（`latest-browser` / `extended-stable-browser`）
  同样禁用于生产、但**不由代码拦截**（上游命名无法穷举，靠评审拦）——它们与本条要防的「目标
  随上游移动」是同一风险。dev/test 不拦（本地调试可覆盖回官方 `:latest`）。
- T0 #801 起派生镜像不再构建推送——`OPENCLAW_IMAGE` 默认值指向存量版本 tag
  （`ghcr.io/acautomata/researcher-service/openclaw:2026.9.4-browser`，内容冻结），bump = 改
  `server/src/config.ts` 默认值（生产禁浮动约束不变；存量镜像缺失时可覆盖回官方基线 tag）。

## wiki 容器镜像（#784）

`deploy/wiki-image/`（busybox 级极简 + 零初始化，无骨架 COPY），默认镜像
`ghcr.io/acautomata/researcher-service/wiki:<FROM 基线 tag>`，经 `WIKI_IMAGE` 可覆盖
（生产禁浮动 tag，同上）。版本单源 = 其 Dockerfile 的 FROM 基线行，与
`server/src/config.ts` 的 WIKI_IMAGE 默认值由 `server/test/wikiImage.test.ts` 交叉断言锁死。
本地构建（真编排/真容器联调需要）：

  ```bash
  TAG="$(grep -m1 -E '^[[:space:]]*FROM[[:space:]]' deploy/wiki-image/Dockerfile | awk '{print $2}')"; TAG="${TAG##*:}"
  docker build -t "ghcr.io/acautomata/researcher-service/wiki:${TAG}" deploy/wiki-image
  ```

## 面板编排面（T0 #801 后的 create/delete 链）

```
Express 控制面 (server/src/containers)
    │ 1. createComplete：mkdir instanceDir → ensureImage → docker create（无宿主端口发布）→
    │    seedWorkspace（named volume 拓扑：镜像内模板 workspace/ 灌容器卷）→ start → 落行
    │ 2. Docker SDK 挂 /var/run/docker.sock 建/删容器 openclaw-gw-<name>
    │ 3. named volume 拓扑（ADR 0011，#590/#592）：openclaw-wiki/workspace/home-<id> 三卷，
    │    空卷首挂由镜像内 ~/.openclaw 骨架自动初始化；home 模板（researcher 克隆）生产经
    │    server 镜像构建期入镜像（ADR 0013，#593），不再挂载宿主
    │ 4. 活性 = docker inspect Running（健康探针随 #801 退役）；删除 = chown 前置 exec +
    │    docker rm（连带三卷）
    ▼
OpenClaw 容器 fleet（容器内统一 18789，不做宿主端口发布——端口池 19000–19999 已废除）
```

- **凭证边界**：`GATEWAY_TOKEN` 每容器独立生成、经 env 注入，真值以 AES-256-GCM 密文落盘
  （`Container.token` 列）；不落日志/不下发浏览器（bootstrap-token 端点已随 #801 退役）。
- **docker.sock 安全**：控制面挂 `/var/run/docker.sock` = 等价 root（spec §5.4 明示风险）。本地/可信
  部署可接受；生产应限制网络面或改用 rootless / 远程 TLS daemon。

## 凭证加密与密钥轮换

后端将 `Instance.token`（GATEWAY_TOKEN 密文）以 AES-256-GCM 密文持久化。生产环境必须通过环境变量
注入密钥，绝不能将密钥提交到 `.env.example`、镜像或日志中：

```bash
export CREDENTIAL_ENCRYPTION_KEYS="<current-base64url-key>,<previous-base64url-key>"
```

每个 key 必须是 32 字节的 base64url 编码值；第一个是当前写入 key，后续 key 仅用于读取历史密文。使用部署平台的 secret store 或受控环境注入该变量。

轮换步骤：

1. 备份数据库，并记录当前 key ring。
2. 生成新 32 字节 key；将它放在 `CREDENTIAL_ENCRYPTION_KEYS` 的第一个位置，旧 key 保留在后面。
3. 重启控制面使新配置生效（Express 控制面仅读 env，无独立旋转命令；写入用新 key、旧 key 继续读历史密文）。
4. 验证应用可读取既有实例记录，并完成数据库备份校验。
5. 从环境变量移除旧 key，再次重启；此时旧 key 可以安全下线。

若怀疑 key 泄露：立即限制密钥访问权限，按以上流程生成并启用新 key、执行重加密、移除泄露 key；
同时轮换网关 token，并审计部署平台与数据库访问日志。

## 与控制面的衔接

- 控制面配置走环境变量（`server/src/config.ts`）：`OPENCLAW_TEMPLATE_DIR`（home 模板源目录，
  生产必填绝对路径）、`OPENCLAW_FLEET_ROOT`（`instances/<id>/` 落盘根，生产须绝对路径 fail-fast）、
  `OPENCLAW_IMAGE`（fleet 目标镜像钉版引用）、`LLM_API_KEY`（全面板共享，env 注入容器不落盘）。
  model provider CRUD 经 `models` 域 + `config_meta` version bump 热生效（#775，不再渲染落盘）。

## 面板 dev 栈（容器化控制面，issue #594 / ADR 0013）

dev 不再 `npm run dev` 宿主直跑控制面，改 `docker-compose.dev.yml` 起 server+redis 容器、挂
docker.sock，与 prod（`docker-compose.deploy.yml`）**同形态**——消除「宿主直跑摸不到 named
volume（卷物理路径在 Docker VM 内）→ dev/prod 寻址/路径分叉」（ADR 0012）。

```bash
# 1. 克隆 researcher（build additional_contexts template= 默认 ../researcher；或设 RESEARCHER_DIR）
git clone --depth 1 https://github.com/ACautomata/researcher ./researcher

# 2.（仅真编排需）LLM key；仅起控制面/登录可跳过。fleet 目标镜像 = config.ts 钉版存量
#    GHCR 引用（派生镜像构建链已随 T0 #801 退役），无需本地构建。
export LLM_API_KEY=...

# 3. 起 dev 控制面（server:8001，挂 docker.sock + panel-dev-db 卷）
docker compose -f deploy/docker-compose.dev.yml up -d --build

# 4. 前端仍宿主 vite dev（proxy /api → 127.0.0.1:8001）
cd frontend && npm run dev

# 改 server 代码 → 重建镜像
docker compose -f deploy/docker-compose.dev.yml up -d --build server
```

- **与 prod 对齐**：模板镜像内路径、`REDIS_URL`、`DATABASE_URL`、`OPENCLAW_FLEET_ROOT` 逐键一致；
  仅 `NODE_ENV=development`（走 config.ts dev 分支）与「server 暴露 8001 给宿主 vite」为 dev 特有。
  端口发布/健康探测/宿主寻址已随 T0 #801 退役（dev/prod 均无端口池与 host.docker.internal 映射）。
- **双轨工作流**：纯逻辑快速迭代仍走宿主 `cd server && npm test` / `npm run typecheck`（不起服务、
  不摸卷）；凡要起服务 / 真编排 OpenClaw 容器（named volume 拓扑），一律走本容器化 dev 栈。

## AutoFigure env（#792 插件化收口——现行）

figure 生成 = server 进程内插件管线（#792 起；sidecar 时代见下方两节历史档案）。键声明单源 =
`plugins/autofigure/manifest.ts` configSchema，启动期 `assertPluginEnv` 全目录校验（不看启用位）：

| 键 | 必填 | 说明 |
|----|------|------|
| `AUTOFIGURE_IMAGE_MODEL` | 是 | 生图模型名（如 image-01） |
| `AUTOFIGURE_IMAGE_API_KEY` | 是 | 生图 API key（服务端凭证） |
| `FAL_KEY` | 是 | fal 云计算 key（SAM3/RMBG） |
| `AUTOFIGURE_IMAGE_BASE_URL` | 否 | 生图 API base URL（缺省国际区 `https://api.minimax.io`） |
| `AUTOFIGURE_SVG_MODEL` | 否 | SVG 生成模型 id（缺省 owner 默认链 primary） |

- **生产**：三必填键写入同目录 `.env`（env_file 注入，与 `LLM_API_KEY` 同机制）——缺键 =
  server 启动期 fail-fast throw，不做静默降级。
- **dev**：`docker-compose.dev.yml` 显式列三键（`${VAR:-}` 空串安全）——缺键 = dev 警告照常
  启动，figure 工具调用期明确报错。
- 凭证纪律：env 注入、不落盘、不入日志、不进事件载荷/产物（#744 §6）。

## AutoFigure 接线（T10，docs/autofigure/tickets/T10-dev-sidecar-smoke.md）——已换轨退役（#791）

> **已换轨退役（#791）**：本节为 sidecar 时代历史档案。server 侧消费端全量退役——`AUTOFIGURE_*`
> env 注入（config.autofigure 读取面删除）、`AUTOFIGURE_ENABLED` flag 门、`X-Autofigure-Api-Key`
> 凭证注入链、figures 创建端点与 Idempotency-Key、`figuresSmoke` 测试均已删除；figures = 常驻
> 读面（无 flag 门），生成入口 = 会话内 figure 工具（#744 §4.1，票 4 接线）。compose 中的
> **autofigure sidecar 服务段暂留**（无现役消费者），目录与服务段的正式删除归票 6（#744 §10）。
> 注意：插件级 env 键已随 #792 回归——现行键清单见上方「AutoFigure env」节。

- **sidecar 服务段（暂留，历史形状）**：dev 栈 `autofigure` 服务仅挂 `panel-dev-net`、无宿主
  端口暴露、零 host 挂载（ADR 0013），`/health` healthcheck；`mem_limit: 2g`（T10 judgement call）。
  构建：`docker compose -f deploy/docker-compose.dev.yml build autofigure`（或
  `docker build deploy/autofigure-sidecar -t autofigure-sidecar:dev`）。
- **部署面注意（服务段存续期仍为真）**：autofigure 是栈内声明服务，`docker compose up -d` 仍会
  启动它——镜像不可拉或 start 失败会使 up 变红（与面板是否使用无关）。
- **历史语义（已失效，仅存档）**：原 T10 设计为 server 经 env 注入 `AUTOFIGURE_ENABLED/LLM_KEY/
  SIDECAR_URL/JOB_TIMEOUT_MS` 四键调 sidecar；真实生成 smoke（三条件门控）走 `POST /api/v1/figures`
  （Idempotency-Key）创建-轮询链——均随 #791 退役，详见本节 superseded 前的 git 历史。

## AutoFigure 生产打包（T11，docs/autofigure/tickets/T11-production-packaging-cd.md）——已换轨退役（#791）

> **已换轨退役（#791）**：与上方 T10 段同批——server 消费端全量退役，生产 compose 的
> **panel-autofigure 服务段暂留**（无现役消费者），目录与服务段正式删除归票 6（#744 §10）。

- **sidecar 服务段（暂留，历史形状）**：生产 compose 起 **panel-autofigure** 第 4 镜像
  `ghcr.io/acautomata/researcher-service/autofigure`（CD 既有管线构建推送，vendored T08 源
  不 fetch mutable upstream；许可/署名文件构建期入镜像 + Dockerfile 断言）。仅挂 `panel-net`、
  无宿主端口、零 host 挂载（ADR 0013）、`/health` healthcheck、`mem_limit: 2g`、
  `restart: unless-stopped`、内部 URL `http://autofigure:8080`。镜像覆盖位
  `PANEL_AUTOFIGURE_IMAGE`（`:latest` / `:<sha>` 回滚）对齐 `PANEL_*_IMAGE` 先例，随服务段
  同批清退。
- **部署面注意（服务段存续期仍为真）**：CD 的 `docker compose pull`/`up` 仍会部署该服务——
  镜像不可拉或 start 失败会使 CD/up 变红（与面板是否使用无关）。
- **历史语义（已失效，仅存档）**：原 T11 设计的 `AUTOFIGURE_ENABLED` flag 门（figures 路由
  90005）、`AUTOFIGURE_LLM_KEY` env 注入 + `X-Autofigure-Api-Key` 凭证链、T07 规范化信封码
  失败面均随 #791 退役。
