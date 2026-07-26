"""accounts 序列化器 —— 注册 / 登录 / 刷新 / 用户信息。"""
from django.contrib.auth import authenticate, get_user_model, password_validation
from django.contrib.auth.validators import UnicodeUsernameValidator
from rest_framework import serializers
from rest_framework.validators import UniqueValidator
from rest_framework_simplejwt.serializers import TokenRefreshSerializer

User = get_user_model()


class RegisterSerializer(serializers.Serializer):
    """注册入参（spec §4：经 is_valid 校验，禁止视图裸读 request.data）。"""

    username = serializers.CharField(
        max_length=150,
        validators=[UnicodeUsernameValidator(), UniqueValidator(queryset=User.objects.all())],
    )
    # codex round-4 F3：密码首尾空白不可裁剪（DRF CharField 默认 trim_whitespace=True），
    # 否则 admin 等外部创建的含边界空白账号无法通过本 API 登录。
    password = serializers.CharField(write_only=True, min_length=8, trim_whitespace=False)
    email = serializers.EmailField(required=False, allow_blank=True)

    def validate_password(self, value):
        # 跑 settings.AUTH_PASSWORD_VALIDATORS，传 prospective user 让
        # UserAttributeSimilarityValidator 比较 username/email（spec §4 零信任）
        user = User(
            username=self.initial_data.get('username', ''),
            email=self.initial_data.get('email', ''),
        )
        password_validation.validate_password(value, user=user)
        return value

    def create(self, validated_data):
        return User.objects.create_user(**validated_data)


class UserSerializer(serializers.ModelSerializer):
    """用户信息出参。"""

    class Meta:
        model = User
        fields = ('id', 'username', 'email')
        read_only_fields = ('id',)


class LoginSerializer(serializers.Serializer):
    """登录入参：username/password + authenticate。"""

    username = serializers.CharField()
    # codex round-4 F3：登录密码同样不裁剪空白，与注册对称存储原值。
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate(self, attrs):
        user = authenticate(
            username=attrs.get('username'), password=attrs.get('password'),
        )
        if user is None or not user.is_active:
            raise serializers.ValidationError('用户名或密码错误')
        attrs['user'] = user
        return attrs


class AccessTokenSerializer(serializers.Serializer):
    """登录响应：仅 access（refresh 走 httpOnly cookie，spec §3）。"""

    access = serializers.CharField(read_only=True)


class CookieTokenRefreshSerializer(TokenRefreshSerializer):
    """从 httpOnly cookie 读 refresh（spec §3），而非请求 body。"""

    refresh = serializers.CharField(required=False)  # 从 cookie 读，body 不要求

    def validate(self, attrs):
        attrs['refresh'] = self.context['request'].COOKIES.get('refresh_token')
        # None（无 cookie）或空串（logout 后 delete_cookie 置空）都算无有效 refresh
        if not attrs.get('refresh'):
            raise serializers.ValidationError({'refresh': '无 refresh cookie'})
        return super().validate(attrs)


class OIDCProviderConfigSerializer(serializers.Serializer):
    """OIDC provider 注册表条目配置（spec §3：issuer/client_id/scope 走 settings.OAUTH_PROVIDERS）。

    spec §4 零信任：视图不裸读配置 dict，经本 Serializer 校验完整性；缺键即判为未配置完整。
    """

    issuer = serializers.URLField()
    client_id = serializers.CharField()
    scope = serializers.CharField()
