"""seam: BindMountWikiFileSystem.build_tree —— issue #83 物理化（真实文件系统）。

直接对真实 Adapter 打 build_tree（tmp_path 造真目录树），验证「照实平铺 wiki/main 根目录
真实子目录」：任意目录成组（含开放 domain 子树与五分类之外的未知目录）、递归收 .md、
跳过插件私有目录与占位文件。不注入 Fake——本 seam 专验真 Adapter 的磁盘遍历行为。
"""
import pytest

from integration.openclaw.adapters import BindMountWikiFileSystem


@pytest.fixture
def wiki_root(tmp_path):
    """造一份真实 wiki/main：concepts（含嵌套）+ domains 子树 + 未知目录 experiments + 应跳过项。"""
    main = tmp_path / 'wiki' / 'main'
    # concepts 含嵌套子目录
    (main / 'concepts' / 'sub').mkdir(parents=True)
    (main / 'concepts' / 'attention.md').write_text(
        '---\ntitle: Attention\n---\n# Attention\n', encoding='utf-8')
    (main / 'concepts' / 'sub' / 'nested.md').write_text(
        '---\ntitle: Nested\n---\n# Nested\n', encoding='utf-8')
    # domains 开放子树（kebab-case，含嵌套 papers/）
    papers = main / 'domains' / 'machine-learning' / 'papers'
    papers.mkdir(parents=True)
    (papers / 'resnet.md').write_text(
        '---\npaper:\n  title: ResNet\n---\n# ResNet\n', encoding='utf-8')
    # 五分类之外的未知目录
    (main / 'experiments').mkdir(parents=True)
    (main / 'experiments' / 'trial-1.md').write_text(
        '---\ntitle: Trial 1\n---\n# Trial 1\n', encoding='utf-8')
    # 应被跳过：插件私有目录 + 占位文件 + 非 .md
    (main / '.openclaw-wiki').mkdir(parents=True)
    (main / '.openclaw-wiki' / 'cache.md').write_text('x', encoding='utf-8')
    (main / 'index.md').write_text('# INDEX', encoding='utf-8')
    (main / 'concepts' / 'draft.txt').write_text('not md', encoding='utf-8')
    # 物理存在但全空的目录 → 不成组
    (main / 'emptydir').mkdir(parents=True)
    return main


def _kinds(tree):
    return {g['kind'] for g in tree['groups']}


def test_groups_mirror_real_subdirs(wiki_root):
    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    kinds = _kinds(tree)
    assert {'concepts', 'domains', 'experiments'} <= kinds


def test_unknown_dir_becomes_group(wiki_root):
    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    by_kind = {g['kind']: g for g in tree['groups']}
    assert by_kind['experiments']['name'] == 'experiments'
    paths = {p['path'] for p in by_kind['experiments']['pages']}
    assert paths == {'experiments/trial-1.md'}


def test_no_five_category_assumption(wiki_root):
    """五分类单数键（concept/entity/…）已废；物理不存在的目录不成组。"""
    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    kinds = _kinds(tree)
    assert 'concept' not in kinds
    assert 'entity' not in kinds
    # 物理不存在 syntheses/reports → 不成组
    assert 'syntheses' not in kinds
    assert 'reports' not in kinds


def test_empty_dir_produces_no_group(wiki_root):
    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    assert 'emptydir' not in _kinds(tree)


def test_skips_plugin_private_and_placeholder(wiki_root):
    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    all_paths = {p['path'] for g in tree['groups'] for p in g['pages']}
    assert not any('.openclaw-wiki' in p for p in all_paths)
    assert 'index.md' not in all_paths
    assert '.openclaw-wiki' not in _kinds(tree)
    # 非 .md 文件不进树
    assert not any(p.endswith('.txt') for p in all_paths)


def test_recurses_into_nested_subdirs(wiki_root):
    """任意深度的 .md 都收进其顶层目录组。"""
    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    by_kind = {g['kind']: g for g in tree['groups']}
    concepts_paths = {p['path'] for p in by_kind['concepts']['pages']}
    assert 'concepts/attention.md' in concepts_paths
    assert 'concepts/sub/nested.md' in concepts_paths


def test_domain_subtree_pages(wiki_root):
    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    by_kind = {g['kind']: g for g in tree['groups']}
    domain_paths = {p['path'] for p in by_kind['domains']['pages']}
    assert 'domains/machine-learning/papers/resnet.md' in domain_paths
    # domain 页标题仍走 frontmatter paper.title
    resnet = next(p for p in by_kind['domains']['pages'] if p['path'].endswith('resnet.md'))
    assert resnet['title'] == 'ResNet'


def test_symlink_dirs_not_followed(wiki_root, tmp_path):
    """指向 wiki/main 外的 symlink 目录不进入树（防经树泄露/遍历外部文件）。"""
    import os

    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.md').write_text('# SECRET\n', encoding='utf-8')
    # 顶层 symlink 目录 → 外部
    os.symlink(outside, wiki_root / 'evil-link')
    # 合法组内的 symlink 子目录 → 外部
    os.symlink(outside, wiki_root / 'concepts' / 'evil-sub')

    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    kinds = {g['kind'] for g in tree['groups']}
    all_paths = {p['path'] for g in tree['groups'] for p in g['pages']}
    assert 'evil-link' not in kinds
    assert not any('evil-sub' in p or 'secret.md' in p for p in all_paths)


def test_symlink_files_not_listed(wiki_root, tmp_path):
    """指向 wiki/main 外的 symlink .md 文件也不进树（防经树泄露外部文件路径）。"""
    import os

    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.md').write_text('# SECRET\n', encoding='utf-8')
    # 合法组内的 symlink .md 文件 → 外部
    os.symlink(outside / 'secret.md', wiki_root / 'concepts' / 'evil.md')

    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    all_paths = {p['path'] for g in tree['groups'] for p in g['pages']}
    assert 'concepts/evil.md' not in all_paths
