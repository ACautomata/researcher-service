"""wiki API 测试共享 fixture：注入 tmp 文件系统 wiki root + fake compile 触发器。

wiki 不落库（spec §6：直读/直写文件系统）；测试用 tmp_path 造一份
`home/wiki/main` 骨架（五核心分类 + domains 子树），Instance.home_dir 指向它。
CompileTrigger 经 locator override 注入 fake，断言「触发且去抖」，不碰真 docker。
"""
import pytest

from containers.models import Instance
from wiki.compile import CompileFleet


@pytest.fixture
def wiki_home(tmp_path):
    """造一个容器 home：wiki/main 下含五核心分类 + domains 子树样例页。"""
    home = tmp_path / 'home'
    main = home / 'wiki' / 'main'
    # 五核心分类
    (main / 'concepts').mkdir(parents=True)
    (main / 'concepts' / 'attention.md').write_text(
        '---\ntitle: Attention\n---\n# Attention\n见 [[self-attention]]。\n',
        encoding='utf-8',
    )
    (main / 'entities').mkdir(parents=True)
    (main / 'sources').mkdir(parents=True)
    (main / 'syntheses').mkdir(parents=True)
    (main / 'reports').mkdir(parents=True)
    # domains 子树
    papers = main / 'domains' / 'cv' / 'papers'
    papers.mkdir(parents=True)
    (papers / 'resnet.md').write_text(
        '---\npaper:\n  title: ResNet\nrelated_pages: [attention]\n---\n# ResNet\n',
        encoding='utf-8',
    )
    # 应被跳过的插件私有目录 / 占位文件
    (main / '.openclaw-wiki').mkdir(parents=True)
    (main / '.openclaw-wiki' / 'cache.md').write_text('x', encoding='utf-8')
    (main / 'index.md').write_text('# INDEX', encoding='utf-8')
    return home


@pytest.fixture
def instance(db, wiki_home):
    return Instance.objects.create(
        name='demo', port=19000, token='gw-tok',
        home_dir=str(wiki_home), container_id='cid',
        status=Instance.STATUS_RUNNING, image='img:tag',
    )


@pytest.fixture
def fake_compile():
    """注入 fake compile 触发器；返回记录调用的实例名列表。"""
    calls = []
    CompileFleet.override(lambda inst: calls.append(inst.name))
    yield calls
    CompileFleet.reset()
