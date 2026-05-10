"""文献分析路由"""
import json
import uuid
import asyncio
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional

from database import db_query, db_execute, update_task
from services.ai_service import discover_problems, validate_problem
from services.external_service import search_external
from services.data_filter import user_filter, current_user_id, current_user_role

router = APIRouter(prefix="/api/v1/lit", tags=["文献分析"])


class DiscoverReq(BaseModel):
    entry_ids: list = []
    deep_analysis: str = "deep"
    extra_texts: list = []


class ValidateReq(BaseModel):
    problem_ids: list = []
    method: str = "cross_reference"


class LitHistoryReq(BaseModel):
    id: str = ""
    kb_id: int = 0
    kb_id2: int = 0
    kb_name: str = ""
    kb_name2: str = ""
    display_name: str = ""
    depth: str = "deep"
    status: str = "pending"
    progress: int = 0
    count: int = 0


@router.get("/history")
async def lit_history():
    uf, up = user_filter()
    where = "WHERE " + uf if uf else ""
    rows = await db_query(f"SELECT * FROM lit_analyses {where} ORDER BY created_at DESC", up)
    return {"history": rows}


@router.post("/history")
async def lit_history_create(req: LitHistoryReq):
    uid = current_user_id()
    aid = req.id or f"lit_{uuid.uuid4().hex[:10]}"
    await db_execute(
        "INSERT INTO lit_analyses(id,kb_id,kb_id2,kb_name,kb_name2,display_name,depth,status,progress,count,user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (aid, req.kb_id, req.kb_id2, req.kb_name, req.kb_name2, req.display_name, req.depth, req.status, req.progress, req.count, uid))
    return {"id": aid}


@router.put("/history/{aid}")
async def lit_history_update(aid: str, req: LitHistoryReq):
    role = current_user_role()
    uid = current_user_id()
    if role == "admin":
        await db_execute(
            "UPDATE lit_analyses SET status=?,progress=?,count=? WHERE id=?",
            (req.status, req.progress, req.count, aid))
    else:
        await db_execute(
            "UPDATE lit_analyses SET status=?,progress=?,count=? WHERE id=? AND (user_id IS NULL OR user_id=?)",
            (req.status, req.progress, req.count, aid, uid))
    return {"ok": True}


@router.post("/auto-discover")
async def lit_discover(req: DiscoverReq):
    uid = current_user_id()
    if req.extra_texts:
        entries = [{"title": f"文献片段 {i+1}", "category": "文献", "keywords": [], "source": "知识库"}
                   for i in range(len(req.extra_texts))]
    elif req.entry_ids:
        ph = ",".join("?" * len(req.entry_ids))
        uf, up = user_filter()
        extra_cond = (" AND " + uf) if uf else ""
        entries = await db_query(f"SELECT * FROM entries WHERE id IN ({ph}){extra_cond}", req.entry_ids + up)
    else:
        uf, up = user_filter()
        where = "WHERE " + uf if uf else ""
        entries = await db_query(f"SELECT * FROM entries {where} LIMIT 100", up)
    if not entries:
        raise HTTPException(400, "知识库为空")
    for e in entries:
        try:
            e["keywords"] = json.loads(e.get("keywords_json", "[]"))
        except Exception:
            e["keywords"] = []
    tid = f"disc_{uuid.uuid4().hex[:8]}"
    await db_execute(
        "INSERT INTO tasks(id,type,status,progress,step,user_id) VALUES(?,'discover','running',0,'扫描条目',?)",
        (tid, uid))
    asyncio.create_task(_do_discover(tid, entries, req.deep_analysis, req.extra_texts, uid))
    return {"task_id": tid, "status": "running"}


@router.get("/auto-discover/{tid}/progress")
async def lit_disc_progress(tid: str):
    return await _task_resp(tid)


@router.get("/search-external")
async def lit_search(keyword: str = Query(...), source: str = Query("arxiv")):
    results = await search_external(keyword, source)
    return {"results": results, "total": len(results)}


@router.post("/validate")
async def lit_validate(req: ValidateReq):
    uid = current_user_id()
    problems = []
    for pid in req.problem_ids:
        rows = await db_query("SELECT * FROM problems WHERE id=?", (pid,))
        if rows:
            problems.append(rows[0])
    if not problems:
        raise HTTPException(400, "未找到问题")
    tid = f"val_{uuid.uuid4().hex[:8]}"
    await db_execute(
        "INSERT INTO tasks(id,type,status,progress,step,user_id) VALUES(?,'validate','running',0,'验证中',?)",
        (tid, uid))
    uf, up = user_filter()
    where = "WHERE " + uf if uf else ""
    entries = await db_query(f"SELECT title,category FROM entries {where} LIMIT 200", up)
    ml = {"cross_reference": "交叉引用", "experiment": "实验验证", "expert": "专家审核"}
    asyncio.create_task(_do_validate(tid, problems, entries, ml.get(req.method, "交叉引用")))
    return {"task_id": tid, "status": "running"}


@router.get("/validate/{tid}/progress")
async def lit_val_progress(tid: str):
    return await _task_resp(tid)


@router.get("/problems")
async def lit_problems(status: str = None, severity: str = None):
    conds, params = [], []
    uf, up = user_filter()
    if uf:
        conds.append(uf)
        params.extend(up)
    if status == "validated":
        conds.append("validated=1")
    elif status == "pending":
        conds.append("validated=0")
    if severity:
        conds.append("severity=?")
        params.append(severity)
    w = "WHERE " + " AND ".join(conds) if conds else ""
    rows = await db_query(f"SELECT * FROM problems {w} ORDER BY created_at DESC", params)
    return {"problems": rows, "total": len(rows)}


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


async def _do_discover(tid, entries, depth, extra_texts=None, uid=None):
    try:
        await update_task(tid, 25, "扫描关键字与条目结构")
        await asyncio.sleep(0.2)
        await update_task(tid, 50, "提取方法论述与结论断言")
        result = await discover_problems(entries, depth, extra_texts)
        await update_task(tid, 80, "识别局限性、矛盾与空白")
        count = 0
        for p in result.get("problems", []):
            pid = f"p_{uuid.uuid4().hex[:10]}"
            await db_execute(
                "INSERT INTO problems(id,title,description,source,source_type,category,severity,user_id) VALUES(?,?,?,?,?,?,?,?)",
                (pid, p["title"], p.get("description", ""),
                 entries[0].get("source", "") if entries else "",
                 "kb", p.get("category", "未分类"), p.get("severity", "medium"), uid))
            count += 1
        await update_task(tid, 100, "完成", "completed", result={"problems_count": count})
    except Exception as e:
        import traceback
        traceback.print_exc()
        await update_task(tid, 0, "失败", "error", error=str(e))


async def _do_validate(tid, problems, entries, method_label):
    try:
        validated = []
        for i, p in enumerate(problems):
            await update_task(tid, int(i / len(problems) * 90), f"验证问题 {i+1}/{len(problems)}")
            await db_execute("UPDATE problems SET validating=1 WHERE id=?", (p["id"],))
            try:
                r = await validate_problem(p, entries)
                score = r.get("score", 6)
                await db_execute(
                    "UPDATE problems SET validated=1,validating=0,validation_method=?,validation_score=? WHERE id=?",
                    (method_label, score, p["id"]))
                validated.append({"id": p["id"], "score": score})
            except Exception as e:
                await db_execute("UPDATE problems SET validating=0 WHERE id=?", (p["id"],))
                validated.append({"id": p["id"], "score": None, "error": str(e)})
        await update_task(tid, 100, "完成", "completed", result={"validated": validated})
    except Exception as e:
        import traceback
        traceback.print_exc()
        await update_task(tid, 0, "失败", "error", error=str(e))
