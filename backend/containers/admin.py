"""containers admin —— Instance 记账只读视图（调试/对账用）。

codex R1 :admin：真只读——禁 add/change/delete。删行会绕过 InstanceOrchestrator.delete()
留孤儿容器（+ 残留目录），改名/端口/状态破坏 runtime↔DB 映射。
token 字段仍只读 + 列表隐藏（凭证防御纵深，即便 change 已禁亦保留）。
"""
from django.contrib import admin

from .models import Instance


@admin.register(Instance)
class InstanceAdmin(admin.ModelAdmin):
    list_display = ('name', 'port', 'status', 'image', 'created_at')
    search_fields = ('name',)
    readonly_fields = ('token', 'container_id', 'created_at')

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
