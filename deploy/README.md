# OpenClaw 单 main-agent 网关部署

本目录是重构后承载 OpenClaw 网关的精简单服务 compose 栈（wayfinder #9 原型）。
镜像 `acautomata/openclaw-docker-cn-im`，把 [ACautomata/researcher](https://github.com/ACautomata/researcher) 仓库作为容器 `~/.openclaw` 配置卷挂载。

## 前置

- Docker + compose plugin
- 本仓库 FastAPI 后端经 `http://127.0.0.1:18789`（或同 network 的服务名）访问网关

## 步骤

```bash
# 1. 克隆 researcher 配置仓库（本仓库根下；或设 RESEARCHER_DIR 指向它）
git clone https://github.com/ACautomata/researcher ./researcher

# 2. 精简 researcher 的 openclaw.json（不接任何 channel —— 见下「配置精简」）

# 3. 配置环境
cp deploy/.env.example deploy/.env
#    填入 GATEWAY_TOKEN（强随机）与 LLM_API_KEY

# 4. 启动
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d

# 5. 验证
docker logs -f openclaw-gateway
curl http://127.0.0.1:18789/health
```

## 配置精简（不接任何消息 channel）

researcher 的 `openclaw.json` 需做如下精简（依据 `docs/research/r8-channels-plugins.md`）：

- **删** `channels`（整个块）与 `bindings`：留 `feishu.enabled=true` 会因缺 `FEISHU_*` secret 启动失败。
- **改** `plugins.slots.contextEngine`: `"lossless-claw"` → `"legacy"`；删 `plugins.entries.lossless-claw` / `plugins.installs.lossless-claw`（或整段删 slots 让默认 legacy 生效）。
- **裁** `plugins.entries.browser`、顶层 `browser`、`plugins.entries.memory-core`（可选，非必需）。
- **留** `plugins.entries.minimax`、`plugins.entries.memory-wiki`（enabled:true）。
- **改** `gateway.bind` → `lan`（FastAPI 跨容器访问必需；已可用 env `OPENCLAW_GATEWAY_BIND` 覆盖）。
- **WS 注意**：本部署走 WebSocket（见 #13），HTTP `responses.enabled` 非必需。

## 关键点（来自 R6/R7/R8）

- 挂载：`researcher/` → `/home/node/.openclaw`（读写）；gateway 读 `/home/node/.openclaw/openclaw.json`。
- 4 个 sync flag 全关，init.sh 不覆写挂载的 openclaw.json、不明文写凭证。
- `LLM_API_KEY` 经 env 注入、SecretRef 运行时读，勿写盘。
- **token 认证始终强制**：WS 握手 `connect.params.auth.token` 必须带 `GATEWAY_TOKEN`；本部署不设 `ALLOW_INSECURE_AUTH`（其仅为本地 Control UI 便利，且即便开启 token 仍必填）。端口已收敛到 `127.0.0.1`。
- wiki 在 `/home/node/.openclaw/wiki/main`（memory-wiki 插件），宿主侧即 `./researcher/wiki/main`。
- 运行时 `state/`、`logs/` 用匿名卷，避免污染宿主 researcher git 树。

## 与本仓库后端的衔接

- 后端 `config.py` 的 `OPENCLAW_GATEWAY_URL` 指向 `http://127.0.0.1:18789`，`OPENCLAW_GATEWAY_TOKEN` = 上面的 `GATEWAY_TOKEN`。
- 后端 apply-config 写 `./researcher/openclaw.json`（env 可配），随后 `docker compose restart openclaw-gateway` 生效。
