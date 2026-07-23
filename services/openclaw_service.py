"""OpenClaw 网关客户端 —— WebSocket 协议（protocol v4）对接本地 OpenClaw Agent 平台。

传输层已从 HTTP `POST /v1/responses` 改为 WebSocket `chat.send`（docs/research/r13-ws-protocol.md）。
对前端输出的 SSE 事件（text / done / error / raw）契约保持不变。

行为差异（相对旧 HTTP 实现，issue #13/#17）：
- `history` 不再逐条上传；会话历史由网关按 `sessionKey` 维护，复用同一 session_key 即有跨轮记忆。
- `system_prompt` 拼接到 message 前缀（WS chat.send 无 instructions 对等字段，除非 admin scope）。
- `temperature`/`max_tokens` 不再由调用方传，由网关 openclaw.json 的 agent 配置托管。
- `chat()`（非流式）复用流式路径收集全部 text 增量拼接。
"""
import json
from typing import AsyncGenerator, Optional

import httpx

from config import OPENCLAW_ENABLED
from services.openclaw_ws import WsClientRegistry
from services.user_credentials import get_effective_openclaw

_timeout = httpx.Timeout(120.0, connect=10.0)

# 进程级 WS 连接单例（懒建 + 重连 + runId 路由）
_registry = WsClientRegistry(get_effective_openclaw)


def reset_ws_client() -> None:
    """测试用：丢弃当前连接单例（下次调用时重建）。仅取消 reader 并断开引用，不等待关闭握手。"""
    client = _registry._client
    _registry._client = None
    if client is not None and client._reader is not None:
        client._reader.cancel()


def use_creds_provider(provider) -> None:
    """测试用：替换 WS 连接的凭据源并丢弃现有连接（指向 fake 替身）。"""
    _registry.set_creds_provider(provider)


async def close_ws_client() -> None:
    """测试用：关闭并丢弃当前连接单例。"""
    await _registry.reset()


def _check_enabled():
    if not OPENCLAW_ENABLED:
        raise RuntimeError("OpenClaw 网关未启用，请在 .env 中设置 OPENCLAW_ENABLED=true")


async def health() -> dict:
    """检查 OpenClaw 网关是否可达（保留 HTTP GET /health，多路复用端口上 HTTP 仍可用）"""
    try:
        base, _, _ = await get_effective_openclaw()
        async with httpx.AsyncClient(timeout=_timeout) as c:
            resp = await c.get(f"{base.rstrip('/')}/health")
            return {"reachable": True, "status": resp.status_code, "body": resp.text[:500]}
    except Exception as e:
        return {"reachable": False, "error": str(e)}


def _build_message(message: str, system_prompt: Optional[str]) -> str:
    """system_prompt 拼接到 message 前缀（WS chat.send 无 instructions 对等字段）。"""
    if system_prompt:
        return f"{system_prompt}\n\n{message}" if message else system_prompt
    return message


def _to_attachments(files: Optional[list]) -> Optional[list]:
    """把前端 files:[{name,data,type}] 映射为 WS attachments:[{mimeType,fileName,content}]。

    content 为纯 base64（剥掉 data URL 的 `data:...;base64,` 前缀）。
    仅图片附件经 WS 传递；非图片由上传落盘 + 消息文本告知路径（路由层处理）。
    """
    if not files:
        return None
    attachments = []
    for f in files:
        ftype = f.get("type", "") or ""
        if not ftype.startswith("image/"):
            continue
        data = f.get("data", "") or ""
        # 剥 data URL 前缀，只留纯 base64
        if data.startswith("data:") and "," in data:
            data = data.split(",", 1)[1]
        attachments.append({
            "mimeType": ftype,
            "fileName": f.get("name", "file"),
            "content": data,
        })
    return attachments or None


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


def _translate(payload: dict, state: dict) -> list[str]:
    """把一帧 WS chat 事件 payload 翻译成既有 SSE 字符串列表。

    state 携带跨帧上下文（已发文本累积），用于 replace=true 的差集计算与 final 尾部补发。
    """
    out = []
    st = payload.get("state")
    if st == "delta":
        delta = payload.get("deltaText", "")
        if payload.get("replace"):
            # 非前缀整段替换：与已发文本求差集后发增量（前端是追加式渲染）
            snapshot = payload.get("message") or ""
            if snapshot and snapshot.startswith(state["sent"]):
                delta = snapshot[len(state["sent"]):]
            # 若无快照可用，退回发原 deltaText
        if delta:
            state["sent"] += delta
            out.append(_sse({"type": "text", "text": delta}))
    elif st == "final":
        # final 的 message 若含未发尾部文本，先补 text 再 done
        message = payload.get("message") or ""
        if message and message.startswith(state["sent"]) and len(message) > len(state["sent"]):
            tail = message[len(state["sent"]):]
            state["sent"] += tail
            out.append(_sse({"type": "text", "text": tail}))
        out.append(_sse({"type": "done", "usage": payload.get("usage", {})}))
    elif st == "error":
        text = payload.get("errorMessage") or payload.get("errorKind") or "未知错误"
        out.append(_sse({"type": "error", "text": text}))
    elif st == "aborted":
        # 中止非错误，前端正常收尾
        out.append(_sse({"type": "done", "stopReason": payload.get("stopReason", "aborted")}))
    return out


async def chat(
    agent_id: str = "main",
    message: str = "",
    history: Optional[list] = None,
    system_prompt: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    session_key: Optional[str] = None,
    files: Optional[list] = None,
) -> dict:
    """向 OpenClaw Agent 发送消息（非流式）—— 复用流式路径收集全部 text 增量。

    history 参数保留签名但不再逐条上传（网关按 sessionKey 维护历史）。
    temperature/max_tokens 保留签名但不生效（由网关 agent 配置托管）。
    """
    _check_enabled()
    text = ""
    raw = None
    async for sse_event in chat_stream(
        agent_id=agent_id,
        message=message,
        history=history,
        system_prompt=system_prompt,
        temperature=temperature,
        max_tokens=max_tokens,
        session_key=session_key,
        files=files,
    ):
        if sse_event.startswith("data: "):
            try:
                evt = json.loads(sse_event[6:])
            except json.JSONDecodeError:
                continue
            if evt.get("type") == "text":
                text += evt.get("text", "")
            elif evt.get("type") == "done":
                raw = evt
    return {"text": text, "raw": raw}


async def chat_stream(
    agent_id: str = "main",
    message: str = "",
    history: Optional[list] = None,
    system_prompt: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    session_key: Optional[str] = None,
    files: Optional[list] = None,
) -> AsyncGenerator[str, None]:
    """向 OpenClaw Agent 发送消息（SSE 流式）—— 异步生成器，yield SSE 事件字符串。

    内部走 WS chat.send；对外契约（text/done/error/raw）与旧 HTTP 实现一致。
    history 不再逐条上传（网关按 sessionKey 维护历史）；temperature/max_tokens 不生效。
    终态（final/error/aborted）后无条件补一个 done，保证前端 __DONE__ 收尾逻辑触发。
    """
    _check_enabled()

    client = _registry.get()
    full_message = _build_message(message, system_prompt)
    attachments = _to_attachments(files)
    # 非图片附件名拼进消息（图片经 attachments base64 传递；非图片落盘由路由层告知路径）
    message = full_message

    state = {"sent": ""}
    try:
        async for payload in client.chat_stream(
            session_key=session_key or "main",
            message=message,
            agent_id=agent_id or "main",
            attachments=attachments,
        ):
            for sse in _translate(payload, state):
                yield sse
            if payload.get("state") in ("final", "error", "aborted"):
                break
    except Exception as e:
        yield _sse({"type": "error", "text": str(e)})
    # 终态后无条件补 done（对齐旧实现末尾的 yield done）
    yield _sse({"type": "done"})
