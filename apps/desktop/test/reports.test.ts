import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createHlc } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import { seedDefaultData } from '../src/main/db/seed';
import type { SqlDatabase } from '../src/main/db/sqlite';
import { audit, save, type DocContext } from '../src/main/services/documents';
import { buildReportBuffer, reportTitle, runReport } from '../src/main/services/reports';
import type { ReportResult } from '../src/main/services/reports';

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

/** 基础资料：一个仓库、一个商品、一个供应商、一个客户。 */
function fixtures(repo: Repository): void {
  repo.insert('warehouse', { name: '主仓', status: 1 }, 'wh_main');
  repo.insert('product', { code: 'P001', name: '螺丝', base_unit_id: 'u_ge', status: 1 }, 'p1');
  repo.insert('supplier', { name: '供应商A', status: 1 }, 'sup1');
  repo.insert('customer', { name: '客户B', status: 1 }, 'cus1');
}

/**
 * 造数：两次采购入库（10@3、10@5，移动加权 → 均价 4）+ 一次销售出库（4@售价10）。
 * 期望：入库合计 20 / 成本 80；出库 4 / 成本快照 16；销售额 40、毛利 24。
 */
function buildData(pack: Pack): void {
  const { db, repo, ctx } = pack;
  const in1 = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 10, price: 3 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', in1.id as string);

  const in2 = save(db, repo, ctx, 'purchase_inbound', {
    docType: '采购',
    supplier_id: 'sup1',
    warehouse_id: 'wh_main',
    biz_date: T,
    items: [{ product_id: 'p1', qty: 10, price: 5 }],
  });
  audit(db, repo, ctx, 'purchase_inbound', in2.id as string);

  const out = save(db, repo, ctx, 'sales_outbound', {
    docType: '销售',
    customer_id: 'cus1',
    warehouse_id: 'wh_main',
    biz_date: T + 1000,
    items: [{ product_id: 'p1', qty: 4, price: 10 }],
  });
  audit(db, repo, ctx, 'sales_outbound', out.id as string);
}

function rowOf(result: ReportResult, key: string, value: unknown): Record<string, unknown> {
  const found = result.rows.find((r) => r[key] === value);
  assert.ok(found, `未找到 ${key}=${String(value)} 的行`);
  return found;
}

test('reportTitle：返回中文标题', () => {
  assert.equal(reportTitle('inventory_detail'), '进销存明细表');
  assert.equal(reportTitle('gross_profit'), '销售毛利表');
});

test('进销存明细表：逐笔流水 + 合计与流水一致', () => {
  const pack = setup();
  fixtures(pack.repo);
  buildData(pack);

  const r = runReport(pack.db, 'inventory_detail', {});
  assert.equal(r.rows.length, 3);
  assert.equal(r.totals?.qty_in, 20);
  assert.equal(r.totals?.qty_out, 4);
  assert.equal(r.totals?.amount, 96); // 30 + 50 + 16（金额恒为正的成本额）

  // 商品过滤：仍为 3 笔（同一商品）
  assert.equal(runReport(pack.db, 'inventory_detail', { productId: 'p1' }).rows.length, 3);
  // 关键字过滤：商品编号命中
  assert.equal(runReport(pack.db, 'inventory_detail', { keyword: 'P001' }).rows.length, 3);
  pack.db.close();
});

test('进销存汇总表：期初 + 本期入 − 本期出 = 期末（与明细勾稽）', () => {
  const pack = setup();
  fixtures(pack.repo);
  buildData(pack);

  // 全区间：期初 0，本期入 20/80，本期出 4/16，期末 16/64
  const full = runReport(pack.db, 'inventory_summary', { startDate: T, endDate: T + 2000 });
  assert.equal(full.rows.length, 1);
  const p1 = rowOf(full, 'product_code', 'P001');
  assert.equal(p1.init_qty, 0);
  assert.equal(p1.in_qty, 20);
  assert.equal(p1.in_amount, 80);
  assert.equal(p1.out_qty, 4);
  assert.equal(p1.out_amount, 16);
  assert.equal(p1.end_qty, 16); // 0 + 20 − 4
  assert.equal(p1.end_amount, 64);

  // 起始日切在出库之前：两笔入库计入期初，期间只剩出库
  const mid = runReport(pack.db, 'inventory_summary', { startDate: T + 500, endDate: T + 2000 });
  const p1b = rowOf(mid, 'product_code', 'P001');
  assert.equal(p1b.init_qty, 20);
  assert.equal(p1b.init_amount, 80);
  assert.equal(p1b.in_qty, 0);
  assert.equal(p1b.out_qty, 4);
  assert.equal(p1b.end_qty, 16);

  // 按仓库维度
  const byWh = runReport(pack.db, 'inventory_summary', { groupBy: 'warehouse' });
  assert.equal(byWh.rows.length, 1);
  assert.equal(rowOf(byWh, 'warehouse_name', '主仓').end_qty, 16);
  pack.db.close();
});

test('收货对账单：按供应商汇总入库数量/金额与应付/已付/未付', () => {
  const pack = setup();
  fixtures(pack.repo);
  buildData(pack);

  const r = runReport(pack.db, 'receipt_statement', {});
  const sup = rowOf(r, 'supplier_name', '供应商A');
  assert.equal(sup.doc_count, 2);
  assert.equal(sup.in_qty, 20);
  assert.equal(sup.in_amount, 80);
  assert.equal(sup.payable_amount, 80);
  assert.equal(sup.paid_amount, 0);
  assert.equal(sup.unpaid_amount, 80);

  // 按供应商过滤命中；过滤到不存在的供应商则为空
  assert.equal(runReport(pack.db, 'receipt_statement', { supplierId: 'sup1' }).rows.length, 1);
  assert.equal(runReport(pack.db, 'receipt_statement', { supplierId: 'nope' }).rows.length, 0);
  pack.db.close();
});

test('发货对账单：按客户汇总出库数量/金额与应收/已收/未收', () => {
  const pack = setup();
  fixtures(pack.repo);
  buildData(pack);

  const r = runReport(pack.db, 'shipment_statement', {});
  const cus = rowOf(r, 'customer_name', '客户B');
  assert.equal(cus.doc_count, 1);
  assert.equal(cus.out_qty, 4);
  assert.equal(cus.out_amount, 40);
  assert.equal(cus.receivable_amount, 40);
  assert.equal(cus.received_amount, 0);
  assert.equal(cus.unreceived_amount, 40);
  pack.db.close();
});

test('发货成本表：销售金额 − 成本额 = 毛利（成本取销售成本快照）', () => {
  const pack = setup();
  fixtures(pack.repo);
  buildData(pack);

  const r = runReport(pack.db, 'shipment_cost', {});
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.sale_amount, 40);
  assert.equal(row.cost_amount, 16);
  assert.equal(row.gross_profit, 24);
  assert.equal(row.gross_rate, 0.6); // 24 / 40

  // 商品过滤：命中（该商品在单内）；不匹配商品则为空
  assert.equal(runReport(pack.db, 'shipment_cost', { productId: 'p1' }).rows.length, 1);
  assert.equal(runReport(pack.db, 'shipment_cost', { productId: 'p2' }).rows.length, 0);
  pack.db.close();
});

test('销售毛利表：按商品/客户/业务员三种维度聚合，毛利与成本表一致', () => {
  const pack = setup();
  fixtures(pack.repo);
  buildData(pack);

  const byProduct = runReport(pack.db, 'gross_profit', { groupBy: 'product' });
  const p1 = rowOf(byProduct, 'dim_code', 'P001');
  assert.equal(p1.sale_qty, 4);
  assert.equal(p1.sale_amount, 40);
  assert.equal(p1.cost_amount, 16);
  assert.equal(p1.gross_profit, 24);
  assert.equal(p1.gross_rate, 0.6);

  const byCustomer = runReport(pack.db, 'gross_profit', { groupBy: 'customer' });
  assert.equal(rowOf(byCustomer, 'dim_name', '客户B').gross_profit, 24);

  const byHandler = runReport(pack.db, 'gross_profit', { groupBy: 'handler' });
  assert.equal(byHandler.rows.length, 1);
  assert.equal(byHandler.rows[0].gross_profit, 24);
  pack.db.close();
});

test('导出 Excel：表头为中文标签、含加粗合计行，数值与报表一致', async () => {
  const pack = setup();
  fixtures(pack.repo);
  buildData(pack);

  const result = runReport(pack.db, 'inventory_summary', { startDate: T, endDate: T + 2000 });
  const buffer = await buildReportBuffer(result);
  assert.ok(buffer instanceof Buffer && buffer.length > 0);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('进销存汇总表');
  assert.ok(ws, '缺少以报表标题命名的工作表');

  const header = ws!.getRow(1).values as unknown[];
  assert.ok(header.includes('商品编号') && header.includes('期末数量'));

  // 最后一行是合计行：首列为「合计」且加粗
  const last = ws!.getRow(ws!.rowCount);
  assert.equal(last.getCell(1).value, '合计');
  assert.equal(last.font?.bold, true);

  // 合计行的期末数量与页面 totals 一致
  const cols = result.columns.map((c) => c.label);
  const endCell = last.getCell(cols.indexOf('期末数量') + 1).value;
  assert.equal(endCell, result.totals?.end_qty);

  pack.db.close();
});
