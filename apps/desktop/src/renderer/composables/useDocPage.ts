import { reactive, ref, type Ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from './useCrud';

/** P2 单据类型（对应 window.api.doc 的 kind）。 */
export type DocKind = 'purchase_order' | 'purchase_inbound' | 'sales_order' | 'sales_outbound';

/** 单据列表行（仅声明页面直接使用的公共列，其余由 Record 兜底）。 */
export interface DocListRow {
  id?: string;
  doc_no?: string;
  doc_type?: string | null;
  partner_name?: string | null;
  warehouse_name?: string | null;
  biz_date?: number | null;
  status?: number;
  total_amount?: number;
  handler_id?: string | null;
  handler_name?: string | null;
  remark?: string | null;
  [key: string]: unknown;
}

/** 列表筛选条件。 */
export interface DocFilters {
  keyword: string;
  status: number | '';
  docType: string;
  dateRange: [Date, Date] | null;
}

const STATUS_LABEL: Record<number, string> = { 0: '待审核', 1: '已审核', 9: '已红冲' };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 单据列表页组合式函数：封装列表查询与审核 / 取消审核 / 红冲 / 转单等操作。
 * 仅依赖 window.api.doc，保持最小实现，供 7 个单据页面复用。
 */
export function useDocPage(kind: DocKind, defaultDocType = '') {
  const rows = ref<DocListRow[]>([]) as Ref<DocListRow[]>;
  const loading = ref(false);
  const filters = reactive<DocFilters>({
    keyword: '',
    status: '',
    docType: defaultDocType,
    dateRange: null,
  });

  /** 经手人 id -> 姓名，用于列表展示（列表行未返回 handler_name 时兜底）。 */
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
      const opts: {
        keyword?: string;
        status?: number;
        docType?: string;
        startDate?: number;
        endDate?: number;
      } = {};
      const key = filters.keyword.trim();
      if (key) opts.keyword = key;
      if (typeof filters.status === 'number') opts.status = filters.status;
      if (filters.docType) opts.docType = filters.docType;
      if (filters.dateRange && filters.dateRange.length === 2) {
        opts.startDate = filters.dateRange[0].getTime();
        opts.endDate = filters.dateRange[1].getTime() + 86_399_999;
      }
      const [list] = await Promise.all([api().doc.list(kind, opts), loadUsers()]);
      rows.value = (list ?? []) as DocListRow[];
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
    if (!(await confirmAction('确定审核该单据？审核后将写入库存流水。', '审核确认'))) return;
    try {
      await api().doc.audit(kind, id);
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
      await api().doc.unaudit(kind, id);
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
      const result = await api().doc.reverse(kind, id);
      const no = pickDocNo((result ?? {}) as Record<string, unknown>);
      ElMessage.success(no ? `红冲成功，生成单据：${no}` : '红冲成功');
    } catch (err) {
      ElMessage.error(message(err));
    } finally {
      await load();
    }
  }

  async function transfer(id: string): Promise<void> {
    if (!(await confirmAction('确定根据该订单生成对应单据？', '转单确认'))) return;
    try {
      const result = await api().doc.transfer(kind as 'purchase_order' | 'sales_order', id);
      const no = pickDocNo((result ?? {}) as Record<string, unknown>);
      ElMessage.success(no ? `转单成功，生成单据：${no}` : '转单成功');
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

  function handlerName(row: DocListRow): string {
    if (row.handler_name) return String(row.handler_name);
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

  /** 金额显示两位小数。 */
  function money(value: unknown): string {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
  }

  return {
    rows,
    loading,
    filters,
    load,
    audit,
    unaudit,
    reverse,
    transfer,
    statusLabel,
    statusTagType,
    handlerName,
    formatDate,
    money,
  };
}
