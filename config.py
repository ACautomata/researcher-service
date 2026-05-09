"""全局配置，从 .env 加载"""
import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    # 服务
    HOST: str = os.getenv("HOST", "127.0.0.1")
    PORT: int = int(os.getenv("PORT", "8000"))
    UPLOAD_DIR: str = os.getenv("UPLOAD_DIR", "./uploads")
    DB_PATH: str = os.getenv("DB_PATH", "./pipeline.db")

    # AI API —— 所有 OpenAI 兼容格式统一入口
    AI_API_BASE: str = os.getenv("AI_API_BASE", "https://open.bigmodel.cn/api/paas/v4")
    AI_API_KEY: str = os.getenv("AI_API_KEY", "")
    AI_MODEL: str = os.getenv("AI_MODEL", "glm-4")

    # 外部搜索
    ARXIV_ENABLED: bool = os.getenv("ARXIV_ENABLED", "true").lower() == "true"

    # Claude Agent SDK（key 为空时复用 AI_API_KEY）
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    ANTHROPIC_BASE_URL: str = os.getenv("ANTHROPIC_BASE_URL", "")
    ANTHROPIC_MODEL: str = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
    AGENT_AUTO_APPROVE: bool = os.getenv("AGENT_AUTO_APPROVE", "true").lower() == "true"

    # Obsidian Vault
    OBSIDIAN_VAULT_PATH: str = os.getenv("OBSIDIAN_VAULT_PATH", "")

    # 用户认证（.env 设置 AUTH_ENABLED=true 时，除 /api/v1/auth/* 外所有 API 需携带 Bearer token）
    AUTH_ENABLED: bool = os.getenv("AUTH_ENABLED", "false").lower() == "true"
    AUTH_SESSION_DAYS: int = int(os.getenv("AUTH_SESSION_DAYS", "30"))
    # 流水线相关 API 是否必须登录（true 时未登录无法调用 kb/lit/idea/algo/agent/obsidian）
    PIPELINE_REQUIRES_LOGIN: bool = os.getenv("PIPELINE_REQUIRES_LOGIN", "false").lower() == "true"

    @classmethod
    def ai_headers(cls) -> dict:
        return {
            "Authorization": f"Bearer {cls.AI_API_KEY}",
            "Content-Type": "application/json",
        }


cfg = Config()

AI_API_BASE = cfg.AI_API_BASE
AI_API_KEY = cfg.AI_API_KEY
AI_MODEL = cfg.AI_MODEL
HOST = cfg.HOST
PORT = cfg.PORT
UPLOAD_DIR = cfg.UPLOAD_DIR
DB_PATH = cfg.DB_PATH
ANTHROPIC_API_KEY = cfg.ANTHROPIC_API_KEY or cfg.AI_API_KEY
ANTHROPIC_BASE_URL = cfg.ANTHROPIC_BASE_URL
ANTHROPIC_MODEL = cfg.ANTHROPIC_MODEL
AGENT_AUTO_APPROVE = cfg.AGENT_AUTO_APPROVE
OBSIDIAN_VAULT_PATH = cfg.OBSIDIAN_VAULT_PATH
AUTH_ENABLED = cfg.AUTH_ENABLED
AUTH_SESSION_DAYS = cfg.AUTH_SESSION_DAYS
PIPELINE_REQUIRES_LOGIN = cfg.PIPELINE_REQUIRES_LOGIN