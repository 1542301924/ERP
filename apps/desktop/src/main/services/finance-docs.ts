/**
 * 财务单据引擎（P4「财务」）：收 / 付款单（`ar_receipt` / `ap_payment`）。
 *
 * 与 `services/documents.ts`（采购 / 销售）和 `services/stock-docs.ts`（调拨 / 盘点）
 * 保持同一套约定：
 *  - 状态机 `0 待审核 → 1 已审核 → 9 已红冲`，**只有已审核（1）才计入核销与账户余额**；
 *  - 保存时服务端权威重建核销明细（`ar_receipt_apply` / `ap_payment_apply`）；
 *  - 审核 / 取消审核 / 红冲后，触发往来单已收（已付）与资金账户余额的**派生重算**；
 *  - 红冲生成反向已审核单据 R（金额取负、核销取负），原单置 9，二者净额为 0。
 *
 * 计入口径（与 `services/finance.ts` 一致）：收付款单 `status ≠ 0`（已审核 1 或已红冲 9）。
 * 派生状态（`ar_bill.received_amount` / `ap_bill.paid_amount` / `account.balance`）
 * 由 `finance.recomputeBillSettled` / `finance.recomputeAccountBalance` 用原始 SQL 写入，
 * 不经 `Repository`、不产生 `_change_log`（符合「同步事实、不同步派生状态」）。
 *
 * 本模块**不依赖 electron**，只依赖 `SqlDatabase` / `Repository`，便于单元测试。
 */

import { DocStatus, type Row } from '@inventory/shared';
import type { Repository } from '../db/repository';
import type { SqlDatabase } from '../db/sqlite';
import { nextCode } from './code-rule';
import type { DocContext } from './documents';
import {
  getSettleDoc,
  listSettleDocs,
  recomputeAccountBalance,
  recomputeBillSettled,
  settleConfig,
  type SettleDocFilter,
  type SettleDocGetResult,
  type SettleDocKind,
  type SettleDocRow,
} from './finance';
import { round2 } from './inventory';
import { writeOpLog } from './op-log';

/** 收付款单保存入参（收 / 付款共用，按 kind 取用相关字段）。 */
export interface SettleDocSaveInput {
  id?: string;
  /** 往来单位（客户 / 供应商）id，服务端按 kind 写入对应字段。 */
  partner_id?: string | null;
  /** 资金账户 id。 */
  account_id?: string | null;
  /** 单据金额（收 / 付总额，恒为正）。 */
  amount?: number;
  /** 业务日期（收款日期 / 付款日期）。 */
  date?: number;
  /** 结算方式（现金 / 转账 / 微信 / 支付宝…）。 */
  method?: string | null;
  remark?: string | null;
  /** 核销明细：往来单 id + 本次核销金额（恒为正）。 */
  applies: Array<{ bill_id: string; amount: number }>;
}

/** 内部：归一化后的核销明细。 */
interface ApplyInput {
  bill_id: string;
  amount: number;
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function config(kind: SettleDocKind) {
  return settleConfig(kind);
}

function loadDoc(db: SqlDatabase, kind: SettleDocKind, id: string): Row {
  const doc = db.prepare(`SELECT * FROM ${kind} WHERE id = ? AND deleted = 0`).get(id);
  if (!doc) throw new Error('单据不存在');
  return doc as Row;
}

/** 读取核销明细（未删除）。 */
function loadApplies(db: SqlDatabase, kind: SettleDocKind, id: string): Row[] {
  const cfg = config(kind);
  return db
    .prepare(`SELECT * FROM ${cfg.applyTable} WHERE ${cfg.applyFk} = ? AND deleted = 0`)
    .all(id) as Row[];
}

/** 惰性创建编号规则并取下一个单据编号。 */
function nextDocNo(db: SqlDatabase, repo: Repository, kind: SettleDocKind): string {
  const cfg = config(kind);
  const existing = db.prepare('SELECT id FROM code_rule WHERE target = ? AND deleted = 0').get(cfg.docNoTarget);
  if (!existing) {
    repo.insert('code_rule', { target: cfg.docNoTarget, prefix: cfg.prefix, category_code: null, seq_len: 5, next_seq: 1 });
  }
  return nextCode(db, repo, cfg.docNoTarget);
}

/** 归一化核销明细：剔除空行 / 非正金额，并按 bill_id 合并同单多笔。 */
function normalizeApplies(applies: ApplyInput[]): ApplyInput[] {
  const merged = new Map<string, number>();
  for (const apply of applies ?? []) {
    const billId = text(apply.bill_id);
    const amount = round2(num(apply.amount));
    if (!billId || amount <= 0) continue;
    merged.set(billId, round2((merged.get(billId) ?? 0) + amount));
  }
  return [...merged.entries()].map(([bill_id, amount]) => ({ bill_id, amount }));
}

/** 校验往来单存在、未删除且属于该往来单位；不匹配时抛中文错误。 */
function assertBillBelongs(db: SqlDatabase, kind: SettleDocKind, partnerId: string, billId: string): void {
  const cfg = config(kind);
  const bill = db
    .prepare(`SELECT ${cfg.partnerField} AS partner FROM ${cfg.billTable} WHERE id = ? AND deleted = 0`)
    .get(billId) as Row | undefined;
  if (!bill) throw new Error('核销的应收 / 应付单不存在');
  if (String(bill.partner ?? '') !== partnerId) throw new Error(`核销的往来单不属于该${cfg.partnerLabel}`);
}

/** 某往单当前「已核销」金额（口径：明细未删除 且 所属收付款单 status ≠ 0）。 */
function settledOfBill(db: SqlDatabase, kind: SettleDocKind, billId: string): number {
  const cfg = config(kind);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(ap.amount), 0) AS s FROM ${cfg.applyTable} ap ` +
        `JOIN ${cfg.table} d ON d.id = ap.${cfg.applyFk} ` +
        `WHERE ap.${cfg.billFk} = ? AND ap.deleted = 0 AND d.deleted = 0 AND d.status <> ?`,
    )
    .get(billId, DocStatus.PENDING_AUDIT) as Row;
  return round2(num(row.s));
}

/** 重建某收付款单的核销明细（保存草稿时调用；先软删旧明细再写新明细）。 */
function rebuildApplies(db: SqlDatabase, repo: Repository, kind: SettleDocKind, docId: string, applies: ApplyInput[]): void {
  const cfg = config(kind);
  const existing = db.prepare(`SELECT id FROM ${cfg.applyTable} WHERE ${cfg.applyFk} = ? AND deleted = 0`).all(docId);
  for (const row of existing) repo.softDelete(cfg.applyTable, String(row.id));
  for (const apply of applies) {
    repo.insert(cfg.applyTable, { [cfg.applyFk]: docId, [cfg.billFk]: apply.bill_id, amount: apply.amount });
  }
}

/** 按核销明细的往来单 id 触发已收 / 已付重算。 */
function recomputeForApplies(db: SqlDatabase, kind: SettleDocKind, applies: Row[]): void {
  const cfg = config(kind);
  const billIds = applies.map((row) => String(row[cfg.billFk] ?? '')).filter(Boolean);
  recomputeBillSettled(db, cfg.billKind, billIds);
}

/** 取消审核 / 红冲前置校验：已红冲不可再操作；已被红冲单引用需先处理。 */
function runGuard(db: SqlDatabase, kind: SettleDocKind, doc: Row): void {
  if (Number(doc.status) === DocStatus.REVERSED) throw new Error('单据已红冲，不能再次操作');
  const hit = db
    .prepare(`SELECT 1 AS x FROM ${kind} WHERE deleted = 0 AND reversal_of = ? LIMIT 1`)
    .get(doc.id as string);
  if (hit) throw new Error('该单据已被红冲单引用，请先处理红冲单');
}

/** 保存收付款单（新建或修改草稿），服务端权威重建核销明细。 */
export function save(
  db: SqlDatabase,
  repo: Repository,
  ctx: DocContext,
  kind: SettleDocKind,
  input: SettleDocSaveInput,
): Row {
  const cfg = config(kind);

  return db.transaction(() => {
    const partnerId = text(input.partner_id);
    if (!partnerId) throw new Error(`${cfg.partnerLabel}必填`);

    const amount = round2(num(input.amount));
    if (amount <= 0) throw new Error('单据金额必须大于 0');

    const applies = normalizeApplies(input.applies ?? []);
    const appliedTotal = round2(applies.reduce((sum, apply) => sum + apply.amount, 0));
    if (appliedTotal > amount + 0.000001) throw new Error('核销金额合计不能超过单据金额');
    for (const apply of applies) {
      if (apply.amount > amount + 0.000001) throw new Error('单笔核销金额不能超过单据金额');
      assertBillBelongs(db, kind, partnerId, apply.bill_id);
    }

    const header: Row = {
      [cfg.partnerField]: partnerId,
      account_id: text(input.account_id),
      amount,
      [cfg.dateField]: input.date ?? ctx.now(),
      method: text(input.method),
      remark: text(input.remark),
    };

    if (input.id) {
      const doc = repo.findById(kind, input.id);
      if (!doc || Number(doc.deleted) === 1) throw new Error('单据不存在');
      if (Number(doc.status) !== DocStatus.PENDING_AUDIT) throw new Error('单据已审核，请先「取消审核」后再修改');

      const updated = repo.update(kind, input.id, header);
      rebuildApplies(db, repo, kind, input.id, applies);
      return updated;
    }

    const values: Row = { ...header };
    values.doc_no = nextDocNo(db, repo, kind);
    values.status = DocStatus.PENDING_AUDIT;
    values.audited_by = null;
    values.audited_at = null;
    values.reversal_of = null;

    const doc = repo.insert(kind, values);
    rebuildApplies(db, repo, kind, doc.id as string, applies);
    return doc;
  });
}

/** 审核收付款单：核销生效（计入已收 / 已付）并重算资金账户余额。 */
export function audit(db: SqlDatabase, repo: Repository, ctx: DocContext, kind: SettleDocKind, id: string): Row {
  const cfg = config(kind);

  return db.transaction(() => {
    const doc = loadDoc(db, kind, id);
    if (Number(doc.status) !== DocStatus.PENDING_AUDIT) throw new Error('单据不是待审核状态，无法审核');

    const applies = loadApplies(db, kind, id);

    // 核销余额前置校验（防止任一往来单被超额核销）
    for (const apply of applies) {
      const billId = String(apply[cfg.billFk] ?? '');
      const bill = db.prepare(`SELECT * FROM ${cfg.billTable} WHERE id = ? AND deleted = 0`).get(billId) as Row | undefined;
      if (!bill) throw new Error('核销的应收 / 应付单不存在');
      const remaining = round2(num(bill.amount) - settledOfBill(db, kind, billId));
      const applyAmount = round2(num(apply.amount));
      if (applyAmount > remaining + 0.000001) {
        throw new Error(`核销金额超过往来单未结清余额（可核销 ${remaining}，本次 ${applyAmount}）`);
      }
    }

    const now = ctx.now();
    const updated = repo.update(kind, id, { status: DocStatus.AUDITED, audited_by: ctx.userId, audited_at: now });
    writeOpLog(db, { user_id: ctx.userId, action: 'audit', entity: kind, entity_id: id, after: updated, device_id: ctx.deviceId, at: now });

    recomputeForApplies(db, kind, applies);
    recomputeAccountBalance(db, (doc.account_id as string | null) ?? undefined);
    return updated;
  });
}

/** 取消审核：状态回 0（核销自动失效），重算已收 / 已付与账户余额。 */
export function unaudit(db: SqlDatabase, repo: Repository, ctx: DocContext, kind: SettleDocKind, id: string): Row {
  return db.transaction(() => {
    const doc = loadDoc(db, kind, id);
    runGuard(db, kind, doc);
    if (Number(doc.status) !== DocStatus.AUDITED) throw new Error('单据不是已审核状态，无法取消审核');

    const applies = loadApplies(db, kind, id);
    const now = ctx.now();
    const updated = repo.update(kind, id, { status: DocStatus.PENDING_AUDIT, audited_by: null, audited_at: null });
    writeOpLog(db, { user_id: ctx.userId, action: 'unaudit', entity: kind, entity_id: id, before: doc, after: updated, device_id: ctx.deviceId, at: now });

    recomputeForApplies(db, kind, applies);
    recomputeAccountBalance(db, (doc.account_id as string | null) ?? undefined);
    return updated;
  });
}

/** 红冲：生成反向已审核单据 R（金额与核销取负），原单置 9；二者净额为 0。 */
export function reverse(
  db: SqlDatabase,
  repo: Repository,
  ctx: DocContext,
  kind: SettleDocKind,
  id: string,
): { doc: Row; reversalDocId: string } {
  const cfg = config(kind);

  return db.transaction(() => {
    const doc = loadDoc(db, kind, id);
    runGuard(db, kind, doc);
    if (Number(doc.status) !== DocStatus.AUDITED) throw new Error('单据不是已审核状态，无法红冲');

    const applies = loadApplies(db, kind, id);
    const now = ctx.now();

    // 1. 反向单据 R：拷贝表头，金额取负，直接置已审核
    const rValues: Row = {
      [cfg.partnerField]: doc[cfg.partnerField] ?? null,
      account_id: doc.account_id ?? null,
      amount: -round2(num(doc.amount)),
      [cfg.dateField]: now,
      method: doc.method ?? null,
      remark: doc.remark ?? null,
      doc_no: nextDocNo(db, repo, kind),
      status: DocStatus.AUDITED,
      audited_by: ctx.userId,
      audited_at: now,
      reversal_of: doc.id,
    };
    const rDoc = repo.insert(kind, rValues);

    // 2. 反向核销明细（金额取负）
    for (const apply of applies) {
      repo.insert(cfg.applyTable, {
        [cfg.applyFk]: rDoc.id,
        [cfg.billFk]: apply[cfg.billFk],
        amount: -round2(num(apply.amount)),
      });
    }

    // 3. 原单置已红冲
    const originalUpdated = repo.update(kind, id, { status: DocStatus.REVERSED });

    writeOpLog(db, { user_id: ctx.userId, action: 'reverse', entity: kind, entity_id: id, before: doc, after: originalUpdated, device_id: ctx.deviceId, at: now });
    writeOpLog(db, { user_id: ctx.userId, action: 'reverse', entity: kind, entity_id: rDoc.id as string, after: rDoc, device_id: ctx.deviceId, at: now });

    // 4. 重算受影响的往来单与账户余额
    const allApplies = db
      .prepare(`SELECT * FROM ${cfg.applyTable} WHERE ${cfg.applyFk} = ? AND deleted = 0`)
      .all(rDoc.id as string) as Row[];
    recomputeForApplies(db, kind, [...applies, ...allApplies]);
    recomputeAccountBalance(db, (doc.account_id as string | null) ?? undefined);

    return { doc: originalUpdated, reversalDocId: rDoc.id as string };
  });
}

/** 收付款单列表（委托 finance 查询服务）。 */
export function list(db: SqlDatabase, kind: SettleDocKind, filter: SettleDocFilter = {}): SettleDocRow[] {
  return listSettleDocs(db, kind, filter);
}

/** 收付款单详情：表头 + 核销明细（委托 finance 查询服务）。 */
export function get(db: SqlDatabase, kind: SettleDocKind, id: string): SettleDocGetResult | null {
  return getSettleDoc(db, kind, id);
}
