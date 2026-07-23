# R27 — 多 OpenClaw 容器管理面板的编排契约（issue #27）

> 目标：为「运行时可增删多个 OpenClaw 容器、每容器独立 wiki 与 model 配置」的管理面板，设计一套
> 供 **Django + Docker SDK（docker-py）控制面**实现的编排契约。
>
> 现状基线：单容器栈 `deploy/docker-compose.yml` 把宿主 `./researcher` bind-mount 到容器
> `/home/node/.openclaw`，并用 `deploy/openclaw.json` 单独挂载覆盖其中同名文件；端口
> `127.0.0.1:18789:18789`，bind=lan，GATEWAY_TOKEN 认证。挂载契约见 R6，wiki 落盘见 R7，
> WS 接入见 R13。本报告把这套单容器契约推广到 N 个动态容器。
>
> 标注约定：
> - **[事实]** = 可查证，给出信源（仓库代码 / docker-py 官方文档 / OpenClaw 官方文档）。
> - **[决策]** = 设计选择，给出推荐 + 备选 + 取舍。
> - **[待实测]** = 文档/源码未给出确定答案，需起容器或起 Django 后实测。

---

## 0. 核心结论速览（先看这里）

**推荐契约一句话**：每容器 = 一个 Docker 命名卷（named volume）作为 `~/.openclaw`，由控制面从「共享
只读模板目录」**首次启动前预填充**（init container / 控制面 copy），运行期容器独写自己的卷；宿主集中
布局 `…/instances/<name>/{openclaw.json}` 作为**每容器唯一可写配置层**单独 bind-mount 覆盖；
`openclaw.json` 由 Django 侧 Jinja 模板渲染（单一来源在 Django DB）；端口只在宿主侧分配
（容器内统一 18789，靠 Docker 网络命名空间天然隔离，规避 browser 派生端口冲突）；控制面用 docker-py
按 **label** 过滤管理生命周期，删除时 `remove(v=True)` 连匿名卷一起清。

> 关键判断：**不选「每容器独立 git clone researcher」**——git clone 是给「人改配置」用的，面板场景
> 配置由 Django 模板生成，researcher 的 workspace/wiki/skills 骨架是**只读种子**，多容器共享一份只读
> 模板 + 每容器一个可写命名卷即可，避免 N 份 git 树、N 倍磁盘、N 次 clone。

---

## 1. 每容器独立 researcher 配置卷的供给方式

### 1.1 问题分解

单容器契约里，`researcher` 仓库根是「一份完整 OpenClaw home」：`openclaw.json` + `workspace/` +
`wiki/` + `skills/`（R6 §2）。多容器时，这四类内容**读写属性不同**，必须拆开对待：

| 内容 | 单容器来源 | 多容器下的读写性 | 能否共享 |
|---|---|---|---|
| `openclaw.json` | 本仓库 `deploy/openclaw.json` 覆盖 | **每容器独立**（独立 model/wiki 路径/token） | 否，须每容器一份 |
| `workspace/`、`wiki/`、`skills/` 骨架 | researcher 仓库根 | **骨架只读**（种子）；运行期 agent 往 `workspace/`、`wiki/main/` 写 | 骨架可共享，写入须隔离 |
| `state/`、`logs/` | 匿名卷 | **每容器运行时私有** | 否（R6：sqlite 不可共享） |

**[事实]** `state/openclaw.sqlite` 是 gateway 状态库，bind-mount 共享会导致多容器写同一 sqlite；
R6 已用匿名卷隔离（compose:62）。**[事实]** wiki 写入目录 = 容器内 `/home/node/.openclaw/wiki/main`，
memory-wiki 插件直写 markdown（R7 §2.1）。**[事实]** OpenClaw 官方要求多实例「unique
`agents.defaults.workspace`」「unique `OPENCLAW_STATE_DIR`」，共享会 config/state/port 冲突
（docs.openclaw.ai/gateway/multiple-gateways）。

### 1.2 三个候选方案

**方案 A —— 共享只读模板 bind-mount + 每容器可写命名卷叠加（推荐）**

```
宿主：
  /srv/openclaw/template/researcher/     ← git clone 一次，只读种子（workspace/wiki/skills 骨架）
  /srv/openclaw/instances/<name>/
      openclaw.json                      ← Django 渲染，每容器唯一（单独 bind-mount 覆盖）

Docker 命名卷（docker volume create openclaw-home-<name>）：
  容器内挂到 /home/node/.openclaw        ← 每容器可写 home
```

挂载叠加（docker-py `volumes` dict，**顺序：先命名卷，再只读模板，再配置覆盖**）：

```python
volumes = {
    # 1. 每容器可写 home（命名卷，生命周期随容器）
    f"openclaw-home-{name}": {"bind": "/home/node/.openclaw", "mode": "rw"},
    # 2. 只读模板提供 workspace/wiki/skills 骨架（首次由控制面预填充进命名卷，见 §1.3）
    # 3. 每容器配置覆盖（配置单一来源 = Django 渲染产物）
    f"/srv/openclaw/instances/{name}/openclaw.json":
        {"bind": "/home/node/.openclaw/openclaw.json", "mode": "ro"},
    # 4. 运行时 state/logs 用每容器匿名卷，隔离 sqlite
    #    （命名卷已是 rw home，state/logs 直接落在命名卷内即可，无需再叠匿名卷）
}
```

**取舍**：磁盘最省（骨架一份），wiki/workspace 写入经命名卷天然隔离；模板升级（researcher 仓库
git pull）只改一处。**代价**：需一次「预填充」步骤把模板骨架拷进每个新命名卷（§1.3）。

**方案 B —— 每容器独立 git clone（备选，不推荐）**

每容器 `git clone researcher → /srv/openclaw/instances/<name>/researcher`，整体 bind-mount 到
`/home/node/.openclaw`。

**取舍**：实现最直白（与单容器完全同构），但 N 容器 = N 份 git 树、N 倍磁盘、N 次 clone；且
researcher 的 `state/`、`logs/` 会污染各自的 git 树（R6 风险残留原样放大 N 倍）；模板升级要 N 次 pull。
仅在「每容器需要完全不同 researcher 分支/版本」时才值得。

**方案 C —— 每容器把模板烤进镜像 / init container 拷贝（备选）**

构建期 `COPY researcher /home/node/.openclaw-seed`，运行期 init 把 seed 拷进命名卷。

**取舍**：彻底解耦宿主文件系统，但要自建镜像（失去直接 `pull acautomata/openclaw-docker-cn-im` 的
便利），模板升级要重 build。适合后续「模板版本化发布」阶段，初版不必。

### 1.3 推荐的预填充机制（方案 A 的关键配套）

**[决策]** 新命名卷是空的，须先把「workspace/wiki/skills 骨架」填进去，否则容器内 `~/.openclaw`
缺目录。两个可查证机制：

- **Docker 命名卷的「非空容器路径初始化」行为 [事实]**：把一个**已存在内容**的容器路径挂到新空命名卷时，
  Docker 会把容器镜像里该路径的现有内容拷进卷。但本镜像 `/home/node/.openclaw` 在镜像内是空/骨架，
  researcher 内容来自 bind-mount 而非镜像，故**不能依赖**此行为拿到 researcher 骨架——需显式拷贝。
- **推荐：控制面在创建容器前，先跑一个一次性 init 容器做拷贝 [决策]**：

```python
# 用同一镜像跑一个 ephemeral 容器，把模板拷进新命名卷，退出即删
client.containers.run(
    image=IMAGE,
    command=["bash", "-c", "cp -a /template/researcher/. /home/node/.openclaw/ && chown -R 1000:1000 /home/node/.openclaw"],
    volumes={
        "/srv/openclaw/template/researcher": {"bind": "/template/researcher", "mode": "ro"},
        f"openclaw-home-{name}": {"bind": "/home/node/.openclaw", "mode": "rw"},
    },
    user="0:0", remove=True, detach=False,  # 同步跑完即弃
)
```

  或更省事：Django 直接在宿主 `cp -a template/researcher/. <卷在宿主的实际目录>`——但**[待实测]**
  命名卷宿主路径（`/var/lib/docker/volumes/<name>/_data`）不应被控制面直接写（Docker Desktop on macOS
  上该路径在 VM 内，不可达）。故**优先 init 容器拷贝**，它走容器内路径，与 Docker Desktop 兼容。

> **为什么不直接共享模板卷而省掉拷贝**：wiki/workspace 是**运行时写入**目标（agent 写 wiki/main、
> 写 workspace/oc-uploads），共享可写卷会让 N 容器写同一份 wiki——违背「每容器独立 wiki」。骨架必须
> 落到每容器私有卷里。

### 1.4 wiki 与 openclaw.json 的宿主路径布局

**[决策]** 面板/后端要读 wiki（R7 的 `_WIKI_ROOT` 直读模式）与改配置，宿主侧布局集中在一棵
`instances/` 树下，便于枚举与清理：

```
/srv/openclaw/                       ← env: OPENCLAW_FLEET_ROOT
├── template/researcher/             ← 共享只读种子（git clone ACautomata/researcher，周期 git pull）
├── openclaw.template.json.j2        ← Django 侧模板（§2）
└── instances/
    └── <name>/                      ← 每容器目录（控制面创建/删除）
        ├── openclaw.json            ← Django 渲染产物（bind-mount 覆盖进容器）
        └── meta.json                ← 控制面记账（container_id, port, token, volume, created_at…）
```

- **wiki 宿主路径**：落在命名卷内 `…/wiki/main`，**不在 `instances/<name>/` 下**（命名卷的宿主物理路径
  受 Docker 管理）。**[待实测]** 面板读 wiki 的两条路：(a) 后端**与容器共享命名卷**——后端也起一个
  只读 sidecar 挂同一命名卷读 `wiki/main`（跨容器共享卷，**只读**安全）；(b) 面板改经容器内
  gateway 的插件 API 读。**推荐 (a)**，延续 R7「直读文件系统、不依赖网关存活」的解耦原则；把
  `RESEARCHER_WIKI_ROOT` 从「单个固定路径」泛化为「按容器名解析」`…/instances/<name>/...` 或命名卷
  挂载点。**这是相对单容器契约必须改的点**（单容器写死 `./researcher/wiki/main`）。
- **openclaw.json 宿主路径**：`/srv/openclaw/instances/<name>/openclaw.json`，是**唯一被 bind-mount
  覆盖进容器的文件**（沿用单容器「配置单一来源在面板侧」的不变量）。

---

## 2. openclaw.json 的模板化生成

### 2.1 推荐：模板渲染，单一来源在 Django DB

**[决策]** `openclaw.json` 由 Django 侧模板渲染生成，**配置单一来源 = Django 数据库**（每容器的
model provider、token、端口、wiki 路径、agent 配置存 DB），渲染产物落到
`instances/<name>/openclaw.json` 再 bind-mount 进容器。容器卷**不是**配置来源，只是配置的只读投影。

**取舍**：与单容器「`deploy/openclaw.json` 是单一来源」一脉相承，但把「单一来源」从「仓库里一份静态
JSON」上移为「Django DB + 模板」，因为多容器要按实例参数化。各容器卷不做配置来源——否则面板改配置
要去改 N 个卷里的文件，违背集中管理。

**备选**：每容器卷自持 openclaw.json（Django 只初始写入一次，之后容器自治）。**否决**：面板无法可靠
回读/审计当前配置（容器可能改它），且「运行时可改 model」需穿透卷，复杂易错。

### 2.2 模板占位符（最小参数集）

**[事实]** 单容器 `deploy/openclaw.json` 已用 `${GATEWAY_TOKEN}` 占位（gateway.auth.token），靠 gateway
进程 env 插值（R6 §4 token 机制）。多容器模板需额外参数化以下字段（其余沿用精简版结构，删
channels/bindings/lossless-claw，留 browser/memory-core/minimax/memory-wiki——**[事实]** 见
test_deploy_stack.py 的精简断言）：

| 模板变量 | 落到 openclaw.json 字段 | 说明 |
|---|---|---|
| `{{ gateway_token }}` | `gateway.auth.token` | **每容器独立 token**（见下「token 策略」）；或保留 `${GATEWAY_TOKEN}` 占位 + 每容器注入同名 env |
| `{{ gateway_port }}` | `gateway.port` | **容器内固定 18789**（见 §3，无需参数化，写死即可） |
| `{{ wiki_path }}` | `plugins.entries.memory-wiki.config.vault.path` | 每容器独立：`~/.openclaw/wiki/main`（命名卷内，天然隔离；**通常无需改**，因 home 已隔离） |
| `{{ model_provider }}` / `{{ model_id }}` / `{{ model_alias }}` / `{{ context_window }}` / `{{ max_tokens }}` / `{{ base_url }}` | `models.providers.<p>` + `agents.defaults.model.primary` | 复用现有 `_infer_provider` 的 deepseek/anthropic/custom 推断（routes/openclaw.py:177） |
| `{{ llm_api_key_env_id }}` | `models.providers.<p>.apiKey.id` | SecretRef 的 env id，默认 `LLM_API_KEY`；**每容器独立 key 时参数化** |

**[决策] token 策略**：每容器独立 GATEWAY_TOKEN（面板创建时用 `secrets.token_urlsafe` 生成，存 DB，
渲染进该容器的 openclaw.json，或经 env `GATEWAY_TOKEN` 注入并保留 `${GATEWAY_TOKEN}` 占位）。
**强烈推荐「env 注入 + `${GATEWAY_TOKEN}` 占位」**——沿用 R6 已验证的机制（sync 全关后 gateway 进程
自行 env 插值），token 不落盘进 JSON，DB 里也只存一份。**取舍**：独立 token 让「删某容器」即时吊销其
访问，且一容器 token 泄漏不波及其余；代价是面板要按容器名取对应 token 才能 WS 连接（记账在 meta/DB）。

### 2.3 渲染与生效流程（替代 compose restart）

单容器用 `docker compose restart openclaw-gateway` 生效（routes/openclaw.py:210）。多容器无 compose，
改为 docker-py 重启单容器：

```python
def apply_config(name: str, new_cfg: InstanceCfg) -> None:
    rendered = render_template(new_cfg)                       # Django 模板
    write(f"{FLEET_ROOT}/instances/{name}/openclaw.json", rendered)
    client.containers.get(f"openclaw-gw-{name}").restart()    # 只重启这一个
```

**[事实]** sync 全关后 init.sh 不覆写挂载的 openclaw.json（R6 §3），restart 即生效，无需回写或
`docker cp`。**[事实]** bind-mount 是同一文件，宿主写 → 容器立即可见，restart 后 gateway 重读。

> **取舍**：`restart()` 会断进行中的 WS 会话（R13 §5.3：runId 是连接级的，断线 run 不可恢复）。面板应
> 在「容器空闲」时才 apply-config，或先提示。这是相对 compose 单容器无差别的既有约束，非多容器新增。

---

## 3. 每容器端口分配策略

### 3.1 核心事实：容器内可统一 18789，宿主侧分配

**[事实]** Docker 每容器有独立网络命名空间；端口映射是「宿主端口 → 容器端口」的 NAT
（docker-py `ports` dict，键是容器内端口，值是宿主端口或 `(host_ip, host_port)` 元组）。
**[事实]** OpenClaw 官方多实例要求「unique `gateway.port`」，但那是**同 namespace 裸跑**的约束；
官方同时明说容器方案是「clear winner」，每容器独立网络栈（zedly.ai / docs.openclaw.ai 容器建议）。

**[关键推论]** 多容器时**容器内全部监听 18789**（与镜像 EXPOSE 一致，无需改 `OPENCLAW_GATEWAY_PORT`），
只在**宿主侧分配互不冲突的映射端口**。这彻底规避了官方警告的 browser 派生端口冲突
（base+2 控制口、CDP +9..+108）——这些派生口都绑在**容器内 loopback**，不映射到宿主，N 容器各在各的
namespace 里，互不打架。**[事实]** 官方：browser 控制口「loopback only」，CDP 口从控制口范围自动分配。

### 3.2 推荐：宿主端口池 + 控制面分配记账

**[决策]** 面板维护一个宿主端口池（如 `19000–19999`），创建容器时取**最小空闲端口**，记账在
meta/DB，删除时回收。bind 统一 `127.0.0.1`（沿用单容器安全约束，Control UI 是 admin 面勿暴露公网）。

```python
def alloc_port(pool: range, used: set[int]) -> int:
    free = [p for p in pool if p not in used]
    if not free:
        raise RuntimeError("端口池耗尽")
    return min(free)

container = client.containers.run(
    ..., 
    ports={"18789/tcp": ("127.0.0.1", host_port)},   # 容器内 18789 → 宿主 127.0.0.1:host_port
)
```

**取舍**：显式分配（而非 `{"18789/tcp": None}` 让 Docker 随机）是为了**面板可预测地拼 gateway URL**
（`http://127.0.0.1:<port>`），并把端口与容器名绑定记账。**备选** Docker 随机端口（`None`）+ 创建后
`container.attrs["NetworkSettings"]["Ports"]` 回读——省去自维护池，但回读时序略繁，且重启后端口可能变
（实际 Docker 保持映射不变，**[待实测]** 重启是否保留同一宿主端口；显式分配则天然稳定）。**推荐显式
分配**，可控可测。

### 3.3 避让冲突的两条硬规则

1. **18789 宿主端口被原单容器 compose 栈占用**：面板端口池须**避开 18789**（及任何已被占用的口）。
   池起点建议 ≥ 19000。**[事实]** 单容器栈绑 `127.0.0.1:18789:18789`（compose:66）。
2. **面板容器与原 compose 栈容器同名冲突**：原栈容器名 `openclaw-gateway`（compose:16），面板容器须用
   独立命名空间，如 `openclaw-gw-<name>`，避免 `containers.get("openclaw-gateway")` 误抓。

**[待实测]** 若面板与单容器 compose 栈**共存**于同一 Docker daemon，建议给面板容器打 label
（§4.3）并按 label 过滤，天然隔离两套生命周期。

---

## 4. 容器生命周期（Django + docker-py）

### 4.1 连接与镜像

**[事实]** 连接 daemon：`docker.from_env()`（读 `DOCKER_HOST` 等 env）或
`DockerClient(base_url="unix:///var/run/docker.sock")`。Django 进程需有 docker socket 访问权
（注意：挂 `/var/run/docker.sock` 给 Django 容器 = 等价 root，**安全风险须标注**；或 Django 跑宿主）。

**[决策] 镜像 tag**：默认 `acautomata/openclaw-docker-cn-im:latest`，**生产 pin digest**。
**[事实]** R6 §5：`latest = 2026.7.1 = main-3c68ead`，digest
`sha256:d66052d9...`；浮动 tag 有漂移风险，建议 DB 存允许列表 + 默认值，创建时
`client.images.pull(image, tag=...)` 预热。多容器共用同一镜像层，磁盘不重复。

### 4.2 创建（run）的完整参数骨架

**[事实]** 以下 kwargs 均为 docker-py `containers.run()` 官方支持的键
（docker-py.readthedocs.io/en/stable/containers.html）：

```python
import docker, secrets
client = docker.from_env()

container = client.containers.run(
    image="acautomata/openclaw-docker-cn-im@sha256:d66052d9...",  # pin digest
    name=f"openclaw-gw-{name}",
    detach=True,
    user="0:0",                                   # 便于 init.sh chown；gateway 进程降权 node（R6 §4）
    cap_add=["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE"],
    environment={
        "TZ": "Asia/Shanghai", "HOME": "/home/node", "TERM": "xterm-256color",
        "NODE_ENV": "production", "LANG": "en_US.UTF-8", "LANGUAGE": "en_US:en",
        "LC_ALL": "en_US.UTF-8",
        # 4 个 sync flag 全关（防覆写挂载的 openclaw.json / 防明文写凭证）——[事实] R6 §3
        "SYNC_OPENCLAW_CONFIG": "false", "SYNC_EXTENSIONS_ON_START": "false",
        "SYNC_EXTENSIONS_MODE": "none", "SYNC_MODEL_CONFIG": "false",
        # LLM 凭证（SecretRef 运行时读进程 env，勿写盘）——[事实] R6 §4
        "LLM_API_KEY": instance_llm_key, "LLM_BASE_URL": instance_llm_base,
        # Gateway 绑定/认证 —— 容器内统一 18789 + lan（FastAPI 跨容器访问必需）
        "OPENCLAW_GATEWAY_PORT": "18789", "OPENCLAW_GATEWAY_BIND": "lan",
        "OPENCLAW_GATEWAY_MODE": "local",
        "GATEWAY_TOKEN": per_instance_token,      # 每容器独立 token（§2.2）
        "OPENCLAW_WORKSPACE_ROOT": "/home/node/.openclaw",
        "DM_POLICY": "disabled", "GROUP_POLICY": "disabled", "ALLOW_FROM": "",
        "OPENCLAW_PLUGINS_ENABLED": "true",        # memory-wiki 需
    },
    volumes={
        f"openclaw-home-{name}": {"bind": "/home/node/.openclaw", "mode": "rw"},   # 每容器命名卷（预填充骨架）
        f"{FLEET_ROOT}/instances/{name}/openclaw.json":
            {"bind": "/home/node/.openclaw/openclaw.json", "mode": "ro"},          # 配置覆盖（只读）
    },
    ports={"18789/tcp": ("127.0.0.1", host_port)},
    restart_policy={"Name": "unless-stopped"},
    healthcheck={                                  # 单位是纳秒（docker-py 与 CLI 不同）——[事实]
        "test": ["CMD-SHELL", "curl -fsS http://127.0.0.1:18789/health || exit 1"],
        "interval": 30_000_000_000,                # 30s
        "timeout": 10_000_000_000,                 # 10s
        "retries": 3,
        "start_period": 60_000_000_000,            # 60s 启动宽限
    },
    labels={
        "app": "openclaw-fleet",                   # 面板按此过滤（§4.3）
        "openclaw.instance": name,
        "openclaw.port": str(host_port),
    },
)
```

> **[待实测]** 镜像内是否带 `curl` 供 healthcheck；若无，改用 `["CMD-SHELL", "wget -qO- ... || exit 1"]`
> 或 node 一行。单容器栈未配 healthcheck（compose 无此键），故镜像内健康探针命令未在本仓库验证过。
> 兜底：控制面用「HTTP GET 宿主映射端口 `/health`」做外部健康检查（下 §4.4），不依赖容器内命令。

### 4.3 查询/上报：按 label 过滤 + 状态聚合

**[事实]** `client.containers.list(all=True, filters={"label": ["app=openclaw-fleet"]})` 只取面板容器；
`container.status` 给出 `running/exited/...`；`container.reload()` 后
`container.attrs["State"]["Health"]["Status"]` 给出 `starting/healthy/unhealthy`；
`container.attrs["State"]["StartedAt"]`、`attrs["Config"]["Image"]` 可取。**[事实]** label filter 格式
`"key=value"` 或 `"key"` 列表。

**[决策] 状态上报模型**（对齐现有 `/openclaw/status` 的 shape，泛化为列表）：

```python
{
  "instances": [
    {
      "name": name,
      "container": {"id": ..., "running": bool, "status": ..., "health": ...,
                    "started_at": ..., "image": ...},
      "gateway":  {"url": f"http://127.0.0.1:{port}", "reachable": bool},   # 外部 HTTP /health 探
      "port": port,
      "model_provider": ...,          # 从 instances/<name>/openclaw.json 回读
    }, ...
  ]
}
```

每个容器一行，结构沿用单容器 `container/gateway/agents` 三段（routes/openclaw.py:307），前端 ocstatus
改为列表渲染。**WS 连接按 `(url, token)` 缓存**——现有 `WsClientRegistry` 是单连接单例
（services/openclaw_ws.py:228），多容器要扩成 `dict[(url,token) -> OpenClawWsClient]`。**[决策]** 这是
相对单容器必须改的连接层点，R13 §7.8 已预言「多网关场景按 (url,token) 缓存多个连接」。

### 4.4 删除与卷清理

**[决策]** 删除 = 停容器 + 连匿名卷删 + 删命名卷 + 删宿主 `instances/<name>/` 目录：

```python
c = client.containers.get(f"openclaw-gw-{name}")
c.stop(timeout=10)          # 先优雅停（超时后 SIGKILL）
c.remove(v=True, force=True)  # v=True 连容器关联的匿名卷一起删 —— [事实]
# 命名卷不随 remove(v=True) 删（它非匿名），须显式删：
client.volumes.get(f"openclaw-home-{name}").remove(force=True)
shutil.rmtree(f"{FLEET_ROOT}/instances/{name}", ignore_errors=True)
```

**[事实]** `remove(v=True)` 只删**匿名卷**；命名卷（named volume）需 `client.volumes.get(name).remove()`。
**取舍**：wiki/workspace 数据在命名卷里，删容器**默认连数据一起删**（符合「面板增删容器」的临时语义）。
**若用户要「删容器留 wiki」**，提供 `keep_volume=True` 选项跳过命名卷删除——**[待用户拍板]** 是否暴露
此选项（见 §5）。

### 4.5 生命周期状态机

```
creating (init 容器预填充骨架 → 渲染配置 → run)
  → running (healthcheck healthy)
  → stopped (stop；卷保留，可 restart)
  → removing (stop + remove v + 删命名卷 + 删 instances 目录)  [终态]
  └ 失败：创建即删（回滚命名卷与目录）
```

**[决策]** Django 侧用一个 `Instance` model 存 `name/port/token/volume/container_id/status/created_at`，
状态机迁移落 DB，崩溃后可按 label 扫描 daemon 对账（reconcile）。

---

## 5. 需实测 / 待用户拍板项汇总

| 项 | 类型 | 说明 |
|---|---|---|
| 命名卷预填充路径 | **[待实测]** | init 容器 `cp -a` 在 Docker Desktop (macOS) 的可行性；不要直写 `/var/lib/docker/volumes/.../_data`（VM 内不可达） |
| healthcheck 容器内命令 | **[待实测]** | 镜像内是否有 `curl`/`wget`；兜底改用控制面外部 HTTP 探 `/health` |
| Docker 随机端口重启稳定性 | **[待实测]** | `{"18789/tcp": None}` 重启后宿主端口是否不变；显式分配可绕过此问题 |
| GATEWAY_TOKEN env 插值 | **[待实测]** | R6 遗留：acautomata fork init.sh 是否如推断走 `${GATEWAY_TOKEN}` 占位（建议起容器 `openclaw gateway status` 实测一次） |
| 面板读 wiki 走共享卷 | **[待实测]** | 后端 sidecar 只读挂命名卷读 `wiki/main`；验证并发写时一致性（R7 §3.3 锁注意事项放大 N 倍） |
| 删容器是否留 wiki 数据 | **[待用户拍板]** | 是否提供 `keep_volume` 选项；默认建议连数据删 |
| 端口池范围/上限 | **[待用户拍板]** | 建议 19000–19999；决定单机能起多少容器 |
| 面板与单容器 compose 栈是否共存 | **[待用户拍板]** | 共存则按 label 隔离两套生命周期；或面板直接取代 compose 栈 |
| 每容器独立 LLM key 粒度 | **[待用户拍板]** | 全面板共享一个 LLM_API_KEY，还是每容器独立（影响 SecretRef env id 参数化） |
| Django 进程 docker 权限 | **[待用户拍板]** | 挂 docker.sock（等价 root）还是跑宿主；安全权衡 |

---

## 6. 关键信源索引

| 主题 | 位置 |
|---|---|
| 单容器挂载契约 | `deploy/docker-compose.yml`（researcher→/home/node/.openclaw:57、openclaw.json 覆盖:60、匿名卷 state/logs:62-63、端口:66）；`docs/research/r6-docker-image-mount.md` |
| 精简 openclaw.json 结构 | `deploy/openclaw.json`（删 channels/bindings/lossless-claw、token 占位:26、bind lan:10、minimax/memory-wiki 插件:132,145）；`tests/test_deploy_stack.py:171-231` |
| apply-config 单容器流程 | `routes/openclaw.py:166-298`（`_infer_provider`:177、`_restart_gateway`:210、`/apply-config`:231） |
| status 单容器 shape | `routes/openclaw.py:303-359` |
| WS 连接单例 | `services/openclaw_ws.py:228-249`（`WsClientRegistry`）；`services/openclaw_service.py:24` |
| wiki 直读机制 | `docs/research/r7-wiki-read-mechanism.md`（wiki/main 落盘、直读 FS 原则、双 schema） |
| docker-py API | docker-py.readthedocs.io/en/stable/{containers,client}.html：`run()` kwargs、ports/volumes dict、healthcheck 纳秒、`remove(v,force)`、label filters、`docker.from_env()` |
| 多实例官方依据 | docs.openclaw.ai/gateway/multiple-gateways（隔离四要素、容器是 clear winner、browser 派生口 loopback-only、OPENCLAW_ALLOW_MULTI_GATEWAY） |
