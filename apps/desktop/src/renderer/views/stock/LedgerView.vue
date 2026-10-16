<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../composables/useCrud';
import type { StockLedgerFilter, StockLedgerRow } from '../../../../env';

interface DictItem {
  id: string;
  name: string;
}

/** 库存流水业务类型（与 shared InventoryBizType 字典一致）。 */
const BIZ_TYPES = ['期初', '采购入库', '销售出库', '部门领用', '生产入库', '退货入库', '退货出库', '调拨', '盘点', '红冲'];

const rows = ref<StockLedgerRow[]>([]);
const loading = ref(false);
const warehouses = ref<DictItem[]>([]);
const filters = reactive<{
  keyword: string;
  warehouseId: string;
  bizType: string;
  dateRange: [Date, Date] | null;
}>({ keyword: '', warehouseId: '', bizType: '', dateRange: null });

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plain(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? String(Number(n.toFixed(6))) : '';
}

function money(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function formatDate(value: unknown): string {
  const n = Number(value);
  if (!n || !Number.isFinite(n)) return '-';
  const d = new Date(n);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function loadWarehouses(): Promise<void> {
  try {
    const list = await api().query('warehouse');
    warehouses.value = list.map((w) => ({ id: String(w.id), name: String(w.name ?? w.id) }));
  } catch {
    // 仓库字典失败不阻断流水列表
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const filter: StockLedgerFilter = {};
    const key = filters.keyword.trim();
    if (key) filter.keyword = key;
    if (filters.warehouseId) filter.warehouseId = filters.warehouseId;
    if (filters.bizType) filter.bizType = filters.bizType;
    if (filters.dateRange && filters.dateRange.length === 2) {
      filter.startDate = filters.dateRange[0].getTime();
      filter.endDate = filters.dateRange[1].getTime() + 86_399_999;
    }
    rows.value = await api().stock.ledger(filter);
  } catch (err) {
    rows.value = [];
    ElMessage.error(message(err));
  } finally {
    loading.value = false;
  }
}

function resetSearch(): void {
  filters.keyword = '';
  filters.warehouseId = '';
  filters.bizType = '';
  filters.dateRange = null;
  void load();
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
            placeholder="单据编号 / 商品编号 / 名称"
            clearable
            style="width: 240px"
            @keyup.enter="load"
          />
        </el-form-item>
        <el-form-item label="仓库">
          <el-select v-model="filters.warehouseId" clearable placeholder="全部" style="width: 150px" value-on-clear="">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="业务类型">
          <el-select v-model="filters.bizType" clearable placeholder="全部" style="width: 140px" value-on-clear="">
            <el-option v-for="t in BIZ_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="业务日期">
          <el-date-picker
            v-model="filters.dateRange"
            type="daterange"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            style="width: 260px"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="load">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <el-table v-loading="loading" :data="rows" empty-text="暂无流水数据" border stripe>
        <el-table-column label="业务日期" width="120">
          <template #default="{ row }">{{ formatDate(row.biz_date) }}</template>
        </el-table-column>
        <el-table-column prop="biz_type" label="业务类型" width="110" />
        <el-table-column prop="doc_no" label="单据编号" width="150">
          <template #default="{ row }">{{ row.doc_no || '-' }}</template>
        </el-table-column>
        <el-table-column prop="product_code" label="商品编号" width="120" />
        <el-table-column prop="product_name" label="商品名称" min-width="150" />
        <el-table-column prop="warehouse_name" label="仓库" width="120" />
        <el-table-column prop="location_name" label="货位" width="110">
          <template #default="{ row }">{{ row.location_name || '-' }}</template>
        </el-table-column>
        <el-table-column prop="unit_name" label="单位" width="80" />
        <el-table-column label="入库" width="100" align="right">
          <template #default="{ row }">{{ plain(row.qty_in) }}</template>
        </el-table-column>
        <el-table-column label="出库" width="100" align="right">
          <template #default="{ row }">{{ plain(row.qty_out) }}</template>
        </el-table-column>
        <el-table-column label="单位成本" width="110" align="right">
          <template #default="{ row }">{{ money(row.unit_cost) }}</template>
        </el-table-column>
        <el-table-column label="金额" width="110" align="right">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="冲销" width="80" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.reversal_of" type="info" size="small">红冲</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
