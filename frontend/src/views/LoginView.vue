<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/errors'

// spec §9.2：本地账号注册/登录表单；提交后存 access token 并跳容器管理页。
const auth = useAuthStore()
const router = useRouter()
const mode = ref<'login' | 'register'>('login')
const form = reactive({ username: '', password: '' })
const errorMsg = ref('')
// #202 问题6：提交中 loading 态 + 防重复点击
const submitting = ref(false)

async function onSubmit(): Promise<void> {
  if (submitting.value) return // 提交中防重复点击
  errorMsg.value = ''
  submitting.value = true
  try {
    if (mode.value === 'register') {
      await auth.register(form.username, form.password)
    } else {
      await auth.login(form.username, form.password)
    }
    await router.push('/')
  } catch (err) {
    // codex P2：仅「已解析的 API 错误」（rejectWithApiError 抛的 ApiError）逐字透传
    // 后端真实校验消息（如「这个密码太常见了。」）。fetch 因后端不可达 reject 抛原生
    // TypeError（"Failed to fetch"/"Load failed"）属网络/意外错误,不带可读 API 消息,
    // 须走模式专属本地化兜底——旧实现只判 err.message 非空会把英文浏览器报错漏给用户。
    errorMsg.value =
      err instanceof ApiError && err.message
        ? err.message
        : mode.value === 'register'
          ? '注册失败，请稍后重试'
          : '登录失败，请稍后重试'
  } finally {
    submitting.value = false
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
    <!-- #202 问题6：回车提交——input 上 keyup.enter 直挂 + form 上兜底（事件冒泡），防重复由 submitting 保证 -->
    <el-form @submit.prevent="onSubmit" @keyup.enter="onSubmit">
      <el-form-item label="用户名">
        <el-input v-model="form.username" placeholder="用户名" @keyup.enter="onSubmit" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input v-model="form.password" type="password" placeholder="密码" @keyup.enter="onSubmit" />
      </el-form-item>
      <el-form-item v-if="errorMsg">
        <span class="error">{{ errorMsg }}</span>
      </el-form-item>
      <el-button type="primary" :loading="submitting" :disabled="submitting" @click="onSubmit">
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
