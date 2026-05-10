"""Idea 路由"""
import json
import uuid
import asyncio
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional

from database import db_query, db_execute, update_task
from services.ai_service import generate_ideas
from services.data_filter import user_filter, current_user_id

router = APIRouter(prefix="/api/v1/idea", tags=["Idea"])


class IdeaReq(BaseModel):
    problem_ids: list = []
    direction: Optional[str] = None


@router.post("/generate")
async def idea_generate(req: IdeaReq):
    uid = current_user_id()
    uf, up = user_filter()
    validate_cond = "validated=1"
    if uf:
        validate_cond += " AND " + uf
    if req.problem_ids:
        ph = ",".join("?" * len(req.problem_ids))
        problems = await db_query(
            f"SELECT * FROM problems WHERE id IN ({ph}) AND {validate_cond}",
            req.problem_ids + up)
    else:
        problems = await db_query(
            f"SELECT * FROM problems WHERE {validate_cond} LIMIT 20", up)
    if not problems:
        return {"success": False, "message": "暂无已验证问题"}
    tid = f"idea_{uuid.uuid4().hex[:8]}"
    await db_execute(
        "INSERT INTO tasks(id,type,status,progress,step,user_id) VALUES(?,'idea','running',0,'分析问题',?)",
        (tid, uid))
    asyncio.create_task(_do_ideas(tid, problems, req.direction, uid))
    return {"task_id": tid, "status": "running"}


@router.get("/generate/{tid}/progress")
async def idea_gen_progress(tid: str):
    return await _task_resp(tid)


@router.get("/list")
async def idea_list(min_score: float = None, domain_id: int = None, page: int = 1, page_size: int = 50):
    conds, params = [], []
    uf, up = user_filter("i")
    if uf:
        conds.append(uf)
        params.extend(up)
    if min_score is not None:
        conds.append("i.overall_score>=?")
        params.append(min_score)
    if domain_id is not None:
        conds.append("i.domain_id=?")
        params.append(domain_id)
    w = "WHERE " + " AND ".join(conds) if conds else ""
    total = await db_query(f"SELECT COUNT(*) as cnt FROM ideas i {w}", params)
    rows = await db_query(
        f"SELECT i.*, d.name as domain_name FROM ideas i LEFT JOIN domains d ON i.domain_id=d.id {w} ORDER BY i.overall_score DESC LIMIT ? OFFSET ?",
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


async def _do_ideas(tid, problems, direction, uid):
    try:
        # 从问题中推导 domain_id
        domain_id = None
        analysis_ids = set(p.get("source_analysis") for p in problems if p.get("source_analysis"))
        if analysis_ids:
            ph = ",".join("?" * len(analysis_ids))
            la_rows = await db_query(
                f"SELECT DISTINCT kb_id FROM lit_analyses WHERE id IN ({ph})",
                list(analysis_ids))
            if la_rows:
                domain_id = la_rows[0]["kb_id"]
        problem_ids = [p["id"] for p in problems]

        await update_task(tid, 30, "生成研究思路")
        result = await generate_ideas(problems, direction)
        await update_task(tid, 70, "评价与排序")
        count = 0
        for idea in result.get("ideas", []):
            iid = f"i_{uuid.uuid4().hex[:10]}"
            nv, fb, im = idea.get("novelty", 5), idea.get("feasibility", 5), idea.get("impact", 5)
            os_ = round((nv + fb + im) / 3, 1)
            await db_execute(
                "INSERT INTO ideas(id,title,description,from_problem,novelty,feasibility,impact,overall_score,user_id,domain_id,problem_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (iid, idea["title"], idea.get("description", ""), idea.get("from_problem", ""),
                 nv, fb, im, os_, uid, domain_id, json.dumps(problem_ids, ensure_ascii=False)))
            count += 1
        await update_task(tid, 100, "完成", "completed", result={"ideas_count": count})
    except Exception as e:
        import traceback
        traceback.print_exc()
        await update_task(tid, 0, "失败", "error", error=str(e))
