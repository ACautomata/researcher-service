"""issue #19 文件上传到 main workspace 的接缝测试。

接缝 = FastAPI 路由 POST /openclaw/upload。
断言：上传落到 researcher workspace/oc-uploads（uuid 前缀防重名）；
upload 仅接受 agent_id=main，其它一律拒绝；非 main 不落盘。
"""
import io

import pytest


@pytest.mark.asyncio
async def test_upload_main_writes_to_workspace_oc_uploads(openclaw_upload):
    """agent_id=main 上传成功，文件写入 workspace/oc-uploads，带 uuid 前缀，返回相对路径。"""
    client, workspace_root = openclaw_upload

    files = {"file": ("notes.txt", io.BytesIO(b"hello world"), "text/plain")}
    r = await client.post("/api/v1/openclaw/upload", data={"agent_id": "main"}, files=files)

    assert r.status_code == 200, r.text
    body = r.json()
    saved = workspace_root / "oc-uploads" / body["saved_as"]
    assert saved.is_file(), f"文件应落到 {saved}"
    assert saved.read_bytes() == b"hello world"
    assert body["saved_as"] != "notes.txt", "应加 uuid 前缀防重名"
    assert body["saved_as"].endswith("_notes.txt")
    assert body["path"].startswith("oc-uploads/")


@pytest.mark.asyncio
async def test_upload_rejects_non_main_agent(openclaw_upload):
    """非 main 的 agent_id 一律拒绝（单 main 收敛），且不落盘。"""
    client, workspace_root = openclaw_upload

    files = {"file": ("x.txt", io.BytesIO(b"data"), "text/plain")}
    r = await client.post("/api/v1/openclaw/upload", data={"agent_id": "paper-review"}, files=files)

    assert r.status_code == 400, r.text
    assert not (workspace_root / "oc-uploads").exists() or not list(
        (workspace_root / "oc-uploads").iterdir()
    ), "非 main 不应落盘"


@pytest.mark.asyncio
async def test_upload_rejects_autoresearch_and_idea_generate(openclaw_upload):
    """其余已删子 agent 同样拒绝。"""
    client, _ = openclaw_upload
    for bad in ("autoresearch", "idea-generate"):
        files = {"file": ("x.txt", io.BytesIO(b"d"), "text/plain")}
        r = await client.post("/api/v1/openclaw/upload", data={"agent_id": bad}, files=files)
        assert r.status_code == 400, f"{bad} 应被拒绝"
