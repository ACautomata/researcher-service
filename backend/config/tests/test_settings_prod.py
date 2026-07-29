"""seam: prod.py validate_prod_env fail-fast 契约 —— 强制生产配置缺失即拒启动。

代码层防护：必须在启动时校验所有生产必填 env 缺失即 raise ImproperlyConfigured，
防止生产/Docker 部署因静默使用错误的默认（开发兜底 vs 生产应注入）而潜伏故障。

各校验对应 validate_prod_env 一行 if-not-env: raise；新增校验项须在此加对应测试。
"""
from __future__ import annotations

from django.core.exceptions import ImproperlyConfigured

from config.settings._validation import validate_prod_env


def _minimal_env(**overrides):
    """validate_prod_env 期望的最小 env 集合（除被测项外给齐）。"""
    base = {
        'DJANGO_ALLOWED_HOSTS': 'example.test',
        'OPENCLAW_TEMPLATE_DIR': '/srv/openclaw/template/researcher',
    }
    base.update(overrides)
    return base


def test_validate_prod_env_ok_when_template_dir_set():
    """OPENCLAW_TEMPLATE_DIR 显式提供 → 正常通过。"""
    validate_prod_env(_minimal_env())  # 不抛即通过


def test_validate_prod_env_fail_fast_when_template_dir_missing():
    """OPENCLAW_TEMPLATE_DIR 缺失 → ImproperlyConfigured。

    codex P1 :287325b 警示：base.py 默认值改 <repo>/researcher 后，未设 env 的生产部署
    会静默用镜像内不存在的开发路径，HomeProvisioner.copytree FileNotFoundError →
    容器创建卡 creating（issue #195 修过的同类错配）。fail-fast 让运维启动时就发现，
    而非生产首次创建容器时才暴露。
    """
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_DIR=''))
    msg = str(ei.value)
    assert 'OPENCLAW_TEMPLATE_DIR' in msg
    # 错误消息含「生产」「必填」语义（运维一眼看懂）
    assert '生产' in msg and ('必填' in msg or '必设' in msg or '必须' in msg)


def test_validate_prod_env_fail_fast_message_guides_to_docs():
    """错误消息指向 deploy/README.md / .env.example，运维能立即知道在哪改。"""
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_DIR=''))
    msg = str(ei.value)
    assert 'deploy/README.md' in msg or 'deploy/.env.example' in msg, (
        f'错误消息应指向部署文档，当前: {msg!r}'
    )


def test_validate_prod_env_fail_fast_when_allowed_hosts_missing():
    """DJANGO_ALLOWED_HOSTS 缺失/空 → 既存 fail-fast 不退。"""
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(DJANGO_ALLOWED_HOSTS=''))
    assert 'DJANGO_ALLOWED_HOSTS' in str(ei.value)


def test_validate_prod_env_fail_fast_when_allowed_hosts_whitespace_only():
    """DJANGO_ALLOWED_HOSTS 仅空白 → 仍 fail-fast（防运维误设 ", , "）。"""
    with __import__('pytest').raises(ImproperlyConfigured):
        validate_prod_env(_minimal_env(DJANGO_ALLOWED_HOSTS='   '))