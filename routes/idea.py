"""Idea 路由"""
import json
import uuid
import asyncio
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional

from database import db_query, db_execute, update_task
from services.ai_service import generate_ideas

router = APIRouter(prefix="/api/v1/idea", tags=["Idea"])


class IdeaReq(BaseModel):
    problem_ids: list = []
    direction: Optional[str] = None


@router.post("/generate")
async def idea_generate(req: IdeaReq):
    if req.problem_ids:
        ph = ",".join("?" * len(req.problem_ids))
        problems = await db_query(f"SELECT * FROM problems WHERE id IN ({ph}) AND validated=1", req.problem_ids)
    else:
        problems = await db_query("SELECT * FROM problems WHERE validated=1 LIMIT 20")
    if not problems:
        return {"success": False, "message": "暂无已验证问题"}
    tid = f"idea_{uuid.uuid4().hex[:8]}"
    await db_execute("INSERT INTO tasks(id,type,status,progress,step) VALUES(?,'idea','running',0,'分析问题')", (tid,))
    asyncio.create_task(_do_ideas(tid, problems, req.direction))
    return {"task_id": tid, "status": "running"}


@router.get("/generate/{tid}/progress")
async def idea_gen_progress(tid: str):
    return await _task_resp(tid)


@router.get("/list")
async def idea_list(min_score: float = None, page: int = 1, page_size: int = 50):
    conds, params = [], []
    if min_score is not None:
        conds.append("overall_score>=?")
        params.append(min_score)
    w = "WHERE " + " AND ".join(conds) if conds else ""
    total = await db_query(f"SELECT COUNT(*) as cnt FROM ideas {w}", params)
    rows = await db_query(f"SELECT * FROM ideas {w} ORDER BY overall_score DESC LIMIT ? OFFSET ?",
                           params + [page_size, (page - 1) * page_size])
    return {"ideas": rows, "total": total[0]["cnt"], "page": page}


async def _task_resp(tid):
    rows = await db_query("SELECT * FROM tasks WHERE id=?", (tid,))
    if not rows:
        raise HTTPException(404)
    t = rows[0]
    return {
        "task_id": t["id"], "status": t["status"], "progress": t["progress"],
        "step": t["step"],
        "result": json.loads(t["result_json"]) if t["result_json"] else None,
        "error": t["error"],
    }


async def _do_ideas(tid, problems, direction):
    try:
        await update_task(tid, 30, "生成研究思路")
        result = await generate_ideas(problems, direction)
        await update_task(tid, 70, "评价与排序")
        count = 0
        for idea in result.get("ideas", []):
            iid = f"i_{uuid.uuid4().hex[:10]}"
            nv, fb, im = idea.get("novelty", 5), idea.get("feasibility", 5), idea.get("impact", 5)
            os_ = round((nv + fb + im) / 3, 1)
            await db_execute(
                "INSERT INTO ideas(id,title,description,from_problem,novelty,feasibility,impact,overall_score) VALUES(?,?,?,?,?,?,?,?)",
                (iid, idea["title"], idea.get("description", ""), idea.get("from_problem", ""),
                 nv, fb, im, os_))
            count += 1
        await update_task(tid, 100, "完成", "completed", result={"ideas_count": count})
    except Exception as e:
        import traceback
        traceback.print_exc()
        await update_task(tid, 0, "失败", "error", error=str(e))