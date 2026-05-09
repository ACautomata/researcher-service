"""知识库路由"""
import os
import json
import uuid
import asyncio
from fastapi import APIRouter, UploadFile, File, Query, HTTPException
from pydantic import BaseModel
from typing import Optional

from config import UPLOAD_DIR
from database import db_query, db_execute, update_task
from services.ai_service import extract_entries, extract_keywords
from services.parser_service import extract_text

router = APIRouter(prefix="/api/v1/kb", tags=["知识库"])


class ParseReq(BaseModel):
    upload_id: int


@router.post("/upload")
async def kb_upload(files: list[UploadFile] = File(...)):
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    uploaded = []
    for f in files:
        ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
        save = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex[:12]}_{f.filename}")
        content = await f.read()
        with open(save, "wb") as fp:
            fp.write(content)
        rid = await db_execute(
            "INSERT INTO papers(filename,original_name,ext,size_bytes,status) VALUES(?,?,?,?,?)",
            (save, f.filename, ext, len(content), "uploaded"))
        uploaded.append({"upload_id": rid, "filename": f.filename, "size": len(content)})
    return {"success": True, "uploaded": uploaded}


@router.post("/parse")
async def kb_parse(req: ParseReq):
    papers = await db_query("SELECT * FROM papers WHERE id=? AND status!='parsed'", (req.upload_id,))
    if not papers:
        raise HTTPException(404, "文件不存在或已解析")
    tid = f"parse_{uuid.uuid4().hex[:8]}"
    await db_execute("INSERT INTO tasks(id,type,status,progress,step) VALUES(?,'parse','running',0,'校验文件')", (tid,))
    asyncio.create_task(_do_parse(tid, req.upload_id))
    return {"task_id": tid, "status": "running"}


@router.get("/parse/{tid}/progress")
async def kb_parse_progress(tid: str):
    return await _task_resp(tid)


@router.get("/entries")
async def kb_entries(keyword: str = None, category: str = None, page: int = 1, page_size: int = 50):
    conds, params = [], []
    if keyword:
        conds += ["(title LIKE ? OR keywords_json LIKE ?)"]
        params += [f"%{keyword}%", f"%{keyword}%"]
    if category:
        conds += ["category=?"]
        params.append(category)
    w = "WHERE " + " AND ".join(conds) if conds else ""
    total = await db_query(f"SELECT COUNT(*) as cnt FROM entries {w}", params)
    rows = await db_query(f"SELECT * FROM entries {w} ORDER BY id DESC LIMIT ? OFFSET ?",
                           params + [page_size, (page - 1) * page_size])
    for r in rows:
        try:
            r["keywords"] = json.loads(r.get("keywords_json", "[]"))
        except Exception:
            r["keywords"] = []
    return {"total": total[0]["cnt"], "entries": rows, "page": page}


@router.get("/keywords")
async def kb_keywords(category: str = None, limit: int = 100):
    conds, params = [], []
    if category:
        conds += ["category=?"]
        params.append(category)
    w = "WHERE " + " AND ".join(conds) if conds else ""
    rows = await db_query(f"SELECT * FROM keywords {w} ORDER BY weight DESC LIMIT ?", params + [limit])
    return {"keywords": rows}


@router.delete("/entries")
async def kb_delete(body: dict):
    ids = body.get("ids", [])
    if not ids:
        return {"success": True}
    ph = ",".join("?" * len(ids))
    await db_execute(f"DELETE FROM entries WHERE id IN ({ph})", ids)
    return {"success": True, "message": f"删除 {len(ids)} 条"}


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


async def _do_parse(tid, paper_id):
    try:
        paper = (await db_query("SELECT * FROM papers WHERE id=?", (paper_id,)))[0]
        await update_task(tid, 25, "文件接收与格式校验")
        if not os.path.exists(paper["filename"]):
            return await update_task(tid, 0, "失败", "error", error="文件不存在")
        await update_task(tid, 50, "文本提取与结构化")
        text = extract_text(paper["filename"], paper["ext"] or "")
        if not text or len(text) < 50:
            return await update_task(tid, 0, "失败", "error", error="文本为空或过短")
        await update_task(tid, 75, "AI 关键字识别与权重计算")
        ed = await extract_entries(text, paper["original_name"])
        el = ed.get("entries", [])
        await update_task(tid, 90, "AI 知识条目生成与分类")
        kd = await extract_keywords(el)
        kl = kd.get("keywords", [])
        for e in el:
            await db_execute(
                "INSERT INTO entries(title,category,source,status,paper_id,keywords_json) VALUES(?,?,?,?,?,?)",
                (e["title"], e.get("category", "未分类"), paper["original_name"],
                 e.get("status", "draft"), paper_id,
                 json.dumps(e.get("keywords", []), ensure_ascii=False)))
        for kw in kl:
            ex = await db_query("SELECT id,weight FROM keywords WHERE word=? AND category=?",
                                (kw["word"], kw.get("category")))
            if ex:
                await db_execute("UPDATE keywords SET weight=?,source_paper_id=? WHERE id=?",
                                 (max(ex[0]["weight"], kw.get("weight", 5)), paper_id, ex[0]["id"]))
            else:
                await db_execute("INSERT INTO keywords(word,weight,category,source_paper_id) VALUES(?,?,?,?)",
                                 (kw["word"], kw.get("weight", 5), kw.get("category"), paper_id))
        await db_execute("UPDATE papers SET status='parsed' WHERE id=?", (paper_id,))
        await update_task(tid, 100, "完成", "completed",
                          result={"entries_count": len(el), "keywords_count": len(kl)})
    except Exception as e:
        import traceback
        traceback.print_exc()
        await update_task(tid, 0, "失败", "error", error=str(e))

@router.post("/clear-all")
async def kb_clear_all():
    """清空所有数据，重新开始"""
    await db_execute("DELETE FROM algorithms")
    await db_execute("DELETE FROM ideas")
    await db_execute("DELETE FROM problems")
    await db_execute("DELETE FROM entries")
    await db_execute("DELETE FROM keywords")
    await db_execute("DELETE FROM tasks")
    await db_execute("DELETE FROM papers")
    await db_execute("DELETE FROM domains")
    # 清空上传文件夹里的文件
    import shutil
    if os.path.exists(UPLOAD_DIR):
        for f in os.listdir(UPLOAD_DIR):
            fp = os.path.join(UPLOAD_DIR, f)
            if os.path.isfile(fp):
                os.remove(fp)
    return {"success": True, "message": "已清空全部数据"}


# ===== 领域管理 =====

class DomainReq(BaseModel):
    name: str
    description: str = ""


@router.post("/domain")
async def kb_create_domain(req: DomainReq):
    try:
        rid = await db_execute(
            "INSERT INTO domains(name,description) VALUES(?,?)",
            (req.name, req.description))
        return {"success": True, "domain_id": rid, "name": req.name}
    except Exception as e:
        raise HTTPException(400, f"创建失败（可能已存在同名领域）: {str(e)}")


@router.get("/domains")
async def kb_list_domains():
    rows = await db_query("SELECT * FROM domains ORDER BY updated_at DESC")
    # 统计每个领域的论文数
    for r in rows:
        cnt = await db_query(
            "SELECT COUNT(*) as c FROM papers WHERE domain_id=?", (r["id"],))
        r["paper_count"] = cnt[0]["c"] if cnt else 0
    return {"domains": rows}


@router.delete("/domain/{domain_id}")
async def kb_delete_domain(domain_id: int):
    await db_execute("UPDATE papers SET domain_id=NULL WHERE domain_id=?", (domain_id,))
    await db_execute("DELETE FROM domains WHERE id=?", (domain_id,))
    return {"success": True}


@router.put("/domain/{domain_id}")
async def kb_update_domain(domain_id: int, req: DomainReq):
    await db_execute(
        "UPDATE domains SET name=?,description=?,updated_at=datetime('now','localtime') WHERE id=?",
        (req.name, req.description, domain_id))
    return {"success": True}


# ===== 领域内论文管理 =====

@router.post("/domain/{domain_id}/upload")
async def kb_domain_upload(domain_id: int, files: list[UploadFile] = File(...)):
    domains = await db_query("SELECT * FROM domains WHERE id=?", (domain_id,))
    if not domains:
        raise HTTPException(404, "领域不存在")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    uploaded = []
    for f in files:
        ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
        save = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex[:12]}_{f.filename}")
        content = await f.read()
        with open(save, "wb") as fp:
            fp.write(content)
        # 解析 PDF 为 markdown
        md_text = ""
        if ext in ("pdf", "docx", "doc", "txt", "md", "tex"):
            try:
                md_text = extract_text(save, ext)
            except Exception:
                pass
        rid = await db_execute(
            "INSERT INTO papers(filename,original_name,ext,size_bytes,status,domain_id,markdown_content) VALUES(?,?,?,?,?,?,?)",
            (save, f.filename, ext, len(content), "uploaded", domain_id, md_text))
        uploaded.append({
            "paper_id": rid, "filename": f.filename,
            "size": len(content), "md_length": len(md_text)})
    return {"success": True, "uploaded": uploaded}


@router.get("/domain/{domain_id}/papers")
async def kb_domain_papers(domain_id: int):
    rows = await db_query(
        "SELECT * FROM papers WHERE domain_id=? ORDER BY created_at DESC", (domain_id,))
    return {"papers": rows, "domain_id": domain_id}


@router.get("/paper/{paper_id}")
async def kb_paper_detail(paper_id: int):
    rows = await db_query("SELECT * FROM papers WHERE id=?", (paper_id,))
    if not rows:
        raise HTTPException(404)
    return rows[0]


@router.post("/paper/{paper_id}/reparse")
async def kb_paper_reparse(paper_id: int):
    """重新解析论文为 markdown"""
    rows = await db_query("SELECT * FROM papers WHERE id=?", (paper_id,))
    if not rows:
        raise HTTPException(404)
    p = rows[0]
    if not os.path.exists(p["filename"]):
        raise HTTPException(400, "文件不存在")
    try:
        md_text = extract_text(p["filename"], p["ext"] or "")
        await db_execute(
            "UPDATE papers SET markdown_content=?,status='parsed' WHERE id=?",
            (md_text, paper_id))
        return {"success": True, "md_length": len(md_text)}
    except Exception as e:
        raise HTTPException(500, str(e))