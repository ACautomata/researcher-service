"""Obsidian Vault 服务 —— 文件浏览、Markdown 解析、链接图谱"""
import os
import re
import json
from pathlib import Path
from typing import Optional

from config import OBSIDIAN_VAULT_PATH

# Obsidian 维基链接: [[Note Name]] 或 [[Note Name|Alias]]
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]")
# Markdown 链接: [text](path)
MDLINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+\.md)\)")
# Frontmatter
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
# 标签: #tag 或 #tag/subtag
TAG_RE = re.compile(r"#([a-zA-Z\u4e00-\u9fff_/][a-zA-Z0-9\u4e00-\u9fff_/-]*)")


def _vault_path(rel_path: str = "") -> str:
    base = os.path.abspath(OBSIDIAN_VAULT_PATH or "./vault")
    if rel_path:
        full = os.path.normpath(os.path.join(base, rel_path))
        if not full.startswith(base + os.sep) and full != base:
            raise ValueError("路径越界")
        return full
    return base


def get_tree(dir_path: str = "") -> list[dict]:
    """获取目录树"""
    vp = _vault_path(dir_path)
    if not os.path.isdir(vp):
        return []
    items = []
    try:
        for entry in sorted(os.listdir(vp)):
            if entry.startswith("."):
                continue
            full = os.path.join(vp, entry)
            is_dir = os.path.isdir(full)
            items.append({
                "name": entry,
                "type": "dir" if is_dir else "file",
                "ext": os.path.splitext(entry)[1].lower() if not is_dir else "",
                "path": os.path.join(dir_path, entry).replace("\\", "/") if dir_path else entry,
            })
    except OSError:
        pass
    return items


def read_file(rel_path: str) -> dict:
    """读取文件内容"""
    vp = _vault_path(rel_path)
    if not os.path.isfile(vp):
        raise FileNotFoundError(f"文件不存在: {rel_path}")
    try:
        with open(vp, "r", encoding="utf-8") as f:
            content = f.read()
    except UnicodeDecodeError:
        with open(vp, "r", encoding="gbk") as f:
            content = f.read()
    return {
        "path": rel_path,
        "content": content,
        "size": len(content),
    }


def write_file(rel_path: str, content: str) -> dict:
    """写入文件"""
    vp = _vault_path(rel_path)
    os.makedirs(os.path.dirname(vp), exist_ok=True)
    with open(vp, "w", encoding="utf-8") as f:
        f.write(content)
    return {"path": rel_path, "size": len(content), "saved": True}


def scan_graph() -> dict:
    """扫描整个 Vault 生成知识图谱数据"""
    nodes = []
    edges = []
    node_ids = set()
    edge_set = set()
    vault = _vault_path()

    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if not f.endswith(".md"):
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, vault).replace("\\", "/")
            note_name = os.path.splitext(rel)[0]
            node_id = note_name.replace("/", " > ")

            if node_id not in node_ids:
                node_ids.add(node_id)
                nodes.append({
                    "id": node_id,
                    "label": os.path.basename(note_name),
                    "path": rel,
                    "size": os.path.getsize(full),
                })

            try:
                with open(full, "r", encoding="utf-8") as fp:
                    content = fp.read()
            except Exception:
                continue

            for match in WIKILINK_RE.finditer(content):
                target = match.group(1)
                target_id = target.replace("/", " > ")
                key = (node_id, target_id)
                if key not in edge_set and key[0] != key[1]:
                    edge_set.add(key)
                    edges.append({"from": node_id, "to": target_id})

            for match in MDLINK_RE.finditer(content):
                target = match.group(2)
                if target.endswith(".md"):
                    target_note = os.path.splitext(target)[0]
                    target_id = target_note.replace("/", " > ")
                    key = (node_id, target_id)
                    if key not in edge_set and key[0] != key[1]:
                        edge_set.add(key)
                        edges.append({"from": node_id, "to": target_id})

    # 为边中引用了但文件不存在的笔记创建占位节点
    linked = set()
    for e in edges:
        linked.add(e["from"])
        linked.add(e["to"])
    for target_id in linked:
        if target_id not in node_ids:
            node_ids.add(target_id)
            nodes.append({
                "id": target_id,
                "label": target_id.split(" > ")[-1],
                "path": None,
                "size": 0,
            })

    nodes = [n for n in nodes if n["id"] in linked]

    return {"nodes": nodes, "edges": edges}


def search_notes(query: str) -> list[dict]:
    """搜索笔记标题和内容"""
    vault = _vault_path()
    results = []
    qlower = query.lower()

    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if not f.endswith(".md"):
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, vault).replace("\\", "/")
            name = os.path.splitext(rel)[0]

            if qlower in name.lower():
                results.append({
                    "path": rel, "name": name,
                    "match": "title", "excerpt": "",
                })
                continue

            try:
                with open(full, "r", encoding="utf-8") as fp:
                    content = fp.read()
            except Exception:
                continue

            if qlower in content.lower():
                idx = content.lower().find(qlower)
                start = max(0, idx - 40)
                end = min(len(content), idx + len(query) + 80)
                excerpt = content[start:end].replace("\n", " ")
                results.append({
                    "path": rel, "name": name,
                    "match": "content", "excerpt": excerpt,
                })

    return results[:50]


def get_tags() -> list[dict]:
    """提取所有标签"""
    vault = _vault_path()
    tag_map = {}

    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if not f.endswith(".md"):
                continue
            full = os.path.join(root, f)
            try:
                with open(full, "r", encoding="utf-8") as fp:
                    content = fp.read()
            except Exception:
                continue
            for match in TAG_RE.finditer(content):
                tag = "#" + match.group(1)
                tag_map[tag] = tag_map.get(tag, 0) + 1

    return sorted(
        [{"tag": t, "count": c} for t, c in tag_map.items()],
        key=lambda x: x["count"], reverse=True
    )[:100]
