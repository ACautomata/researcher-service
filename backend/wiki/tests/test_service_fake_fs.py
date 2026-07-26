"""wiki 服务 fake 文件系统单测 —— issue #100 acceptance 3：树构建/CRUD/越权防护可 fake 文件系统单测。

不依赖 bind-mount / Instance DB / Django，直接注入 FakeWikiFileSystem 验证 WikiService 行为。
"""
import pytest

from integration.openclaw.fakes import FakeWikiFileSystem
from wiki.service import InvalidPath, PageExists, PageNotFound, WikiService


class _FakeInstance:
    """WikiService 的轻量 stub：仅提供 home_dir（fake fs 下不使用，但构造签名兼容）。"""
    home_dir = '/fake'


@pytest.fixture
def svc():
    """WikiService 构造注入 FakeWikiFileSystem（不碰真文件系统）。"""
    fs = FakeWikiFileSystem()
    fs.pages['concepts/attention.md'] = (
        '---\ntitle: Attention\n---\n# Attention\n'
    )
    fs.pages['concepts/transformer.md'] = (
        '---\ntitle: Transformer\n---\n# T\n'
    )
    fs.pages['domains/cv/papers/resnet.md'] = (
        '---\npaper:\n  title: ResNet\n---\n# ResNet\n'
    )
    return WikiService(_FakeInstance(), fs=fs)


# —— build_tree ——

def test_build_tree_five_core_kinds(svc):
    tree = svc.build_tree()
    kinds = {g['kind'] for g in tree['groups']}
    assert {'concept', 'entity', 'source', 'synthesis', 'report', 'domain'} <= kinds


def test_build_tree_has_pages(svc):
    tree = svc.build_tree()
    concept = next(g for g in tree['groups'] if g['kind'] == 'concept')
    paths = {p['path'] for p in concept['pages']}
    assert 'concepts/attention.md' in paths


# —— read_page ——

def test_read_page(svc):
    page = svc.read_page('concepts/attention.md')
    assert page['path'] == 'concepts/attention.md'
    assert page['title'] == 'Attention'
    assert '# Attention' in page['content']


def test_read_missing(svc):
    with pytest.raises(PageNotFound):
        svc.read_page('concepts/nope.md')


# —— write_page ——

def test_write_overwrites(svc):
    svc.write_page('concepts/attention.md', '# 已编辑\n')
    assert svc.read_page('concepts/attention.md')['content'] == '# 已编辑\n'


def test_write_missing_raises(svc):
    with pytest.raises(PageNotFound):
        svc.write_page('concepts/nope.md', 'x')


# —— create_page ——

def test_create_page(svc):
    svc.create_page('concepts/new.md', '# New\n')
    assert svc.read_page('concepts/new.md')['content'] == '# New\n'


def test_create_existing_raises(svc):
    with pytest.raises(PageExists):
        svc.create_page('concepts/attention.md', 'x')


# —— delete_page ——

def test_delete_page(svc):
    svc.delete_page('concepts/attention.md')
    with pytest.raises(PageNotFound):
        svc.read_page('concepts/attention.md')


def test_delete_missing_raises(svc):
    with pytest.raises(PageNotFound):
        svc.delete_page('concepts/nope.md')


# —— build_graph ——

def test_build_graph_nodes_from_tree(svc):
    graph = svc.build_graph()
    node_ids = {n['id'] for n in graph['nodes']}
    assert 'concepts/attention.md' in node_ids
    assert 'domains/cv/papers/resnet.md' in node_ids
