<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../composables/useCrud';
import type { DocKind, DocListRow, StockAlertRow, SyncState } from '../../../env';

const router = useRouter();

/** 单据类型元信息：标题、菜单路径、出入方向。 */
const DOC_META: Record<DocKind, { label: string; path: string; direction: 'in' | 'out' }> = {
  purchase_inbound: { label: '采购入库单', path: '/purchase/inbound', direction: 'in' },
  purchase_order: { label: '采购订单', path: '/purchase/orders', direction: 'in' },
  sales_outbound: { label: '销售出库单', path: '/sales/outbound', direction: 'out' },
  sales_order: { label: '销售订单', path: '/sales/orders', direction: 'out' },
};

/** 状态文案。 */
const STATUS_LABEL: Record<number, string> = { 0: '待审核', 1: '已审核', 9: '已红冲' };
const STATUS_TAG: Record<number, 'warning' | 'success' | 'info'> = { 0: 'warning', 1: 'success', 9: 'info' };

/** 今日单据行（跨类型合并）。 */
interface TodayDoc {
  kind: DocKind;
  doc_no: string | null;
  partner_name: string | null;
  warehouse_name: string | null;
  total_amount: number;
  biz_date: number | null;
  status: number;
}

const loading = ref(false);
const error = ref<string | null>(null);
const updatedAt = ref<number | null>(null);

const inbound = ref({ count: 0, amount: 0 });
const outbound = ref({ count: 0, amount: 0 });
const pendingByKind = ref<{ kind: DocKind; count: number }[]>([]);
const todayDocs = ref<TodayDoc[]>([]);
const alerts = ref<StockAlertRow[]>([]);
const ar = ref({ total: 0, count: 0 });
const ap = ref({ total: 0, count: 0 });
const sync = ref<SyncState | null>(null);
const syncing = ref(false);

const pendingTotal = computed(() => pendingByKind.value.reduce((sum, row) => sum + row.count, 0));
const pendingText = computed(() =>
  pendingByKind.value
    .filter((row) => row.count > 0)
    .map((row) => `${DOC_META[row.kind].label.replace('单', '')} ${row.count}`)
    .join(' · '),
);
const lowAlertCount = computed(() => alerts.value.filter((row) => row.level === 'low').length);
const syncInfo = computed(() => sync.value?.status ?? null);
const hasSyncTodo = computed(() => Boolean(syncInfo.value && (syncInfo.value.pendingCount > 0 || syncInfo.value.conflictCount > 0)));

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function money(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function qty(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toFixed(4)));
}

function dayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDate(ms: number | null): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(ms: number | null): string {
  if (!ms) return '从未同步';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toTodayDoc(kind: DocKind, row: DocListRow): TodayDoc {
  return {
    kind,
    doc_no: (row.doc_no as string | null) ?? null,
    partner_name: row.partner_name ?? null,
    warehouse_name: row.warehouse_name ?? null,
    total_amount: Number(row.total_amount ?? 0),
    biz_date: row.biz_date == null ? null : Number(row.biz_date),
    status: Number(row.status ?? 0),
  };
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const today = { startDate: dayStart(), endDate: dayStart() + 86_399_999 };
    const [
      inboundList,
      orderList,
      outboundList,
      salesOrderList,
      pendingInbound,
      pendingOrder,
      pendingOutbound,
      pendingSalesOrder,
      alertList,
      arList,
      apList,
      syncState,
    ] = await Promise.all([
      api().doc.list('purchase_inbound', today),
      api().doc.list('purchase_order', today),
      api().doc.list('sales_outbound', today),
      api().doc.list('sales_order', today),
      api().doc.list('purchase_inbound', { status: 0 }),
      api().doc.list('purchase_order', { status: 0 }),
      api().doc.list('sales_outbound', { status: 0 }),
      api().doc.list('sales_order', { status: 0 }),
      api().stock.alert(),
      api().finance.listBills('ar', { onlyOutstanding: true }),
      api().finance.listBills('ap', { onlyOutstanding: true }),
      api().sync.state(),
    ]);

    const inDocs = (inboundList ?? []).map((row) => toTodayDoc('purchase_inbound', row));
    const outDocs = (outboundList ?? []).map((row) => toTodayDoc('sales_outbound', row));
    inbound.value = { count: inDocs.length, amount: inDocs.reduce((sum, row) => sum + row.total_amount, 0) };
    outbound.value = { count: outDocs.length, amount: outDocs.reduce((sum, row) => sum + row.total_amount, 0) };

    todayDocs.value = [
      ...inDocs,
      ...outDocs,
      ...(orderList ?? []).map((row) => toTodayDoc('purchase_order', row)),
      ...(salesOrderList ?? []).map((row) => toTodayDoc('sales_order', row)),
    ]
      .sort((a, b) => (b.biz_date ?? 0) - (a.biz_date ?? 0))
      .slice(0, 10);

    pendingByKind.value = [
      { kind: 'purchase_inbound', count: (pendingInbound ?? []).length },
      { kind: 'purchase_order', count: (pendingOrder ?? []).length },
      { kind: 'sales_outbound', count: (pendingOutbound ?? []).length },
      { kind: 'sales_order', count: (pendingSalesOrder ?? []).length },
    ];
    alerts.value = (alertList ?? []).filter((row) => row.level === 'low');
    ar.value = { total: (arList ?? []).reduce((sum, row) => sum + Number(row.remaining ?? 0), 0), count: (arList ?? []).length };
    ap.value = { total: (apList ?? []).reduce((sum, row) => sum + Number(row.remaining ?? 0), 0), count: (apList ?? []).length };
    sync.value = syncState;
    updatedAt.value = Date.now();
  } catch (err) {
    error.value = message(err);
  } finally {
    loading.value = false;
  }
}

async function syncNow(): Promise<void> {
  syncing.value = true;
  try {
    const result = await api().sync.now();
    if (result.ok) {
      ElMessage.success(`同步完成：推送 ${result.pushed} · 拉取 ${result.pulled} · 冲突 ${result.conflicts}`);
    } else {
      ElMessage.error(result.error ?? '同步失败');
    }
    await load();
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    syncing.value = false;
  }
}

function go(path: string): void {
  void router.push(path);
}

/** 打开今日单据所在列表页。 */
function openDoc(row: TodayDoc): void {
  go(DOC_META[row.kind].path);
}

/** 表格插槽内 row 为无类型值，这里做一次收束取元信息。 */
function docMeta(kind: unknown): { label: string; path: string; direction: 'in' | 'out' } {
  return DOC_META[kind as DocKind] ?? { label: String(kind ?? '-'), path: '/sales/outbound', direction: 'out' };
}

/** 打开库存预警页。 */
function openAlerts(): void {
  go('/stock/alerts');
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <el-alert v-if="error" class="card-gap" type="error" :title="error" :closable="false" />

    <el-alert
      v-if="hasSyncTodo"
      class="card-gap"
      type="warning"
      :closable="false"
      show-icon
      :title="`待同步 ${syncInfo?.pendingCount ?? 0} 条${syncInfo && syncInfo.conflictCount > 0 ? `，冲突 ${syncInfo.conflictCount} 条待裁决` : ''}`"
    >
      <template #default>
        <div class="sync-bar">
          <span>上次同步：{{ formatTime(syncInfo?.lastSyncAt ?? null) }}</span>
          <span>
            <el-button size="small" type="primary" :loading="syncing" @click="syncNow">立即同步</el-button>
            <el-button size="small" @click="go('/system/sync')">同步中心</el-button>
          </span>
        </div>
      </template>
    </el-alert>

    <!-- 今日概览：单一平面承载全部指标，用发丝分隔线替代卡片矩阵 -->
    <el-card class="card-gap overview">
      <div class="overview-head">
        <div>
          <div class="ov-title">你好，今天 {{ formatDate(Date.now()) }}</div>
          <div class="ov-sub">数据更新于 {{ updatedAt ? formatTime(updatedAt) : '-' }}</div>
        </div>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>

      <div class="kpi-row">
        <div class="kpi-group">
          <div class="kpi is-link" @click="go('/purchase/inbound')">
            <div class="kpi-label">今日入库</div>
            <div class="kpi-value">{{ inbound.count }}<span class="unit">单</span></div>
            <div class="kpi-extra">金额 ¥{{ money(inbound.amount) }}</div>
          </div>
          <div class="kpi is-link" @click="go('/sales/outbound')">
            <div class="kpi-label">今日出库</div>
            <div class="kpi-value">{{ outbound.count }}<span class="unit">单</span></div>
            <div class="kpi-extra">金额 ¥{{ money(outbound.amount) }}</div>
          </div>
        </div>

        <div class="kpi-group secondary">
          <div class="kpi">
            <div class="kpi-label">待审核单据</div>
            <div class="kpi-value">{{ pendingTotal }}<span class="unit">单</span></div>
            <div class="kpi-extra">{{ pendingText || '暂无待审核' }}</div>
          </div>
          <div class="kpi is-link" @click="go('/stock/alerts')">
            <div class="kpi-label">库存预警</div>
            <div class="kpi-value">{{ alerts.length }}<span class="unit">项</span></div>
            <div class="kpi-extra">低于下限 {{ lowAlertCount }} 项</div>
          </div>
          <div class="kpi is-link" @click="go('/finance/receivable')">
            <div class="kpi-label">应收未结清</div>
            <div class="kpi-value">¥{{ money(ar.total) }}</div>
            <div class="kpi-extra">{{ ar.count }} 张单据未结清</div>
          </div>
          <div class="kpi is-link" @click="go('/finance/payable')">
            <div class="kpi-label">应付未结清</div>
            <div class="kpi-value">¥{{ money(ap.total) }}</div>
            <div class="kpi-extra">{{ ap.count }} 张单据未结清</div>
          </div>
        </div>
      </div>
    </el-card>

    <el-card class="card-gap">
      <template #header>
        <div class="card-head">
          <span>今日单据</span>
          <el-button link type="primary" @click="go('/sales/outbound')">进入销售出库</el-button>
        </div>
      </template>
      <el-table :data="todayDocs" empty-text="今日暂无单据" @row-click="openDoc">
        <el-table-column label="类型" width="130">
          <template #default="{ row }">
            <el-tag :type="docMeta(row.kind).direction === 'in' ? 'success' : 'primary'" size="small">
              {{ docMeta(row.kind).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="doc_no" label="单据编号" width="170">
          <template #default="{ row }"><span class="num">{{ row.doc_no }}</span></template>
        </el-table-column>
        <el-table-column label="往来单位" min-width="150">
          <template #default="{ row }">{{ row.partner_name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="仓库" min-width="120">
          <template #default="{ row }">{{ row.warehouse_name ?? '-' }}</template>
        </el-table-column>
        <el-table-column label="金额" width="130" align="right">
          <template #default="{ row }"><span class="num">¥{{ money(row.total_amount) }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="STATUS_TAG[row.status] ?? 'info'" size="small">
              {{ STATUS_LABEL[row.status] ?? row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="业务日期" width="130">
          <template #default="{ row }">{{ formatDate(row.biz_date) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-row :gutter="16">
      <el-col :xs="24" :md="14">
        <el-card>
          <template #header>
            <div class="card-head">
              <span>库存预警（低于下限）</span>
              <el-button link type="primary" @click="go('/stock/alerts')">查看全部</el-button>
            </div>
          </template>
          <el-table :data="alerts.slice(0, 5)" empty-text="库存充足，暂无预警" @row-click="openAlerts">
            <el-table-column prop="product_code" label="商品编号" width="120" />
            <el-table-column prop="product_name" label="商品名称" min-width="140" />
            <el-table-column label="单位" width="64">
              <template #default="{ row }">{{ row.unit_name ?? '-' }}</template>
            </el-table-column>
            <el-table-column label="当前库存" width="100" align="right">
              <template #default="{ row }"><span class="num">{{ qty(row.total_qty) }}</span></template>
            </el-table-column>
            <el-table-column label="下限" width="80" align="right">
              <template #default="{ row }">{{ row.min_stock ?? '-' }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="10">
        <el-card>
          <template #header>快捷入口</template>
          <div class="shortcuts">
            <el-button @click="go('/purchase/inbound')">采购入库</el-button>
            <el-button @click="go('/sales/outbound')">销售出库</el-button>
            <el-button @click="go('/stock/realtime')">实时库存</el-button>
            <el-button @click="go('/stock/alerts')">库存预警</el-button>
            <el-button @click="go('/finance/receivable')">应收管理</el-button>
            <el-button @click="go('/finance/payable')">应付管理</el-button>
            <el-button @click="go('/reports/summary')">进销存汇总</el-button>
            <el-button @click="go('/system/sync')">同步中心</el-button>
          </div>
          <div v-if="syncInfo" class="sync-note">
            本机标识：{{ syncInfo.deviceId }} · 待同步 {{ syncInfo.pendingCount }} · 冲突
            {{ syncInfo.conflictCount }} · 上次同步 {{ formatTime(syncInfo.lastSyncAt) }}
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 概览卡：头部信息 + 指标带 */
.overview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.ov-title {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--text);
}

.ov-sub {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-3);
}

.kpi-row {
  display: flex;
  flex-wrap: wrap;
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
}

.kpi-group {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  min-width: 0;
}

.kpi {
  flex: 1 1 150px;
  min-width: 0;
  padding: 2px 20px;
  border-left: 1px solid var(--border);
  border-radius: 0;
}

/* 首列不画分隔线，作为整条指标带的起点 */
.kpi-row > .kpi-group:first-child > .kpi:first-child {
  border-left: none;
  padding-left: 0;
}

.kpi.is-link {
  cursor: pointer;
  transition: background-color var(--transition);
}

.kpi.is-link:hover {
  background: var(--surface-2);
}

.kpi.is-link:hover .kpi-value {
  color: var(--brand);
}

.kpi .kpi-value {
  margin: 4px 0 2px;
  transition: color var(--transition);
}

.kpi-group.secondary .kpi-value {
  font-size: 20px;
}

.unit {
  margin-left: 3px;
  font-size: 12.5px;
  font-weight: 400;
  color: var(--text-3);
}

.sync-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 13px;
}

.shortcuts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.shortcuts :deep(.el-button + .el-button) {
  margin-left: 0;
}

.sync-note {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 1200px) {
  .kpi-group {
    flex: 1 1 100%;
  }

  .kpi-group + .kpi-group .kpi:first-child {
    border-left: none;
    padding-left: 0;
  }

  .kpi-group + .kpi-group {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
}
</style>
