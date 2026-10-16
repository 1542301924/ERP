/**
 * 库存单据引擎（P3「库存」）：库存调拨 / 库存盘点。
 *
 * 与 `services/documents.ts`（采购 / 销售四类单据）保持同一套约定：
 *  - 状态机 `0 待审核 → 1 已审核 → 9 已红冲`，只有已审核才写流水、才影响库存；
 *  - 调拨：源仓出库 + 目标仓入库两条流水（成本按源仓移动加权平均，成本随货转移）；
 *  - 盘点：按 `real − book` 差异生成盈亏流水（盘盈入库 / 盘亏出库）；
 *  - 取消审核 / 红冲一律**追加反向流水**（`stock_ledger` append-only），不删原流水；
 *  - 审核 / 取消审核 / 红冲后按受影响维度触发 `stock_balance` 增量重算。
 *
 * 本模块**不依赖 electron**，只依赖 `SqlDatabase` / `Repository`，便于单元测试。
 */

import { DocStatus, InventoryBizType, SysConfigKey, type Row } from '@inventory/shared';
import { getSysConfig } from '../db/database';
import type { Repository } from '../db/repository';
import type { SqlDatabase } from '../db/sqlite';
import { nextCode } from './code-rule';
import type { DocContext } from './documents';
import { assertAvailable, availableQty, avgCost, round2 } from './inventory';
import { writeOpLog } from './op-log';
import { recomputeBalance } from './stock';

/** 库存单据类型。 */
export type StockDocKind = 'stock_transfer' | 'stock_check';

/** 保存入参（两类单据共用一个结构，按 kind 取用其中相关字段）。 */
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

/** 列表过滤条件。 */
export interface StockDocFilter {
  keyword?: string;
  status?: number;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 单据类型配置（表名 / 列名均为硬编码字面量）。 */
interface KindConfig {
  itemTable: string;
  itemFk: string;
  docNoTarget: string;
  prefix: string;
  bizType: string;
  docType: string;
  headerFields: string[];
}

const KIND_CONFIG: Record<StockDocKind, KindConfig> = {
  stock_transfer: {
    itemTable: 'stock_transfer_item',
    itemFk: 'transfer_id',
    docNoTarget: 'doc_no.stock_transfer',
    prefix: 'DB',
    bizType: InventoryBizType.TRANSFER,
    docType: '调拨',
    headerFields: ['from_warehouse_id', 'to_warehouse_id', 'biz_date', 'handler_id', 'remark'],
  },
  stock_check: {
    itemTable: 'stock_check_item',
    itemFk: 'check_id',
    docNoTarget: 'doc_no.stock_check',
    prefix: 'PD',
    bizType: InventoryBizType.STOCK_CHECK,
    docType: '盘点',
    headerFields: ['warehouse_id', 'biz_date', 'handler_id', 'remark'],
  },
};

function config(kind: StockDocKind): KindConfig {
  const cfg = KIND_CONFIG[kind];
  if (!cfg) throw new Error(`未知库存单据类型: ${kind}`);
  return cfg;
}

function loadDoc(db: SqlDatabase, kind: StockDocKind, id: string): Row {
  const doc = db.prepare(`SELECT * FROM ${kind} WHERE id = ? AND deleted = 0`).get(id);
  if (!doc) throw new Error('单据不存在');
  return doc as Row;
}

function loadItems(db: SqlDatabase, kind: StockDocKind, id: string): Row[] {
  const cfg = config(kind);
  return db.prepare(`SELECT * FROM ${cfg.itemTable} WHERE ${cfg.itemFk} = ? AND deleted = 0`).all(id) as Row[];
}

/** 解析换算系数：优先 `product_unit` 中的 factor，否则回退入参 factor（默认 1）。 */
function resolveFactor(db: SqlDatabase, productId: string, unitId: string | null | undefined, inputFactor?: number): number {
  if (unitId) {
    const row = db
      .prepare('SELECT factor FROM product_unit WHERE product_id = ? AND unit_id = ? AND deleted = 0')
      .get(productId, unitId);
    if (row && row.factor !== undefined && row.factor !== null) return Number(row.factor);
  }
  return Number(inputFactor ?? 1);
}

/** 惰性创建编号规则并取下一个单据编号。 */
function nextDocNo(db: SqlDatabase, repo: Repository, kind: StockDocKind): string {
  const cfg = config(kind);
  const existing = db.prepare('SELECT id FROM code_rule WHERE target = ? AND deleted = 0').get(cfg.docNoTarget);
  if (!existing) repo.insert('code_rule', { target: cfg.docNoTarget, prefix: cfg.prefix, category_code: null, seq_len: 5, next_seq: 1 });
  return nextCode(db, repo, cfg.docNoTarget);
}

/** 校验调拨表头：调出 / 调入仓库必填且不同。 */
function assertTransferHeader(fromWh: unknown, toWh: unknown): void {
  if (!fromWh || !toWh) throw new Error('调拨单需要选择调出仓库与调入仓库');
  if (String(fromWh) === String(toWh)) throw new Error('调出仓库与调入仓库不能相同');
}

/** 取消审核 / 红冲前置校验：已红冲、已被反向单引用。 */
function runGuard(db: SqlDatabase, kind: StockDocKind, doc: Row): void {
  if (Number(doc.status) === DocStatus.REVERSED) throw new Error('单据已红冲，不能再次操作');
  const hit = db
    .prepare(`SELECT 1 AS x FROM ${kind} WHERE deleted = 0 AND reversal_of = ? LIMIT 1`)
    .get(doc.id as string);
  if (hit) throw new Error('该单据已被红冲单引用，请先处理红冲单');
}

/** 按流水的 (商品, 仓库) 维度做增量重算。 */
function recomputeForLedger(db: SqlDatabase, rows: Row[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.product_id}|${row.warehouse_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recomputeBalance(db, { productId: String(row.product_id), warehouseId: String(row.warehouse_id) });
  }
}

/** 组装明细行（服务端权威计算 base_qty 等）。 */
function buildItems(
  db: SqlDatabase,
  kind: StockDocKind,
  warehouseId: string | null,
  items: StockDocSaveInput['items'],
): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    const factor = resolveFactor(db, item.product_id, item.unit_id, item.factor);
    const qty = Number(item.qty ?? 0);
    const baseQty = qty * factor;

    if (kind === 'stock_transfer') {
      rows.push({
        product_id: item.product_id,
        from_location_id: item.from_location_id ?? null,
        to_location_id: item.to_location_id ?? null,
        unit_id: item.unit_id ?? null,
        factor,
        qty,
        base_qty: baseQty,
      });
      continue;
    }

    // 盘点：以保存时刻的账面量作为 book_qty（盘点基准），差异 = 实盘 − 账面
    const locationId = item.location_id ?? null;
    const bookQty = availableQty(db, {
      product_id: item.product_id,
      warehouse_id: warehouseId ?? '',
      location_id: locationId,
    });
    rows.push({
      product_id: item.product_id,
      location_id: locationId,
      unit_id: item.unit_id ?? null,
      factor,
      qty,
      base_qty: baseQty,
      book_qty: bookQty,
      real_qty: baseQty,
      diff_qty: baseQty - bookQty,
    });
  }
  return rows;
}

/** 保存单据（新建或修改草稿），并在保存时重建明细。 */
export function save(db: SqlDatabase, repo: Repository, ctx: DocContext, kind: StockDocKind, input: StockDocSaveInput): Row {
  const cfg = config(kind);

  return db.transaction(() => {
    const inputRow = input as unknown as Record<string, unknown>;
    if (kind === 'stock_transfer') {
      assertTransferHeader(inputRow.from_warehouse_id ?? null, inputRow.to_warehouse_id ?? null);
    } else if (!inputRow.warehouse_id) {
      throw new Error('盘点单需要选择仓库');
    }

    const warehouseId = kind === 'stock_transfer' ? null : ((inputRow.warehouse_id as string | null) ?? null);
    const items = buildItems(db, kind, warehouseId, input.items ?? []);
    if (items.length === 0) throw new Error('请至少添加一条有效明细');

    const writeItems = (docId: string): void => {
      for (const row of items) repo.insert(cfg.itemTable, { ...row, [cfg.itemFk]: docId });
    };

    if (input.id) {
      const doc = repo.findById(kind, input.id);
      if (!doc || Number(doc.deleted) === 1) throw new Error('单据不存在');
      if (Number(doc.status) !== DocStatus.PENDING_AUDIT) throw new Error('单据已审核，请先「取消审核」后再修改');

      const patch: Row = {};
      for (const field of cfg.headerFields) if (field in input) patch[field] = inputRow[field] ?? null;
      const updated = repo.update(kind, input.id, patch);

      const existing = db.prepare(`SELECT id FROM ${cfg.itemTable} WHERE ${cfg.itemFk} = ? AND deleted = 0`).all(input.id);
      for (const item of existing) repo.softDelete(cfg.itemTable, item.id as string);
      writeItems(input.id);
      return updated;
    }

    const values: Row = {};
    for (const field of cfg.headerFields) values[field] = inputRow[field] ?? null;
    values.doc_no = nextDocNo(db, repo, kind);
    values.status = DocStatus.PENDING_AUDIT;
    values.audited_by = null;
    values.audited_at = null;

    const doc = repo.insert(kind, values);
    writeItems(doc.id as string);
    return doc;
  });
}

/** 审核单据：写库存流水并触发重算。 */
export function audit(db: SqlDatabase, repo: Repository, ctx: DocContext, kind: StockDocKind, id: string): Row {
  const cfg = config(kind);

  return db.transaction(() => {
    const doc = loadDoc(db, kind, id);
    if (Number(doc.status) !== DocStatus.PENDING_AUDIT) throw new Error('单据不是待审核状态，无法审核');

    const items = loadItems(db, kind, id);
    if (items.length === 0) throw new Error('单据没有明细，无法审核');

    const now = ctx.now();
    const allowNegative = getSysConfig(db, SysConfigKey.ALLOW_NEGATIVE_STOCK) === '1';
    const written: Row[] = [];

    const insertLedger = (values: Row): void => {
      const row = repo.insert('stock_ledger', {
        biz_type: cfg.bizType,
        doc_type: cfg.docType,
        doc_id: doc.id,
        doc_no: doc.doc_no,
        biz_date: (doc.biz_date as number | null) ?? now,
        operator_id: ctx.userId,
        reversal_of: null,
        remark: null,
        ...values,
      });
      written.push(row);
    };

    if (kind === 'stock_transfer') {
      const fromWh = (doc.from_warehouse_id as string | null) ?? null;
      const toWh = (doc.to_warehouse_id as string | null) ?? null;
      assertTransferHeader(fromWh, toWh);

      // 负库存校验（源仓），一次性聚合
      assertAvailable(
        db,
        items.map((item) => ({
          product_id: String(item.product_id),
          warehouse_id: fromWh as string,
          location_id: (item.from_location_id as string | null) ?? null,
          qty: Number(item.base_qty ?? item.qty ?? 0),
        })),
        allowNegative,
      );

      // 预取成本（避免同单多行相互影响）
      const costs = items.map((item) =>
        avgCost(db, {
          product_id: String(item.product_id),
          warehouse_id: fromWh as string,
          location_id: (item.from_location_id as string | null) ?? null,
        }),
      );

      items.forEach((item, idx) => {
        const baseQty = Number(item.base_qty ?? item.qty ?? 0);
        const unitCost = costs[idx];
        const amount = baseQty * unitCost;
        insertLedger({
          product_id: item.product_id,
          warehouse_id: fromWh,
          location_id: item.from_location_id ?? null,
          qty_in: 0,
          qty_out: baseQty,
          unit_cost: unitCost,
          amount,
        });
        insertLedger({
          product_id: item.product_id,
          warehouse_id: toWh,
          location_id: item.to_location_id ?? null,
          qty_in: baseQty,
          qty_out: 0,
          unit_cost: unitCost,
          amount,
        });
      });
    } else {
      const wh = (doc.warehouse_id as string | null) ?? null;
      if (!wh) throw new Error('盘点单缺少仓库');

      // 盘亏（diff < 0）需要出库，做可用量校验
      assertAvailable(
        db,
        items
          .filter((item) => Number(item.diff_qty ?? 0) < 0)
          .map((item) => ({
            product_id: String(item.product_id),
            warehouse_id: wh,
            location_id: (item.location_id as string | null) ?? null,
            qty: -Number(item.diff_qty ?? 0),
          })),
        allowNegative,
      );

      for (const item of items) {
        const diff = Number(item.diff_qty ?? 0);
        if (diff === 0) continue;
        const unitCost = avgCost(db, {
          product_id: String(item.product_id),
          warehouse_id: wh,
          location_id: (item.location_id as string | null) ?? null,
        });
        const absDiff = Math.abs(diff);
        insertLedger({
          product_id: item.product_id,
          warehouse_id: wh,
          location_id: item.location_id ?? null,
          qty_in: diff > 0 ? absDiff : 0,
          qty_out: diff < 0 ? absDiff : 0,
          unit_cost: unitCost,
          amount: absDiff * unitCost,
        });
      }
    }

    const updated = repo.update(kind, id, { status: DocStatus.AUDITED, audited_by: ctx.userId, audited_at: now });
    writeOpLog(db, { user_id: ctx.userId, action: 'audit', entity: kind, entity_id: id, after: updated, device_id: ctx.deviceId, at: now });
    recomputeForLedger(db, written);
    return updated;
  });
}

/** 取消审核：红冲自身流水，状态回 0，并重算。 */
export function unaudit(db: SqlDatabase, repo: Repository, ctx: DocContext, kind: StockDocKind, id: string): Row {
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

    const updated = repo.update(kind, id, { status: DocStatus.PENDING_AUDIT, audited_by: null, audited_at: null });
    writeOpLog(db, { user_id: ctx.userId, action: 'unaudit', entity: kind, entity_id: id, before: doc, after: updated, device_id: ctx.deviceId, at: now });
    recomputeForLedger(db, ledgerRows);
    return updated;
  });
}

/** 红冲：生成反向已审核单据 R，原单置 9，并重算。 */
export function reverse(
  db: SqlDatabase,
  repo: Repository,
  ctx: DocContext,
  kind: StockDocKind,
  id: string,
): { doc: Row; reversalDocId: string } {
  const cfg = config(kind);

  return db.transaction(() => {
    const doc = loadDoc(db, kind, id);
    runGuard(db, kind, doc);
    if (Number(doc.status) !== DocStatus.AUDITED) throw new Error('单据不是已审核状态，无法红冲');

    const now = ctx.now();
    const items = loadItems(db, kind, id);

    // 1. 新建反向单据 R（调拨交换调出/调入仓库）
    const rValues: Row = {};
    for (const field of cfg.headerFields) rValues[field] = doc[field] ?? null;
    if (kind === 'stock_transfer') {
      rValues.from_warehouse_id = doc.to_warehouse_id ?? null;
      rValues.to_warehouse_id = doc.from_warehouse_id ?? null;
    }
    rValues.doc_no = nextDocNo(db, repo, kind);
    rValues.status = DocStatus.PENDING_AUDIT;
    rValues.audited_by = null;
    rValues.audited_at = null;
    rValues.reversal_of = doc.id;
    rValues.biz_date = now;
    const rDoc = repo.insert(kind, rValues);

    // 2. 复制明细（调拨交换库位）
    for (const item of items) {
      const rItem: Row = { ...item, id: undefined, [cfg.itemFk]: rDoc.id };
      delete rItem.id;
      if (kind === 'stock_transfer') {
        rItem.from_location_id = item.to_location_id ?? null;
        rItem.to_location_id = item.from_location_id ?? null;
      }
      repo.insert(cfg.itemTable, rItem);
    }

    // 3. 反向流水：对原单每条未被冲销的流水，在 R 名下写一条方向相反的流水
    const originalLedger = db
      .prepare('SELECT * FROM stock_ledger WHERE doc_id = ? AND reversal_of IS NULL')
      .all(doc.id as string) as Row[];
    for (const led of originalLedger) {
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

    const rUpdated = repo.update(kind, rDoc.id as string, { status: DocStatus.AUDITED, audited_by: ctx.userId, audited_at: now });
    const originalUpdated = repo.update(kind, id, { status: DocStatus.REVERSED });

    writeOpLog(db, { user_id: ctx.userId, action: 'reverse', entity: kind, entity_id: id, before: doc, after: originalUpdated, device_id: ctx.deviceId, at: now });
    writeOpLog(db, { user_id: ctx.userId, action: 'reverse', entity: kind, entity_id: rDoc.id as string, after: rUpdated, device_id: ctx.deviceId, at: now });
    recomputeForLedger(db, originalLedger);

    return { doc: originalUpdated, reversalDocId: rDoc.id as string };
  });
}

/** 列表查询（含派生展示列）。 */
export function list(db: SqlDatabase, kind: StockDocKind, filter: StockDocFilter = {}): Row[] {
  const cfg = config(kind);
  const where: string[] = ['d.deleted = 0'];
  const params: unknown[] = [];

  const keyword = filter.keyword?.trim();
  if (keyword) {
    where.push('(d.doc_no LIKE ? OR d.remark LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (filter.status !== undefined && filter.status !== null) {
    where.push('d.status = ?');
    params.push(filter.status);
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

  const sql =
    kind === 'stock_transfer'
      ? `SELECT d.*, '${cfg.docType}' AS doc_type, fw.name AS from_warehouse_name, tw.name AS to_warehouse_name ` +
        'FROM stock_transfer d ' +
        'LEFT JOIN warehouse fw ON fw.id = d.from_warehouse_id AND fw.deleted = 0 ' +
        'LEFT JOIN warehouse tw ON tw.id = d.to_warehouse_id AND tw.deleted = 0 ' +
        `WHERE ${where.join(' AND ')} ORDER BY d.biz_date DESC, d.doc_no DESC${limitSuffix}`
      : `SELECT d.*, '${cfg.docType}' AS doc_type, w.name AS warehouse_name ` +
        'FROM stock_check d ' +
        'LEFT JOIN warehouse w ON w.id = d.warehouse_id AND w.deleted = 0 ' +
        `WHERE ${where.join(' AND ')} ORDER BY d.biz_date DESC, d.doc_no DESC${limitSuffix}`;

  return db.prepare(sql).all(...params) as Row[];
}

/** 单据详情：表头 + 明细（含商品/库位名称）。 */
export function get(db: SqlDatabase, kind: StockDocKind, id: string): { doc: Row; items: Row[] } | null {
  const cfg = config(kind);
  const doc = db.prepare(`SELECT * FROM ${kind} WHERE id = ? AND deleted = 0`).get(id);
  if (!doc) return null;

  // 调拨明细含调出/调入货位；盘点明细只有单一货位，不能引用 from/to 列
  const select =
    kind === 'stock_transfer'
      ? 'i.*, p.name AS product_name, p.code AS product_code, u.name AS unit_name, ' +
        'fl.name AS from_location_name, tl.name AS to_location_name, l.name AS location_name '
      : 'i.*, p.name AS product_name, p.code AS product_code, u.name AS unit_name, l.name AS location_name ';
  const locationJoins =
    kind === 'stock_transfer'
      ? 'LEFT JOIN location fl ON fl.id = i.from_location_id AND fl.deleted = 0 ' +
        'LEFT JOIN location tl ON tl.id = i.to_location_id AND tl.deleted = 0 '
      : '';

  const items = db
    .prepare(
      `SELECT ${select}FROM ${cfg.itemTable} i ` +
        'LEFT JOIN product p ON p.id = i.product_id AND p.deleted = 0 ' +
        'LEFT JOIN unit u ON u.id = i.unit_id AND u.deleted = 0 ' +
        locationJoins +
        'LEFT JOIN location l ON l.id = i.location_id AND l.deleted = 0 ' +
        `WHERE i.${cfg.itemFk} = ? AND i.deleted = 0`,
    )
    .all(id) as Row[];

  return { doc: doc as Row, items };
}

export { round2 };
