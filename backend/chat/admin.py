"""chat admin —— Pairing 记账只读视图（调试/对账用）。

真只读（对齐 containers.admin）：禁 add/change/delete。改行会绕过 PairingService 状态机。
私钥（private_key_pem）/device_token 是凭证——用 exclude 完全移出 admin 表单
（readonly_fields 仍会在 change 页明文渲染凭证，codex R security），仅保留非敏感字段。
"""
from django.contrib import admin

from .models import Pairing


@admin.register(Pairing)
class PairingAdmin(admin.ModelAdmin):
    list_display = ('instance', 'device_id', 'status', 'updated_at')
    search_fields = ('instance__name', 'device_id')
    # 凭证字段完全移出表单（change 页亦不渲染），仅暴露非敏感派生信息
    exclude = ('private_key_pem', 'device_token')
    readonly_fields = (
        'instance', 'device_id', 'public_key_pem',
        'scopes_json', 'pairing_request_id', 'status', 'updated_at',
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
