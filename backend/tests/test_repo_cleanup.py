"""仓库收尾验收测试（issue #48 / T12）。

验收标准（可机械化部分）：
1. 旧 FastAPI 后端与 `public/` vanilla-JS 前端全部删除，仓库仅留 backend/frontend/deploy/docs。
2. deploy/README 与根 README 反映新架构（Django 控制面 + 多容器 + 配对 + 端口池 + docker.sock），
   不再把本仓库描述成「FastAPI + 单文件前端」。

这些测试在删除发生前应失败（红），删除 + 文档更新后通过（绿）。
"""
from pathlib import Path

import pytest

# backend/tests/ → 上溯两级 = 仓库根
REPO_ROOT = Path(__file__).resolve().parents[2]

# 旧 FastAPI 后端 / vanilla-JS 前端 / 旧测试与脚手架 —— 应全部删除（spec §0.2）。
OLD_PATHS = [
    'main.py',
    'config.py',
    'database.py',
    'models.py',
    '_gen_invite.py',
    'requirements.txt',
    'pytest.ini',
    '.env.example',
    'routes',
    'services',
    'public',
    'tests',
    'vault',  # 用户指示（#48 收尾）：示例 vault 一并删除
    'research-agent-main',  # 用户指示（#48 收尾）：旧模板克隆一并删除
]

# 新架构目录 —— 必须存在（spec §2 目标布局）。
KEPT_PATHS = [
    'backend',
    'frontend',
    'deploy',
    'docs',
]


class TestOldCodeRemoved:
    @pytest.mark.parametrize('rel', OLD_PATHS)
    def test_old_path_gone(self, rel: str) -> None:
        assert not (REPO_ROOT / rel).exists(), f'旧代码残留: {rel}'


class TestNewLayoutKept:
    @pytest.mark.parametrize('rel', KEPT_PATHS)
    def test_kept_dir_exists(self, rel: str) -> None:
        assert (REPO_ROOT / rel).is_dir(), f'保留目录缺失: {rel}'


class TestDocsReflectNewArchitecture:
    """deploy/README 与根 README 须描述新架构（Django 控制面 + 多容器编排）。"""

    # 三处 README 都应出现的新架构关键词（任一即算命中）。
    NEW_TERMS = ('Django', 'Channels')
    # 新架构核心概念：多容器编排 / 配对 / 端口池 / docker.sock。
    CONCEPT_TERMS = ('容器', '配对', '端口池', 'docker.sock')

    def _read(self, rel: str) -> str:
        return (REPO_ROOT / rel).read_text(encoding='utf-8')

    @pytest.mark.parametrize('rel', ['README.md', 'deploy/README.md'])
    def test_mentions_django_stack(self, rel: str) -> None:
        text = self._read(rel)
        assert any(t in text for t in self.NEW_TERMS), f'{rel} 未提及新栈 {self.NEW_TERMS}'

    @pytest.mark.parametrize('rel', ['README.md', 'deploy/README.md'])
    def test_mentions_orchestration_concepts(self, rel: str) -> None:
        text = self._read(rel)
        assert any(t in text for t in self.CONCEPT_TERMS), f'{rel} 未提及编排概念 {self.CONCEPT_TERMS}'

    @pytest.mark.parametrize('rel', ['README.md', 'deploy/README.md'])
    def test_no_longer_fastapi_self_reference(self, rel: str) -> None:
        """不得再把「本仓库后端」描述为 FastAPI（允许提及历史/迁移背景，但不得作为当前栈）。"""
        text = self._read(rel)
        assert 'FastAPI 后端' not in text, f'{rel} 仍以 FastAPI 描述本仓库后端'
