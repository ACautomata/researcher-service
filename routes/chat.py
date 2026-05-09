"""AI 对话路由"""
import json
import uuid
import asyncio
from typing import Optional
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.ai_service import chat

router = APIRouter(prefix="/api/v1/chat", tags=["AI 对话"])


class SendRequest(BaseModel):
    message: str
    history: list = []
    system_prompt: Optional[str] = None


@router.post("/send")
async def chat_send(req: SendRequest):
    """非流式：发送消息，返回完整回复"""
    if not req.message.strip():
        raise HTTPException(400, "消息不能为空")
    messages = []
    if req.system_prompt:
        messages.append({"role": "system", "content": req.system_prompt})
    for h in req.history[-20:]:
        messages.append({"role": h.get("role", "user"), "content": h.get("content", "")})
    messages.append({"role": "user", "content": req.message})
    try:
        text = await chat(messages, temperature=0.7)
        return {"response": text}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/stream")
async def chat_stream(req: SendRequest, request: Request):
    """流式：SSE 流式输出"""
    if not req.message.strip():
        raise HTTPException(400, "消息不能为空")

    async def generate():
        messages = []
        if req.system_prompt:
            messages.append({"role": "system", "content": req.system_prompt})
        for h in req.history[-20:]:
            messages.append({"role": h.get("role", "user"), "content": h.get("content", "")})
        messages.append({"role": "user", "content": req.message})
        try:
            full = await chat(messages, temperature=0.7)
            # 按字符流式输出
            chunk_size = 3
            for i in range(0, len(full), chunk_size):
                if await request.is_disconnected():
                    break
                chunk = full[i:i+chunk_size]
                yield f"data: {json.dumps({'text': chunk})}\n\n"
                await asyncio.sleep(0.02)
            yield f"data: {json.dumps({'done': True})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
