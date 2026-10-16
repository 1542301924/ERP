import { reactive, ref, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from './useCrud';

/** P3 库存单据类型（对应 window.api.stockDoc 的 kind）。 */
export type StockDocKind = 'stock_transfer' | 'stock_check';

/** 单据列表行（仅声明页面直接使用的公共列，其余由 Record 兜底）。 */
export interface StockDocListRow {
  id?: string;
  doc_no?: string | null;
  from_warehouse_name?: string | null;
  to_warehouse_name?: string | null;
  warehouse_name?: string | null;
  biz_date?: number | null;
  status?: number;
  handler_id?: string | null;
  remark?: string | null;
  [key: string]: unknown;
}

/** 列表筛选条件。 */
export interface StockDocFilters {
  keyword: string;
  status: number | '';
  dateRange: [Date, Date] | null;
}

const STATUS_LABEL: Record<number, string> = { 0: '待审核', 1: '已审核', 9: '已红冲' };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 库存单据列表页组合式函数：封装列表查询与审核 / 取消审核 / 红冲。
 * 仅依赖 window.api.stockDoc，供「库存调拨」「库存盘点」两个页面复用。
 */
export function useStockDocPage(kind: StockDocKind) {
  const rows = ref<StockDocListRow[]>([]) as Ref<StockDocListRow[]>;
  const loading = ref(false);
  const filters = reactive<StockDocFilters>({ keyword: '', status: '', dateRange: null });

  /** 经手人 id -> 姓名，用于列表展示。 */
  const userMap = ref<Map<string, string>>(new Map());

  async function loadUsers(): Promise<void> {
    if (userMap.value.size) return;
    try {
      const users = await api().query('app_user');
      userMap.value = new Map(users.map((u) => [String(u.id), String(u.name ?? u.account ?? u.id)]));
    } catch {
      // 字典加载失败不阻断单据列表
    }
  }

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const opts: { keyword?: string; status?: number; startDate?: number; endDate?: number } = {};
      const key = filters.keyword.trim();
      if (key) opts.keyword = key;
      if (typeof filters.status === 'number') opts.status = filters.status;
      if (filters.dateRange && filters.dateRange.length === 2) {
        opts.startDate = filters.dateRange[0].getTime();
        opts.endDate = filters.dateRange[1].getTime() + 86_399_999;
      }
      const [list] = await Promise.all([api().stockDoc.list(kind, opts), loadUsers()]);
      rows.value = (list ?? []) as StockDocListRow[];
    } catch (err) {
      rows.value = [];
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

  /** 从返回结果中尽量取到生成单据编号（兼容 {doc_no} 与 {doc:{doc_no}} 两种形态）。 */
  function pickDocNo(result: Record<string, unknown>): string {
    const inner = (result.doc ?? {}) as Record<string, unknown>;
    return String(result.doc_no ?? inner.doc_no ?? '');
  }

  async function audit(id: string): Promise<void> {
    if (!(await confirmAction('确定审核该单据？审核后将写入库存流水并影响库存。', '审核确认'))) return;
    try {
      await api().stockDoc.audit(kind, id);
      ElMessage.success('审核成功');
    } catch (err) {
      ElMessage.error(message(err));
    } finally {
      await load();
    }
  }

  async function unaudit(id: string): Promise<void> {
    if (!(await confirmAction('确定取消审核该单据？', '取消审核确认'))) return;
    try {
      await api().stockDoc.unaudit(kind, id);
      ElMessage.success('取消审核成功');
    } catch (err) {
      ElMessage.error(message(err));
    } finally {
      await load();
    }
  }

  async function reverse(id: string): Promise<void> {
    if (!(await confirmAction('确定红冲该单据？红冲将生成反向单据并回滚库存。', '红冲确认'))) return;
    try {
      const result = await api().stockDoc.reverse(kind, id);
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

  function handlerName(row: StockDocListRow): string {
    const id = row.handler_id ? String(row.handler_id) : '';
    return id ? userMap.value.get(id) ?? id : '-';
  }

  /** ms 时间戳 -> YYYY-MM-DD。 */
  function formatDate(value: unknown): string {
    const n = Number(value);
    if (!n || !Number.isFinite(n)) return '-';
    const d = new Date(n);
    const pad = (x: number): string => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  return {
    rows,
    loading,
    filters,
    load,
    audit,
    unaudit,
    reverse,
    statusLabel,
    statusTagType,
    handlerName,
    formatDate,
  };
}
