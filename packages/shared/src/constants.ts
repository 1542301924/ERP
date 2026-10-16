/**
 * 单据状态 / 同步状态 / 库存业务类型等枚举（对应设计文档 §5.0 / §5.2）。
 */

/** 单据状态机：0 待审核 → 1 已审核 → 9 已红冲（只有 1 成立生效）。 */
export const DocStatus = {
  PENDING_AUDIT: 0,
  AUDITED: 1,
  REVERSED: 9,
} as const;
export type DocStatusValue = (typeof DocStatus)[keyof typeof DocStatus];

/** 行同步状态。 */
export const SyncState = {
  LOCAL_PENDING: 0,
  SYNCED: 1,
  CONFLICT: 2,
} as const;
export type SyncStateValue = (typeof SyncState)[keyof typeof SyncState];

/** 库存流水业务类型（stock_ledger.biz_type）。 */
export const InventoryBizType = {
  OPENING: '期初',
  PURCHASE_IN: '采购入库',
  SALES_OUT: '销售出库',
  DEPT_USE: '部门领用',
  PRODUCTION_IN: '生产入库',
  RETURN_IN: '退货入库',
  RETURN_OUT: '退货出库',
  TRANSFER: '调拨',
  STOCK_CHECK: '盘点',
  REVERSAL: '红冲',
} as const;
export type InventoryBizTypeValue = (typeof InventoryBizType)[keyof typeof InventoryBizType];

/** 入库单类型（purchase_inbound.inbound_type）。 */
export const InboundType = {
  PURCHASE: '采购',
  DEPT_USE: '部门领用',
  PRODUCTION: '生产入库',
  RETURN: '退货入库',
} as const;
export type InboundTypeValue = (typeof InboundType)[keyof typeof InboundType];

/** 出库单类型（sales_outbound.outbound_type）。 */
export const OutboundType = {
  SALES: '销售',
  RETURN: '退货出库',
} as const;
export type OutboundTypeValue = (typeof OutboundType)[keyof typeof OutboundType];

/** 变更日志操作类型（_change_log.op）。 */
export const ChangeOp = {
  INSERT: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
} as const;
export type ChangeOpValue = (typeof ChangeOp)[keyof typeof ChangeOp];

/** sys_config 关键配置键与默认值。 */
export const SysConfigKey = {
  SCHEMA_VERSION: 'schema_version',
  DEVICE_ID: 'device_id',
  ALLOW_NEGATIVE_STOCK: 'allow_negative_stock',
  BACKUP_KEEP: 'backup_keep',
  LAN_PORT: 'lan_port',
  THEME: 'theme',
} as const;

export const SysConfigDefault: Record<string, string> = {
  [SysConfigKey.ALLOW_NEGATIVE_STOCK]: '0', // 0=禁止负库存（默认），1=允许
  [SysConfigKey.BACKUP_KEEP]: '7',
  [SysConfigKey.LAN_PORT]: '8765',
};
