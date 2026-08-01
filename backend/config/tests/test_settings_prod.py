"""seam: prod.py validate_prod_env fail-fast 契约 —— 强制生产配置缺失即拒启动。

代码层防护：必须在启动时校验所有生产必填 env 缺失即 raise ImproperlyConfigured，
防止生产/Docker 部署因静默使用错误的默认（开发兜底 vs 生产应注入）而潜伏故障。

各校验对应 validate_prod_env 一行 if-not-env: raise；新增校验项须在此加对应测试。
"""
from __future__ import annotations

import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

from config.settings._validation import validate_prod_env

# 校验「绝对路径 + 已存在目录」通过用：任一测试机上都已存在的绝对目录（本测试包的上两级
# = backend/config）。validate_prod_env 现要求 OPENCLAW_TEMPLATE_DIR 不仅是绝对路径，
# 还必须是已存在目录（codex P2 :292d349），故「通过用」必须给真实存在的目录。
_EXISTING_DIR = str(Path(__file__).resolve().parent.parent)
# OPENCLAW_TEMPLATE_JSON 校验要求已存在的文件（ConfigRenderer 以 JSON 解析模板）；
# 用本测试文件自身作为真实存在的文件路径。
_EXISTING_FILE = str(Path(__file__).resolve())


def _minimal_env(**overrides):
    """validate_prod_env 期望的最小 env 集合（除被测项外给齐）。"""
    base = {
        'DJANGO_ALLOWED_HOSTS': 'example.test',
        'OPENCLAW_TEMPLATE_DIR': _EXISTING_DIR,
        'OPENCLAW_TEMPLATE_JSON': _EXISTING_FILE,
        'LLM_API_KEY': 'sk-prod-test',
        'REDIS_URL': 'redis://redis:6379/0',
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
    """P2#3 反面：OPENCLAW_TEMPLATE_DIR 是合法绝对路径且已存在目录 → 正常通过。"""
    validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_DIR=_EXISTING_DIR))


def test_validate_prod_env_fail_fast_when_template_dir_nonexistent():
    """codex P2 :292d349 review：OPENCLAW_TEMPLATE_DIR 是绝对路径但不存在（如拼写错误
    /srv/openclaw/template/reseacher）被 validator 放行会让 prod 启动看似正常，首次创建
    容器时 HomeProvisioner.copytree 才抛 FileNotFoundError，违背 fail-fast「启动时即知」
    初衷（issue #195 同类错配）。启动期必须校验路径已存在且是目录。
    """
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_DIR='/srv/openclaw/template/reseacher'))
    msg = str(ei.value)
    assert 'OPENCLAW_TEMPLATE_DIR' in msg
    # 错误消息告诉运维「必须是已存在/可读目录」并显式当前错值
    assert '目录' in msg
    assert "'/srv/openclaw/template/reseacher'" in msg


def test_validate_prod_env_fail_fast_when_template_dir_is_file(tmp_path):
    """codex P2 :292d349 review 边界：OPENCLAW_TEMPLATE_DIR 指向一个普通文件（绝对、存在
    但不是目录）同样要让 copytree 失败 → 启动期即拒，而非首次创建容器才 NotADirectoryError。
    """
    file_path = tmp_path / 'not_a_dir'
    file_path.write_text('x')
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_DIR=str(file_path)))
    assert 'OPENCLAW_TEMPLATE_DIR' in str(ei.value)
    assert '目录' in str(ei.value)


def test_validate_prod_env_fail_fast_when_template_dir_not_readable(tmp_path):
    """codex P2 :55：OPENCLAW_TEMPLATE_DIR 是已存在目录但当前进程无读/遍历权限 →
    HomeProvisioner.copytree 递归拷贝仍抛 PermissionError。is_dir() 仅判文件类型不判权限位，
    须 os.access(R_OK|X_OK) 兜底（R_OK=列条目，X_OK=遍历子目录，copytree 递归两者皆需）。
    root 用户绕过 POSIX 权限位（os.access 恒 True），该用例在 root 下跳过。
    """
    if hasattr(os, 'geteuid') and os.geteuid() == 0:
        __import__('pytest').skip('root 绕过 POSIX 权限位，os.access 恒 True')
    no_access = tmp_path / 'no_access'
    no_access.mkdir()
    no_access.chmod(0o000)
    try:
        with __import__('pytest').raises(ImproperlyConfigured) as ei:
            validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_DIR=str(no_access)))
        msg = str(ei.value)
        assert 'OPENCLAW_TEMPLATE_DIR' in msg
        assert '权限' in msg
    finally:
        no_access.chmod(0o755)  # 还原权限，让 tmp_path fixture 能清理


# ---- LLM_API_KEY 生产 fail-fast（issue #258 / parent #250）----
# ADR 0005 + spec §5.2：LLM_API_KEY 是全面板共享的必填敏感值。base.py 声明为默认空串
# （dev/integration 宽容，integration CI 靠 env 注入跑真容器），生产由本校验强制非空——
# 缺省空串会静默注入空 key 到 OpenClaw 容器，首次创建/对话才暴露（issue #195 同类错配）。


def test_validate_prod_env_fail_fast_when_llm_api_key_missing():
    """LLM_API_KEY 缺失 → ImproperlyConfigured（运维启动即知，而非首次创建/对话才暴露）。"""
    env = _minimal_env()
    env.pop('LLM_API_KEY')
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(env)
    msg = str(ei.value)
    assert 'LLM_API_KEY' in msg
    assert '生产' in msg and ('必填' in msg or '必设' in msg or '必须' in msg)
    # 错误消息指向部署文档，运维能立即知道在哪改（与 TEMPLATE_DIR 校验同款）
    assert 'deploy/README.md' in msg or 'deploy/.env.example' in msg, (
        f'错误消息应指向部署文档，当前: {msg!r}'
    )


def test_validate_prod_env_fail_fast_when_llm_api_key_empty():
    """LLM_API_KEY 显式空串 → 同样 fail-fast（与缺失同语义：空 key 静默注入容器）。"""
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(LLM_API_KEY=''))
    assert 'LLM_API_KEY' in str(ei.value)


def test_validate_prod_env_fail_fast_when_llm_api_key_whitespace_only():
    """LLM_API_KEY 仅空白 → 仍 fail-fast（防运维误设含缩进的空值）。"""
    with __import__('pytest').raises(ImproperlyConfigured):
        validate_prod_env(_minimal_env(LLM_API_KEY='   '))


# ---- REDIS_URL 生产 fail-fast（issue #252 / parent #243）----
# REDIS_URL 是 DistributedLock（backend/common/lock）的**连接配置**（非凭证，区别于
# LLM_API_KEY 敏感值）。base.py 提供开发可跑默认（env 可覆盖），dev.py 显式本地默认，
# 生产由本校验强制非空——缺省会让 LockFleet 首次用锁时才连接失败，违背 fail-fast
# 「启动时即知」初衷（对齐 SECRET_KEY/LLM_API_KEY 先例）。本票纯 settings 字符串，
# 不引入 redis/channels-redis/django-redis 运行时依赖（与 Port/Adapter 解耦）。


def test_validate_prod_env_ok_when_redis_url_set():
    """REDIS_URL 显式提供 → 正常通过（与其他必填项一起给齐时不抛）。"""
    validate_prod_env(_minimal_env())  # 不抛即通过


def test_validate_prod_env_fail_fast_when_redis_url_missing():
    """REDIS_URL 缺失 → ImproperlyConfigured（启动即知，而非首次用锁才连接失败）。"""
    env = _minimal_env()
    env.pop('REDIS_URL')
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(env)
    msg = str(ei.value)
    assert 'REDIS_URL' in msg
    assert '生产' in msg and ('必填' in msg or '必设' in msg or '必须' in msg)
    # 错误消息指向部署文档，运维能立即知道在哪改（与 TEMPLATE_DIR/LLM_API_KEY 同款）
    assert 'deploy/README.md' in msg or 'deploy/.env.example' in msg, (
        f'错误消息应指向部署文档，当前: {msg!r}'
    )


def test_validate_prod_env_fail_fast_when_redis_url_empty():
    """REDIS_URL 显式空串 → 同样 fail-fast（与缺失同语义：空连接串到首次用锁才暴露）。"""
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(REDIS_URL=''))
    assert 'REDIS_URL' in str(ei.value)


def test_validate_prod_env_fail_fast_when_redis_url_whitespace_only():
    """REDIS_URL 仅空白 → 仍 fail-fast（防运维误设含缩进的空值）。"""
    with __import__('pytest').raises(ImproperlyConfigured):
        validate_prod_env(_minimal_env(REDIS_URL='   '))


# ---- OPENCLAW_TEMPLATE_JSON 生产 fail-fast ----
# openclaw.json 模板文件（配置单一来源，与单容器 compose 共用 deploy/openclaw.json）。
# base.py 默认 <repo>/deploy/openclaw.json 仅适用开发/CI；生产镜像化后端（context=backend +
# COPY . /app）里 BASE_DIR.parent/deploy 解析成 /deploy 且不存在 → 首次创建容器裸 500
# （orchestrator.create 惰性 read_text → FileNotFoundError，view 未捕获）。生产须经 compose
# 挂载文件 + 注入绝对路径，启动期 fail-fast 让运维立即知道，而非首次创建容器才暴露。


def test_validate_prod_env_ok_when_template_json_set():
    """OPENCLAW_TEMPLATE_JSON 提供已存在的绝对文件 → 正常通过（与其它必填项一起）。"""
    validate_prod_env(_minimal_env())  # 不抛即通过


def test_validate_prod_env_fail_fast_when_template_json_missing():
    """OPENCLAW_TEMPLATE_JSON 缺失 → ImproperlyConfigured（运维启动即知，而非首次创建 500）。"""
    env = _minimal_env()
    env.pop('OPENCLAW_TEMPLATE_JSON')
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(env)
    msg = str(ei.value)
    assert 'OPENCLAW_TEMPLATE_JSON' in msg
    assert '生产' in msg and ('必填' in msg or '必设' in msg or '必须' in msg)
    assert 'deploy/README.md' in msg or 'deploy/.env.example' in msg, (
        f'错误消息应指向部署文档，当前: {msg!r}'
    )


def test_validate_prod_env_fail_fast_when_template_json_relative():
    """OPENCLAW_TEMPLATE_JSON 相对路径 → fail-fast（镜像内 BASE_DIR 是容器路径，相对会被 cwd 吞）。"""
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_JSON='openclaw.json'))
    msg = str(ei.value)
    assert 'OPENCLAW_TEMPLATE_JSON' in msg
    assert '绝对路径' in msg
    assert "'openclaw.json'" in msg


def test_validate_prod_env_fail_fast_when_template_json_nonexistent(tmp_path):
    """OPENCLAW_TEMPLATE_JSON 绝对路径但不存在 → fail-fast（首次创建容器才 FileNotFoundError）。"""
    missing = tmp_path / 'no_openclaw.json'
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_JSON=str(missing)))
    msg = str(ei.value)
    assert 'OPENCLAW_TEMPLATE_JSON' in msg
    assert '文件' in msg
    assert str(missing) in msg


def test_validate_prod_env_fail_fast_when_template_json_is_dir(tmp_path):
    """OPENCLAW_TEMPLATE_JSON 指向目录（绝对、存在但不是文件）→ fail-fast（ConfigRenderer 需文件）。"""
    a_dir = tmp_path / 'a_dir'
    a_dir.mkdir()
    with __import__('pytest').raises(ImproperlyConfigured) as ei:
        validate_prod_env(_minimal_env(OPENCLAW_TEMPLATE_JSON=str(a_dir)))
    assert 'OPENCLAW_TEMPLATE_JSON' in str(ei.value)
