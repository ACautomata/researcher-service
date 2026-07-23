"""accounts 序列化器 —— 注册入参 / 用户信息出参。"""
from django.contrib.auth import get_user_model
from rest_framework import serializers

User = get_user_model()


class RegisterSerializer(serializers.Serializer):
    """注册入参（spec §4：经 is_valid 校验，禁止视图裸读 request.data）。"""

    username = serializers.CharField(max_length=150)
    password = serializers.CharField(write_only=True, min_length=8)
    email = serializers.EmailField(required=False, allow_blank=True)

    def create(self, validated_data):
        return User.objects.create_user(**validated_data)


class UserSerializer(serializers.ModelSerializer):
    """用户信息出参。"""

    class Meta:
        model = User
        fields = ['id', 'username', 'email']
        read_only_fields = ['id']
