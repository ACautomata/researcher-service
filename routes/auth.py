"""用户注册、登录、会话校验、个人 API 配置与 admin 用户管理"""
import re
import secrets
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
    invite_code: str = Field(..., min_length=1)


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
    openclaw_api_base: Optional[str] = None
    openclaw_api_key: Optional[str] = None


class GenerateInviteCodesBody(BaseModel):
    count: int = Field(default=1, ge=1, le=100)
    prefix: Optional[str] = Field(default=None, max_length=8)
    expires_in_days: Optional[int] = Field(default=None, ge=1)


def _validate_username(username: str) -> None:
    if not _USERNAME_RE.match(username.strip()):
        raise HTTPException(
            status_code=400,
            detail="用户名须为 2–32 位，可含字母、数字、下划线或中文",
        )


async def session_user(token: str) -> Optional[dict]:
    rows = await db_query(
        """
        SELECT u.id, u.username, u.role
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
        await db_execute("INSERT INTO user_settings (user_id, theme_color) VALUES (?, 'aurora')", (user_id,))
        rows = await db_query("SELECT * FROM user_settings WHERE user_id = ?", (user_id,))
    return rows[0]


async def build_settings_public_dict(user_id: int) -> dict:
    """供 /auth/settings 与 /user/settings 共用。"""
    row = await _ensure_user_settings(user_id)
    ak = (row.get("ai_api_key") or "").strip()
    ak2 = (row.get("anthropic_api_key") or "").strip()
    oc_key = (row.get("openclaw_api_key") or "").strip()
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
        "openclaw_api_base": (row.get("openclaw_api_base") or "").strip(),
        "openclaw_api_key_set": bool(oc_key),
        "openclaw_api_key_masked": mask_secret(oc_key) if oc_key else None,
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
    if "openclaw_api_base" in patch:
        cols.append("openclaw_api_base = ?")
        vals.append((patch["openclaw_api_base"] or "").strip())
    if "openclaw_api_key" in patch:
        cols.append("openclaw_api_key = ?")
        vals.append((patch["openclaw_api_key"] or "").strip())
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

    # 验证邀请码
    code_rows = await db_query(
        "SELECT id, used_by FROM invite_codes WHERE code=? AND is_active=1 "
        "AND (expires_at IS NULL OR expires_at > datetime('now'))",
        (body.invite_code.strip(),),
    )
    if not code_rows:
        raise HTTPException(status_code=400, detail="邀请码无效或已过期")
    if code_rows[0]["used_by"] is not None:
        raise HTTPException(status_code=400, detail="该邀请码已被使用")
    valid_invite_id = code_rows[0]["id"]

    ph = hash_password(body.password)
    # 所有新注册账号默认均为普通用户
    role = "user"
    uid = await db_execute(
        "INSERT INTO users(username, password_hash, role) VALUES(?, ?, ?)",
        (u, ph, role),
    )
    # 标记邀请码已被使用
    await db_execute(
        "UPDATE invite_codes SET used_by=?, used_at=datetime('now','localtime') WHERE id=? AND used_by IS NULL",
        (uid, valid_invite_id),
    )
    await db_execute("INSERT INTO user_settings (user_id, theme_color) VALUES (?, 'aurora')", (uid,))
    token = new_session_token()
    await db_execute(
        "INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, datetime('now', ?))",
        (token, uid, f"+{AUTH_SESSION_DAYS} days"),
    )
    return {"access_token": token, "token_type": "bearer", "user": {"id": uid, "username": u, "role": role}}


@router.post("/login")
async def login(body: LoginBody):
    u = body.username.strip()
    rows = await db_query(
        "SELECT id, username, role, password_hash FROM users WHERE username = ?",
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
    return {"access_token": token, "token_type": "bearer", "user": {"id": row["id"], "username": row["username"], "role": row.get("role", "user")}}


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


class ChangePasswordBody(BaseModel):
    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8, max_length=128)


@router.put("/password")
async def change_own_password(body: ChangePasswordBody, user: dict = Depends(_current_user)):
    """当前登录用户修改自己的密码"""
    rows = await db_query("SELECT password_hash FROM users WHERE id=?", (user["id"],))
    if not rows or not verify_password(body.current_password, rows[0]["password_hash"]):
        raise HTTPException(status_code=400, detail="当前密码不正确")
    if body.current_password == body.new_password:
        raise HTTPException(status_code=400, detail="新密码不能与当前密码相同")
    ph = hash_password(body.new_password)
    await db_execute("UPDATE users SET password_hash=? WHERE id=?", (ph, user["id"]))
    await db_execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
    return {"success": True, "message": "密码已修改，请重新登录"}


# ===== Admin 用户管理 =====

class AdminPasswordBody(BaseModel):
    password: str = Field(..., min_length=8, max_length=128)


class AdminRoleBody(BaseModel):
    role: str = Field(..., pattern="^(admin|user)$")


async def require_admin(user: dict = Depends(_current_user)) -> dict:
    """当前用户必须为 admin 角色，否则 403。"""
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="仅 admin 可执行此操作")
    return user


@router.get("/admin/users")
async def admin_list_users(_: dict = Depends(require_admin)):
    """列出所有用户（不暴露密码哈希）。"""
    rows = await db_query(
        "SELECT id, username, role, created_at FROM users ORDER BY id"
    )
    return {"users": rows}


@router.put("/admin/users/{user_id}/password")
async def admin_reset_password(user_id: int, body: AdminPasswordBody, _: dict = Depends(require_admin)):
    """admin 重置指定用户的密码，同时清除其会话强制重新登录。"""
    user = await db_query("SELECT id FROM users WHERE id = ?", (user_id,))
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    ph = hash_password(body.password)
    await db_execute("UPDATE users SET password_hash = ? WHERE id = ?", (ph, user_id))
    await db_execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return {"success": True}


@router.put("/admin/users/{user_id}/role")
async def admin_change_role(user_id: int, body: AdminRoleBody, admin: dict = Depends(require_admin)):
    """admin 修改指定用户的角色（不可修改自己）。"""
    user = await db_query("SELECT id, role FROM users WHERE id = ?", (user_id,))
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user[0]["id"] == admin["id"]:
        raise HTTPException(status_code=400, detail="不能修改自己的角色")
    await db_execute("UPDATE users SET role = ? WHERE id = ?", (body.role, user_id))
    return {"success": True, "previous_role": user[0]["role"], "new_role": body.role}


@router.delete("/admin/users/{user_id}")
async def admin_delete_user(user_id: int, admin: dict = Depends(require_admin)):
    """admin 删除指定用户（关联 pipeline 数据置为 NULL 后删除账号）。"""
    user = await db_query("SELECT id, username FROM users WHERE id = ?", (user_id,))
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user[0]["id"] == admin["id"]:
        raise HTTPException(status_code=400, detail="不能删除自己的账号")
    for table in ("papers", "keywords", "entries", "problems", "ideas", "algorithms", "tasks", "domains", "lit_analyses"):
        await db_execute(f"UPDATE {table} SET user_id = NULL WHERE user_id = ?", (user_id,))
    await db_execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    await db_execute("DELETE FROM user_settings WHERE user_id = ?", (user_id,))
    await db_execute("DELETE FROM users WHERE id = ?", (user_id,))
    return {"success": True, "deleted_username": user[0]["username"]}


# ════════════ 邀请码管理（admin） ════════════

@router.get("/admin/invite-codes")
async def admin_list_invite_codes(_: dict = Depends(require_admin)):
    """列出所有邀请码（含创建者和使用者用户名）。"""
    rows = await db_query("""
        SELECT ic.id, ic.code, ic.created_by, cu.username as created_by_username,
               ic.created_at, ic.used_by, uu.username as used_by_username,
               ic.used_at, ic.is_active, ic.expires_at
        FROM invite_codes ic
        LEFT JOIN users cu ON cu.id = ic.created_by
        LEFT JOIN users uu ON uu.id = ic.used_by
        ORDER BY ic.id DESC
    """)
    return {"invite_codes": rows}


@router.post("/admin/invite-codes")
async def admin_generate_invite_codes(body: GenerateInviteCodesBody, admin: dict = Depends(require_admin)):
    """管理员生成邀请码。"""
    codes = []
    for _ in range(body.count):
        token = secrets.token_hex(8)
        code_str = f"{body.prefix}_{token}" if body.prefix else token
        if body.expires_in_days:
            cid = await db_execute(
                "INSERT INTO invite_codes(code, created_by, expires_at) "
                "VALUES(?, ?, datetime('now', ?))",
                (code_str, admin["id"], f"+{body.expires_in_days} days"),
            )
        else:
            cid = await db_execute(
                "INSERT INTO invite_codes(code, created_by) VALUES(?, ?)",
                (code_str, admin["id"]),
            )
        codes.append({"id": cid, "code": code_str})
    return {"invite_codes": codes, "count": len(codes)}


@router.put("/admin/invite-codes/{code_id}/toggle")
async def admin_toggle_invite_code(code_id: int, _: dict = Depends(require_admin)):
    """停用/启停邀请码（仅限未使用的码）。"""
    row = await db_query("SELECT is_active, used_by FROM invite_codes WHERE id=?", (code_id,))
    if not row:
        raise HTTPException(status_code=404, detail="邀请码不存在")
    if row[0]["used_by"] is not None:
        raise HTTPException(status_code=400, detail="该邀请码已被使用，无法修改状态")
    new_state = 0 if row[0]["is_active"] else 1
    await db_execute("UPDATE invite_codes SET is_active=? WHERE id=?", (new_state, code_id))
    return {"success": True, "is_active": bool(new_state)}


@router.delete("/admin/invite-codes/{code_id}")
async def admin_delete_invite_code(code_id: int, _: dict = Depends(require_admin)):
    """删除邀请码（仅限未使用的码，保留审计记录）。"""
    row = await db_query("SELECT id, used_by FROM invite_codes WHERE id=?", (code_id,))
    if not row:
        raise HTTPException(status_code=404, detail="邀请码不存在")
    if row[0]["used_by"] is not None:
        raise HTTPException(status_code=400, detail="该邀请码已被使用，无法删除（保留审计记录）")
    await db_execute("DELETE FROM invite_codes WHERE id=?", (code_id,))
    return {"success": True}
