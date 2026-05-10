"""参数优化路由"""
import json
import uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from database import db_query, db_execute
from services.data_filter import user_filter, current_user_id, current_user_role

router = APIRouter(prefix="/api/v1/param", tags=["Param"])


class ParamTaskReq(BaseModel):
    id: Optional[str] = None
    name: str = "未命名"
    status: str = "running"
    params_json: str = "[]"
    results_json: str = "[]"


@router.get("/list")
async def param_list():
    uf, up = user_filter()
    where = "WHERE " + uf if uf else ""
    rows = await db_query(f"SELECT * FROM param_tasks {where} ORDER BY created_at DESC", up)
    return {"tasks": rows}


@router.post("/save")
async def param_save(req: ParamTaskReq):
    uid = current_user_id()
    pid = req.id or f"pt_{uuid.uuid4().hex[:10]}"
    existing = await db_query("SELECT id FROM param_tasks WHERE id=?", (pid,))
    if existing:
        await db_execute(
            "UPDATE param_tasks SET name=?,status=?,params_json=?,results_json=? WHERE id=?",
            (req.name, req.status, req.params_json, req.results_json, pid))
    else:
        await db_execute(
            "INSERT INTO param_tasks(id,name,status,params_json,results_json,user_id) VALUES(?,?,?,?,?,?)",
            (pid, req.name, req.status, req.params_json, req.results_json, uid))
    return {"id": pid, "ok": True}


@router.delete("/{pid}")
async def param_delete(pid: str):
    role = current_user_role()
    uid = current_user_id()
    if role == "admin":
        await db_execute("DELETE FROM param_tasks WHERE id=?", (pid,))
    else:
        await db_execute("DELETE FROM param_tasks WHERE id=? AND (user_id IS NULL OR user_id=?)", (pid, uid))
    return {"ok": True}
