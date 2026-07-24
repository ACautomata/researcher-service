"""openclaw.json 渲染（spec §5.2）。

配置单一来源 = deploy/openclaw.json（与单容器 compose 共用一份，DRY）。每容器渲染产物落到
instances/<name>/openclaw.json，bind-mount(ro) 覆盖进容器。

token 策略：gateway.auth.token 保留 `${GATEWAY_TOKEN}` env 占位 —— 真值由 docker env
`GATEWAY_TOKEN=<secret>` 注入，gateway 进程运行时插值（R6 §4 已证）。真 token 绝不落盘进 JSON
文件（spec §5.2 安全不变量）。

renderer 强制 spec 不变量（port/bind/token）—— 即便模板漂移或被污染，输出仍合规。model providers
等可变配置由模板提供（P0 默认 minimax；P1 model CRUD ticket 经重渲染生效，见 spec §7）。
"""
import copy
import json

# 容器内 gateway 固定端口（spec §5.2 / r27 §3.1：Docker 网络命名空间隔离，仅宿主侧分配映射端口）
GATEWAY_PORT = 18789
GATEWAY_BIND = 'lan'
# env 占位（gateway 进程插值，非 Jinja 变量）—— 字面量保留进 JSON
GATEWAY_TOKEN_PLACEHOLDER = '${GATEWAY_TOKEN}'


class ConfigRenderer:
    """从模板文本渲染 openclaw.json，强制 spec 安全不变量。"""

    def __init__(self, template_text: str) -> None:
        # 构造期解析：损坏模板 fail-fast（不静默产出坏配置）
        self._template = json.loads(template_text)

    def render(self) -> str:
        cfg = copy.deepcopy(self._template)
        gateway = cfg.setdefault('gateway', {})
        gateway['port'] = GATEWAY_PORT
        gateway['bind'] = GATEWAY_BIND
        # 强制占位：杜绝真 token 落盘（即便上游模板写错）
        gateway.setdefault('auth', {})['token'] = GATEWAY_TOKEN_PLACEHOLDER
        return json.dumps(cfg, indent=2, ensure_ascii=False)
