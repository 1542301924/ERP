/**
 * 单据引擎（P2「出入库」）。
 *
 * 统一处理四类单据的 保存 / 审核 / 取消审核 / 红冲 / 订单转单，
 * 以及列表 / 详情查询。**不依赖 electron**，只依赖 `SqlDatabase` / `Repository`，便于单元测试。
 *
 * 状态机（`DocStatus`）：0 待审核 → 1 已审核 → 9 已红冲。
 *  - 草稿（0）可修改；
 *  - 已审核（1）不可改内容，只能「取消审核」回到草稿，或「红冲」生成反向已审核单据；
 *  - 红冲后的原单（9）不可再次操作。
 */

import {
  DocStatus,
  InboundType,
  InventoryBizType,
  OutboundType,
  SysConfigKey,
  type Row,
} from '@inventory/shared';
import { getSysConfig } from '../db/database';
import type { Repository } from '../db/repository';
import type { SqlDatabase } from '../db/sqlite';
import { nextCode } from './code-rule';
import { assertAvailable, avgCost, round2 } from './inventory';
import { writeOpLog } from './op-log';

/** 支持的单据类型。 */
export type DocKind = 'purchase_order' | 'purchase_inbound' | 'sales_order' | 'sales_outbound';

/** 列表过滤条件。 */
export interface DocFilter {
  keyword?: string;
  status?: number;
  docType?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 列表行：单据 + 派生展示字段。 */
export type DocListRow = Row & {
  doc_type: string | null;
  partner_name: string | null;
  warehouse_name: string | null;
};

/** 保存入参。 */
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
  doc: Row;
  items: Row[];
  bills: { ap_bill: Row | null; ar_bill: Row | null };
}

/** 引擎运行上下文：操作人、设备、时间源。 */
export interface DocContext {
  userId: string;
  deviceId: string;
  now: () => number;
}

/** 单据类型配置（表名 / 列名均为硬编码字面量，不接受外部输入）。 */
interface KindConfig {
  itemTable: string;
  itemFk: string;
  docTypeColumn: 'inbound_type' | 'outbound_type' | null;
  allowedDocTypes: string[] | null;
  partnerField: 'supplier_id' | 'customer_id';
  partnerTable: 'supplier' | 'customer';
  billTable: 'ap_bill' | 'ar_bill' | null;
  billSourceField: 'source_inbound_id' | 'source_outbound_id' | null;
  billPartnerField: 'supplier_id' | 'customer_id' | null;
  headerFields: string[];
  hasLocation: boolean;
  hasCostAmount: boolean;
}

const KIND_CONFIG: Record<DocKind, KindConfig> = {
  purchase_order: {
    itemTable: 'purchase_order_item',
    itemFk: 'order_id',
    docTypeColumn: null,
    allowedDocTypes: null,
    partnerField: 'supplier_id',
    partnerTable: 'supplier',
    billTable: null,
    billSourceField: null,
    billPartnerField: null,
    headerFields: ['supplier_id', 'warehouse_id', 'biz_date', 'handler_id', 'remark'],
    hasLocation: false,
    hasCostAmount: false,
  },
  purchase_inbound: {
    itemTable: 'purchase_inbound_item',
    itemFk: 'inbound_id',
    docTypeColumn: 'inbound_type',
    allowedDocTypes: [InboundType.PURCHASE, InboundType.DEPT_USE, InboundType.PRODUCTION, InboundType.RETURN],
    partnerField: 'supplier_id',
    partnerTable: 'supplier',
    billTable: 'ap_bill',
    billSourceField: 'source_inbound_id',
    billPartnerField: 'supplier_id',
    headerFields: [
      'supplier_id',
      'warehouse_id',
      'department_id',
      'receiver_id',
      'use_purpose',
      'biz_date',
      'handler_id',
      'remark',
    ],
    hasLocation: true,
    hasCostAmount: false,
  },
  sales_order: {
    itemTable: 'sales_order_item',
    itemFk: 'order_id',
    docTypeColumn: null,
    allowedDocTypes: null,
    partnerField: 'customer_id',
    partnerTable: 'customer',
    billTable: null,
    billSourceField: null,
    billPartnerField: null,
    headerFields: ['customer_id', 'warehouse_id', 'biz_date', 'handler_id', 'remark'],
    hasLocation: false,
    hasCostAmount: false,
  },
  sales_outbound: {
    itemTable: 'sales_outbound_item',
    itemFk: 'outbound_id',
    docTypeColumn: 'outbound_type',
    allowedDocTypes: [OutboundType.SALES, OutboundType.RETURN],
    partnerField: 'customer_id',
    partnerTable: 'customer',
    billTable: 'ar_bill',
    billSourceField: 'source_outbound_id',
    billPartnerField: 'customer_id',
    headerFields: ['customer_id', 'warehouse_id', 'biz_date', 'handler_id', 'remark'],
    hasLocation: true,
    hasCostAmount: true,
  },
};

/** 单据编号规则（惰性创建）。 */
const DOC_NO_RULES: Record<DocKind, { target: string; prefix: string }> = {
  purchase_order: { target: 'doc_no.purchase_order', prefix: 'PO' },
  purchase_inbound: { target: 'doc_no.purchase_inbound', prefix: 'RK' },
  sales_order: { target: 'doc_no.sales_order', prefix: 'SO' },
  sales_outbound: { target: 'doc_no.sales_outbound', prefix: 'CK' },
};

/** 审核效果描述。 */
interface AuditEffect {
  biz_type: string;
  direction: 'in' | 'out';
  unit_cost: 'price' | 'avg';
  bill: { table: 'ap_bill' | 'ar_bill'; partner: 'supplier_id' | 'customer_id'; sign: 1 | -1 } | null;
}

// ---------------- 内部工具 ----------------

function config(kind: DocKind): KindConfig {
  const cfg = KIND_CONFIG[kind];
  if (!cfg) throw new Error(`未知单据类型: ${kind}`);
  return cfg;
}

function loadDoc(db: SqlDatabase, kind: DocKind, id: string): Row {
  const doc = db.prepare(`SELECT * FROM ${kind} WHERE id = ? AND deleted = 0`).get(id);
  if (!doc) throw new Error('单据不存在');
  return doc as Row;
}

function loadItems(db: SqlDatabase, kind: DocKind, id: string): Row[] {
  const cfg = config(kind);
  return db.prepare(`SELECT * FROM ${cfg.itemTable} WHERE ${cfg.itemFk} = ? AND deleted = 0`).all(id) as Row[];
}

function docTypeOf(cfg: KindConfig, doc: Row): string | null {
  return cfg.docTypeColumn ? ((doc[cfg.docTypeColumn] as string | null) ?? null) : null;
}

/** 解析单据类型（出入库单必填且枚举受限；订单忽略）。 */
function resolveDocType(cfg: KindConfig, input: DocSaveInput): string | null {
  if (!cfg.docTypeColumn) return null;
  const docType = input.docType;
  if (!docType || !cfg.allowedDocTypes!.includes(docType)) {
    throw new Error(`单据类型无效，应为：${cfg.allowedDocTypes!.join('/')}`);
  }
  return docType;
}

/** 解析计量换算系数：优先 product_unit 中的 factor，否则回退入参 factor（默认 1）。 */
function resolveFactor(db: SqlDatabase, productId: string, unitId: string | null | undefined, inputFactor?: number): number {
  if (unitId) {
    const row = db
      .prepare('SELECT factor FROM product_unit WHERE product_id = ? AND unit_id = ? AND deleted = 0')
      .get(productId, unitId);
    if (row && row.factor !== undefined && row.factor !== null) return Number(row.factor);
  }
  return Number(inputFactor ?? 1);
}

/** 服务端权威地计算明细行（base_qty / amount）。 */
function buildItemRows(
  db: SqlDatabase,
  cfg: KindConfig,
  items: DocSaveInput['items'],
): { rows: Row[]; total: number } {
  const rows: Row[] = [];
  let total = 0;
  for (const item of items) {
    const factor = resolveFactor(db, item.product_id, item.unit_id, item.factor);
    const qty = Number(item.qty ?? 0);
    const price = Number(item.price ?? 0);
    const base_qty = qty * factor;
    const amount = round2(qty * price);
    total += amount;

    const row: Row = {
      product_id: item.product_id,
      unit_id: item.unit_id ?? null,
      factor,
      qty,
      base_qty,
      price,
      amount,
      remark: item.remark ?? null,
    };
    if (cfg.hasLocation) {
      row.location_id = item.location_id ?? null;
      row.cost_price = null;
      if (cfg.hasCostAmount) row.cost_amount = null;
    }
    rows.push(row);
  }
  return { rows, total: round2(total) };
}

/** 惰性创建编号规则并取下一个单据编号。 */
function nextDocNo(db: SqlDatabase, repo: Repository, kind: DocKind): string {
  const { target, prefix } = DOC_NO_RULES[kind];
  const existing = db.prepare('SELECT id FROM code_rule WHERE target = ? AND deleted = 0').get(target);
  if (!existing) repo.insert('code_rule', { target, prefix, category_code: null, seq_len: 5, next_seq: 1 });
  return nextCode(db, repo, target);
}

/** 审核效果表。 */
function auditEffect(kind: DocKind, docType: string | null): AuditEffect | null {
  if (kind === 'purchase_order' || kind === 'sales_order') return null;

  if (kind === 'purchase_inbound') {
    switch (docType) {
      case InboundType.PURCHASE:
        return {
          biz_type: InventoryBizType.PURCHASE_IN,
          direction: 'in',
          unit_cost: 'price',
          bill: { table: 'ap_bill', partner: 'supplier_id', sign: 1 },
        };
      case InboundType.DEPT_USE:
        return { biz_type: InventoryBizType.DEPT_USE, direction: 'out', unit_cost: 'avg', bill: null };
      case InboundType.PRODUCTION:
        return { biz_type: InventoryBizType.PRODUCTION_IN, direction: 'in', unit_cost: 'price', bill: null };
      case InboundType.RETURN:
        return {
          biz_type: InventoryBizType.RETURN_OUT,
          direction: 'out',
          unit_cost: 'avg',
          bill: { table: 'ap_bill', partner: 'supplier_id', sign: -1 },
        };
      default:
        throw new Error(`入库单类型无效：${docType ?? '(空)'}`);
    }
  }

  switch (docType) {
    case OutboundType.SALES:
      return {
        biz_type: InventoryBizType.SALES_OUT,
        direction: 'out',
        unit_cost: 'avg',
        bill: { table: 'ar_bill', partner: 'customer_id', sign: 1 },
      };
    case OutboundType.RETURN:
      return {
        biz_type: InventoryBizType.RETURN_IN,
        direction: 'in',
        unit_cost: 'avg',
        bill: { table: 'ar_bill', partner: 'customer_id', sign: -1 },
      };
    default:
      throw new Error(`出库单类型无效：${docType ?? '(空)'}`);
  }
}

/**
 * 前置校验（取消审核 / 红冲共用）。任一命中即抛中文错误。
 */
function runGuard(db: SqlDatabase, kind: DocKind, doc: Row): void {
  if (Number(doc.status) === DocStatus.REVERSED) throw new Error('单据已红冲，不能再次操作');

  // 2. 已发生收付款核销
  const apBillIds = db
    .prepare('SELECT id FROM ap_bill WHERE source_inbound_id = ? AND deleted = 0')
    .all(doc.id as string)
    .map((r) => r.id as string);
  const arBillIds = db
    .prepare('SELECT id FROM ar_bill WHERE source_outbound_id = ? AND deleted = 0')
    .all(doc.id as string)
    .map((r) => r.id as string);

  if (apBillIds.length > 0) {
    const placeholders = apBillIds.map(() => '?').join(',');
    const hit = db
      .prepare(
        'SELECT 1 AS x FROM ap_payment_apply a JOIN ap_payment p ON p.id = a.payment_id ' +
          `WHERE a.deleted = 0 AND p.deleted = 0 AND a.ap_bill_id IN (${placeholders}) LIMIT 1`,
      )
      .get(...apBillIds);
    if (hit) throw new Error('该单据的应收/应付已发生收付款核销，请先反核销');
  }
  if (arBillIds.length > 0) {
    const placeholders = arBillIds.map(() => '?').join(',');
    const hit = db
      .prepare(
        'SELECT 1 AS x FROM ar_receipt_apply a JOIN ar_receipt r ON r.id = a.receipt_id ' +
          `WHERE a.deleted = 0 AND r.deleted = 0 AND a.ar_bill_id IN (${placeholders}) LIMIT 1`,
      )
      .get(...arBillIds);
    if (hit) throw new Error('该单据的应收/应付已发生收付款核销，请先反核销');
  }

  // 3. 下游单据已引用
  const exists = (table: string, where: string, params: unknown[]): boolean =>
    db.prepare(`SELECT 1 AS x FROM ${table} WHERE deleted = 0 AND ${where} LIMIT 1`).get(...params) !== undefined;

  if (kind === 'purchase_order') {
    if (exists('purchase_inbound', 'source_order_id = ?', [doc.id]))
      throw new Error('该单据已被下游单据引用，请先处理下游单据');
  } else if (kind === 'sales_order') {
    if (exists('sales_outbound', 'source_order_id = ?', [doc.id]))
      throw new Error('该单据已被下游单据引用，请先处理下游单据');
  } else if (kind === 'purchase_inbound') {
    if (exists('purchase_inbound', '(source_order_id = ? OR reversal_of = ?)', [doc.id, doc.id]))
      throw new Error('该单据已被下游单据引用，请先处理下游单据');
  } else {
    if (exists('sales_outbound', '(source_order_id = ? OR reversal_of = ?)', [doc.id, doc.id]))
      throw new Error('该单据已被下游单据引用，请先处理下游单据');
  }
}

// ---------------- 对外 API ----------------

/** 保存单据（新建或修改草稿）。 */
export function save(db: SqlDatabase, repo: Repository, ctx: DocContext, kind: DocKind, input: DocSaveInput): Row {
  const cfg = config(kind);
  const docType = resolveDocType(cfg, input);
  const { rows, total } = buildItemRows(db, cfg, input.items ?? []);

  return db.transaction(() => {
    if (input.id) {
      const doc = repo.findById(kind, input.id);
      if (!doc || Number(doc.deleted) === 1) throw new Error('单据不存在');
      if (Number(doc.status) !== DocStatus.PENDING_AUDIT) {
        throw new Error('单据已审核，请先「取消审核」后再修改');
      }

      const patch: Row = {};
      const inputRow = input as unknown as Record<string, unknown>;
      for (const field of cfg.headerFields) {
        if (field in input) patch[field] = inputRow[field] ?? null;
      }
      patch.total_amount = total;
      if (cfg.docTypeColumn && input.docType !== undefined) patch[cfg.docTypeColumn] = docType;

      const updated = repo.update(kind, input.id, patch);

      const existing = db.prepare(`SELECT id FROM ${cfg.itemTable} WHERE ${cfg.itemFk} = ? AND deleted = 0`).all(input.id);
      for (const item of existing) repo.softDelete(cfg.itemTable, item.id as string);
      for (const row of rows) repo.insert(cfg.itemTable, { ...row, [cfg.itemFk]: input.id });

      return updated;
    }

    const values: Row = {};
    const inputRow = input as unknown as Record<string, unknown>;
    for (const field of cfg.headerFields) {
      values[field] = inputRow[field] ?? null;
    }
    values.doc_no = nextDocNo(db, repo, kind);
    values.status = DocStatus.PENDING_AUDIT;
    values.audited_by = null;
    values.audited_at = null;
    values.total_amount = total;
    if (cfg.docTypeColumn) values[cfg.docTypeColumn] = docType;

    const doc = repo.insert(kind, values);
    for (const row of rows) repo.insert(cfg.itemTable, { ...row, [cfg.itemFk]: doc.id });
    return doc;
  });
}

/** 审核单据：在一个事务内写流水 / 往来单 / 更新状态。 */
export function audit(db: SqlDatabase, repo: Repository, ctx: DocContext, kind: DocKind, id: string): Row {
  const cfg = config(kind);

  return db.transaction(() => {
    const doc = loadDoc(db, kind, id);
    if (Number(doc.status) !== DocStatus.PENDING_AUDIT) throw new Error('单据不是待审核状态，无法审核');

    const items = loadItems(db, kind, id);
    const effect = auditEffect(kind, docTypeOf(cfg, doc));
    const now = ctx.now();
    const warehouseId = (doc.warehouse_id as string | null) ?? null;

    if (!effect) {
      const updated = repo.update(kind, id, { status: DocStatus.AUDITED, audited_by: ctx.userId, audited_at: now });
      writeOpLog(db, {
        user_id: ctx.userId,
        action: 'audit',
        entity: kind,
        entity_id: id,
        after: updated,
        device_id: ctx.deviceId,
        at: now,
      });
      return updated;
    }

    // 负库存前置校验（仅出库方向）
    if (effect.direction === 'out') {
      const allowNegative = getSysConfig(db, SysConfigKey.ALLOW_NEGATIVE_STOCK) === '1';
      const needs = items.map((item) => ({
        product_id: String(item.product_id),
        warehouse_id: warehouseId ?? '',
        location_id: (item.location_id as string | null) ?? null,
        qty: Number(item.base_qty ?? item.qty ?? 0),
      }));
      assertAvailable(db, needs, allowNegative);
    }

    // 往来单缺少往来单位前置校验
    let partnerId: string | null = null;
    if (effect.bill) {
      partnerId = (doc[effect.bill.partner] as string | null) ?? null;
      if (!partnerId && effect.bill.sign > 0) {
        throw new Error(effect.bill.table === 'ap_bill' ? '采购入库缺少供应商，无法审核' : '销售出库缺少客户，无法审核');
      }
    }

    for (const item of items) {
      const baseQty = Number(item.base_qty ?? item.qty ?? 0);
      const locationId = (item.location_id as string | null) ?? null;
      const unitCost =
        effect.unit_cost === 'price'
          ? Number(item.price ?? 0)
          : avgCost(db, { product_id: String(item.product_id), warehouse_id: warehouseId ?? '', location_id: locationId });
      const amount = baseQty * unitCost;

      repo.insert('stock_ledger', {
        biz_type: effect.biz_type,
        doc_type: docTypeOf(cfg, doc),
        doc_id: doc.id,
        doc_no: doc.doc_no,
        product_id: item.product_id,
        warehouse_id: warehouseId,
        location_id: locationId,
        qty_in: effect.direction === 'in' ? baseQty : 0,
        qty_out: effect.direction === 'out' ? baseQty : 0,
        unit_cost: unitCost,
        amount,
        biz_date: (doc.biz_date as number | null) ?? now,
        operator_id: ctx.userId,
        reversal_of: null,
        remark: null,
      });

      const patch: Row = { cost_price: unitCost };
      if (cfg.hasCostAmount) patch.cost_amount = round2(baseQty * unitCost);
      repo.update(cfg.itemTable, String(item.id), patch);
    }

    // 往来单（金额可能为负：退货方向）
    if (effect.bill && partnerId) {
      const billAmount = round2(effect.bill.sign * Number(doc.total_amount ?? 0));
      if (effect.bill.table === 'ap_bill') {
        repo.insert('ap_bill', {
          supplier_id: partnerId,
          source_inbound_id: doc.id,
          amount: billAmount,
          paid_amount: 0,
          status: DocStatus.AUDITED,
          due_date: null,
        });
      } else {
        repo.insert('ar_bill', {
          customer_id: partnerId,
          source_outbound_id: doc.id,
          amount: billAmount,
          received_amount: 0,
          status: DocStatus.AUDITED,
          due_date: null,
        });
      }
    }

    const updated = repo.update(kind, id, { status: DocStatus.AUDITED, audited_by: ctx.userId, audited_at: now });
    writeOpLog(db, {
      user_id: ctx.userId,
      action: 'audit',
      entity: kind,
      entity_id: id,
      after: updated,
      device_id: ctx.deviceId,
      at: now,
    });
    return updated;
  });
}

/** 取消审核：红冲自身流水、作废往来单、状态回 0。 */
export function unaudit(db: SqlDatabase, repo: Repository, ctx: DocContext, kind: DocKind, id: string): Row {
  const cfg = config(kind);

  return db.transaction(() => {
    const doc = loadDoc(db, kind, id);
    runGuard(db, kind, doc);
    if (Number(doc.status) !== DocStatus.AUDITED) throw new Error('单据不是已审核状态，无法取消审核');

    const now = ctx.now();
    const ledgerRows = db
      .prepare('SELECT * FROM stock_ledger WHERE doc_id = ? AND reversal_of IS NULL')
      .all(doc.id as string) as Row[];

    for (const row of ledgerRows) {
      const existing = db.prepare('SELECT id FROM stock_ledger WHERE reversal_of = ?').get(row.id);
      if (existing) throw new Error('该单据的库存流水已被冲销');
      repo.insert('stock_ledger', {
        biz_type: InventoryBizType.REVERSAL,
        doc_type: row.doc_type,
        doc_id: row.doc_id,
        doc_no: row.doc_no,
        product_id: row.product_id,
        warehouse_id: row.warehouse_id,
        location_id: row.location_id,
        qty_in: row.qty_out,
        qty_out: row.qty_in,
        unit_cost: row.unit_cost,
        amount: row.amount,
        biz_date: now,
        operator_id: ctx.userId,
        reversal_of: row.id,
        remark: null,
      });
    }

    if (cfg.billTable && cfg.billSourceField) {
      const bills = db
        .prepare(`SELECT id FROM ${cfg.billTable} WHERE ${cfg.billSourceField} = ? AND deleted = 0`)
        .all(doc.id as string);
      for (const bill of bills) repo.softDelete(cfg.billTable, bill.id as string);
    }

    const updated = repo.update(kind, id, {
      status: DocStatus.PENDING_AUDIT,
      audited_by: null,
      audited_at: null,
    });
    writeOpLog(db, {
      user_id: ctx.userId,
      action: 'unaudit',
      entity: kind,
      entity_id: id,
      before: doc,
      after: updated,
      device_id: ctx.deviceId,
      at: now,
    });
    return updated;
  });
}

/** 红冲：生成反向已审核单据 R，原单置 9。 */
export function reverse(
  db: SqlDatabase,
  repo: Repository,
  ctx: DocContext,
  kind: DocKind,
  id: string,
): { doc: Row; reversalDocId: string } {
  const cfg = config(kind);

  return db.transaction(() => {
    const doc = loadDoc(db, kind, id);
    runGuard(db, kind, doc);
    if (Number(doc.status) !== DocStatus.AUDITED) throw new Error('单据不是已审核状态，无法红冲');

    const now = ctx.now();

    // 1. 新建反向单据 R（复制可编辑表头字段）
    const rValues: Row = {};
    for (const field of cfg.headerFields) rValues[field] = doc[field] ?? null;
    rValues.doc_no = nextDocNo(db, repo, kind);
    rValues.status = DocStatus.PENDING_AUDIT;
    rValues.audited_by = null;
    rValues.audited_at = null;
    rValues.total_amount = Number(doc.total_amount ?? 0);
    rValues.source_order_id = null;
    rValues.reversal_of = doc.id;
    rValues.biz_date = now;
    if (cfg.docTypeColumn) rValues[cfg.docTypeColumn] = doc[cfg.docTypeColumn] ?? null;

    const rDoc = repo.insert(kind, rValues);

    // 2. 复制明细
    const items = loadItems(db, kind, id);
    for (const item of items) {
      const rItem: Row = {
        product_id: item.product_id,
        unit_id: item.unit_id ?? null,
        factor: item.factor ?? 1,
        qty: item.qty ?? null,
        base_qty: item.base_qty ?? null,
        price: item.price ?? null,
        amount: item.amount ?? null,
        remark: item.remark ?? null,
      };
      if (cfg.hasLocation) {
        rItem.location_id = item.location_id ?? null;
        rItem.cost_price = item.cost_price ?? null;
        if (cfg.hasCostAmount) rItem.cost_amount = item.cost_amount ?? null;
      }
      rItem[cfg.itemFk] = rDoc.id;
      repo.insert(cfg.itemTable, rItem);
    }

    // 3. 反向流水：遍历原单未被冲销的流水，逐条发出方向相反的一条
    const originalLedger = db
      .prepare('SELECT * FROM stock_ledger WHERE doc_id = ? AND reversal_of IS NULL')
      .all(doc.id as string) as Row[];
    for (const led of originalLedger) {
      // 防止重复冲销同一流水：已被冲销的原流水行直接跳过
      const existing = db.prepare('SELECT id FROM stock_ledger WHERE reversal_of = ?').get(led.id);
      if (existing) continue;
      repo.insert('stock_ledger', {
        biz_type: InventoryBizType.REVERSAL,
        doc_type: led.doc_type,
        doc_id: rDoc.id,
        doc_no: rDoc.doc_no,
        product_id: led.product_id,
        warehouse_id: led.warehouse_id,
        location_id: led.location_id,
        qty_in: led.qty_out,
        qty_out: led.qty_in,
        unit_cost: led.unit_cost,
        amount: led.amount,
        biz_date: now,
        operator_id: ctx.userId,
        reversal_of: led.id,
        remark: null,
      });
    }

    // 4. 反向往来单（与原单金额相反）
    if (cfg.billTable && cfg.billSourceField && cfg.billPartnerField) {
      const origBill = db
        .prepare(`SELECT * FROM ${cfg.billTable} WHERE ${cfg.billSourceField} = ? AND deleted = 0`)
        .get(doc.id as string) as Row | undefined;
      if (origBill) {
        const partner = origBill[cfg.billPartnerField] as string | null;
        if (partner) {
          const billValues: Row = {
            [cfg.billPartnerField]: partner,
            [cfg.billSourceField]: rDoc.id,
            amount: -Number(origBill.amount ?? 0),
            status: DocStatus.AUDITED,
            due_date: null,
          };
          if (cfg.billTable === 'ap_bill') billValues.paid_amount = 0;
          else billValues.received_amount = 0;
          repo.insert(cfg.billTable, billValues);
        }
      }
    }

    // 5. R 置已审核；原单置已红冲
    const rUpdated = repo.update(kind, rDoc.id as string, {
      status: DocStatus.AUDITED,
      audited_by: ctx.userId,
      audited_at: now,
    });
    const originalUpdated = repo.update(kind, id, { status: DocStatus.REVERSED });

    writeOpLog(db, {
      user_id: ctx.userId,
      action: 'reverse',
      entity: kind,
      entity_id: id,
      before: doc,
      after: originalUpdated,
      device_id: ctx.deviceId,
      at: now,
    });
    writeOpLog(db, {
      user_id: ctx.userId,
      action: 'reverse',
      entity: kind,
      entity_id: rDoc.id as string,
      after: rUpdated,
      device_id: ctx.deviceId,
      at: now,
    });

    return { doc: originalUpdated, reversalDocId: rDoc.id as string };
  });
}

/** 订单转出入库单（草稿）。 */
export function transfer(
  db: SqlDatabase,
  repo: Repository,
  ctx: DocContext,
  orderKind: 'purchase_order' | 'sales_order',
  orderId: string,
): Row {
  return db.transaction(() => {
    const order = loadDoc(db, orderKind, orderId);
    if (Number(order.status) !== DocStatus.AUDITED) throw new Error('订单未审核，不能转单');

    const targetKind: DocKind = orderKind === 'purchase_order' ? 'purchase_inbound' : 'sales_outbound';
    const targetCfg = config(targetKind);

    const existing = db
      .prepare(`SELECT id FROM ${targetKind} WHERE source_order_id = ? AND deleted = 0`)
      .get(orderId);
    if (existing) throw new Error('该订单已生成对应的出入库单');

    const now = ctx.now();
    const docType = orderKind === 'purchase_order' ? InboundType.PURCHASE : OutboundType.SALES;

    const values: Row = {};
    for (const field of targetCfg.headerFields) values[field] = order[field] ?? null;
    values.doc_no = nextDocNo(db, repo, targetKind);
    values[targetCfg.docTypeColumn as string] = docType;
    values.source_order_id = orderId;
    values.status = DocStatus.PENDING_AUDIT;
    values.audited_by = null;
    values.audited_at = null;
    values.total_amount = Number(order.total_amount ?? 0);

    const newDoc = repo.insert(targetKind, values);

    const items = loadItems(db, orderKind, orderId);
    for (const item of items) {
      const row: Row = {
        product_id: item.product_id,
        unit_id: item.unit_id ?? null,
        factor: item.factor ?? 1,
        qty: item.qty ?? null,
        base_qty: item.base_qty ?? null,
        price: item.price ?? null,
        amount: item.amount ?? null,
        remark: item.remark ?? null,
        location_id: null,
        cost_price: null,
      };
      if (targetCfg.hasCostAmount) row.cost_amount = null;
      row[targetCfg.itemFk] = newDoc.id;
      repo.insert(targetCfg.itemTable, row);
    }

    writeOpLog(db, {
      user_id: ctx.userId,
      action: 'transfer',
      entity: targetKind,
      entity_id: newDoc.id as string,
      before: order,
      after: newDoc,
      device_id: ctx.deviceId,
      at: now,
    });

    return newDoc;
  });
}

/** 列表查询（默认排除软删除，按业务日期 / 单据编号倒序）。 */
export function list(db: SqlDatabase, kind: DocKind, filter: DocFilter = {}): DocListRow[] {
  const cfg = config(kind);
  const where: string[] = ['d.deleted = 0'];
  const params: unknown[] = [];

  const keyword = typeof filter.keyword === 'string' ? filter.keyword.trim() : '';
  if (keyword) {
    where.push('(d.doc_no LIKE ? OR d.remark LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (filter.status !== undefined && filter.status !== null) {
    where.push('d.status = ?');
    params.push(filter.status);
  }
  if (filter.docType && cfg.docTypeColumn) {
    where.push(`d.${cfg.docTypeColumn} = ?`);
    params.push(filter.docType);
  }
  if (filter.startDate !== undefined && filter.startDate !== null) {
    where.push('d.biz_date >= ?');
    params.push(filter.startDate);
  }
  if (filter.endDate !== undefined && filter.endDate !== null) {
    where.push('d.biz_date <= ?');
    params.push(filter.endDate);
  }

  const limitSuffix = filter.limit ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : '';
  const docTypeSelect = cfg.docTypeColumn ? `d.${cfg.docTypeColumn} AS doc_type` : 'NULL AS doc_type';

  const sql =
    `SELECT d.*, ${docTypeSelect}, p.name AS partner_name, w.name AS warehouse_name ` +
    `FROM ${kind} d ` +
    `LEFT JOIN ${cfg.partnerTable} p ON p.id = d.${cfg.partnerField} AND p.deleted = 0 ` +
    'LEFT JOIN warehouse w ON w.id = d.warehouse_id AND w.deleted = 0 ' +
    `WHERE ${where.join(' AND ')} ` +
    `ORDER BY d.biz_date DESC, d.doc_no DESC${limitSuffix}`;

  return db.prepare(sql).all(...params) as DocListRow[];
}

/** 单据详情：表头 + 明细（含 product_name/product_code/unit_name）+ 往来单。 */
export function get(db: SqlDatabase, kind: DocKind, id: string): DocGetResult | null {
  const cfg = config(kind);
  const doc = db.prepare(`SELECT * FROM ${kind} WHERE id = ? AND deleted = 0`).get(id);
  if (!doc) return null;

  const items = db
    .prepare(
      'SELECT i.*, p.name AS product_name, p.code AS product_code, u.name AS unit_name ' +
        `FROM ${cfg.itemTable} i ` +
        'LEFT JOIN product p ON p.id = i.product_id AND p.deleted = 0 ' +
        'LEFT JOIN unit u ON u.id = i.unit_id AND u.deleted = 0 ' +
        `WHERE i.${cfg.itemFk} = ? AND i.deleted = 0`,
    )
    .all(id) as Row[];

  const apBill = db
    .prepare('SELECT * FROM ap_bill WHERE source_inbound_id = ? AND deleted = 0')
    .get(id) as Row | undefined;
  const arBill = db
    .prepare('SELECT * FROM ar_bill WHERE source_outbound_id = ? AND deleted = 0')
    .get(id) as Row | undefined;

  return {
    doc: doc as Row,
    items,
    bills: { ap_bill: apBill ?? null, ar_bill: arBill ?? null },
  };
}
