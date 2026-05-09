"""个人 API 配置（与 /auth/settings 等价，避免部分环境下 /auth/* 路径异常）"""
from fastapi import APIRouter, Depends

from routes.auth import UserSettingsUpdate, _current_user, apply_user_settings_patch, build_settings_public_dict

router = APIRouter(prefix="/api/v1/user", tags=["用户配置"])


@router.get("/settings")
async def get_user_settings(user: dict = Depends(_current_user)):
    return await build_settings_public_dict(user["id"])


@router.put("/settings")
async def put_user_settings(body: UserSettingsUpdate, user: dict = Depends(_current_user)):
    patch = body.model_dump(exclude_unset=True)
    await apply_user_settings_patch(user["id"], patch)
    return {"success": True}
