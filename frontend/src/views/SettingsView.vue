<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import ChaoxingCourseSync from '@/components/ChaoxingCourseSync.vue'
import { authorizeChaoxing, getChaoxingStatus, unlinkChaoxing, type ChaoxingStatus } from '@/api/chaoxing'
const route = useRoute()
const status = ref<ChaoxingStatus | null>(null)
const busy = ref(false)
const error = ref('')
const notice = route.query.chaoxing === 'connected' ? '超星授权成功' : route.query.chaoxing === 'failed' ? '超星授权未完成，请重新尝试' : ''
async function load() {
  try { status.value = await getChaoxingStatus() }
  catch { error.value = '无法获取超星绑定状态，请稍后重试' }
}
async function bind() {
  busy.value = true; error.value = ''
  try {
    const { url } = await authorizeChaoxing()
    const target = new URL(url)
    if (target.origin !== 'https://api.chaoxing.com' || target.pathname !== '/auth/oauth2/authorize') throw new Error('授权地址无效')
    window.location.assign(target.href)
  } catch { error.value = '暂时无法发起超星授权，请检查配置后重试'; busy.value = false }
}
async function unlink() {
  busy.value = true; error.value = ''
  try { await unlinkChaoxing(); await load() }
  catch { error.value = '解绑失败，请稍后重试' }
  finally { busy.value = false }
}
onMounted(load)
</script>
<template>
  <main class="settings">
    <h1>账号设置</h1>
    <section aria-labelledby="chaoxing-heading">
      <h2 id="chaoxing-heading">超星学习账号</h2>
      <p>绑定本人超星账号并同步课程清单后，可在对话中直接按关键词检索课程资料。</p>
      <p>仅查询你有权限的教学数据，不修改课程或创建知识点。超星密码由超星登录页面处理。</p>
      <p>解绑会立即停止本平台的课程数据访问并清除本地授权；超星侧尚未提供已验证的远端撤销接口，如需撤销应用授权请前往超星账号设置操作。授权过期或失效后，可在此重新绑定。</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="status">
        <p v-if="!status.configured">管理员尚未配置超星接入。</p>
        <template v-else>
          <p role="status">{{ status.connected ? '已绑定' : '未绑定' }}</p>
          <button data-test="chaoxing-bind" :disabled="busy" @click="bind">{{ status.connected ? '重新授权' : '绑定超星' }}</button>
          <button v-if="status.connected" data-test="chaoxing-unlink" :disabled="busy" @click="unlink">解绑</button>
          <ChaoxingCourseSync v-if="status.connected" />
        </template>
      </template>
      <p v-else-if="!error">正在读取绑定状态…</p>
    </section>
  </main>
</template>
<style scoped>
.settings { max-width: 760px; margin: 36px auto; padding: 0 24px; color: var(--el-text-color-primary); }
h1 { font-size: 24px; } h2 { font-size: 18px; }
section { padding: 24px; border: 1px solid var(--el-border-color); border-radius: 12px; }
p { line-height: 1.7; color: var(--el-text-color-secondary); }
button { padding: 8px 16px; margin-right: 12px; cursor: pointer; color: var(--el-color-primary); background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 6px; }
button:disabled { opacity: .6; cursor: wait; }
[role="alert"] { color: var(--el-color-danger); }
</style>
