"""数据隔离辅助：按用户角色过滤数据行"""
from typing import Optional, Tuple
from services.request_context import ctx_user_id, ctx_user_role


def current_user_id() -> Optional[int]:
    """当前请求的 user_id，未登录时返回 None。"""
    return ctx_user_id.get()


def current_user_role() -> Optional[str]:
    """当前请求的角色，未登录时返回 None。"""
    return ctx_user_role.get()


def user_filter(table_prefix: str = "") -> Tuple[str, list]:
    """
    返回 (where_clause, params) 用于 SQL 查询的用户数据隔离。

    - admin 角色：不加过滤，看到全部数据（含 legacy user_id IS NULL）
    - 普通用户：只看到自己的数据（user_id = ?）
    - 未登录：返回空结果（1=0）

    table_prefix: 联表查询时为列名加前缀，如 "p."
    """
    uid = current_user_id()
    role = current_user_role()

    if uid is None:
        return "1=0", []

    if role == "admin":
        return "", []

    prefix = f"{table_prefix}." if table_prefix else ""
    return f"({prefix}user_id = ?)", [uid]
