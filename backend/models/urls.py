"""models app 路由 —— 挂在 /api/v1/containers/<name>/models/（spec §7）。

providers/          —— GET 列表 / POST 新建
providers/<pid>/    —— GET 回读 / PUT 改 / DELETE 删
"""
from django.urls import path

from .views import ModelProviderDetailView, ModelProviderListView

urlpatterns = [
    path('providers/', ModelProviderListView.as_view(), name='model-provider-list'),
    path('providers/<str:pid>/', ModelProviderDetailView.as_view(), name='model-provider-detail'),
]
