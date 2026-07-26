"""项目级 views —— 健康检查等不属于任一 app 的端点。"""

from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView


class HealthResponseSerializer(serializers.Serializer):
    """健康检查响应契约：{status: 'ok'}。"""

    status = serializers.CharField(read_only=True)


class HealthView(APIView):
    """健康检查端点（spec §0.1）。公开，不参与 JWT 拦截。"""

    permission_classes = (AllowAny,)

    @extend_schema(responses=HealthResponseSerializer)
    def get(self, request):
        return Response({'status': 'ok'})


class AuthProbeView(APIView):
    """受保护探针（T02 契约测试用，无业务 app 归属；后续 app 端点接管后删除）。

    不设 AllowAny，吃全局 DEFAULT_PERMISSION_CLASSES=[IsAuthenticated]（spec §3）：
    无 token → 401，带合法 access → 200。
    """

    @extend_schema(responses=HealthResponseSerializer)
    def get(self, request):
        return Response({'status': 'ok'})
