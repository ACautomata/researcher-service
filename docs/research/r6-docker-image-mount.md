# R6 — OpenClaw Docker 镜像配置挂载契约（wayfinder ticket #6）

> 目标：搞清 `acautomata/openclaw-docker-cn-im` 镜像期望的配置挂载点与 sync 开关，
> 为「把 https://github.com/ACautomata/researcher 仓库作为容器 volume、加载到正确的
> 配置文件地址」提供事实依据。
>
> 信源可信度排序：本地浅克隆 `/tmp/researcher-probe`（ACautomata/researcher）> 上游镜像
> 源码 `justlovemaki/OpenClaw-Docker-CN-IM`（init.sh / Dockerfile / .env.example，本报告
> 已下载全文分析）> OpenClaw 官方文档 docs.openclaw.ai > Docker Hub API。
>
> 关键背景：researcher 仓库**本身就是一份 `~/.openclaw` 配置目录**（README.md:3
> 「本仓库是它的 `~/.openclaw` 配置目录」），不是 OpenClaw 运行时本体。镜像里跑的是
> OpenClaw 本体（gateway + CLI），researcher 提供 openclaw.json / workspace / wiki /
> skills 等配置内容。

---

## 1. 配置根目录的容器内绝对路径

**结论：配置根（OpenClaw home）是 `/home/node/.openclaw`。已证实。**

依据：
- 上游 init.sh 第 5 行：`OPENCLAW_HOME="/home/node/.openclaw"`（硬编码默认值）。
- researcher compose 把整个数据目录 bind-mount 到该路径：
  `docker/docker-compose.bench.yml:64` → `- ${OPENCLAW_DATA_DIR}:/home/node/.openclaw`。
- env_setup.sh 反复以 `/home/node/.openclaw` 为配置根：`BENCH_MOUNT="/home/node/.openclaw"`
  （env_setup.sh:650, 664, 694），「copy repo into ${CONTAINER}:/home/node/.openclaw」
  （env_setup.sh:640）。
- 镜像内进程以 `node` 用户运行（`gosu node`，init.sh:2439），`HOME=/home/node`
  （Dockerfile:65,105；compose environment HOME=/home/node）。
- OpenClaw 官方文档同样把 `$HOME/.openclaw` 作为默认配置根，容器内即
  `/home/node/.openclaw`（docs.openclaw.ai/install/docker）。

补充：配置根可被 `OPENCLAW_HOME` 覆盖（官方文档），但该 fork 镜像 init.sh:5 把它写死为
`/home/node/.openclaw`；不要改，沿用默认即可。

---

## 2. openclaw.json 的读取路径与子目录布局

**结论：gateway 从 `$OPENCLAW_HOME/openclaw.json` = `/home/node/.openclaw/openclaw.json`
读取主配置。workspace / wiki / skills / extensions / auth-profiles 均相对于该根布局。**

依据（init.sh + researcher openclaw.json + 官方文档）：

- **openclaw.json 路径**：init.sh `sync()` 默认 `CONFIG_FILE=/home/node/.openclaw/openclaw.json`
  （init.sh:2134）；`ensure_base_config` 写 `$OPENCLAW_HOME/openclaw.json`（init.sh:225）。
  可用 `OPENCLAW_CONFIG_PATH` 覆盖（官方文档），bench 未用。
- **workspace**：`OPENCLAW_WORKSPACE = ${OPENCLAW_WORKSPACE_ROOT}/workspace`
  （init.sh:6-8），`OPENCLAW_WORKSPACE_ROOT` 默认 `$OPENCLAW_HOME`（init.sh:6），
  researcher compose 显式设 `OPENCLAW_WORKSPACE_ROOT=/home/node/.openclaw`
  （compose:44, env_setup.sh:579）→ 实际 workspace = `/home/node/.openclaw/workspace`。
  researcher openclaw.json 里 main agent 的 `"workspace": "~/.openclaw/workspace"`
  （openclaw.json:78）与此一致。researcher 仓库根本身就含 `workspace/` 目录。
- **wiki**：由 memory-wiki 插件管理，researcher openclaw.json 配
  `"vault.path": "~/.openclaw/wiki/main"`（openclaw.json:178）→
  `/home/node/.openclaw/wiki/main`。researcher 仓库根含 `wiki/` 目录。
- **skills**：插件/扩展 skills 在 `$OPENCLAW_HOME/extensions`（init.sh
  `sync_seed_extensions` 的 `target_dir="$OPENCLAW_HOME/extensions"`）；workspace 级 skills
  在 `$OPENCLAW_WORKSPACE/skills`（init.sh:2410 agent-reach 同步目标
  `$OPENCLAW_WORKSPACE/skills/agent-reach`）。
- **extensions**：`/home/node/.openclaw/extensions`（init.sh `sync_seed_extensions`；
  researcher openclaw.json:219 `installPath: /home/node/.openclaw/extensions/lossless-claw`）。
- **auth-profiles**：官方文档 `/home/node/.openclaw/agents/<agentId>/agent/auth-profiles.json`；
  另有本地加密 key 目录 `/home/node/.config/openclaw`（官方文档；init.sh
  `ensure_config_persistence` 把 `/home/node/.config` 链到 `$OPENCLAW_HOME/.config`）。
  researcher `.gitignore` 排除 `agents/*/agent/auth-profiles.json`（README.md:146）。
- **其它运行时子目录**（gateway 自维护，bench 不入库）：`state/openclaw.sqlite`
  （env_setup.sh:369, 501）、`logs/stability/...`（compose healthcheck:73）、
  `agents/<id>/sessions`（env_setup.sh:357, 388 显式 mkdir）。

布局总览（容器内）：
```
/home/node/.openclaw/            ← OpenClaw home（researcher 仓库根挂到这里）
├── openclaw.json                ← 主配置（gateway 读这里）
├── workspace/                   ← agent workspace（OPENCLAW_WORKSPACE）
├── wiki/main/                   ← memory-wiki vault
├── extensions/                  ← 内置/安装扩展（seed 同步目标）
├── agents/<agentId>/agent/      ← auth-profiles.json / models.json（secret，gitignored）
├── skills/、workspace/skills/   ← skills
├── state/openclaw.sqlite        ← gateway 状态库（运行时生成）
├── logs/                        ← gateway 日志
└── .config → /home/node/.config ← 加密 key（init.sh 软链）
```

---

## 3. init.sh 启动时覆盖/同步哪些配置 + 如何禁用

**结论：init.sh 入口点（ENTRYPOINT = `/bin/bash /usr/local/bin/init.sh`，Dockerfile:123）
的 `main()` 按序执行（init.sh:2465-2479）：**

```
ensure_directories → ensure_config_persistence → fix_permissions_if_needed
→ sync_seed_extensions → install_agent_reach → sync_config_with_env
→ finalize_permissions → print_runtime_summary → setup_runtime_env
→ install_signal_traps → start_gateway → wait_for_gateway
```

其中**会写盘/覆盖**的步骤及其开关：

| 步骤 | 默认行为 | 关闭开关 | 证据 |
|---|---|---|---|
| `ensure_config_persistence` | 把 `/home/node/.config` 持久化/软链到 `$OPENCLAW_HOME/.config`（不动 openclaw.json） | 无（仅建链） | init.sh:55 |
| `sync_seed_extensions` | 把镜像 seed 扩展 `/home/node/.openclaw-seed/extensions` 同步进 `$OPENCLAW_HOME/extensions` | `SYNC_OPENCLAW_CONFIG=false` **或** `SYNC_EXTENSIONS_ON_START=false`；模式由 `SYNC_EXTENSIONS_MODE` 控制（`missing`/`overwrite`/`seed-version`，默认 `seed-version`） | init.sh `sync_seed_extensions`（grep 输出）|
| `install_agent_reach` + workspace skills 同步 | 把 workspace 父目录的 `skills/agent-reach` 移入 `$OPENCLAW_WORKSPACE/skills/agent-reach`（**会 `cp -af` 覆盖并 `rm -rf` 源**） | 仅当 `$OPENCLAW_WORKSPACE/../skills/agent-reach` 存在才触发 | init.sh:2405-2419 |
| `sync_config_with_env`（**核心**） | 读 openclaw.json → 用 env 重写 models/channels/gateway/agent/tools → **`json.dump` 覆写 openclaw.json**（init.sh:2156-2157） | `SYNC_OPENCLAW_CONFIG=false` 整体跳过；`SYNC_MODEL_CONFIG=false` 仅跳过模型段 | init.sh:2136-2138, 1374-1383 |

**关键安全性质（决定能否 bind-mount 进自己的 openclaw.json）：**

1. `ensure_base_config` 只在 openclaw.json **不存在**时写骨架：`if [ -f "$config_file" ]; then return; fi`
   （init.sh:227-229）。已存在的 openclaw.json **不会**被骨架覆盖。
2. `sync()`（覆写 openclaw.json 的唯一地方）在 `SYNC_OPENCLAW_CONFIG=false` 时**第一行就 return**：
   ```python
   if not is_openclaw_sync_enabled(os.environ):
       print('ℹ️ 已关闭整体配置同步，跳过所有环境变量同步逻辑')
       return
   ```
   （init.sh:2136-2138）。因此 bind-mount 进去的 openclaw.json **原样保留**，gateway 直接采用。
3. `SYNC_MODEL_CONFIG=false` 是子开关：即便整体 sync 开，也跳过模型段（init.sh:1383）。
   researcher 关掉它是为了让 init.sh **不把 `API_KEY` 明文写进
   `models.providers.default`**（compose:23-36 注释明确说明），改用 openclaw.json 里的
   SecretRef（`{"source":"env","id":"LLM_API_KEY"}`，env_setup.sh:277, 431）在运行时从进程
   env 读 key。

**researcher 实际用的关闭组合（compose:28-31, env_setup.sh:567-569）：**
```
SYNC_OPENCLAW_CONFIG=false      # 总开关：跳过所有 env→config 覆写 + seed 扩展同步
SYNC_EXTENSIONS_ON_START=false  # 双保险：关 seed 扩展同步
SYNC_EXTENSIONS_MODE=none       # 双保险：模式设为 none
SYNC_MODEL_CONFIG=false         # 双保险：不写明文模型/凭证
```

注意：researcher compose 的 `container` 运行时分支只传了 `SYNC_EXTENSIONS_MODE=none`
（env_setup.sh:216），没传 `SYNC_OPENCLAW_CONFIG=false`——但 docker 分支通过
`.bench-runtime/.env.bench`（env_setup.sh:567-569）把四个 sync flag 全设为 false。compose
栈应沿用 docker 分支的完整四开关。

**风险残留（即便 sync 全关仍需注意）：**
- `install_agent_reach` 的 workspace-skills 同步（init.sh:2405-2419）**不受 SYNC flag 控制**，
  只要 `/home/node/.openclaw/skills/agent-reach`（即 workspace 父目录 = 配置根下的 skills/）
  存在就会移动它。researcher 仓库根的 `skills/` 若含 agent-reach 会被改写。researcher 的
  `bench_tar_repo`（env_setup.sh:330-340）打包时排除了 `extensions` 等目录，规避了部分此类
  副作用。bind-mount 整仓库时应确认仓库根 `skills/agent-reach` 是否存在。
- `finalize_permissions` 以 root 运行时 `chown -R node:node $OPENCLAW_HOME`（init.sh:2459-2463）
  会改 bind-mount 内容的属主——macOS virtiofs 上通常无害，Linux 上会把宿主文件改成 uid 1000。

---

## 4. 必需/常用环境变量

**结论（按用途分组，含默认值与证据）：**

### Gateway 绑定/认证（裸启动必填）
| 变量 | 默认 | 说明 | 证据 |
|---|---|---|---|
| `OPENCLAW_GATEWAY_PORT` | `18789` | gateway 端口；EXPOSE 18789 | init.sh:2081, Dockerfile:117 |
| `OPENCLAW_GATEWAY_BIND` | `lan`（上游 .env.example:199）/ sync 时写 `0.0.0.0`（init.sh:2082） | researcher compose 强制 `loopback`（compose:49）。**只接受字面量 `loopback/lan/tailnet/auto/custom`，不收裸 IP**（compose:46-47 注释） | compose:49, init.sh:2082 |
| `OPENCLAW_GATEWAY_MODE` | `local` | 运行模式 | init.sh:2083, .env.example:201 |
| `OPENCLAW_GATEWAY_TOKEN` | 上游必填（.env.example:198） | **上游 init.sh 只认这个名**（init.sh:2077, 2092, 2445），`start_gateway --token` 直接传它 | init.sh:2445 |
| `GATEWAY_TOKEN` | researcher 用 | **fork 差异**：researcher compose 注入 `GATEWAY_TOKEN`（compose:55），靠 openclaw.json 里 `"token": "${GATEWAY_TOKEN}"`（openclaw.json:26）由 gateway 进程做 env 插值，而非 init.sh。因 sync 全关，init.sh 不写 token，gateway 启动时自己解析 `${GATEWAY_TOKEN}` | compose:52-55, openclaw.json:26 |
| `OPENCLAW_GATEWAY_ALLOW_INSECURE_AUTH` | researcher 设 `true` | 允许 loopback 免配对（仅本地便利，勿暴露公网） | compose:51 |

> **Token 机制要点**：sync 关闭时，init.sh 不会把 token 写进 openclaw.json，但
> `start_gateway` 仍执行 `--token "$OPENCLAW_GATEWAY_TOKEN"`（init.sh:2445）。researcher 没
> 设 `OPENCLAW_GATEWAY_TOKEN`，改为在 openclaw.json 用 `${GATEWAY_TOKEN}` 占位符 + 注入
> `GATEWAY_TOKEN` env。compose 注释「GATEWAY_TOKEN is required at startup even with
> insecure-auth on」（compose:52-54）。**compose 栈两选一**：要么注入 `OPENCLAW_GATEWAY_TOKEN`
> 让 `--token` 生效，要么注入 `GATEWAY_TOKEN` 并在 openclaw.json 用 `${GATEWAY_TOKEN}`。
> researcher 走后者，建议沿用同名 `GATEWAY_TOKEN` 以复用其 openclaw.json。

### LLM 凭证（gateway 调模型必需）
| 变量 | 说明 | 证据 |
|---|---|---|
| `LLM_API_KEY` | **必填**，fail-fast（env_setup.sh:47-49）。researcher 不写进 `.env.bench` 文件（防 artifact 泄漏，env_setup.sh:585-593），运行时经 SecretRef 从进程 env 读 | env_setup.sh:47, 277, 585-593 |
| `LLM_BASE_URL` | 默认 `https://api.minimaxi.com/anthropic` | env_setup.sh:50 |
| `LLM_MODEL` | 默认 `minimax/MiniMax-M2.7`，须 `provider/model` 形式 | env_setup.sh:52, 425-428 |

### 运行时环境（researcher compose 显式设置）
`TZ=Asia/Shanghai`、`HOME=/home/node`、`TERM=xterm-256color`、`NODE_ENV=production`、
`LANG/LANGUAGE/LC_ALL=en_US.UTF-8`（compose:16-22；与 Dockerfile:105-114 一致）。

### 路径/挂载
| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCLAW_WORKSPACE_ROOT` | `$OPENCLAW_HOME` = `/home/node/.openclaw` | workspace 父目录；实际 workspace = `${此值}/workspace`（init.sh:6-8） |
| `OPENCLAW_CONFIG_PATH` / `OPENCLAW_HOME` / `OPENCLAW_STATE_DIR` | 见 §1/§2 | 高级覆盖路径，bench 未用（README.md:152） |

### 通道（researcher 全禁，避免 gateway 外拨）
`DM_POLICY=disabled`、`GROUP_POLICY=disabled`、`ALLOW_FROM=""`（compose:40-42）。
feishu/discord 等 channel 还需在 openclaw.json 里 `enabled=false`（env_setup.sh:252-270 的
patch 逻辑），否则 gateway 启动要求对应 SecretRef（FEISHU_APP_SECRET 等）而失败。

### 其它 researcher 用到
`OPENCLAW_PLUGINS_ENABLED`（默认 `false`，ClawProBench 研究场景设 `true` 以加载 memory-wiki
插件 wiki_apply/wiki_search；compose:56-62, env_setup.sh:580-584）、
`OPENCLAW_SANDBOX_MODE=off`（.env.example:216；researcher patch 也设 `agents.defaults.sandbox.mode=off`，
env_setup.sh:297）。

---

## 5. 可公开获取的 tag/digest

**结论：`acautomata/openclaw-docker-cn-im` 在 Docker Hub 真实存在（repository ID 30519967），
`:latest` 与 `:2026.7.1`、`:main-3c68ead` 同 digest。本机无 docker，以下 digest 来自 Docker Hub
Registry API v2，未经 `docker manifest inspect` 复核。**

| Tag | Digest (manifest list) |
|---|---|
| `latest` | `sha256:d66052d90733e2c054b71e32be066ade802f870bedac7a31ebaf13cd61af2624` |
| `main-3c68ead` | 同上（= latest） |
| `2026.7.1` | 同上（= latest） |
| `2026.6.5` / `main-cd7de75` | `sha256:676370794da98f6bf553fc575cc924ea9353b7c8825310abdcd7b13a741f1e15` |
| `2026.6.1` / `main-e6b51bc` | `sha256:1b6cadb7eb82f27c1522b011c847d269494dad0e0826225a70fe93a582020869` |

（amd64 镜像层 digest for latest = `sha256:9028dbe5...`，来源 Docker Hub API。）

**与 researcher benchmark 用法的对应关系：**
- researcher 默认镜像 = `acautomata/openclaw-docker-cn-im:latest`
  （env_setup.sh:56 `IMAGE=...:-acautomata/openclaw-docker-cn-im:latest}`；
  `.env.bench.example:16` 注释 `# OPENCLAW_IMAGE=acautomata/openclaw-docker-cn-im:latest`）。
- `:latest` = `:2026.7.1`。env_setup.sh 多处注释直接引用「OpenClaw 2026.7.1」的行为
  （feishu 插件自动安装 env_setup.sh:248、sqlite 损坏恢复 env_setup.sh:490），与 latest 对齐。
- 该镜像 fork 自上游 `justlikemaki/openclaw-docker-cn-im`（GitHub
  `justlovemaki/OpenClaw-Docker-CN-IM`），是中国优化版（预装飞书/钉钉/QQ/企微/微信 IM 插件）。
- **未能确认**：本机无 docker，`docker manifest inspect` / `docker pull` 未执行；digest 以
  Docker Hub API 为准。生产建议 pin digest 而非浮动 `:latest`。

---

## 6. 最终结论（挂载契约）

**应把 researcher 仓库根 bind-mount 到 `/home/node/.openclaw`，并设 4 个 sync flag 为关闭。**

- **挂载点**：`researcher_repo_root → /home/node/.openclaw`（读写）。researcher 仓库根 =
  一份完整 OpenClaw home（含 openclaw.json + workspace/ + wiki/ + skills/），挂载后
  `/home/node/.openclaw/openclaw.json` 即 researcher 的 openclaw.json。
- **为何不被 init 覆盖**：`SYNC_OPENCLAW_CONFIG=false` 让 `sync()` 在覆写 openclaw.json 之前
  就 return（init.sh:2136-2138）；`ensure_base_config` 见文件已存在即跳过（init.sh:227-229）。
  因而 gateway 原样采用 researcher 的 openclaw.json。
- **为何不明文写凭证**：`SYNC_MODEL_CONFIG=false`（双保险之一）阻止 init.sh 把 `API_KEY`
  写进 `models.providers.default`；改用 openclaw.json 内 SecretRef 在运行时读进程 env 的
  `LLM_API_KEY`。
- **token**：注入 `GATEWAY_TOKEN`，researcher openclaw.json 已用 `${GATEWAY_TOKEN}` 占位。
- **凭证注入**：`LLM_API_KEY`（+可选 `LLM_BASE_URL`/`LLM_MODEL`）经进程 env 传入，
  不写盘。

---

## 对 compose 栈的直接影响

**建议的 volume 挂载：**
```yaml
volumes:
  - /path/to/researcher-repo:/home/node/.openclaw   # researcher 仓库根 → OpenClaw home
```
（单挂载即覆盖 openclaw.json / workspace / wiki / skills。若担心 gateway 运行时写入
state/logs/.config 污染宿主仓库，可再加匿名卷或独立挂载覆盖 `/home/node/.openclaw/state`
与 `/home/node/.openclaw/logs`，以及 `/home/node/.config/openclaw`。researcher bench 的做法
是**先 tar 拷贝仓库到独立 data_dir 再 mount 那个 data_dir**（env_setup.sh:342-372），而非直接
mount 仓库——这样既避免污染 git 树，又规避 agent-reach 移动 skills 的副作用；compose 栈若直接
mount 仓库需自行权衡。）

**env 清单（核心，对齐 researcher compose）：**
```yaml
environment:
  HOME: /home/node
  TZ: Asia/Shanghai
  NODE_ENV: production
  LANG: en_US.UTF-8
  LANGUAGE: en_US:en
  LC_ALL: en_US.UTF-8
  # --- 关闭 init 同步（关键，防覆盖 openclaw.json / 防明文写凭证） ---
  SYNC_OPENCLAW_CONFIG: "false"
  SYNC_EXTENSIONS_ON_START: "false"
  SYNC_EXTENSIONS_MODE: "none"
  SYNC_MODEL_CONFIG: "false"
  # --- LLM 凭证（运行时 SecretRef 读，勿写盘） ---
  LLM_API_KEY: ${LLM_API_KEY}
  LLM_BASE_URL: ${LLM_BASE_URL:-https://api.minimaxi.com/anthropic}
  # --- Gateway 绑定 ---
  OPENCLAW_GATEWAY_PORT: "18789"
  OPENCLAW_GATEWAY_BIND: loopback          # 字面量，非 IP
  OPENCLAW_GATEWAY_MODE: local
  OPENCLAW_GATEWAY_ALLOW_INSECURE_AUTH: "true"
  GATEWAY_TOKEN: ${GATEWAY_TOKEN}          # openclaw.json 用 ${GATEWAY_TOKEN} 占位
  # --- Workspace ---
  OPENCLAW_WORKSPACE_ROOT: /home/node/.openclaw
  # --- 通道全禁（避免 gateway 外拨/求 SecretRef） ---
  DM_POLICY: disabled
  GROUP_POLICY: disabled
  ALLOW_FROM: ""
```

**需禁用的 sync flag（必须全设，缺一不可作为双保险）：**
- `SYNC_OPENCLAW_CONFIG=false` —— 主开关，单独即可同时阻止 openclaw.json 覆写 + seed 扩展同步。
- `SYNC_MODEL_CONFIG=false` —— 阻止写明文模型/凭证段。
- `SYNC_EXTENSIONS_ON_START=false` + `SYNC_EXTENSIONS_MODE=none` —— 阻止 seed 扩展目录同步。

**端口绑定建议**：宿主机侧 `127.0.0.1:18789:18789`（compose:66 用 `${DOCKER_BIND:-127.0.0.1}`），
因 `controlUi.allowInsecureAuth=true` 是 admin 面，勿暴露公网（README.md:109）。

**其它注意**：
- 以 root（`user: 0:0` + cap CHOWN/SETUID/SETGID/DAC_OVERRIDE）运行便于 init.sh chown；
  researcher compose:9-14 即如此。gateway 实际进程会被 init.sh 降权到 `node`（uid 1000）。
- 仓库根若含 `skills/agent-reach`，init.sh:2405-2419 会把它移动到 workspace/skills 并删源——
  mount 前确认或改用「拷到 data_dir 再 mount」的隔离方式。
- macOS Docker Desktop（virtiofs）上，bind-mount 里的 `state/openclaw.sqlite` 可能损坏导致
  「disk I/O error」；researcher 的对策是删除该 sqlite 再重启（env_setup.sh:369, 490-507）。
  建议 mount 前清空宿主仓库的 `state/`。

---

## 附：未能确认 / 需复核项

- 本机无 docker，`acautomata/openclaw-docker-cn-im` 各 tag digest 来自 Docker Hub Registry API，
  未经 `docker manifest inspect` 复核；生产请 pin digest。
- `GATEWAY_TOKEN` vs `OPENCLAW_GATEWAY_TOKEN` 的确切优先级在 **acautomata fork** 的 init.sh 中
  未直接验证（本报告分析的是上游 `justlovemaki` 的 init.sh，它只认 `OPENCLAW_GATEWAY_TOKEN`）。
  researcher 用 `GATEWAY_TOKEN` + openclaw.json `${GATEWAY_TOKEN}` 占位符的机制推断自其
  compose/openclaw.json，且与「sync 全关 → init 不写 token → gateway 进程自行 env 插值」自洽。
  建议起容器后用 `openclaw gateway status` + 一次 Dashboard 登录实测确认 token 生效。
- 上游 init.sh 版本为 `main` 分支（lastTouchedVersion 2026.2.14），而镜像 latest=2026.7.1；
  acautomata fork 的 init.sh 可能与上游 main 存在版本差。核心 sync 开关语义已由 researcher
  实际用法（四 flag 全关 → openclaw.json 不被覆盖）交叉证实，结论稳健。
