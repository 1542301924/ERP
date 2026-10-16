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

declare global {
  interface Window {
    api?: WindowApi;
  }
}
