"""
启动入口
"""
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from config import HOST, PORT, AI_API_BASE, AI_MODEL
from database import init_db

from routes.kb import router as kb_router
from routes.lit import router as lit_router
from routes.idea import router as idea_router
from routes.algo import router as algo_router
from routes.agent import router as agent_router


@asynccontextmanager
async def lifespan(app):
    os.makedirs("./uploads", exist_ok=True)
    await init_db()
    print(f"\n  [OK] 数据库: ./pipeline.db")
    print(f"  [OK] AI API: {AI_API_BASE} / {AI_MODEL}")
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

# 2. 只用 FileResponse 返回首页，不用 StaticFiles
@app.get("/")
async def index():
    return FileResponse("./public/index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True, log_level="info")