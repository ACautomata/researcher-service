"""accounts views —— 注册 / 登录 / 刷新 / 当前用户。"""
from django.conf import settings
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.parsers import JSONParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from .serializers import (
    AccessTokenSerializer,
    CookieTokenRefreshSerializer,
    LoginSerializer,
    OIDCProviderConfigSerializer,
    RegisterSerializer,
    UserSerializer,
)


class RegisterView(APIView):
    """本地账号注册（spec §3）。公开，不参与 JWT 拦截。"""

    permission_classes = [AllowAny]

    @extend_schema(request=RegisterSerializer, responses={201: UserSerializer})
    def post(self, request):
        ser = RegisterSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user = ser.save()
        return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)


class LoginView(APIView):
    """登录：access(JSON body) + refresh(httpOnly cookie)，spec §3。"""

    permission_classes = [AllowAny]
    # codex round-4 F4：只接受 JSON。HTML <form> 无法发 application/json，
    # 故切断跨站表单登录 CSRF（攻击者无法用跨站 form 在受害者浏览器种攻击者 refresh cookie）。
    parser_classes = [JSONParser]

    @extend_schema(request=LoginSerializer, responses=AccessTokenSerializer)
    def post(self, request):
        ser = LoginSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user = ser.validated_data['user']
        refresh = RefreshToken.for_user(user)
        response = Response(
            {'access': str(refresh.access_token)}, status=status.HTTP_200_OK
        )
        response.set_cookie(
            'refresh_token',
            str(refresh),
            httponly=True,
            samesite='Lax',
            secure=not settings.DEBUG,
            path='/api/v1/auth',
        )
        return response


class CookieTokenRefreshView(TokenRefreshView):
    """刷新 access：从 httpOnly cookie 读 refresh（spec §3）。"""

    serializer_class = CookieTokenRefreshSerializer

    @extend_schema(
        request=None,  # refresh 走 httpOnly cookie，无 body（codex P2-4）
        responses=AccessTokenSerializer,
    )
    def post(self, request, *args, **kwargs):
        return super().post(request, *args, **kwargs)


class LogoutView(APIView):
    """登出：让 httpOnly refresh cookie 过期（codex P2-2，JS 无法清 httpOnly）。

    受全局 IsAuthenticated 保护（需 access token）。
    """

    @extend_schema(responses={204: None})
    def post(self, request):
        response = Response(status=status.HTTP_204_NO_CONTENT)
        response.delete_cookie('refresh_token', path='/api/v1/auth')
        return response


class MeView(APIView):
    """当前用户信息（spec §3）。受全局 IsAuthenticated 保护，不设 AllowAny。"""

    @extend_schema(responses=UserSerializer)
    def get(self, request):
        return Response(UserSerializer(request.user).data)


class _OIDCPlaceholderView(APIView):
    """OIDC 通用端点占位基类（spec §3）。

    授权码形态预留：provider 注册表 `settings.OAUTH_PROVIDERS` 按名查配置，
    未配置 / 配置不全（经 OIDCProviderConfigSerializer 校验）→ 501。
    骨架期真实 IdP 集成 out-of-scope（map #25），即便配置完整也仍 501「未接入」。
    """

    permission_classes = [AllowAny]

    @staticmethod
    def _provider_configured(provider: str) -> bool:
        config = settings.OAUTH_PROVIDERS.get(provider)
        if config is None:
            return False
        return OIDCProviderConfigSerializer(data=config).is_valid()

    def _placeholder(self, provider: str):
        if not self._provider_configured(provider):
            return Response(
                {'detail': f"OIDC provider '{provider}' 未配置"},
                status=status.HTTP_501_NOT_IMPLEMENTED,
            )
        # 配置完整但真实换 token/重定向未接入（骨架占位，留后续接具体 IdP）
        return Response(
            {'detail': f"OIDC provider '{provider}' 已配置，但 IdP 集成尚未接入（骨架占位）"},
            status=status.HTTP_501_NOT_IMPLEMENTED,
        )


class OAuthProviderLoginView(_OIDCPlaceholderView):
    """GET /api/v1/auth/oauth/<provider>/login —— 授权码形态预留（将来 302 重定向到 IdP）。"""

    @extend_schema(responses={501: None})
    def get(self, request, provider: str):
        return self._placeholder(provider)


class OAuthProviderCallbackView(_OIDCPlaceholderView):
    """GET /api/v1/auth/oauth/<provider>/callback —— 授权码换 token 占位。"""

    @extend_schema(responses={501: None})
    def get(self, request, provider: str):
        return self._placeholder(provider)
