<script setup lang="ts">
import { reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

// spec §9.2：本地账号登录表单；提交后存 access token 并跳容器管理页。
const auth = useAuthStore()
const router = useRouter()
const form = reactive({ username: '', password: '' })

async function onSubmit(): Promise<void> {
  await auth.login(form.username, form.password)
  await router.push('/')
}
</script>

<template>
  <div class="login">
    <h1>登录</h1>
    <el-form>
      <el-form-item label="用户名">
        <el-input v-model="form.username" placeholder="用户名" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input v-model="form.password" type="password" placeholder="密码" />
      </el-form-item>
      <el-button type="primary" @click="onSubmit">登录</el-button>
    </el-form>
  </div>
</template>
