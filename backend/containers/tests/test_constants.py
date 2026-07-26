"""seam: containers 共享常量单一来源契约 —— issue #88 / parent #79。

钉住「gateway 容器内端口 18789 三处定义收口到 containers.constants」这一架构不变量。
重构前 ports/runtime/config_renderer 各自 `= 18789` 是三个独立 int 对象（18789 > 256
不命中 CPython 小整数缓存，跨编译单元即不同对象）；收口后三者都引用
constants.GATEWAY_INTERNAL_PORT 同一对象，`is` 为 True。这是「单一来源」的可执行证据，
不是 tautology——重构前后断言结果会从 False 翻转为 True。
"""

from containers import config_renderer, constants, ports, runtime


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
