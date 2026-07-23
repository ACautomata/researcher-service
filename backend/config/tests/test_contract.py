"""seam: 后端契约端点（health + OpenAPI schema）—— issue #37 P0 骨架。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §4（drf-spectacular 出 OpenAPI schema 作权威契约）。
"""
import pytest
from rest_framework.test import APIClient


@pytest.fixture
def api():
    return APIClient()


def test_health_returns_ok(api):
    resp = api.get('/api/health')
    assert resp.status_code == 200
    assert resp.json() == {'status': 'ok'}


def test_schema_returns_openapi(api):
    resp = api.get('/api/schema/?format=json')
    assert resp.status_code == 200
    doc = resp.json()
    # 期望值来自 OpenAPI 3.x 规范，非用代码同样方式重算
    assert doc['openapi'].startswith('3.')
    assert 'paths' in doc
    # schema 必须反映真实存在的 health 路由
    assert '/api/health' in doc['paths']


def test_schema_swagger_ui(api):
    # spec §4：Swagger UI 与 schema 并存，供前端/执行 agent 检视契约
    resp = api.get('/api/schema/swagger/')
    assert resp.status_code == 200
