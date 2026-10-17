<script setup lang="ts">
/**
 * 操作日志（审计）。
 *
 * 数据来自 `op_log`：单据的审核 / 取消审核 / 红冲 / 转单都会留痕。
 * 列表支持按操作人、动作、单据类型、日期区间过滤；点击行可查看变更前后快照。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../composables/useCrud';
import type { OpLogDetail, OpLogFilter, OpLogRow } from '../../../../env';

/** 动作字典：值与 `op-log` 写入时的 action 一致。 */
const ACTION_LABELS: Record<string, string> = {
  audit: '审核',
  unaudit: '取消审核',
  reverse: '红冲',
  transfer: '转单',
};

/** 单据类型字典：值为各业务表名。 */
const ENTITY_LABELS: Record<string, string> = {
  purchase_order: '采购订单',
  purchase_inbound: '采购入库单',
  sales_order: '销售订单',
  sales_outbound: '销售出库单',
  stock_transfer: '库存调拨单',
  stock_check: '库存盘点单',
  ar_receipt: '收款单',
  ap_payment: '付款单',
};

const rows = ref<OpLogRow[]>([]);
const loading = ref(false);
const filters = reactive<{
  keyword: string;
  action: string;
  entity: string;
  dateRange: [Date, Date] | null;
}>({ keyword: '', action: '', entity: '', dateRange: null });

// ---------------- 详情 ----------------
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<OpLogDetail | null>(null);

const beforeText = computed(() => prettyJson(detail.value?.before_json ?? null));
const afterText = computed(() => prettyJson(detail.value?.after_json ?? null));

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function entityLabel(entity: string): string {
  return ENTITY_LABELS[entity] ?? entity;
}

function actionTagType(action: string): 'primary' | 'info' | 'warning' | 'danger' {
  if (action === 'audit') return 'primary';
  if (action === 'unaudit') return 'warning';
  if (action === 'reverse') return 'danger';
  return 'info';
}

function formatTime(value: unknown): string {
  const n = Number(value);
  return n && Number.isFinite(n) ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function prettyJson(raw: string | null): string {
  if (!raw) return '（无）';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const filter: OpLogFilter = {};
    const key = filters.keyword.trim();
    if (key) filter.keyword = key;
    if (filters.action) filter.action = filters.action;
    if (filters.entity) filter.entity = filters.entity;
    if (filters.dateRange && filters.dateRange.length === 2) {
      filter.startDate = filters.dateRange[0].getTime();
      filter.endDate = filters.dateRange[1].getTime() + 86_399_999;
    }
    rows.value = await api().opLog.list(filter);
  } catch (err) {
    rows.value = [];
    ElMessage.error(message(err));
  } finally {
    loading.value = false;
  }
}

function resetSearch(): void {
  filters.keyword = '';
  filters.action = '';
  filters.entity = '';
  filters.dateRange = null;
  void load();
}

async function openDetail(row: OpLogRow): Promise<void> {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await api().opLog.get(row.id);
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    detailLoading.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div>
    <el-card class="card-gap">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="关键字">
          <el-input
            v-model="filters.keyword"
            placeholder="操作人 / 账号 / 单据 ID"
            clearable
            style="width: 220px"
            @keyup.enter="load"
          />
        </el-form-item>
        <el-form-item label="动作">
          <el-select v-model="filters.action" clearable placeholder="全部" style="width: 140px" value-on-clear="">
            <el-option
              v-for="(label, value) in ACTION_LABELS"
              :key="value"
              :label="label"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="单据类型">
          <el-select v-model="filters.entity" clearable placeholder="全部" style="width: 150px" value-on-clear="">
            <el-option
              v-for="(label, value) in ENTITY_LABELS"
              :key="value"
              :label="label"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="操作时间">
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
      <el-table
        v-loading="loading"
        :data="rows"
        empty-text="暂无操作日志"
        border
        stripe
        @row-click="openDetail"
      >
        <el-table-column label="操作时间" width="180">
          <template #default="{ row }">{{ formatTime(row.at) }}</template>
        </el-table-column>
        <el-table-column label="操作人" width="150">
          <template #default="{ row }">{{ row.user_name || row.account || row.user_id || '-' }}</template>
        </el-table-column>
        <el-table-column label="动作" width="110">
          <template #default="{ row }">
            <el-tag :type="actionTagType(row.action)" size="small">{{ actionLabel(row.action) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="单据类型" width="140">
          <template #default="{ row }">{{ entityLabel(row.entity) }}</template>
        </el-table-column>
        <el-table-column prop="entity_id" label="单据 ID" min-width="220" show-overflow-tooltip />
        <el-table-column label="设备" width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.device_id || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="openDetail(row)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-drawer v-model="detailVisible" title="操作日志详情" size="52%">
      <div v-loading="detailLoading">
        <el-descriptions v-if="detail" :column="2" border size="small">
          <el-descriptions-item label="操作时间">{{ formatTime(detail.at) }}</el-descriptions-item>
          <el-descriptions-item label="操作人">
            {{ detail.user_name || detail.account || detail.user_id || '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="动作">{{ actionLabel(detail.action) }}</el-descriptions-item>
          <el-descriptions-item label="单据类型">{{ entityLabel(detail.entity) }}</el-descriptions-item>
          <el-descriptions-item label="单据 ID" :span="2">{{ detail.entity_id }}</el-descriptions-item>
          <el-descriptions-item label="设备" :span="2">{{ detail.device_id || '-' }}</el-descriptions-item>
        </el-descriptions>

        <div v-if="detail" class="oplog-diff">
          <div class="oplog-diff__col">
            <div class="oplog-diff__title">变更前</div>
            <pre class="oplog-diff__pre">{{ beforeText }}</pre>
          </div>
          <div class="oplog-diff__col">
            <div class="oplog-diff__title">变更后</div>
            <pre class="oplog-diff__pre">{{ afterText }}</pre>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.oplog-diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 16px;
}

.oplog-diff__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 6px;
}

.oplog-diff__pre {
  margin: 0;
  padding: 12px;
  max-height: 56vh;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
}

@media (max-width: 900px) {
  .oplog-diff {
    grid-template-columns: 1fr;
  }
}
</style>
