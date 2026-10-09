# deploy —— 面板编排契约（生产栈 + dev 栈 + 镜像构建）

本目录承载面板自管容器（会话沙箱 + wiki 容器）的**编排契约**：

- `docker-compose.deploy.yml` —— **生产栈**（frontend nginx + server + redis；
  由 CD scp 落盘宝塔宿主 `/www/panel/`）。
- `docker-compose.dev.yml` —— **dev 栈**（server+redis 容器化，与 prod 同形态，issue #594 / ADR 0013）。
- `.env.example` —— 生产栈环境变量模板（`LLM_API_KEY` / `LLM_CREDENTIAL_SECRET` / `JWT_SECRET` 等；真实 `.env` 经 CD 渲染，
  不进版本库）。
- `wiki-image/` —— wiki 容器镜像构建源（#784，busybox 级 + 零初始化）。

> **#858 OpenClaw 退役③**：openclaw-gw fleet 编排整链退役（容器 REST/管理页/容器行表、home 模板
> provisioning、`GATEWAY_TOKEN` 凭证加密、`OPENCLAW_*` 配置面）。T0 #801 已退役的
> `openclaw.json` 模板 / `openclaw-image/` 派生镜像构建 / 端口池 / 设备配对 / bootstrap-token /
> 升级编排 / 健康探针不再赘述。现役镜像面 = 沙箱（`SANDBOX_IMAGE`）+ wiki（`WIKI_IMAGE`）两支路。

## 沙箱 / wiki 容器镜像（钉版纪律）

- **生产禁浮动 tag**：`SANDBOX_IMAGE` / `WIKI_IMAGE` 为浮动引用（无 tag 或 `:latest`）→ server
  启动 fail-fast（机器强制，准据 `isFloatingImageRef`，`readPinnedImage` 共用内核）。
  dev/test 不拦（本地调试可覆盖）。
- `WIKI_IMAGE` 见下节；`SANDBOX_IMAGE` 默认 busybox 钉版（#776）。

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

## 面板编排面（#858 后：wiki 容器 + 会话沙箱两支路）

```
Express 控制面
    │ wikiContainers/（researcher-wiki-<ownerId>，每用户一台、永久、零出网文件仓库）
    │ sandboxes/（researcher-sandbox-<sessionId>，1 session:1、闲置 30min 自动 stop）
    ▼
Docker SDK（/var/run/docker.sock）—— docker inspect Running 即活性（无探针无端口）
```

- kind 标签二值 `researcher.kind=wiki|sandbox`（#858 收敛；识别准据 `server/src/containers/kind.ts`）。
- **docker.sock 安全**：控制面挂 `/var/run/docker.sock` = 等价 root（spec §5.4 明示风险）。本地/可信
  部署可接受；生产应限制网络面或改用 rootless / 远程 TLS daemon。

## 与控制面的衔接

- 控制面配置走环境变量（`server/src/config.ts`）：`DATA_ROOT`（落盘根 = 附件上传临时区，
  生产须绝对路径 fail-fast）、`LLM_API_KEY`（平台默认端点解析根）与 `LLM_CREDENTIAL_SECRET`
  （BYOK 凭证加密根，#881）。LLM 端点 CRUD 经 `models` 域 + `config_meta` version bump 热生效（#775）。
- （#858：`OPENCLAW_TEMPLATE_DIR` / `OPENCLAW_FLEET_ROOT` / `OPENCLAW_IMAGE` /
  `CREDENTIAL_ENCRYPTION_KEYS` 随 fleet 编排退役，server 不再读取。）

## 面板 dev 栈（容器化控制面，issue #594 / ADR 0013）

dev 不再 `npm run dev` 宿主直跑控制面，改 `docker-compose.dev.yml` 起 server+redis 容器、挂
docker.sock，与 prod（`docker-compose.deploy.yml`）**同形态**——消除「宿主直跑摸不到 named
volume（卷物理路径在 Docker VM 内）→ dev/prod 寻址/路径分叉」（ADR 0012）。

```bash
# 1.（会话发消息需）LLM key；仅起控制面/登录可跳过。
export LLM_API_KEY=...

# 2. 起 dev 控制面（server:8001，挂 docker.sock + panel-dev-db 卷）
docker compose -f deploy/docker-compose.dev.yml up -d --build

# 3. 前端仍宿主 vite dev（proxy /api → 127.0.0.1:8001）
cd frontend && npm run dev

# 改 server 代码 → 重建镜像
docker compose -f deploy/docker-compose.dev.yml up -d --build server
```

- **与 prod 对齐**：`REDIS_URL`、`DATABASE_URL`、`DATA_ROOT` 逐键一致；
  仅 `NODE_ENV=development`（走 config.ts dev 分支）与「server 暴露 8001 给宿主 vite」为 dev 特有。
- **双轨工作流**：纯逻辑快速迭代仍走宿主 `cd server && npm test` / `npm run typecheck`（不起服务、
  不摸卷）；凡要起服务 / 真编排容器（沙箱/wiki 面板自管容器），一律走本容器化 dev 栈。

## AutoFigure env（#792 插件化收口——现行）

figure 生成 = server 进程内插件管线（#792 起）。键声明单源 =
`plugins/autofigure/manifest.ts` configSchema，启动期 `assertPluginEnv` 全目录校验（不看启用位）：

| 键 | 必填 | 说明 |
|----|------|------|
| `AUTOFIGURE_IMAGE_MODEL` | 是 | 生图模型名（如 image-01） |
| `AUTOFIGURE_IMAGE_API_KEY` | 是 | 生图 API key（服务端凭证） |
| `FAL_KEY` | 是 | fal 云计算 key（SAM3/RMBG） |
| `AUTOFIGURE_IMAGE_BASE_URL` | 否 | 生图 API base URL（缺省国际区 `https://api.minimax.io`） |
| `AUTOFIGURE_SVG_MODEL` | 否 | 废弃兼容 pin：优先于用户指派，设值告警；清除后使用插件 LLM 指派/默认链 |

- **生产**：三必填键写入同目录 `.env`（env_file 注入，与 `LLM_API_KEY` 同机制）——缺键 =
  server 启动期 fail-fast throw，不做静默降级。
- **dev**：`docker-compose.dev.yml` 显式列三键（`${VAR:-}` 空串安全）——缺键 = dev 警告照常
  启动，figure 工具调用期明确报错。
- 凭证纪律：env 注入、不落盘、不入日志、不进事件载荷/产物（#744 §6）。

## AutoFigure 退役（#802）

旧生成容器、vendored 源码和部署配置已删除，无数据迁移。生成由控制面插件执行，
figures 读取、PNG/SVG 下载保持原 API。历史契约见 `docs/autofigure/`。
