"""seam: chat.chat_client.list_commands —— T07 斜杠命令清单 RPC（issue #43 / spec §8.2）。

commands.list 是与 approval.resolve 同构的「req→res 回执」WS RPC（复用 _pending_resolves）：
发 commands.list{agentId:"main", scope:"both", includeArgs:true} → 有界等 res → 返回 payload
（外层键名 + includeArgs 元数据按实测校准，原样透传给 REST 层解析）。注入 FakeChatTransport（fakes.py）。
"""
import pytest

from chat.chat_client import ChatSendError, OpenClawChatClient
from chat.tests.fakes import FakeChatTransport

URL = 'ws://127.0.0.1:19000/'


@pytest.mark.asyncio
async def test_list_commands_builds_frame_and_returns_payload():
    """发 commands.list 帧（agentId/scope/includeArgs 按 r26 §2），返回网关 res payload。"""
    payload = {'commands': [{'name': 'model', 'description': '切换模型',
                             'textAliases': ['/model', '/m'], 'nativeName': 'model'}]}
    t = FakeChatTransport(commands_payload=payload)
    c = OpenClawChatClient(URL, 'dt', transport=t)
    await c.connect()
    result = await c.list_commands()
    assert result == payload
    cl = next(f for f in t.sent if f.get('method') == 'commands.list')
    assert cl['params']['agentId'] == 'main'
    assert cl['params']['scope'] == 'both'
    assert cl['params']['includeArgs'] is True
    await c.aclose()


@pytest.mark.asyncio
async def test_list_commands_not_connected_returns_empty():
    """未连接（_ws None）→ 返回 {}（对齐 list_pending_approvals 的 best-effort 契约）。"""
    t = FakeChatTransport()
    c = OpenClawChatClient(URL, 'dt', transport=t)
    assert await c.list_commands() == {}


@pytest.mark.asyncio
async def test_list_commands_gateway_reject_raises():
    """网关拒绝（缺 operator.read scope）→ res not ok → 抛 ChatSendError（上层映射 502）。"""
    t = FakeChatTransport(commands_error={'code': 'FORBIDDEN', 'message': 'missing scope operator.read'})
    c = OpenClawChatClient(URL, 'dt', transport=t)
    await c.connect()
    with pytest.raises(ChatSendError):
        await c.list_commands()
    await c.aclose()


@pytest.mark.asyncio
async def test_list_commands_ack_timeout_raises():
    """有界等待：ack 丢失/网关不回 → ChatSendError（不永久挂起），且 future 已从 _pending_resolves 清出。"""
    t = FakeChatTransport(suppress_commands_ack=True)
    c = OpenClawChatClient(URL, 'dt', transport=t, ack_timeout=0.05)
    await c.connect()
    with pytest.raises(ChatSendError):
        await c.list_commands()
    assert not c._pending_resolves  # 超时后 future 已清理，不泄漏
    await c.aclose()
