<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import SettleDocFormDialog from '../../components/SettleDocFormDialog.vue';
import { useFinancePage, type BillRow, type SettleDocRow } from '../../composables/useFinancePage';
import type { BillKind, SettleDocKind } from '../../../../env';

const props = defineProps<{
  billKind: BillKind;
  settleKind: SettleDocKind;
}>();

const isReceipt = computed(() => props.settleKind === 'ar_receipt');
const partnerLabel = computed(() => (isReceipt.value ? '客户' : '供应商'));
const billTitle = computed(() => (isReceipt.value ? '应收单（来源销售出库）' : '应付单（来源采购入库）'));
const settleTitle = computed(() => (isReceipt.value ? '收款单' : '付款单'));
const settledLabel = computed(() => (isReceipt.value ? '已收款' : '已付款'));

const {
  bills,
  settleRows,
  loading,
  filters,
  load,
  audit,
  unaudit,
  reverse,
  statusLabel,
  statusTagType,
  settleStateLabel,
  settleStateTagType,
  formatDate,
  money,
} = useFinancePage(props.billKind, props.settleKind);

const dialogVisible = ref(false);
const dialogDocId = ref<string | undefined>(undefined);

function openCreate(): void {
  dialogDocId.value = undefined;
  dialogVisible.value = true;
}

function openEdit(row: SettleDocRow): void {
  dialogDocId.value = String(row.id ?? '');
  dialogVisible.value = true;
}

function resetSearch(): void {
  filters.keyword = '';
  filters.settleState = '';
  filters.status = '';
  filters.dateRange = null;
  void load();
}

function settledCss(row: BillRow): string {
  return Number(row.remaining) > 0.000001 ? 'amount-outstanding' : '';
}

onMounted(load);
</script>

<template>
  <div>
    <el-card class="card-gap">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="关键字">
          <el-input
            v-model="filters.keyword"
            :placeholder="`单号 / ${partnerLabel} / 备注`"
            clearable
            style="width: 220px"
            @keyup.enter="load"
          />
        </el-form-item>
        <el-form-item label="结清状态">
          <el-select
            v-model="filters.settleState"
            clearable
            placeholder="全部"
            style="width: 130px"
            value-on-clear=""
          >
            <el-option label="未结清" value="unsettled" />
            <el-option label="部分结清" value="partial" />
            <el-option label="已结清" value="settled" />
          </el-select>
        </el-form-item>
        <el-form-item label="单据状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 130px" value-on-clear="">
            <el-option label="待审核" :value="0" />
            <el-option label="已审核" :value="1" />
            <el-option label="已红冲" :value="9" />
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
          <el-button type="primary" @click="load">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="success" @click="openCreate">新增{{ settleTitle }}</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="card-gap">
      <template #header>
        <span>{{ billTitle }}</span>
      </template>
      <el-table v-loading="loading" :data="bills" empty-text="暂无往来单" border stripe>
        <el-table-column prop="source_doc_no" label="来源单号" width="170">
          <template #default="{ row }">{{ row.source_doc_no || '-' }}</template>
        </el-table-column>
        <el-table-column prop="partner_name" :label="partnerLabel" min-width="150">
          <template #default="{ row }">{{ row.partner_name || '-' }}</template>
        </el-table-column>
        <el-table-column label="单据金额" width="130" align="right">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
        <el-table-column :label="settledLabel" width="130" align="right">
          <template #default="{ row }">{{ money(row.settled_amount) }}</template>
        </el-table-column>
        <el-table-column label="未结清" width="130" align="right">
          <template #default="{ row }">
            <span :class="settledCss(row)">{{ money(row.remaining) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结清状态" width="110">
          <template #default="{ row }">
            <el-tag :type="settleStateTagType(row.settle_state)">{{ settleStateLabel(row.settle_state) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="单据日期" width="120">
          <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="到期日" width="120">
          <template #default="{ row }">{{ formatDate(row.due_date) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card>
      <template #header>
        <span>{{ settleTitle }}</span>
      </template>
      <el-table v-loading="loading" :data="settleRows" :empty-text="`暂无${settleTitle}`" border stripe>
        <el-table-column prop="doc_no" label="单据编号" width="160">
          <template #default="{ row }">
            {{ row.doc_no || '-' }}
            <el-tag v-if="row.reversal_of" size="small" type="info">红冲单</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="partner_name" :label="partnerLabel" min-width="150">
          <template #default="{ row }">{{ row.partner_name || '-' }}</template>
        </el-table-column>
        <el-table-column prop="account_name" label="资金账户" min-width="140">
          <template #default="{ row }">{{ row.account_name || '-' }}</template>
        </el-table-column>
        <el-table-column label="单据金额" width="130" align="right">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
        <el-table-column label="已核销" width="130" align="right">
          <template #default="{ row }">{{ money(row.applied_amount) }}</template>
        </el-table-column>
        <el-table-column :label="isReceipt ? '收款日期' : '付款日期'" width="120">
          <template #default="{ row }">{{ formatDate(row.date) }}</template>
        </el-table-column>
        <el-table-column prop="method" label="结算方式" width="110">
          <template #default="{ row }">{{ row.method || '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="120" />
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 0" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="row.status === 0" link type="success" size="small" @click="audit(String(row.id))">
              审核
            </el-button>
            <el-button v-if="row.status !== 0" link type="primary" size="small" @click="openEdit(row)">查看</el-button>
            <el-button v-if="row.status === 1" link type="warning" size="small" @click="unaudit(String(row.id))">
              取消审核
            </el-button>
            <el-button v-if="row.status === 1" link type="danger" size="small" @click="reverse(String(row.id))">
              红冲
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <SettleDocFormDialog
      v-model="dialogVisible"
      :kind="settleKind"
      :doc-id="dialogDocId"
      @saved="load"
    />
  </div>
</template>

<style scoped>
.amount-outstanding {
  color: #f56c6c;
  font-weight: 600;
}
</style>
