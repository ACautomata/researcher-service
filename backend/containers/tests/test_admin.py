"""seam: Instance admin 只读 —— codex R1 :admin。

Instance admin 是记账/对账视图，须禁 add/change/delete：删行绕过 InstanceOrchestrator.delete()
留孤儿容器（+ 残留目录），改名/端口/状态破坏 runtime↔DB 映射。真只读 = 仅查看。
"""
from django.contrib import admin

from containers.admin import InstanceAdmin
from containers.models import Instance


def test_admin_has_no_add_permission():
    adm = InstanceAdmin(Instance, admin.site)
    assert adm.has_add_permission(None) is False


def test_admin_has_no_change_permission():
    adm = InstanceAdmin(Instance, admin.site)
    assert adm.has_change_permission(None) is False
    assert adm.has_change_permission(None, obj=object()) is False


def test_admin_has_no_delete_permission():
    adm = InstanceAdmin(Instance, admin.site)
    assert adm.has_delete_permission(None) is False
    assert adm.has_delete_permission(None, obj=object()) is False


def test_admin_token_still_readonly_and_hidden_from_list():
    # token 是 gateway 凭证：列表不展示、字段只读（即便 change 被禁也保留防御纵深）
    adm = InstanceAdmin(Instance, admin.site)
    assert 'token' in adm.readonly_fields
    assert 'token' not in adm.list_display
