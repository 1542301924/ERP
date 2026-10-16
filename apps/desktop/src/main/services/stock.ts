/**
 * 库存服务（P3「库存」）。
 *
 * 本模块**不依赖 electron**，只依赖 `SqlDatabase`，便于单元测试。
 *
 * 口径（与 P2 `inventory.ts` 一致）：
 *  - `stock_ledger` 是唯一事实来源（append-only）；`stock_balance` 是**派生表**（不含同步字段），
 *    由流水重算得到，**禁止经 Repository 写入**，因此这里一律用原始 SQL。
 *  - 数量 / 成本金额 / 移动加权平均单价一律以商品**基本单位**记账。
 *  - 重算**幂等**：余额只由流水聚合决定，与流水写入顺序无关（多端同步后重算结果收敛一致）。
 */

import type { SqlDatabase } from '../db/sqlite';

/** 重算过滤范围（缺省即全量重算）。 */
export interface RecomputeFilter {
  productId?: string;
  warehouseId?: string;
}

/** 实时库存行（余额 + 主数据名称）。 */
export interface BalanceRow {
  id: string;
  product_id: string;
  product_code: string | null;
  product_name: string | null;
  unit_id: string | null;
  unit_name: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
  location_id: string | null;
  location_name: string | null;
  qty: number;
  locked_qty: number;
  avail_qty: number;
  cost_amount: number;
  avg_cost: number;
  min_stock: number | null;
  max_stock: number | null;
}

/** 库存流水行（流水 + 主数据名称）。 */
export interface LedgerRow {
  id: string;
  biz_type: string;
  doc_type: string | null;
  doc_id: string | null;
  doc_no: string | null;
  product_id: string;
  product_code: string | null;
  product_name: string | null;
  unit_name: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
  location_id: string | null;
  location_name: string | null;
  qty_in: number;
  qty_out: number;
  unit_cost: number;
  amount: number;
  biz_date: number;
  operator_id: string | null;
  reversal_of: string | null;
  remark: string | null;
}

/** 库存预警行（按商品跨仓库汇总）。 */
export interface AlertRow {
  product_id: string;
  product_code: string | null;
  product_name: string | null;
  unit_name: string | null;
  total_qty: number;
  min_stock: number | null;
  max_stock: number | null;
  level: 'low' | 'high';
}

/** 由过滤条件拼接 `product_id` / `warehouse_id` 的 WHERE 片段（列名为固定字面量）。 */
function scopeWhere(filter: RecomputeFilter): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.productId) {
    where.push('product_id = ?');
    params.push(filter.productId);
  }
  if (filter.warehouseId) {
    where.push('warehouse_id = ?');
    params.push(filter.warehouseId);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * 由 `stock_ledger` 重算 `stock_balance`（按 商品 + 仓库 + 库位 维度）。
 *
 * 实现为「先清空受影响范围的派生行，再按流水聚合重建」，因此天然幂等。
 * 返回写入的余额行数。
 */
export function recomputeBalance(db: SqlDatabase, filter: RecomputeFilter = {}): number {
  return db.transaction(() => {
    const { sql: whereSql, params } = scopeWhere(filter);

    // 1. 清空受影响范围的派生行（stock_balance 为派生表，可安全重建）
    db.prepare(`DELETE FROM stock_balance ${whereSql}`).run(...params);

    // 2. 按流水聚合：数量 = 入 − 出；成本金额 = 入成本 − 出成本（amount 恒为正数绝对值）
    const rows = db
      .prepare(
        'SELECT product_id, warehouse_id, location_id, ' +
          'COALESCE(SUM(qty_in), 0) - COALESCE(SUM(qty_out), 0) AS qty, ' +
          'COALESCE(SUM(CASE WHEN qty_in > 0 THEN amount ELSE 0 END), 0) - ' +
          'COALESCE(SUM(CASE WHEN qty_out > 0 THEN amount ELSE 0 END), 0) AS cost_amount ' +
          `FROM stock_ledger ${whereSql} ` +
          'GROUP BY product_id, warehouse_id, location_id',
      )
      .all(...params);

    const recomputedAt = Date.now();
    const fromSeq = Number(
      db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM _change_log WHERE entity = 'stock_ledger'").get()?.s ?? 0,
    );
    const insert = db.prepare(
      'INSERT INTO stock_balance ' +
        '(id, product_id, warehouse_id, location_id, qty, locked_qty, avail_qty, cost_amount, avg_cost, recomputed_at, recomputed_from_seq) ' +
        'VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
    );

    for (const row of rows) {
      const qty = Number(row.qty ?? 0);
      const costAmount = Number(row.cost_amount ?? 0);
      const locationId = row.location_id === null || row.location_id === undefined ? null : String(row.location_id);
      // 移动加权平均：剩余成本 / 剩余数量；数量为 0 时均价记 0（避免除零）
      const avgCost = qty !== 0 ? costAmount / qty : 0;
      insert.run(
        `${row.product_id}:${row.warehouse_id}:${locationId ?? ''}`,
        row.product_id,
        row.warehouse_id,
        locationId,
        qty,
        qty, // 可用量 = 现有量 − 占用量（P3 暂无占用概念）
        costAmount,
        avgCost,
        recomputedAt,
        fromSeq,
      );
    }

    return rows.length;
  });
}

/** 重算并返回写入行数的便捷别名（供 IPC / 审核挂接调用）。 */
export function recompute(db: SqlDatabase, filter: RecomputeFilter = {}): { rows: number } {
  return { rows: recomputeBalance(db, filter) };
}

/** 实时库存查询：按 商品 / 仓库 / 库位 筛选（默认隐藏数量为 0 的行）。 */
export function listBalance(
  db: SqlDatabase,
  filter: {
    keyword?: string;
    productId?: string;
    warehouseId?: string;
    locationId?: string;
    includeZero?: boolean;
  } = {},
): BalanceRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!filter.includeZero) where.push('b.qty <> 0');
  if (filter.productId) {
    where.push('b.product_id = ?');
    params.push(filter.productId);
  }
  if (filter.warehouseId) {
    where.push('b.warehouse_id = ?');
    params.push(filter.warehouseId);
  }
  if (filter.locationId) {
    where.push('b.location_id = ?');
    params.push(filter.locationId);
  }
  const keyword = filter.keyword?.trim();
  if (keyword) {
    where.push('(p.code LIKE ? OR p.name LIKE ? OR p.barcode LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  const sql =
    'SELECT b.id, b.product_id, b.warehouse_id, b.location_id, b.qty, b.locked_qty, b.avail_qty, ' +
    'b.cost_amount, b.avg_cost, p.code AS product_code, p.name AS product_name, ' +
    'p.base_unit_id AS unit_id, u.name AS unit_name, p.min_stock, p.max_stock, ' +
    'w.name AS warehouse_name, l.name AS location_name ' +
    'FROM stock_balance b ' +
    'LEFT JOIN product p ON p.id = b.product_id ' +
    'LEFT JOIN unit u ON u.id = p.base_unit_id ' +
    'LEFT JOIN warehouse w ON w.id = b.warehouse_id ' +
    'LEFT JOIN location l ON l.id = b.location_id ' +
    (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
    'ORDER BY p.code, w.name, l.name';

  return db.prepare(sql).all(...params) as unknown as BalanceRow[];
}

/** 库存流水查询（只读；append-only，供追溯与红冲入口）。 */
export function listLedger(
  db: SqlDatabase,
  filter: {
    keyword?: string;
    productId?: string;
    warehouseId?: string;
    bizType?: string;
    docId?: string;
    startDate?: number;
    endDate?: number;
    limit?: number;
  } = {},
): LedgerRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.productId) {
    where.push('g.product_id = ?');
    params.push(filter.productId);
  }
  if (filter.warehouseId) {
    where.push('g.warehouse_id = ?');
    params.push(filter.warehouseId);
  }
  if (filter.bizType) {
    where.push('g.biz_type = ?');
    params.push(filter.bizType);
  }
  if (filter.docId) {
    where.push('g.doc_id = ?');
    params.push(filter.docId);
  }
  if (filter.startDate !== undefined && filter.startDate !== null) {
    where.push('g.biz_date >= ?');
    params.push(filter.startDate);
  }
  if (filter.endDate !== undefined && filter.endDate !== null) {
    where.push('g.biz_date <= ?');
    params.push(filter.endDate);
  }
  const keyword = filter.keyword?.trim();
  if (keyword) {
    where.push('(g.doc_no LIKE ? OR p.code LIKE ? OR p.name LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  const limitSuffix = filter.limit ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : '';

  const sql =
    'SELECT g.id, g.biz_type, g.doc_type, g.doc_id, g.doc_no, g.product_id, g.warehouse_id, g.location_id, ' +
    'g.qty_in, g.qty_out, g.unit_cost, g.amount, g.biz_date, g.operator_id, g.reversal_of, g.remark, ' +
    'p.code AS product_code, p.name AS product_name, u.name AS unit_name, ' +
    'w.name AS warehouse_name, l.name AS location_name ' +
    'FROM stock_ledger g ' +
    'LEFT JOIN product p ON p.id = g.product_id ' +
    'LEFT JOIN unit u ON u.id = p.base_unit_id ' +
    'LEFT JOIN warehouse w ON w.id = g.warehouse_id ' +
    'LEFT JOIN location l ON l.id = g.location_id ' +
    (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
    `ORDER BY g.biz_date DESC, g.created_at DESC${limitSuffix}`;

  return db.prepare(sql).all(...params) as unknown as LedgerRow[];
}

/** 库存预警：按商品跨仓库汇总，低于 `min_stock` 记 low，高于 `max_stock` 记 high。 */
export function alertList(db: SqlDatabase): AlertRow[] {
  const rows = db
    .prepare(
      'SELECT * FROM (' +
        'SELECT p.id AS product_id, p.code AS product_code, p.name AS product_name, ' +
        'u.name AS unit_name, p.min_stock AS min_stock, p.max_stock AS max_stock, ' +
        'COALESCE(SUM(b.qty), 0) AS total_qty ' +
        'FROM product p ' +
        'LEFT JOIN stock_balance b ON b.product_id = p.id ' +
        'LEFT JOIN unit u ON u.id = p.base_unit_id ' +
        'WHERE p.deleted = 0 ' +
        'GROUP BY p.id' +
        ') t ' +
        'WHERE (min_stock IS NOT NULL AND total_qty < min_stock) ' +
        'OR (max_stock IS NOT NULL AND total_qty > max_stock) ' +
        'ORDER BY product_code',
    )
    .all();

  return rows.map((row) => {
    const totalQty = Number(row.total_qty ?? 0);
    const minStock = row.min_stock === null || row.min_stock === undefined ? null : Number(row.min_stock);
    const maxStock = row.max_stock === null || row.max_stock === undefined ? null : Number(row.max_stock);
    const level: 'low' | 'high' = minStock !== null && totalQty < minStock ? 'low' : 'high';
    return {
      product_id: String(row.product_id),
      product_code: row.product_code === null ? null : String(row.product_code),
      product_name: row.product_name === null ? null : String(row.product_name),
      unit_name: row.unit_name === null ? null : String(row.unit_name),
      total_qty: totalQty,
      min_stock: minStock,
      max_stock: maxStock,
      level,
    };
  });
}
