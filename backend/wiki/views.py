"""wiki views —— 每容器 wiki/main 文件树 + 页面 CRUD + graph（spec §6 / issue #45）。

HTTP 薄适配层：path 必经 Serializer is_valid（spec §4 零信任，防目录穿越），业务委托
WikiService（直读/直写文件系统）。路径参数 name 经 NAME_VALIDATOR（防 URL path 注入）。
受全局 IsAuthenticated 保护（spec §3），无 token → 401。

领域异常转 HTTP：InvalidPath→400（path 注入/穿越），PageNotFound→404，instance 不存在→404。
"""
import logging

from django.core.exceptions import ValidationError
from django.http import Http404
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from containers.models import NAME_VALIDATOR, Instance
from wiki.compile import CompileFleet
from wiki.serializers import (
    WikiCategoryItemSerializer,
    WikiPageSerializer,
    WikiPageWriteSerializer,
    WikiPathSerializer,
    WikiTreeSerializer,
)
from wiki.service import InvalidPath, PageExists, PageNotFound, WikiService

# categories 聚合响应的 OpenAPI 契约（issue #84）：键是动态 category 值（开放词表，
# 扫到什么返回什么，不预设集合），值是条目数组 → object additionalProperties。
_CATEGORY_ITEM_SCHEMA = {
    'type': 'object',
    'properties': {
        'path': {'type': 'string'},
        'title': {'type': 'string'},
        'category': {'type': 'string'},
        'excerpt': {'type': 'string'},
    },
    'required': ['path', 'title', 'category', 'excerpt'],
}
WIKI_CATEGORIES_RESPONSE_SCHEMA = {
    'type': 'object',
    'additionalProperties': {
        'type': 'array',
        'items': _CATEGORY_ITEM_SCHEMA,
    },
}

logger = logging.getLogger(__name__)


class _InvalidName(Exception):
    """路径参数 name 非法（内部信号，非 HTTP 响应）。"""


class _BaseWikiView(APIView):
    def _get_instance(self, name: str) -> Instance:
        try:
            NAME_VALIDATOR(name)
        except ValidationError as exc:
            raise _InvalidName from exc
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            raise Http404
        return inst


class WikiTreeView(_BaseWikiView):
    """GET 文件树（五核心分类 + domains 子树）—— 验收 1。"""

    @extend_schema(responses=WikiTreeSerializer)
    def get(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        tree = WikiService(inst).build_tree()
        return Response(WikiTreeSerializer(tree).data)


class WikiPageView(_BaseWikiView):
    """GET 读取一页（验收 2 读取侧）。"""

    @extend_schema(parameters=[WikiPathSerializer], responses=WikiPageSerializer)
    def get(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        ser = WikiPathSerializer(data=request.query_params)
        ser.is_valid(raise_exception=True)  # spec §4：path 注入 → 400
        path = ser.validated_data['path']
        try:
            page = WikiService(inst).read_page(path)
        except InvalidPath:
            return Response({'detail': '非法 path'}, status=status.HTTP_400_BAD_REQUEST)
        except PageNotFound as exc:
            raise Http404 from exc
        return Response(WikiPageSerializer(page).data)

    @extend_schema(request=WikiPageWriteSerializer, responses={200: None, 404: None})
    def put(self, request, name):
        """覆盖已存在页（验收 2 写入侧）；编辑不主动触发 compile（r29 §2.3）。"""
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        ser = WikiPageWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        try:
            WikiService(inst).write_page(data['path'], data['content'])
        except InvalidPath:
            return Response({'detail': '非法 path'}, status=status.HTTP_400_BAD_REQUEST)
        except PageNotFound as exc:
            raise Http404 from exc
        return Response({'path': data['path']})

    @extend_schema(request=WikiPageWriteSerializer, responses={201: None, 409: None})
    def post(self, request, name):
        """新建一页（验收 3）：落盘并触发 compile 同步机器视图索引。"""
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        ser = WikiPageWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        try:
            WikiService(inst).create_page(data['path'], data['content'])
        except InvalidPath:
            return Response({'detail': '非法 path'}, status=status.HTTP_400_BAD_REQUEST)
        except PageExists:
            return Response({'detail': '页面已存在'}, status=status.HTTP_409_CONFLICT)
        CompileFleet.trigger(inst)  # 新建进搜索索引需 compile（异步去抖）
        return Response({'path': data['path']}, status=status.HTTP_201_CREATED)

    @extend_schema(parameters=[WikiPathSerializer], responses={204: None, 404: None})
    def delete(self, request, name):
        """删除一页（验收 3）：落盘并触发 compile 清索引残留。"""
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        ser = WikiPathSerializer(data=request.query_params)
        ser.is_valid(raise_exception=True)
        path = ser.validated_data['path']
        try:
            WikiService(inst).delete_page(path)
        except InvalidPath:
            return Response({'detail': '非法 path'}, status=status.HTTP_400_BAD_REQUEST)
        except PageNotFound as exc:
            raise Http404 from exc
        CompileFleet.trigger(inst)  # 删除清索引残留需 compile（异步去抖）
        return Response(status=status.HTTP_204_NO_CONTENT)


class WikiGraphView(_BaseWikiView):
    """GET 全库图谱（节点=遍历树，边=[[wikilink]]+related_pages）—— spec §6。"""

    @extend_schema(responses={200: None})
    def get(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        # service 输出已是规范 dict（nodes[{id,title,ghost?}], edges[{from,to}]），直接返回
        return Response(WikiService(inst).build_graph())


class WikiCategoriesView(_BaseWikiView):
    """GET categories 聚合（按 `category:` 标记分组带标记页）—— issue #84 / spec #75。"""

    @extend_schema(responses={200: WIKI_CATEGORIES_RESPONSE_SCHEMA})
    def get(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        categories = WikiService(inst).list_categories()
        return Response({cat: WikiCategoryItemSerializer(items, many=True).data
                         for cat, items in categories.items()})
