"""seam: chat.chat_client —— chat.send 的 transmitted 分类与 idempotencyKey（issue #41 / codex #219 P1）。

从 test_chat_client.py 拆出（该文件超 pylint C0302 1000 行阈值）：聚焦「帧已发出但结果未知」的
ChatSendTransmittedError 分类边界 + idempotencyKey 透传——consumer 自愈据此判可否盲重试、
重试复用同 key 让网关幂等去重。注入 FakeChatTransport（fakes.py）。
"""
import asyncio

import pytest

from chat.chat_client import (
    ChatSendError,
    ChatSendTransmittedError,
    OpenClawChatClient,
)
from chat.device_crypto import DeviceCrypto
from chat.tests.fakes import FakeChatTransport

URL = 'ws://127.0.0.1:19000/'

# 对齐 test_chat_client.py：session connect 帧 device 签名块所需共享假 identity（这些测试不验签）。
_IDENTITY = DeviceCrypto.generate_identity()
_SCOPES = ['operator.read', 'operator.write', 'operator.approvals']


def _client(url=URL, device_token='dt', **kwargs):
    """构造 OpenClawChatClient，注入假 identity/scopes 走 #140 签名路径（对齐 test_chat_client._client）。"""
    return OpenClawChatClient(
        url, device_token,
        identity=_IDENTITY, scopes=_SCOPES, **kwargs,
    )


@pytest.mark.asyncio
async def test_send_message_uses_provided_idempotency_key():
    """codex #219 P1：显式传 idempotency_key 时透传（consumer 自愈重试复用同 key）。"""
    t = FakeChatTransport(ack_run_id='run-9')

    async def on_event(frame):
        pass

    c = _client(transport=t)
    await c.connect()
    await c.send_message('sess-1', '你好', on_event=on_event, idempotency_key='fixed-key-1')
    cs = next(f for f in t.sent if f.get('method') == 'chat.send')
    assert cs['params']['idempotencyKey'] == 'fixed-key-1'
    await c.aclose()


@pytest.mark.asyncio
async def test_recv_death_after_send_raises_transmitted():
    """codex #219 P1：帧已发出、等 ack 期间连接死（aclose 触发 _fail_pending_acks）→
    ChatSendTransmittedError——consumer 据此判不可盲重试（run 事件流已绑死连接）。"""
    t = FakeChatTransport(suppress_ack=True)  # 不回 ack，send_message 卡在等 ack

    async def on_event(frame):
        pass

    c = _client(transport=t)
    await c.connect()
    task = asyncio.create_task(c.send_message('s', 'm', on_event=on_event))
    await asyncio.sleep(0.05)  # chat.send 已发出，正在等 ack
    await c.aclose()  # 连接死 → _fail_pending_acks reject 未决 ack
    with pytest.raises(ChatSendTransmittedError):
        await task


@pytest.mark.asyncio
async def test_send_message_ack_timeout_raises_transmitted():
    """codex #219 P1：ack 超时（帧已发出）→ ChatSendTransmittedError（consumer 据此不盲重试）。"""
    t = FakeChatTransport(suppress_ack=True)
    c = _client(transport=t, ack_timeout=0.1)
    await c.connect()

    async def on_event(frame):
        pass

    with pytest.raises(ChatSendTransmittedError):
        await c.send_message('s', 'm', on_event=on_event)
    await c.aclose()


@pytest.mark.asyncio
async def test_send_message_explicit_reject_is_not_transmitted():
    """codex #219 P1：网关显式拒绝（ack ok:false）→ 普通 ChatSendError（非 transmitted，可安全重试）。"""
    t = FakeChatTransport(ack_error={'code': 'RATE_LIMIT', 'message': 'too fast'})
    c = _client(transport=t)
    await c.connect()

    async def on_event(frame):
        pass

    with pytest.raises(ChatSendError) as exc:
        await c.send_message('s', 'm', on_event=on_event)
    # 显式拒绝 = 确定未起 run，不是 transmitted 子类
    assert not isinstance(exc.value, ChatSendTransmittedError)
    await c.aclose()
