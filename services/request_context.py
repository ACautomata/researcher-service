"""请求级用户上下文（供 AI / Agent 读取个人配置）"""
from contextvars import ContextVar
from typing import Optional

ctx_user_id: ContextVar[Optional[int]] = ContextVar("ctx_user_id", default=None)
