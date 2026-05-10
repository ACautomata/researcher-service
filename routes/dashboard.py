"""Dashboard 路由 - 任务状态、系统资源、Token 使用统计"""
import psutil
import subprocess
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends

from database import db_query
from routes.auth import _current_user
from services.data_filter import user_filter

router = APIRouter(prefix="/api/v1/dashboard", tags=["Dashboard"])


def _get_gpu_info() -> list:
    """通过 nvidia-smi 获取 NVIDIA GPU 信息（支持多卡）"""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used,utilization.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return []
        gpus = []
        for line in result.stdout.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 5:
                continue
            try:
                idx = int(parts[0])
                name = parts[1]
                mem_total = float(parts[2])
                mem_used = float(parts[3])
                util = float(parts[4])
                gpus.append({
                    "index": idx,
                    "name": name,
                    "memory_total_mb": mem_total,
                    "memory_used_mb": mem_used,
                    "memory_percent": round((mem_used / mem_total * 100) if mem_total > 0 else 0, 1),
                    "utilization_percent": util
                })
            except (ValueError, IndexError):
                continue
        return gpus
    except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
        return []


@router.get("/tasks")
async def get_tasks(status: Optional[str] = None, limit: int = 20):
    """获取任务列表（按用户隔离）"""
    conds, params = [], []
    uf, up = user_filter()
    if uf:
        conds.append(uf)
        params.extend(up)
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
    """获取系统资源使用情况（CPU/内存/磁盘/GPU）— 不按用户隔离"""
    try:
        cpu_percent = psutil.cpu_percent(interval=0.5)
        mem = psutil.virtual_memory()
        mem_total_gb = mem.total / (1024**3)
        mem_used_gb = mem.used / (1024**3)
        mem_percent = mem.percent
        disk = psutil.disk_usage('/')
        disk_total_gb = disk.total / (1024**3)
        disk_used_gb = disk.used / (1024**3)
        disk_percent = disk.percent
        gpus = _get_gpu_info()

        return {
            "cpu": {"percent": cpu_percent, "cores": psutil.cpu_count(logical=True)},
            "memory": {"total_gb": round(mem_total_gb, 2), "used_gb": round(mem_used_gb, 2), "percent": mem_percent},
            "disk": {"total_gb": round(disk_total_gb, 2), "used_gb": round(disk_used_gb, 2), "percent": disk_percent},
            "gpus": gpus,
            "timestamp": datetime.now().isoformat()
        }
    except Exception as e:
        return {
            "cpu": {"percent": 0, "cores": 0},
            "memory": {"total_gb": 0, "used_gb": 0, "percent": 0},
            "disk": {"total_gb": 0, "used_gb": 0, "percent": 0},
            "gpus": [],
            "error": str(e)
        }


@router.get("/usage")
async def get_user_usage(user: dict = Depends(_current_user)):
    """获取用户 Token 使用统计（按用户隔离）"""
    user_id = user["id"]

    uf, up = user_filter()
    uf_where = "WHERE " + uf if uf else ""

    # 获取任务统计
    total_tasks = await db_query(f"SELECT COUNT(*) as cnt FROM tasks {uf_where}", up)
    completed_tasks = await db_query(f"SELECT COUNT(*) as cnt FROM tasks WHERE status='completed'{' AND ' + uf if uf else ''}", up)
    running_tasks = await db_query(f"SELECT COUNT(*) as cnt FROM tasks WHERE status='running'{' AND ' + uf if uf else ''}", up)

    # 获取数据统计
    papers_count = await db_query(f"SELECT COUNT(*) as cnt FROM papers {uf_where}", up)
    entries_count = await db_query(f"SELECT COUNT(*) as cnt FROM entries {uf_where}", up)
    keywords_count = await db_query(f"SELECT COUNT(*) as cnt FROM keywords {uf_where}", up)
    problems_count = await db_query(f"SELECT COUNT(*) as cnt FROM problems {uf_where}", up)
    ideas_count = await db_query(f"SELECT COUNT(*) as cnt FROM ideas {uf_where}", up)
    algos_count = await db_query(f"SELECT COUNT(*) as cnt FROM algorithms {uf_where}", up)

    # Token 使用估算
    entries_result = await db_query(f"SELECT keywords_json FROM entries {uf_where}", up)
    estimated_tokens = 0
    for row in entries_result:
        try:
            import json
            keywords = json.loads(row.get("keywords_json", "[]"))
            estimated_tokens += len(keywords) * 10
        except:
            pass

    base_token_cost = total_tasks[0]["cnt"] * 300
    estimated_tokens += base_token_cost

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
