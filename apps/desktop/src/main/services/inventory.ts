/**
 * 库存服务（P2「出入库」）：由 `stock_ledger` 派生可用量与移动加权平均成本。
 *
 * 本模块**不依赖 electron**，只依赖 `SqlDatabase`，便于单元测试。
 *
 * 约定（全局一致）：
 *  - `stock_ledger.amount` 恒为该次变动的**正数绝对金额**（成本）。
 *  - `qty = Σ(qty_in) − Σ(qty_out)`。
 *  - `cost_amount = Σ(amount where qty_in>0) − Σ(amount where qty_out>0)`。
 *  - `avg_cost = qty !== 0 ? cost_amount / qty : 0`。
 */

import type { SqlDatabase } from '../db/sqlite';

/** 库存维度键；`location_id` 缺省时按仓库聚合（跨库位）。 */
export interface StockKey {
  product_id: string;
  warehouse_id: string;
  location_id?: string | null;
}

/** 参与可用量校验的一条需求。 */
export interface StockNeed {
  product_id: string;
  warehouse_id: string;
  location_id?: string | null;
  qty: number;
}

/** 库存汇总。 */
export interface LedgerSummary {
  qty: number;
  cost_amount: number;
  avg_cost: number;
}

/** 金额四舍五入到分（保留 2 位小数）。 */
export function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** 构造维度过滤条件（仅拼接固有列名，值走参数化）。 */
function stockWhere(key: StockKey): { sql: string; params: unknown[] } {
  const where = ['product_id = ?', 'warehouse_id = ?'];
  const params: unknown[] = [key.product_id, key.warehouse_id];
  if (key.location_id !== undefined && key.location_id !== null) {
    where.push('location_id = ?');
    params.push(key.location_id);
  }
  return { sql: where.join(' AND '), params };
}

/** 读取某表某 id 的 name（用于中文报错文案），缺失时回退为 id 本身。 */
function lookupName(db: SqlDatabase, table: string, id: string): string {
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id);
  return row?.name ? String(row.name) : id;
}

/** 可用量（= 现有量，P2 暂无占用量概念）。 */
export function availableQty(db: SqlDatabase, key: StockKey): number {
  const { sql, params } = stockWhere(key);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty_in), 0) - COALESCE(SUM(qty_out), 0) AS qty FROM stock_ledger WHERE ${sql}`,
    )
    .get(...params);
  return Number(row?.qty ?? 0);
}

/** 库存汇总：数量 / 成本金额 / 移动加权平均单价。 */
export function ledgerSummary(db: SqlDatabase, key: StockKey): LedgerSummary {
  const { sql, params } = stockWhere(key);
  const row = db
    .prepare(
      'SELECT ' +
        'COALESCE(SUM(qty_in), 0) - COALESCE(SUM(qty_out), 0) AS qty, ' +
        'COALESCE(SUM(CASE WHEN qty_in > 0 THEN amount ELSE 0 END), 0) - ' +
        'COALESCE(SUM(CASE WHEN qty_out > 0 THEN amount ELSE 0 END), 0) AS cost_amount ' +
        `FROM stock_ledger WHERE ${sql}`,
    )
    .get(...params);
  const qty = Number(row?.qty ?? 0);
  const cost_amount = Number(row?.cost_amount ?? 0);
  return { qty, cost_amount, avg_cost: qty !== 0 ? cost_amount / qty : 0 };
}

/** 移动加权平均成本。 */
export function avgCost(db: SqlDatabase, key: StockKey): number {
  return ledgerSummary(db, key).avg_cost;
}

/**
 * 校验可用量：按 (商品, 仓库, 库位) 聚合需求，不足时抛出**一条**中文错误，
 * 逐条列出所有不足行（`；` 连接）。
 */
export function assertAvailable(db: SqlDatabase, needs: StockNeed[], allowNegative: boolean): void {
  if (allowNegative) return;

  const aggregated = new Map<string, Required<StockNeed>>();
  for (const need of needs) {
    const locationId = need.location_id ?? null;
    const key = `${need.product_id}|${need.warehouse_id}|${locationId ?? ''}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.qty += Number(need.qty);
    } else {
      aggregated.set(key, {
        product_id: need.product_id,
        warehouse_id: need.warehouse_id,
        location_id: locationId,
        qty: Number(need.qty),
      });
    }
  }

  const lines: string[] = [];
  for (const need of aggregated.values()) {
    const available = availableQty(db, {
      product_id: need.product_id,
      warehouse_id: need.warehouse_id,
      location_id: need.location_id,
    });
    if (need.qty > available) {
      const productName = lookupName(db, 'product', need.product_id);
      const warehouseName = lookupName(db, 'warehouse', need.warehouse_id);
      lines.push(`商品「${productName}」在仓库「${warehouseName}」可用 ${available}，需 ${need.qty}`);
    }
  }

  if (lines.length > 0) throw new Error(`库存不足：${lines.join('；')}`);
}
