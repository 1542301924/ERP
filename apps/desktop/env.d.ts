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

declare global {
  interface Window {
    api?: WindowApi;
  }
}
