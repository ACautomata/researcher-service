# OpenClaw 单 main-agent 网关部署

本目录是重构后承载 OpenClaw 网关的精简单服务 compose 栈（wayfinder #9 原型）。
镜像 `acautomata/openclaw-docker-cn-im`，把 [ACautomata/researcher](https://github.com/ACautomata/researcher) 仓库作为容器 `~/.openclaw` 配置卷挂载。

**配置单一来源在本仓库**：`deploy/openclaw.json` 是精简版配置，compose 把它单独 bind-mount 覆盖 researcher 的同名文件。researcher 仓库**不动**（其 workspace/、wiki/、skills/ 仍照常挂载）。

## 前置

- Docker + compose plugin
- 本仓库 FastAPI 后端经 `http://127.0.0.1:18789`（或同 network 的服务名）访问网关

## 步骤

```bash
# 1. 克隆 researcher 配置仓库（本仓库根下；或设 RESEARCHER_DIR 指向它）
#    提供 workspace/ + wiki/ + skills/；其 openclaw.json 会被本目录的覆盖，无需手改
git clone https://github.com/ACautomata/researcher ./researcher

# 2. 配置环境
cp deploy/.env.example deploy/.env
#    填入 GATEWAY_TOKEN（强随机）与 LLM_API_KEY

# 3. 启动
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d

# 4. 验证
docker logs -f openclaw-gateway
curl http://127.0.0.1:18789/health
```

## 配置精简（不接任何消息 channel）

`deploy/openclaw.json` 已是精简好的版本，compose 挂载覆盖 researcher 的同名文件。相对 researcher 原始配置的精简点（依据 `docs/research/r8-channels-plugins.md`）：

- **删** `channels`（整个块）与 `bindings`：留 `feishu.enabled=true` 会因缺 `FEISHU_*` secret 启动失败。
- **改** `plugins.slots.contextEngine`: `"lossless-claw"` → `"legacy"`；删 `plugins.entries.lossless-claw` / `plugins.installs.lossless-claw`。
- **留** 顶层 `browser` + `plugins.entries.browser`、`plugins.entries.memory-core`、`plugins.entries.minimax`、`plugins.entries.memory-wiki`（enabled:true）。
- **改** `gateway.bind` → `lan`：FastAPI 在宿主/邻容器经 18789 访问网关必需（`loopback` 时 Docker 端口映射不到容器内 loopback）。sync 全关后 env 覆盖不可靠，故直接写进 JSON。
- **改** `gateway.controlUi.allowInsecureAuth` → `false`：token 认证始终强制，关掉 Control UI 的 insecure-auth 降级路径。
- **WS 注意**：本部署走 WebSocket（见 #13），HTTP `responses.enabled` 非必需。

## 关键点（来自 R6/R7/R8）

- 挂载：`${RESEARCHER_DIR:-../researcher}` → `/home/node/.openclaw`（读写）；`deploy/openclaw.json` → `/home/node/.openclaw/openclaw.json`（覆盖）。gateway 读 `/home/node/.openclaw/openclaw.json`。**相对路径解析基准 = 本目录（deploy/）**，故仓库根的 researcher 默认写作 `../researcher`；若默认写成 `./researcher` 会解析成 `deploy/researcher`（不存在时 compose 自建空目录，导致 workspace/wiki/skills 全缺失）。
- 4 个 sync flag 全关，init.sh 不覆写挂载的 openclaw.json、不明文写凭证。
- `LLM_API_KEY` 经 env 注入、SecretRef 运行时读，勿写盘。
- **token 认证始终强制**：WS 握手 `connect.params.auth.token` 必须带 `GATEWAY_TOKEN`。容器不设 `ALLOW_INSECURE_AUTH` env（该镜像也未读它），且 `deploy/openclaw.json` 已把 `controlUi.allowInsecureAuth` 置 `false`，彻底关闭 insecure-auth 降级路径。端口收敛到 `127.0.0.1`。
- wiki 在 `/home/node/.openclaw/wiki/main`（memory-wiki 插件），宿主侧即 `./researcher/wiki/main`。
- 运行时 `state/`、`logs/` 用匿名卷，避免污染宿主 researcher git 树。

## 与本仓库后端的衔接

- 后端 `config.py` 的 `OPENCLAW_GATEWAY_URL` 指向 `http://127.0.0.1:18789`，`OPENCLAW_GATEWAY_TOKEN` = 上面的 `GATEWAY_TOKEN`。
- 后端 apply-config 写 `RESEARCHER_CONFIG_PATH`（默认 `./deploy/openclaw.json`，即本目录这份精简配置，env 可配），随后 `docker compose restart openclaw-gateway` 生效。
