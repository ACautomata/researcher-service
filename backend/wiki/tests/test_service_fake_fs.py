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
    # 五分类之外的未知目录（issue #83 物理化）：照实成组
    fs.pages['experiments/trial-1.md'] = (
        '---\ntitle: Trial 1\n---\n# Trial 1\n'
    )
    return WikiService(_FakeInstance(), fs=fs)


# —— build_tree ——

def test_build_tree_mirrors_real_dirs(svc):
    """分组 = 页面真实顶层目录，不写死五分类；未知目录也成组。"""
    tree = svc.build_tree()
    kinds = {g['kind'] for g in tree['groups']}
    assert {'concepts', 'domains', 'experiments'} <= kinds


def test_build_tree_no_five_category_assumption(svc):
    """五分类单数键（concept/entity/…）已废；物理无对应目录不成组。"""
    tree = svc.build_tree()
    kinds = {g['kind'] for g in tree['groups']}
    assert 'concept' not in kinds
    assert 'entity' not in kinds
    # fixture 中物理不存在 entities/sources/syntheses/reports → 不成组
    assert 'entities' not in kinds
    assert 'syntheses' not in kinds
    assert 'reports' not in kinds


def test_build_tree_has_pages(svc):
    tree = svc.build_tree()
    concepts = next(g for g in tree['groups'] if g['kind'] == 'concepts')
    paths = {p['path'] for p in concepts['pages']}
    assert 'concepts/attention.md' in paths


def test_build_tree_unknown_dir_grouped(svc):
    tree = svc.build_tree()
    experiments = next(g for g in tree['groups'] if g['kind'] == 'experiments')
    assert experiments['name'] == 'experiments'
    paths = {p['path'] for p in experiments['pages']}
    assert paths == {'experiments/trial-1.md'}


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


def test_create_path_traversal_raises(svc):
    with pytest.raises(InvalidPath):
        svc.create_page('../../evil.md', 'x')


def test_create_managed_dir_raises(svc):
    with pytest.raises(InvalidPath):
        svc.create_page('.openclaw-wiki/evil.md', 'x')


def test_create_managed_file_raises(svc):
    with pytest.raises(InvalidPath):
        svc.create_page('concepts/index.md', 'x')


# —— read_page path validation ——

def test_read_path_traversal_raises(svc):
    with pytest.raises(InvalidPath):
        svc.read_page('../../evil.md')


def test_read_managed_dir_raises(svc):
    with pytest.raises(InvalidPath):
        svc.read_page('.openclaw-wiki/evil.md')


def test_read_managed_file_raises(svc):
    with pytest.raises(InvalidPath):
        svc.read_page('concepts/index.md')


# —— write_page path validation ——

def test_write_path_traversal_raises(svc):
    with pytest.raises(InvalidPath):
        svc.write_page('../../evil.md', 'x')


def test_write_managed_dir_raises(svc):
    with pytest.raises(InvalidPath):
        svc.write_page('.openclaw-wiki/evil.md', 'x')


def test_write_managed_file_raises(svc):
    with pytest.raises(InvalidPath):
        svc.write_page('concepts/index.md', 'x')


# —— delete_page path validation ——

def test_delete_path_traversal_raises(svc):
    with pytest.raises(InvalidPath):
        svc.delete_page('../../evil.md')


def test_delete_managed_dir_raises(svc):
    with pytest.raises(InvalidPath):
        svc.delete_page('.openclaw-wiki/evil.md')


def test_delete_managed_file_raises(svc):
    with pytest.raises(InvalidPath):
        svc.delete_page('concepts/index.md')


# —— build_graph ——

def test_build_graph_nodes_from_tree(svc):
    graph = svc.build_graph()
    node_ids = {n['id'] for n in graph['nodes']}
    assert 'concepts/attention.md' in node_ids
    assert 'domains/cv/papers/resnet.md' in node_ids
