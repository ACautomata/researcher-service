"""chat.chat_client —— 收敛后的**兼容 shim**（#231 / ADR 0004）。

路径4 strangler 收敛：唯一 OpenClawWire 实现已迁入防腐层
``integration.openclaw.wire_client.OpenClawWireClient``（原 OpenClawChatClient，承载
#152/#154/#214/#219/#220 的 dead/transmitted 硬化语义）。本模块提供**同对象 alias**
``OpenClawChatClient = OpenClawWireClient``——strangler 零改名，273 个 chat 测试 / pool /
consumers / 所有 ``except ChatSendError`` 调用点零改动。alias 清理列 deferred。

wire 异常族 / GatewayPolicy / 握手默认常量的单一来源在 integration.openclaw.wire（#229），
本模块 identity-preserving re-export（同对象，非拷贝）——isinstance / is / __cause__ 链不变。
"""
from __future__ import annotations

from integration.openclaw.wire import (
    DEFAULT_MAX_PAYLOAD_BYTES,
    DEFAULT_TICK_INTERVAL_MS,
    ChatClientError,
    ChatConnectError,
    ChatPayloadTooLargeError,
    ChatSendError,
    ChatSendTransmittedError,
    GatewayPolicy,
)
from integration.openclaw.wire_client import OnEvent, OpenClawWireClient

# #231 / ADR 0004：同对象 alias（strangler 零改名）。``OpenClawChatClient is OpenClawWireClient``。
OpenClawChatClient = OpenClawWireClient

__all__ = [
    'DEFAULT_MAX_PAYLOAD_BYTES',
    'DEFAULT_TICK_INTERVAL_MS',
    'ChatClientError',
    'ChatConnectError',
    'ChatPayloadTooLargeError',
    'ChatSendError',
    'ChatSendTransmittedError',
    'GatewayPolicy',
    'OnEvent',
    'OpenClawChatClient',
]
