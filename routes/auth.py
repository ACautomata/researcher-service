"""用户注册、登录、会话校验与个人 API 配置"""
import re
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from config import AUTH_ENABLED, AUTH_SESSION_DAYS, PIPELINE_REQUIRES_LOGIN
from database import db_query, db_execute
from services.auth_crypto import hash_password, verify_password, new_session_token
from services.user_credentials import mask_secret

router = APIRouter(prefix="/api/v1/auth", tags=["认证"])


_USERNAME_RE = re.compile(r"^[a-zA-Z0-9_\u4e00-\u9fff]{2,32}$")


class RegisterBody(BaseModel):
    username: str = Field(..., min_length=2, max_length=32)
    password: str = Field(..., min_length=8, max_length=128)


class LoginBody(BaseModel):
    username: str
    password: str


class UserSettingsUpdate(BaseModel):
    ai_api_base: Optional[str] = None
    ai_api_key: Optional[str] = None
    ai_model: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    anthropic_base_url: Optional[str] = None
    anthropic_model: Optional[str] = None
    theme_color: Optional[str] = None  # 用户主题配色：emerald/aurora/flame/nebula/ocean/mint/sunset/sakura


def _validate_username(username: str) -> None:
    if not _USERNAME_RE.match(username.strip()):
        raise HTTPException(
            status_code=400,
            detail="用户名须为 2–32 位，可含字母、数字、下划线或中文",
        )


async def session_user(token: str) -> Optional[dict]:
    rows = await db_query(
        """
        SELECT u.id, u.username
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
        """,
        (token,),
    )
    return rows[0] if rows else None


async def _current_user(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    user = await session_user(authorization[7:].strip())
    if not user:
        raise HTTPException(status_code=401, detail="登录已失效")
    return user


async def _ensure_user_settings(user_id: int) -> dict:
    rows = await db_query("SELECT * FROM user_settings WHERE user_id = ?", (user_id,))
    if not rows:
        await db_execute("INSERT INTO user_settings (user_id) VALUES (?)", (user_id,))
        rows = await db_query("SELECT * FROM user_settings WHERE user_id = ?", (user_id,))
    return rows[0]


async def build_settings_public_dict(user_id: int) -> dict:
    """供 /auth/settings 与 /user/settings 共用。"""
    row = await _ensure_user_settings(user_id)
    ak = (row.get("ai_api_key") or "").strip()
    ak2 = (row.get("anthropic_api_key") or "").strip()
    return {
        "ai_api_base": (row.get("ai_api_base") or "").strip(),
        "ai_model": (row.get("ai_model") or "").strip(),
        "ai_api_key_set": bool(ak),
        "ai_api_key_masked": mask_secret(ak) if ak else None,
        "anthropic_base_url": (row.get("anthropic_base_url") or "").strip(),
        "anthropic_model": (row.get("anthropic_model") or "").strip(),
        "anthropic_api_key_set": bool(ak2),
        "anthropic_api_key_masked": mask_secret(ak2) if ak2 else None,
        "theme_color": (row.get("theme_color") or "aurora").strip(),
    }


async def apply_user_settings_patch(user_id: int, patch: dict) -> None:
    if not patch:
        return
    await _ensure_user_settings(user_id)
    cols, vals = [], []
    if "ai_api_base" in patch:
        cols.append("ai_api_base = ?")
        vals.append((patch["ai_api_base"] or "").strip())
    if "ai_api_key" in patch:
        cols.append("ai_api_key = ?")
        vals.append((patch["ai_api_key"] or "").strip())
    if "ai_model" in patch:
        cols.append("ai_model = ?")
        vals.append((patch["ai_model"] or "").strip())
    if "anthropic_api_key" in patch:
        cols.append("anthropic_api_key = ?")
        vals.append((patch["anthropic_api_key"] or "").strip())
    if "anthropic_base_url" in patch:
        cols.append("anthropic_base_url = ?")
        vals.append((patch["anthropic_base_url"] or "").strip())
    if "anthropic_model" in patch:
        cols.append("anthropic_model = ?")
        vals.append((patch["anthropic_model"] or "").strip())
    if "theme_color" in patch:
        cols.append("theme_color = ?")
        vals.append((patch["theme_color"] or "aurora").strip())
    if not cols:
        return
    cols.append("updated_at = datetime('now','localtime')")
    vals.append(user_id)
    await db_execute(
        f"UPDATE user_settings SET {', '.join(cols)} WHERE user_id = ?",
        tuple(vals),
    )


@router.get("/config")
async def auth_config():
    return {
        "auth_required": AUTH_ENABLED,
        "pipeline_requires_login": PIPELINE_REQUIRES_LOGIN,
    }


@router.post("/register")
async def register(body: RegisterBody):
    u = body.username.strip()
    _validate_username(u)
    exists = await db_query("SELECT id FROM users WHERE username = ?", (u,))
    if exists:
        raise HTTPException(status_code=400, detail="该用户名已被注册")
    ph = hash_password(body.password)
    uid = await db_execute(
        "INSERT INTO users(username, password_hash) VALUES(?, ?)",
        (u, ph),
    )
    await db_execute("INSERT INTO user_settings (user_id) VALUES (?)", (uid,))
    token = new_session_token()
    await db_execute(
        "INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, datetime('now', ?))",
        (token, uid, f"+{AUTH_SESSION_DAYS} days"),
    )
    return {"access_token": token, "token_type": "bearer", "user": {"id": uid, "username": u}}


@router.post("/login")
async def login(body: LoginBody):
    u = body.username.strip()
    rows = await db_query(
        "SELECT id, username, password_hash FROM users WHERE username = ?",
        (u,),
    )
    if not rows or not verify_password(body.password, rows[0]["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    row = rows[0]
    token = new_session_token()
    await db_execute(
        "INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, datetime('now', ?))",
        (token, row["id"], f"+{AUTH_SESSION_DAYS} days"),
    )
    return {"access_token": token, "token_type": "bearer", "user": {"id": row["id"], "username": row["username"]}}


@router.get("/me")
async def me(authorization: Optional[str] = Header(default=None, alias="Authorization")):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="未提供凭证")
    token = authorization[7:].strip()
    user = await session_user(token)
    if not user:
        raise HTTPException(status_code=401, detail="登录已失效")
    return {"user": user}


@router.post("/logout")
async def logout(authorization: Optional[str] = Header(default=None, alias="Authorization")):
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
        await db_execute("DELETE FROM sessions WHERE token = ?", (token,))
    return {"success": True}


@router.get("/settings")
async def get_settings(user: dict = Depends(_current_user)):
    return await build_settings_public_dict(user["id"])


@router.put("/settings")
async def put_settings(body: UserSettingsUpdate, user: dict = Depends(_current_user)):
    patch = body.model_dump(exclude_unset=True)
    await apply_user_settings_patch(user["id"], patch)
    return {"success": True}
