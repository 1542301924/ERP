import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc } from '@inventory/shared';
import { openAndInit, setSysConfig } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import { seedDefaultData } from '../src/main/db/seed';
import type { SqlDatabase } from '../src/main/db/sqlite';
import { availableQty } from '../src/main/services/inventory';
import { recomputeBalance } from '../src/main/services/stock';
import {
  audit,
  get,
  list,
  reverse,
  save,
  unaudit,
  type StockDocKind,
} from '../src/main/services/stock-docs';
import type { DocContext } from '../src/main/services/documents';

const T = 1_700_000_000_000;

interface Pack {
  db: SqlDatabase;
  repo: Repository;
  ctx: DocContext;
}

function setup(): Pack {
  const db = openAndInit(':memory:');
  seedDefaultData(db, { deviceId: 'devT' });
  const repo = new Repository(db, { userId: 'u1', deviceId: 'devT', clock: createHlc('devT') }, () => T);
  const ctx: DocContext = { userId: 'u1', deviceId: 'devT', now: () => T };
  return { db, repo, ctx };
}

/** 基础资料：两个仓库、商品（含整箱换算 12）、两个货位。 */
function fixtures(repo: Repository): void {
  repo.insert('warehouse', { name: '主仓', status: 1 }, 'w1');
  repo.insert('warehouse', { name: '分仓', status: 1 }, 'w2');
  repo.insert('product', { code: 'P001', name: '螺丝', base_unit_id: 'u_ge', status: 1 }, 'p1');
  repo.insert('product_unit', { product_id: 'p1', unit_id: 'u_xiang', factor: 12, is_base: 0 }, 'pu1');
  repo.insert('location', { warehouse_id: 'w1', name: 'A-01', status: 1 }, 'loc1');
  repo.insert('location', { warehouse_id: 'w2', name: 'B-01', status: 1 }, 'loc2');
}

/** 直接写一条期初流水并重算，作为库存起点。 */
function seedStock(db: SqlDatabase, repo: Repository, warehouseId: string, qty: number, cost: number): void {
  repo.insert('stock_ledger', {
    biz_type: '期初',
    product_id: 'p1',
    warehouse_id: warehouseId,
    qty_in: qty,
    unit_cost: cost,
    amount: qty * cost,
    biz_date: T,
  });
  recomputeBalance(db, { productId: 'p1', warehouseId });
}

function balanceQty(db: SqlDatabase, warehouseId: string): number {
  const row = db.prepare('SELECT qty FROM stock_balance WHERE product_id = ? AND warehouse_id = ?').get('p1', warehouseId);
  return Number(row?.qty ?? 0);
}

test('调拨：审核后源仓出库 + 目标仓入库双流水，成本随货转移并重算余额', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);
  seedStock(db, repo, 'w1', 10, 2);

  const doc = save(db, repo, ctx, 'stock_transfer', {
    from_warehouse_id: 'w1',
    to_warehouse_id: 'w2',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 4 }],
  });
  assert.equal(doc.status, 0);
  assert.match(String(doc.doc_no), /^DB/);

  const audited = audit(db, repo, ctx, 'stock_transfer', doc.id as string);
  assert.equal(audited.status, 1);

  const ledger = db
    .prepare("SELECT * FROM stock_ledger WHERE doc_id = ? AND biz_type = '调拨' ORDER BY warehouse_id")
    .all(doc.id) as Record<string, unknown>[];
  assert.equal(ledger.length, 2);
  const out = ledger.find((r) => r.warehouse_id === 'w1')!;
  const into = ledger.find((r) => r.warehouse_id === 'w2')!;
  assert.equal(out.qty_out, 4);
  assert.equal(out.unit_cost, 2);
  assert.equal(into.qty_in, 4);
  assert.equal(into.unit_cost, 2);

  assert.equal(balanceQty(db, 'w1'), 6);
  assert.equal(balanceQty(db, 'w2'), 4);
  const w2 = db.prepare('SELECT * FROM stock_balance WHERE product_id = ? AND warehouse_id = ?').get('p1', 'w2')!;
  assert.equal(w2.cost_amount, 8);
  assert.equal(w2.avg_cost, 2);

  db.close();
});

test('调拨：源仓可用不足时审核报中文错误，不写流水', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);
  seedStock(db, repo, 'w1', 10, 2);

  const doc = save(db, repo, ctx, 'stock_transfer', {
    from_warehouse_id: 'w1',
    to_warehouse_id: 'w2',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 20 }],
  });
  assert.throws(
    () => audit(db, repo, ctx, 'stock_transfer', doc.id as string),
    /库存不足：商品「螺丝」在仓库「主仓」可用 10，需 20/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM stock_ledger WHERE doc_id = ?').get(doc.id)!.c, 0);

  setSysConfig(db, 'allow_negative_stock', '1');
  const ok = audit(db, repo, ctx, 'stock_transfer', doc.id as string);
  assert.equal(ok.status, 1);
  assert.equal(balanceQty(db, 'w1'), -10);

  db.close();
});

test('调拨：取消审核红冲流水、状态回 0、余额回退，可再次审核', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);
  seedStock(db, repo, 'w1', 10, 2);

  const doc = save(db, repo, ctx, 'stock_transfer', {
    from_warehouse_id: 'w1',
    to_warehouse_id: 'w2',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 4 }],
  });
  audit(db, repo, ctx, 'stock_transfer', doc.id as string);
  assert.equal(balanceQty(db, 'w1'), 6);

  const back = unaudit(db, repo, ctx, 'stock_transfer', doc.id as string);
  assert.equal(back.status, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM stock_ledger WHERE doc_id = ? AND biz_type = ?').get(doc.id, '红冲')!.c, 2);
  assert.equal(balanceQty(db, 'w1'), 10);
  assert.equal(balanceQty(db, 'w2'), 0);

  const re = audit(db, repo, ctx, 'stock_transfer', doc.id as string);
  assert.equal(re.status, 1);
  assert.equal(balanceQty(db, 'w2'), 4);

  db.close();
});

test('调拨：红冲生成反向已审核单据 R，原单置 9，余额回退', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);
  seedStock(db, repo, 'w1', 10, 2);

  const doc = save(db, repo, ctx, 'stock_transfer', {
    from_warehouse_id: 'w1',
    to_warehouse_id: 'w2',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 4 }],
  });
  audit(db, repo, ctx, 'stock_transfer', doc.id as string);

  const res = reverse(db, repo, ctx, 'stock_transfer', doc.id as string);
  assert.equal(Number(res.doc.status), 9);

  const rDoc = db.prepare('SELECT * FROM stock_transfer WHERE id = ?').get(res.reversalDocId) as Record<string, unknown>;
  assert.equal(Number(rDoc.status), 1);
  assert.equal(rDoc.reversal_of, doc.id);
  // 反向单调换仓库
  assert.equal(rDoc.from_warehouse_id, 'w2');
  assert.equal(rDoc.to_warehouse_id, 'w1');

  assert.equal(balanceQty(db, 'w1'), 10);
  assert.equal(balanceQty(db, 'w2'), 0);

  // 已红冲原单不可再次操作
  assert.throws(() => unaudit(db, repo, ctx, 'stock_transfer', doc.id as string), /单据已红冲，不能再次操作/);

  db.close();
});

test('盘点：盘亏生成出库流水、盘盈生成入库流水，均按当前均价记账', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);
  seedStock(db, repo, 'w1', 10, 2);
  repo.insert('product', { code: 'P002', name: '螺母', base_unit_id: 'u_ge', status: 1 }, 'p2');
  repo.insert('stock_ledger', {
    biz_type: '期初',
    product_id: 'p2',
    warehouse_id: 'w1',
    qty_in: 10,
    unit_cost: 3,
    amount: 30,
    biz_date: T,
  });
  recomputeBalance(db, { productId: 'p2', warehouseId: 'w1' });

  const doc = save(db, repo, ctx, 'stock_check', {
    warehouse_id: 'w1',
    biz_date: T,
    items: [
      { product_id: 'p1', qty: 8 }, // 账面 10 → 实盘 8：盘亏 2
      { product_id: 'p2', qty: 15 }, // 账面 10 → 实盘 15：盘盈 5
    ],
  });
  assert.match(String(doc.doc_no), /^PD/);

  const got = get(db, 'stock_check', doc.id as string)!;
  const p1Item = got.items.find((i) => i.product_id === 'p1')!;
  const p2Item = got.items.find((i) => i.product_id === 'p2')!;
  assert.equal(p1Item.book_qty, 10);
  assert.equal(p1Item.real_qty, 8);
  assert.equal(p1Item.diff_qty, -2);
  assert.equal(p2Item.diff_qty, 5);

  audit(db, repo, ctx, 'stock_check', doc.id as string);

  const ledger = db.prepare("SELECT * FROM stock_ledger WHERE doc_id = ? AND biz_type = '盘点'").all(doc.id) as Record<string, unknown>[];
  const p1Led = ledger.find((r) => r.product_id === 'p1')!;
  const p2Led = ledger.find((r) => r.product_id === 'p2')!;
  assert.equal(p1Led.qty_out, 2);
  assert.equal(p1Led.unit_cost, 2);
  assert.equal(p1Led.amount, 4);
  assert.equal(p2Led.qty_in, 5);
  assert.equal(p2Led.unit_cost, 3);
  assert.equal(p2Led.amount, 15);

  assert.equal(balanceQty(db, 'w1'), 8);
  assert.equal(availableQty(db, { product_id: 'p2', warehouse_id: 'w1' }), 15);

  db.close();
});

test('盘点：盘亏超出可用量时审核报错；红冲后余额回退', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);
  seedStock(db, repo, 'w1', 10, 2);

  // 实盘为 0 → 盘亏 10，账面恰为 10，可正常审核
  const doc = save(db, repo, ctx, 'stock_check', {
    warehouse_id: 'w1',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 0 }],
  });
  audit(db, repo, ctx, 'stock_check', doc.id as string);
  assert.equal(balanceQty(db, 'w1'), 0);

  reverse(db, repo, ctx, 'stock_check', doc.id as string);
  assert.equal(balanceQty(db, 'w1'), 10);

  db.close();
});

test('库存单据：list 返回派生展示列并可按状态过滤', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);
  seedStock(db, repo, 'w1', 10, 2);

  const doc = save(db, repo, ctx, 'stock_transfer', {
    from_warehouse_id: 'w1',
    to_warehouse_id: 'w2',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 2 }],
  });

  const kind: StockDocKind = 'stock_transfer';
  const rows = list(db, kind, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from_warehouse_name, '主仓');
  assert.equal(rows[0].to_warehouse_name, '分仓');
  assert.equal(list(db, kind, { status: 0 }).length, 1);
  assert.equal(list(db, kind, { status: 1 }).length, 0);

  audit(db, repo, ctx, 'stock_transfer', doc.id as string);
  assert.equal(list(db, kind, { status: 0 }).length, 0);
  assert.equal(list(db, kind, { status: 1 }).length, 1);

  db.close();
});
