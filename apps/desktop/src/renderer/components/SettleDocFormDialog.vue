<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../composables/useCrud';
import type { SettleDocKind } from '../../../env';

interface DictItem {
  id: string;
  name: string;
}

interface ApplyRow {
  bill_id: string;
  source_doc_no: string | null;
  bill_date: number | null;
  bill_amount: number;
  settled: number;
  remaining: number;
  apply_amount: number;
}

interface HeaderForm {
  id: string;
  partner_id: string | null;
  account_id: string | null;
  amount: number;
  date: Date | null;
  method: string | null;
  remark: string | null;
}

const props = defineProps<{
  kind: SettleDocKind;
  modelValue: boolean;
  docId?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'saved'): void;
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

const isReceipt = computed(() => props.kind === 'ar_receipt');
const partnerLabel = computed(() => (isReceipt.value ? '客户' : '供应商'));
const partnerEntity = computed(() => (isReceipt.value ? 'customer' : 'supplier'));
const billKind = computed(() => (isReceipt.value ? 'ar' : 'ap'));

const METHODS = ['现金', '银行转账', '微信', '支付宝', '其他'];

const form = reactive<HeaderForm>({
  id: '',
  partner_id: null,
  account_id: null,
  amount: 0,
  date: null,
  method: null,
  remark: null,
});

const applies = ref<ApplyRow[]>([]);
const partners = ref<DictItem[]>([]);
const accounts = ref<DictItem[]>([]);
const readonly = ref(false);
const saving = ref(false);
const billLoading = ref(false);

const title = computed(() => {
  const name = isReceipt.value ? '收款单' : '付款单';
  return readonly.value ? `查看${name}` : form.id ? `编辑${name}` : `新增${name}`;
});

const appliedTotal = computed(() => applies.value.reduce((sum, row) => sum + num(row.apply_amount), 0));
const unapplied = computed(() => round2(num(form.amount) - appliedTotal.value));

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

async function loadDicts(): Promise<void> {
  try {
    const a = api();
    const [list, acc] = await Promise.all([a.query(partnerEntity.value), a.finance.accounts()]);
    partners.value = list.map((r) => ({ id: String(r.id), name: String(r.name ?? r.id) }));
    accounts.value = acc.map((r) => ({ id: String(r.id), name: String(r.name ?? r.id) }));
  } catch (err) {
    ElMessage.error(message(err));
  }
}

/** 拉取该往来单位下未结清的往来单，作为可核销明细行。 */
async function loadOpenBills(partnerId: string): Promise<void> {
  billLoading.value = true;
  try {
    const list = await api().finance.openBills(billKind.value, partnerId);
    applies.value = list.map((bill) => ({
      bill_id: bill.id,
      source_doc_no: bill.source_doc_no,
      bill_date: bill.created_at,
      bill_amount: num(bill.amount),
      settled: num(bill.settled_amount),
      remaining: num(bill.remaining),
      apply_amount: 0,
    }));
  } catch (err) {
    applies.value = [];
    ElMessage.error(message(err));
  } finally {
    billLoading.value = false;
  }
}

/** 编辑 / 查看时把已存在的核销明细回填到明细行。 */
function mergeApplies(existing: Array<{ bill_id: string | null; bill_amount: number; bill_settled: number; bill_source_doc_no: string | null; bill_created_at: number | null; amount: number }>): void {
  for (const item of existing) {
    const billId = item.bill_id ? String(item.bill_id) : '';
    if (!billId) continue;
    const row = applies.value.find((r) => r.bill_id === billId);
    if (row) {
      row.apply_amount = num(item.amount);
      continue;
    }
    // 该往来单已结清、不在未结清列表中，仍按已核销事实补一行
    applies.value.push({
      bill_id: billId,
      source_doc_no: item.bill_source_doc_no,
      bill_date: item.bill_created_at,
      bill_amount: num(item.bill_amount),
      settled: num(item.bill_settled),
      remaining: round2(num(item.bill_amount) - num(item.bill_settled)),
      apply_amount: num(item.amount),
    });
  }
}

async function loadDoc(id: string): Promise<void> {
  try {
    const res = await api().finance.getSettle(props.kind, id);
    if (!res) {
      ElMessage.error('未找到单据');
      visible.value = false;
      return;
    }
    const doc = res.doc;
    Object.assign(form, {
      id: String(doc.id ?? ''),
      partner_id: text(doc[isReceipt.value ? 'customer_id' : 'supplier_id']),
      account_id: text(doc.account_id),
      amount: num(doc.amount),
      date: doc[isReceipt.value ? 'receive_date' : 'pay_date']
        ? new Date(Number(doc[isReceipt.value ? 'receive_date' : 'pay_date']))
        : new Date(),
      method: text(doc.method),
      remark: text(doc.remark),
    });
    readonly.value = Number(doc.status ?? 0) !== 0;
    if (form.partner_id) {
      await loadOpenBills(form.partner_id);
      mergeApplies(res.applies ?? []);
    } else {
      applies.value = [];
    }
  } catch (err) {
    ElMessage.error(message(err));
    visible.value = false;
  }
}

function resetDraft(): void {
  Object.assign(form, {
    id: '',
    partner_id: null,
    account_id: null,
    amount: 0,
    date: new Date(),
    method: null,
    remark: null,
  });
  readonly.value = false;
  applies.value = [];
}

async function onPartnerChange(): Promise<void> {
  if (!form.partner_id) {
    applies.value = [];
    return;
  }
  await loadOpenBills(form.partner_id);
}

/** 按单据金额从最早未结清单开始自动核销。 */
function autoAllocate(): void {
  let left = round2(num(form.amount));
  for (const row of applies.value) {
    if (left <= 0) {
      row.apply_amount = 0;
      continue;
    }
    const take = Math.min(row.remaining, left);
    row.apply_amount = round2(take);
    left = round2(left - take);
  }
}

function clearAllocate(): void {
  for (const row of applies.value) row.apply_amount = 0;
}

async function submit(): Promise<void> {
  if (readonly.value) return;
  if (!form.partner_id) {
    ElMessage.warning(`请选择${partnerLabel.value}`);
    return;
  }
  if (num(form.amount) <= 0) {
    ElMessage.warning('单据金额必须大于 0');
    return;
  }
  const payloadApplies = applies.value
    .filter((row) => num(row.apply_amount) > 0)
    .map((row) => ({ bill_id: row.bill_id, amount: round2(num(row.apply_amount)) }));
  if (round2(payloadApplies.reduce((sum, row) => sum + row.amount, 0)) > round2(num(form.amount)) + 0.000001) {
    ElMessage.warning('核销金额合计不能超过单据金额');
    return;
  }
  saving.value = true;
  try {
    await api().finance.saveSettle(props.kind, {
      id: form.id || undefined,
      partner_id: form.partner_id,
      account_id: form.account_id,
      amount: round2(num(form.amount)),
      date: form.date ? form.date.getTime() : Date.now(),
      method: form.method,
      remark: form.remark,
      applies: payloadApplies,
    });
    ElMessage.success('保存成功');
    emit('saved');
    visible.value = false;
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    saving.value = false;
  }
}

function formatDate(value: unknown): string {
  const n = Number(value);
  if (!n || !Number.isFinite(n)) return '-';
  const d = new Date(n);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function money(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    await loadDicts();
    resetDraft();
    if (props.docId) await loadDoc(props.docId);
  },
);
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="title"
    width="960px"
    top="6vh"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <el-form :model="form" label-width="90px" :disabled="readonly">
      <el-row :gutter="12">
        <el-col :span="8">
          <el-form-item :label="partnerLabel">
            <el-select
              v-model="form.partner_id"
              filterable
              clearable
              :placeholder="`请选择${partnerLabel}`"
              style="width: 100%"
              @change="onPartnerChange"
            >
              <el-option v-for="p in partners" :key="p.id" :label="p.name" :value="p.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="资金账户">
            <el-select v-model="form.account_id" filterable clearable placeholder="请选择资金账户" style="width: 100%">
              <el-option v-for="a in accounts" :key="a.id" :label="a.name" :value="a.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="单据金额">
            <el-input-number
              v-model="form.amount"
              :min="0"
              :precision="2"
              :step="100"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item :label="isReceipt ? '收款日期' : '付款日期'">
            <el-date-picker v-model="form.date" type="date" placeholder="选择日期" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="结算方式">
            <el-select v-model="form.method" filterable allow-create clearable placeholder="请选择" style="width: 100%">
              <el-option v-for="m in METHODS" :key="m" :label="m" :value="m" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="24">
          <el-form-item label="备注">
            <el-input v-model="form.remark" type="textarea" :rows="2" />
          </el-form-item>
        </el-col>
      </el-row>

      <div class="detail-head">
        <span class="detail-title">核销明细（未结清{{ isReceipt ? '应收' : '应付' }}单）</span>
        <template v-if="!readonly">
          <el-button size="small" @click="autoAllocate">按金额自动核销</el-button>
          <el-button size="small" @click="clearAllocate">清空</el-button>
        </template>
        <span class="summary">
          已核销合计 <b>{{ money(appliedTotal) }}</b> ／ 单据金额 <b>{{ money(form.amount) }}</b>
          <span :class="unapplied < 0 ? 'over' : ''">（未核销 {{ money(unapplied) }}）</span>
        </span>
      </div>

      <el-table v-loading="billLoading" :data="applies" size="small" border empty-text="该往来单位暂无未结清单据" style="width: 100%">
        <el-table-column label="来源单号" min-width="150">
          <template #default="{ row }">{{ row.source_doc_no || '-' }}</template>
        </el-table-column>
        <el-table-column label="单据日期" width="120">
          <template #default="{ row }">{{ formatDate(row.bill_date) }}</template>
        </el-table-column>
        <el-table-column label="单据金额" width="120" align="right">
          <template #default="{ row }">{{ money(row.bill_amount) }}</template>
        </el-table-column>
        <el-table-column label="已核销" width="120" align="right">
          <template #default="{ row }">{{ money(row.settled) }}</template>
        </el-table-column>
        <el-table-column label="未结清" width="120" align="right">
          <template #default="{ row }">{{ money(row.remaining) }}</template>
        </el-table-column>
        <el-table-column label="本次核销" width="150">
          <template #default="{ row }">
            <el-input-number
              v-model="row.apply_amount"
              :min="0"
              :max="Math.max(row.remaining, 0)"
              :precision="2"
              size="small"
              controls-position="right"
              style="width: 100%"
              :disabled="readonly"
            />
          </template>
        </el-table-column>
      </el-table>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">{{ readonly ? '关闭' : '取消' }}</el-button>
      <el-button v-if="!readonly" type="primary" :loading="saving" @click="submit">保存草稿</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 10px;
  flex-wrap: wrap;
}
.detail-title {
  font-weight: 600;
  margin-right: 6px;
}
.summary {
  margin-left: auto;
  color: #606266;
  font-size: 13px;
}
.summary .over {
  color: #f56c6c;
}
</style>
