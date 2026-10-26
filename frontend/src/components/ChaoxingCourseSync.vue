<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { listChaoxingCourses, syncChaoxingCourses, type LearningCourse } from '@/api/chaoxing'
import { buildCourseSyncBookmarklet, parseCourseImport, type SyncedCourse } from '@/chaoxing/courseSync'
const courses = ref<LearningCourse[]>([])
const preview = ref<SyncedCourse[]>([])
const syncedAt = ref<string | null>(null)
const raw = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const bookmarklet = buildCourseSyncBookmarklet(window.location.origin)
function readPreview(input: string) {
  error.value = ''; notice.value = ''; preview.value = []
  try { preview.value = parseCourseImport(input) }
  catch { error.value = '清单无效：需包含课程名称、课程和班级信息，最多 100 个课程/班级。请重新同步或选择课程清单文件。' }
}
async function readFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > 80_000) { error.value = '课程清单文件过大'; return }
  try { readPreview(await file.text()) } catch { error.value = '无法读取课程清单文件' }
}
async function save(rows: SyncedCourse[]) {
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const result = await syncChaoxingCourses(rows)
    courses.value = result.rows; syncedAt.value = result.syncedAt; preview.value = []; raw.value = ''
    notice.value = rows.length ? `已同步 ${rows.length} 个课程/班级，现在可直接按关键词搜索` : '课程清单已清除'
  } catch { error.value = '课程清单保存失败，请检查绑定状态后重试' }
  finally { busy.value = false }
}
onMounted(async () => {
  const fragment = window.location.hash
  if (fragment.startsWith('#chaoxing-courses=')) {
    // 元数据只经 URL fragment 交给浏览器，不进入服务端日志；预览前即清理地址。
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    try { readPreview(decodeURIComponent(fragment.slice('#chaoxing-courses='.length))) }
    catch { error.value = '同步清单无法解析，请重试' }
  }
  try { const result = await listChaoxingCourses(); courses.value = result.rows; syncedAt.value = result.syncedAt ?? null }
  catch { error.value = '暂时无法读取已同步课程，请稍后重试' }
})
</script>
<template>
  <section aria-labelledby="course-sync-heading" class="course-sync">
    <h3 id="course-sync-heading">我的超星课程</h3>
    <p>首次同步课程后，在对话中输入 <code>/course-search 关键词</code>，即可搜索已同步的课程资料，无需填写课程或班级 ID。</p>
    <ol>
      <li>将 <a :href="bookmarklet" draggable="true" aria-label="同步我的超星课程书签">同步我的超星课程</a> 拖到浏览器书签栏。</li>
      <li><a href="https://mooc2-ans.chaoxing.com/visit/interaction" target="_blank" rel="noopener noreferrer">打开超星“我学的课”</a>，登录后点击刚保存的同步书签。</li>
      <li>返回本页，核对课程清单并确认同步。新增或退课后请重新同步。</li>
    </ol>
    <p>同步只读取当前页面列出的课程名称、课程及班级信息，不读取密码或 Cookie；资料访问仍由本人超星授权校验。另行归档的课程需单独整理导入。</p>
    <label>也可导入课程清单文件 <input type="file" accept=".json,application/json" :disabled="busy" @change="readFile" /></label>
    <details><summary>粘贴已有课程清单</summary>
      <label>课程清单<textarea v-model="raw" aria-label="课程清单" :disabled="busy" maxlength="80000" /></label>
      <button :disabled="busy || !raw" @click="readPreview(raw)">预览清单</button>
    </details>
    <div v-if="preview.length">
      <h4>待同步 {{ preview.length }} 个课程/班级</h4>
      <p>确认后将替换现有课程清单。</p>
      <ul><li v-for="course in preview" :key="`${course.id}:${course.classId}`">{{ course.name }}</li></ul>
      <button :disabled="busy" @click="save(preview)">确认同步</button>
      <button :disabled="busy" @click="preview = []">取消导入</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p>已保存 {{ courses.length }} 个课程/班级<span v-if="syncedAt">，同步于 {{ new Date(syncedAt).toLocaleString() }}</span></p>
    <ul><li v-for="course in courses" :key="`${course.id}:${course.classId}`">{{ course.name }}</li></ul>
    <button v-if="courses.length" :disabled="busy" @click="save([])">清除课程清单</button>
  </section>
</template>
<style scoped>
.course-sync { margin-top: 24px; border-top: 1px solid var(--el-border-color); padding-top: 16px; }
p, li { line-height: 1.7; } a { color: var(--el-color-primary); }
textarea { display: block; width: 100%; min-height: 100px; box-sizing: border-box; }
ul { max-height: 240px; overflow-y: auto; } button { margin: 8px 8px 8px 0; padding: 6px 12px; }
[role="alert"] { color: var(--el-color-danger); }
</style>
