"""seam: containers 共享常量单一来源契约 —— issue #88（1/3）/ #89（2/3）/ parent #79。

钉住「容器/编排域纯常量在 containers.constants 唯一定义、消费模块引用同一对象」这一架构不变量。

非 tautology 的判据（重构前后断言结果会翻转）：
- **int > 256**（如 18789）：不命中 CPython 小整数缓存，跨编译单元即不同对象 → 收口前 is False。
- **非标识符形态 str**（含 `-` / `.` / `/` / `$` 等，CPython 编译期不 intern）：同理，跨模块独立定义即不同对象 → 收口前 is False。
- 收口前 constants 根本无对应属性时，`constants.X` 直接 AttributeError。

标识符形态 str（`'app'`、`'lan'`）与小 int（≤256，如 8/32）会被 intern/缓存，is 恒真、
无法区分收口前后——对这些仅用值断言钉定义点（写 is 即 tautology，故不写）。
"""

from datetime import timedelta

from containers import (
    config_renderer,
    constants,
    docker_runtime,
    orchestrator,
    ports,
    runtime,
)


def test_gateway_internal_port_single_value():
    # 真常量唯一定义点：spec §5.2/§5.3 容器内 gateway 固定 18789。
    assert constants.GATEWAY_INTERNAL_PORT == 18789


def test_ports_reserved_port_is_constants_reference():
    # ports.RESERVED_PORT_18789 不再独立 `= 18789`，引用 constants 同一对象。
    assert ports.RESERVED_PORT_18789 is constants.GATEWAY_INTERNAL_PORT


def test_runtime_gateway_port_is_constants_reference():
    # runtime.GATEWAY_INTERNAL_PORT 不再独立 `= 18789`，引用 constants 同一对象。
    assert runtime.GATEWAY_INTERNAL_PORT is constants.GATEWAY_INTERNAL_PORT


def test_config_renderer_gateway_port_is_constants_reference():
    # config_renderer.GATEWAY_PORT 是 constants 的可读别名，引用同一对象。
    assert config_renderer.GATEWAY_PORT is constants.GATEWAY_INTERNAL_PORT


# ---------------------------------------------------------------------------
# issue #89 (2/3)：runtime / config_renderer / orchestrator 域常量陆续收口。
# 每组契约 = 「constants 是唯一定义点（值）」+ 「消费模块引用同一对象（is）」。
# ---------------------------------------------------------------------------


# --- runtime 域：Docker label + 容器名前缀 + 容器内 bind 路径（原散落 runtime.py） ---


def test_container_prefix_defined_in_constants():
    # spec §5.3 / r27 §3.3：openclaw-gw- 前缀与原 compose 栈 openclaw-gateway 隔离。
    assert constants.CONTAINER_PREFIX == 'openclaw-gw-'


def test_label_constants_defined_in_constants():
    # issue #39 验收 + spec §5.4：按 label 过滤管理容器生命周期。
    assert constants.LABEL_APP_KEY == 'app'
    assert constants.LABEL_APP_VALUE == 'openclaw-fleet'
    assert constants.LABEL_INSTANCE_KEY == 'openclaw.instance'
    assert constants.LABEL_PORT_KEY == 'openclaw.port'


def test_bind_paths_defined_in_constants():
    # spec §5.2/§5.3：容器内固定 bind-mount 路径。
    assert constants.HOME_BIND == '/home/node/.openclaw'
    assert constants.CONFIG_BIND == '/home/node/.openclaw/openclaw.json'


def test_runtime_container_prefix_is_constants_reference():
    # runtime 仅留 container_name()，CONTAINER_PREFIX 引用 constants（'openclaw-gw-' 含 '-'，
    # 非 intern：收口前 runtime 独立定义 → is False；收口后同一对象）。
    assert runtime.CONTAINER_PREFIX is constants.CONTAINER_PREFIX


def test_docker_runtime_label_and_bind_refs_are_constants():
    # docker_runtime 不再经 runtime 转取，常量直接引自 constants。下列均为非标识符形态 str，
    # 收口前从 runtime 取独立对象 → is False；收口后 is True。钉住「引用来源迁移」。
    # LABEL_APP_KEY='app' 为标识符形态（intern），is 恒真无法钉，靠值断言 + 行为测试覆盖。
    assert docker_runtime.LABEL_APP_VALUE is constants.LABEL_APP_VALUE
    assert docker_runtime.LABEL_INSTANCE_KEY is constants.LABEL_INSTANCE_KEY
    assert docker_runtime.LABEL_PORT_KEY is constants.LABEL_PORT_KEY
    assert docker_runtime.CONTAINER_PREFIX is constants.CONTAINER_PREFIX
    assert docker_runtime.HOME_BIND is constants.HOME_BIND
    assert docker_runtime.CONFIG_BIND is constants.CONFIG_BIND


# --- config_renderer 域：gateway bind + token 占位符（原散落 config_renderer.py） ---


def test_gateway_bind_defined_in_constants():
    # spec §5.2：gateway 网络绑定模式 'lan'。值是标识符形态（intern），is 无法钉跨模块引用，
    # 仅值断言钉定义点；config_renderer/docker_runtime 引用迁移靠行为测试 + review。
    assert constants.GATEWAY_BIND == 'lan'


def test_gateway_token_placeholder_defined_in_constants():
    # spec §5.2 安全不变量：真 token 绝不落盘 JSON，保留 ${GATEWAY_TOKEN} env 占位由 gateway 进程插值。
    assert constants.GATEWAY_TOKEN_PLACEHOLDER == '${GATEWAY_TOKEN}'


def test_config_renderer_token_placeholder_is_constants_reference():
    # '${GATEWAY_TOKEN}' 含 $ { }，CPython 不 intern——收口前 config_renderer 独立定义 → is False；
    # 收口后同一对象。钉住 config_renderer 引用来源迁移（test_config_render 钉行为值不变）。
    assert config_renderer.GATEWAY_TOKEN_PLACEHOLDER is constants.GATEWAY_TOKEN_PLACEHOLDER


# --- orchestrator 域：编排私有常量提升为共享 + 消除内联魔法数字（原散落 orchestrator.py） ---


def test_max_port_retries_defined_in_constants():
    # codex R1 :77：port 并发冲突最大重试次数（port 池充足，覆盖极端并发）。
    assert constants.MAX_PORT_RETRIES == 8


def test_max_health_workers_defined_in_constants():
    # codex R1 :156：list 健康探测并发上限（避免线程爆炸）。
    assert constants.MAX_HEALTH_WORKERS == 8


def test_lease_ttl_defined_in_constants():
    # codex R8 F1：CREATING 行跨进程 lease TTL（覆盖模板拷贝 + 镜像预拉取的阻塞 IO）。
    assert constants.LEASE_TTL == timedelta(seconds=600)


def test_token_urlsafe_bytes_defined_in_constants():
    # gateway_token 熵：secrets.token_urlsafe 字节数，32 字节 = 256 bit（spec §5.2 GATEWAY_TOKEN）。
    assert constants.TOKEN_URLSAFE_BYTES == 32


def test_orchestrator_shared_constants_are_constants_references():
    # orchestrator 引用 constants（去私有下划线前缀提升为共享）。red 来源：
    # - LEASE_TTL 是 timedelta 对象（不 intern）→ 收口前独立 _LEASE_TTL 是不同对象，且无 LEASE_TTL 属性。
    # - MAX_*/TOKEN_URLSAFE_BYTES 是小 int（≤256，小整数缓存，is 恒真），但 orchestrator 收口前
    #   仅暴露带下划线的 _MAX_*，无 MAX_* 属性、无 TOKEN_URLSAFE_BYTES → AttributeError 提供 red。
    assert orchestrator.MAX_PORT_RETRIES is constants.MAX_PORT_RETRIES
    assert orchestrator.MAX_HEALTH_WORKERS is constants.MAX_HEALTH_WORKERS
    assert orchestrator.LEASE_TTL is constants.LEASE_TTL
    assert orchestrator.TOKEN_URLSAFE_BYTES is constants.TOKEN_URLSAFE_BYTES
