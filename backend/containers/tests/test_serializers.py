"""seam: containers Serializer 零信任校验 —— issue #39。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §4（写操作必经 is_valid，禁裸读 request.data；
name 防路径穿越 + docker 容器名注入）/§10（name 唯一）。

注：DRF is_valid() 会跑 UniqueValidator（查 DB），故全部标 @django_db。
"""
import pytest

from containers.models import Instance
from containers.serializers import InstanceCreateSerializer


@pytest.mark.django_db
def test_valid_lowercase_name_passes():
    assert InstanceCreateSerializer(data={'name': 'demo'}).is_valid()


@pytest.mark.django_db
def test_valid_with_digits_and_dash_passes():
    assert InstanceCreateSerializer(data={'name': 'demo-1'}).is_valid()


@pytest.mark.django_db
def test_uppercase_rejected():
    # docker 名 / DNS-label 风格：仅小写
    assert not InstanceCreateSerializer(data={'name': 'Demo'}).is_valid()


@pytest.mark.django_db
def test_digit_start_rejected():
    assert not InstanceCreateSerializer(data={'name': '1demo'}).is_valid()


@pytest.mark.django_db
def test_path_traversal_chars_rejected():
    # 安全关键：name 直接进 instances/<name>/ 路径与 docker 容器名，禁 / .. 等
    for bad in ['a/b', 'a..b', 'a b', 'a.b', 'a*b', 'abs;rm']:
        assert not InstanceCreateSerializer(data={'name': bad}).is_valid(), bad


@pytest.mark.django_db
def test_too_short_rejected():
    # 3–30 字符（首字母后至少 2 位）
    assert not InstanceCreateSerializer(data={'name': 'ab'}).is_valid()


@pytest.mark.django_db
def test_too_long_rejected():
    assert not InstanceCreateSerializer(data={'name': 'a' + 'b' * 30}).is_valid()


@pytest.mark.django_db
def test_duplicate_name_rejected():
    # spec §10 name 唯一：UniqueValidator 转 400，非 DB 500
    Instance.objects.create(
        name='demo', port=19000, token='t', home_dir='/h', image='i',
    )
    assert not InstanceCreateSerializer(data={'name': 'demo'}).is_valid()
