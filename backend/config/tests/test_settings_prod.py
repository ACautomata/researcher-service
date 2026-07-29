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


def test_validate_prod_env_fail_fast_when_allowed_hosts_comma_only():
    """codex P2 :2902641 review：DJANGO_ALLOWED_HOSTS=', ,' 仅原 strip() 通过（因为 "," 仍
    是 content），让 prod.py 解析后空 ALLOWED_HOSTS → 启动成功但 DisallowedHost 拒请求。
    现 split+filter 判空（与 prod.py 语义一致），纯逗号或纯空白也拒。
    """
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(DJANGO_ALLOWED_HOSTS=','))
    assert 'DJANGO_ALLOWED_HOSTS' in str(ei.value)


def test_validate_prod_env_fail_fast_when_allowed_hosts_comma_with_spaces():
    """codex P2 :2902641 review 边界：', , '/', , ' 形式（split 后元素仍非空）→ 同样拒。"""
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(DJANGO_ALLOWED_HOSTS=', , '))
    assert 'DJANGO_ALLOWED_HOSTS' in str(ei.value)


def test_validate_prod_env_fail_fast_when_template_dir_relative():
    """codex P2 :2902641 review：OPENCLAW_TEMPLATE_DIR=researcher 相对路径被 validator
    通过会让 prod 启动看似正常，但 HomeProvisioner 用 cwd 解析后 FileNotFoundError，
    重复 issue #195「卡 creating」错配。Path.is_absolute() 必须拒相对路径。
    """
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_DIR='researcher'))
    msg = str(ei.value)
    assert 'OPENCLAW_TEMPLATE_DIR' in msg
    # 错误消息明确告诉运维「必须是绝对路径」并显式当前值
    assert '绝对路径' in msg
    assert "'researcher'" in msg


def test_validate_prod_env_fail_fast_when_template_dir_dot_relative():
    """codex P2 :2902641 review 边界：'./researcher' / '../researcher' 等显式相对路径同样拒。"""
    with __import__('pytest').raises(ImproperlyConfigured):
        validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_DIR='./researcher'))


def test_validate_prod_env_ok_when_template_dir_absolute():
    """P2#3 反面：OPENCLAW_TEMPLATE_DIR 是合法绝对路径 → 正常通过。"""
    validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_DIR='/srv/openclaw/template/researcher'))
