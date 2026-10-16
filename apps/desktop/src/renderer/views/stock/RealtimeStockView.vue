<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../composables/useCrud';
import type { StockBalanceFilter, StockBalanceRow } from '../../../../env';

interface DictItem {
  id: string;
  name: string;
}

const rows = ref<StockBalanceRow[]>([]);
const loading = ref(false);
const warehouses = ref<DictItem[]>([]);
const filters = reactive<{ keyword: string; warehouseId: string; includeZero: boolean }>({
  keyword: '',
  warehouseId: '',
  includeZero: false,
});

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function num(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(Number(n.toFixed(6))) : '0';
}

function money(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

async function loadWarehouses(): Promise<void> {
  try {
    const list = await api().query('warehouse');
    warehouses.value = list.map((w) => ({ id: String(w.id), name: String(w.name ?? w.id) }));
  } catch {
    // 仓库字典失败不阻断库存列表
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const filter: StockBalanceFilter = { includeZero: filters.includeZero };
    const key = filters.keyword.trim();
    if (key) filter.keyword = key;
    if (filters.warehouseId) filter.warehouseId = filters.warehouseId;
    rows.value = await api().stock.balance(filter);
  } catch (err) {
    rows.value = [];
    ElMessage.error(message(err));
  } finally {
    loading.value = false;
  }
}

async function recompute(): Promise<void> {
  loading.value = true;
  try {
    const res = await api().stock.recompute();
    ElMessage.success(`重算完成，更新 ${res.rows} 条余额`);
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    await load();
  }
}

function resetSearch(): void {
  filters.keyword = '';
  filters.warehouseId = '';
  filters.includeZero = false;
  void load();
}

/** 低于 min_stock 或高于 max_stock 时高亮行。 */
function rowClass({ row }: { row: StockBalanceRow }): string {
  const qty = Number(row.qty ?? 0);
  if (row.min_stock !== null && qty < Number(row.min_stock)) return 'row-low';
  if (row.max_stock !== null && qty > Number(row.max_stock)) return 'row-high';
  return '';
}

onMounted(async () => {
  await loadWarehouses();
  await load();
});
</script>

<template>
  <div>
    <el-card class="card-gap">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="关键字">
          <el-input
            v-model="filters.keyword"
            placeholder="商品编号 / 名称 / 条码"
            clearable
            style="width: 240px"
            @keyup.enter="load"
          />
        </el-form-item>
        <el-form-item label="仓库">
          <el-select v-model="filters.warehouseId" clearable placeholder="全部" style="width: 160px" value-on-clear="">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="显示零库存">
          <el-switch v-model="filters.includeZero" @change="load" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="load">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="warning" @click="recompute">全量重算</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <el-table v-loading="loading" :data="rows" empty-text="暂无库存数据" border stripe :row-class-name="rowClass">
        <el-table-column prop="product_code" label="商品编号" width="130" />
        <el-table-column prop="product_name" label="商品名称" min-width="160" />
        <el-table-column prop="warehouse_name" label="仓库" width="130" />
        <el-table-column prop="location_name" label="货位" width="120">
          <template #default="{ row }">{{ row.location_name || '-' }}</template>
        </el-table-column>
        <el-table-column prop="unit_name" label="单位" width="80" />
        <el-table-column label="现有量" width="110" align="right">
          <template #default="{ row }">{{ num(row.qty) }}</template>
        </el-table-column>
        <el-table-column label="可用量" width="110" align="right">
          <template #default="{ row }">{{ num(row.avail_qty) }}</template>
        </el-table-column>
        <el-table-column label="移动加权均价" width="130" align="right">
          <template #default="{ row }">{{ money(row.avg_cost) }}</template>
        </el-table-column>
        <el-table-column label="成本金额" width="130" align="right">
          <template #default="{ row }">{{ money(row.cost_amount) }}</template>
        </el-table-column>
        <el-table-column label="安全库存(下限/上限)" width="180" align="center">
          <template #default="{ row }">
            {{ row.min_stock ?? '-' }} / {{ row.max_stock ?? '-' }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
:deep(.row-low) {
  --el-table-tr-bg-color: #fef0f0;
}
:deep(.row-high) {
  --el-table-tr-bg-color: #fdf6ec;
}
</style>
