"""FakeWikiFileSystem 越权防护回归测试 —— codex PR #111 P2 修复（issue #100）。

Fake 不应导入 Adapter 私有常量，而应在构造层内联路径校验规则
（_SKIP_DIRS/_SKIP_FILES 副本 + '..' 段拒绝），确保 CRUD 各方法
在越权路径上也抛 ValueError，对齐 BindMountWikiFileSystem。
"""
import pytest

from integration.openclaw.fakes import FakeWikiFileSystem


@pytest.fixture
def fs():
    f = FakeWikiFileSystem()
    f.pages['concepts/attention.md'] = '---\ntitle: Attention\n---\n# A\n'
    return f


# —— traversal ——

def test_read_rejects_traversal(fs):
    with pytest.raises(ValueError):
        fs.read_page('../../../etc/passwd.md')


def test_write_rejects_traversal(fs):
    with pytest.raises(ValueError):
        fs.write_page('../../../etc/passwd.md', 'x')


def test_create_rejects_traversal(fs):
    with pytest.raises(ValueError):
        fs.create_page('../../evil.md', 'x')


def test_delete_rejects_traversal(fs):
    with pytest.raises(ValueError):
        fs.delete_page('../../evil.md')


# —— managed dirs ——

def test_read_rejects_dot_openclaw_wiki(fs):
    with pytest.raises(ValueError):
        fs.read_page('.openclaw-wiki/cache.md')


def test_create_rejects_managed_dir(fs):
    with pytest.raises(ValueError):
        fs.create_page('.openclaw-wiki/evil.md', 'x')


# —— managed files ——

def test_read_rejects_index(fs):
    with pytest.raises(ValueError):
        fs.read_page('index.md')


def test_write_rejects_index(fs):
    with pytest.raises(ValueError):
        fs.write_page('index.md', 'x')


def test_delete_rejects_agents_md(fs):
    with pytest.raises(ValueError):
        fs.delete_page('AGENTS.md')


# —— valid paths still work ——

def test_valid_read_still_works(fs):
    page = fs.read_page('concepts/attention.md')
    assert page['title'] == 'Attention'


def test_valid_write_still_works(fs):
    fs.write_page('concepts/attention.md', '# edited\n')
    assert fs.pages['concepts/attention.md'] == '# edited\n'
