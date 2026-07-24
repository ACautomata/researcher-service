"""containers admin —— Instance 记账只读视图（调试/对账用）。

token / container_id / created_at 只读（token 是 gateway 凭证，禁止在 admin 改）。
list_display 不含 token（避免列表页泄漏凭证）。
"""
from django.contrib import admin

from .models import Instance


@admin.register(Instance)
class InstanceAdmin(admin.ModelAdmin):
    list_display = ('name', 'port', 'status', 'image', 'created_at')
    search_fields = ('name',)
    readonly_fields = ('token', 'container_id', 'created_at')
