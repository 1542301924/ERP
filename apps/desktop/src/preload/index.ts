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

  // ---------------- 财务（P4） ----------------
  finance: {
    /** 应收 / 应付单列表（含往来单位、来源单号、已收已付与未结清余额） */
    listBills: (kind: string, filter?: unknown) => ipcRenderer.invoke('finance:listBills', kind, filter),
    /** 某往来单位下「可核销」的往来单（未结清余额 > 0） */
    openBills: (kind: string, partnerId: string) => ipcRenderer.invoke('finance:openBills', kind, partnerId),
    /** 收款单 / 付款单列表 */
    listSettle: (kind: string, filter?: unknown) => ipcRenderer.invoke('finance:listSettle', kind, filter),
    /** 收付款单详情：表头 + 核销明细 */
    getSettle: (kind: string, id: string) => ipcRenderer.invoke('finance:getSettle', kind, id),
    /** 保存收付款单（新建 / 修改草稿） */
    saveSettle: (kind: string, input: unknown) => ipcRenderer.invoke('finance:saveSettle', kind, input),
    /** 审核收付款单（核销生效并重算账户余额） */
    auditSettle: (kind: string, id: string) => ipcRenderer.invoke('finance:auditSettle', kind, id),
    /** 取消审核 */
    unauditSettle: (kind: string, id: string) => ipcRenderer.invoke('finance:unauditSettle', kind, id),
    /** 红冲 */
    reverseSettle: (kind: string, id: string) => ipcRenderer.invoke('finance:reverseSettle', kind, id),
    /** 资金账户列表（含派生余额） */
    accounts: () => ipcRenderer.invoke('finance:accounts'),
    /** 资金账户流水（由已审核收付款单合并派生） */
    flow: (filter?: unknown) => ipcRenderer.invoke('finance:flow', filter),
    /** 全量重算资金账户余额（对账兜底），返回更新的账户数 */
    recomputeBalances: () => ipcRenderer.invoke('finance:recomputeBalances'),
  },

  // ---------------- 报表（P5） ----------------
  report: {
    /** 运行报表（返回列定义 + 数据行 + 合计行） */
    run: (kind: string, filter?: unknown) => ipcRenderer.invoke('report:run', kind, filter),
    /** 运行并导出为 Excel（弹出保存对话框） */
    export: (kind: string, filter?: unknown) => ipcRenderer.invoke('report:export', kind, filter),
  },

  // ---------------- 同步（P7） ----------------
  sync: {
    /** 同步中心状态：待同步 / 冲突 / 上次同步 + 配置 + 主节点服务状态 */
    state: () => ipcRenderer.invoke('sync:state'),
    /** 读取同步配置 */
    getConfig: () => ipcRenderer.invoke('sync:config:get'),
    /** 更新同步配置（角色 / 主节点地址 / 端口 / 间隔） */
    setConfig: (patch: unknown) => ipcRenderer.invoke('sync:config:set', patch),
    /** 立即同步一次（推 outbox + 拉增量） */
    now: () => ipcRenderer.invoke('sync:now'),
    /** 冲突列表（可按状态过滤） */
    conflicts: (opts?: { status?: number }) => ipcRenderer.invoke('sync:conflicts', opts),
    /** 人工裁决冲突（把裁决值写回实体） */
    resolve: (input: { id: string; resolvedValue: string | null }) => ipcRenderer.invoke('sync:resolve', input),
    /** 启动主节点 LAN 服务 */
    startServer: () => ipcRenderer.invoke('sync:server:start'),
    /** 停止主节点 LAN 服务 */
    stopServer: () => ipcRenderer.invoke('sync:server:stop'),
    /** 启动后台定时同步引擎（client 角色） */
    startEngine: () => ipcRenderer.invoke('sync:engine:start'),
    /** 停止后台定时同步引擎 */
    stopEngine: () => ipcRenderer.invoke('sync:engine:stop'),
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

  // ---------------- 备份 / 恢复（P8） ----------------
  backup: {
    /** 备份记录列表（按时间倒序） */
    list: () => ipcRenderer.invoke('backup:list'),
    /** 备份到默认备份目录（受保留份数管理） */
    create: () => ipcRenderer.invoke('backup:create'),
    /** 备份并另存到指定路径（弹出保存对话框） */
    export: () => ipcRenderer.invoke('backup:export'),
    /** 选择备份文件（用于恢复） */
    pickFile: () => ipcRenderer.invoke('backup:pickFile'),
    /** 删除备份记录（默认目录内的文件一并删除） */
    remove: (id: string) => ipcRenderer.invoke('backup:delete', id),
    /** 从备份文件恢复主库（成功后应用自动重启） */
    restore: (filePath: string) => ipcRenderer.invoke('backup:restore', filePath),
    /** 读取保留份数 */
    getKeep: () => ipcRenderer.invoke('backup:keep:get'),
    /** 设置保留份数 */
    setKeep: (keep: number) => ipcRenderer.invoke('backup:keep:set', keep),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type PreloadApi = typeof api;
