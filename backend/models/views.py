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
from containers.orchestrator import ConfigWriteError, Fleet, InstanceNotFound
from models.models import ModelProvider
from models.serializers import ModelProviderReadSerializer, ModelProviderWriteSerializer


class _InvalidName(Exception):
    """路径参数 name 非法（内部信号，非 HTTP 响应）。"""


class _InstanceCreating(Exception):
    """目标实例仍在 provisioning（CREATING 行）——provider 变更须拒绝（codex review P2）。

    竞态：CREATING 期间 create 会写 base render 的 openclaw.json；若此时放行 rewrite_config
    写 provider-aware payload，create 的 base render 可能后到覆盖（lost update——provider
    事务提交成功但 openclaw.json 丢 provider）。与 delete 对 CREATING 拒删（InstanceBusy
    409）同模式，eliminate 整个竞态窗口。仅写操作（POST/PUT/DELETE）检查；GET 只读无竞态。
    """


class _BaseModelsView(APIView):
    def _get_instance(self, name: str, *, for_write: bool = False) -> Instance:
        try:
            NAME_VALIDATOR(name)
        except ValidationError as exc:
            raise _InvalidName from exc
        inst = Instance.objects.filter(name=name).first()
        if inst is None:
            raise Http404
        # codex review P2：写操作在 CREATING 行上拒绝（create 在飞/中断），防 base render
        # 覆盖并发 provider-aware rewrite（lost update）。READ 路径不检查（无写盘副作用）。
        if for_write and inst.status == Instance.STATUS_CREATING:
            raise _InstanceCreating
        return inst

    @staticmethod
    def _save_and_rewrite(provider: ModelProvider, name: str) -> None:
        """DB mutation + 重渲染在同一事务内：rewrite 失败 → DB 回滚，DB 与 openclaw.json 不分裂。

        unique(instance, provider_id) 冲突 → IntegrityError（view 转 409）；
        rewrite 写盘失败 → ConfigWriteError（view 转 503，DB 已回滚）；
        并发 delete 致实例消失 → InstanceNotFound（view 转 404，DB 已回滚）。
        """
        with transaction.atomic():
            provider.save()
            Fleet.get().rewrite_config(name)

    @staticmethod
    def _delete_and_rewrite(provider: ModelProvider, name: str) -> None:
        with transaction.atomic():
            provider.delete()
            Fleet.get().rewrite_config(name)

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
            inst = self._get_instance(name, for_write=True)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        except _InstanceCreating:
            return Response(
                {'detail': '容器正在创建中，暂不能配置模型，请稍候'},
                status=status.HTTP_409_CONFLICT,
            )
        ser = ModelProviderWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)  # spec §4：禁裸读 request.data
        provider = ModelProvider(instance=inst)
        self._apply(ser.validated_data, provider)
        try:
            self._save_and_rewrite(provider, name)
        except IntegrityError:
            # unique(instance, provider_id)：并发绕 serializer 或重复提交 → 409，非裸 500
            return Response(
                {'detail': '该容器下 provider_id 已存在'},
                status=status.HTTP_409_CONFLICT,
            )
        except InstanceNotFound:
            return Response({'detail': '容器不存在'}, status=status.HTTP_404_NOT_FOUND)
        except ConfigWriteError as e:
            # 写盘失败（卷只读/满）：DB 已回滚，配置停留在上一份一致状态 → 503
            return Response({'detail': str(e)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
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
            inst = self._get_instance(name, for_write=True)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        except _InstanceCreating:
            return Response(
                {'detail': '容器正在创建中，暂不能配置模型，请稍候'},
                status=status.HTTP_409_CONFLICT,
            )
        provider = self._get_provider(inst, pid)
        ser = ModelProviderWriteSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        self._apply(ser.validated_data, provider)
        try:
            self._save_and_rewrite(provider, name)
        except IntegrityError:
            # PUT 改 provider_id 撞同容器既有 pid → 409
            return Response(
                {'detail': '该容器下 provider_id 已存在'},
                status=status.HTTP_409_CONFLICT,
            )
        except InstanceNotFound:
            return Response({'detail': '容器不存在'}, status=status.HTTP_404_NOT_FOUND)
        except ConfigWriteError as e:
            return Response({'detail': str(e)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(ModelProviderReadSerializer(provider).data)

    @extend_schema(responses={204: None, 404: None})
    def delete(self, request, name, pid):
        try:
            inst = self._get_instance(name, for_write=True)
        except _InvalidName:
            return Response({'detail': '非法 name'}, status=status.HTTP_400_BAD_REQUEST)
        except _InstanceCreating:
            return Response(
                {'detail': '容器正在创建中，暂不能配置模型，请稍候'},
                status=status.HTTP_409_CONFLICT,
            )
        provider = self._get_provider(inst, pid)
        try:
            self._delete_and_rewrite(provider, name)  # 级联清理 + 重渲染，事务内
        except InstanceNotFound:
            return Response({'detail': '容器不存在'}, status=status.HTTP_404_NOT_FOUND)
        except ConfigWriteError as e:
            return Response({'detail': str(e)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(status=status.HTTP_204_NO_CONTENT)
