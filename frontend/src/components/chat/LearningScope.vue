<script setup lang="ts">
import { onActivated, ref, watch } from 'vue'
import { getChaoxingStatus, getLearningScope, listChaoxingCourses, setLearningScope, type ChaoxingStatus, type LearningCourse } from '@/api/chaoxing'
const props = defineProps<{ sessionId: string | null; disabled?: boolean }>()
const status = ref<ChaoxingStatus | null>(null)
const courses = ref<LearningCourse[]>([])
const courseId = ref('')
const error = ref('')
const busy = ref(false)
const expanded = ref(false)
let generation = 0
async function load(sessionId: string | null) {
  const current = ++generation
  courses.value = []; courseId.value = ''; error.value = ''; expanded.value = false; status.value = null; busy.value = false
  try {
    const next = await getChaoxingStatus()
    if (current !== generation) return
    status.value = next
    if (sessionId && next.connected) {
      const scope = await getLearningScope(sessionId)
      if (current === generation) {
        courseId.value = scope.courseId ?? ''
        if (scope.courseId) {
          const result = await listChaoxingCourses()
          if (current === generation) courses.value = result.rows
        }
      }
    }
  } catch { if (current === generation) error.value = '学习资源状态暂不可用' }
}
watch(() => props.sessionId, load, { immediate: true })
onActivated(() => { void load(props.sessionId) })
async function showCourses() {
  expanded.value = true
  const current = generation
  try {
    const result = await listChaoxingCourses()
    if (current !== generation) return
    courses.value = result.rows
    if (result.truncated) error.value = '课程列表可能不完整'
  } catch { if (current === generation) error.value = '课程列表暂不可用，仍可继续对话学习' }
}
async function change(event: Event) {
  if (!props.sessionId) return
  const current = generation
  const sessionId = props.sessionId
  const selected = (event.target as HTMLSelectElement).value
  busy.value = true; error.value = ''
  try {
    const result = await setLearningScope(sessionId, selected || null)
    if (current === generation) courseId.value = result.courseId ?? ''
  } catch { if (current === generation) error.value = '课程范围保存失败，请重试' }
  finally { if (current === generation) busy.value = false }
}
</script>
<template>
  <div v-if="status?.configured" class="learning-scope">
    <template v-if="!status.connected"><router-link to="/settings">绑定超星</router-link>，学习时获取相关课程资源推荐</template>
    <template v-else>
      <span>{{ courseId ? `课程范围：${courses.find(c => c.id === courseId)?.name ?? courseId}` : '学习资源自动推荐' }}</span>
      <button v-if="!expanded && sessionId" :disabled="disabled" @click="showCourses">{{ courseId ? '调整课程范围' : '限定课程（可选）' }}</button>
      <select v-if="expanded && sessionId" :value="courseId" :disabled="busy || disabled" aria-label="学习课程范围" @change="change">
        <option value="">自动推荐：全部已同步课程</option>
        <option v-for="course in courses" :key="`${course.id}:${course.classId ?? ''}`" :value="course.id">{{ course.name }}</option>
      </select>
      <router-link v-if="expanded && !courses.length" to="/settings">先同步我的超星课程</router-link>
      <span v-if="error" role="status">{{ error }}</span>
    </template>
  </div>
</template>
<style scoped>
.learning-scope { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 18px; font-size: 12px; color: var(--el-text-color-secondary); }
a, button { color: var(--el-color-primary); }
button, select { border: 1px solid var(--el-border-color); background: var(--el-bg-color); color: var(--el-text-color-primary); border-radius: 5px; padding: 4px 8px; }
</style>
