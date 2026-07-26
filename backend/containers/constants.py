"""containers / 编排域共享常量单一来源（spec §5.2/§5.3 / parent issue #79）。

收口容器/编排域纯常量到此模块，消除 runtime/config_renderer/orchestrator 散落定义：
- issue #88（1/3）：gateway 容器内固定端口 18789（ports/runtime/config_renderer 三处去重）。
- issue #89（2/3）：Docker label key、容器名前缀、容器内 bind 路径、gateway bind/token 占位、
  编排协议常量（端口重试/健康并发上限/lease TTL/token 熵），并消除内联魔法数字。

划分原则（parent #79）：
- **真常量进这里**：协议/架构级不变量——值由 spec 或 Docker 网络拓扑决定，跨部署不漂移。
  典型：容器内固定端口（18789，命名空间隔离）、容器名前缀、label key、编排状态机协议常量
  （MAX_PORT_RETRIES / MAX_HEALTH_WORKERS / LEASE_TTL —— 由编排并发模型决定，非部署可调）。
- **部署配置留 settings**：随环境变化的运营参数（端口池区间、宿主 bind、token、运营超时），
  经 config/settings/{base,dev,prod}.py + env 注入，不进本模块。LEASE_TTL 虽是时间值，
  但属 CREATING 状态机协议（codex R8 F1，覆盖模板拷贝 + 镜像预拉取的阻塞 IO），不随部署漂移；
  而 HealthProbe timeout（接口默认参数 2.0）才是运营超时，留 orchestrator 内部不动。

边界（ADR 0002）：wire 域常量在 integration/openclaw/wire.py 单独收口；本模块只管
容器/编排域。两包互不重复定义（wire.py 注释已声明）。
"""

from datetime import timedelta

# 容器内 gateway 固定端口（spec §5.2/§5.3：Docker 网络命名空间隔离，仅宿主侧分配映射端口）
GATEWAY_INTERNAL_PORT = 18789

# 容器名前缀：与原 compose 栈 openclaw-gateway 隔离（spec §5.3 / r27 §3.3）
CONTAINER_PREFIX = 'openclaw-gw-'
# 按 label 过滤管理容器生命周期（issue #39 验收 + spec §5.4）
LABEL_APP_KEY = 'app'
LABEL_APP_VALUE = 'openclaw-fleet'
LABEL_INSTANCE_KEY = 'openclaw.instance'
LABEL_PORT_KEY = 'openclaw.port'
# 容器内固定 bind-mount 路径（spec §5.2/§5.3）
HOME_BIND = '/home/node/.openclaw'
CONFIG_BIND = '/home/node/.openclaw/openclaw.json'
# gateway 网络绑定模式（spec §5.2：容器内 gateway 绑 lan，宿主侧靠 Docker 端口映射隔离）
GATEWAY_BIND = 'lan'
# env 占位：真 token 绝不落盘 JSON，保留 ${GATEWAY_TOKEN} 由 gateway 进程运行时插值（spec §5.2）
GATEWAY_TOKEN_PLACEHOLDER = '${GATEWAY_TOKEN}'

# --- 编排状态机协议常量（原 orchestrator.py 私有 _前缀，issue #89 提升为共享） ---
# codex R1 :77：port 并发冲突最大重试次数（DB 唯一约束仲裁下，port 池充足覆盖极端并发）
MAX_PORT_RETRIES = 8
# codex R1 :156：list 健康探测并发上限（ThreadPoolExecutor，bound 总延迟而非 N×timeout 串行）
MAX_HEALTH_WORKERS = 8
# codex R8 F1：CREATING 行跨进程 lease TTL——覆盖模板拷贝（cp -a）+ 镜像预拉取（docker pull）
# 的阻塞 IO（内部不续约）；极端超时由 _reconcile self-heal 兜底。600s 覆盖典型 create 全程。
LEASE_TTL = timedelta(seconds=600)
# gateway_token 熵（spec §5.2 GATEWAY_TOKEN）：secrets.token_urlsafe 字节数，32 字节 = 256 bit
TOKEN_URLSAFE_BYTES = 32
