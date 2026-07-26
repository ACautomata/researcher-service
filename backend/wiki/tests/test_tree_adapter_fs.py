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


def test_non_regular_md_not_listed(wiki_root):
    """FIFO/socket/device 命名 .md 不进树——_page_title 会 read_text() 阻塞 worker（codex #125 P1）。"""
    import os

    os.mkfifo(wiki_root / 'concepts' / 'evil.md')

    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    all_paths = {p['path'] for g in tree['groups'] for p in g['pages']}
    assert 'concepts/evil.md' not in all_paths


def test_missing_wiki_root_returns_empty_tree(tmp_path):
    """wiki/main 不存在（模板未初始化/被删）时返回空树，不上抛（codex #125 P2）。"""
    missing = tmp_path / 'wiki' / 'main'
    tree = BindMountWikiFileSystem(str(missing)).build_tree()
    assert tree == {'groups': []}


def test_symlinked_wiki_root_returns_empty_tree(tmp_path):
    """wiki/main 自身被换成指向外部的 symlink 时返回空树,不扫外部目录(codex #125 P1)。"""
    import os

    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.md').write_text('# SECRET\n', encoding='utf-8')
    (outside / 'sub').mkdir()
    (outside / 'sub' / 'leak.md').write_text('# LEAK\n', encoding='utf-8')
    root_link = tmp_path / 'wiki' / 'main'
    root_link.parent.mkdir(parents=True)
    os.symlink(outside, root_link)

    tree = BindMountWikiFileSystem(str(root_link)).build_tree()
    assert tree == {'groups': []}


def test_symlinked_wiki_ancestor_returns_empty_tree(tmp_path):
    """<home>/wiki 被换成指向其它 instance 的 symlink 时返回空树,不跨实例泄露(codex #125 P1)。

    root 自身不是 symlink,但直接父 <home>/wiki 是。原实现仅检查 root.is_symlink() 失效。
    """
    import os

    other = tmp_path / 'other-instance' / 'wiki'
    (other / 'main' / 'concepts').mkdir(parents=True)
    (other / 'main' / 'concepts' / 'secret.md').write_text('# SECRET\n', encoding='utf-8')
    home = tmp_path / 'my-home'
    home.mkdir()
    os.symlink(other, home / 'wiki')

    tree = BindMountWikiFileSystem(str(home / 'wiki' / 'main')).build_tree()
    assert tree == {'groups': []}


def test_pages_sorted_by_path(wiki_root):
    """同一组内多子目录的页面按 path 字典序输出,前端不再排序(codex #125 P2)。"""
    (wiki_root / 'concepts' / 'aa').mkdir()
    (wiki_root / 'concepts' / 'bb').mkdir()
    (wiki_root / 'concepts' / 'aa' / 'page1.md').write_text('# A1\n', encoding='utf-8')
    (wiki_root / 'concepts' / 'bb' / 'page2.md').write_text('# B1\n', encoding='utf-8')

    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    by_kind = {g['kind']: g for g in tree['groups']}
    paths = [p['path'] for p in by_kind['concepts']['pages']]
    assert paths == sorted(paths)


def test_non_utf8_md_falls_back_to_filename(wiki_root):
    """非 UTF-8 字节的 .md 退到文件名 fallback,不让整棵树 500(codex #125 P2)。"""
    (wiki_root / 'concepts' / 'bad.md').write_bytes(b'\xff\xfe\xfa invalid utf8')

    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    by_kind = {g['kind']: g for g in tree['groups']}
    paths = {p['path']: p['title'] for p in by_kind['concepts']['pages']}
    assert 'concepts/bad.md' in paths
    assert paths['concepts/bad.md'] == 'bad'


def test_deeply_nested_dirs_no_recursion_error(wiki_root):
    """任意深度嵌套不触发 RecursionError——_scan_dir 已改显式栈迭代(codex #125 P2)。"""
    cur = wiki_root / 'concepts'
    # 深度仅受文件系统路径上限约束;mac 上 ~475 层,Linux 上 ~2000 层,均远低于旧递归
    # 在 Python 默认 recursionlimit=1000 下的爆栈阈值。这里造 200 层即可暴露递归实现的
    # RecursionError(降 limit 后),迭代实现则放宽到任意深度。
    depth = 0
    for _ in range(200):
        cur = cur / 'a'
        try:
            cur.mkdir()
            depth += 1
        except OSError:
            break
    if depth < 50:
        pytest.skip(f'filesystem path limit too shallow: {depth}')
    (cur / 'leaf.md').write_text('# LEAF\n', encoding='utf-8')

    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    all_paths = {p['path'] for g in tree['groups'] for p in g['pages']}
    assert any(p.endswith('leaf.md') for p in all_paths)


def test_unreadable_subdir_skipped(wiki_root, monkeypatch):
    """子目录 iterdir 抛 PermissionError 时跳过该子树,其它分支不受影响(codex #125 P2)。

    用 monkeypatch 模拟 iterdir 抛错而非真 chmod——CI 容器以 root 跑时 chmod(0) 不阻止
    root 枚举目录,真 chmod 会让本测试假失败(codex #125 P2)。
    """
    from pathlib import Path

    locked = wiki_root / 'locked'
    locked.mkdir()
    (locked / 'x.md').write_text('# X\n', encoding='utf-8')

    real_iterdir = Path.iterdir

    def fake_iterdir(self):
        if self == locked:
            raise PermissionError(str(locked))
        return real_iterdir(self)

    monkeypatch.setattr(Path, 'iterdir', fake_iterdir)

    tree = BindMountWikiFileSystem(str(wiki_root)).build_tree()
    all_paths = {p['path'] for g in tree['groups'] for p in g['pages']}
    assert 'concepts/attention.md' in all_paths
    assert not any('locked' in p for p in all_paths)


def test_unreadable_wiki_root_returns_empty_tree(tmp_path, monkeypatch):
    """wiki/main 自身 iterdir 抛 PermissionError 时返回空树,不上抛(codex #125 P2)。

    同 test_unreadable_subdir_skipped,用 monkeypatch 替代真 chmod 以保证 root 用户
    下也可重现。
    """
    from pathlib import Path

    main = tmp_path / 'wiki' / 'main'
    main.mkdir(parents=True)
    (main / 'a.md').write_text('# A\n', encoding='utf-8')

    real_iterdir = Path.iterdir

    def fake_iterdir(self):
        if self == main:
            raise PermissionError(str(main))
        return real_iterdir(self)

    monkeypatch.setattr(Path, 'iterdir', fake_iterdir)

    tree = BindMountWikiFileSystem(str(main)).build_tree()
    assert tree == {'groups': []}
