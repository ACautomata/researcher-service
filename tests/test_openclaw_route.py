"""issue #18 会话记忆 + system_prompt 前缀的路由级接缝测试。

接缝 = FastAPI 路由 POST /openclaw/chat/stream + GET /openclaw/chat/{tid}/stream。
断言路由层把 session_key 透传到 WS chat.send（记忆语义 = 复用 sessionKey，历史由网关维护），
且 system_prompt 拼接到 message 前缀。fake WS 替身挡下游网络。
"""
import json

import pytest
from httpx import ASGITransport, AsyncClient

from tests.fake_openclaw import FakeOpenClawServer


async def _drive_one_stream(client: AsyncClient, server: FakeOpenClawServer, body: dict) -> list[dict]:
    """POST 启动流式 → GET 消费 SSE → 返回事件 dict 列表。"""
    r = await client.post("/api/v1/openclaw/chat/stream", json=body)
    assert r.status_code == 200, r.text
    tid = r.json()["task_id"]

    events = []
    async with client.stream("GET", f"/api/v1/openclaw/chat/{tid}/stream") as resp:
        assert resp.status_code == 200
        async for line in resp.aiter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
                if events[-1].get("type") in ("done", "error"):
                    # done 会再来一次收尾；继续读完
                    pass
    return events


@pytest.mark.asyncio
async def test_route_passes_session_key_to_chat_send(openclaw_route):
    """路由层补传 session_key：WS chat.send 的 sessionKey 应等于请求里的 session_key（记忆复用）。"""
    client, server, _ = openclaw_route
    server.enqueue_chat([{"state": "final"}])

    await _drive_one_stream(client, server, {
        "agent_id": "main", "message": "继续", "session_key": "sess-abc",
    })

    assert server.received_sends, "应至少有一次 chat.send"
    assert server.received_sends[0]["sessionKey"] == "sess-abc"


@pytest.mark.asyncio
async def test_route_prefixes_system_prompt_into_message(openclaw_route):
    """system_prompt 拼到 message 前缀（WS chat.send 无 instructions 字段）。"""
    client, server, _ = openclaw_route
    server.enqueue_chat([{"state": "final"}])

    await _drive_one_stream(client, server, {
        "agent_id": "main", "message": "评审它", "system_prompt": "你是评审专家",
    })

    msg = server.received_sends[0]["message"]
    assert msg.startswith("你是评审专家"), f"system_prompt 应拼到 message 前缀，实际: {msg!r}"
    assert "评审它" in msg


@pytest.mark.asyncio
async def test_route_stream_emits_text_done_contract(openclaw_route):
    """端到端：fake 推 delta/final → 前端 SSE 收到 text...done，契约不变。"""
    client, server, _ = openclaw_route
    server.enqueue_chat([
        {"state": "delta", "deltaText": "结果"},
        {"state": "final"},
    ])

    events = await _drive_one_stream(client, server, {
        "agent_id": "main", "message": "x", "session_key": "s",
    })

    types = [e["type"] for e in events]
    assert "text" in types
    assert types[-1] == "done"
    text_joined = "".join(e.get("text", "") for e in events if e["type"] == "text")
    assert "结果" in text_joined
