"""chat app 路由 —— 设备配对 + 对话会话子资源 + 权限审批 + 斜杠命令，挂在 /api/v1/。

containers/<name>/pairing/                —— GET/POST 查询/触发配对（spec §8.1）
containers/<name>/chat/sessions/          —— GET/POST 会话列表/新建（spec §9.4，issue #41）
containers/<name>/chat/approval/resolve   —— POST 审批回覆回退路径（spec §8.4，issue #42）
containers/<name>/chat/commands           —— GET 斜杠命令清单代理（spec §8.4，issue #43）
"""
from django.urls import path

from chat.views import ApprovalResolveView, CommandListView, PairingView, SessionListCreateView

urlpatterns = [
    path('containers/<str:name>/pairing/', PairingView.as_view(), name='pairing'),
    path('containers/<str:name>/chat/sessions/', SessionListCreateView.as_view(), name='chat-sessions'),
    path('containers/<str:name>/chat/approval/resolve',
         ApprovalResolveView.as_view(), name='chat-approval-resolve'),
    path('containers/<str:name>/chat/commands', CommandListView.as_view(), name='chat-commands'),
]
