/**
 * 同步应用规则（设计文档 §4.1 / §4.4）。
 *
 * 三类实体：
 * 1. append-only（单据 / 单据明细 / stock_ledger）：只允许 insert，永不 LWW，直接插入。
 * 2. 主数据（商品/类别/单位/多单位/仓库/货位/客户/供应商/部门/用户/角色/权限/编码规则 等）：
 *    行级 HLC LWW + dirty_fields 字段级合并；同字段真冲突 → 返回冲突记录。
 * 3. 派生状态（stock_balance、ar_bill/ap_bill 余额）：不参与 apply，各端本地重算。
 */

import { compareHlc } from '../hlc';
import { parseDirtyFields, stringifyDirtyFields } from '../validation';

export type Row = Record<string, unknown>;

export interface IncomingChange {
  entity: string;
  entity_id: string;
  /** insert / update / delete */
  op: string;
  /** 变更后整行 JSON（含同步字段，其中 dirty_fields 描述本次远端修改的字段） */
  payload: Row | null;
  /** 该变更的 HLC */
  hlc: string;
}

export interface ConflictInfo {
  entity: string;
  entity_id: string;
  field: string;
  value_a: string | null;
  value_b: string | null;
  hlc_a: string;
  hlc_b: string;
  /** a=本地（localRow）胜，b=远端（incoming）胜 */
  winner: 'a' | 'b';
  status: number;
}

export type ApplyAction = 'insert' | 'update' | 'noop' | 'skip';

export interface ApplyResult {
  action: ApplyAction;
  /** 应写回本地的整行（noop/skip 时为原 localRow） */
  row: Row | null;
  conflicts: ConflictInfo[];
  /** 建议的 sync_state（0 本地待同步 / 1 已同步 / 2 冲突待处理） */
  syncState: number;
}

/** append-only 实体：仅 insert。 */
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

/** 主数据实体：走行级 HLC LWW + dirty_fields 字段级合并。 */
export const MASTER_DATA_ENTITIES = new Set<string>([
  'product',
  'product_category',
  'product_barcode',
  'unit',
  'product_unit',
  'warehouse',
  'location',
  'customer',
  'supplier',
  'department',
  'app_user',
  'role',
  'role_permission',
  'code_rule',
  'account',
]);

/** 派生状态：不参与 apply，各端本地重算。 */
export const DERIVED_ENTITIES = new Set<string>(['stock_balance', 'ar_bill', 'ap_bill']);

function norm(v: unknown): unknown {
  return v === undefined ? null : v;
}

function sameValue(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

function toText(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/**
 * 应用一条来自远端的变更。
 * @param localRow 本地当前行（不存在则为 null）
 * @param incoming 远端变更（含整行 payload 与 HLC）
 */
export function applyChange(localRow: Row | null, incoming: IncomingChange): ApplyResult {
  const { entity, entity_id } = incoming;
  const payload = incoming.payload;

  if (payload === null) {
    return { action: 'noop', row: localRow, conflicts: [], syncState: (localRow?.sync_state as number) ?? 0 };
  }

  // 1. append-only：只 insert
  if (APPEND_ONLY_ENTITIES.has(entity)) {
    if (localRow === null) {
      return { action: 'insert', row: payload, conflicts: [], syncState: 1 };
    }
    return { action: 'noop', row: localRow, conflicts: [], syncState: (localRow.sync_state as number) ?? 1 };
  }

  // 3. 派生状态：不 apply
  if (DERIVED_ENTITIES.has(entity)) {
    return { action: 'skip', row: localRow, conflicts: [], syncState: (localRow?.sync_state as number) ?? 0 };
  }

  // 2. 主数据：LWW + 字段级合并
  if (MASTER_DATA_ENTITIES.has(entity)) {
    if (localRow === null) {
      return { action: 'insert', row: payload, conflicts: [], syncState: 1 };
    }

    const remoteHlc = String(incoming.hlc || payload.hlc || '');
    const localHlc = String(localRow.hlc ?? '');
    const cmp = compareHlc(remoteHlc, localHlc);
    const remoteFields = parseDirtyFields(payload.dirty_fields);
    const localFields = parseDirtyFields(localRow.dirty_fields);

    const merged: Row = { ...localRow };
    const conflicts: ConflictInfo[] = [];
    const touched = new Set<string>();

    for (const field of remoteFields) {
      const localVal = localRow[field];
      const remoteVal = payload[field];
      const localTouched = localFields.includes(field);

      if (localTouched && !sameValue(localVal, remoteVal)) {
        // 同字段真冲突：HLC 晚者胜
        const winner: 'a' | 'b' = cmp >= 0 ? 'b' : 'a';
        merged[field] = winner === 'b' ? remoteVal : localVal;
        conflicts.push({
          entity,
          entity_id,
          field,
          value_a: toText(localVal),
          value_b: toText(remoteVal),
          hlc_a: localHlc,
          hlc_b: remoteHlc,
          winner,
          status: 0,
        });
        touched.add(field);
      } else if (!sameValue(localVal, remoteVal)) {
        // 仅远端修改（或本地未动）→ 采纳远端值（字段级合并）
        merged[field] = remoteVal;
        touched.add(field);
      }
    }

    if (touched.size === 0) {
      return { action: 'noop', row: localRow, conflicts: [], syncState: (localRow.sync_state as number) ?? 1 };
    }

    // 合并后的同步元数据
    merged.hlc = cmp >= 0 ? remoteHlc : localHlc;
    merged.version = Math.max(Number(localRow.version ?? 1), Number(payload.version ?? 1));
    merged.dirty_fields = stringifyDirtyFields([...touched]);
    merged.sync_state = conflicts.length > 0 ? 2 : 1;
    if (cmp >= 0) {
      if (payload.updated_by !== undefined) merged.updated_by = payload.updated_by;
      if (payload.updated_at !== undefined) merged.updated_at = payload.updated_at;
    }

    return { action: 'update', row: merged, conflicts, syncState: merged.sync_state as number };
  }

  // 未知实体：忽略
  return { action: 'skip', row: localRow, conflicts: [], syncState: (localRow?.sync_state as number) ?? 0 };
}
