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
    files: Optional[list] = None,
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

    user_content = []
    if files:
        for f in files:
            fname = f.get("name", "file")
            fdata = f.get("data", "")
            ftype = f.get("type", "")
            if ftype and ftype.startswith("image/"):
                user_content.append({"type": "input_image", "image_url": fdata})
            else:
                user_content.append({"type": "input_file", "filename": fname, "file_data": fdata})
    if message:
        user_content.append({"type": "input_text", "text": message})
    input_items.append({"type": "message", "role": "user", "content": user_content})

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
    files: Optional[list] = None,
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

    # Build current user message content blocks
    user_content = []
    if files:
        for f in files:
            fname = f.get("name", "file")
            fdata = f.get("data", "")
            ftype = f.get("type", "")
            if ftype and ftype.startswith("image/"):
                user_content.append({"type": "input_image", "image_url": fdata})
            else:
                user_content.append({"type": "input_file", "filename": fname, "file_data": fdata})
    if message:
        user_content.append({"type": "input_text", "text": message})
    input_items.append({"type": "message", "role": "user", "content": user_content})

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
                    if data_str.strip() == "[DONE]":
                        yield f"data: {json.dumps({'type': 'done'})}\n\n"
                        break
                    try:
                        event = json.loads(data_str)
                        event_type = event.get("type", "")
                        # response.output_text.delta → 逐字输出
                        if event_type == "response.output_text.delta":
                            yield f"data: {json.dumps({'type': 'text', 'text': event.get('delta', '')})}\n\n"
                        # response.output_text.done → 最终文本块
                        elif event_type == "response.output_text.done":
                            yield f"data: {json.dumps({'type': 'text', 'text': event.get('text', '')})}\n\n"
                        # response.output_item.done → 消息完成
                        elif event_type == "response.output_item.done":
                            item = event.get("item", {})
                            for block in item.get("content", []):
                                if block.get("type") == "output_text":
                                    yield f"data: {json.dumps({'type': 'text', 'text': block.get('text', '')})}\n\n"
                        # response.completed → 结束
                        elif event_type == "response.completed":
                            resp_data = event.get("response", {})
                            usage = resp_data.get("usage", {})
                            status = resp_data.get("status", "")
                            if status == "failed":
                                # Extract error text from output
                                output = resp_data.get("output", [])
                                error_text = ""
                                for item in output:
                                    for block in item.get("content", []):
                                        if block.get("type") == "output_text":
                                            error_text = block.get("text", "")
                                yield f"data: {json.dumps({'type': 'error', 'text': error_text or '请求失败'})}\n\n"
                            yield f"data: {json.dumps({'type': 'done', 'usage': usage})}\n\n"
                        # error 事件
                        elif event_type == "error":
                            yield f"data: {json.dumps({'type': 'error', 'text': event.get('message', str(event))})}\n\n"
                        elif "delta" in event:
                            yield f"data: {json.dumps({'type': 'text', 'text': event.get('delta', '')})}\n\n"
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
