"""Claude Agent 路由 —— SSE 流式输出"""
import json
import uuid
import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from database import db_execute, db_query, update_task
from services.agent_service import run_agent

router = APIRouter(prefix="/api/v1/agent", tags=["Agent"])

_sessions: dict[str, asyncio.Queue] = {}


class ChatRequest(BaseModel):
    prompt: str
    cwd: Optional[str] = "."
    max_turns: int = 15
    system_prompt: Optional[str] = None


@router.post("/chat")
async def agent_chat(req: ChatRequest):
    tid = f"agent_{uuid.uuid4().hex[:8]}"
    _sessions[tid] = asyncio.Queue()
    await db_execute(
        "INSERT INTO tasks(id,type,status,progress,step) VALUES(?,'agent','running',0,'初始化Agent')",
        (tid,),
    )
    asyncio.create_task(
        run_agent(
            prompt=req.prompt,
            cwd=req.cwd,
            event_queue=_sessions[tid],
            max_turns=req.max_turns,
            system_prompt=req.system_prompt,
        )
    )
    return {"task_id": tid, "status": "running"}


@router.get("/chat/{tid}/stream")
async def agent_chat_stream(tid: str, request: Request):
    queue = _sessions.get(tid)
    if queue is None:
        raise HTTPException(404, "会话不存在或已过期")

    async def generate():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    if event.get("type") in ("done", "error_done"):
                        await update_task(
                            tid,
                            100,
                            "完成" if event.get("type") == "done" else "错误",
                            "completed" if event.get("type") == "done" else "error",
                        )
                        break
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            _sessions.pop(tid, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/sessions")
async def agent_sessions():
    return {"sessions": list(_sessions.keys()), "count": len(_sessions)}
