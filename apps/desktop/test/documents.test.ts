import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc } from '@inventory/shared';
import { openAndInit, setSysConfig } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import { seedDefaultData } from '../src/main/db/seed';
import type { SqlDatabase } from '../src/main/db/sqlite';
import { availableQty } from '../src/main/services/inventory';
import {
  audit,
  get,
  list,
  reverse,
  save,
  transfer,
  unaudit,
  type DocContext,
} from '../src/main/services/documents';

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

/** 基础资料：仓库、商品（含整箱单位换算 12）、供应商、客户。 */
function fixtures(repo: Repository): void {
  repo.insert('warehouse', { name: '主仓', status: 1 }, 'wh_main');
  repo.insert('product', { code: 'P001', name: '螺丝', base_unit_id: 'u_ge', status: 1 }, 'p1');
  repo.insert('product_unit', { product_id: 'p1', unit_id: 'u_xiang', factor: 12, is_base: 0 }, 'pu1');
  repo.insert('supplier', { name: '供应商A', status: 1 }, 'sup1');
  repo.insert('customer', { name: '客户B', status: 1 }, 'cus1');
}

function count(db: SqlDatabase, table: string, where = '', params: unknown[] = []): number {
  const sql = `SELECT COUNT(*) AS c FROM ${table}${where ? ` WHERE ${where}` : ''}`;
  return Number(db.prepare(sql).get(...params)?.c ?? 0);
}

test('schema：四类单据表均含 reversal_of 列', () => {
  const db = openAndInit(':memory:');
  for (const table of ['purchase_order', 'purchase_inbound', 'sales_order', 'sales_outbound']) {
    const cols = db
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all(table)
      .map((r) => r.name as string);
    assert.ok(cols.includes('reversal_of'), `${table} 缺少 reversal_of`);
  }
  db.close();
});

test('采购入库/采购：保存草稿（base_qty/total 由服务端计算）、审核后写流水与应付', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const doc = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', unit_id: 'u_xiang', qty: 2, price: 10 }],
  });
  assert.equal(doc.status, 0);
  assert.match(String(doc.doc_no), /^RK/);

  const got = get(db, 'purchase_inbound', doc.id as string)!;
  assert.equal(got.items.length, 1);
  assert.equal(got.items[0].base_qty, 24); // qty 2 × factor 12
  assert.equal(got.items[0].amount, 20); // qty 2 × price 10
  assert.equal(doc.total_amount, 20);

  const audited = audit(db, repo, ctx, 'purchase_inbound', doc.id as string);
  assert.equal(audited.status, 1);

  const ledger = db.prepare("SELECT * FROM stock_ledger WHERE doc_id = ? AND reversal_of IS NULL").all(doc.id);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].biz_type, '采购入库');
  assert.equal(ledger[0].qty_in, 24);
  assert.equal(ledger[0].unit_cost, 10);
  assert.equal(availableQty(db, { product_id: 'p1', warehouse_id: 'wh_main' }), 24);

  const ap = db.prepare('SELECT * FROM ap_bill WHERE source_inbound_id = ? AND deleted = 0').get(doc.id);
  assert.ok(ap);
  assert.equal(ap.amount, 20); // = total_amount
  db.close();
});

test('已审核单据 save 修改被中文错误拒绝', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);
  const doc = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 1, price: 1 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', doc.id as string);

  assert.throws(
    () => save(db, repo, ctx, 'purchase_inbound', { id: doc.id as string, docType: '采购', items: [] }),
    /单据已审核，请先「取消审核」后再修改/,
  );
  db.close();
});

test('取消审核：回草稿、红冲自身流水、软删应付、可重新审核生效', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);
  const doc = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', unit_id: 'u_xiang', qty: 2, price: 10 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', doc.id as string);
  const orig = db.prepare("SELECT * FROM stock_ledger WHERE doc_id = ? AND reversal_of IS NULL").get(doc.id);

  const back = unaudit(db, repo, ctx, 'purchase_inbound', doc.id as string);
  assert.equal(back.status, 0);

  const reversal = db.prepare("SELECT * FROM stock_ledger WHERE doc_id = ? AND biz_type = '红冲'").get(doc.id);
  assert.ok(reversal);
  assert.equal(reversal.reversal_of, orig!.id);
  assert.equal(reversal.qty_out, 24);
  assert.equal(availableQty(db, { product_id: 'p1', warehouse_id: 'wh_main' }), 0);
  assert.equal(count(db, 'ap_bill', 'source_inbound_id = ? AND deleted = 0', [doc.id]), 0);

  const reAudited = audit(db, repo, ctx, 'purchase_inbound', doc.id as string);
  assert.equal(reAudited.status, 1);
  assert.equal(availableQty(db, { product_id: 'p1', warehouse_id: 'wh_main' }), 24);
  assert.equal(count(db, 'ap_bill', 'source_inbound_id = ? AND deleted = 0', [doc.id]), 1);
  db.close();
});

test('销售出库/销售：按均价记成本、生成应收', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const inbound = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 24, price: 5 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', inbound.id as string);

  const out = save(db, repo, ctx, 'sales_outbound', {
    docType: '销售',
    customer_id: 'cus1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 4, price: 8 }],
  });
  audit(db, repo, ctx, 'sales_outbound', out.id as string);

  const ledger = db.prepare("SELECT * FROM stock_ledger WHERE doc_id = ? AND biz_type = '销售出库'").get(out.id)!;
  assert.equal(ledger.qty_out, 4);
  assert.equal(ledger.unit_cost, 5);
  assert.equal(ledger.amount, 20);

  const item = db.prepare('SELECT * FROM sales_outbound_item WHERE outbound_id = ?').get(out.id)!;
  assert.equal(item.cost_price, 5);
  assert.equal(item.cost_amount, 20);

  const ar = db.prepare('SELECT * FROM ar_bill WHERE source_outbound_id = ? AND deleted = 0').get(out.id);
  assert.ok(ar);
  assert.equal(availableQty(db, { product_id: 'p1', warehouse_id: 'wh_main' }), 20);
  db.close();
});

test('负库存：默认禁止（报错含商品/仓库名且不落库）、允许后审核成功', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const inbound = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 5, price: 4 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', inbound.id as string);

  const out = save(db, repo, ctx, 'sales_outbound', {
    docType: '销售',
    customer_id: 'cus1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 10, price: 2 }],
  });
  assert.throws(
    () => audit(db, repo, ctx, 'sales_outbound', out.id as string),
    /库存不足：商品「螺丝」在仓库「主仓」可用 5，需 10/,
  );
  // 审核失败不得写入任何流水 / 往来单
  assert.equal(count(db, 'stock_ledger', 'doc_id = ?', [out.id]), 0);
  assert.equal(count(db, 'ar_bill', 'source_outbound_id = ?', [out.id]), 0);

  setSysConfig(db, 'allow_negative_stock', '1');
  const ok = audit(db, repo, ctx, 'sales_outbound', out.id as string);
  assert.equal(ok.status, 1);
  assert.equal(availableQty(db, { product_id: 'p1', warehouse_id: 'wh_main' }), -5);
  db.close();
});

test('部门领用 / 生产入库：写对应业务类型流水且不生成往来单', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const inbound = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 20, price: 1 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', inbound.id as string);

  const dept = save(db, repo, ctx, 'purchase_inbound', {
    docType: '部门领用',
    warehouse_id: 'wh_main',
    department_id: 'd1',
    receiver_id: 'r1',
    use_purpose: '生产耗用',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 3, price: 0 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', dept.id as string);
  const deptLedger = db.prepare('SELECT * FROM stock_ledger WHERE doc_id = ?').get(dept.id)!;
  assert.equal(deptLedger.biz_type, '部门领用');
  assert.equal(deptLedger.qty_out, 3);
  assert.equal(count(db, 'ap_bill', 'source_inbound_id = ?', [dept.id]), 0);

  const prod = save(db, repo, ctx, 'purchase_inbound', {
    docType: '生产入库',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 5, price: 2 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', prod.id as string);
  const prodLedger = db.prepare('SELECT * FROM stock_ledger WHERE doc_id = ?').get(prod.id)!;
  assert.equal(prodLedger.biz_type, '生产入库');
  assert.equal(prodLedger.qty_in, 5);
  assert.equal(count(db, 'ap_bill', 'source_inbound_id = ?', [prod.id]), 0);
  db.close();
});

test('退货：采购退货=退货出库+负应付；销售退货=退货入库+负应收', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const inbound = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 20, price: 1 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', inbound.id as string);

  // 采购退货（货退回供应商）
  const pr = save(db, repo, ctx, 'purchase_inbound', {
    docType: '退货入库',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 2, price: 10 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', pr.id as string);
  const prLedger = db.prepare('SELECT * FROM stock_ledger WHERE doc_id = ?').get(pr.id)!;
  assert.equal(prLedger.biz_type, '退货出库');
  assert.equal(prLedger.qty_out, 2);
  const prBill = db.prepare('SELECT * FROM ap_bill WHERE source_inbound_id = ? AND deleted = 0').get(pr.id);
  assert.ok(prBill);
  assert.equal(prBill.amount, -20); // -(2 × 10)

  // 销售退货（客户退回）
  const sr = save(db, repo, ctx, 'sales_outbound', {
    docType: '退货出库',
    customer_id: 'cus1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 3, price: 5 }],
  });
  audit(db, repo, ctx, 'sales_outbound', sr.id as string);
  const srLedger = db.prepare('SELECT * FROM stock_ledger WHERE doc_id = ?').get(sr.id)!;
  assert.equal(srLedger.biz_type, '退货入库');
  assert.equal(srLedger.qty_in, 3);
  const srBill = db.prepare('SELECT * FROM ar_bill WHERE source_outbound_id = ? AND deleted = 0').get(sr.id);
  assert.ok(srBill);
  assert.equal(srBill.amount, -15);
  db.close();
});

test('红冲：原单置 9、生成反向已审核单 + 反向流水 + 负往来单；重复红冲被拒', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const doc = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 10, price: 5 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', doc.id as string);
  const origLedger = db.prepare("SELECT * FROM stock_ledger WHERE doc_id = ? AND biz_type = '采购入库'").get(doc.id);
  const origBill = db.prepare('SELECT * FROM ap_bill WHERE source_inbound_id = ? AND deleted = 0').get(doc.id);

  const { doc: origAfter, reversalDocId } = reverse(db, repo, ctx, 'purchase_inbound', doc.id as string);
  assert.equal(origAfter.status, 9);

  const rDoc = db.prepare('SELECT * FROM purchase_inbound WHERE id = ?').get(reversalDocId)!;
  assert.equal(rDoc.reversal_of, doc.id);
  assert.equal(rDoc.status, 1);
  assert.match(String(rDoc.doc_no), /^RK/);
  assert.equal(count(db, 'purchase_inbound_item', 'inbound_id = ? AND deleted = 0', [reversalDocId]), 1);

  const rLedgers = db.prepare("SELECT * FROM stock_ledger WHERE doc_id = ? AND biz_type = '红冲'").all(reversalDocId);
  assert.equal(rLedgers.length, 1);
  assert.equal(rLedgers[0].reversal_of, origLedger!.id);
  assert.equal(rLedgers[0].qty_out, 10);

  const rBill = db.prepare('SELECT * FROM ap_bill WHERE source_inbound_id = ? AND deleted = 0').get(reversalDocId);
  assert.ok(rBill);
  assert.equal(rBill.amount, -Number(origBill!.amount));

  assert.equal(availableQty(db, { product_id: 'p1', warehouse_id: 'wh_main' }), 0);
  assert.throws(
    () => reverse(db, repo, ctx, 'purchase_inbound', doc.id as string),
    /单据已红冲，不能再次操作/,
  );
  db.close();
});

test('前置校验：下游引用 / 已红冲 / 已发生收付款核销', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  // a) 订单已生成入库单 → 取消审核 / 红冲被拒
  const order = save(db, repo, ctx, 'purchase_order', {
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 1, price: 1 }],
  });
  audit(db, repo, ctx, 'purchase_order', order.id as string);
  transfer(db, repo, ctx, 'purchase_order', order.id as string);
  assert.throws(() => unaudit(db, repo, ctx, 'purchase_order', order.id as string), /已被下游单据引用/);
  assert.throws(() => reverse(db, repo, ctx, 'purchase_order', order.id as string), /已被下游单据引用/);

  // b) 已红冲单据再次操作
  const reversed = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 1, price: 1 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', reversed.id as string);
  reverse(db, repo, ctx, 'purchase_inbound', reversed.id as string);
  assert.throws(
    () => unaudit(db, repo, ctx, 'purchase_inbound', reversed.id as string),
    /单据已红冲，不能再次操作/,
  );

  // c) 已发生收付款核销 → 取消审核被拒
  const doc = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 5, price: 2 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', doc.id as string);
  const ap = db.prepare('SELECT * FROM ap_bill WHERE source_inbound_id = ? AND deleted = 0').get(doc.id);
  repo.insert('ap_payment', { doc_no: 'PAY001', supplier_id: 'sup1', amount: 10 }, 'pay1');
  repo.insert('ap_payment_apply', { payment_id: 'pay1', ap_bill_id: ap!.id, amount: 10 }, 'apply1');
  assert.throws(
    () => unaudit(db, repo, ctx, 'purchase_inbound', doc.id as string),
    /已发生收付款核销/,
  );
  db.close();
});

test('转单：审核订单 → 草稿出入库单（复制明细 / 编号前缀 / 幂等与状态保护）', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const po = save(db, repo, ctx, 'purchase_order', {
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', unit_id: 'u_xiang', qty: 2, price: 3 }],
  });
  audit(db, repo, ctx, 'purchase_order', po.id as string);
  const inbound = transfer(db, repo, ctx, 'purchase_order', po.id as string);
  assert.equal(inbound.status, 0);
  assert.equal(inbound.source_order_id, po.id);
  assert.equal(inbound.inbound_type, '采购');
  assert.match(String(inbound.doc_no), /^RK/);

  const items = db.prepare('SELECT * FROM purchase_inbound_item WHERE inbound_id = ?').all(inbound.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].base_qty, 24);
  assert.equal(items[0].amount, 6);
  assert.equal(items[0].location_id, null);

  assert.throws(() => transfer(db, repo, ctx, 'purchase_order', po.id as string), /该订单已生成对应的出入库单/);

  const po2 = save(db, repo, ctx, 'purchase_order', {
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [],
  });
  assert.throws(() => transfer(db, repo, ctx, 'purchase_order', po2.id as string), /订单未审核，不能转单/);

  const so = save(db, repo, ctx, 'sales_order', {
    customer_id: 'cus1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 1, price: 9 }],
  });
  audit(db, repo, ctx, 'sales_order', so.id as string);
  const outbound = transfer(db, repo, ctx, 'sales_order', so.id as string);
  assert.equal(outbound.status, 0);
  assert.equal(outbound.source_order_id, so.id);
  assert.equal(outbound.outbound_type, '销售');
  assert.match(String(outbound.doc_no), /^CK/);
  assert.equal(count(db, 'sales_outbound_item', 'outbound_id = ? AND deleted = 0', [outbound.id]), 1);
  db.close();
});

test('单据编号：惰性创建规则，编号形如 RK00001 / RK00002', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const d1 = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    items: [],
  });
  const d2 = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    items: [],
  });
  assert.equal(d1.doc_no, 'RK00001');
  assert.equal(d2.doc_no, 'RK00002');

  const rule = db.prepare("SELECT * FROM code_rule WHERE target = 'doc_no.purchase_inbound' AND deleted = 0").get();
  assert.ok(rule);
  assert.equal(rule.prefix, 'RK');
  assert.equal(rule.seq_len, 5);
  db.close();
});

test('doc.list 过滤与 doc.get 关联字段 enrichment', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const a = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    remark: '甲单',
    items: [{ product_id: 'p1', unit_id: 'u_xiang', qty: 1, price: 5 }],
  });
  save(db, repo, ctx, 'sales_outbound', {
    docType: '销售',
    customer_id: 'cus1',
    warehouse_id: 'wh_main',
    biz_date: T + 1000,
    remark: '乙单',
    items: [{ product_id: 'p1', qty: 1, price: 8 }],
  });

  // 列表基础
  const all = list(db, 'purchase_inbound');
  assert.equal(all.length, 1);
  assert.equal(all[0].doc_type, '采购');
  assert.equal(all[0].partner_name, '供应商A');
  assert.equal(all[0].warehouse_name, '主仓');

  // keyword
  assert.equal(list(db, 'purchase_inbound', { keyword: '甲单' }).length, 1);
  assert.equal(list(db, 'purchase_inbound', { keyword: '不存在' }).length, 0);

  // status / docType
  assert.equal(list(db, 'purchase_inbound', { status: 0 }).length, 1);
  assert.equal(list(db, 'purchase_inbound', { status: 1 }).length, 0);
  assert.equal(list(db, 'purchase_inbound', { docType: '采购' }).length, 1);
  assert.equal(list(db, 'purchase_inbound', { docType: '生产入库' }).length, 0);

  // 日期区间（闭区间）
  assert.equal(list(db, 'purchase_inbound', { startDate: T, endDate: T }).length, 1);
  assert.equal(list(db, 'purchase_inbound', { startDate: T + 1 }).length, 0);

  // 销售出库列表 + 客户名
  const sales = list(db, 'sales_outbound', { docType: '销售' });
  assert.equal(sales.length, 1);
  assert.equal(sales[0].partner_name, '客户B');
  assert.equal(sales[0].doc_type, '销售');

  // doc.get enrichment
  const detail = get(db, 'purchase_inbound', a.id as string)!;
  assert.equal(detail.doc.doc_no, a.doc_no);
  assert.equal(detail.items[0].product_name, '螺丝');
  assert.equal(detail.items[0].product_code, 'P001');
  assert.equal(detail.items[0].unit_name, '箱');
  assert.equal(detail.bills.ap_bill, null); // 未审核无往来单
  assert.equal(detail.bills.ar_bill, null);
  db.close();
});

test('op_log：审核 / 取消审核 / 红冲 / 转单 各写入对应 action 记录', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const doc = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 1, price: 1 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', doc.id as string);
  assert.equal(count(db, 'op_log', "action = 'audit'"), 1);

  unaudit(db, repo, ctx, 'purchase_inbound', doc.id as string);
  assert.equal(count(db, 'op_log', "action = 'unaudit'"), 1);

  audit(db, repo, ctx, 'purchase_inbound', doc.id as string);
  reverse(db, repo, ctx, 'purchase_inbound', doc.id as string);
  assert.ok(count(db, 'op_log', "action = 'reverse'") >= 1);

  const order = save(db, repo, ctx, 'purchase_order', {
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 1, price: 1 }],
  });
  audit(db, repo, ctx, 'purchase_order', order.id as string);
  transfer(db, repo, ctx, 'purchase_order', order.id as string);
  assert.equal(count(db, 'op_log', "action = 'transfer'"), 1);
  db.close();
});
