"""seam: containers REST API —— issue #39 容器管理控制面。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §3（全局 IsAuthenticated 拦截）/§4（零信任，经 Serializer）/
§9.3（容器管理页后端契约：列表 status/health/port + 新建 + 删除）。

端点：GET/POST /api/v1/containers/、DELETE /api/v1/containers/<name>。
fleet fixture（conftest）注入 FakeRuntime，故不碰真 daemon。
"""
import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from containers.models import Instance
from containers.orchestrator import (
    InstanceBusy,
    InstanceCleanupError,
    InstanceDirExists,
    InstanceExists,
    PortAllocationError,
)
from containers.ports import PortPoolExhausted

User = get_user_model()


@pytest.fixture
def api():
    return APIClient()


@pytest.fixture
def authed(api):
    # force_authenticate 跳过 JWT 编码细节；401 拦截由无 token 用例单独覆盖
    user = User.objects.create_user(username='alice', password='strong-pass-1')
    api.force_authenticate(user=user)
    return api


# ---------------------------- 认证拦截（spec §3）----------------------------


@pytest.mark.django_db
def test_list_requires_auth(api):
    assert api.get('/api/v1/containers/').status_code == 401


@pytest.mark.django_db
def test_create_requires_auth(api):
    assert api.post('/api/v1/containers/', {'name': 'demo'}, format='json').status_code == 401


@pytest.mark.django_db
def test_delete_requires_auth(api):
    assert api.delete('/api/v1/containers/demo').status_code == 401


# ---------------------------- 创建（spec §9.3 新建）----------------------------


@pytest.mark.django_db
def test_create_returns_202_with_creating(authed, fleet):
    """#297：POST 同步预占 creating 行 → 返 202 + creating 态快照（先于 submit 构造）。

    conftest 注入 inline executor 使后台 provisioning 同步跑完，落盘断言保留；但 202 body
    必须是创建态快照（view 先 created_item 再 submit），非 provisioning 完成后的 running。
    """
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 202
    data = resp.json()
    assert data['name'] == 'demo'
    assert data['port'] == 19000  # 端口池最小空闲
    assert data['status'] == 'creating'
    assert data['health'] == 'pending'
    assert data['image'] == 'img:tag'
    # 落盘验收（issue #39：宿主 instances/<name>/ 落盘）
    assert (fleet['config'].root / 'instances' / 'demo' / 'home' / 'workspace' / 'note.md').exists()
    assert (fleet['config'].root / 'instances' / 'demo' / 'openclaw.json').exists()


@pytest.mark.django_db
def test_create_rejects_invalid_name(authed):
    # spec §4 零信任：非法 name → 400 非 500
    resp = authed.post('/api/v1/containers/', {'name': 'Bad/Name'}, format='json')
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_rejects_missing_name(authed):
    resp = authed.post('/api/v1/containers/', {}, format='json')
    assert resp.status_code == 400


@pytest.mark.django_db
def test_create_rejects_duplicate(authed, fleet):
    # 重复 name → 400（UniqueValidator），非 409/500
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 400


# ---------------------------- 列表（spec §9.3 status/health/port）----------------------------


@pytest.mark.django_db
def test_list_empty(authed):
    assert authed.get('/api/v1/containers/').json() == []


@pytest.mark.django_db
def test_list_shows_created_instance(authed, fleet):
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    items = authed.get('/api/v1/containers/').json()
    assert len(items) == 1
    assert items[0]['name'] == 'demo'
    # Codex P2：列表应批量携带配对状态，前端不再 per-row 轮询
    assert 'pairing' in items[0]
    assert items[0]['pairing']['status'] == 'unpaired'


@pytest.mark.django_db
def test_list_health_turns_healthy_when_reachable(authed, fleet):
    # issue #39 验收：列表 health 随外部 /health 探测变 healthy
    port = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json').json()['port']
    # 默认 running 但 gateway 未探通 → unhealthy
    assert authed.get('/api/v1/containers/').json()[0]['health'] == 'unhealthy'
    fleet['health'].set_reachable(port, True)
    assert authed.get('/api/v1/containers/').json()[0]['health'] == 'healthy'


# ---------------------------- 删除（spec §5.4 连数据删）----------------------------


@pytest.mark.django_db
def test_delete_removes_instance_and_dir(authed, fleet):
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    resp = authed.delete('/api/v1/containers/demo')
    assert resp.status_code == 204
    # issue #39 验收：instances/<name>/ 一并清除
    assert not (fleet['config'].root / 'instances' / 'demo').exists()
    assert authed.get('/api/v1/containers/').json() == []


@pytest.mark.django_db
def test_delete_evicts_pooled_chat_client(authed, fleet):
    """codex #221 第五轮 P2：删除容器须逐出该网关的 pool client + 取消其重连 task。

    否则被删容器的 url/token 仍是 pool 当前 target，#215 主动重连循环 stop 永不命中，
    每 30s 无限向已删端口（可能被后续容器复用）重连陈旧凭证。
    """
    from chat.pool import ChatFleet

    evicted = []

    class SpyPool:
        async def evict_instance(self, instance):
            evicted.append(instance.name)

    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    ChatFleet.override(SpyPool())
    try:
        resp = authed.delete('/api/v1/containers/demo')
        assert resp.status_code == 204
        assert evicted == ['demo'], (
            f'删除容器未逐出 ChatFleet pool client（evicted={evicted}），'
            '主动重连循环将无限重试已删端口')
    finally:
        ChatFleet.reset()


@pytest.mark.django_db
def test_delete_missing_returns_404(authed):
    assert authed.delete('/api/v1/containers/nope').status_code == 404


@pytest.mark.django_db
def test_delete_rejects_invalid_name(authed):
    # 路径参数也校验（spec §4）：防 URL path 注入
    resp = authed.delete('/api/v1/containers/Bad..Name')
    assert resp.status_code == 400


# ---------------------------- codex R1 并发/清理失败转译（:84/:126） ----------------------------


@pytest.mark.django_db
def test_create_returns_409_on_concurrent_duplicate(authed, fleet, monkeypatch):
    # codex R1 :84：orchestrator InstanceExists（并发绕 UniqueValidator）→ 409，非裸 500
    # #297：异步化后同步阶段为 create_reserve，异常映射点随之迁移。
    def _raise(name):
        raise InstanceExists(name)

    monkeypatch.setattr(fleet['orch'], 'create_reserve', _raise)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 409


@pytest.mark.django_db
def test_create_returns_409_on_residual_dir(authed, fleet, monkeypatch):
    # 残留 orphan 目录（DB 无行，崩溃中断/外部残留）→ InstanceDirExists → 409，非裸 500。
    # 场景：上次 create 在 mkdir 后崩溃/手动删 DB 行，目录残留；同名再建撞 mkdir(exist_ok=False)。
    # #297：reserve 阶段目录预检同步暴露（create_reserve），映射点随之迁移。
    def _raise(name):
        raise InstanceDirExists(name, f'/fleet/instances/{name}')

    monkeypatch.setattr(fleet['orch'], 'create_reserve', _raise)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 409
    assert '残留' in resp.json()['detail']


@pytest.mark.django_db
def test_delete_returns_409_when_cleanup_fails(authed, fleet, monkeypatch):
    # codex R1 :126：home 清理失败 → 409 + DB 行保留（可重试），非吞错 204
    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')

    def _fail(name):
        raise InstanceCleanupError(name, str(fleet['config'].root))

    monkeypatch.setattr(fleet['orch'], 'delete', _fail)
    resp = authed.delete('/api/v1/containers/demo')
    assert resp.status_code == 409


@pytest.mark.django_db
def test_delete_evicts_pool_even_when_cleanup_fails(authed, fleet, monkeypatch):
    """codex #221 R7 P2：delete 已 stop/remove 网关后 raise InstanceCleanupError（行保留可重试）时，
    也应逐出 pool client——网关已删，pool client 连的是已删容器，主动重连会打已删端口。
    当前实现仅在 204 成功分支 evict，CleanupError(409) 分支跳过 → 旧 client 无限重连已删端口。
    """
    from chat.pool import ChatFleet

    evicted = []

    class SpyPool:
        async def evict_instance(self, instance):
            evicted.append(instance.name)

    authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')

    def _fail(name):
        raise InstanceCleanupError(name, str(fleet['config'].root))  # 网关已删、home 清理失败

    monkeypatch.setattr(fleet['orch'], 'delete', _fail)
    ChatFleet.override(SpyPool())
    try:
        resp = authed.delete('/api/v1/containers/demo')
        assert resp.status_code == 409  # CleanupError → 409 行保留可重试
        assert evicted == ['demo'], (
            f'delete 网关已删但 cleanup 失败(409)时未逐出 pool client（evicted={evicted}）——'
            '主动重连将无限重试已删端口')
    finally:
        ChatFleet.reset()


# ---------------------------- codex R2 端口耗尽转译（:40） ----------------------------


@pytest.mark.django_db
def test_create_returns_503_when_port_pool_exhausted(authed, fleet, monkeypatch):
    # codex R2 :40：端口池耗尽（PortPoolExhausted）→ 503（预期容量条件），非裸 500
    # #297：异步化后同步阶段为 create_reserve，异常映射点随之迁移。
    def _raise(name):
        raise PortPoolExhausted('端口池 19000-19999 已耗尽')

    monkeypatch.setattr(fleet['orch'], 'create_reserve', _raise)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 503


@pytest.mark.django_db
def test_create_returns_503_when_port_allocation_exhausted(authed, fleet, monkeypatch):
    # codex R2 :40：持续分配冲突（PortAllocationError，重试预算用尽）→ 503，非裸 500
    # #297：异步化后同步阶段为 create_reserve，异常映射点随之迁移。
    def _raise(name):
        raise PortAllocationError(name)

    monkeypatch.setattr(fleet['orch'], 'create_reserve', _raise)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 503


@pytest.mark.django_db
def test_delete_returns_409_while_create_in_flight(authed, fleet, monkeypatch):
    # codex R3 :257：删除目标仍在 provisioning（create 在飞，InstanceBusy）→ 409，非裸 500/204
    def _busy(name):
        raise InstanceBusy(name)

    monkeypatch.setattr(fleet['orch'], 'delete', _busy)
    resp = authed.delete('/api/v1/containers/demo')
    assert resp.status_code == 409


@pytest.mark.django_db
def test_create_background_failure_marks_row_error(authed, fleet, monkeypatch):
    """#297：后台 provisioning 失败不再同步 409/503——行已标 ERROR（客户端经 list + delete 感知/重试）。

    替代原「create 回滚时目录清理失败 → 同步 409」（InstanceCleanupError 异步化后仅后台抛）。
    conftest 注入 inline executor → 后台 provisioning 在请求线程同步跑完；run 失败 +
    目录回滚失败 → 行保留标 ERROR。POST 仍返 202（提交与完成解耦）。
    """
    class _RunFails(fleet['runtime'].__class__):
        def run(self, spec):
            raise RuntimeError('daemon down')

    def _fail_rmtree(path, **kwargs):
        raise OSError('permission denied')

    orch = fleet['orch']
    # monkeypatch 替换（测试结束自动还原），不直接改 fixture 持有的 _deps 引用
    monkeypatch.setattr(orch._deps, 'runtime', _RunFails())  # pylint: disable=protected-access
    monkeypatch.setattr(orch._deps, 'dir_remover', _fail_rmtree)  # pylint: disable=protected-access

    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 202
    inst = Instance.objects.get(name='demo')
    assert inst.status == Instance.STATUS_ERROR
    assert inst.container_id == ''


@pytest.mark.django_db
def test_create_returns_202_even_if_post_create_detail_fails(authed, fleet, monkeypatch):
    # codex R4 :60 精神保留 + #297：POST 由 create_reserve 返回的 creating 行直接构造 202 快照，
    # 不二次 detail() 查 runtime——daemon 抖动不应让已提交的创建 500（客户端误判失败重试撞 409）。
    # 快照在 submit_create 前构造，即使 inline executor 后台同步跑完，响应仍透传创建态。
    def _flaky_detail(name):
        raise RuntimeError('daemon flaked during post-create lookup')

    monkeypatch.setattr(fleet['orch'], 'detail', _flaky_detail)
    resp = authed.post('/api/v1/containers/', {'name': 'demo'}, format='json')
    assert resp.status_code == 202
    assert resp.json()['name'] == 'demo'
    assert resp.json()['status'] == 'creating'
