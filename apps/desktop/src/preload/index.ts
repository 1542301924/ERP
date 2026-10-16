/**
 * preload：向渲染进程暴露受限的 `window.api`（contextBridge）。
 */

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  /** 查询业务表（默认排除软删除行） */
  query: (entity: string, opts?: { includeDeleted?: boolean; limit?: number }) =>
    ipcRenderer.invoke('db:query', entity, opts),
  /** 统一写入口：insert / update / delete */
  mutate: (req: { op: 'insert' | 'update' | 'delete'; entity: string; values?: unknown; id?: string; patch?: unknown }) =>
    ipcRenderer.invoke('db:mutate', req),
  /** 读取系统配置（不传 key 返回全部） */
  getConfig: (key?: string) => ipcRenderer.invoke('config:get', key),

  // ---------------- 主数据 ----------------
  /** 条件查询（关键字 / 等值 / 分页） */
  search: (
    entity: string,
    query?: {
      keyword?: string;
      fields?: string[];
      equals?: Record<string, string | number | null>;
      limit?: number;
      includeDeleted?: boolean;
    },
  ) => ipcRenderer.invoke('md:search', entity, query),
  /** 按 id 取一行 */
  getById: (entity: string, id: string) => ipcRenderer.invoke('md:getById', entity, id),
  /** 商品详情：商品 + 单位 + 条码 */
  productDetail: (id: string) => ipcRenderer.invoke('md:productDetail', id),
  /** 条码查询 */
  lookupBarcode: (barcode: string) => ipcRenderer.invoke('md:lookupBarcode', barcode),
  /** 保存商品单位（按 product_id + unit_id upsert） */
  saveProductUnit: (input: {
    id?: string;
    product_id: string;
    unit_id: string;
    factor: number;
    is_base?: number;
    barcode?: string | null;
    purchase_price?: number | null;
    sale_price?: number | null;
  }) => ipcRenderer.invoke('md:saveProductUnit', input),
  /** 删除商品单位 */
  deleteProductUnit: (id: string) => ipcRenderer.invoke('md:deleteProductUnit', id),
  /** 分类树 */
  categoryTree: (opts?: { includeDisabled?: boolean }) => ipcRenderer.invoke('md:categoryTree', opts),
  /** 保存分类（维护物料化路径） */
  saveCategory: (input: {
    id?: string;
    parent_id?: string | null;
    code?: string | null;
    name: string;
    sort?: number;
    status?: number;
  }) => ipcRenderer.invoke('md:saveCategory', input),
  /** 删除分类 */
  deleteCategory: (id: string) => ipcRenderer.invoke('md:deleteCategory', id),
  /** 生成下一个编号 */
  nextCode: (target: string) => ipcRenderer.invoke('code:next', target),

  // ---------------- 单据（出入库） ----------------
  doc: {
    /** 单据列表（可按关键字 / 状态 / 类型 / 日期区间过滤） */
    list: (kind: string, filter?: unknown) => ipcRenderer.invoke('doc:list', kind, filter),
    /** 单据详情：表头 + 明细 + 往来单 */
    get: (kind: string, id: string) => ipcRenderer.invoke('doc:get', kind, id),
    /** 保存单据（新建 / 修改草稿） */
    save: (kind: string, input: unknown) => ipcRenderer.invoke('doc:save', kind, input),
    /** 审核单据 */
    audit: (kind: string, id: string) => ipcRenderer.invoke('doc:audit', kind, id),
    /** 取消审核 */
    unaudit: (kind: string, id: string) => ipcRenderer.invoke('doc:unaudit', kind, id),
    /** 红冲 */
    reverse: (kind: string, id: string) => ipcRenderer.invoke('doc:reverse', kind, id),
    /** 订单转出入库单 */
    transfer: (orderKind: string, orderId: string) => ipcRenderer.invoke('doc:transfer', orderKind, orderId),
  },

  // ---------------- 库存（P3） ----------------
  stock: {
    /** 重算库存余额（可按商品 / 仓库增量重算） */
    recompute: (filter?: { productId?: string; warehouseId?: string }) =>
      ipcRenderer.invoke('stock:recompute', filter),
    /** 实时库存查询 */
    balance: (filter?: unknown) => ipcRenderer.invoke('stock:balance', filter),
    /** 库存流水查询 */
    ledger: (filter?: unknown) => ipcRenderer.invoke('stock:ledger', filter),
    /** 库存预警列表 */
    alert: () => ipcRenderer.invoke('stock:alert'),
  },

  // ---------------- 库存单据（调拨 / 盘点） ----------------
  stockDoc: {
    /** 单据列表（可按关键字 / 状态 / 日期区间过滤） */
    list: (kind: string, filter?: unknown) => ipcRenderer.invoke('stock_doc:list', kind, filter),
    /** 单据详情：表头 + 明细 */
    get: (kind: string, id: string) => ipcRenderer.invoke('stock_doc:get', kind, id),
    /** 保存单据（新建 / 修改草稿） */
    save: (kind: string, input: unknown) => ipcRenderer.invoke('stock_doc:save', kind, input),
    /** 审核单据 */
    audit: (kind: string, id: string) => ipcRenderer.invoke('stock_doc:audit', kind, id),
    /** 取消审核 */
    unaudit: (kind: string, id: string) => ipcRenderer.invoke('stock_doc:unaudit', kind, id),
    /** 红冲 */
    reverse: (kind: string, id: string) => ipcRenderer.invoke('stock_doc:reverse', kind, id),
  },

  // ---------------- Excel ----------------
  excel: {
    /** 列出模板 */
    templates: () => ipcRenderer.invoke('excel:templates'),
    /** 下载模板到选定路径 */
    downloadTemplate: (id: string) => ipcRenderer.invoke('excel:downloadTemplate', id),
    /** 选择 Excel 文件 */
    pickFile: () => ipcRenderer.invoke('excel:pickFile'),
    /** 导入 */
    import: (id: string, filePath: string) => ipcRenderer.invoke('excel:import', id, filePath),
    /** 导出实体 */
    exportEntity: (entity: string) => ipcRenderer.invoke('excel:exportEntity', entity),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type PreloadApi = typeof api;
