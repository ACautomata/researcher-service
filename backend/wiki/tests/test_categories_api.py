"""seam: wiki categories 聚合 REST API —— issue #84（父 spec #75）。

端点：GET /api/v1/containers/<name>/wiki/categories。
按 `` `category:` `` 机读标记（H1 之下、首个 `##` 之前窗口内整行匹配，大小写不敏感，命中即停）
把带标记页分组成 `{ "<category>": [ {path,title,category,excerpt}, … ], … }`。
只收带标记页；无标记页与插件私有目录/占位文件（SKIP_DIRS/SKIP_FILES）不进响应。
category 为开放词表：扫到什么返回什么，不预设值集合。
wiki 直读宿主 instances/<name>/home/wiki/main（spec §6），不经容器 gateway。
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

User = get_user_model()
pytestmark = pytest.mark.django_db

URL = '/api/v1/containers/demo/wiki/categories'


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def authed(api):
    user = User.objects.create_user(username='alice', password='strong-pass-1')
    api.force_authenticate(user=user)
    return api


@pytest.fixture
def cat_home(wiki_home):
    """在共享 wiki_home 骨架上追加带/不带 category 标记的样本页。"""
    main = wiki_home / 'wiki' / 'main'
    # 带标记页：idea（thoughts 顶层目录）
    (main / 'thoughts').mkdir()
    (main / 'thoughts' / 'idea-1.md').write_text(
        '---\ntitle: First Idea\n---\n# First Idea\n\n`category: idea`\n\n'
        'Idea 第一段摘录。\n\n## Detail\n\n`category: 误抓`（H2 之后，窗口外）。\n',
        encoding='utf-8',
    )
    # 带标记页：大写 Category → critic（与 idea 同目录，验证跨目录分组）
    (main / 'thoughts' / 'crit-1.md').write_text(
        '# Crit One\n\n`Category: critic`\n\nCritic 摘录。\n',
        encoding='utf-8',
    )
    # 带标记页：未知开放词表值 deep-think.v2（domains 子树下）
    (main / 'domains' / 'cv' / 'papers' / 'odd-1.md').write_text(
        '---\ntitle: Odd\n---\n# Odd\n\n`category: deep-think.v2`\n\nOdd 摘录。\n',
        encoding='utf-8',
    )
    # 反例 1：正文段落里出现 `category:` 字样（行内混排，非整行）→ 不抓
    (main / 'concepts' / 'inline-mention.md').write_text(
        '# Mention\n\n正文里说 `category: fake` 是混在行内的。\n',
        encoding='utf-8',
    )
    # 反例 2：标记出现在 H1 之前 → 不抓
    (main / 'concepts' / 'before-h1.md').write_text(
        '`category: fake`\n\n# Late Title\n\n正文。\n',
        encoding='utf-8',
    )
    # 反例 3：标记只在首个 ## 之后才出现 → 不抓
    (main / 'concepts' / 'after-h2.md').write_text(
        '# Sec Title\n\n## section\n\n`category: fake`\n',
        encoding='utf-8',
    )
    # 反例 4：插件私有目录里带标记的页 → 不出现
    (main / '.openclaw-wiki' / 'marked.md').write_text(
        '# Hidden\n\n`category: hidden`\n',
        encoding='utf-8',
    )
    return wiki_home


# ---------------------------- 认证拦截（spec §3）----------------------------


def test_categories_requires_auth(api, instance):
    assert api.get(URL).status_code == 401


# ---------------------------- 分组与收集 ----------------------------


def test_categories_groups_by_tag(authed, cat_home, instance):
    """按 category 标记值分组；开放词表（未知值也成组）；同值跨目录归一组。"""
    resp = authed.get(URL)
    assert resp.status_code == 200
    data = resp.json()
    assert set(data) == {'idea', 'critic', 'deep-think.v2'}
    # idea 组收 idea-1.md；critic 组收 crit-1.md（大小写标记归到小写 critic 值）
    assert [p['path'] for p in data['idea']] == ['thoughts/idea-1.md']
    assert [p['path'] for p in data['critic']] == ['thoughts/crit-1.md']
    # 未知开放词表值 deep-think.v2 也成组
    assert [p['path'] for p in data['deep-think.v2']] == ['domains/cv/papers/odd-1.md']


def test_categories_item_fields(authed, cat_home, instance):
    """每条目含 path/title/category/excerpt；title 沿用 frontmatter/H1 解析。"""
    resp = authed.get(URL)
    idea = resp.json()['idea'][0]
    assert idea['path'] == 'thoughts/idea-1.md'
    assert idea['title'] == 'First Idea'  # frontmatter title
    assert idea['category'] == 'idea'
    assert '摘录' in idea['excerpt']  # 正文开头片段

    critic = resp.json()['critic'][0]
    assert critic['title'] == 'Crit One'  # 无 frontmatter → 取 H1
    assert critic['category'] == 'critic'


def test_categories_excludes_unmarked_pages(authed, cat_home, instance):
    """无标记页（含共享骨架里的 concepts/attention、experiments/trial-1）不进响应。"""
    resp = authed.get(URL)
    paths = {p['path'] for items in resp.json().values() for p in items}
    assert 'concepts/attention.md' not in paths
    assert 'experiments/trial-1.md' not in paths
    assert 'domains/cv/papers/resnet.md' not in paths
    # 带标记的页在
    assert 'thoughts/idea-1.md' in paths


def test_categories_excludes_plugin_private_marked(authed, cat_home, instance):
    """插件私有目录里即便带标记也不出现（SKIP_DIRS 防护）。"""
    resp = authed.get(URL)
    assert 'hidden' not in resp.json()
    paths = {p['path'] for items in resp.json().values() for p in items}
    assert not any('.openclaw-wiki' in p for p in paths)


# ---------------------------- 窗口 / 误抓排除 ----------------------------


def test_categories_excludes_inline_mention(authed, cat_home, instance):
    """正文段落里行内混排的 `category:` 字样不抓（须整行匹配）。"""
    resp = authed.get(URL)
    assert 'fake' not in resp.json()
    paths = {p['path'] for items in resp.json().values() for p in items}
    assert 'concepts/inline-mention.md' not in paths


def test_categories_excludes_tag_before_h1(authed, cat_home, instance):
    """标记出现在 H1 之前 → 不在窗口内 → 不抓。"""
    resp = authed.get(URL)
    paths = {p['path'] for items in resp.json().values() for p in items}
    assert 'concepts/before-h1.md' not in paths


def test_categories_excludes_tag_after_first_h2(authed, cat_home, instance):
    """标记只在首个 ## 之后才出现 → 不在窗口内 → 不抓。"""
    resp = authed.get(URL)
    paths = {p['path'] for items in resp.json().values() for p in items}
    assert 'concepts/after-h2.md' not in paths
    # idea-1.md 里 `category: 误抓` 在 H2 之后，不该被抓成误抓组
    assert '误抓' not in resp.json()


# ---------------------------- 异常路径（对齐既有 API 断言）----------------------------


def test_categories_unknown_instance_404(authed, db):
    assert authed.get('/api/v1/containers/nope/wiki/categories').status_code == 404


def test_categories_invalid_name_400(authed, db):
    # 大写/下划线能匹配 <str:name> 路由但通不过 NAME_VALIDATOR → 400
    assert authed.get('/api/v1/containers/Bad_Name/wiki/categories').status_code == 400
