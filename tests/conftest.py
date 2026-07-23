"""pytest 共享 fixture：定位仓库根下的部署交付物文件。"""
import json
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
DEPLOY_DIR = REPO_ROOT / "deploy"


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
