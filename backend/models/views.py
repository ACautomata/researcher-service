"""models views —— 每容器 model provider CRUD（spec §7 / issue #47）。

HTTP 薄适配层：path 必经 Serializer is_valid（spec §4 零信任），路径参数 name 经
NAME_VALIDATOR（防 URL path 注入），业务委托 ModelProvider ORM + Fleet.get().rewrite_config
（写后重渲染 openclaw.json 经 watch 热加载）。受全局 IsAuthenticated 保护（spec §3）。

领域异常转 HTTP：_InvalidName→400，实例/provider 不存在→404，unique(instance,provider_id)
冲突（并发绕校验）→409。PUT 改 provider_id 亦可能撞 unique → 409。
"""
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.http import Http404
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from containers.models import NAME_VALIDATOR, Instance
from containers.orchestrator import Fleet, InstanceNotFound
from models.models import ModelProvider
from models.serializers import ModelProviderReadSerializer, ModelProviderWriteSerializer


class _InvalidName(Exception):
    """路径参数 name 非法（内部信号，非 HTTP 响应）。"""


class _BaseModelsView(APIView):
    def _get_instance(self, name: str) -> Instance:
        try:
            NAME_VALIDATOR(name)
        except ValidationError:
            raise _InvalidName
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            raise Http404
        return inst

    def _rewrite_or_404(self, name: str) -> None:
        # 写 DB 后重渲染该容器 openclaw.json（spec §7：经 watch 热加载生效）；
        # 极端竞态（实例刚被并发 delete）→ InstanceNotFound 转 404。
        try:
            Fleet.get().rewrite_config(name)
        except InstanceNotFound:
            raise Http404

    @staticmethod
    def _apply(payload: dict, provider: ModelProvider) -> None:
        provider.provider_id = payload['provider_id']
        provider.api = payload['api']
        provider.base_url = payload['base_url']
        provider.api_key_env_id = payload['api_key_env_id']
        provider.auth_header = payload['auth_header']
        provider.models_json = payload['models']


class ModelProviderListView(_BaseModelsView):
    """GET 列表 + POST 新建（spec §7）。"""

    @extend_schema(responses=ModelProviderReadSerializer(many=True))
    def get(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        qs = inst.model_providers.all()
        return Response(ModelProviderReadSerializer(qs, many=True).data)

    @extend_schema(
        request=ModelProviderWriteSerializer,
        responses={201: ModelProviderReadSerializer, 400: None, 404: None, 409: None},
    )
    def post(self, request, name):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        ser = ModelProviderWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)  # spec §4：禁裸读 request.data
        provider = ModelProvider(instance=inst)
        self._apply(ser.validated_data, provider)
        try:
            with transaction.atomic():
                provider.save()
        except IntegrityError:
            # unique(instance, provider_id)：并发绕 serializer 或重复提交 → 409，非裸 500
            return Response(
                {'detail': '该容器下 provider_id 已存在'},
                status=status.HTTP_409_CONFLICT,
            )
        self._rewrite_or_404(name)
        return Response(
            ModelProviderReadSerializer(provider).data, status=status.HTTP_201_CREATED,
        )


class ModelProviderDetailView(_BaseModelsView):
    """GET 回读 / PUT 改 / DELETE 删（连级联清理 + 重渲染，spec §7）。"""

    @staticmethod
    def _get_provider(inst: Instance, pid: str) -> ModelProvider:
        provider = inst.model_providers.filter(provider_id=pid).first()
        if provider is None:
            raise Http404
        return provider

    @extend_schema(responses={200: ModelProviderReadSerializer, 404: None})
    def get(self, request, name, pid):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        provider = self._get_provider(inst, pid)
        return Response(ModelProviderReadSerializer(provider).data)

    @extend_schema(
        request=ModelProviderWriteSerializer,
        responses={200: ModelProviderReadSerializer, 400: None, 404: None, 409: None},
    )
    def put(self, request, name, pid):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        provider = self._get_provider(inst, pid)
        ser = ModelProviderWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        self._apply(ser.validated_data, provider)
        try:
            with transaction.atomic():
                provider.save()
        except IntegrityError:
            # PUT 改 provider_id 撞同容器既有 pid → 409
            return Response(
                {'detail': '该容器下 provider_id 已存在'},
                status=status.HTTP_409_CONFLICT,
            )
        self._rewrite_or_404(name)
        return Response(ModelProviderReadSerializer(provider).data)

    @extend_schema(responses={204: None, 404: None})
    def delete(self, request, name, pid):
        try:
            inst = self._get_instance(name)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        provider = self._get_provider(inst, pid)
        provider.delete()
        self._rewrite_or_404(name)  # 级联清理（重算 primary/fallbacks/aliases，无悬空引用）
        return Response(status=status.HTTP_204_NO_CONTENT)
