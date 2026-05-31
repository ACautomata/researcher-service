"""OpenClaw 网关 HTTP 客户端 —— 对接本地 OpenClaw Agent 平台"""
import json
import asyncio
import httpx
from typing import Optional, AsyncGenerator

from config import OPENCLAW_ENABLED
from services.user_credentials import get_effective_openclaw

_timeout = httpx.Timeout(120.0, connect=10.0)


async def _get_gateway_creds() -> tuple:
    """(gateway_url, gateway_token, api_key) — 优先用户配置，fallback 到 .env"""
    return await get_effective_openclaw()


def _check_enabled():
    if not OPENCLAW_ENABLED:
        raise RuntimeError("OpenClaw 网关未启用，请在 .env 中设置 OPENCLAW_ENABLED=true")


async def _headers() -> dict:
    _, token, _ = await _get_gateway_creds()
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


async def health() -> dict:
    """检查 OpenClaw 网关是否可达"""
    try:
        base, _, _ = await _get_gateway_creds()
        async with httpx.AsyncClient(timeout=_timeout) as c:
            resp = await c.get(f"{base.rstrip('/')}/health")
            return {"reachable": True, "status": resp.status_code, "body": resp.text[:500]}
    except Exception as e:
        return {"reachable": False, "error": str(e)}


async def chat(
    agent_id: str = "main",
    message: str = "",
    history: Optional[list] = None,
    system_prompt: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    session_key: Optional[str] = None,
) -> dict:
    """向 OpenClaw Agent 发送消息（非流式）"""
    _check_enabled()

    base, _, _ = await _get_gateway_creds()
    input_items = []
    if history:
        for h in history[-20:]:
            role = h.get("role", "user")
            content = h.get("content", "")
            if role == "assistant":
                input_items.append({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": content}]})
            else:
                input_items.append({"type": "message", "role": "user", "content": [{"type": "input_text", "text": content}]})
    input_items.append({"type": "message", "role": "user", "content": [{"type": "input_text", "text": message}]})

    model = "openclaw" if agent_id == "main" else f"openclaw/{agent_id}"
    payload = {
        "model": model,
        "input": input_items,
        "temperature": temperature,
        "max_output_tokens": max_tokens,
    }
    if system_prompt:
        payload["instructions"] = system_prompt
    if session_key:
        payload["user"] = session_key

    url = f"{base.rstrip('/')}/v1/responses"
    async with httpx.AsyncClient(timeout=_timeout) as c:
        resp = await c.post(url, headers=await _headers(), json=payload)
        if resp.status_code != 200:
            raise RuntimeError(f"OpenClaw 网关返回错误 HTTP {resp.status_code}: {resp.text[:500]}")
        data = resp.json()
        text = ""
        if "output" in data:
            for item in data["output"]:
                if item.get("type") == "message":
                    for block in item.get("content", []):
                        if block.get("type") == "output_text":
                            text += block.get("text", "")
        return {"text": text, "raw": data}


async def chat_stream(
    agent_id: str = "main",
    message: str = "",
    history: Optional[list] = None,
    system_prompt: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    session_key: Optional[str] = None,
) -> AsyncGenerator[str, None]:
    """向 OpenClaw Agent 发送消息（SSE 流式）—— 异步生成器，yield SSE 事件字符串"""
    _check_enabled()

    base, _, _ = await _get_gateway_creds()
    input_items = []
    if history:
        for h in history[-20:]:
            role = h.get("role", "user")
            content = h.get("content", "")
            if role == "assistant":
                input_items.append({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": content}]})
            else:
                input_items.append({"type": "message", "role": "user", "content": [{"type": "input_text", "text": content}]})
    input_items.append({"type": "message", "role": "user", "content": [{"type": "input_text", "text": message}]})

    model = "openclaw" if agent_id == "main" else f"openclaw/{agent_id}"
    payload = {
        "model": model,
        "input": input_items,
        "stream": True,
        "temperature": temperature,
        "max_output_tokens": max_tokens,
    }
    if system_prompt:
        payload["instructions"] = system_prompt
    if session_key:
        payload["user"] = session_key

    url = f"{base.rstrip('/')}/v1/responses"
    async with httpx.AsyncClient(timeout=_timeout) as c:
        async with c.stream("POST", url, headers=await _headers(), json=payload) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                yield f"data: {json.dumps({'type': 'error', 'text': f'HTTP {resp.status_code}: {body.decode()[:500]}'})}\n\n"
                return
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    data_str = line[6:]
                    try:
                        event = json.loads(data_str)
                        event_type = event.get("type", "")
                        if "delta" in event:
                            yield f"data: {json.dumps({'type': 'text', 'text': event.get('delta', '')})}\n\n"
                        elif event_type == "response.completed":
                            usage = event.get("response", {}).get("usage", {})
                            yield f"data: {json.dumps({'type': 'done', 'usage': usage})}\n\n"
                        elif event_type == "error":
                            yield f"data: {json.dumps({'type': 'error', 'text': event.get('message', str(event))})}\n\n"
                        else:
                            yield f"data: {json.dumps(event)}\n\n"
                    except json.JSONDecodeError:
                        if data_str.strip():
                            yield f"data: {json.dumps({'type': 'raw', 'text': data_str})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"


async def list_agents() -> list:
    """返回可用的 OpenClaw Agent 列表"""
    _check_enabled()
    return [
        {"id": "main", "name": "颖姗", "description": "主 Agent —— 科研助手，负责交互、委派子Agent"},
        {"id": "autoresearch", "name": "Autoresearch", "description": "AutoResearch Agent —— 论文知识库维护、文献 Wiki 构建"},
        {"id": "paper-review", "name": "Paper Review", "description": "论文评审 Agent —— 5阶段论文分析流水线"},
    ]
