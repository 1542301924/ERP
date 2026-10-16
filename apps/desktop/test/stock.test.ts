import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import type { SqlDatabase } from '../src/main/db/sqlite';
import { alertList, listBalance, listLedger, recomputeBalance } from '../src/main/services/stock';

const T = 1_700_000_000_000;

function makeRepo(db: SqlDatabase): Repository {
  return new Repository(db, { userId: 'u1', deviceId: 'devT', clock: createHlc('devT') }, () => T);
}

/** 造商品 / 仓库 / 库位主数据。 */
function seedRef(db: SqlDatabase, repo: Repository): void {
  repo.insert('product', { code: 'P001', name: '螺丝', base_unit_id: 'u_ge', status: 1 }, 'p1');
  repo.insert('warehouse', { name: '主仓', status: 1 }, 'w1');
  repo.insert('warehouse', { name: '分仓', status: 1 }, 'w2');
  repo.insert('location', { warehouse_id: 'w1', name: 'A-01', status: 1 }, 'loc1');
}

function ledgerRow(repo: Repository, values: Record<string, unknown>): void {
  repo.insert('stock_ledger', { biz_date: T, ...values });
}

function balanceOf(db: SqlDatabase, productId: string, warehouseId: string): Record<string, unknown> | undefined {
  return db
    .prepare('SELECT * FROM stock_balance WHERE product_id = ? AND warehouse_id = ?')
    .get(productId, warehouseId);
}

test('recomputeBalance：由流水聚合，数量/成本/均价正确，且多次重算幂等', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);

  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', qty_in: 10, unit_cost: 3, amount: 30 });
  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', qty_in: 10, unit_cost: 5, amount: 50 });

  const first = recomputeBalance(db);
  assert.equal(first, 1);

  const bal = balanceOf(db, 'p1', 'w1')!;
  assert.equal(bal.qty, 20);
  assert.equal(bal.cost_amount, 80);
  assert.equal(bal.avg_cost, 4);

  // 再次全量重算：结果不变（幂等）
  const second = recomputeBalance(db);
  assert.equal(second, 1);
  assert.equal(balanceOf(db, 'p1', 'w1')!.qty, 20);
  assert.equal(balanceOf(db, 'p1', 'w1')!.cost_amount, 80);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM stock_balance').get()!.c), 1);

  db.close();
});

test('recomputeBalance：增量重算只重建指定维度，其他维度保持不变', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);

  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', qty_in: 10, unit_cost: 3, amount: 30 });
  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p2', warehouse_id: 'w1', qty_in: 5, unit_cost: 2, amount: 10 });
  assert.equal(recomputeBalance(db), 2);

  const p2Before = balanceOf(db, 'p2', 'w1')!;
  assert.equal(p2Before.qty, 5);

  // p1 新增一条流水，仅对 p1 增量重算
  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', qty_in: 10, unit_cost: 7, amount: 70 });
  assert.equal(recomputeBalance(db, { productId: 'p1' }), 1);
  assert.equal(balanceOf(db, 'p1', 'w1')!.qty, 20);
  assert.equal(balanceOf(db, 'p1', 'w1')!.cost_amount, 100);
  // p2 维度未被触碰
  assert.equal(balanceOf(db, 'p2', 'w1')!.qty, 5);

  db.close();
});

test('listBalance：默认隐藏零库存行，includeZero 时显示；关键字与仓库过滤生效', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  seedRef(db, repo);

  // p1 入 10 出 10 => 余额 0；p2 入 5 => 余额 5
  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', qty_in: 10, unit_cost: 1, amount: 10 });
  ledgerRow(repo, { biz_type: '销售出库', product_id: 'p1', warehouse_id: 'w1', qty_out: 10, unit_cost: 1, amount: 10 });
  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p2', warehouse_id: 'w2', qty_in: 5, unit_cost: 2, amount: 10 });
  recomputeBalance(db);

  const visible = listBalance(db);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].product_id, 'p2');

  const withZero = listBalance(db, { includeZero: true });
  assert.equal(withZero.length, 2);

  // 仓库过滤
  const onlyW1 = listBalance(db, { warehouseId: 'w1', includeZero: true });
  assert.equal(onlyW1.length, 1);
  assert.equal(onlyW1[0].product_id, 'p1');

  // 关键字命中商品名（螺丝）——需要补种子主数据
  repo.insert('product', { code: 'P002', name: '螺母', base_unit_id: 'u_ge', status: 1 }, 'p2');
  recomputeBalance(db);
  const byName = listBalance(db, { keyword: '螺母', includeZero: true });
  assert.equal(byName.length, 1);
  assert.equal(byName[0].product_name, '螺母');

  db.close();
});

test('listLedger：可按业务类型 / 单据编号过滤，按业务日期倒序', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  seedRef(db, repo);

  ledgerRow(repo, { biz_type: '采购入库', doc_no: 'RK0001', product_id: 'p1', warehouse_id: 'w1', qty_in: 10, unit_cost: 1, amount: 10, biz_date: T });
  ledgerRow(repo, { biz_type: '销售出库', doc_no: 'CK0001', product_id: 'p1', warehouse_id: 'w1', qty_out: 2, unit_cost: 1, amount: 2, biz_date: T + 1000 });

  assert.equal(listLedger(db).length, 2);
  assert.equal(listLedger(db, { bizType: '采购入库' }).length, 1);
  assert.equal(listLedger(db, { keyword: 'CK0001' }).length, 1);
  assert.equal(listLedger(db, { keyword: 'RK0001' })[0].biz_type, '采购入库');

  // 倒序：最新业务日期在前
  const all = listLedger(db);
  assert.equal(all[0].biz_type, '销售出库');

  db.close();
});

test('alertList：低于下限记 low，高于上限记 high，无阈值商品不告警', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  seedRef(db, repo);
  repo.insert('product', { code: 'P002', name: '螺母', min_stock: 10, status: 1 }, 'p2');
  repo.insert('product', { code: 'P003', name: '垫片', max_stock: 3, status: 1 }, 'p3');
  repo.insert('product', { code: 'P004', name: '无阈值', status: 1 }, 'p4');

  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', qty_in: 100, unit_cost: 1, amount: 100 });
  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p2', warehouse_id: 'w1', qty_in: 5, unit_cost: 1, amount: 5 });
  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p3', warehouse_id: 'w1', qty_in: 8, unit_cost: 1, amount: 8 });
  ledgerRow(repo, { biz_type: '采购入库', product_id: 'p4', warehouse_id: 'w1', qty_in: 8, unit_cost: 1, amount: 8 });
  recomputeBalance(db);

  const alerts = alertList(db);
  const byProduct = new Map(alerts.map((a) => [a.product_id, a]));
  assert.equal(alerts.length, 2);
  assert.equal(byProduct.get('p2')!.level, 'low');
  assert.equal(byProduct.get('p3')!.level, 'high');
  assert.equal(byProduct.has('p1'), false);
  assert.equal(byProduct.has('p4'), false);

  db.close();
});
