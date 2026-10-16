import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import type { SqlDatabase } from '../src/main/db/sqlite';
import { assertAvailable, availableQty, avgCost, ledgerSummary, round2 } from '../src/main/services/inventory';

const T = 1_700_000_000_000;

function makeRepo(db: SqlDatabase): Repository {
  return new Repository(db, { userId: 'u1', deviceId: 'devT', clock: createHlc('devT') }, () => T);
}

/** 造商品 / 仓库主数据（用于报错文案与聚合）。 */
function seedRef(db: SqlDatabase, repo: Repository): void {
  repo.insert('product', { code: 'P001', name: '螺丝', status: 1 }, 'p1');
  repo.insert('warehouse', { name: '主仓', status: 1 }, 'w1');
}

test('ledgerSummary / avgCost：多次入库不同单价的移动加权平均', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);

  repo.insert('stock_ledger', { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', qty_in: 10, unit_cost: 3, amount: 30, biz_date: T });
  repo.insert('stock_ledger', { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', qty_in: 10, unit_cost: 5, amount: 50, biz_date: T });

  const afterIn = ledgerSummary(db, { product_id: 'p1', warehouse_id: 'w1' });
  assert.equal(afterIn.qty, 20);
  assert.equal(afterIn.cost_amount, 80);
  assert.equal(afterIn.avg_cost, 4);
  assert.equal(avgCost(db, { product_id: 'p1', warehouse_id: 'w1' }), 4);

  // 出库 4：按均价 4 计成本 16，剩余 16 件 / 成本 64，均价仍为 4
  repo.insert('stock_ledger', { biz_type: '销售出库', product_id: 'p1', warehouse_id: 'w1', qty_out: 4, unit_cost: 4, amount: 16, biz_date: T });

  const afterOut = ledgerSummary(db, { product_id: 'p1', warehouse_id: 'w1' });
  assert.equal(afterOut.qty, 16);
  assert.equal(afterOut.cost_amount, 64);
  assert.equal(afterOut.avg_cost, 4);
  assert.equal(availableQty(db, { product_id: 'p1', warehouse_id: 'w1' }), 16);

  db.close();
});

test('availableQty：可按库位细分，也可按仓库跨库位聚合', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);

  repo.insert('stock_ledger', { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', location_id: 'loc1', qty_in: 10, unit_cost: 1, amount: 10, biz_date: T });
  repo.insert('stock_ledger', { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', location_id: 'loc2', qty_in: 5, unit_cost: 1, amount: 5, biz_date: T });
  repo.insert('stock_ledger', { biz_type: '销售出库', product_id: 'p1', warehouse_id: 'w1', location_id: 'loc1', qty_out: 2, unit_cost: 1, amount: 2, biz_date: T });

  assert.equal(availableQty(db, { product_id: 'p1', warehouse_id: 'w1' }), 13);
  assert.equal(availableQty(db, { product_id: 'p1', warehouse_id: 'w1', location_id: 'loc1' }), 8);
  assert.equal(availableQty(db, { product_id: 'p1', warehouse_id: 'w1', location_id: 'loc2' }), 5);

  db.close();
});

test('assertAvailable：按维度聚合，不足时抛出含商品名与仓库名的中文错误', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  seedRef(db, repo);

  repo.insert('stock_ledger', { biz_type: '采购入库', product_id: 'p1', warehouse_id: 'w1', qty_in: 5, unit_cost: 1, amount: 5, biz_date: T });

  // 足够：不抛
  assert.doesNotThrow(() => assertAvailable(db, [{ product_id: 'p1', warehouse_id: 'w1', qty: 5 }], false));

  // 不足：报错含完整文案
  assert.throws(
    () => assertAvailable(db, [{ product_id: 'p1', warehouse_id: 'w1', qty: 10 }], false),
    /库存不足：商品「螺丝」在仓库「主仓」可用 5，需 10/,
  );

  // 聚合：3 + 4 = 7 > 5
  assert.throws(
    () =>
      assertAvailable(
        db,
        [
          { product_id: 'p1', warehouse_id: 'w1', qty: 3 },
          { product_id: 'p1', warehouse_id: 'w1', qty: 4 },
        ],
        false,
      ),
    /可用 5，需 7/,
  );

  // allowNegative 时直接放行
  assert.doesNotThrow(() => assertAvailable(db, [{ product_id: 'p1', warehouse_id: 'w1', qty: 100 }], true));

  db.close();
});

test('round2：金额四舍五入到分', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(2.344), 2.34);
  assert.equal(round2(10), 10);
});
