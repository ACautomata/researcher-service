"""
启动入口
"""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import HOST, PORT, AI_API_BASE, AI_MODEL, AUTH_ENABLED, PIPELINE_REQUIRES_LOGIN
from database import init_db

from routes.kb import router as kb_router
from routes.lit import router as lit_router
from routes.idea import router as idea_router
from routes.algo import router as algo_router
from routes.agent import router as agent_router
from routes.obsidian import router as obsidian_router
from routes.auth import router as auth_router, session_user
from routes.user_settings import router as user_settings_router
from services.request_context import ctx_user_id


def _pipeline_api_path(path: str) -> bool:
    if not path.startswith("/api/v1/"):
        return False
    if path.startswith("/api/v1/auth") or path.startswith("/api/v1/user"):
        return False
    for prefix in (
        "/api/v1/kb",
        "/api/v1/lit",
        "/api/v1/idea",
        "/api/v1/algo",
        "/api/v1/agent",
        "/api/v1/obsidian",
    ):
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


@asynccontextmanager
async def lifespan(app):
    os.makedirs("./uploads", exist_ok=True)
    await init_db()
    print(f"\n  [OK] 数据库: ./pipeline.db")
    print(f"  [OK] AI API: {AI_API_BASE} / {AI_MODEL}")
    print(f"  [OK] 鉴权:   AUTH_ENABLED={'true' if AUTH_ENABLED else 'false'}  PIPELINE_REQUIRES_LOGIN={'true' if PIPELINE_REQUIRES_LOGIN else 'false'}")
    print(f"  [OK] 地址:   http://localhost:{PORT}")
    print(f"  [OK] 文档:   http://localhost:{PORT}/docs\n")
    yield


app = FastAPI(title="AI Research Pipeline", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                    allow_methods=["*"], allow_headers=["*"])

# 1. 注册所有 API 路由
app.include_router(kb_router)
app.include_router(lit_router)
app.include_router(idea_router)
app.include_router(algo_router)
app.include_router(agent_router)
app.include_router(obsidian_router)
app.include_router(auth_router)
app.include_router(user_settings_router)


@app.middleware("http")
async def user_and_auth_middleware(request: Request, call_next):
    """解析会话用户；按 AUTH_ENABLED / PIPELINE_REQUIRES_LOGIN 限制 API。"""
    request.state.user = None
    token = ""
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    else:
        p = request.url.path
        if p.endswith("/stream") and "/api/v1/agent/chat/" in p:
            token = (request.query_params.get("access_token") or "").strip()

    user = await session_user(token) if token else None
    ctx_reset = None
    if user:
        request.state.user = user
        ctx_reset = ctx_user_id.set(user["id"])
    try:
        if request.method == "OPTIONS":
            return await call_next(request)
        path = request.url.path
        if not path.startswith("/api/v1"):
            return await call_next(request)
        if path.startswith("/api/v1/auth"):
            return await call_next(request)
        need_login = False
        if AUTH_ENABLED:
            need_login = True
        elif PIPELINE_REQUIRES_LOGIN and _pipeline_api_path(path):
            need_login = True
        if need_login and not getattr(request.state, "user", None):
            return JSONResponse({"detail": "请先登录后再使用此功能"}, status_code=401)
        return await call_next(request)
    finally:
        if ctx_reset is not None:
            ctx_user_id.reset(ctx_reset)

app.mount("/", StaticFiles(directory="public", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True, log_level="info")