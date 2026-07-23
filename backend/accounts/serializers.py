"""accounts 序列化器 —— 注册 / 登录 / 刷新 / 用户信息。"""
from django.contrib.auth import authenticate, get_user_model
from django.contrib.auth import password_validation
from rest_framework import serializers
from rest_framework.validators import UniqueValidator
from rest_framework_simplejwt.serializers import TokenRefreshSerializer

User = get_user_model()


class RegisterSerializer(serializers.Serializer):
    """注册入参（spec §4：经 is_valid 校验，禁止视图裸读 request.data）。"""

    username = serializers.CharField(
        max_length=150, validators=[UniqueValidator(queryset=User.objects.all())]
    )
    password = serializers.CharField(write_only=True, min_length=8)
    email = serializers.EmailField(required=False, allow_blank=True)

    def validate_password(self, value):
        # 跑 settings.AUTH_PASSWORD_VALIDATORS（spec §4 零信任；min_length 只挡短密码）
        password_validation.validate_password(value)
        return value

    def create(self, validated_data):
        return User.objects.create_user(**validated_data)


class UserSerializer(serializers.ModelSerializer):
    """用户信息出参。"""

    class Meta:
        model = User
        fields = ['id', 'username', 'email']
        read_only_fields = ['id']


class LoginSerializer(serializers.Serializer):
    """登录入参：username/password + authenticate。"""

    username = serializers.CharField()
    password = serializers.CharField(write_only=True)

    def validate(self, attrs):
        user = authenticate(
            username=attrs.get('username'), password=attrs.get('password')
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
        if attrs.get('refresh') is None:
            raise serializers.ValidationError({'refresh': '无 refresh cookie'})
        return super().validate(attrs)
