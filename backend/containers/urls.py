"""containers app 路由 —— 挂在 /api/v1/containers/（spec §9.3）。

GET/POST /            —— 列表 / 新建
DELETE  /<name>       —— 删除（连数据删）
"""
from django.urls import path

from .views import InstanceDetailView, InstanceListCreateView

urlpatterns = [
    path('', InstanceListCreateView.as_view(), name='instance-list-create'),
    path('<str:name>', InstanceDetailView.as_view(), name='instance-detail'),
]
