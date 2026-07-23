"""issue #17 WS 传输骨架的接缝测试。

接缝 = services.openclaw_service 的 chat_stream()/chat() 对外 SSE 契约。
fake WS 替身（tests/fake_openclaw.py）模拟握手 + 推送 chat 事件帧，断言：
  delta→text、final→done、error→error、终态后补 done、idempotencyKey/agentId/sessionKey 上送。
只测对外行为（SSE 事件序列与 chat.send 入参），不断言内部实现。
"""
import json

import pytest

from tests.fake_openclaw import FakeOpenClawServer


def _parse_sse(events):
    """把 chat_stream() yield 的 SSE 字符串解析为事件 dict 列表。"""
    out = []
    for raw in events:
        assert raw.startswith("data: ")
        out.append(json.loads(raw[len("data: "):].strip()))
    return out


@pytest.mark.asyncio
async def test_chat_stream_maps_delta_then_final_to_text_then_done(openclaw_fake):
    """deltaText 增量→text 事件；final→done；终态后再补一个 done（对齐既有收尾契约）。"""
    server, service = openclaw_fake
    server.enqueue_chat([
        {"state": "delta", "deltaText": "你"},
        {"state": "delta", "deltaText": "好"},
        {"state": "final", "usage": {"total_tokens": 2}},
    ])

    events = _parse_sse([
        e async for e in service.chat_stream(agent_id="main", message="你好", session_key="s1")
    ])

    types = [e["type"] for e in events]
    assert types == ["text", "text", "done", "done"]
    assert events[0]["text"] == "你"
    assert events[1]["text"] == "好"
    assert events[2].get("usage") == {"total_tokens": 2}


@pytest.mark.asyncio
async def test_chat_stream_sends_chat_send_with_required_params(openclaw_fake):
    """chat.send 必带 sessionKey/message/idempotencyKey，且 agentId=main（取代 HTTP 的 model 字段）。"""
    server, service = openclaw_fake
    server.enqueue_chat([{"state": "final"}])

    async for _ in service.chat_stream(agent_id="main", message="评审这篇论文", session_key="sess-9"):
        pass

    assert len(server.received_sends) == 1
    params = server.received_sends[0]
    assert params["sessionKey"] == "sess-9"
    assert params["message"] == "评审这篇论文"
    assert params.get("idempotencyKey"), "idempotencyKey 为必填"
    assert params["agentId"] == "main"


@pytest.mark.asyncio
async def test_chat_stream_maps_error_state_to_error_then_done(openclaw_fake):
    """state=error → error 事件（取 errorMessage），随后补 done。"""
    server, service = openclaw_fake
    server.enqueue_chat([
        {"state": "delta", "deltaText": "半截"},
        {"state": "error", "errorMessage": "rate limit", "errorKind": "rate_limit"},
    ])

    events = _parse_sse([
        e async for e in service.chat_stream(agent_id="main", message="x", session_key="s")
    ])

    types = [e["type"] for e in events]
    assert types == ["text", "error", "done"]
    assert events[1]["text"] == "rate limit"


@pytest.mark.asyncio
async def test_chat_collects_stream_into_text(openclaw_fake):
    """chat() 非流式复用流式路径，拼接所有 text 增量返回 {text, raw}。"""
    server, service = openclaw_fake
    server.enqueue_chat([
        {"state": "delta", "deltaText": "一"},
        {"state": "delta", "deltaText": "二"},
        {"state": "final"},
    ])

    result = await service.chat(agent_id="main", message="拼", session_key="s")

    assert result["text"] == "一二"
    assert "raw" in result


@pytest.mark.asyncio
async def test_handshake_uses_connect_with_token(openclaw_fake):
    """握手走 connect 帧且 auth.token 匹配（token 认证强制）。"""
    server, service = openclaw_fake
    server.enqueue_chat([{"state": "final"}])

    async for _ in service.chat_stream(agent_id="main", message="hi", session_key="s"):
        pass

    assert server.received_connect is not None
    assert server.received_connect["auth"]["token"] == "test-token"


@pytest.mark.asyncio
async def test_image_files_sent_as_base64_attachments(openclaw_fake):
    """issue #19：图片附件经 WS attachments[] 传纯 base64（剥 data URL 前缀）。"""
    server, service = openclaw_fake
    server.enqueue_chat([{"state": "final"}])

    files = [{"name": "fig.png", "type": "image/png",
              "data": "data:image/png;base64,iVBORw0KGgo="}]
    async for _ in service.chat_stream(agent_id="main", message="看图", session_key="s", files=files):
        pass

    attachments = server.received_sends[0].get("attachments")
    assert attachments, "图片应经 attachments 传递"
    att = attachments[0]
    assert att["mimeType"] == "image/png"
    assert att["fileName"] == "fig.png"
    assert att["content"] == "iVBORw0KGgo=", "应剥掉 data URL 前缀只留纯 base64"


@pytest.mark.asyncio
async def test_non_image_files_not_in_attachments(openclaw_fake):
    """issue #19：非图片文件不经 attachments（落盘 workspace 由 agent 自取）。"""
    server, service = openclaw_fake
    server.enqueue_chat([{"state": "final"}])

    files = [{"name": "paper.pdf", "type": "application/pdf", "data": "data:application/pdf;base64,JVBERi0="}]
    async for _ in service.chat_stream(agent_id="main", message="读", session_key="s", files=files):
        pass

    assert not server.received_sends[0].get("attachments"), "非图片不应进 attachments"
