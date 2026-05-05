"""Claude Agent SDK 封装 —— 跨平台（Windows/Linux/macOS）"""
import os
import sys
import json
import asyncio
import threading
import queue as thread_queue
from typing import Optional

from config import ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, AGENT_AUTO_APPROVE


async def run_agent(
    prompt: str,
    cwd: str = ".",
    event_queue: asyncio.Queue | None = None,
    max_turns: int = 15,
    system_prompt: Optional[str] = None,
):
    queue = event_queue or asyncio.Queue()

    if not ANTHROPIC_API_KEY:
        await queue.put({"type": "error", "text": "请先在 .env 中配置 AI_API_KEY"})
        await queue.put({"type": "done"})
        return

    abs_cwd = os.path.abspath(os.path.expanduser(cwd))
    if not os.path.isdir(abs_cwd):
        await queue.put({"type": "error", "text": f"工作目录不存在: {abs_cwd}"})
        await queue.put({"type": "done"})
        return

    cli_env = {
        "ANTHROPIC_API_KEY": ANTHROPIC_API_KEY,
    }
    if ANTHROPIC_BASE_URL:
        cli_env["ANTHROPIC_BASE_URL"] = ANTHROPIC_BASE_URL
        cli_env["ANTHROPIC_API_URL"] = ANTHROPIC_BASE_URL

    bridge = thread_queue.Queue()

    def _run_in_thread():
        from claude_agent_sdk import query, ClaudeAgentOptions

        # 确保有支持 subprocess 的 event loop
        loop = asyncio.ProactorEventLoop() if sys.platform == "win32" else asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        def _on_stderr(line: str):
            line = line.strip()
            if line:
                bridge.put({"type": "stderr", "text": line})

        options = ClaudeAgentOptions(
            cwd=abs_cwd,
            max_turns=max_turns,
            model=ANTHROPIC_MODEL,
            permission_mode="bypassPermissions" if AGENT_AUTO_APPROVE else "default",
            system_prompt=system_prompt or "",
            stderr=_on_stderr,
            env=cli_env,
            load_timeout_ms=30000,
        )

        async def _query():
            try:
                gen = query(prompt=prompt, options=options)
                first = await asyncio.wait_for(anext(gen), timeout=30.0)
                bridge.put(_serialize(first))
                async for msg in gen:
                    bridge.put(_serialize(msg))
            except asyncio.TimeoutError:
                bridge.put({"type": "error", "text": "Agent 启动超时"})
            except Exception as e:
                bridge.put({"type": "error", "text": str(e)})
            bridge.put({"type": "done"})

        loop.run_until_complete(_query())
        loop.close()

    thread = threading.Thread(target=_run_in_thread, daemon=True)
    thread.start()

    try:
        while True:
            try:
                event = await asyncio.get_running_loop().run_in_executor(
                    None, lambda: bridge.get(timeout=0.5)
                )
                await queue.put(event)
                if event.get("type") in ("done",):
                    break
            except thread_queue.Empty:
                pass
    finally:
        thread.join(timeout=10)


# ============================================================
# 序列化 (deferred import 避免污染 module 顶层)
# ============================================================

def _serialize(msg) -> dict:
    from claude_agent_sdk.types import (
        SystemMessage, AssistantMessage, UserMessage, ResultMessage,
        TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock,
        ServerToolUseBlock, ServerToolResultBlock,
    )

    if isinstance(msg, SystemMessage):
        return {"type": "system", "subtype": getattr(msg, "subtype", ""),
                "data": str(getattr(msg, "data", ""))}

    if isinstance(msg, AssistantMessage):
        return {"type": "assistant", "model": msg.model,
                "stop_reason": msg.stop_reason, "usage": msg.usage,
                "blocks": [_block(b) for b in msg.content]}

    if isinstance(msg, UserMessage):
        if isinstance(msg.content, list):
            return {"type": "user", "blocks": [_block(b) for b in msg.content]}
        return {"type": "user", "blocks": [{"type": "text", "text": str(msg.content)}]}

    if isinstance(msg, ResultMessage):
        return {"type": "result", "subtype": msg.subtype,
                "duration_ms": msg.duration_ms, "num_turns": msg.num_turns,
                "is_error": msg.is_error, "stop_reason": msg.stop_reason,
                "total_cost_usd": msg.total_cost_usd, "errors": msg.errors,
                "usage": msg.usage}

    return {"type": "unknown", "text": str(msg)}


def _block(b) -> dict:
    from claude_agent_sdk.types import (
        TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock,
        ServerToolUseBlock, ServerToolResultBlock,
    )

    if isinstance(b, TextBlock):
        return {"type": "text", "text": b.text}
    if isinstance(b, ThinkingBlock):
        return {"type": "thinking", "text": getattr(b, "text", str(b))}
    if isinstance(b, ToolUseBlock):
        return {"type": "tool_use", "id": b.id, "name": b.name, "input": b.input}
    if isinstance(b, ToolResultBlock):
        content = b.content
        if isinstance(content, list):
            content = json.dumps(content, ensure_ascii=False)
        return {"type": "tool_result", "tool_use_id": b.tool_use_id,
                "content": str(content) if content else "", "is_error": b.is_error}
    if isinstance(b, (ServerToolUseBlock, ServerToolResultBlock)):
        return {"type": "server_tool", "name": getattr(b, "name", ""), "data": str(b)}
    return {"type": "unknown_block", "text": str(b)}
