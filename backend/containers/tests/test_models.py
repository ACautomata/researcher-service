"""seam: Instance model 记账 —— issue #39 容器编排控制面。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §5.5（状态机：creating→running→stopped→removing）
/§10（Instance 字段：name/port/token/volume/container_id/status/image/created_at）。
"""
import pytest
from django.db import IntegrityError

from containers.models import Instance


@pytest.mark.django_db
def test_instance_defaults_to_creating_status():
    # spec §5.5：状态机起点 creating（cp -a → 渲染 → run）
    inst = Instance.objects.create(
        name='demo',
        port=19000,
        token='t-token',
        home_dir='/fleet/instances/demo/home',
        image='acautomata/openclaw-docker-cn-im:latest',
    )
    inst.refresh_from_db()
    assert inst.status == Instance.STATUS_CREATING
    assert inst.container_id == ''  # run 前未知（空串，非 NULL —— 避免 null-string 反模式）
    assert inst.created_at is not None


@pytest.mark.django_db
def test_name_is_unique():
    # spec §5.3/§10：容器名作主键语义，重复应 DB 级拒绝（非 API 500）
    Instance.objects.create(
        name='demo', port=19000, token='t1', home_dir='/h', image='img'
    )
    with pytest.raises(IntegrityError):
        Instance.objects.create(
            name='demo', port=19001, token='t2', home_dir='/h2', image='img'
        )
