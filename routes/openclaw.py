"""OpenClaw 网关桥接路由 —— 将 OpenClaw Agent 平台能力接入 Pipeline"""
import json
import uuid
import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Query
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

from database import db_execute, update_task
from services.data_filter import current_user_id
from services.openclaw_service import (
    chat, chat_stream, health, list_agents,
)
from config import OPENCLAW_ENABLED

router = APIRouter(prefix="/api/v1/openclaw", tags=["OpenClaw"])

_openclaw_event_queues: dict[str, asyncio.Queue] = {}


class ChatRequest(BaseModel):
    agent_id: str = "main"
    message: str
    history: Optional[list] = None
    system_prompt: Optional[str] = None
    temperature: float = 0.7
    max_tokens: int = 4096


class PaperReviewRequest(BaseModel):
    agent_id: str = "paper-review"
    message: str
    system_prompt: Optional[str] = None


# ── 健康检查 ──────────────────────────────────────────────

@router.get("/health")
async def openclaw_health():
    if not OPENCLAW_ENABLED:
        return {"enabled": False, "reachable": False}
    result = await health()
    return {"enabled": True, **result}


# ── Agent 列表 ────────────────────────────────────────────

@router.get("/agents")
async def openclaw_agents():
    if not OPENCLAW_ENABLED:
        return {"agents": [], "enabled": False}
    return {"agents": await list_agents(), "enabled": True}


# ── 非流式对话 ────────────────────────────────────────────

@router.post("/chat")
async def openclaw_chat(req: ChatRequest):
    """向 OpenClaw Agent 发送消息，返回完整回复"""
    result = await chat(
        agent_id=req.agent_id,
        message=req.message,
        history=req.history,
        system_prompt=req.system_prompt,
        temperature=req.temperature,
        max_tokens=req.max_tokens,
    )
    return result


# ── SSE 流式对话 ───────────────────────────────────────────

@router.post("/chat/stream")
async def openclaw_chat_stream_start(req: ChatRequest):
    """启动 OpenClaw Agent 流式对话，返回 task_id"""
    uid = current_user_id()
    tid = f"openclaw_{uuid.uuid4().hex[:8]}"
    _openclaw_event_queues[tid] = asyncio.Queue()
    await db_execute(
        "INSERT INTO tasks(id,type,status,progress,step,user_id) VALUES(?,'openclaw','running',0,'连接OpenClaw',?)",
        (tid, uid),
    )

    async def _run():
        try:
            async for sse_event in chat_stream(
                agent_id=req.agent_id,
                message=req.message,
                history=req.history,
                system_prompt=req.system_prompt,
                temperature=req.temperature,
                max_tokens=req.max_tokens,
            ):
                await _openclaw_event_queues[tid].put(sse_event)
        except Exception as e:
            await _openclaw_event_queues[tid].put(
                f"data: {json.dumps({'type': 'error', 'text': str(e)})}\n\n"
            )
        await _openclaw_event_queues[tid].put("__DONE__")

    asyncio.create_task(_run())
    return {"task_id": tid, "status": "running"}


@router.get("/chat/{tid}/stream")
async def openclaw_chat_stream_events(tid: str, request: Request):
    """SSE 事件流 —— 供 EventSource 消费"""
    queue = _openclaw_event_queues.get(tid)
    if queue is None:
        raise HTTPException(404, "会话不存在或已过期")

    async def generate():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    if event == "__DONE__":
                        await update_task(tid, 100, "完成", "completed")
                        break
                    yield event
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            _openclaw_event_queues.pop(tid, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── 论文评审（异步任务模式） ──────────────────────────────

@router.post("/paper-review")
async def openclaw_paper_review(req: PaperReviewRequest):
    """启动论文评审流水线（5阶段分析），返回 task_id"""
    uid = current_user_id()
    tid = f"openclaw_review_{uuid.uuid4().hex[:8]}"
    await db_execute(
        "INSERT INTO tasks(id,type,status,progress,step,user_id) VALUES(?,'openclaw_review','running',0,'启动论文评审',?)",
        (tid, uid),
    )

    async def _do_review():
        try:
            full_response = ""
            await update_task(tid, 5, "正在分析论文...")
            async for sse_event in chat_stream(
                agent_id=req.agent_id,
                message=req.message,
                system_prompt=req.system_prompt or (
                    "你是一位严谨的学术论文评审专家。请对用户提供的论文执行完整的5阶段分析：\n"
                    "1. Wiki条目整理 —— 结构化提取论文元信息、背景、方法、实验\n"
                    "2. 实验深度提取 —— 提取实验设置、结果、消融、参数敏感性\n"
                    "3. 评审式问题分析 —— 从新颖性、重要性、证据充分性等9个维度审视\n"
                    "4. 验证实验设计 —— 设计可执行的验证实验\n"
                    "5. Codex任务提示生成 —— 生成代码实现任务提示\n\n"
                    "请逐步输出分析结果。"
                ),
                temperature=0.3,
                max_tokens=8192,
            ):
                data_str = sse_event
                if data_str.startswith("data: "):
                    try:
                        evt = json.loads(data_str[6:])
                        if evt.get("type") == "text":
                            full_response += evt.get("text", "")
                            progress = min(90, 5 + len(full_response) // 100)
                            await update_task(tid, progress, "分析中...")
                        elif evt.get("type") == "done":
                            break
                    except json.JSONDecodeError:
                        pass
            await update_task(tid, 100, "评审完成", "completed",
                              result={"response": full_response})
        except Exception as e:
            await update_task(tid, 0, str(e), "error", error=str(e))

    asyncio.create_task(_do_review())
    return {"task_id": tid, "status": "running"}


@router.get("/paper-review/{tid}/progress")
async def openclaw_paper_review_progress(tid: str):
    """查询论文评审进度"""
    from database import db_query
    rows = await db_query("SELECT * FROM tasks WHERE id = ?", (tid,))
    if not rows:
        raise HTTPException(404, "任务不存在")
    t = rows[0]
    return {
        "task_id": tid,
        "status": t["status"],
        "progress": t["progress"],
        "step": t["step"],
        "result": json.loads(t["result_json"]) if t["result_json"] else None,
        "error": t["error"],
    }


# ── 应用配置到 Docker ──────────────────────────────────────

class ApplyConfigRequest(BaseModel):
    api_key: Optional[str] = None
    api_base: Optional[str] = None


@router.post("/apply-config")
async def openclaw_apply_config(req: ApplyConfigRequest, request: Request):
    """将 API Key 写入 Docker 的 openclaw.json 并重启 OpenClaw 容器"""
    import subprocess, tempfile, os as _os

    if not OPENCLAW_ENABLED:
        raise HTTPException(400, "OpenClaw 未启用")

    try:
        # 1. 更新 Docker .env
        env_path = "/root/openclaw-docker-cn-im-main/.env"
        if _os.path.exists(env_path):
            lines = open(env_path).readlines()
            new_lines = []
            for line in lines:
                if line.startswith("DEEPSEEK_API_KEY="):
                    if req.api_key:
                        new_lines.append(f"DEEPSEEK_API_KEY={req.api_key}\n")
                    continue
                new_lines.append(line)
            open(env_path, "w").writelines(new_lines)

        # 2. 更新 openclaw.json 中的模型配置
        import json as _json
        oc_config = "/root/.openclaw/openclaw.json"
        if _os.path.exists(oc_config):
            data = _json.load(open(oc_config))
            providers = data.get("models", {}).get("providers", {})
            # 找到 deepseek provider
            for provider_name, provider in list(providers.items()):
                if "deepseek" in provider_name.lower():
                    if req.api_base:
                        provider["baseUrl"] = req.api_base
                    if req.api_key:
                        provider["apiKey"] = req.api_key
            # 确保 gateway http responses 启用
            gw = data.setdefault("gateway", {})
            gw_http = gw.setdefault("http", {})
            gw_ep = gw_http.setdefault("endpoints", {})
            gw_ep["responses"] = {"enabled": True}
            _json.dump(data, open(oc_config, "w"), indent=2, ensure_ascii=False)

        # 3. 重启 Docker 容器
        result = subprocess.run(
            ["docker", "compose", "restart"],
            cwd="/root/openclaw-docker-cn-im-main",
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr or "重启失败")

        return {"success": True, "message": "配置已应用，OpenClaw 正在重启"}
    except Exception as e:
        raise HTTPException(500, f"应用配置失败: {str(e)}")

@router.get("/sessions")
async def openclaw_sessions():
    return {
        "sessions": list(_openclaw_event_queues.keys()),
        "count": len(_openclaw_event_queues),
    }
