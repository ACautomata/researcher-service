<script setup lang="ts">
// admin Usage 核算页（#800）：按 user × provider × model 聚合展示 + 合计行。
// 时间窗 [from, to) 半开区间（相邻核算窗拼接不双计边界行）；用量行是唯一真值——
// 单价随 provider 配置版本可变（核算 join modelsJson.cost 属导出/对账侧，页面只展示用量）。
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { aggregateUsage, type UsageAggregateRowDTO } from '@/api/usage'

const rows = ref<UsageAggregateRowDTO[]>([])
const loading = ref(false)
const filters = reactive<{ userId: string; range: [Date, Date] | null }>({ userId: '', range: null })

const totals = computed(() => ({
  calls: rows.value.reduce((s, r) => s + r.calls, 0),
  inputTokens: rows.value.reduce((s, r) => s + r.input_tokens, 0),
  outputTokens: rows.value.reduce((s, r) => s + r.output_tokens, 0),
}))

async function search(): Promise<void> {
  loading.value = true
  try {
    rows.value = await aggregateUsage({
      ...(filters.userId.trim() ? { userId: filters.userId.trim() } : {}),
      ...(filters.range ? { from: filters.range[0], to: filters.range[1] } : {}),
    })
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(search)

defineExpose({ rows, totals, filters, search })
</script>

<template>
  <div class="admin-usage">
    <div class="header"><h1>Usage 核算</h1></div>

    <el-form inline @submit.prevent="search">
      <el-form-item label="userId">
        <el-input v-model="filters.userId" placeholder="全部用户" style="width: 180px" data-test="usage-user-id" />
      </el-form-item>
      <el-form-item label="时间窗">
        <el-date-picker
          v-model="filters.range"
          type="daterange"
          start-placeholder="from（含）"
          end-placeholder="to（不含）"
          data-test="usage-range"
        />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" native-type="submit" :loading="loading" data-test="usage-search" @click="search">
          查询
        </el-button>
      </el-form-item>
    </el-form>

    <el-table :data="rows" v-loading="loading" data-test="usage-table" show-summary :summary-method="() => [
      '合计', '', '', '',
      String(totals.calls),
      String(totals.inputTokens),
      String(totals.outputTokens),
      '',
      '',
    ]">
      <el-table-column prop="username" label="用户" width="140" />
      <el-table-column prop="provider_id" label="provider" width="140" />
      <el-table-column prop="lc_provider" label="LC provider" width="120" />
      <el-table-column prop="model" label="模型" min-width="180" />
      <el-table-column prop="calls" label="调用数" width="100" />
      <el-table-column prop="input_tokens" label="input tokens" width="140" />
      <el-table-column prop="output_tokens" label="output tokens" width="140" />
      <el-table-column prop="cache_read_tokens" label="cache read" width="110" />
      <el-table-column prop="cache_write_tokens" label="cache write" width="110" />
    </el-table>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
</style>
