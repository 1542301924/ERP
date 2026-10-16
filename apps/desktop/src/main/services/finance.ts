/**
 * 财务查询服务（P4「财务」）。
 *
 * 本模块**不依赖 electron**，只依赖 `SqlDatabase`，便于单元测试。
 *
 * 口径（与设计 §5.6 / D3 一致）：
 *  - `ar_bill` / `ap_bill` 是**由单据审核派生的事实**（应收 / 应付单），本模块只读。
 *  - 结清状态**由金额派生**：`remaining = amount − 已收/已付`，据此判定 未结清 / 部分 / 已结清。
 *  - `account.balance` 是**派生计数**，由「已审核收款单 − 已审核付款单」重算得到，
 *    因此这里用原始 SQL 写入（不经 Repository、不同步该计数，符合「同步事实、不同步派生状态」）。
 *  - 资金账户流水由 `ar_receipt` / `ap_payment`（已审核）合并派生，不单独建流水表。
 */

import { DocStatus, type Row } from '@inventory/shared';
import type { SqlDatabase } from '../db/sqlite';
import { round2 } from './inventory';

/** 往来单类型：应收 / 应付。 */
export type BillKind = 'ar' | 'ap';

/** 收付款单类型。 */
export type SettleDocKind = 'ar_receipt' | 'ap_payment';

/** 结清状态（派生）。 */
export type SettleState = 'unsettled' | 'partial' | 'settled';

/** 往来单过滤条件。 */
export interface BillFilter {
  keyword?: string;
  partnerId?: string;
  settleState?: SettleState;
  onlyOutstanding?: boolean;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 往来单行（单据 + 派生展示字段 + 未结清余额）。 */
export interface BillRow {
  id: string;
  partner_id: string;
  partner_name: string | null;
  source_doc_no: string | null;
  amount: number;
  settled_amount: number;
  remaining: number;
  settle_state: SettleState;
  status: number;
  due_date: number | null;
  created_at: number;
}

/** 收付款单过滤条件。 */
export interface SettleDocFilter {
  keyword?: string;
  partnerId?: string;
  accountId?: string;
  status?: number;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 收付款单行（单据 + 派生展示字段）。 */
export interface SettleDocRow {
  id: string;
  doc_no: string | null;
  partner_id: string | null;
  partner_name: string | null;
  account_id: string | null;
  account_name: string | null;
  amount: number;
  applied_amount: number;
  date: number | null;
  method: string | null;
  remark: string | null;
  status: number;
  reversal_of: string | null;
}

/** 核销明细行（核销 + 对应往来单信息）。 */
export interface SettleApplyRow {
  id: string;
  bill_id: string | null;
  bill_amount: number;
  bill_settled: number;
  bill_source_doc_no: string | null;
  bill_created_at: number | null;
  amount: number;
}

/** 收付款单详情：表头 + 核销明细。 */
export interface SettleDocGetResult {
  doc: Row;
  applies: SettleApplyRow[];
}

/** 资金账户流水过滤条件。 */
export interface AccountFlowFilter {
  accountId?: string;
  direction?: 'in' | 'out';
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 资金账户流水行（由收付款单派生）。 */
export interface AccountFlowRow {
  id: string;
  date: number | null;
  account_id: string | null;
  account_name: string | null;
  direction: 'in' | 'out';
  doc_no: string | null;
  partner_name: string | null;
  amount: number;
  status: number;
}

/** 往来单配置（表名 / 列名为硬编码字面量，按 kind 选择）。 */
interface BillConfig {
  billTable: string;
  partnerField: string;
  partnerTable: string;
  sourceField: string;
  sourceTable: string;
  amountField: string;
}

const BILL_CONFIG: Record<BillKind, BillConfig> = {
  ar: {
    billTable: 'ar_bill',
    partnerField: 'customer_id',
    partnerTable: 'customer',
    sourceField: 'source_outbound_id',
    sourceTable: 'sales_outbound',
    amountField: 'received_amount',
  },
  ap: {
    billTable: 'ap_bill',
    partnerField: 'supplier_id',
    partnerTable: 'supplier',
    sourceField: 'source_inbound_id',
    sourceTable: 'purchase_inbound',
    amountField: 'paid_amount',
  },
};

/** 收付款单配置。 */
interface SettleConfig {
  table: string;
  applyTable: string;
  applyFk: string;
  billTable: string;
  billFk: string;
  partnerField: string;
  partnerTable: string;
  amountField: string;
  dateField: string;
  docNoTarget: string;
  prefix: string;
  partnerLabel: string;
  billKind: BillKind;
}

const SETTLE_CONFIG: Record<SettleDocKind, SettleConfig> = {
  ar_receipt: {
    table: 'ar_receipt',
    applyTable: 'ar_receipt_apply',
    applyFk: 'receipt_id',
    billTable: 'ar_bill',
    billFk: 'ar_bill_id',
    partnerField: 'customer_id',
    partnerTable: 'customer',
    amountField: 'received_amount',
    dateField: 'receive_date',
    docNoTarget: 'doc_no.ar_receipt',
    prefix: 'SK',
    partnerLabel: '客户',
    billKind: 'ar',
  },
  ap_payment: {
    table: 'ap_payment',
    applyTable: 'ap_payment_apply',
    applyFk: 'payment_id',
    billTable: 'ap_bill',
    billFk: 'ap_bill_id',
    partnerField: 'supplier_id',
    partnerTable: 'supplier',
    amountField: 'paid_amount',
    dateField: 'pay_date',
    docNoTarget: 'doc_no.ap_payment',
    prefix: 'FK',
    partnerLabel: '供应商',
    billKind: 'ap',
  },
};

function billConfig(kind: BillKind): BillConfig {
  const cfg = BILL_CONFIG[kind];
  if (!cfg) throw new Error(`未知往来单类型: ${kind}`);
  return cfg;
}

export function settleConfig(kind: SettleDocKind): SettleConfig {
  const cfg = SETTLE_CONFIG[kind];
  if (!cfg) throw new Error(`未知收付款单类型: ${kind}`);
  return cfg;
}

/** 由金额派生结清状态。 */
function settleState(amount: number, settled: number): SettleState {
  if (Math.abs(amount) <= 0.000001) return 'settled';
  const remaining = round2(amount - settled);
  if (remaining <= 0.000001) return 'settled';
  if (Math.abs(settled) > 0.000001) return 'partial';
  return 'unsettled';
}

/** 应收 / 应付单列表（含往来单名、来源单号与未结清余额）。 */
export function listBills(db: SqlDatabase, kind: BillKind, filter: BillFilter = {}): BillRow[] {
  const cfg = billConfig(kind);
  const where: string[] = ['b.deleted = 0'];
  const params: unknown[] = [];

  if (filter.partnerId) {
    where.push(`b.${cfg.partnerField} = ?`);
    params.push(filter.partnerId);
  }
  if (filter.startDate !== undefined && filter.startDate !== null) {
    where.push('b.created_at >= ?');
    params.push(filter.startDate);
  }
  if (filter.endDate !== undefined && filter.endDate !== null) {
    where.push('b.created_at <= ?');
    params.push(filter.endDate);
  }
  const keyword = filter.keyword?.trim();
  if (keyword) {
    where.push(`(sd.doc_no LIKE ? OR pt.name LIKE ?)`);
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (filter.onlyOutstanding || filter.settleState) {
    const remainingExpr = `(b.amount - COALESCE(b.${cfg.amountField}, 0))`;
    if (filter.onlyOutstanding) where.push(`${remainingExpr} > 0.000001`);
    if (filter.settleState === 'settled') where.push(`ABS(b.amount) <= 0.000001 OR ${remainingExpr} <= 0.000001`);
    if (filter.settleState === 'unsettled') {
      where.push(`COALESCE(b.${cfg.amountField}, 0) <= 0.000001 AND ${remainingExpr} > 0.000001`);
    }
    if (filter.settleState === 'partial') {
      where.push(`COALESCE(b.${cfg.amountField}, 0) > 0.000001 AND ${remainingExpr} > 0.000001`);
    }
  }

  const limitSuffix = filter.limit ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : '';

  const sql =
    `SELECT b.id, b.${cfg.partnerField} AS partner_id, pt.name AS partner_name, ` +
    `sd.doc_no AS source_doc_no, b.amount, COALESCE(b.${cfg.amountField}, 0) AS settled_amount, ` +
    `(b.amount - COALESCE(b.${cfg.amountField}, 0)) AS remaining, b.status, b.due_date, b.created_at ` +
    `FROM ${cfg.billTable} b ` +
    `LEFT JOIN ${cfg.partnerTable} pt ON pt.id = b.${cfg.partnerField} AND pt.deleted = 0 ` +
    `LEFT JOIN ${cfg.sourceTable} sd ON sd.id = b.${cfg.sourceField} AND sd.deleted = 0 ` +
    `WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC${limitSuffix}`;

  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => {
    const amount = round2(Number(row.amount ?? 0));
    const settled = round2(Number(row.settled_amount ?? 0));
    return {
      id: String(row.id),
      partner_id: String(row.partner_id ?? ''),
      partner_name: row.partner_name === null ? null : String(row.partner_name),
      source_doc_no: row.source_doc_no === null || row.source_doc_no === undefined ? null : String(row.source_doc_no),
      amount,
      settled_amount: settled,
      remaining: round2(amount - settled),
      settle_state: settleState(amount, settled),
      status: Number(row.status ?? 0),
      due_date: row.due_date === null || row.due_date === undefined ? null : Number(row.due_date),
      created_at: Number(row.created_at ?? 0),
    };
  });
}

/** 收付款单列表。 */
export function listSettleDocs(db: SqlDatabase, kind: SettleDocKind, filter: SettleDocFilter = {}): SettleDocRow[] {
  const cfg = settleConfig(kind);
  const where: string[] = ['d.deleted = 0'];
  const params: unknown[] = [];

  if (filter.partnerId) {
    where.push(`d.${cfg.partnerField} = ?`);
    params.push(filter.partnerId);
  }
  if (filter.accountId) {
    where.push('d.account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.status !== undefined && filter.status !== null) {
    where.push('d.status = ?');
    params.push(filter.status);
  }
  if (filter.startDate !== undefined && filter.startDate !== null) {
    where.push(`d.${cfg.dateField} >= ?`);
    params.push(filter.startDate);
  }
  if (filter.endDate !== undefined && filter.endDate !== null) {
    where.push(`d.${cfg.dateField} <= ?`);
    params.push(filter.endDate);
  }
  const keyword = filter.keyword?.trim();
  if (keyword) {
    where.push('(d.doc_no LIKE ? OR d.remark LIKE ? OR pt.name LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  const limitSuffix = filter.limit ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : '';

  const sql =
    `SELECT d.*, pt.name AS partner_name, acc.name AS account_name, ` +
    `(SELECT COALESCE(SUM(ap.amount), 0) FROM ${cfg.applyTable} ap WHERE ap.${cfg.applyFk} = d.id AND ap.deleted = 0) AS applied_amount ` +
    `FROM ${cfg.table} d ` +
    `LEFT JOIN ${cfg.partnerTable} pt ON pt.id = d.${cfg.partnerField} AND pt.deleted = 0 ` +
    `LEFT JOIN account acc ON acc.id = d.account_id AND acc.deleted = 0 ` +
    `WHERE ${where.join(' AND ')} ORDER BY d.${cfg.dateField} DESC, d.doc_no DESC${limitSuffix}`;

  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => ({
    id: String(row.id),
    doc_no: row.doc_no === null || row.doc_no === undefined ? null : String(row.doc_no),
    partner_id: row[cfg.partnerField] === null || row[cfg.partnerField] === undefined ? null : String(row[cfg.partnerField]),
    partner_name: row.partner_name === null || row.partner_name === undefined ? null : String(row.partner_name),
    account_id: row.account_id === null || row.account_id === undefined ? null : String(row.account_id),
    account_name: row.account_name === null || row.account_name === undefined ? null : String(row.account_name),
    amount: round2(Number(row.amount ?? 0)),
    applied_amount: round2(Number(row.applied_amount ?? 0)),
    date: row[cfg.dateField] === null || row[cfg.dateField] === undefined ? null : Number(row[cfg.dateField]),
    method: row.method === null || row.method === undefined ? null : String(row.method),
    remark: row.remark === null || row.remark === undefined ? null : String(row.remark),
    status: Number(row.status ?? 0),
    reversal_of: row.reversal_of === null || row.reversal_of === undefined ? null : String(row.reversal_of),
  }));
}

/** 收付款单详情（表头 + 核销明细）。 */
export function getSettleDoc(db: SqlDatabase, kind: SettleDocKind, id: string): SettleDocGetResult | null {
  const cfg = settleConfig(kind);
  const doc = db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ? AND deleted = 0`).get(id);
  if (!doc) return null;

  const billCfg = BILL_CONFIG[cfg.billKind];
  const applies = db
    .prepare(
      `SELECT ap.id, ap.${cfg.billFk} AS bill_id, ap.amount, ` +
        `COALESCE(b.amount, 0) AS bill_amount, COALESCE(b.${billCfg.amountField}, 0) AS bill_settled, ` +
        `sd.doc_no AS bill_source_doc_no, b.created_at AS bill_created_at ` +
        `FROM ${cfg.applyTable} ap ` +
        `LEFT JOIN ${cfg.billTable} b ON b.id = ap.${cfg.billFk} ` +
        `LEFT JOIN ${billCfg.sourceTable} sd ON sd.id = b.${billCfg.sourceField} AND sd.deleted = 0 ` +
        `WHERE ap.${cfg.applyFk} = ? AND ap.deleted = 0`,
    )
    .all(id);

  return {
    doc: doc as Row,
    applies: applies.map((row) => ({
      id: String(row.id),
      bill_id: row.bill_id === null || row.bill_id === undefined ? null : String(row.bill_id),
      bill_amount: round2(Number(row.bill_amount ?? 0)),
      bill_settled: round2(Number(row.bill_settled ?? 0)),
      bill_source_doc_no:
        row.bill_source_doc_no === null || row.bill_source_doc_no === undefined ? null : String(row.bill_source_doc_no),
      bill_created_at: row.bill_created_at === null || row.bill_created_at === undefined ? null : Number(row.bill_created_at),
      amount: round2(Number(row.amount ?? 0)),
    })),
  };
}

/** 某往来单位下「可核销」的往来单（未结清余额 > 0）。 */
export function openBills(db: SqlDatabase, kind: BillKind, partnerId: string): BillRow[] {
  return listBills(db, kind, { partnerId, onlyOutstanding: true });
}

/** 资金账户列表（含派生余额）。 */
export function listAccounts(db: SqlDatabase): Row[] {
  return db.prepare('SELECT * FROM account WHERE deleted = 0 ORDER BY name').all();
}

/** 往来单 → 核销明细表映射（用于由核销明细重算已收/已付）。 */
const BILL_APPLY: Record<BillKind, { applyTable: string; applyFk: string; billFk: string; docTable: string }> = {
  ar: { applyTable: 'ar_receipt_apply', applyFk: 'receipt_id', billFk: 'ar_bill_id', docTable: 'ar_receipt' },
  ap: { applyTable: 'ap_payment_apply', applyFk: 'payment_id', billFk: 'ap_bill_id', docTable: 'ap_payment' },
};

/**
 * 由核销明细重算往来单的「已收 / 已付」金额（派生计数，原始 SQL 写入）。
 *
 * 计入口径：核销明细未删除，且其所属收付款单 `status ≠ 0`（即已审核 1 或已红冲 9）。
 * 这样「取消审核」（状态回 0）自然使该单核销失效；「红冲」保留原单（9）并追加负向 R（1），净额为 0。
 */
export function recomputeBillSettled(db: SqlDatabase, kind: BillKind, billIds: string[]): void {
  const cfg = BILL_APPLY[kind];
  const billCfg = billConfig(kind);
  const seen = new Set<string>();
  for (const billId of billIds) {
    if (!billId || seen.has(billId)) continue;
    seen.add(billId);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(ap.amount), 0) AS s FROM ${cfg.applyTable} ap ` +
          `JOIN ${cfg.docTable} d ON d.id = ap.${cfg.applyFk} ` +
          `WHERE ap.${cfg.billFk} = ? AND ap.deleted = 0 AND d.deleted = 0 AND d.status <> ?`,
      )
      .get(billId, DocStatus.PENDING_AUDIT) as Row;
    db.prepare(`UPDATE ${billCfg.billTable} SET ${billCfg.amountField} = ? WHERE id = ?`).run(
      round2(Number(row.s ?? 0)),
      billId,
    );
  }
}

/**
 * 由「收款单 − 付款单」重算资金账户余额（可指定账户，缺省全量）。
 * 返回更新的账户数。余额是派生计数，直接用原始 SQL 写入（不走 Repository）。
 * 计入口径同 `recomputeBillSettled`：`status ≠ 0`（已审核 1 / 已红冲 9）。
 */
export function recomputeAccountBalance(db: SqlDatabase, accountId?: string): number {
  const ids: string[] = accountId
    ? [accountId]
    : db
        .prepare('SELECT id FROM account WHERE deleted = 0')
        .all()
        .map((r) => String(r.id));

  for (const id of ids) {
    const received = Number(
      (db
        .prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM ar_receipt WHERE account_id = ? AND deleted = 0 AND status <> ?')
        .get(id, DocStatus.PENDING_AUDIT) as Row).s ?? 0,
    );
    const paid = Number(
      (db
        .prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM ap_payment WHERE account_id = ? AND deleted = 0 AND status <> ?')
        .get(id, DocStatus.PENDING_AUDIT) as Row).s ?? 0,
    );
    db.prepare('UPDATE account SET balance = ? WHERE id = ?').run(round2(received - paid), id);
  }
  return ids.length;
}

/** 资金账户流水（由已审核收付款单合并派生）。 */
export function accountFlow(db: SqlDatabase, filter: AccountFlowFilter = {}): AccountFlowRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.accountId) {
    where.push('t.account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.direction) {
    where.push('t.direction = ?');
    params.push(filter.direction === 'in' ? 'in' : 'out');
  }
  if (filter.startDate !== undefined && filter.startDate !== null) {
    where.push('t.biz_date >= ?');
    params.push(filter.startDate);
  }
  if (filter.endDate !== undefined && filter.endDate !== null) {
    where.push('t.biz_date <= ?');
    params.push(filter.endDate);
  }
  const limitSuffix = filter.limit ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : '';

  const union =
    "SELECT r.id AS id, r.receive_date AS biz_date, r.account_id AS account_id, 'in' AS direction, " +
    "r.doc_no AS doc_no, c.name AS partner_name, r.amount AS amount, r.status AS status " +
    'FROM ar_receipt r LEFT JOIN customer c ON c.id = r.customer_id AND c.deleted = 0 ' +
    'WHERE r.deleted = 0 AND r.status <> ' + DocStatus.PENDING_AUDIT +
    ' UNION ALL ' +
    "SELECT p.id AS id, p.pay_date AS biz_date, p.account_id AS account_id, 'out' AS direction, " +
    'p.doc_no AS doc_no, s.name AS partner_name, p.amount AS amount, p.status AS status ' +
    'FROM ap_payment p LEFT JOIN supplier s ON s.id = p.supplier_id AND s.deleted = 0 ' +
    'WHERE p.deleted = 0 AND p.status <> ' + DocStatus.PENDING_AUDIT;

  const sql =
    'SELECT t.*, acc.name AS account_name FROM (' +
    union +
    ') t LEFT JOIN account acc ON acc.id = t.account_id AND acc.deleted = 0 ' +
    (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
    `ORDER BY t.biz_date DESC, t.doc_no DESC${limitSuffix}`;

  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => ({
    id: String(row.id),
    date: row.biz_date === null || row.biz_date === undefined ? null : Number(row.biz_date),
    account_id: row.account_id === null || row.account_id === undefined ? null : String(row.account_id),
    account_name: row.account_name === null || row.account_name === undefined ? null : String(row.account_name),
    direction: row.direction === 'in' ? 'in' : 'out',
    doc_no: row.doc_no === null || row.doc_no === undefined ? null : String(row.doc_no),
    partner_name: row.partner_name === null || row.partner_name === undefined ? null : String(row.partner_name),
    amount: round2(Number(row.amount ?? 0)),
    status: Number(row.status ?? 0),
  }));
}
