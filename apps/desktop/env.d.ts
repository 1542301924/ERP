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

declare global {
  interface Window {
    api?: WindowApi;
  }
}
