<script setup lang="ts">
// CategoriesView —— Categories 栏目（issue #85 / spec #75 前端）。
// 版面：顶部容器切换器 + 左按 category 动态分组（可折叠 chip+名称+计数）+ 右只读正文。
// 分组开放词表：遍历响应键建组，未知 category 也自动成组；chip 用 hash 取色（无需预设调色板）。
// 点条目右侧只读展示完整正文（复用 MdEditor readonly + readPage 取全文）。
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { listInstances } from '@/api/containers'
import { useCategoriesStore } from '@/stores/categories'
import MdEditor from '@/components/MdEditor.vue'

const store = useCategoriesStore()
const { current, groups, activePath, content } = storeToRefs(store)

const containers = ref<string[]>([])
// 折叠状态：category 键 → 是否折叠（默认展开）。开放词表键可能是 `__proto__`，
// 用 Map 而非普通对象（普通对象赋值 `__proto__` 会走原型 setter，导致该组折叠失效 —— codex P2）。
const collapsed = ref(new Map<string, boolean>())

// hash 取色：对 category 名做稳定 hash，映射到 HSL 色相（同值同色，未知值也自动有区分色）
function chipColor(category: string): string {
  let h = 0
  for (let i = 0; i < category.length; i += 1) {
    h = (h * 31 + category.charCodeAt(i)) | 0
  }
  const hue = ((h % 360) + 360) % 360
  return `hsl(${hue} 70% 45%)`
}

function isCollapsed(category: string): boolean {
  return collapsed.value.get(category) === true
}

function toggle(category: string): void {
  collapsed.value.set(category, !isCollapsed(category))
}

async function selectContainer(name: string): Promise<void> {
  if (!name) return
  // 初始化/重挂载：清掉 Pinia 残留的旧选中态（对齐 WikiView 的 resetForContainer 用法）
  await store.resetForContainer(name)
}

async function onSwitch(name: string): Promise<void> {
  // 早退判 pending（含在飞的目标容器）而非 current：加载在飞时再选回 current 必须推进作废旧请求
  if (name === store.pending) return
  try {
    await store.switchContainer(name)
  } catch (e) {
    ElMessage.error((e as Error).message) // 对齐 WikiView/onCreate 的错误处理约定（#202 问题3）
  }
}

async function onOpen(path: string): Promise<void> {
  try {
    await store.openItem(path)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

onMounted(async () => {
  try {
    const list = await listInstances()
    containers.value = list.map((i) => i.name)
    if (containers.value.length > 0) {
      await selectContainer(containers.value[0])
    }
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
})
</script>

<template>
  <div class="categories-view">
    <header class="categories-header">
      <span class="brand">Categories</span>
      <select
        data-test="container-switch"
        class="switcher"
        :value="current"
        @change="onSwitch(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
      </select>
    </header>

    <div class="categories-body">
      <aside class="left">
        <div v-if="Object.keys(groups).length === 0" class="empty" data-test="empty">
          该容器暂无带 category 标记的页面
        </div>
        <section v-for="(items, category) in groups" :key="category" class="cat-group" data-test="cat-group">
          <button
            class="cat-toggle"
            data-test="cat-toggle"
            @click="toggle(category)"
          >
            <span class="caret">{{ isCollapsed(category) ? '▸' : '▾' }}</span>
            <span
              class="chip"
              data-test="cat-chip"
              :style="{ background: chipColor(category) }"
            />
            <span class="cat-name" data-test="cat-name">{{ category }}</span>
            <span class="cat-count" data-test="cat-count">{{ items.length }}</span>
          </button>
          <ul v-if="!isCollapsed(category)" class="cat-items">
            <li
              v-for="item in items"
              :key="item.path"
              class="cat-item"
              :class="{ active: item.path === activePath }"
              data-test="cat-item"
              @click="onOpen(item.path)"
            >
              <div class="item-title">{{ item.title }}</div>
              <div class="item-excerpt">{{ item.excerpt }}</div>
            </li>
          </ul>
        </section>
      </aside>

      <main class="center">
        <MdEditor v-if="activePath" :content="content" :readonly="true" />
        <div v-else class="empty" data-test="empty-reading">从左侧选择一个条目开始阅读</div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.categories-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.categories-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid #e4e7ed;
}
.brand {
  font-weight: 600;
}
.switcher {
  padding: 4px 8px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
}
.categories-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.left {
  width: 280px;
  border-right: 1px solid #e4e7ed;
  overflow-y: auto;
}
.center {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}
.empty {
  color: #909399;
  padding: 40px;
  text-align: center;
}
.cat-group {
  border-bottom: 1px solid #f0f2f5;
}
.cat-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  text-align: left;
}
.caret {
  color: #909399;
  width: 12px;
}
.chip {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
}
.cat-name {
  font-weight: 600;
}
.cat-count {
  margin-left: auto;
  font-size: 12px;
  color: #909399;
}
.cat-items {
  list-style: none;
  margin: 0;
  padding: 0 0 4px;
}
.cat-item {
  padding: 6px 12px 6px 30px;
  cursor: pointer;
}
.cat-item:hover {
  background: #f5f7fa;
}
.cat-item.active {
  background: #ecf5ff;
}
.item-title {
  font-size: 13px;
  color: #303133;
}
.item-excerpt {
  font-size: 12px;
  color: #909399;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
