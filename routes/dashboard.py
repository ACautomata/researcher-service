"""Dashboard 路由 - 任务状态、系统资源、Token 使用统计"""
import psutil
import os
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends

from database import db_query
from routes.auth import _current_user

router = APIRouter(prefix="/api/v1/dashboard", tags=["Dashboard"])


@router.get("/tasks")
async def get_tasks(status: Optional[str] = None, limit: int = 20):
    """获取任务列表"""
    conds, params = [], []
    if status:
        conds.append("status = ?")
        params.append(status)
    where = "WHERE " + " AND ".join(conds) if conds else ""
    sql = f"""
        SELECT id, type, status, progress, step, error,
               created_at, updated_at,
               CASE
                 WHEN status = 'running' THEN datetime(updated_at, '+5 minutes') > datetime('now')
                 ELSE FALSE
               END as is_active
        FROM tasks {where}
        ORDER BY created_at DESC
        LIMIT ?
    """
    rows = await db_query(sql, params + [limit])
    return {"tasks": rows}


@router.get("/stats")
async def get_system_stats():
    """获取系统资源使用情况"""
    try:
        # CPU 使用率
        cpu_percent = psutil.cpu_percent(interval=0.5)

        # 内存使用
        mem = psutil.virtual_memory()
        mem_total_gb = mem.total / (1024**3)
        mem_used_gb = mem.used / (1024**3)
        mem_percent = mem.percent

        # 磁盘使用
        disk = psutil.disk_usage('/')
        disk_total_gb = disk.total / (1024**3)
        disk_used_gb = disk.used / (1024**3)
        disk_percent = disk.percent

        return {
            "cpu": {
                "percent": cpu_percent,
                "cores": psutil.cpu_count()
            },
            "memory": {
                "total_gb": round(mem_total_gb, 2),
                "used_gb": round(mem_used_gb, 2),
                "percent": mem_percent
            },
            "disk": {
                "total_gb": round(disk_total_gb, 2),
                "used_gb": round(disk_used_gb, 2),
                "percent": disk_percent
            },
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        return {
            "cpu": {"percent": 0, "cores": 0},
            "memory": {"total_gb": 0, "used_gb": 0, "percent": 0},
            "disk": {"total_gb": 0, "used_gb": 0, "percent": 0},
            "error": str(e)
        }


@router.get("/usage")
async def get_user_usage(user: dict = Depends(_current_user)):
    """获取用户 Token 使用统计"""
    user_id = user["id"]

    # 获取任务统计
    total_tasks = await db_query("SELECT COUNT(*) as cnt FROM tasks", ())
    completed_tasks = await db_query("SELECT COUNT(*) as cnt FROM tasks WHERE status='completed'", ())
    running_tasks = await db_query("SELECT COUNT(*) as cnt FROM tasks WHERE status='running'", ())

    # 获取数据统计
    papers_count = await db_query("SELECT COUNT(*) as cnt FROM papers", ())
    entries_count = await db_query("SELECT COUNT(*) as cnt FROM entries", ())
    keywords_count = await db_query("SELECT COUNT(*) as cnt FROM keywords", ())
    problems_count = await db_query("SELECT COUNT(*) as cnt FROM problems", ())
    ideas_count = await db_query("SELECT COUNT(*) as cnt FROM ideas", ())
    algos_count = await db_query("SELECT COUNT(*) as cnt FROM algorithms", ())

    # Token 使用估算（基于 AI 调用次数，假设每次调用平均消耗约 500 tokens）
    # 实际项目中应该记录真实的 token 使用量
    # 这里我们创建一个估算

    # 获取各步骤的数据量来估算 token 使用
    entries_result = await db_query("SELECT keywords_json FROM entries", ())
    estimated_tokens = 0
    for row in entries_result:
        try:
            import json
            keywords = json.loads(row.get("keywords_json", "[]"))
            estimated_tokens += len(keywords) * 10  # 每个关键词约 10 tokens
        except:
            pass

    # 添加固定基础消耗（每次 AI 调用约 200-500 tokens）
    base_token_cost = total_tasks[0]["cnt"] * 300
    estimated_tokens += base_token_cost

    # 假设每用户限额为 100,000 tokens
    token_limit = 100000

    return {
        "tasks": {
            "total": total_tasks[0]["cnt"],
            "completed": completed_tasks[0]["cnt"],
            "running": running_tasks[0]["cnt"],
            "failed": total_tasks[0]["cnt"] - completed_tasks[0]["cnt"] - running_tasks[0]["cnt"]
        },
        "data": {
            "papers": papers_count[0]["cnt"],
            "entries": entries_count[0]["cnt"],
            "keywords": keywords_count[0]["cnt"],
            "problems": problems_count[0]["cnt"],
            "ideas": ideas_count[0]["cnt"],
            "algorithms": algos_count[0]["cnt"]
        },
        "tokens": {
            "estimated_used": estimated_tokens,
            "limit": token_limit,
            "remaining": max(0, token_limit - estimated_tokens),
            "usage_percent": round((estimated_tokens / token_limit) * 100, 2) if token_limit > 0 else 0
        }
    }
