"""pytest 共享 fixture：定位仓库根下的部署交付物文件。"""
import json
import sys
from pathlib import Path

import pytest
import yaml
from httpx import ASGITransport, AsyncClient

REPO_ROOT = Path(__file__).resolve().parent.parent
DEPLOY_DIR = REPO_ROOT / "deploy"

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def compose() -> dict:
    """解析 deploy/docker-compose.yml 为 dict。"""
    return yaml.safe_load((DEPLOY_DIR / "docker-compose.yml").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def gateway_service(compose) -> dict:
    return compose["services"]["openclaw-gateway"]


@pytest.fixture(scope="session")
def gateway_env(gateway_service) -> dict:
    return gateway_service["environment"]


@pytest.fixture(scope="session")
def deploy_env_example() -> str:
    return (DEPLOY_DIR / ".env.example").read_text(encoding="utf-8")


@pytest.fixture(scope="session")
def root_env_example() -> str:
    return (REPO_ROOT / ".env.example").read_text(encoding="utf-8")


@pytest.fixture(scope="session")
def openclaw_config() -> dict:
    """本仓库维护的精简版 openclaw.json（deploy/openclaw.json），compose 挂载覆盖 researcher 的同名文件。"""
    return json.loads((DEPLOY_DIR / "openclaw.json").read_text(encoding="utf-8"))


@pytest.fixture
async def openclaw_fake(monkeypatch):
    """fake OpenClaw WS 替身 + 把 openclaw_service 的凭据解析指向它。

    返回 (server, service)。service 为 services.openclaw_service 模块，
    其 WS 客户端单例已在每个用例前后重置，避免连接串扰。
    """
    from tests.fake_openclaw import FakeOpenClawServer
    import services.openclaw_service as service

    server = await FakeOpenClawServer.start(token="test-token")

    async def fake_creds():
        # (gateway_url, gateway_token, api_key) —— url 用 ws:// 指向替身
        return server.url, "test-token", ""

    monkeypatch.setattr(service, "get_effective_openclaw", fake_creds)
    monkeypatch.setattr(service, "OPENCLAW_ENABLED", True)
    service.use_creds_provider(fake_creds)
    try:
        yield server, service
    finally:
        await service.close_ws_client()
        await server.close()


@pytest.fixture
async def openclaw_route(monkeypatch, tmp_path):
    """FastAPI 路由级接缝：真实 app + 临时 SQLite + fake WS 替身。

    返回 (client, server, service)。把 openclaw_service 的凭据指向 fake 替身、
    OPENCLAW_ENABLED 置 True、数据库指向临时文件（不碰仓库根 pipeline.db）。
    """
    from tests.fake_openclaw import FakeOpenClawServer
    import services.openclaw_service as service
    import database
    import main as app_module

    db_path = str(tmp_path / "test_pipeline.db")
    monkeypatch.setattr(database, "DB_PATH", db_path)
    await database.init_db()

    server = await FakeOpenClawServer.start(token="test-token")

    async def fake_creds():
        return server.url, "test-token", ""

    monkeypatch.setattr(service, "get_effective_openclaw", fake_creds)
    monkeypatch.setattr(service, "OPENCLAW_ENABLED", True)
    # 路由层 import 的是同一 service 模块的 OPENCLAW_ENABLED（from-import 拷贝），一并 patch
    import routes.openclaw as route_module
    monkeypatch.setattr(route_module, "OPENCLAW_ENABLED", True)
    service.use_creds_provider(fake_creds)

    transport = ASGITransport(app=app_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        try:
            yield client, server, service
        finally:
            await service.close_ws_client()
            await server.close()


@pytest.fixture
async def openclaw_upload(monkeypatch, tmp_path):
    """文件上传接缝：真实 app + 临时 workspace 根。

    返回 (client, workspace_root)。workspace_root 为临时目录，路由应把上传写到其 oc-uploads 下。
    """
    import database
    import routes.openclaw as route_module
    import main as app_module

    db_path = str(tmp_path / "test_pipeline.db")
    monkeypatch.setattr(database, "DB_PATH", db_path)
    await database.init_db()

    workspace_root = tmp_path / "workspace"
    monkeypatch.setattr(route_module, "OPENCLAW_ENABLED", True)
    monkeypatch.setattr(route_module, "RESEARCHER_WORKSPACE_PATH", str(workspace_root))

    transport = ASGITransport(app=app_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, workspace_root


def _make_wiki_client(monkeypatch, tmp_path, empty: bool):
    """构造 Wiki 接缝 client：临时 wiki/main 骨架 + 真实 app。返回 (client, wiki_root)。"""
    import database
    import routes.openclaw as route_module
    import main as app_module
    from tests.wiki_fixtures import build_wiki_skeleton

    async def _setup():
        db_path = str(tmp_path / "test_pipeline.db")
        monkeypatch.setattr(database, "DB_PATH", db_path)
        await database.init_db()

    wiki_root = build_wiki_skeleton(tmp_path, empty=empty)
    monkeypatch.setattr(route_module, "OPENCLAW_ENABLED", True)
    monkeypatch.setattr(route_module, "RESEARCHER_WIKI_ROOT", str(wiki_root))

    transport = ASGITransport(app=app_module.app)
    return _setup, AsyncClient(transport=transport, base_url="http://test"), wiki_root


@pytest.fixture
async def openclaw_wiki(monkeypatch, tmp_path):
    """Wiki 接缝（含页面骨架）：返回 (client, wiki_root)。"""
    setup, client, wiki_root = _make_wiki_client(monkeypatch, tmp_path, empty=False)
    await setup()
    async with client:
        yield client, wiki_root


@pytest.fixture
async def openclaw_wiki_empty(monkeypatch, tmp_path):
    """Wiki 接缝（0-pages 空骨架）：返回 (client, wiki_root)。"""
    setup, client, wiki_root = _make_wiki_client(monkeypatch, tmp_path, empty=True)
    await setup()
    async with client:
        yield client, wiki_root


class _RestartSpy:
    """记录 apply-config 是否触发了重启钩子。"""

    def __init__(self):
        self.called = False

    def __call__(self):
        self.called = True


def _write_min_openclaw_json(path):
    """写一份最小的单 main openclaw.json 到 path（apply-config/status 测试用）。"""
    import json as _json
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_json.dumps({
        "models": {"providers": {"minimax": {"baseUrl": "https://api.minimaxi.com/anthropic",
                                             "models": [{"id": "MiniMax-M3"}]}}},
        "agents": {"defaults": {"model": {"primary": "minimax/MiniMax-M3"}},
                   "list": [{"id": "main", "name": "Research Assistant", "default": True,
                             "workspace": "~/.openclaw/workspace"}]},
        "auth": {"profiles": {"minimax:cn": {"provider": "minimax", "mode": "api_key"}}},
    }), encoding="utf-8")


@pytest.fixture
async def openclaw_apply(monkeypatch, tmp_path):
    """apply-config 接缝：tmp RESEARCHER_CONFIG_PATH + 重启钩子 spy。

    返回 (client, cfg_path, restart_spy)。重启钩子注入 spy（不真跑 docker）。
    """
    import database
    import routes.openclaw as route_module
    import main as app_module

    db_path = str(tmp_path / "test_pipeline.db")
    monkeypatch.setattr(database, "DB_PATH", db_path)
    await database.init_db()

    cfg_path = tmp_path / "researcher" / "openclaw.json"
    _write_min_openclaw_json(cfg_path)

    spy = _RestartSpy()
    monkeypatch.setattr(route_module, "OPENCLAW_ENABLED", True)
    monkeypatch.setattr(route_module, "RESEARCHER_CONFIG_PATH", str(cfg_path))
    monkeypatch.setattr(route_module, "restart_gateway_hook", spy)

    transport = ASGITransport(app=app_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, cfg_path, spy


@pytest.fixture
async def openclaw_status(monkeypatch, tmp_path):
    """status 接缝：tmp RESEARCHER_CONFIG_PATH（含单 main）+ OPENCLAW_ENABLED=True。

    返回 client。health()/docker inspect 失败被 status 容错，不影响 subagent 维度断言。
    """
    import database
    import routes.openclaw as route_module
    import main as app_module

    db_path = str(tmp_path / "test_pipeline.db")
    monkeypatch.setattr(database, "DB_PATH", db_path)
    await database.init_db()

    cfg_path = tmp_path / "researcher" / "openclaw.json"
    _write_min_openclaw_json(cfg_path)

    monkeypatch.setattr(route_module, "OPENCLAW_ENABLED", True)
    monkeypatch.setattr(route_module, "RESEARCHER_CONFIG_PATH", str(cfg_path))

    transport = ASGITransport(app=app_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
