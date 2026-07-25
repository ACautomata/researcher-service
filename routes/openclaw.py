"""OpenClaw 网关桥接路由 —— 将 OpenClaw Agent 平台能力接入 Pipeline"""
import json
import uuid
import asyncio
import os
import re
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Query, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

from database import db_execute, update_task
from services.data_filter import current_user_id
from services.openclaw_service import (
    chat, chat_stream, health,
)
from config import (
    OPENCLAW_ENABLED, RESEARCHER_WORKSPACE_PATH, RESEARCHER_WIKI_ROOT,
    RESEARCHER_CONFIG_PATH, RESEARCHER_COMPOSE_DIR,
)

router = APIRouter(prefix="/api/v1/openclaw", tags=["OpenClaw"])

_openclaw_event_queues: dict[str, asyncio.Queue] = {}


class ChatRequest(BaseModel):
    agent_id: str = "main"
    message: str
    history: Optional[list] = None
    system_prompt: Optional[str] = None
    temperature: float = 0.7
    max_tokens: int = 4096
    session_key: Optional[str] = None  # 复用同一 key → 网关按 sessionKey 维护跨轮记忆
    files: Optional[list] = None  # [{name, data, type}]


# ── 健康检查 ──────────────────────────────────────────────

@router.get("/health")
async def openclaw_health():
    if not OPENCLAW_ENABLED:
        return {"enabled": False, "reachable": False}
    result = await health()
    return {"enabled": True, **result}


# ── 非流式对话 ────────────────────────────────────────────

@router.post("/chat")
async def openclaw_chat(req: ChatRequest):
    """向 OpenClaw Agent 发送消息，返回完整回复"""
    result = await chat(
        agent_id=req.agent_id,
        message=req.message,
        history=req.history,
        system_prompt=req.system_prompt,
        temperature=req.temperature,
        max_tokens=req.max_tokens,
        session_key=req.session_key,
    )
    return result


# ── 文件上传 ──────────────────────────────────────────────

@router.post("/upload")
async def openclaw_upload(agent_id: str = Form("main"), file: UploadFile = File(...)):
    """上传文件到 main agent 的 workspace（researcher 挂载源 workspace/oc-uploads）"""
    if not OPENCLAW_ENABLED:
        raise HTTPException(400, "OpenClaw 未启用")
    # 单 main 收敛：仅接受 main，其余（含已删子 agent）一律拒绝
    if agent_id != "main":
        raise HTTPException(400, f"仅支持上传到 main agent，收到: {agent_id}")

    upload_dir = os.path.join(RESEARCHER_WORKSPACE_PATH, "oc-uploads")
    os.makedirs(upload_dir, exist_ok=True)

    # 用 uuid 前缀防重名
    safe_name = f"{uuid.uuid4().hex[:8]}_{file.filename or 'file'}"
    save_path = os.path.join(upload_dir, safe_name)

    content = await file.read()
    MAX_SIZE = 50 * 1024 * 1024
    if len(content) > MAX_SIZE:
        raise HTTPException(400, f"文件超过 50MB 限制")

    with open(save_path, "wb") as f:
        f.write(content)

    # Agent 看到的路径（相对 workspace）
    rel_path = f"oc-uploads/{safe_name}"
    return {"filename": file.filename, "saved_as": safe_name, "path": rel_path, "size": len(content)}


# ── SSE 流式对话 ───────────────────────────────────────────

@router.post("/chat/stream")
async def openclaw_chat_stream_start(req: ChatRequest):
    """启动 OpenClaw Agent 流式对话，返回 task_id"""
    uid = current_user_id()
    tid = f"openclaw_{uuid.uuid4().hex[:8]}"
    _openclaw_event_queues[tid] = asyncio.Queue()
    await db_execute(
        "INSERT INTO tasks(id,type,status,progress,step,user_id) VALUES(?,'openclaw','running',0,'连接OpenClaw',?)",
        (tid, uid),
    )

    async def _run():
        try:
            async for sse_event in chat_stream(
                agent_id=req.agent_id,
                message=req.message,
                history=req.history,
                system_prompt=req.system_prompt,
                temperature=req.temperature,
                max_tokens=req.max_tokens,
                session_key=req.session_key,
                files=req.files,
            ):
                await _openclaw_event_queues[tid].put(sse_event)
        except Exception as e:
            await _openclaw_event_queues[tid].put(
                f"data: {json.dumps({'type': 'error', 'text': str(e)})}\n\n"
            )
        await _openclaw_event_queues[tid].put("__DONE__")

    asyncio.create_task(_run())
    return {"task_id": tid, "status": "running"}


@router.get("/chat/{tid}/stream")
async def openclaw_chat_stream_events(tid: str, request: Request):
    """SSE 事件流 —— 供 EventSource 消费"""
    queue = _openclaw_event_queues.get(tid)
    if queue is None:
        raise HTTPException(404, "会话不存在或已过期")

    async def generate():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    if event == "__DONE__":
                        await update_task(tid, 100, "完成", "completed")
                        break
                    yield event
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            _openclaw_event_queues.pop(tid, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── 应用配置到 researcher openclaw.json ────────────────────
# 去 Docker 化（issue #22 / spec 2c）：只写 RESEARCHER_CONFIG_PATH 的
# models.providers + agents.defaults.model（单 main）；生效 = docker compose restart
# openclaw-gateway（compose 栈目录）。sync 全关后 init 不覆盖，无需回写/docker cp。

class ApplyConfigRequest(BaseModel):
    api_key: Optional[str] = None
    api_base: Optional[str] = None
    api_model: Optional[str] = None


def _infer_provider(api_base: str, api_model: str) -> dict:
    """沿用既有 deepseek/anthropic/custom 推断（单 main）。"""
    base_lower = api_base.lower()
    if "deepseek" in base_lower:
        return {
            "provider_name": "deepseek",
            "model_id": api_model or "deepseek-v4-pro",
            "model_alias": "DeepSeek V4 Pro",
            "api_protocol": "anthropic-messages",
            "context_window": 131072,
            "max_tokens": 131072,
        }
    if "anthropic" in base_lower:
        model_id = api_model or "claude-sonnet-4-20250514"
        return {
            "provider_name": "anthropic",
            "model_id": model_id,
            "model_alias": model_id,
            "api_protocol": "anthropic-messages",
            "context_window": 200000,
            "max_tokens": 8192,
        }
    model_id = api_model or "default-model"
    return {
        "provider_name": "custom",
        "model_id": model_id,
        "model_alias": model_id,
        "api_protocol": "anthropic-messages",
        "context_window": 131072,
        "max_tokens": 4096,
    }


def _restart_gateway() -> None:
    """生效动作：在 compose 栈目录重启 openclaw-gateway（sync 全关后 init 不覆盖配置）。

    需后端进程有 docker/compose 权限 + 正确 compose 工作目录（见 REFACTOR-SPEC 待确认项）。
    失败不阻断——配置已写盘，下次重启容器同样生效。
    """
    import subprocess
    try:
        subprocess.run(
            ["docker", "compose", "restart", "openclaw-gateway"],
            cwd=RESEARCHER_COMPOSE_DIR,
            capture_output=True, text=True, timeout=60,
        )
    except Exception:
        pass


# 可替换的重启钩子（测试注入 spy，断言「调用了重启」而非真跑 docker）
restart_gateway_hook = _restart_gateway


@router.post("/apply-config")
async def openclaw_apply_config(req: ApplyConfigRequest, request: Request):
    """将界面模型配置写入 researcher openclaw.json（单 main）并触发容器重启生效"""
    import json as _json
    import os as _os

    if not OPENCLAW_ENABLED:
        raise HTTPException(400, "OpenClaw 未启用")

    api_base = (req.api_base or "").strip()
    api_key = (req.api_key or "").strip()
    api_model = (req.api_model or "").strip()

    if not api_base and not api_key:
        raise HTTPException(400, "请提供 API Base URL 或 API Key")

    p = _infer_provider(api_base, api_model)

    try:
        oc_config = RESEARCHER_CONFIG_PATH
        if not _os.path.exists(oc_config):
            raise HTTPException(500, f"openclaw.json 不存在: {oc_config}")

        data = _json.load(open(oc_config))

        # 只写 models.providers（单 provider；apiKey 用 SecretRef 运行时读 LLM_API_KEY，不明文写盘）
        data.setdefault("models", {})["providers"] = {
            p["provider_name"]: {
                "baseUrl": api_base,
                "apiKey": {"source": "env", "provider": "default", "id": "LLM_API_KEY"},
                "api": p["api_protocol"],
                "authHeader": True,
                "models": [
                    {
                        "id": p["model_id"],
                        "name": p["model_alias"],
                        "reasoning": True,
                        "input": ["text"],
                        "contextWindow": p["context_window"],
                        "maxTokens": p["max_tokens"],
                    }
                ],
            }
        }

        # 单 main：更新 agents.defaults.model 指向新 provider
        agents = data.setdefault("agents", {})
        defaults = agents.setdefault("defaults", {})
        full_id = f"{p['provider_name']}/{p['model_id']}"
        defaults["model"] = {"primary": full_id}
        defaults["models"] = {full_id: {"alias": p["model_alias"]}}

        _json.dump(data, open(oc_config, "w"), indent=2, ensure_ascii=False)

        # 生效：docker compose restart（经可替换钩子；测试注入 spy）
        restart_gateway_hook()

        return {
            "success": True,
            "message": f"已切换到 {p['model_alias']}，OpenClaw 正在重启生效",
            "provider": p["provider_name"],
            "model": p["model_id"],
            "protocol": p["api_protocol"],
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"应用配置失败: {str(e)}")


# ── 状态面板 ──────────────────────────────────────────────

@router.get("/status")
async def openclaw_status():
    import subprocess, os as _os, json as _json

    result = {
        "enabled": OPENCLAW_ENABLED,
        "gateway": {"reachable": False, "version": None},
        "container": {"running": False, "name": "openclaw-gateway"},
        "agents": [],
        "model_provider": None,
        "active_sessions": len(_openclaw_event_queues),
    }

    if not OPENCLAW_ENABLED:
        return result

    # Gateway health
    h = await health()
    result["gateway"]["reachable"] = h.get("reachable", False)
    if h.get("reachable"):
        try:
            body = _json.loads(h.get("body", "{}"))
            result["gateway"]["status"] = body.get("status", "unknown")
        except Exception:
            pass

    # Docker container status
    try:
        r = subprocess.run(
            ["docker", "inspect", "openclaw-gateway"],
            capture_output=True, text=True, timeout=10
        )
        if r.returncode == 0:
            info = _json.loads(r.stdout)[0]
            state = info.get("State", {})
            result["container"]["running"] = state.get("Running", False)
            result["container"]["status"] = state.get("Status", "unknown")
            result["container"]["started_at"] = state.get("StartedAt", "")
            result["container"]["image"] = info.get("Config", {}).get("Image", "")
    except Exception:
        pass

    # Agent 信息（单 main）：从 researcher openclaw.json 读 agents.list
    oc_config = RESEARCHER_CONFIG_PATH
    if _os.path.exists(oc_config):
        try:
            data = _json.load(open(oc_config))
            agents_list = data.get("agents", {}).get("list", [])

            for agent in agents_list:
                agent_id = agent.get("id", "unknown")
                result["agents"].append({
                    "id": agent_id,
                    "name": agent.get("name", agent_id),
                    "is_default": agent.get("default", False),
                    "workspace": agent.get("workspace", ""),
                })

            # Model provider
            providers = data.get("models", {}).get("providers", {})
            for name, p in providers.items():
                result["model_provider"] = {
                    "name": name,
                    "base_url": p.get("baseUrl", ""),
                    "api": p.get("api", ""),
                    "models": [m.get("id") for m in p.get("models", [])],
                }
                break  # Just first one
        except Exception:
            pass

    return result


# ── 会话列表 ──────────────────────────────────────────────

@router.get("/sessions")
async def openclaw_sessions():
    return {
        "sessions": list(_openclaw_event_queues.keys()),
        "count": len(_openclaw_event_queues),
    }


# ── Wiki 知识库 ──────────────────────────────────────────
# 读 researcher 的 wiki/main（memory-wiki 插件 vault，render mode=obsidian）。
# 列表维度 = 五核心分类（concepts/entities/sources/syntheses/reports）+ domains 子树；
# 不再单扫 domains。frontmatter 兼容插件官方与 researcher 论文页双 schema。
# 依据 docs/research/r7-wiki-read-mechanism.md。

# Obsidian wikilink：[[target]] / [[target|alias]] / [[target#anchor]]（取 target 段）
_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]")

# 分类 → 子目录相对路径（name 对非 domain 类恒为 "_"）
_WIKI_GROUP_DIRS = {
    "concept": "concepts",
    "entity": "entities",
    "source": "sources",
    "synthesis": "syntheses",
    "report": "reports",
}
# 应跳过的目录/文件（插件私有、下划线视图、占位 index）
_WIKI_SKIP_DIRS = {".openclaw-wiki", "_attachments", "_views", "domains"}
_WIKI_SKIP_FILES = {"index.md", "AGENTS.md", "WIKI.md", "inbox.md"}


def _parse_frontmatter(content: str) -> tuple:
    """解析 YAML frontmatter（双 schema 平铺键 + 块式列表），返回 (frontmatter, body)。

    用简易逐行解析，与既有实现一致、不引入 pyyaml 运行时依赖。支持：
    - 平铺标量键（插件官方 pageType/id/title 与 researcher type/paper.*/evidence_level）；
    - 行内 [a, b] 列表；
    - 块式列表（key: 换行后跟若干 "  - item"），ingest 对 source_pages/related_pages/tags
      的实际写法（见 researcher 的 workspace AGENTS.md 页面模板）。
    claims 等嵌套结构不解析（人读浏览页与图谱边都不需要）。
    """
    frontmatter = {}
    body = content
    if content.startswith("---"):
        end = content.find("---", 3)
        if end > 0:
            yaml_text = content[3:end].strip()
            body = content[end + 3:].strip()
            last_key = None
            for line in yaml_text.split("\n"):
                stripped = line.strip()
                # 块式列表项：依附于上一个 key
                if stripped.startswith("- ") and last_key:
                    item = stripped[2:].strip().strip('"').strip("'")
                    cur = frontmatter.get(last_key)
                    if not isinstance(cur, list):
                        cur = [] if not cur else [cur]
                        frontmatter[last_key] = cur
                    if item:
                        cur.append(item)
                    continue
                if not stripped or stripped.startswith("#"):
                    continue
                if ":" in line:
                    key, _, val = line.partition(":")
                    key = key.strip()
                    val = val.strip()
                    if val.startswith("[") and val.endswith("]"):
                        val = [v.strip().strip('"').strip("'") for v in val[1:-1].split(",") if v.strip()]
                    else:
                        val = val.strip('"').strip("'")
                    frontmatter[key] = val
                    last_key = key
    return frontmatter, body


def _page_title(fpath: str, fallback: str) -> str:
    """从 frontmatter 取 title（paper.title 优先，兼容插件 title）。"""
    try:
        raw = open(fpath, encoding="utf-8").read(2000)
        fm, _ = _parse_frontmatter(raw if raw.startswith("---") else "---\n" + raw)
        return fm.get("paper.title") or fm.get("title") or fallback
    except Exception:
        return fallback


def _scan_group_dir(dirpath: str, pages_out: list, id_prefix: str = "", kind: str = "") -> None:
    """扫描单个目录下的 .md 页面（跳过占位/索引），追加到 pages_out。

    kind 提供时写入每条 page（图谱构建需要按 kind/domain 归属解析与分组）。
    """
    import os as _os
    if not _os.path.isdir(dirpath):
        return
    for pf in sorted(_os.listdir(dirpath)):
        if not pf.endswith(".md") or pf in _WIKI_SKIP_FILES:
            continue
        fpath = _os.path.join(dirpath, pf)
        pid = id_prefix + pf[:-3]
        page = {
            "id": pid,
            "filename": pf,
            "title": _page_title(fpath, pid),
            "path": fpath,
        }
        if kind:
            page["kind"] = kind
            # name：domain 类为 domain 名，其余 kind 恒为 "_"（与列表路由约定一致）
            page["name"] = id_prefix.rstrip("/") if kind == "domain" else "_"
        pages_out.append(page)


@router.get("/wiki")
async def wiki_list():
    """列出 wiki/main 页面：五核心分类 + domains 子树分组，跳过插件私有目录。

    返回 {groups: [{kind, name, pages}], index, wiki_root}；空骨架 groups 为空（容错）。
    index.md 的 openclaw:wiki:index 生成块内容单独作 index 字段返回（沿用前端展示）。
    """
    import os as _os
    root = RESEARCHER_WIKI_ROOT
    if not _os.path.isdir(root):
        return {"groups": [], "index": "", "wiki_root": root}

    groups = []
    # 五核心分类
    for kind, sub in _WIKI_GROUP_DIRS.items():
        pages = []
        _scan_group_dir(_os.path.join(root, sub), pages)
        if pages:
            groups.append({"kind": kind, "name": sub, "pages": pages, "page_count": len(pages)})

    # domains 子树（researcher 论文页）：domains/<domain>/papers/*.md 归一个 domain 分组
    domain_pages = []
    domains_dir = _os.path.join(root, "domains")
    if _os.path.isdir(domains_dir):
        for dname in sorted(_os.listdir(domains_dir)):
            _scan_group_dir(_os.path.join(domains_dir, dname, "papers"), domain_pages,
                            id_prefix=f"{dname}/")
    if domain_pages:
        groups.append({"kind": "domain", "name": "domains",
                       "pages": domain_pages, "page_count": len(domain_pages)})

    # index.md 单独返回（含 openclaw:wiki:index 生成块原文）
    index_content = ""
    index_path = _os.path.join(root, "index.md")
    if _os.path.isfile(index_path):
        try:
            index_content = open(index_path, encoding="utf-8").read(5000)
        except Exception:
            pass

    return {"groups": groups, "index": index_content, "wiki_root": root}


def _resolve_page_path(kind: str, name: str, page_id: str) -> Optional[str]:
    """把 (kind, name, page_id) 映射为 wiki/main 下的 .md 绝对路径；越界返回 None。"""
    import os as _os
    root = _os.path.realpath(RESEARCHER_WIKI_ROOT)
    if kind == "domain":
        # name 为 domain 名，page_id 为论文 slug
        rel = _os.path.join("domains", name, "papers", page_id + ".md")
    elif kind in _WIKI_GROUP_DIRS:
        rel = _os.path.join(_WIKI_GROUP_DIRS[kind], page_id + ".md")
    else:
        return None
    fpath = _os.path.realpath(_os.path.join(root, rel))
    # 防目录穿越
    if not fpath.startswith(root + _os.sep):
        return None
    return fpath


@router.get("/wiki/{kind}/{name}/{page_id}")
async def wiki_paper(kind: str, name: str, page_id: str):
    """读取指定 wiki 页面完整内容（kind: concept/entity/.../domain）。"""
    import os as _os
    fpath = _resolve_page_path(kind, name, page_id)
    if not fpath or not _os.path.isfile(fpath):
        raise HTTPException(404, f"页面不存在: {kind}/{name}/{page_id}")

    try:
        content = open(fpath, encoding="utf-8").read()
    except Exception as e:
        raise HTTPException(500, f"读取失败: {str(e)}")

    frontmatter, body = _parse_frontmatter(content)
    return {
        "id": page_id,
        "kind": kind,
        "name": name,
        "frontmatter": frontmatter,
        "body": body,
        "content": content,
    }


class WikiSaveBody(BaseModel):
    content: str


@router.put("/wiki/{kind}/{name}/{page_id}")
async def wiki_save(kind: str, name: str, page_id: str, body: WikiSaveBody):
    """保存 wiki 页面：只覆盖已存在页面，不新建、不动 index.md 生成块。

    依赖 memory-wiki render.preserveHumanBlocks=true：整页覆盖写回视作人类编辑。
    """
    import os as _os
    # 不触碰 index 生成块与各分类 index.md（插件 managed 区）
    if page_id == "index":
        raise HTTPException(400, "不允许覆写 index.md（插件生成区）")
    fpath = _resolve_page_path(kind, name, page_id)
    if not fpath or not _os.path.isfile(fpath):
        raise HTTPException(404, f"页面不存在: {kind}/{name}/{page_id}")
    try:
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(body.content)
        return {"success": True, "path": fpath}
    except Exception as e:
        raise HTTPException(500, f"保存失败: {str(e)}")


# ── Wiki 图谱 ──────────────────────────────────────────
# 全库预解析：遍历五核心分类 + domains 出节点，解析正文 [[wikilink]] 与 frontmatter
# related/source_pages 出边，供前端 vis-network 渲染 ego/全局图。
# 节点 id 用 kind/pageId 复合键（与前端 openWikiPaper 一致，点节点直接复用打开）。
# 解析不到目标的链接归为 dangling 占位节点（前端渲 ghost），不产生幻觉页面。

# frontmatter 里作为边来源的键 → 边类型（related_pages 为 ingest 真实键，related 为兼容别名）
_WIKI_FM_EDGE_KEYS = {"related_pages": "related", "related": "related", "source_pages": "source_pages"}

# 归一化 frontmatter 路径引用：剥掉 wiki/、domains/、papers/、methods/ 等目录段与 .md 后缀，
# 留下可作为 page_id / slug 的末段（source_pages/related_pages 的真实值是 vault 相对路径，
# 形如 wiki/domains/<d>/papers/<slug>.md）。
def _graph_normalize_ref(raw: str) -> str:
    s = str(raw).strip().strip('"').strip("'")
    if s.endswith(".md"):
        s = s[:-3]
    s = s.replace("\\", "/").strip("/")
    if "/" in s:
        s = s.split("/")[-1]
    return s


def _graph_resolve_target(raw: str, pages: list, exact: dict, lower: dict, slug_lower: dict) -> str:
    """把 wikilink / frontmatter 引用解析为节点 id；解析不到返回 None。

    引用形似 "concept.example-topic" / "ml/attention-survey"（=page_id）、页 title，
    或 vault 路径（wiki/domains/<d>/papers/<slug>.md）。先归一化取末段，再
    精确（page_id → title）→ 大小写不敏感 → domain slug 末段匹配。
    """
    target = _graph_normalize_ref(raw)
    if not target:
        return None
    if target in exact:
        return exact[target]
    tl = target.lower()
    if tl in lower:
        return lower[tl]
    # domain slug 末段匹配（source_pages: [attention-survey] / 路径末段 → domain/ml/attention-survey）
    return slug_lower.get(tl)


def _build_wiki_graph(root: str) -> dict:
    """遍历 wiki/main 全库构建图谱 {nodes, edges}。

    nodes: [{id, kind, name, pageId, title}]（dangling 占位节点为 {id, title, dangling}）；
    edges: [{from, to, type}]，type ∈ wikilink/related/source_pages。
    """
    import os as _os
    pages = []
    for kind, sub in _WIKI_GROUP_DIRS.items():
        _scan_group_dir(_os.path.join(root, sub), pages, id_prefix="", kind=kind)
    domains_dir = _os.path.join(root, "domains")
    if _os.path.isdir(domains_dir):
        for dname in sorted(_os.listdir(domains_dir)):
            _scan_group_dir(_os.path.join(domains_dir, dname, "papers"), pages,
                            id_prefix=f"{dname}/", kind="domain")

    nodes = []
    for p in pages:
        nid = f"{p['kind']}/{p['id']}"
        p["_nid"] = nid
        nodes.append({"id": nid, "kind": p["kind"], "name": p["name"],
                      "pageId": p["id"], "title": p["title"]})

    exact, lower, slug_lower = {}, {}, {}
    for p in pages:
        exact[p["id"]] = p["_nid"]
        exact[p["title"]] = p["_nid"]
        lower[p["id"].lower()] = p["_nid"]
        lower[p["title"].lower()] = p["_nid"]
        if p["kind"] == "domain":
            slug_lower[p["id"].split("/")[-1].lower()] = p["_nid"]

    edges = []
    dangling = {}
    seen = set()

    def _add_edge(src, tgt, etype):
        key = (src, tgt, etype)
        if key in seen:
            return
        seen.add(key)
        edges.append({"from": src, "to": tgt, "type": etype})

    for p in pages:
        try:
            content = open(p["path"], encoding="utf-8").read()
        except Exception:
            continue
        fm, body = _parse_frontmatter(content)
        # 正文 wikilink 边
        for m in _WIKILINK_RE.finditer(body):
            tgt = _graph_resolve_target(m.group(1), pages, exact, lower, slug_lower)
            if tgt is None:
                label = _graph_normalize_ref(m.group(1))
                tgt = f"dangling/{label}"
                if tgt not in dangling:
                    dangling[tgt] = True
                    nodes.append({"id": tgt, "title": label, "dangling": True})
            _add_edge(p["_nid"], tgt, "wikilink")
        # frontmatter related_pages / source_pages 边
        for key, etype in _WIKI_FM_EDGE_KEYS.items():
            val = fm.get(key)
            if not val:
                continue
            items = val if isinstance(val, list) else [val]
            for item in items:
                tgt = _graph_resolve_target(str(item), pages, exact, lower, slug_lower)
                if tgt:
                    _add_edge(p["_nid"], tgt, etype)

    return {"nodes": nodes, "edges": edges}


# 进程内图谱缓存：按 vault 内所有 .md 的最新 mtime 失效。大库（AC「大库不卡」）下避免
# 每请求全库逐页 open×2 + 正则重建；保存/新增页面后 mtime 变化即自动重建。
_wiki_graph_cache: dict = {"sig": None, "graph": None}


def _wiki_vault_signature(root: str) -> float:
    """vault 内容签名 = 所有 .md 的 (路径, mtime) 集合哈希；变化即代表图谱需重建。"""
    import os as _os
    sig = []
    for kind, sub in _WIKI_GROUP_DIRS.items():
        d = _os.path.join(root, sub)
        if _os.path.isdir(d):
            for f in _os.listdir(d):
                if f.endswith(".md"):
                    fp = _os.path.join(d, f)
                    sig.append((fp, _os.path.getmtime(fp)))
    domains_dir = _os.path.join(root, "domains")
    if _os.path.isdir(domains_dir):
        for dname in sorted(_os.listdir(domains_dir)):
            pd = _os.path.join(domains_dir, dname, "papers")
            if _os.path.isdir(pd):
                for f in _os.listdir(pd):
                    if f.endswith(".md"):
                        fp = _os.path.join(pd, f)
                        sig.append((fp, _os.path.getmtime(fp)))
    return hash(tuple(sig))


@router.get("/wiki/graph")
async def wiki_graph():
    """全库预解析图谱：节点（kind/pageId 复合 id + kind/title）+ 边（from/to/type）。

    供前端 vis-network 渲染：默认 ego 图（当前页 1–2 跳）、可切全局；dangling 节点渲 ghost。
    结果按 vault mtime 签名做进程内缓存，内容变化自动失效。
    """
    import os as _os
    root = RESEARCHER_WIKI_ROOT
    if not _os.path.isdir(root):
        return {"nodes": [], "edges": []}
    sig = _wiki_vault_signature(root)
    if _wiki_graph_cache["sig"] == sig and _wiki_graph_cache["graph"] is not None:
        return _wiki_graph_cache["graph"]
    graph = _build_wiki_graph(root)
    _wiki_graph_cache["sig"] = sig
    _wiki_graph_cache["graph"] = graph
    return graph
