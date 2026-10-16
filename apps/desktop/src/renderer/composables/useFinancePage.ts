import { reactive, ref, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from './useCrud';
import type {
  BillFilter,
  BillKind,
  BillRow,
  SettleDocFilter,
  SettleDocKind,
  SettleDocRow,
  SettleState,
} from '../../../env';

export type { BillKind, BillRow, SettleDocKind, SettleDocRow };

/** 列表筛选条件（往来单与收付款单共用，按需取子集）。 */
export interface FinanceFilters {
  keyword: string;
  settleState: SettleState | '';
  status: number | '';
  dateRange: [Date, Date] | null;
}

const STATUS_LABEL: Record<number, string> = { 0: '待审核', 1: '已审核', 9: '已红冲' };
const SETTLE_STATE_LABEL: Record<SettleState, string> = {
  unsettled: '未结清',
  partial: '部分结清',
  settled: '已结清',
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dateRangeOpts(range: [Date, Date] | null): { startDate?: number; endDate?: number } {
  if (!range || range.length !== 2) return {};
  return { startDate: range[0].getTime(), endDate: range[1].getTime() + 86_399_999 };
}

/**
 * 财务列表页组合式函数：封装往来单（应收 / 应付）与收付款单的查询，
 * 以及收付款单的 审核 / 取消审核 / 红冲。仅依赖 window.api.finance。
 */
export function useFinancePage(billKind: BillKind, settleKind: SettleDocKind) {
  const bills = ref<BillRow[]>([]) as Ref<BillRow[]>;
  const settleRows = ref<SettleDocRow[]>([]) as Ref<SettleDocRow[]>;
  const loading = ref(false);
  const filters = reactive<FinanceFilters>({ keyword: '', settleState: '', status: '', dateRange: null });

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const key = filters.keyword.trim();
      const range = dateRangeOpts(filters.dateRange);

      const billOpts: BillFilter = {};
      if (key) billOpts.keyword = key;
      if (filters.settleState) billOpts.settleState = filters.settleState;
      Object.assign(billOpts, range);

      const settleOpts: SettleDocFilter = { ...range };
      if (key) settleOpts.keyword = key;
      if (typeof filters.status === 'number') settleOpts.status = filters.status;

      const [billList, settleList] = await Promise.all([
        api().finance.listBills(billKind, billOpts),
        api().finance.listSettle(settleKind, settleOpts),
      ]);
      bills.value = (billList ?? []) as BillRow[];
      settleRows.value = (settleList ?? []) as SettleDocRow[];
    } catch (err) {
      bills.value = [];
      settleRows.value = [];
      ElMessage.error(message(err));
    } finally {
      loading.value = false;
    }
  }

  async function confirmAction(text: string, title: string): Promise<boolean> {
    try {
      await ElMessageBox.confirm(text, title, { type: 'warning' });
      return true;
    } catch {
      return false;
    }
  }

  function pickDocNo(result: Record<string, unknown>): string {
    const inner = (result.doc ?? {}) as Record<string, unknown>;
    return String(result.doc_no ?? inner.doc_no ?? '');
  }

  async function audit(id: string): Promise<void> {
    if (!(await confirmAction('确定审核该收付款单？审核后核销生效并重算资金账户余额。', '审核确认'))) return;
    try {
      await api().finance.auditSettle(settleKind, id);
      ElMessage.success('审核成功');
    } catch (err) {
      ElMessage.error(message(err));
    } finally {
      await load();
    }
  }

  async function unaudit(id: string): Promise<void> {
    if (!(await confirmAction('确定取消审核该收付款单？核销将失效并重算余额。', '取消审核确认'))) return;
    try {
      await api().finance.unauditSettle(settleKind, id);
      ElMessage.success('取消审核成功');
    } catch (err) {
      ElMessage.error(message(err));
    } finally {
      await load();
    }
  }

  async function reverse(id: string): Promise<void> {
    if (!(await confirmAction('确定红冲该收付款单？将生成反向单据并回滚核销与账户余额。', '红冲确认'))) return;
    try {
      const result = await api().finance.reverseSettle(settleKind, id);
      const no = pickDocNo((result ?? {}) as Record<string, unknown>);
      ElMessage.success(no ? `红冲成功，生成单据：${no}` : '红冲成功');
    } catch (err) {
      ElMessage.error(message(err));
    } finally {
      await load();
    }
  }

  function statusLabel(status: unknown): string {
    const n = Number(status);
    return STATUS_LABEL[n] ?? (status === null || status === undefined ? '-' : String(status));
  }

  function statusTagType(status: unknown): 'warning' | 'success' | 'info' {
    const n = Number(status);
    if (n === 1) return 'success';
    if (n === 9) return 'info';
    return 'warning';
  }

  function settleStateLabel(state: unknown): string {
    return SETTLE_STATE_LABEL[state as SettleState] ?? '-';
  }

  function settleStateTagType(state: unknown): 'info' | 'warning' | 'success' {
    if (state === 'settled') return 'success';
    if (state === 'partial') return 'warning';
    return 'info';
  }

  /** ms 时间戳 -> YYYY-MM-DD。 */
  function formatDate(value: unknown): string {
    const n = Number(value);
    if (!n || !Number.isFinite(n)) return '-';
    const d = new Date(n);
    const pad = (x: number): string => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** 金额显示两位小数。 */
  function money(value: unknown): string {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
  }

  return {
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
  };
}
