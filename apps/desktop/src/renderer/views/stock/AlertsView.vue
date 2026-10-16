<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../composables/useCrud';
import type { StockAlertRow } from '../../../../env';

const rows = ref<StockAlertRow[]>([]);
const loading = ref(false);

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plain(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(Number(n.toFixed(6))) : '0';
}

function levelLabel(level: string): string {
  return level === 'low' ? '低于下限' : '高于上限';
}

function levelTagType(level: string): 'danger' | 'warning' {
  return level === 'low' ? 'danger' : 'warning';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await api().stock.alert();
  } catch (err) {
    rows.value = [];
    ElMessage.error(message(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <el-card class="card-gap">
      <div class="head">
        <span class="tip">按商品跨仓库汇总现有量，低于安全库存下限或高于上限时告警。</span>
        <el-button type="primary" @click="load">刷新</el-button>
      </div>
    </el-card>

    <el-card>
      <el-table v-loading="loading" :data="rows" empty-text="暂无库存预警" border stripe>
        <el-table-column prop="product_code" label="商品编号" width="140" />
        <el-table-column prop="product_name" label="商品名称" min-width="180" />
        <el-table-column prop="unit_name" label="单位" width="90" />
        <el-table-column label="当前库存" width="120" align="right">
          <template #default="{ row }">{{ plain(row.total_qty) }}</template>
        </el-table-column>
        <el-table-column label="下限" width="110" align="right">
          <template #default="{ row }">{{ row.min_stock ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="上限" width="110" align="right">
          <template #default="{ row }">{{ row.max_stock ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="预警类型" width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="levelTagType(row.level)">{{ levelLabel(row.level) }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tip {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
