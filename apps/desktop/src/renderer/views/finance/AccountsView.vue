<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../composables/useCrud';
import type { AccountFlowFilter, AccountFlowRow } from '../../../../env';

interface AccountItem {
  id: string;
  name: string;
  balance: number;
}

const accounts = ref<AccountItem[]>([]);
const flowRows = ref<AccountFlowRow[]>([]);
const loading = ref(false);
const recomputing = ref(false);

const filters = reactive<{
  accountId: string;
  direction: 'in' | 'out' | '';
  dateRange: [Date, Date] | null;
}>({ accountId: '', direction: '', dateRange: null });

const STATUS_LABEL: Record<number, string> = { 0: '待审核', 1: '已审核', 9: '已红冲' };

const totalBalance = computed(() => accounts.value.reduce((sum, a) => sum + Number(a.balance || 0), 0));

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function statusLabel(status: unknown): string {
  const n = Number(status);
  return STATUS_LABEL[n] ?? '-';
}

async function loadAccounts(): Promise<void> {
  try {
    const list = await api().finance.accounts();
    accounts.value = list.map((r) => ({
      id: String(r.id),
      name: String(r.name ?? r.id),
      balance: Number(r.balance ?? 0),
    }));
  } catch (err) {
    accounts.value = [];
    ElMessage.error(message(err));
  }
}

async function loadFlow(): Promise<void> {
  loading.value = true;
  try {
    const filter: AccountFlowFilter = {};
    if (filters.accountId) filter.accountId = filters.accountId;
    if (filters.direction) filter.direction = filters.direction;
    if (filters.dateRange && filters.dateRange.length === 2) {
      filter.startDate = filters.dateRange[0].getTime();
      filter.endDate = filters.dateRange[1].getTime() + 86_399_999;
    }
    flowRows.value = await api().finance.flow(filter);
  } catch (err) {
    flowRows.value = [];
    ElMessage.error(message(err));
  } finally {
    loading.value = false;
  }
}

async function loadAll(): Promise<void> {
  await Promise.all([loadAccounts(), loadFlow()]);
}

function resetSearch(): void {
  filters.accountId = '';
  filters.direction = '';
  filters.dateRange = null;
  void loadFlow();
}

async function recompute(): Promise<void> {
  try {
    await ElMessageBox.confirm('将按「已审核收款单 − 已审核付款单」全量重算所有资金账户余额，确定继续？', '余额重算', {
      type: 'warning',
    });
  } catch {
    return;
  }
  recomputing.value = true;
  try {
    const res = await api().finance.recomputeBalances();
    ElMessage.success(`重算完成，更新 ${res.rows} 个账户余额`);
    await loadAll();
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    recomputing.value = false;
  }
}

onMounted(loadAll);
</script>

<template>
  <div>
    <el-card class="card-gap">
      <template #header>
        <div class="head">
          <span>资金账户余额（合计 {{ money(totalBalance) }}）</span>
          <el-button :loading="recomputing" size="small" @click="recompute">全量重算</el-button>
        </div>
      </template>
      <el-table :data="accounts" empty-text="暂无资金账户" border stripe>
        <el-table-column prop="name" label="账户名称" min-width="200" />
        <el-table-column label="余额" width="160" align="right">
          <template #default="{ row }">{{ money(row.balance) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card>
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="资金账户">
          <el-select v-model="filters.accountId" clearable placeholder="全部" style="width: 180px" value-on-clear="">
            <el-option v-for="a in accounts" :key="a.id" :label="a.name" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="方向">
          <el-select v-model="filters.direction" clearable placeholder="全部" style="width: 130px" value-on-clear="">
            <el-option label="收入（收款）" value="in" />
            <el-option label="支出（付款）" value="out" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker
            v-model="filters.dateRange"
            type="daterange"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            style="width: 260px"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="loadFlow">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table v-loading="loading" :data="flowRows" empty-text="暂无资金流水" border stripe>
        <el-table-column label="业务日期" width="120">
          <template #default="{ row }">{{ formatDate(row.date) }}</template>
        </el-table-column>
        <el-table-column prop="account_name" label="资金账户" min-width="160">
          <template #default="{ row }">{{ row.account_name || '-' }}</template>
        </el-table-column>
        <el-table-column label="方向" width="110">
          <template #default="{ row }">
            <el-tag :type="row.direction === 'in' ? 'success' : 'warning'">
              {{ row.direction === 'in' ? '收入' : '支出' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="doc_no" label="单据编号" width="160">
          <template #default="{ row }">{{ row.doc_no || '-' }}</template>
        </el-table-column>
        <el-table-column prop="partner_name" label="往来单位" min-width="150">
          <template #default="{ row }">{{ row.partner_name || '-' }}</template>
        </el-table-column>
        <el-table-column label="金额" width="140" align="right">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">{{ statusLabel(row.status) }}</template>
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
</style>
