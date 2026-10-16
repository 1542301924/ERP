import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import type { SqlDatabase } from '../src/main/db/sqlite';
import {
  categoryTree,
  deleteCategory,
  getById,
  lookupBarcode,
  productDetail,
  saveCategory,
  saveProductUnit,
  search,
} from '../src/main/services/master-data';

function makeRepo(db: SqlDatabase): Repository {
  return new Repository(db, { userId: 'u1', deviceId: 'devT', clock: createHlc('devT') }, () => 1_700_000_000_000);
}

function count(db: SqlDatabase, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0);
}

/** 取行 id（Row 值为 unknown，统一转 string）。 */
function sid(row: Record<string, unknown>): string {
  return row.id as string;
}

test('search：关键字 / 等值 / 分页 / includeDeleted / 字段白名单', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  repo.insert('customer', { name: '张三商行', contact: '张三', phone: '13800000000', status: 1 });
  repo.insert('customer', { name: '李四商行', contact: '李四', phone: '13900000000', status: 1 });
  const deleted = repo.insert('customer', { name: '王五商行', contact: '王五', phone: '13700000000', status: 1 });
  repo.softDelete('customer', deleted.id as string);

  const byKeyword = search(db, 'customer', { keyword: '张三' });
  assert.equal(byKeyword.length, 1);
  assert.equal(byKeyword[0].name, '张三商行');

  const byPhoneKeyword = search(db, 'customer', { keyword: '139' });
  assert.equal(byPhoneKeyword.length, 1);
  assert.equal(byPhoneKeyword[0].name, '李四商行');

  const byEquals = search(db, 'customer', { equals: { phone: '13900000000' } });
  assert.equal(byEquals.length, 1);

  const limited = search(db, 'customer', { limit: 1 });
  assert.equal(limited.length, 1);

  assert.equal(search(db, 'customer').length, 2, '默认排除软删除');
  assert.equal(search(db, 'customer', { includeDeleted: true }).length, 3);

  const custom = search(db, 'customer', { keyword: '李', fields: ['name'] });
  assert.equal(custom.length, 1);

  assert.throws(() => search(db, 'customer', { keyword: 'x', fields: ['not_a_column'] }), /查询字段不存在/);
  assert.throws(() => search(db, 'unknown_entity'), /未知实体/);
  db.close();
});

test('categoryTree：层级结构 + sort 排序', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const root = saveCategory(db, repo, { name: '食品', sort: 0 });
  saveCategory(db, repo, { parent_id: sid(root), name: '零食', sort: 2 });
  saveCategory(db, repo, { parent_id: sid(root), name: '饮料', sort: 1 });

  const tree = categoryTree(db);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, '食品');
  assert.deepEqual(
    tree[0].children.map((c) => c.name),
    ['饮料', '零食'],
    '按 sort 升序',
  );

  // 停用分类默认不出现
  const disabled = saveCategory(db, repo, { parent_id: sid(root), name: '停用类', status: 0 });
  assert.equal(categoryTree(db)[0].children.length, 2);
  assert.equal(categoryTree(db, { includeDisabled: true })[0].children.length, 3);
  assert.ok(disabled.id);
  db.close();
});

test('saveCategory：物料化路径 + 移动时级联重算', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const root = saveCategory(db, repo, { name: '食品' });
  const child = saveCategory(db, repo, { parent_id: sid(root), name: '零食' });
  const grand = saveCategory(db, repo, { parent_id: sid(child), name: '薯片' });

  assert.equal(root.path, `/root/${root.id}/`);
  assert.equal(child.path, `/root/${root.id}/${child.id}/`);
  assert.equal(grand.path, `/root/${root.id}/${child.id}/${grand.id}/`);

  // 移动 child 到新的根节点下，grand 路径应级联更新
  const root2 = saveCategory(db, repo, { name: '饮料' });
  saveCategory(db, repo, { id: sid(child), parent_id: sid(root2), name: '零食' });

  const childAfter = repo.findById('product_category', child.id as string)!;
  const grandAfter = repo.findById('product_category', grand.id as string)!;
  assert.equal(childAfter.path, `/root/${root2.id}/${child.id}/`);
  assert.equal(grandAfter.path, `/root/${root2.id}/${child.id}/${grand.id}/`);
  db.close();
});

test('saveCategory：防止环（自己 / 后代）', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const root = saveCategory(db, repo, { name: '食品' });
  const child = saveCategory(db, repo, { parent_id: sid(root), name: '零食' });

  assert.throws(() => saveCategory(db, repo, { id: sid(root), parent_id: sid(root), name: '食品' }), /设为自己/);
  assert.throws(
    () => saveCategory(db, repo, { id: sid(root), parent_id: sid(child), name: '食品' }),
    /子分类/,
  );
  db.close();
});

test('deleteCategory：有子分类 / 被商品引用时禁止', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const root = saveCategory(db, repo, { name: '食品' });
  const child = saveCategory(db, repo, { parent_id: sid(root), name: '零食' });

  assert.throws(() => deleteCategory(db, repo, root.id as string), /子分类/);

  repo.insert('product', { code: 'P1', name: '薯片', category_id: sid(child), status: 1 });
  assert.throws(() => deleteCategory(db, repo, child.id as string), /被商品引用/);

  // 无引用、无子分类时可删除
  const empty = saveCategory(db, repo, { name: '空分类' });
  deleteCategory(db, repo, empty.id as string);
  assert.equal(Number(repo.findById('product_category', empty.id as string)!.deleted), 1);
  db.close();
});

test('saveProductUnit：upsert + 基本单位同步', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const ge = repo.insert('unit', { name: '个', sort: 0, status: 1 });
  const product = repo.insert('product', { code: 'P1', name: '商品', base_unit_id: null, status: 1 });

  const first = saveProductUnit(db, repo, {
    product_id: product.id as string,
    unit_id: ge.id as string,
    factor: 1,
    is_base: 1,
  });
  assert.equal(first.is_base, 1);
  assert.equal(repo.findById('product', product.id as string)!.base_unit_id, ge.id);

  // 同 (product_id, unit_id) 再次保存 -> 更新而非新增
  const second = saveProductUnit(db, repo, {
    product_id: product.id as string,
    unit_id: ge.id as string,
    factor: 12,
    is_base: 0,
  });
  assert.equal(second.id, first.id);
  assert.equal(second.factor, 12);
  assert.equal(count(db, 'product_unit'), 1);
  db.close();
});

test('lookupBarcode：三级优先（product -> product_unit -> product_barcode）', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const ge = repo.insert('unit', { name: '个', sort: 0, status: 1 });

  const p1 = repo.insert('product', { code: 'P1', name: '主条码命中', barcode: 'AAA', status: 1 });
  const p2 = repo.insert('product', { code: 'P2', name: '单位条码命中', status: 1 });
  const p3 = repo.insert('product', { code: 'P3', name: '附属条码命中', status: 1 });

  saveProductUnit(db, repo, { product_id: p2.id as string, unit_id: ge.id as string, factor: 1, is_base: 1, barcode: 'BBB' });
  repo.insert('product_barcode', { product_id: p3.id as string, barcode: 'CCC', remark: null });

  const byProduct = lookupBarcode(db, 'AAA');
  assert.equal(byProduct?.matchedBy, 'product');
  assert.equal(byProduct?.product.id, p1.id);
  assert.equal(byProduct?.unit, undefined);

  const byUnit = lookupBarcode(db, 'BBB');
  assert.equal(byUnit?.matchedBy, 'product_unit');
  assert.equal(byUnit?.product.id, p2.id);
  assert.ok(byUnit?.unit);

  const byBarcode = lookupBarcode(db, 'CCC');
  assert.equal(byBarcode?.matchedBy, 'product_barcode');
  assert.equal(byBarcode?.product.id, p3.id);

  // 同一编码多来源时，product.barcode 优先
  repo.update('product', p1.id as string, { barcode: 'DDD' });
  repo.insert('product_barcode', { product_id: p3.id as string, barcode: 'DDD', remark: null });
  assert.equal(lookupBarcode(db, 'DDD')?.matchedBy, 'product');

  assert.equal(lookupBarcode(db, 'NOPE'), null);
  db.close();
});

test('productDetail：返回商品 + 带 unit_name 的单位 + 条码', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const ge = repo.insert('unit', { name: '个', sort: 0, status: 1 });
  const xiang = repo.insert('unit', { name: '箱', sort: 0, status: 1 });
  const product = repo.insert('product', { code: 'P1', name: '商品', status: 1 });

  saveProductUnit(db, repo, { product_id: product.id as string, unit_id: ge.id as string, factor: 1, is_base: 1 });
  saveProductUnit(db, repo, { product_id: product.id as string, unit_id: xiang.id as string, factor: 12 });
  repo.insert('product_barcode', { product_id: product.id as string, barcode: 'X001', remark: '箱码' });

  const detail = productDetail(db, product.id as string)!;
  assert.equal(detail.product.id, product.id);
  assert.equal(detail.units.length, 2);
  assert.equal(detail.units[0].unit_name, '个', '基本单位排在前');
  assert.deepEqual(
    detail.units.map((u) => u.unit_name).sort(),
    ['个', '箱'],
  );
  assert.equal(detail.barcodes.length, 1);
  assert.equal(detail.barcodes[0].barcode, 'X001');

  assert.equal(productDetail(db, 'not-exist'), null);

  // getById 查得到
  assert.equal(getById(db, 'product', product.id as string)?.code, 'P1');
  assert.equal(getById(db, 'product', 'not-exist'), null);
  db.close();
});
