"""chat app 路由 —— 设备配对子资源，挂在 /api/v1/containers/<name>/pairing/。

GET  /   —— 查询配对状态
POST /   —— 触发/重试配对
"""
from django.urls import path

from chat.views import PairingView

urlpatterns = [
    path('containers/<str:name>/pairing/', PairingView.as_view(), name='pairing'),
]
