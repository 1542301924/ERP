import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createHlc } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import { buildTemplateBuffer, importFromBuffer, listTemplates } from '../src/main/services/excel';
import type { SqlDatabase } from '../src/main/db/sqlite';

function makeRepo(db: SqlDatabase): Repository {
  return new Repository(db, { userId: 'u1', deviceId: 'devT', clock: createHlc('devT') }, () => 1_700_000_000_000);
}

function count(db: SqlDatabase, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0);
}

function seedUnits(db: SqlDatabase, repo: Repository): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const name of ['个', '件', '箱', 'kg']) ids[name] = repo.insert('unit', { name, sort: 0, status: 1 }).id as string;
  return ids;
}

const PRODUCT_HEADERS = [
  '商品编号*',
  '商品名称*',
  '类别编码',
  '主条码',
  '规格',
  '颜色',
  '基本单位*',
  '预设进价',
  '预设售价',
  '最低库存',
  '最高库存',
  '期初数量',
  '期初成本',
  '生产厂商',
  '状态(1启用/0停用)',
];

async function buildWorkbook(headers: string[], rows: Array<Array<string | number | null>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

test('product 导入：文件内重复编号在物理行 7/31 均计失败', async () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  seedUnits(db, repo);

  const rows: Array<Array<string | number | null>> = [];
  for (let i = 1; i <= 100; i++) {
    const physicalRow = i + 1;
    const code = physicalRow === 7 || physicalRow === 31 ? 'DUP-CODE' : `P${String(i).padStart(3, '0')}`;
    rows.push([code, `商品${i}`, '', '', '', '', '个', 10, 15, 0, 100, 0, 0, '', 1]);
  }
  const buffer = await buildWorkbook(PRODUCT_HEADERS, rows);

  const result = await importFromBuffer(db, repo, 'product', buffer);
  assert.equal(result.total, 100);
  assert.equal(result.success, 98);
  assert.equal(result.failed, 2);
  assert.deepEqual(
    result.errors.map((e) => e.row).sort((a, b) => a - b),
    [7, 31],
  );

  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM product WHERE code = 'DUP-CODE'").get()?.c, 0);
  assert.equal(count(db, 'product'), 98);
  assert.equal(count(db, 'product_unit'), 98);
  assert.equal(count(db, 'product_unit'), count(db, 'product'));

  const baseUnits = db.prepare('SELECT COUNT(*) AS c FROM product_unit WHERE is_base = 1').get()?.c;
  assert.equal(Number(baseUnits), 98);
  db.close();
});

test('product 导入：未知单位 / 未知类别 / 库中已存在编号均失败，其余成功', async () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const units = seedUnits(db, repo);
  repo.insert('product', { code: 'EXIST', name: '已存在', base_unit_id: units['个'], status: 1 });

  const rows: Array<Array<string | number | null>> = [
    ['P1', '正常', '', '', '', '', '个', 1, 2, 0, 0, 0, 0, '', 1],
    ['P2', '坏单位', '', '', '', '', '米', 1, 2, 0, 0, 0, 0, '', 1],
    ['P3', '坏类别', 'NO_CAT', '', '', '', '个', 1, 2, 0, 0, 0, 0, '', 1],
    ['EXIST', '库中已有', '', '', '', '', '个', 1, 2, 0, 0, 0, 0, '', 1],
    ['P5', '正常2', '', '', '', '', '个', 1, 2, 0, 0, 0, 0, '', 1],
  ];
  const buffer = await buildWorkbook(PRODUCT_HEADERS, rows);

  const result = await importFromBuffer(db, repo, 'product', buffer);
  assert.equal(result.total, 5);
  assert.equal(result.success, 2);
  assert.equal(result.failed, 3);
  for (const err of result.errors) {
    assert.match(err.message, /[\u4e00-\u9fa5]/, `错误信息应为中文: ${err.message}`);
  }
  assert.ok(db.prepare("SELECT 1 AS x FROM product WHERE code = 'P1'").get());
  assert.ok(db.prepare("SELECT 1 AS x FROM product WHERE code = 'P5'").get());
  db.close();
});

test('init_stock 导入：更新期初数量 / 成本；未知编号失败', async () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const units = seedUnits(db, repo);
  repo.insert('product', { code: 'P100', name: '商品', base_unit_id: units['个'], status: 1 });

  const buffer = await buildWorkbook(
    ['商品编号*', '商品名称', '数量*', '成本单价*'],
    [
      ['P100', '商品', 5, 3.5],
      ['NOPE', '不存在', 1, 1],
    ],
  );

  const result = await importFromBuffer(db, repo, 'init_stock', buffer);
  assert.equal(result.total, 2);
  assert.equal(result.success, 1);
  assert.equal(result.failed, 1);

  const product = db.prepare("SELECT * FROM product WHERE code = 'P100'").get()!;
  assert.equal(Number(product.init_qty), 5);
  assert.equal(Number(product.init_cost), 3.5);
  db.close();
});

test('导入不可导入模板（purchase_inbound）应拒绝', async () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  await assert.rejects(
    () => importFromBuffer(db, repo, 'purchase_inbound', Buffer.from('')),
    /导入将在 P2 开放/,
  );
  db.close();
});

test('listTemplates 返回 6 个模板且 importable 标记正确；product 模板可被 exceljs 加载', async () => {
  const tpls = listTemplates();
  assert.equal(tpls.length, 6);
  assert.deepEqual(
    tpls.map((t) => t.id),
    ['product', 'customer', 'supplier', 'init_stock', 'purchase_inbound', 'sales_outbound'],
  );
  assert.equal(tpls.find((t) => t.id === 'product')?.importable, true);
  assert.equal(tpls.find((t) => t.id === 'init_stock')?.importable, true);
  assert.equal(tpls.find((t) => t.id === 'purchase_inbound')?.importable, false);
  assert.equal(tpls.find((t) => t.id === 'sales_outbound')?.importable, false);

  const buffer = await buildTemplateBuffer('product');
  assert.ok(Buffer.isBuffer(buffer));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  assert.ok(ws);
  assert.equal(ws.getRow(1).getCell(1).value, '商品编号*');
  assert.equal(ws.getRow(2).getCell(1).value, 'P0001');
});
