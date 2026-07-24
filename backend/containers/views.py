"""containers views —— 容器列表/创建/删除（spec §3/§4/§9.3）。

HTTP 薄适配层：入参必经 Serializer is_valid（spec §4 零信任，禁裸读 request.data），
业务委托 Fleet.get()（orchestrator service locator）。路径参数 name 亦经 NAME_VALIDATOR
（防 URL path 目录穿越）。受全局 IsAuthenticated 保护（spec §3），无 token → 401。

codex R1：orchestrator 领域异常转译为 HTTP 语义——InstanceExists→409（并发重名），
InstanceCleanupError→409（home 清理失败，DB 行保留可重试）。
"""
from django.core.exceptions import ValidationError
from django.http import Http404
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import NAME_VALIDATOR
from .orchestrator import Fleet, InstanceCleanupError, InstanceExists
from .serializers import InstanceCreateSerializer, InstanceSerializer


class InstanceListCreateView(APIView):
    """GET 列表（name/status/health/port/image）+ POST 新建（spec §9.3）。"""

    @extend_schema(responses=InstanceSerializer(many=True))
    def get(self, request):
        items = Fleet.get().list()
        return Response(InstanceSerializer(items, many=True).data)

    @extend_schema(
        request=InstanceCreateSerializer,
        responses={201: InstanceSerializer, 409: None},
    )
    def post(self, request):
        ser = InstanceCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)  # spec §4：禁裸读 request.data
        name = ser.validated_data['name']
        try:
            Fleet.get().create(name)
        except InstanceExists:
            # codex R1 :84：并发绕 UniqueValidator → DB 唯一约束 → 409（非裸 IntegrityError→500）
            return Response({'detail': '实例名已存在'}, status=status.HTTP_409_CONFLICT)
        item = Fleet.get().detail(name)
        return Response(InstanceSerializer(item).data, status=status.HTTP_201_CREATED)


class InstanceDetailView(APIView):
    """DELETE 删除容器（默认连数据删，spec §5.4）。"""

    @extend_schema(responses={204: None, 409: None})
    def delete(self, request, name):
        # spec §4：路径参数也校验，防 URL path 注入 → 目录穿越（name 进 rmtree 路径）
        try:
            NAME_VALIDATOR(name)
        except ValidationError:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            removed = Fleet.get().delete(name)
        except InstanceCleanupError:
            # codex R1 :126：容器已停删但 home 清理失败 → 409 + DB 行保留（标 REMOVING，可重试）
            return Response(
                {'detail': '容器已停删，但 home 目录清理失败（权限/属主），请重试或手动清理'},
                status=status.HTTP_409_CONFLICT,
            )
        if not removed:
            raise Http404
        return Response(status=status.HTTP_204_NO_CONTENT)
