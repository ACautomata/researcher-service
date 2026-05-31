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
    files: Optional[list] = None  # [{name, data, type}]


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
                files=req.files,
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
    api_model: Optional[str] = None


@router.post("/apply-config")
async def openclaw_apply_config(req: ApplyConfigRequest, request: Request):
    """将界面 API 配置写入 Docker 的 openclaw.json 并重启 OpenClaw 容器"""
    import subprocess, tempfile, os as _os

    if not OPENCLAW_ENABLED:
        raise HTTPException(400, "OpenClaw 未启用")

    api_base = (req.api_base or "").strip()
    api_key = (req.api_key or "").strip()
    api_model = (req.api_model or "").strip()

    if not api_base and not api_key:
        raise HTTPException(400, "请提供 API Base URL 或 API Key")

    # ── 自动推断 provider 名称 & 协议 ──
    base_lower = api_base.lower()
    if "deepseek" in base_lower:
        provider_name = "deepseek"
        model_id = api_model or "deepseek-v4-pro"
        model_alias = "DeepSeek V4 Pro"
        api_protocol = "anthropic-messages"
        context_window = 131072
        max_tokens = 131072
    elif "anthropic" in base_lower:
        provider_name = "anthropic"
        model_id = api_model or "claude-sonnet-4-20250514"
        model_alias = model_id
        api_protocol = "anthropic-messages"
        context_window = 200000
        max_tokens = 8192
    else:
        provider_name = "custom"
        model_id = api_model or "default-model"
        model_alias = model_id
        api_protocol = "anthropic-messages"
        context_window = 131072
        max_tokens = 4096

    try:
        import json as _json

        # ── 1. 更新 Docker .env ──
        env_path = "/root/openclaw-docker-cn-im-main/.env"
        if _os.path.exists(env_path):
            env_lines = open(env_path).readlines()
            new_lines = []
            for line in env_lines:
                if line.startswith("DEEPSEEK_API_KEY=") and api_key:
                    new_lines.append(f"DEEPSEEK_API_KEY={api_key}\n")
                else:
                    new_lines.append(line)
            open(env_path, "w").writelines(new_lines)

        # ── 2. 完整替换 openclaw.json 模型配置 ──
        oc_config = "/root/.openclaw/openclaw.json"
        if not _os.path.exists(oc_config):
            raise HTTPException(500, "openclaw.json 不存在")

        data = _json.load(open(oc_config))

        # 替换 models.providers（清空旧的，写入新的）
        data["models"]["providers"] = {
            provider_name: {
                "baseUrl": api_base,
                "apiKey": api_key,
                "api": api_protocol,
                "authHeader": True,
                "models": [
                    {
                        "id": model_id,
                        "name": model_alias,
                        "reasoning": True,
                        "input": ["text"],
                        "contextWindow": context_window,
                        "maxTokens": max_tokens,
                    }
                ],
            }
        }

        # 更新 agent 默认模型
        if "agents" not in data:
            data["agents"] = {}
        if "defaults" not in data["agents"]:
            data["agents"]["defaults"] = {}
        data["agents"]["defaults"]["model"] = {
            "primary": f"{provider_name}/{model_id}"
        }
        data["agents"]["defaults"]["models"] = {
            f"{provider_name}/{model_id}": {"alias": model_alias}
        }

        # 更新 auth profiles
        data["auth"]["profiles"] = {
            f"{provider_name}:default": {
                "provider": provider_name,
                "mode": "api_key",
            }
        }

        # 确保 gateway http responses 启用
        gw = data.setdefault("gateway", {})
        gw_http = gw.setdefault("http", {})
        gw_ep = gw_http.setdefault("endpoints", {})
        gw_ep["responses"] = {"enabled": True}

        # 确保 contextEngine 使用 legacy（Docker 镜像无 lossless-claw）
        if "plugins" not in data:
            data["plugins"] = {}
        if "slots" not in data["plugins"]:
            data["plugins"]["slots"] = {}
        data["plugins"]["slots"]["contextEngine"] = "legacy"

        _json.dump(data, open(oc_config, "w"), indent=2, ensure_ascii=False)

        # ── 5. 为每个子 Agent 创建 auth-profiles.json ──
        agent_auth = {f"{provider_name}:default": {"api_key": api_key}}
        for sub_id in ["autoresearch", "paper-review", "idea-generate"]:
            sub_dir = f"/root/.openclaw/agents/{sub_id}/agent"
            _os.makedirs(sub_dir, exist_ok=True)
            auth_path = _os.path.join(sub_dir, "auth-profiles.json")
            _json.dump(agent_auth, open(auth_path, "w"), indent=2)

        # ── 3. 写入容器并重启 ──
        # 策略: compose restart → init.sh 覆盖 → sleep → docker cp 回写 → 等待 gateway 重读
        subprocess.run(
            ["docker", "compose", "restart"],
            cwd="/root/openclaw-docker-cn-im-main",
            capture_output=True, text=True, timeout=30
        )
        # 等待容器启动完成（init.sh 此时已覆盖配置）
        import time
        time.sleep(18)
        # 重新推送我们的配置
        subprocess.run(
            ["docker", "cp", oc_config, "openclaw-gateway:/home/node/.openclaw/openclaw.json"],
            capture_output=True, text=True, timeout=10
        )
        # 推送子 Agent auth-profiles
        for sub_id in ["autoresearch", "paper-review", "idea-generate"]:
            auth_path = f"/root/.openclaw/agents/{sub_id}/agent/auth-profiles.json"
            if _os.path.exists(auth_path):
                subprocess.run(
                    ["docker", "cp", auth_path, f"openclaw-gateway:/home/node/.openclaw/agents/{sub_id}/agent/auth-profiles.json"],
                    capture_output=True, text=True, timeout=10
                )
        # 热重启网关进程（kill 后 init.sh 会重新启动它，读新配置）
        # 如果 kill 导致容器重启，配置可能被覆盖，已通过上面 docker cp 处理
        subprocess.run(
            ["docker", "exec", "openclaw-gateway", "sh", "-c",
             "pkill -f 'openclaw' 2>/dev/null; echo done"],
            capture_output=True, text=True, timeout=15
        )
        # 额外等 15 秒确保 gateway 完全就绪
        time.sleep(15)
        # 如果容器恰好重启了，再补一次 docker cp
        subprocess.run(
            ["docker", "cp", oc_config, "openclaw-gateway:/home/node/.openclaw/openclaw.json"],
            capture_output=True, text=True, timeout=10
        )
        for sub_id in ["autoresearch", "paper-review", "idea-generate"]:
            auth_path = f"/root/.openclaw/agents/{sub_id}/agent/auth-profiles.json"
            if _os.path.exists(auth_path):
                subprocess.run(
                    ["docker", "cp", auth_path, f"openclaw-gateway:/home/node/.openclaw/agents/{sub_id}/agent/auth-profiles.json"],
                    capture_output=True, text=True, timeout=10
                )
        time.sleep(5)

        return {
            "success": True,
            "message": f"已切换到 {model_alias} ({api_protocol})，OpenClaw 正在重启",
            "provider": provider_name,
            "model": model_id,
            "protocol": api_protocol,
        }
    except Exception as e:
        raise HTTPException(500, f"应用配置失败: {str(e)}")


# ── 状态面板 ──────────────────────────────────────────────

@router.get("/status")
async def openclaw_status():
    import subprocess, os as _os, json as _json

    result = {
        "enabled": OPENCLAW_ENABLED,
        "gateway": {"reachable": False, "version": None},
        "container": {"running": False, "name": "openclaw-gateway"},
        "agents": [],
        "model_provider": None,
        "active_sessions": len(_openclaw_event_queues),
    }

    if not OPENCLAW_ENABLED:
        return result

    # Gateway health
    h = await health()
    result["gateway"]["reachable"] = h.get("reachable", False)
    if h.get("reachable"):
        try:
            body = _json.loads(h.get("body", "{}"))
            result["gateway"]["status"] = body.get("status", "unknown")
        except Exception:
            pass

    # Docker container status
    try:
        r = subprocess.run(
            ["docker", "inspect", "openclaw-gateway"],
            capture_output=True, text=True, timeout=10
        )
        if r.returncode == 0:
            info = _json.loads(r.stdout)[0]
            state = info.get("State", {})
            result["container"]["running"] = state.get("Running", False)
            result["container"]["status"] = state.get("Status", "unknown")
            result["container"]["started_at"] = state.get("StartedAt", "")
            result["container"]["image"] = info.get("Config", {}).get("Image", "")
    except Exception:
        pass

    # Agent / sub-agent info from openclaw.json
    oc_config = "/root/.openclaw/openclaw.json"
    if _os.path.exists(oc_config):
        try:
            data = _json.load(open(oc_config))
            agents_list = data.get("agents", {}).get("list", [])
            subagents_config = data.get("agents", {}).get("defaults", {}).get("subagents", {})
            allow_agents = subagents_config.get("allowAgents", [])

            for agent in agents_list:
                agent_id = agent.get("id", "unknown")
                result["agents"].append({
                    "id": agent_id,
                    "name": agent.get("name", agent_id),
                    "is_default": agent.get("default", False),
                    "is_subagent": agent_id in allow_agents,
                    "workspace": agent.get("workspace", ""),
                })

            # Count defined sub-agents
            result["subagent_count"] = len(allow_agents)
            result["agent_count"] = len(agents_list)

            # Model provider
            providers = data.get("models", {}).get("providers", {})
            for name, p in providers.items():
                result["model_provider"] = {
                    "name": name,
                    "base_url": p.get("baseUrl", ""),
                    "api": p.get("api", ""),
                    "models": [m.get("id") for m in p.get("models", [])],
                }
                break  # Just first one
        except Exception:
            pass

    return result


# ── 会话列表 ──────────────────────────────────────────────

@router.get("/sessions")
async def openclaw_sessions():
    return {
        "sessions": list(_openclaw_event_queues.keys()),
        "count": len(_openclaw_event_queues),
    }
