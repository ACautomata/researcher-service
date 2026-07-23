<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

// spec §9.2：本地账号注册/登录表单；提交后存 access token 并跳容器管理页。
const auth = useAuthStore()
const router = useRouter()
const mode = ref<'login' | 'register'>('login')
const form = reactive({ username: '', password: '' })
const errorMsg = ref('')

async function onSubmit(): Promise<void> {
  errorMsg.value = ''
  try {
    if (mode.value === 'register') {
      await auth.register(form.username, form.password)
    } else {
      await auth.login(form.username, form.password)
    }
    await router.push('/')
  } catch {
    // codex P2-8：失败显示可操作错误，而非 unhandled rejection
    errorMsg.value =
      mode.value === 'register'
        ? '注册失败，用户名可能已存在'
        : '登录失败，请检查用户名和密码'
  }
}

// codex round-4 F5（spec §9.2）：登录/注册模式切换
function toggleMode(): void {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  errorMsg.value = ''
}
</script>

<template>
  <div class="login">
    <h1>{{ mode === 'login' ? '登录' : '注册' }}</h1>
    <el-form>
      <el-form-item label="用户名">
        <el-input v-model="form.username" placeholder="用户名" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input v-model="form.password" type="password" placeholder="密码" />
      </el-form-item>
      <el-form-item v-if="errorMsg">
        <span class="error">{{ errorMsg }}</span>
      </el-form-item>
      <el-button type="primary" @click="onSubmit">
        {{ mode === 'login' ? '登录' : '注册' }}
      </el-button>
      <a data-test="switch-register" href="#" @click.prevent="toggleMode">
        {{ mode === 'login' ? '没有账号？去注册' : '已有账号？去登录' }}
      </a>
    </el-form>
  </div>
</template>

<style scoped>
.error {
  color: var(--el-color-danger);
}
</style>
