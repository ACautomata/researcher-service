"""Obsidian Vault 路由"""
import os
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel

from config import OBSIDIAN_VAULT_PATH
from services.obsidian_service import (
    get_tree, read_file, write_file, scan_graph, search_notes, get_tags,
)

router = APIRouter(prefix="/api/v1/obsidian", tags=["Obsidian"])


class SaveRequest(BaseModel):
    path: str
    content: str


@router.get("/vault-path")
async def obsidian_vault_path():
    return {
        "path": os.path.abspath(OBSIDIAN_VAULT_PATH) if OBSIDIAN_VAULT_PATH else "",
        "configured": bool(OBSIDIAN_VAULT_PATH),
    }


@router.get("/tree")
async def obsidian_tree(path: str = Query("")):
    if not OBSIDIAN_VAULT_PATH:
        raise HTTPException(400, "未配置 OBSIDIAN_VAULT_PATH")
    try:
        items = get_tree(path)
        return {"items": items, "path": path}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/file")
async def obsidian_file(path: str = Query(...)):
    if not OBSIDIAN_VAULT_PATH:
        raise HTTPException(400, "未配置 OBSIDIAN_VAULT_PATH")
    try:
        return read_file(path)
    except FileNotFoundError:
        raise HTTPException(404, f"文件不存在: {path}")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/file")
async def obsidian_save(req: SaveRequest):
    if not OBSIDIAN_VAULT_PATH:
        raise HTTPException(400, "未配置 OBSIDIAN_VAULT_PATH")
    try:
        return write_file(req.path, req.content)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/graph")
async def obsidian_graph():
    if not OBSIDIAN_VAULT_PATH:
        raise HTTPException(400, "未配置 OBSIDIAN_VAULT_PATH")
    return scan_graph()


@router.get("/search")
async def obsidian_search(q: str = Query(..., min_length=1)):
    if not OBSIDIAN_VAULT_PATH:
        raise HTTPException(400, "未配置 OBSIDIAN_VAULT_PATH")
    return {"results": search_notes(q), "query": q}


@router.get("/tags")
async def obsidian_tags():
    if not OBSIDIAN_VAULT_PATH:
        raise HTTPException(400, "未配置 OBSIDIAN_VAULT_PATH")
    return {"tags": get_tags()}
