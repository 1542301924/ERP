/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

export interface WindowApi {
  query(
    entity: string,
    opts?: { includeDeleted?: boolean; limit?: number },
  ): Promise<Record<string, unknown>[]>;
  mutate(req: {
    op: 'insert' | 'update' | 'delete';
    entity: string;
    values?: Record<string, unknown>;
    id?: string;
    patch?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  getConfig(key?: string): Promise<Record<string, string> | string | null>;

  // ---------------- 主数据 ----------------
  search(
    entity: string,
    query?: {
      keyword?: string;
      fields?: string[];
      equals?: Record<string, string | number | null>;
      limit?: number;
      includeDeleted?: boolean;
    },
  ): Promise<Record<string, unknown>[]>;
  getById(entity: string, id: string): Promise<Record<string, unknown> | null>;
  productDetail(id: string): Promise<ProductDetail | null>;
  lookupBarcode(barcode: string): Promise<LookupBarcodeResult | null>;
  saveProductUnit(input: {
    id?: string;
    product_id: string;
    unit_id: string;
    factor: number;
    is_base?: number;
    barcode?: string | null;
    purchase_price?: number | null;
    sale_price?: number | null;
  }): Promise<Record<string, unknown>>;
  deleteProductUnit(id: string): Promise<Record<string, unknown>>;
  categoryTree(opts?: { includeDisabled?: boolean }): Promise<CategoryNode[]>;
  saveCategory(input: {
    id?: string;
    parent_id?: string | null;
    code?: string | null;
    name: string;
    sort?: number;
    status?: number;
  }): Promise<Record<string, unknown>>;
  deleteCategory(id: string): Promise<Record<string, unknown>>;
  nextCode(target: string): Promise<string>;

  // ---------------- 单据（出入库） ----------------
  doc: {
    /** 单据列表（可按关键字 / 状态 / 类型 / 日期区间过滤） */
    list(kind: DocKind, filter?: DocFilter): Promise<DocListRow[]>;
    /** 单据详情：表头 + 明细 + 往来单；不存在时为 null */
    get(kind: DocKind, id: string): Promise<DocGetResult | null>;
    /** 保存单据（新建 / 修改草稿），返回表头行（含 doc_no、status） */
    save(kind: DocKind, input: DocSaveInput): Promise<Record<string, unknown>>;
    /** 审核单据，返回审核后的表头行 */
    audit(kind: DocKind, id: string): Promise<Record<string, unknown>>;
    /** 取消审核，返回回到草稿的表头行 */
    unaudit(kind: DocKind, id: string): Promise<Record<string, unknown>>;
    /** 红冲，返回原单（已置 9）与反向单 id */
    reverse(kind: DocKind, id: string): Promise<{ doc: Record<string, unknown>; reversalDocId: string }>;
    /** 订单转出入库单，返回新建的草稿出入库单 */
    transfer(orderKind: 'purchase_order' | 'sales_order', orderId: string): Promise<Record<string, unknown>>;
  };

  // ---------------- 库存（P3） ----------------
  stock: {
    /** 重算库存余额（可按商品 / 仓库增量重算），返回写入的余额行数 */
    recompute(filter?: { productId?: string; warehouseId?: string }): Promise<{ rows: number }>;
    /** 实时库存查询 */
    balance(filter?: StockBalanceFilter): Promise<StockBalanceRow[]>;
    /** 库存流水查询 */
    ledger(filter?: StockLedgerFilter): Promise<StockLedgerRow[]>;
    /** 库存预警列表 */
    alert(): Promise<StockAlertRow[]>;
  };

  // ---------------- 库存单据（调拨 / 盘点） ----------------
  stockDoc: {
    /** 单据列表（可按关键字 / 状态 / 日期区间过滤） */
    list(kind: StockDocKind, filter?: StockDocFilter): Promise<Record<string, unknown>[]>;
    /** 单据详情：表头 + 明细；不存在时为 null */
    get(kind: StockDocKind, id: string): Promise<StockDocGetResult | null>;
    /** 保存单据（新建 / 修改草稿），返回表头行（含 doc_no、status） */
    save(kind: StockDocKind, input: StockDocSaveInput): Promise<Record<string, unknown>>;
    /** 审核单据，返回审核后的表头行 */
    audit(kind: StockDocKind, id: string): Promise<Record<string, unknown>>;
    /** 取消审核，返回回到草稿的表头行 */
    unaudit(kind: StockDocKind, id: string): Promise<Record<string, unknown>>;
    /** 红冲，返回原单（已置 9）与反向单 id */
    reverse(kind: StockDocKind, id: string): Promise<{ doc: Record<string, unknown>; reversalDocId: string }>;
  };

  // ---------------- 财务（P4） ----------------
  finance: {
    /** 应收 / 应付单列表 */
    listBills(kind: BillKind, filter?: BillFilter): Promise<BillRow[]>;
    /** 某往来单位下「可核销」的往来单（未结清余额 > 0） */
    openBills(kind: BillKind, partnerId: string): Promise<BillRow[]>;
    /** 收款单 / 付款单列表 */
    listSettle(kind: SettleDocKind, filter?: SettleDocFilter): Promise<SettleDocRow[]>;
    /** 收付款单详情：表头 + 核销明细；不存在时为 null */
    getSettle(kind: SettleDocKind, id: string): Promise<SettleDocGetResult | null>;
    /** 保存收付款单（新建 / 修改草稿） */
    saveSettle(kind: SettleDocKind, input: SettleDocSaveInput): Promise<Record<string, unknown>>;
    /** 审核收付款单 */
    auditSettle(kind: SettleDocKind, id: string): Promise<Record<string, unknown>>;
    /** 取消审核 */
    unauditSettle(kind: SettleDocKind, id: string): Promise<Record<string, unknown>>;
    /** 红冲，返回原单（已置 9）与反向单 id */
    reverseSettle(kind: SettleDocKind, id: string): Promise<{ doc: Record<string, unknown>; reversalDocId: string }>;
    /** 资金账户列表（含派生余额） */
    accounts(): Promise<Record<string, unknown>[]>;
    /** 资金账户流水 */
    flow(filter?: AccountFlowFilter): Promise<AccountFlowRow[]>;
    /** 全量重算资金账户余额，返回更新的账户数 */
    recomputeBalances(): Promise<{ rows: number }>;
  };

  // ---------------- 报表（P5） ----------------
  report: {
    /** 运行报表（返回列定义 + 数据行 + 合计行） */
    run(kind: ReportKind, filter?: ReportFilter): Promise<ReportResult>;
    /** 运行并导出为 Excel（弹出保存对话框） */
    export(
      kind: ReportKind,
      filter?: ReportFilter,
    ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  };

  // ---------------- 同步（P7） ----------------
  sync: {
    /** 同步中心状态：待同步 / 冲突 / 上次同步 + 配置 + 主节点服务状态 */
    state(): Promise<SyncState>;
    /** 读取同步配置 */
    getConfig(): Promise<SyncConfigShape>;
    /** 更新同步配置（角色 / 主节点地址 / 端口 / 间隔） */
    setConfig(patch: Partial<SyncConfigShape>): Promise<SyncConfigShape>;
    /** 立即同步一次（推 outbox + 拉增量） */
    now(): Promise<SyncResultShape>;
    /** 冲突列表（可按状态过滤） */
    conflicts(opts?: { status?: number }): Promise<SyncConflictRow[]>;
    /** 人工裁决冲突（把裁决值写回实体） */
    resolve(input: { id: string; resolvedValue: string | null }): Promise<SyncConflictRow>;
    /** 启动主节点 LAN 服务 */
    startServer(): Promise<SyncServerInfo>;
    /** 停止主节点 LAN 服务 */
    stopServer(): Promise<SyncServerInfo>;
    /** 启动后台定时同步引擎（client 角色） */
    startEngine(): Promise<{ running: boolean }>;
    /** 停止后台定时同步引擎 */
    stopEngine(): Promise<{ running: boolean }>;
  };

  // ---------------- Excel ----------------
  excel: {
    templates(): Promise<{ id: string; name: string; importable: boolean }[]>;
    downloadTemplate(id: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
    pickFile(): Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
    import(id: string, filePath: string): Promise<ImportResult>;
    exportEntity(entity: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  };
}

/** 分类树节点。 */
export type CategoryNode = Record<string, unknown> & { children: CategoryNode[] };

/** 商品详情。 */
export interface ProductDetail {
  product: Record<string, unknown>;
  units: Record<string, unknown>[];
  barcodes: Record<string, unknown>[];
}

/** 条码查询结果。 */
export interface LookupBarcodeResult {
  product: Record<string, unknown>;
  matchedBy: 'product' | 'product_unit' | 'product_barcode';
  unit?: Record<string, unknown>;
}

/** Excel 导入结果（`row` 为物理 Excel 行号，表头为第 1 行）。 */
export interface ImportResult {
  template: string;
  total: number;
  success: number;
  failed: number;
  errors: { row: number; message: string; data?: Record<string, unknown> }[];
}

// ---------------- 单据（出入库） ----------------

/** 单据类型。 */
export type DocKind = 'purchase_order' | 'purchase_inbound' | 'sales_order' | 'sales_outbound';

/** 单据列表过滤条件（日期为闭区间）。 */
export interface DocFilter {
  keyword?: string;
  status?: number;
  docType?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 单据列表行：单据 + 派生展示字段。 */
export type DocListRow = Record<string, unknown> & {
  doc_type: string | null;
  partner_name: string | null;
  warehouse_name: string | null;
};

/** 保存单据入参。 */
export interface DocSaveInput {
  id?: string;
  docType?: string;
  supplier_id?: string | null;
  customer_id?: string | null;
  warehouse_id?: string | null;
  department_id?: string | null;
  receiver_id?: string | null;
  use_purpose?: string | null;
  biz_date?: number;
  handler_id?: string | null;
  remark?: string | null;
  items: Array<{
    product_id: string;
    unit_id?: string | null;
    factor?: number;
    qty: number;
    price: number;
    location_id?: string | null;
    remark?: string | null;
  }>;
}

/** 单据详情。 */
export interface DocGetResult {
  doc: Record<string, unknown>;
  items: Record<string, unknown>[];
  bills: { ap_bill: Record<string, unknown> | null; ar_bill: Record<string, unknown> | null };
}

// ---------------- 库存（P3） ----------------

/** 实时库存查询过滤条件。 */
export interface StockBalanceFilter {
  keyword?: string;
  productId?: string;
  warehouseId?: string;
  locationId?: string;
  includeZero?: boolean;
}

/** 实时库存行（余额 + 主数据名称）。 */
export interface StockBalanceRow {
  id: string;
  product_id: string;
  product_code: string | null;
  product_name: string | null;
  unit_id: string | null;
  unit_name: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
  location_id: string | null;
  location_name: string | null;
  qty: number;
  locked_qty: number;
  avail_qty: number;
  cost_amount: number;
  avg_cost: number;
  min_stock: number | null;
  max_stock: number | null;
}

/** 库存流水查询过滤条件（日期为闭区间）。 */
export interface StockLedgerFilter {
  keyword?: string;
  productId?: string;
  warehouseId?: string;
  bizType?: string;
  docId?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 库存流水行（流水 + 主数据名称）。 */
export interface StockLedgerRow {
  id: string;
  biz_type: string;
  doc_type: string | null;
  doc_id: string | null;
  doc_no: string | null;
  product_id: string;
  product_code: string | null;
  product_name: string | null;
  unit_name: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
  location_id: string | null;
  location_name: string | null;
  qty_in: number;
  qty_out: number;
  unit_cost: number;
  amount: number;
  biz_date: number;
  operator_id: string | null;
  reversal_of: string | null;
  remark: string | null;
}

/** 库存预警行（按商品跨仓库汇总）。 */
export interface StockAlertRow {
  product_id: string;
  product_code: string | null;
  product_name: string | null;
  unit_name: string | null;
  total_qty: number;
  min_stock: number | null;
  max_stock: number | null;
  level: 'low' | 'high';
}

// ---------------- 库存单据（调拨 / 盘点） ----------------

/** 库存单据类型。 */
export type StockDocKind = 'stock_transfer' | 'stock_check';

/** 库存单据列表过滤条件（日期为闭区间）。 */
export interface StockDocFilter {
  keyword?: string;
  status?: number;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 库存单据保存入参。 */
export interface StockDocSaveInput {
  id?: string;
  from_warehouse_id?: string | null;
  to_warehouse_id?: string | null;
  warehouse_id?: string | null;
  biz_date?: number;
  handler_id?: string | null;
  remark?: string | null;
  items: Array<{
    product_id: string;
    from_location_id?: string | null;
    to_location_id?: string | null;
    location_id?: string | null;
    unit_id?: string | null;
    factor?: number;
    qty: number;
  }>;
}

/** 库存单据详情。 */
export interface StockDocGetResult {
  doc: Record<string, unknown>;
  items: Record<string, unknown>[];
}

// ---------------- 财务（P4） ----------------

/** 往来单类型：应收 / 应付。 */
export type BillKind = 'ar' | 'ap';

/** 收付款单类型。 */
export type SettleDocKind = 'ar_receipt' | 'ap_payment';

/** 结清状态（由金额派生）。 */
export type SettleState = 'unsettled' | 'partial' | 'settled';

/** 往来单过滤条件。 */
export interface BillFilter {
  keyword?: string;
  partnerId?: string;
  settleState?: SettleState;
  onlyOutstanding?: boolean;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 往来单行（单据 + 派生展示字段 + 未结清余额）。 */
export interface BillRow {
  id: string;
  partner_id: string;
  partner_name: string | null;
  source_doc_no: string | null;
  amount: number;
  settled_amount: number;
  remaining: number;
  settle_state: SettleState;
  status: number;
  due_date: number | null;
  created_at: number;
}

/** 收付款单过滤条件。 */
export interface SettleDocFilter {
  keyword?: string;
  partnerId?: string;
  accountId?: string;
  status?: number;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 收付款单行。 */
export interface SettleDocRow {
  id: string;
  doc_no: string | null;
  partner_id: string | null;
  partner_name: string | null;
  account_id: string | null;
  account_name: string | null;
  amount: number;
  applied_amount: number;
  date: number | null;
  method: string | null;
  remark: string | null;
  status: number;
  reversal_of: string | null;
}

/** 核销明细行。 */
export interface SettleApplyRow {
  id: string;
  bill_id: string | null;
  bill_amount: number;
  bill_settled: number;
  bill_source_doc_no: string | null;
  bill_created_at: number | null;
  amount: number;
}

/** 收付款单详情。 */
export interface SettleDocGetResult {
  doc: Record<string, unknown>;
  applies: SettleApplyRow[];
}

/** 收付款单保存入参。 */
export interface SettleDocSaveInput {
  id?: string;
  partner_id?: string | null;
  account_id?: string | null;
  amount?: number;
  date?: number;
  method?: string | null;
  remark?: string | null;
  applies: Array<{ bill_id: string; amount: number }>;
}

/** 资金账户流水过滤条件。 */
export interface AccountFlowFilter {
  accountId?: string;
  direction?: 'in' | 'out';
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 资金账户流水行（由已审核收付款单派生）。 */
export interface AccountFlowRow {
  id: string;
  date: number | null;
  account_id: string | null;
  account_name: string | null;
  direction: 'in' | 'out';
  doc_no: string | null;
  partner_name: string | null;
  amount: number;
  status: number;
}

// ---------------- 报表（P5） ----------------

/** 报表类型。 */
export type ReportKind =
  | 'inventory_detail'
  | 'inventory_summary'
  | 'receipt_statement'
  | 'shipment_statement'
  | 'shipment_cost'
  | 'gross_profit';

/** 列数据类型（决定前端与 Excel 的格式化方式）。 */
export type ReportColumnType = 'text' | 'money' | 'qty' | 'percent' | 'date';

/** 统一报表过滤条件（各报表按需取用相关维度）。 */
export interface ReportFilter {
  keyword?: string;
  startDate?: number;
  endDate?: number;
  warehouseId?: string;
  productId?: string;
  customerId?: string;
  supplierId?: string;
  handlerId?: string;
  /** 汇总维度（进销存汇总表 / 销售毛利表使用）。 */
  groupBy?: 'product' | 'warehouse' | 'customer' | 'handler';
}

/** 报表列定义。 */
export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}

/** 报表结果：列定义 + 数据行 + 可选合计行。 */
export interface ReportResult {
  kind: ReportKind;
  title: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, number>;
}

// ---------------- 同步（P7） ----------------

/** 节点角色：standalone 单机不同步 / master 主节点 / client 客户端。 */
export type SyncRole = 'standalone' | 'master' | 'client';

/** 同步配置。 */
export interface SyncConfigShape {
  role: SyncRole;
  masterUrl: string;
  port: number;
  intervalMs: number;
}

/** 同步游标。 */
export interface SyncCursorShape {
  peerId: string;
  lastPullSeq: number;
  lastPushSeq: number;
  lastSyncAt: number | null;
  status: string | null;
}

/** 同步状态摘要。 */
export interface SyncStatusShape {
  deviceId: string;
  pendingCount: number;
  conflictCount: number;
  lastSyncAt: number | null;
  cursor: SyncCursorShape;
}

/** 主节点 LAN 服务信息。 */
export interface SyncServerInfo {
  running: boolean;
  port: number;
  url: string;
}

/** 同步中心整体状态。 */
export interface SyncState {
  status: SyncStatusShape;
  config: SyncConfigShape;
  engineRunning: boolean;
  server: SyncServerInfo;
}

/** 一次同步的结果。 */
export interface SyncResultShape {
  ok: boolean;
  pushed: number;
  pulled: number;
  conflicts: number;
  duplicate: number;
  nextSeq: number;
  error?: string;
}

/** 冲突记录行。 */
export interface SyncConflictRow {
  id: string;
  entity: string;
  entity_id: string;
  field: string;
  value_a: string | null;
  value_b: string | null;
  hlc_a: string;
  hlc_b: string;
  winner: string;
  resolved_value: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  status: number;
}

declare global {
  interface Window {
    api?: WindowApi;
  }
}
