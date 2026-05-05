"""Pydantic 请求/响应模型"""
from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum


# ===== 通用 =====
class TaskResponse(BaseModel):
    task_id: str
    status: str
    progress: int = 0
    step: Optional[str] = None


class OkResponse(BaseModel):
    success: bool = True
    message: str = ""


# ===== 知识库 =====
class ParseRequest(BaseModel):
    upload_id: int


class DeleteEntriesRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)


# ===== 文献分析 =====
class AutoDiscoverRequest(BaseModel):
    entry_ids: list[int] = Field(default_factory=list)
    deep_analysis: str = "deep"  # quick / deep / cross


class ExternalSearchRequest(BaseModel):
    keyword: str
    source: str = "arxiv"


class ValidateRequest(BaseModel):
    problem_ids: list[str] = Field(default_factory=list)
    method: str = "cross_reference"  # cross_reference / experiment / expert


# ===== Idea =====
class GenerateIdeaRequest(BaseModel):
    problem_ids: list[str] = Field(default_factory=list)
    direction: Optional[str] = None


# ===== 算法 =====
class GenerateAlgoRequest(BaseModel):
    idea_id: str
    language: str = "Python"