/**
 * 报表服务（P5「报表」）：6 张报表 + 导出 Excel。
 *
 * 本模块**不依赖 electron**，只依赖 `SqlDatabase`，便于单元测试；文件落盘由 IPC 层负责。
 *
 * 口径（与 P2 / P3 / P4 一致）：
 *  - **库存类报表**（进销存明细 / 汇总）以 `stock_ledger` 为唯一事实来源：只由流水聚合，
 *    红冲通过「再写一条反向流水」体现，因此净额天然为 0、可完整追溯。
 *  - **单据类报表**（收货 / 发货对账、发货成本、销售毛利）只统计 `status = 1`（已审核）
 *    且 `reversal_of IS NULL`（非红冲单）的单据：被红冲的原单（status = 9）与被红冲产生的
 *    反向单（reversal_of 非空）都不计入，二者净额归零，与 P4「已审核生效」口径一致。
 *  - 数量一律以商品**基本单位**（`base_qty`）计；成本取销售出库明细的 `cost_amount` 成本快照。
 */

import ExcelJS from 'exceljs';
import type { Row } from '@inventory/shared';
import type { SqlDatabase } from '../db/sqlite';
import { round2 } from './inventory';

/** 报表类型。 */
export type ReportKind =
  | 'inventory_detail'
  | 'inventory_summary'
  | 'receipt_statement'
  | 'shipment_statement'
  | 'shipment_cost'
  | 'gross_profit';

/** 统一报表过滤条件（各报表按需取用相关维度）。 */
export interface ReportFilter {
  keyword?: string;
  startDate?: number;
  endDate?: number;
  warehouseId?: string;
  productId?: string;
  customerId?: string;
  supplierId?: string;
  handlerId?: string;
  /** 汇总维度（进销存汇总表 / 销售毛利表使用）。 */
  groupBy?: 'product' | 'warehouse' | 'customer' | 'handler';
}

/** 列数据类型（决定前端与 Excel 的格式化方式）。 */
export type ReportColumnType = 'text' | 'money' | 'qty' | 'percent' | 'date';

/** 报表列定义。 */
export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}

/** 报表结果：列定义 + 数据行 + 可选合计行。 */
export interface ReportResult {
  kind: ReportKind;
  title: string;
  columns: ReportColumn[];
  rows: Row[];
  totals?: Record<string, number>;
}

const TITLES: Record<ReportKind, string> = {
  inventory_detail: '进销存明细表',
  inventory_summary: '进销存汇总表',
  receipt_statement: '收货对账单',
  shipment_statement: '发货对账单',
  shipment_cost: '发货成本表',
  gross_profit: '销售毛利表',
};

// ---------------- 工具 ----------------

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** 由过滤条件拼接日期区间（闭区间），列名由调用方给出。 */
function dateWhere(column: string, filter: ReportFilter): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  if (filter.startDate !== undefined && filter.startDate !== null && Number.isFinite(Number(filter.startDate))) {
    sql.push(`${column} >= ?`);
    params.push(Number(filter.startDate));
  }
  if (filter.endDate !== undefined && filter.endDate !== null && Number.isFinite(Number(filter.endDate))) {
    sql.push(`${column} <= ?`);
    params.push(Number(filter.endDate));
  }
  return { sql, params };
}

function whereClause(parts: string[]): string {
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

/** 计算毛利率（销售额为 0 时记 0）。 */
function grossRate(gross: number, sale: number): number {
  if (Math.abs(sale) <= 0.000001) return 0;
  return Number((gross / sale).toFixed(4));
}

// ---------------- 1. 进销存明细表 ----------------

function inventoryDetail(db: SqlDatabase, filter: ReportFilter): ReportResult {
  const { sql: dateSql, params: dateParams } = dateWhere('g.biz_date', filter);
  const where: string[] = ['g.deleted = 0', ...dateSql];
  const params: unknown[] = [...dateParams];

  if (filter.productId) {
    where.push('g.product_id = ?');
    params.push(filter.productId);
  }
  if (filter.warehouseId) {
    where.push('g.warehouse_id = ?');
    params.push(filter.warehouseId);
  }
  const keyword = filter.keyword?.trim();
  if (keyword) {
    where.push('(g.doc_no LIKE ? OR p.code LIKE ? OR p.name LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  const sql =
    'SELECT g.id, g.biz_date, g.biz_type, g.doc_no, g.doc_type, ' +
    'g.qty_in, g.qty_out, g.unit_cost, g.amount, g.reversal_of, ' +
    'p.code AS product_code, p.name AS product_name, u.name AS unit_name, ' +
    'w.name AS warehouse_name, l.name AS location_name ' +
    'FROM stock_ledger g ' +
    'LEFT JOIN product p ON p.id = g.product_id ' +
    'LEFT JOIN unit u ON u.id = p.base_unit_id ' +
    'LEFT JOIN warehouse w ON w.id = g.warehouse_id ' +
    'LEFT JOIN location l ON l.id = g.location_id ' +
    `${whereClause(where)} ORDER BY g.biz_date DESC, g.doc_no DESC`;

  const rows = db.prepare(sql).all(...params) as Row[];
  let totalIn = 0;
  let totalOut = 0;
  let totalAmount = 0;
  const mapped = rows.map((row) => {
    const qtyIn = round2(num(row.qty_in));
    const qtyOut = round2(num(row.qty_out));
    const amount = round2(num(row.amount));
    totalIn = round2(totalIn + qtyIn);
    totalOut = round2(totalOut + qtyOut);
    totalAmount = round2(totalAmount + amount);
    return {
      id: String(row.id),
      biz_date: num(row.biz_date),
      biz_type: str(row.biz_type),
      doc_no: str(row.doc_no),
      product_code: str(row.product_code),
      product_name: str(row.product_name),
      unit_name: str(row.unit_name),
      warehouse_name: str(row.warehouse_name),
      location_name: str(row.location_name),
      qty_in: qtyIn,
      qty_out: qtyOut,
      unit_cost: round2(num(row.unit_cost)),
      amount,
      reversal: row.reversal_of ? '红冲' : '',
    };
  });

  return {
    kind: 'inventory_detail',
    title: TITLES.inventory_detail,
    columns: [
      { key: 'biz_date', label: '业务日期', type: 'date' },
      { key: 'biz_type', label: '业务类型', type: 'text' },
      { key: 'doc_no', label: '单据编号', type: 'text' },
      { key: 'product_code', label: '商品编号', type: 'text' },
      { key: 'product_name', label: '商品名称', type: 'text' },
      { key: 'warehouse_name', label: '仓库', type: 'text' },
      { key: 'location_name', label: '货位', type: 'text' },
      { key: 'unit_name', label: '单位', type: 'text' },
      { key: 'qty_in', label: '入库数量', type: 'qty' },
      { key: 'qty_out', label: '出库数量', type: 'qty' },
      { key: 'unit_cost', label: '单位成本', type: 'money' },
      { key: 'amount', label: '金额', type: 'money' },
      { key: 'reversal', label: '冲销', type: 'text' },
    ],
    rows: mapped,
    totals: { qty_in: totalIn, qty_out: totalOut, amount: totalAmount },
  };
}

// ---------------- 2. 进销存汇总表 ----------------

function inventorySummary(db: SqlDatabase, filter: ReportFilter): ReportResult {
  const groupByWarehouse = filter.groupBy === 'warehouse';
  const start = filter.startDate !== undefined && filter.startDate !== null && Number.isFinite(Number(filter.startDate))
    ? Math.floor(Number(filter.startDate))
    : null;
  const end = filter.endDate !== undefined && filter.endDate !== null && Number.isFinite(Number(filter.endDate))
    ? Math.floor(Number(filter.endDate))
    : null;

  // 期初：区间开始前的净额；本期：区间内的入 / 出。二者直接用流水条件聚合（数字由后端归一，无注入风险）。
  const beforeCond = start !== null ? `g.biz_date < ${start}` : '0';
  const inCond = `(${start !== null ? `g.biz_date >= ${start} AND ` : ''}${end !== null ? `g.biz_date <= ${end}` : '1'})`;

  const where: string[] = ['g.deleted = 0'];
  const params: unknown[] = [];
  if (filter.productId) {
    where.push('g.product_id = ?');
    params.push(filter.productId);
  }
  if (filter.warehouseId) {
    where.push('g.warehouse_id = ?');
    params.push(filter.warehouseId);
  }
  const keyword = filter.keyword?.trim();
  if (keyword) {
    where.push('(p.code LIKE ? OR p.name LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const groupCols = groupByWarehouse ? 'p.id, g.warehouse_id' : 'p.id';
  const sql =
    'SELECT p.id AS product_id, p.code AS product_code, p.name AS product_name, u.name AS unit_name, ' +
    (groupByWarehouse ? 'g.warehouse_id, w.name AS warehouse_name, ' : '') +
    `SUM(CASE WHEN ${beforeCond} THEN (g.qty_in - g.qty_out) ELSE 0 END) AS init_qty, ` +
    `SUM(CASE WHEN ${beforeCond} THEN (g.qty_in * g.unit_cost - g.qty_out * g.unit_cost) ELSE 0 END) AS init_amount, ` +
    `SUM(CASE WHEN ${inCond} THEN g.qty_in ELSE 0 END) AS in_qty, ` +
    `SUM(CASE WHEN ${inCond} THEN g.qty_in * g.unit_cost ELSE 0 END) AS in_amount, ` +
    `SUM(CASE WHEN ${inCond} THEN g.qty_out ELSE 0 END) AS out_qty, ` +
    `SUM(CASE WHEN ${inCond} THEN g.qty_out * g.unit_cost ELSE 0 END) AS out_amount ` +
    'FROM stock_ledger g ' +
    'JOIN product p ON p.id = g.product_id ' +
    'LEFT JOIN unit u ON u.id = p.base_unit_id ' +
    (groupByWarehouse ? 'LEFT JOIN warehouse w ON w.id = g.warehouse_id ' : '') +
    `${whereClause(where)} GROUP BY ${groupCols} ORDER BY p.code${groupByWarehouse ? ', w.name' : ''}`;

  const rows = db.prepare(sql).all(...params) as Row[];
  const totals = { init_qty: 0, init_amount: 0, in_qty: 0, in_amount: 0, out_qty: 0, out_amount: 0, end_qty: 0, end_amount: 0 };
  const mapped = rows.map((row) => {
    const initQty = round2(num(row.init_qty));
    const initAmount = round2(num(row.init_amount));
    const inQty = round2(num(row.in_qty));
    const inAmount = round2(num(row.in_amount));
    const outQty = round2(num(row.out_qty));
    const outAmount = round2(num(row.out_amount));
    const endQty = round2(initQty + inQty - outQty);
    const endAmount = round2(initAmount + inAmount - outAmount);
    totals.init_qty = round2(totals.init_qty + initQty);
    totals.init_amount = round2(totals.init_amount + initAmount);
    totals.in_qty = round2(totals.in_qty + inQty);
    totals.in_amount = round2(totals.in_amount + inAmount);
    totals.out_qty = round2(totals.out_qty + outQty);
    totals.out_amount = round2(totals.out_amount + outAmount);
    totals.end_qty = round2(totals.end_qty + endQty);
    totals.end_amount = round2(totals.end_amount + endAmount);
    return {
      product_code: str(row.product_code),
      product_name: str(row.product_name),
      ...(groupByWarehouse ? { warehouse_name: str(row.warehouse_name) } : {}),
      unit_name: str(row.unit_name),
      init_qty: initQty,
      init_amount: initAmount,
      in_qty: inQty,
      in_amount: inAmount,
      out_qty: outQty,
      out_amount: outAmount,
      end_qty: endQty,
      end_amount: endAmount,
    };
  });

  const columns: ReportColumn[] = [
    { key: 'product_code', label: '商品编号', type: 'text' },
    { key: 'product_name', label: '商品名称', type: 'text' },
    ...(groupByWarehouse ? [{ key: 'warehouse_name', label: '仓库', type: 'text' as const }] : []),
    { key: 'unit_name', label: '单位', type: 'text' },
    { key: 'init_qty', label: '期初数量', type: 'qty' },
    { key: 'init_amount', label: '期初金额', type: 'money' },
    { key: 'in_qty', label: '本期入库数量', type: 'qty' },
    { key: 'in_amount', label: '本期入库金额', type: 'money' },
    { key: 'out_qty', label: '本期出库数量', type: 'qty' },
    { key: 'out_amount', label: '本期出库金额', type: 'money' },
    { key: 'end_qty', label: '期末数量', type: 'qty' },
    { key: 'end_amount', label: '期末金额', type: 'money' },
  ];

  return { kind: 'inventory_summary', title: TITLES.inventory_summary, columns, rows: mapped, totals };
}

// ---------------- 3. 收货对账单 ----------------

function receiptStatement(db: SqlDatabase, filter: ReportFilter): ReportResult {
  const { sql: dateSql, params: dateParams } = dateWhere('d.biz_date', filter);
  const docWhere: string[] = ["d.deleted = 0", 'd.status = 1', 'd.reversal_of IS NULL', "d.inbound_type = '采购'", ...dateSql];
  const docParams: unknown[] = [...dateParams];
  if (filter.supplierId) {
    docWhere.push('d.supplier_id = ?');
    docParams.push(filter.supplierId);
  }

  const docsCte = `docs AS (SELECT d.id, d.supplier_id, d.total_amount FROM purchase_inbound d ${whereClause(docWhere)})`;

  const sql =
    `WITH ${docsCte}, ` +
    'q AS (SELECT d.supplier_id AS sid, COALESCE(SUM(it.base_qty), 0) AS qty ' +
    'FROM docs d JOIN purchase_inbound_item it ON it.inbound_id = d.id AND it.deleted = 0 GROUP BY d.supplier_id), ' +
    'a AS (SELECT supplier_id AS sid, COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS amount FROM docs GROUP BY supplier_id), ' +
    'p AS (SELECT d.supplier_id AS sid, COALESCE(SUM(b.amount), 0) AS payable, COALESCE(SUM(b.paid_amount), 0) AS paid ' +
    'FROM docs d JOIN ap_bill b ON b.source_inbound_id = d.id AND b.deleted = 0 GROUP BY d.supplier_id) ' +
    'SELECT s.id AS supplier_id, s.name AS supplier_name, ' +
    'COALESCE(a.cnt, 0) AS doc_count, COALESCE(q.qty, 0) AS in_qty, COALESCE(a.amount, 0) AS in_amount, ' +
    'COALESCE(p.payable, 0) AS payable_amount, COALESCE(p.paid, 0) AS paid_amount ' +
    'FROM supplier s LEFT JOIN a ON a.sid = s.id LEFT JOIN q ON q.sid = s.id LEFT JOIN p ON p.sid = s.id ' +
    'WHERE s.deleted = 0 AND (a.cnt IS NOT NULL OR p.sid IS NOT NULL) ORDER BY s.name';

  const rows = db.prepare(sql).all(...docParams) as Row[];
  const totals = { doc_count: 0, in_qty: 0, in_amount: 0, payable_amount: 0, paid_amount: 0, unpaid_amount: 0 };
  const mapped = rows.map((row) => {
    const inQty = round2(num(row.in_qty));
    const inAmount = round2(num(row.in_amount));
    const payable = round2(num(row.payable_amount));
    const paid = round2(num(row.paid_amount));
    const unpaid = round2(payable - paid);
    totals.doc_count += num(row.doc_count);
    totals.in_qty = round2(totals.in_qty + inQty);
    totals.in_amount = round2(totals.in_amount + inAmount);
    totals.payable_amount = round2(totals.payable_amount + payable);
    totals.paid_amount = round2(totals.paid_amount + paid);
    totals.unpaid_amount = round2(totals.unpaid_amount + unpaid);
    return {
      supplier_name: str(row.supplier_name),
      doc_count: num(row.doc_count),
      in_qty: inQty,
      in_amount: inAmount,
      payable_amount: payable,
      paid_amount: paid,
      unpaid_amount: unpaid,
    };
  });

  return {
    kind: 'receipt_statement',
    title: TITLES.receipt_statement,
    columns: [
      { key: 'supplier_name', label: '供应商', type: 'text' },
      { key: 'doc_count', label: '入库单数', type: 'qty' },
      { key: 'in_qty', label: '入库数量', type: 'qty' },
      { key: 'in_amount', label: '入库金额', type: 'money' },
      { key: 'payable_amount', label: '应付金额', type: 'money' },
      { key: 'paid_amount', label: '已付金额', type: 'money' },
      { key: 'unpaid_amount', label: '未付金额', type: 'money' },
    ],
    rows: mapped,
    totals,
  };
}

// ---------------- 4. 发货对账单 ----------------

function shipmentStatement(db: SqlDatabase, filter: ReportFilter): ReportResult {
  const { sql: dateSql, params: dateParams } = dateWhere('d.biz_date', filter);
  const docWhere: string[] = ["d.deleted = 0", 'd.status = 1', 'd.reversal_of IS NULL', "d.outbound_type = '销售'", ...dateSql];
  const docParams: unknown[] = [...dateParams];
  if (filter.customerId) {
    docWhere.push('d.customer_id = ?');
    docParams.push(filter.customerId);
  }

  const docsCte = `docs AS (SELECT d.id, d.customer_id, d.total_amount FROM sales_outbound d ${whereClause(docWhere)})`;

  const sql =
    `WITH ${docsCte}, ` +
    'q AS (SELECT d.customer_id AS sid, COALESCE(SUM(it.base_qty), 0) AS qty ' +
    'FROM docs d JOIN sales_outbound_item it ON it.outbound_id = d.id AND it.deleted = 0 GROUP BY d.customer_id), ' +
    'a AS (SELECT customer_id AS sid, COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS amount FROM docs GROUP BY customer_id), ' +
    'p AS (SELECT d.customer_id AS sid, COALESCE(SUM(b.amount), 0) AS receivable, COALESCE(SUM(b.received_amount), 0) AS received ' +
    'FROM docs d JOIN ar_bill b ON b.source_outbound_id = d.id AND b.deleted = 0 GROUP BY d.customer_id) ' +
    'SELECT c.id AS customer_id, c.name AS customer_name, ' +
    'COALESCE(a.cnt, 0) AS doc_count, COALESCE(q.qty, 0) AS out_qty, COALESCE(a.amount, 0) AS out_amount, ' +
    'COALESCE(p.receivable, 0) AS receivable_amount, COALESCE(p.received, 0) AS received_amount ' +
    'FROM customer c LEFT JOIN a ON a.sid = c.id LEFT JOIN q ON q.sid = c.id LEFT JOIN p ON p.sid = c.id ' +
    'WHERE c.deleted = 0 AND (a.cnt IS NOT NULL OR p.sid IS NOT NULL) ORDER BY c.name';

  const rows = db.prepare(sql).all(...docParams) as Row[];
  const totals = { doc_count: 0, out_qty: 0, out_amount: 0, receivable_amount: 0, received_amount: 0, unreceived_amount: 0 };
  const mapped = rows.map((row) => {
    const outQty = round2(num(row.out_qty));
    const outAmount = round2(num(row.out_amount));
    const receivable = round2(num(row.receivable_amount));
    const received = round2(num(row.received_amount));
    const unreceived = round2(receivable - received);
    totals.doc_count += num(row.doc_count);
    totals.out_qty = round2(totals.out_qty + outQty);
    totals.out_amount = round2(totals.out_amount + outAmount);
    totals.receivable_amount = round2(totals.receivable_amount + receivable);
    totals.received_amount = round2(totals.received_amount + received);
    totals.unreceived_amount = round2(totals.unreceived_amount + unreceived);
    return {
      customer_name: str(row.customer_name),
      doc_count: num(row.doc_count),
      out_qty: outQty,
      out_amount: outAmount,
      receivable_amount: receivable,
      received_amount: received,
      unreceived_amount: unreceived,
    };
  });

  return {
    kind: 'shipment_statement',
    title: TITLES.shipment_statement,
    columns: [
      { key: 'customer_name', label: '客户', type: 'text' },
      { key: 'doc_count', label: '出库单数', type: 'qty' },
      { key: 'out_qty', label: '出库数量', type: 'qty' },
      { key: 'out_amount', label: '出库金额', type: 'money' },
      { key: 'receivable_amount', label: '应收金额', type: 'money' },
      { key: 'received_amount', label: '已收金额', type: 'money' },
      { key: 'unreceived_amount', label: '未收金额', type: 'money' },
    ],
    rows: mapped,
    totals,
  };
}

// ---------------- 5. 发货成本表 ----------------

function shipmentCost(db: SqlDatabase, filter: ReportFilter): ReportResult {
  const { sql: dateSql, params: dateParams } = dateWhere('d.biz_date', filter);
  const where: string[] = ["d.deleted = 0", 'd.status = 1', 'd.reversal_of IS NULL', "d.outbound_type = '销售'", ...dateSql];
  const params: unknown[] = [...dateParams];
  if (filter.customerId) {
    where.push('d.customer_id = ?');
    params.push(filter.customerId);
  }
  // 商品过滤出现在 JOIN 的 ON 子句中（SQL 文本位置早于 WHERE），故其占位符须排在 WHERE 参数之前
  const itemWhere: string[] = ['it.deleted = 0'];
  const itemParams: unknown[] = [];
  if (filter.productId) {
    itemWhere.push('it.product_id = ?');
    itemParams.push(filter.productId);
  }

  const sql =
    'SELECT d.id AS doc_id, d.doc_no, d.biz_date, c.name AS customer_name, ' +
    'COUNT(it.id) AS item_count, ' +
    'COALESCE(SUM(it.amount), 0) AS sale_amount, COALESCE(SUM(it.cost_amount), 0) AS cost_amount ' +
    'FROM sales_outbound d ' +
    'LEFT JOIN customer c ON c.id = d.customer_id AND c.deleted = 0 ' +
    `JOIN sales_outbound_item it ON it.outbound_id = d.id AND ${itemWhere.join(' AND ')} ` +
    `${whereClause(where)} GROUP BY d.id ORDER BY d.biz_date DESC, d.doc_no DESC`;

  const rows = db.prepare(sql).all(...itemParams, ...params) as Row[];
  const totals = { item_count: 0, sale_amount: 0, cost_amount: 0, gross_profit: 0 };
  const mapped = rows.map((row) => {
    const sale = round2(num(row.sale_amount));
    const cost = round2(num(row.cost_amount));
    const gross = round2(sale - cost);
    totals.item_count += num(row.item_count);
    totals.sale_amount = round2(totals.sale_amount + sale);
    totals.cost_amount = round2(totals.cost_amount + cost);
    totals.gross_profit = round2(totals.gross_profit + gross);
    return {
      doc_no: str(row.doc_no),
      biz_date: num(row.biz_date),
      customer_name: str(row.customer_name),
      item_count: num(row.item_count),
      sale_amount: sale,
      cost_amount: cost,
      gross_profit: gross,
      gross_rate: grossRate(gross, sale),
    };
  });

  return {
    kind: 'shipment_cost',
    title: TITLES.shipment_cost,
    columns: [
      { key: 'doc_no', label: '单据编号', type: 'text' },
      { key: 'biz_date', label: '业务日期', type: 'date' },
      { key: 'customer_name', label: '客户', type: 'text' },
      { key: 'item_count', label: '商品项数', type: 'qty' },
      { key: 'sale_amount', label: '销售金额', type: 'money' },
      { key: 'cost_amount', label: '成本金额', type: 'money' },
      { key: 'gross_profit', label: '毛利', type: 'money' },
      { key: 'gross_rate', label: '毛利率', type: 'percent' },
    ],
    rows: mapped,
    totals,
  };
}

// ---------------- 6. 销售毛利表 ----------------

function grossProfit(db: SqlDatabase, filter: ReportFilter): ReportResult {
  const mode = filter.groupBy === 'customer' || filter.groupBy === 'handler' ? filter.groupBy : 'product';
  const { sql: dateSql, params: dateParams } = dateWhere('d.biz_date', filter);
  const where: string[] = ["d.deleted = 0", 'd.status = 1', 'd.reversal_of IS NULL', "d.outbound_type = '销售'", ...dateSql];
  const params: unknown[] = [...dateParams];
  if (filter.customerId) {
    where.push('d.customer_id = ?');
    params.push(filter.customerId);
  }
  if (filter.productId) {
    where.push('it.product_id = ?');
    params.push(filter.productId);
  }
  if (filter.handlerId) {
    where.push('d.handler_id = ?');
    params.push(filter.handlerId);
  }

  const group =
    mode === 'customer'
      ? { cols: 'c.id', dims: 'c.id AS dim_id, c.name AS dim_name', join: 'LEFT JOIN customer c ON c.id = d.customer_id AND c.deleted = 0 ' }
      : mode === 'handler'
        ? { cols: 'd.handler_id', dims: 'd.handler_id AS dim_id, u.name AS dim_name', join: 'LEFT JOIN app_user u ON u.id = d.handler_id AND u.deleted = 0 ' }
        : { cols: 'p.id', dims: 'p.id AS dim_id, p.code AS dim_code, p.name AS dim_name', join: 'JOIN product p ON p.id = it.product_id AND p.deleted = 0 ' };

  const sql =
    'SELECT ' +
    group.dims +
    ', COALESCE(SUM(it.base_qty), 0) AS sale_qty, COALESCE(SUM(it.amount), 0) AS sale_amount, ' +
    'COALESCE(SUM(it.cost_amount), 0) AS cost_amount ' +
    'FROM sales_outbound d ' +
    'LEFT JOIN sales_outbound_item it ON it.outbound_id = d.id AND it.deleted = 0 ' +
    group.join +
    `${whereClause(where)} GROUP BY ${group.cols} ORDER BY sale_amount DESC`;

  const rows = db.prepare(sql).all(...params) as Row[];
  const totals = { sale_qty: 0, sale_amount: 0, cost_amount: 0, gross_profit: 0 };
  const mapped = rows.map((row) => {
    const saleQty = round2(num(row.sale_qty));
    const sale = round2(num(row.sale_amount));
    const cost = round2(num(row.cost_amount));
    const gross = round2(sale - cost);
    totals.sale_qty = round2(totals.sale_qty + saleQty);
    totals.sale_amount = round2(totals.sale_amount + sale);
    totals.cost_amount = round2(totals.cost_amount + cost);
    totals.gross_profit = round2(totals.gross_profit + gross);
    return {
      dim_code: str(row.dim_code),
      dim_name: str(row.dim_name),
      sale_qty: saleQty,
      sale_amount: sale,
      cost_amount: cost,
      gross_profit: gross,
      gross_rate: grossRate(gross, sale),
    };
  });

  const label = mode === 'customer' ? '客户' : mode === 'handler' ? '业务员' : '商品';
  const columns: ReportColumn[] = [
    ...(mode === 'product' ? [{ key: 'dim_code', label: '商品编号', type: 'text' as const }] : []),
    { key: 'dim_name', label, type: 'text' },
    { key: 'sale_qty', label: '销售数量', type: 'qty' },
    { key: 'sale_amount', label: '销售额', type: 'money' },
    { key: 'cost_amount', label: '成本额', type: 'money' },
    { key: 'gross_profit', label: '毛利', type: 'money' },
    { key: 'gross_rate', label: '毛利率', type: 'percent' },
  ];

  return { kind: 'gross_profit', title: TITLES.gross_profit, columns, rows: mapped, totals };
}

// ---------------- 入口 ----------------

/** 报表标题（供前端展示 / 导出文件名）。 */
export function reportTitle(kind: ReportKind): string {
  const title = TITLES[kind];
  if (!title) throw new Error(`未知报表: ${kind}`);
  return title;
}

/** 运行报表。 */
export function runReport(db: SqlDatabase, kind: ReportKind, filter: ReportFilter = {}): ReportResult {
  switch (kind) {
    case 'inventory_detail':
      return inventoryDetail(db, filter);
    case 'inventory_summary':
      return inventorySummary(db, filter);
    case 'receipt_statement':
      return receiptStatement(db, filter);
    case 'shipment_statement':
      return shipmentStatement(db, filter);
    case 'shipment_cost':
      return shipmentCost(db, filter);
    case 'gross_profit':
      return grossProfit(db, filter);
    default:
      throw new Error(`未知报表: ${String(kind)}`);
  }
}

// ---------------- 导出 Excel ----------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateCell(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 把报表结果写为 Excel Buffer（中文表头 + 合计行）。 */
export async function buildReportBuffer(result: ReportResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(result.title);
  ws.addRow(result.columns.map((c) => c.label));

  for (const row of result.rows) {
    const cells = result.columns.map((c) => {
      const value = row[c.key];
      if (c.type === 'date') return value === null || value === undefined ? null : formatDateCell(num(value));
      if (c.type === 'money' || c.type === 'qty') return value === null || value === undefined ? null : num(value);
      if (c.type === 'percent') return value === null || value === undefined ? null : Math.round(num(value) * 10000) / 100;
      return value === null || value === undefined ? null : String(value);
    });
    ws.addRow(cells);
  }

  if (result.totals) {
    const totalRow = result.columns.map((c, i) =>
      i === 0 ? '合计' : result.totals && c.key in result.totals ? result.totals[c.key] : null,
    );
    ws.addRow(totalRow);
    ws.getRow(ws.rowCount).font = { bold: true };
  }

  result.columns.forEach((_, i) => {
    ws.getColumn(i + 1).width = 16;
  });
  ws.getRow(1).font = { bold: true };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
