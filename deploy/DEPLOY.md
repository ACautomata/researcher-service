# 面板生产部署（CD → 宝塔宿主）

本文档覆盖 **一次性 bootstrap** 与 **CD 自动化边界**。流水线本身见 `.github/workflows/cd.yml`。
（#341 M9：部署栈已从 Django backend 切换为 TS/Express server。）

## 架构

```
https://researcher.acautomata.top
    │  宝塔边缘 nginx：Let's Encrypt 证书（自动续期）+ 强制 HTTPS
    │  反代 → http://127.0.0.1:18080
    ▼
panel-frontend 容器（nginx，唯一对宿主暴露，loopback:18080）
    ├─ /        → SPA（dist/，history fallback）
    ├─ /api/    → panel-server:8001（TS/Express，#312 信封）
    └─ /api/v1/events → panel-server:8001（SSE 事件流，proxy_buffering off）
                     │  panel-server 挂 docker.sock（编排 OpenClaw 容器）+ SQLite 卷；
                     │  home 模板构建期入镜像（ADR 0013，无宿主数据挂载）
                     ▼
              panel-redis（BullMQ 队列，内部网络）
              panel-autofigure（AutoFigure sidecar，仅 panel-net 内部；flag 默认关，sidecar 未被使用）
```

- 四服务 `restart: unless-stopped`，宿主重启自恢复。
- 前端为 origin-relative：构建不注入后端地址，无 CORS、无 per-domain 重建。
- 镜像存私有 GHCR：`ghcr.io/<owner>/<repo>/{server,frontend,wiki,autofigure}`，tag `:latest` +
  `:<commit sha>`（wiki 为 wiki 容器镜像 #784，autofigure 为 AutoFigure sidecar T08/T11）。
  wiki 另推**版本 tag**（`:<Dockerfile FROM 基线 tag>`）——**面板 wiki 容器的目标镜像钉的就是它**
  （server 镜像内 `config.ts` 默认值同版本）。fleet 目标镜像 = `OPENCLAW_IMAGE` 存量钉版 GHCR
  引用（openclaw-image 派生镜像构建已随 T0 #801 退役，见 `deploy/README.md`）。
- **超时分层**：`/api/` 慢请求（创建容器、配对等）依赖代理链逐层放宽超时。容器内 nginx 已配
  `proxy_read_timeout/send_timeout 300s`（`/api/`）与 `3600s`（`/api/v1/events` SSE 流）；**BaoTa 边缘
  反代须 ≥ 内层最慢值 `3600s`**：站点 → 反向代理 → 配置，填 `proxy_read_timeout 3600s;` +
  `proxy_send_timeout 3600s;`（bootstrap 步骤 5），否则外层默认 60s 会先于内层返回 504——慢请求已
  完成但 UI 报失败。改任一层超时须同步全链。
- **SSE 事件流**（`GET /api/v1/events`，issue #773）：容器内 nginx 已配专属精确匹配 location
  （`proxy_buffering off; proxy_cache off;` + `3600s` 读写超时——20s `:ping` 心跳间隙不被代理掐断；
  应用层另发 `X-Accel-Buffering: no` 双侧互锁）。**BaoTa 边缘反代同样须 `proxy_buffering off;`
  且超时 ≥ `3600s`**，否则外层攒帧/掐断会让事件流延迟成批到达或直接 504。

## CD 自动化什么

每次 CI 在 `master` 上成功后自动：

1. 构建 + 推送 `server`、`frontend`、`wiki`（#784）、`autofigure`（AutoFigure sidecar，T08/T11）
   四镜像到 GHCR（`:latest` 与 `:<CI head_sha>`）；`wiki` 另推版本 tag（版本从 wiki Dockerfile
   的 `FROM` 行单源提取）。server 镜像构建期 clone researcher home 模板并经 buildx 多 context
   拷入镜像（ADR 0013：#593 模板入镜像，模板随镜像 `:sha` 版本化）。autofigure 构建源为
   `deploy/autofigure-sidecar`（vendored T08 源，**不 fetch mutable upstream**），许可/署名文件
   构建期入镜像（Dockerfile 构建期断言，缺失即 CD 红）。
2. 渲染运行时 `.env`（敏感值来自 secrets，不进 git）。
3. scp `docker-compose.deploy.yml` + `.env` → 宿主 `/www/panel/`。
4. SSH 远端：`docker login ghcr.io`（持久）→ `pull` → `up -d --remove-orphans` → `image prune` →
   健康门 `curl 127.0.0.1:18080/api/health`（30s 内非 200 即 workflow 红）。
5. 防御性 bootstrap：`/www/panel` 缺则自动创建（幂等）。

## 一次性 bootstrap（手工，仅首次）

| # | 步骤 | 说明 |
|---|------|------|
| 1 | 宿主装 Docker + compose 插件 | `docker compose version` 可用即可（CD 用 CLI 子命令）。 |
| 2 | DNS 指向 | `researcher.acautomata.top` A 记录 → 宿主公网 IP（LE HTTP-01 需先解析）。 |
| 3 | 宝塔建站点 | 网站 → 添加站点 `researcher.acautomata.top`（纯静态/反代用途，无需 PHP）。 |
| 4 | Let's Encrypt | 站点 SSL → Let's Encrypt 申请 → 开启「强制 HTTPS」。续期宝塔自动。 |
| 5 | 反代 | 站点 → 反向代理 → 目标 `http://127.0.0.1:18080`，发送域名 `$host`。**并把代理读/写超时放宽到 `3600s`**（见上方「超时分层」）。 |
| 6 | GitHub secrets | 见下表。 |

> `/www/panel` 目录无需手工预建——CD 首次会自动创建（防御性 bootstrap）。researcher home 模板
> 不再落宿主：CD 构建期 clone 并拷入 server 镜像（ADR 0013，#593），镜像 `:sha` 即模板版本。

## GitHub secrets 清单

仓库 → Settings → Secrets and variables → Actions：

| Secret | 取值 | 用途 |
|--------|------|------|
| `REMOTE_HOST` | 宿主 IP / 主机名 | SSH 目标 |
| `REMOTE_USER` | `root` | SSH 用户（宝塔以 root 跑、own docker.sock） |
| `DEPLOY_KEY` | SSH 私钥全文 | 免密登录（对应公钥预先放宿主 `/root/.ssh/authorized_keys`） |
| `GHCR_PULL_USER` | GitHub 用户名 | 宿主拉私有 GHCR |
| `GHCR_PULL_TOKEN` | classic PAT，scope `read:packages` | 宿主拉私有 GHCR（持久 login，运行时拉 OpenClaw 镜像复用） |
| `JWT_SECRET` | **≥32 字符强随机** | HS256 签名密钥（server 生产 fail-fast） |
| `LLM_API_KEY` | 面板共享 LLM key | 注入 OpenClaw 容器 |
| `CREDENTIAL_ENCRYPTION_KEYS` | base64url 32 字节 | 凭证 AES-256-GCM 密钥环 |
| ~~`AUTOFIGURE_LLM_KEY`~~（**已退役，#791**） | ~~AutoFigure 生成凭证~~ | 随 sidecar 生成链路换轨退役（config.autofigure 读取面已删，server 不再消费任何 AUTOFIGURE_* 键）；新面板级生成配置归插件 configSchema（#744 §5，票 4）。正式清退归票 6 |
| `API_DOCS_ENABLED`（可选） | `true`（默认） | OpenAPI/Swagger 文档面（`/api/docs`，#761）：admin-only（requireAuth + requireAdmin）zod 生成式文档。显式 `false` → server 不装配 docs 路由（整树 90005） |
| `RESEARCHER_REPO`（可选） | 克隆 URL | 构建机 clone home 模板（默认 `https://github.com/ACautomata/researcher.git`；模板入 server 镜像，不再落宿主） |

生成 `JWT_SECRET` 与 `CREDENTIAL_ENCRYPTION_KEYS`：

```bash
openssl rand -base64 48      # JWT_SECRET（≥32 字符，48 字节 base64 足够）
python3 -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('='))"   # CREDENTIAL_ENCRYPTION_KEYS
```

> **⚠ #341 M9 迁移注意**：旧 Django 时代的 `DJANGO_SECRET_KEY` / `DJANGO_ALLOWED_HOSTS` 两个
> secret 已被 `JWT_SECRET` 取代。**恢复 CD 自动部署前必须先在仓库
> Settings 配好新 secret**（JWT_SECRET 缺失时 server 容器拒绝启动，
> 健康门判红）。旧 secret 可删除。另注意：Django 表结构与 Prisma schema 不兼容，切换后
> panel-db 卷内旧 Django 数据**不会迁移**（spec #312「现有数据不迁移」），首启会建新表。

## 运行时 server 必需 env（fail-fast 校验，`server/src/config.ts`）

容器启动时校验，缺一即拒启动（健康门会据此判红）：

`JWT_SECRET`（≥32 字符）· `CREDENTIAL_ENCRYPTION_KEYS` ·
`LLM_API_KEY`（create 容器时 90003 前置校验）· `REDIS_URL`（compose 固定
`redis://redis:6379/0`）· `OPENCLAW_TEMPLATE_DIR`（compose 固定 `/app/templates/researcher`，
镜像内——构建期 COPY 的 researcher home 模板）·
`OPENCLAW_FLEET_ROOT`（compose 固定 `/fleet`，server 容器内工作目录，无宿主挂载）·
`DATABASE_URL`（compose 固定 `file:/app/db/db.sqlite3`，指向 panel-db 卷）。

> **`OPENCLAW_IMAGE` 不在上列**：它有缺省值（= 存量钉版 GHCR 引用，openclaw-image 派生镜像构建
> 已随 T0 #801 退役），缺省并不拒启动——但
> **生产浮动 tag（无 tag 或 `:latest`）→ 启动 fail-fast**（准据 `server/src/config.ts` 的
> `readPinnedImage`；与 `server/README.md` 同处置）。

> 说明：`OPENCLAW_TEMPLATE_DIR` 指向 **server 镜像内**路径（ADR 0013
> `#593` 模板入镜像），compose 显式 pin 到镜像内 COPY 产物。镜像外唯一的宿主数据
> 挂载是 `/var/run/docker.sock`（spec §5.4 已接受等价 root）。

> **`/fleet`（容器内工作目录，非宿主挂载）：** server 容器的 `OPENCLAW_FLEET_ROOT=/fleet` 是
> 容器私有目录——named volume 拓扑（ADR 0011/0013，#590/#592）下 OpenClaw 容器不 bind 宿主树，
> `instances/<id>/` 目录与 provision 的 cp 只落在容器内，容器重建即空、create 幂等重建。生产
> 2026-08-01 的「/fleet 缺挂载 → gateway 崩溃循环」故障属于旧 bind 时代契约（宿主 fleet 根须与
> compose 挂载同源）；挂载已删除，此故障面不再存在。

## AutoFigure 生产接线与运维（T11，docs/autofigure/tickets/T11-production-packaging-cd.md）——已换轨退役（#791）

> **已换轨退役（#791）**：本节为 sidecar 时代历史档案。server 消费端全量退役——`AUTOFIGURE_*`
> env 注入（config.autofigure 读取面删除）、`AUTOFIGURE_ENABLED` flag 门（figures 路由已无常驻
> 90005 语义）、`X-Autofigure-Api-Key` 凭证注入链均已删除；figures = 常驻读面（无 flag 门），
> 生成入口 = 会话内 figure 工具（#744 §4.1，票 4 接线）。生产 compose 的 **panel-autofigure
> 服务段暂留**（无现役消费者），`deploy/autofigure-sidecar` 目录与服务段的正式删除归票 6
>（#744 §10）；`PANEL_AUTOFIGURE_IMAGE` 覆盖位随服务段同批清退。

- **sidecar 服务段（暂留，历史形状）**：仅挂 `panel-net`、无 ports、零 host 挂载（ADR 0013）；
  `/health` 容器 healthcheck；`mem_limit: 2g`（T10/T11 judgement call）；`restart: unless-stopped`；
  内部 URL `http://autofigure:8080`。镜像管线 = CD 既有管线构建推送（`:latest` + `:<CI head_sha>`，
  构建源 `deploy/autofigure-sidecar` vendored T08 源，不 fetch mutable upstream；许可/署名文件
  构建期入镜像 + Dockerfile 断言，缺失即 CD 红）。
- **部署面注意（服务段存续期仍为真）**：autofigure 是栈内声明服务，CD 的 `docker compose
  pull`/`up` 仍会部署它——sidecar 镜像不可拉或容器 start 失败会使 CD/up 变红（与面板是否使用
  无关）。

> **验证状态**：镜像构建/推送与运行时健康行为属 CD/CI 拥有（本机无 Docker daemon）。T11 本地验证仅
> 静态（compose config 解析、YAML 结构、image/env 插值、server 回归），**不声称本地构建/推送/运行时
> 真实通过**。

## 回滚

镜像按 `:<commit sha>` 留了不可变记录，回滚 = 固定到上一个 sha 重启（home 模板已随
server 镜像构建期入镜像——回滚镜像即回滚模板，无宿主侧残留状态需要同步；AutoFigure 镜像回滚
经 `PANEL_AUTOFIGURE_IMAGE`，见上方 AutoFigure 段）：

```bash
ssh root@<REMOTE_HOST>
cd /www/panel
# 编辑 .env，把 PANEL_SERVER_IMAGE / PANEL_FRONTEND_IMAGE / PANEL_AUTOFIGURE_IMAGE 的 :latest 改成 :<上一个 sha>
docker compose -f docker-compose.deploy.yml --env-file .env up -d
```

（或在 CI 重跑对应历史 commit 的 CD。）

> 面板 fleet 的目标镜像不随部署自动切换：它钉在 server 镜像内的 `config.ts` 默认值（存量
> 版本 tag 引用）。存量容器何时/如何换到新目标由运维动作决定（升级编排已随 T0 #801 退役），
> 生产禁浮动 tag 的 fail-fast 见上方「运行时 server 必需 env」的 `OPENCLAW_IMAGE` 说明。

## 排障

```bash
ssh root@<REMOTE_HOST>
cd /www/panel
docker compose -f docker-compose.deploy.yml --env-file .env ps
docker compose -f docker-compose.deploy.yml --env-file .env logs server
docker logs panel-frontend
curl -v http://127.0.0.1:18080/api/health   # 应用层（Express 不校验 Host，无需 -H）
curl -v https://researcher.acautomata.top/api/health  # 经宝塔 TLS 全链路
```
