"""wiki app 路由 —— 挂在 /api/v1/containers/<name>/wiki/（spec §6 / §9.6）。

tree       —— GET 文件树（五核心分类 + domains 子树）
page       —— GET/PUT/POST/DELETE 页面 CRUD（?path= 相对 wiki/main）
graph      —— GET 全库图谱（节点=遍历树，边=[[wikilink]]）
categories —— GET categories 聚合（按 `category:` 标记分组，issue #84）
"""
from django.urls import path

from wiki.views import WikiCategoriesView, WikiGraphView, WikiPageView, WikiTreeView

urlpatterns = [
    path('tree', WikiTreeView.as_view(), name='wiki-tree'),
    path('page', WikiPageView.as_view(), name='wiki-page'),
    path('graph', WikiGraphView.as_view(), name='wiki-graph'),
    path('categories', WikiCategoriesView.as_view(), name='wiki-categories'),
]
