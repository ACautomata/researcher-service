"""seam: InstanceOrchestrator.rewrite_config —— model CRUD 后重渲染 openclaw.json（spec §7）。

DB（ModelProvider）改后重渲染该容器 instances/<name>/openclaw.json，经 OpenClaw watch 热加载
生效（#36 已证：无需 restart）。复用 containers conftest 的 fleet fixture（FakeRuntime + tmp root）。
"""
import json

import pytest

from containers.orchestrator import InstanceNotFound
from models.models import API_ANTHROPIC, API_OPENAI, ModelProvider


def _make_provider(inst, pid='my-openai', api=API_OPENAI, **kw):
    return ModelProvider.objects.create(
        instance=inst, provider_id=pid, api=api,
        base_url=kw.get('base_url', 'https://x/v1'),
        api_key_env_id=kw.get('env', 'ZHIPU_API_KEY'),
        auth_header=True,
        models_json=kw.get('models', [{'id': 'g', 'name': 'G'}]),
    )


def _config(fleet, name):
    return json.loads(
        (fleet['config'].root / 'instances' / name / 'openclaw.json').read_text(),
    )


@pytest.mark.django_db
def test_rewrite_no_providers_preserves_base_invariants(fleet):
    # 无托管 provider → base 透传，gateway 安全不变量仍强制（spec §5.2）
    fleet['orch'].create('demo')
    fleet['orch'].rewrite_config('demo')
    cfg = _config(fleet, 'demo')
    assert cfg['gateway']['port'] == 18789
    assert cfg['gateway']['bind'] == 'lan'
    assert cfg['gateway']['auth']['token'] == '${GATEWAY_TOKEN}'


@pytest.mark.django_db
def test_rewrite_writes_provider_into_config_file(fleet):
    inst = fleet['orch'].create('demo')
    _make_provider(
        inst, pid='my-openai', api=API_OPENAI, env='ZHIPU_API_KEY',
        base_url='https://open.bigmodel.cn/api/paas/v4',
        models=[{'id': 'glm-4-plus', 'name': 'GLM-4 Plus'}],
    )
    fleet['orch'].rewrite_config('demo')
    cfg = _config(fleet, 'demo')
    prov = cfg['models']['providers']['my-openai']
    assert prov['api'] == 'openai-completions'                       # r28 修正点
    assert prov['baseUrl'] == 'https://open.bigmodel.cn/api/paas/v4'
    assert prov['apiKey'] == {'source': 'env', 'provider': 'default', 'id': 'ZHIPU_API_KEY'}
    assert cfg['agents']['defaults']['model']['primary'] == 'my-openai/glm-4-plus'


@pytest.mark.django_db
def test_rewrite_after_delete_has_no_dangling_refs(fleet):
    inst = fleet['orch'].create('demo')
    a = _make_provider(inst, pid='pa', api=API_ANTHROPIC, env='AA_KEY',
                       models=[{'id': 'a1', 'name': 'A1'}])
    _make_provider(inst, pid='pb', api=API_OPENAI, env='BB_KEY',
                   models=[{'id': 'b1', 'name': 'B1'}])
    fleet['orch'].rewrite_config('demo')
    a.delete()                                                        # 删 primary
    fleet['orch'].rewrite_config('demo')
    cfg = _config(fleet, 'demo')
    assert 'pa' not in cfg['models']['providers']
    # primary/fallbacks/aliases 全部不含已删 provider（spec 验收：无悬空引用）
    model = cfg['agents']['defaults']['model']
    assert model['primary'] == 'pb/b1'
    assert 'pa/' not in json.dumps(cfg['agents']['defaults'])


@pytest.mark.django_db
def test_rewrite_creates_config_dir_if_missing(fleet):
    # 容器行存在但 openclaw.json 尚未落盘（如直建 Instance 行）时，rewrite 仍可写
    from containers.models import Instance
    inst = Instance.objects.create(
        name='solo', port=19001, token='t', home_dir=str(fleet['config'].root / 'instances' / 'solo' / 'home'),
        container_id='', status=Instance.STATUS_RUNNING, image='img:tag',
    )
    _make_provider(inst, pid='p', models=[{'id': 'm', 'name': 'M'}])
    fleet['orch'].rewrite_config('solo')
    cfg = _config(fleet, 'solo')
    assert 'p' in cfg['models']['providers']


@pytest.mark.django_db
def test_rewrite_missing_instance_raises(fleet):
    with pytest.raises(InstanceNotFound):
        fleet['orch'].rewrite_config('nope')


# ── #280：create config 写盘原子性（ConfigStore 单源，打在 facade seam）──


@pytest.mark.django_db
def test_create_writes_config_atomically_no_tmp_leftover(fleet):
    # #280：create 的 config 写盘经 ConfigStore（tmp + os.replace）原子落盘——
    # 正常路径不得残留任何 .tmp 文件（torn/partial 风险已消；tmp 名每次唯一）。
    fleet['orch'].create('demo')
    cfg_file = fleet['config'].root / 'instances' / 'demo' / 'openclaw.json'
    assert cfg_file.exists()
    assert cfg_file.read_text().strip()                      # 非空
    assert not list(cfg_file.parent.glob('openclaw.json.*.tmp'))


@pytest.mark.django_db
def test_create_config_write_failure_preserves_existing_and_cleans_tmp(fleet, monkeypatch):
    """#280：create 写盘失败（注入 OSError）→ 既有 openclaw.json 不被污染、tmp 被清理、
    转 ConfigWriteError。打在 facade seam（orch.create 触发、观察磁盘副作用）。"""
    from pathlib import Path

    from containers.fleet.values import ConfigWriteError
    from containers.models import Instance

    orch = fleet['orch']
    orch.create('demo')                                      # 首次成功落盘
    cfg_file = fleet['config'].root / 'instances' / 'demo' / 'openclaw.json'
    original = cfg_file.read_text()
    assert original.strip()

    # 打点 ConfigStore 的 os.replace（Path.replace 绑定方法）为抛 OSError，模拟卷只读/权限
    # 失败——替换发生在 tmp 写入 + chmod 之后，故 tmp 应被清理、目标文件不受污染。
    def fail_replace(self, target):
        raise OSError('simulated disk failure')

    monkeypatch.setattr(Path, 'replace', fail_replace)

    with pytest.raises(ConfigWriteError):
        orch.create('demo2')

    # 既有 openclaw.json 不受污染；tmp 已清理；demo2 的目录因回滚被删除
    assert cfg_file.read_text() == original
    assert not list(cfg_file.parent.glob('openclaw.json.*.tmp'))
    assert not (fleet['config'].root / 'instances' / 'demo2').exists()
    assert not Instance.objects.filter(name='demo2').exists()


@pytest.mark.django_db
def test_config_store_uses_unique_tmp_per_write(fleet, monkeypatch):
    """#280 codex review P2：create 与 rewrite_config 收敛到同一原子写 seam 后，固定 tmp
    名 ``openclaw.json.tmp`` 会让并发写者（create 与 model CRUD 的 rewrite_config 竞争同一
    实例）共享/互相覆盖 tmp——一个写者可能在另一写者的 write_text 与 replace 之间 replace，
    装错 payload 或误报 ConfigWriteError 回滚合法操作。每个 write 调用须用唯一 tmp 文件
    （os.replace 仍原子、最后者胜）。

    该断言须直接观察 ConfigStore 的 tmp 生成（唯一能看 tmp 名的层）——原子性主回归仍打
    facade seam（上方 test_create_config_write_failure_*）。
    """
    from pathlib import Path

    orch = fleet['orch']
    store = orch._cmd._config_store
    real_replace = Path.replace
    seen_tmp = []

    def spy_replace(self, target):
        seen_tmp.append(self.name)
        return real_replace(self, target)

    monkeypatch.setattr(Path, 'replace', spy_replace)

    store.write('demo', '{"a": 1}')
    store.write('demo', '{"b": 2}')

    assert len(seen_tmp) == 2, '两次 write 都应完成 replace'
    assert len(set(seen_tmp)) == 2, '两次 write 不得复用同一 tmp 文件（并发写者共享 tmp 名）'
