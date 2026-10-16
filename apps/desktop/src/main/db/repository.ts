/**
 * 统一写入口：insert / update / softDelete。
 *
 * 规则（设计文档 §4.1 / §4.2 / 计划 §2）：
 *  - 自动填充 id(ULID) / created_by / created_at / updated_by / updated_at / version /
 *    origin_device / hlc / dirty_fields / sync_state / deleted。
 *  - 每次写业务表**必须在同一事务内**追加一条 `_change_log`（pushed=0）。
 *  - update 时 version+1，dirty_fields 记录本次变更字段名单。
 */

import {
  newId,
  serializeHlc,
  stringifyDirtyFields,
  parseDirtyFields,
  ChangeOp,
  SyncState,
  SYNC_FIELD_NAMES,
  type HlcClock,
  type Row,
} from '@inventory/shared';
import type { SqlDatabase } from './sqlite';

/** 携带同步字段的业务表（可走统一写入口）。 */
export const SYNC_ENTITIES = new Set<string>([
  // §5.1 主数据
  'unit',
  'product_unit',
  'product_category',
  'product',
  'product_barcode',
  'warehouse',
  'location',
  'customer',
  'supplier',
  'department',
  'app_user',
  'role',
  'role_permission',
  'code_rule',
  // §5.2 流水
  'stock_ledger',
  // §5.3 采购
  'purchase_order',
  'purchase_order_item',
  'purchase_inbound',
  'purchase_inbound_item',
  // §5.4 销售
  'sales_order',
  'sales_order_item',
  'sales_outbound',
  'sales_outbound_item',
  // §5.5 调拨 / 盘点
  'stock_transfer',
  'stock_transfer_item',
  'stock_check',
  'stock_check_item',
  // §5.6 财务
  'account',
  'ap_bill',
  'ap_payment',
  'ap_payment_apply',
  'ar_bill',
  'ar_receipt',
  'ar_receipt_apply',
]);

/** append-only（只允许 insert，禁止 update / softDelete）的实体：单据、单据明细、库存流水。 */
export const APPEND_ONLY_ENTITIES = new Set<string>([
  'stock_ledger',
  'purchase_order',
  'purchase_order_item',
  'purchase_inbound',
  'purchase_inbound_item',
  'sales_order',
  'sales_order_item',
  'sales_outbound',
  'sales_outbound_item',
  'stock_transfer',
  'stock_transfer_item',
  'stock_check',
  'stock_check_item',
  'ap_payment',
  'ap_payment_apply',
  'ar_receipt',
  'ar_receipt_apply',
]);

/** 写入上下文：当前用户、设备 ID、HLC 时钟。 */
export interface WriteContext {
  userId: string;
  deviceId: string;
  clock: HlcClock;
}

const SYNC_FIELD_SET = new Set<string>(SYNC_FIELD_NAMES as readonly string[]);

export class Repository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly ctx: WriteContext,
    private readonly now: () => number = Date.now,
  ) {}

  /** 新增一行并追加变更日志。 */
  insert(entity: string, values: Row, id?: string): Row {
    this.assertEntity(entity);
    const row: Row = {
      ...values,
      id: id ?? (values.id as string | undefined) ?? newId(),
      created_by: this.ctx.userId,
      created_at: this.now(),
      updated_by: null,
      updated_at: null,
      version: 1,
      origin_device: this.ctx.deviceId,
      hlc: serializeHlc(this.ctx.clock.tick()),
      dirty_fields: null,
      sync_state: SyncState.LOCAL_PENDING,
      deleted: 0,
    };

    this.db.transaction(() => {
      this.insertRow(entity, row);
      this.appendChangeLog(entity, row.id as string, ChangeOp.INSERT, row);
    });
    return row;
  }

  /** 修改一行：version+1，记录 dirty_fields，追加变更日志。 */
  update(entity: string, id: string, patch: Row): Row {
    this.assertEntity(entity);
    this.assertMutable(entity, 'update');

    const current = this.findById(entity, id);
    if (!current) throw new Error(`${entity} 中不存在 id=${id}`);

    const changedFields: string[] = [];
    const cleanPatch: Row = {};
    for (const [key, value] of Object.entries(patch)) {
      if (SYNC_FIELD_SET.has(key)) continue; // 同步字段由写入口托管
      cleanPatch[key] = value;
      changedFields.push(key);
    }

    const row: Row = {
      ...current,
      ...cleanPatch,
      updated_by: this.ctx.userId,
      updated_at: this.now(),
      version: Number(current.version ?? 1) + 1,
      hlc: serializeHlc(this.ctx.clock.tick()),
      dirty_fields: stringifyDirtyFields(changedFields),
      sync_state: SyncState.LOCAL_PENDING,
    };

    this.db.transaction(() => {
      this.updateRow(entity, row);
      this.appendChangeLog(entity, id, ChangeOp.UPDATE, row);
    });
    return row;
  }

  /** 软删除：置 deleted=1，version+1，追加变更日志。 */
  softDelete(entity: string, id: string): Row {
    this.assertEntity(entity);
    this.assertMutable(entity, 'delete');

    const current = this.findById(entity, id);
    if (!current) throw new Error(`${entity} 中不存在 id=${id}`);

    const row: Row = {
      ...current,
      updated_by: this.ctx.userId,
      updated_at: this.now(),
      version: Number(current.version ?? 1) + 1,
      hlc: serializeHlc(this.ctx.clock.tick()),
      dirty_fields: stringifyDirtyFields(['deleted']),
      sync_state: SyncState.LOCAL_PENDING,
      deleted: 1,
    };

    this.db.transaction(() => {
      this.updateRow(entity, row);
      this.appendChangeLog(entity, id, ChangeOp.DELETE, row);
    });
    return row;
  }

  /** 按 id 取一行。 */
  findById(entity: string, id: string): Row | null {
    this.assertEntity(entity);
    const row = this.db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(id);
    return row ?? null;
  }

  /** 列表查询（默认排除已软删除行）。 */
  list(entity: string, opts: { includeDeleted?: boolean; limit?: number } = {}): Row[] {
    this.assertEntity(entity);
    const where = opts.includeDeleted ? '' : 'WHERE deleted = 0';
    const limit = opts.limit ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '';
    return this.db.prepare(`SELECT * FROM ${entity} ${where}${limit}`).all();
  }

  // ---------------- 内部实现 ----------------

  private insertRow(entity: string, row: Row): void {
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    this.db
      .prepare(`INSERT INTO ${entity} (${cols.join(', ')}) VALUES (${placeholders})`)
      .run(...cols.map((c) => row[c] as never));
  }

  private updateRow(entity: string, row: Row): void {
    const cols = Object.keys(row).filter((c) => c !== 'id');
    const assignments = cols.map((c) => `${c} = ?`).join(', ');
    this.db
      .prepare(`UPDATE ${entity} SET ${assignments} WHERE id = ?`)
      .run(...cols.map((c) => row[c] as never), row.id as never);
  }

  /** 同一事务内追加一条 _change_log。 */
  private appendChangeLog(entity: string, entityId: string, op: string, row: Row): void {
    const seq = this.nextSeq();
    this.db
      .prepare(
        'INSERT INTO _change_log (log_id, seq, device_id, entity, entity_id, op, payload, hlc, created_at, pushed) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
      )
      .run(
        newId(),
        seq,
        this.ctx.deviceId,
        entity,
        entityId,
        op,
        JSON.stringify(row),
        String(row.hlc ?? ''),
        this.now(),
      );
  }

  private nextSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM _change_log').get();
    return Number(row?.next ?? 1);
  }

  private assertEntity(entity: string): void {
    if (!SYNC_ENTITIES.has(entity)) {
      throw new Error(`未知实体（不在携带同步字段的业务表内）: ${entity}`);
    }
  }

  private assertMutable(entity: string, action: string): void {
    if (APPEND_ONLY_ENTITIES.has(entity)) {
      throw new Error(`${entity} 为 append-only（单据/流水），禁止 ${action}`);
    }
  }
}

// 便于测试/复用：暴露解析工具
export { parseDirtyFields, stringifyDirtyFields };
