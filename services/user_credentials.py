"""当前登录用户的 LLM / Agent 凭证（无用户或库中无记录时使用全局 .env）"""
from typing import Optional, Tuple

from config import (
    AI_API_BASE,
    AI_API_KEY,
    AI_MODEL,
    ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL,
    OPENCLAW_GATEWAY_URL,
    OPENCLAW_GATEWAY_TOKEN,
)
from database import db_query
from services.request_context import ctx_user_id


async def get_effective_llm() -> Tuple[str, str, str]:
    """(api_base, api_key, model)"""
    uid = ctx_user_id.get()
    if not uid:
        return AI_API_BASE, AI_API_KEY, AI_MODEL
    rows = await db_query(
        "SELECT ai_api_base, ai_api_key, ai_model FROM user_settings WHERE user_id = ?",
        (uid,),
    )
    if not rows:
        return AI_API_BASE, AI_API_KEY, AI_MODEL
    r = rows[0]
    base = (r.get("ai_api_base") or "").strip() or AI_API_BASE
    key = (r.get("ai_api_key") or "").strip() or AI_API_KEY
    model = (r.get("ai_model") or "").strip() or AI_MODEL
    return base, key, model


async def get_effective_agent() -> Tuple[str, str, str]:
    """(anthropic_key, anthropic_base_url, anthropic_model)"""
    uid = ctx_user_id.get()
    if not uid:
        return ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL or "", ANTHROPIC_MODEL
    rows = await db_query(
        "SELECT anthropic_api_key, anthropic_base_url, anthropic_model FROM user_settings WHERE user_id = ?",
        (uid,),
    )
    if not rows:
        return ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL or "", ANTHROPIC_MODEL
    r = rows[0]
    key = (r.get("anthropic_api_key") or "").strip() or ANTHROPIC_API_KEY
    base = (r.get("anthropic_base_url") or "").strip() or (ANTHROPIC_BASE_URL or "")
    model = (r.get("anthropic_model") or "").strip() or ANTHROPIC_MODEL
    return key, base, model


def mask_secret(s: Optional[str]) -> Optional[str]:
    if not s or len(s) < 10:
        return None
    return s[:4] + "…" + s[-4:]


async def get_effective_openclaw() -> Tuple[str, str, str]:
    """(openclaw_api_base, openclaw_api_key, openclaw_gateway_token)"""
    uid = ctx_user_id.get()
    if not uid:
        return OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, ""
    rows = await db_query(
        "SELECT openclaw_api_base, openclaw_api_key FROM user_settings WHERE user_id = ?",
        (uid,),
    )
    if not rows:
        return OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, ""
    r = rows[0]
    base = (r.get("openclaw_api_base") or "").strip() or OPENCLAW_GATEWAY_URL
    key = (r.get("openclaw_api_key") or "").strip()
    return base, OPENCLAW_GATEWAY_TOKEN, key
