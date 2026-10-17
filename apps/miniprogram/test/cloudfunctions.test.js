/**
 * 云函数 mp 纯逻辑单测（node:test，无需微信 / 云环境）。
 *
 * 覆盖：登录与权限范围、查库存/扫码/详情/预警、开单（含幂等与校验）、我的单据、我的应收。
 * 数据访问用内存实现替换真实云数据库（见 memory-db.js）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createHandler } = require('../cloudfunctions/mp/handler');
const { createMemoryDb } = require('./memory-db');

const OPENID = 'o1';

function baseSeed(extra = {}) {
  return {
    role: [{ id: 'r_sales', name: '销售' }],
    app_user: [{ id: 'u1', account: 'sale1', name: '张三', role_id: 'r_sales', status: 1 }],
    mp_binding: [{ openid: OPENID, user_id: 'u1' }],
    mp_config: [],
    unit: [{ id: 'u_pcs', name: '个' }],
    warehouse: [{ id: 'w1', name: '主仓', status: 1, deleted: 0 }],
    customer: [{ id: 'c1', name: '客户A', status: 1, deleted: 0 }],
    product: [
      {
        id: 'p1',
        code: 'P001',
        name: '螺丝',
        spec: 'M6',
        barcode: '6900001',
        base_unit_id: 'u_pcs',
        sale_price: 2.5,
        min_stock: 10,
        status: 1,
        deleted: 0,
      },
      {
        id: 'p2',
        code: 'P002',
        name: '螺母',
        spec: '',
        barcode: '6900002',
        base_unit_id: 'u_pcs',
        sale_price: 1.5,
        min_stock: 0,
        status: 1,
        deleted: 0,
      },
    ],
    product_barcode: [{ id: 'pb1', product_id: 'p2', barcode: '8800002', deleted: 0 }],
    stock_balance: [
      { id: 'b1', product_id: 'p1', warehouse_id: 'w1', qty: 8, avail_qty: 8, cost_amount: 16 },
      { id: 'b2', product_id: 'p2', warehouse_id: 'w1', qty: 100, avail_qty: 100, cost_amount: 50 },
    ],
    ar_bill: [
      { id: 'ar1', customer_id: 'c1', amount: 100, received_amount: 40, status: 0, due_date: 1000, deleted: 0 },
      { id: 'ar2', customer_id: 'c1', amount: 50, received_amount: 50, status: 1, due_date: 2000, deleted: 0 },
    ],
    ...extra,
  };
}

function makeMain(seed, opts = {}) {
  const db = createMemoryDb(seed);
  const main = createHandler({
    db,
    getOpenId: () => (opts.openid === undefined ? OPENID : opts.openid),
    now: () => opts.now || 1700000000000,
  });
  return { main, db };
}

test('login：已绑定用户返回用户与角色', async () => {
  const { main } = makeMain(baseSeed());
  const res = await main({ action: 'login' });
  assert.equal(res.ok, true);
  assert.equal(res.data.user.id, 'u1');
  assert.equal(res.data.user.roleName, '销售');
});

test('login：未绑定 openid 返回 NOT_BOUND', async () => {
  const { main } = makeMain(baseSeed(), { openid: 'unknown' });
  const res = await main({ action: 'login' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NOT_BOUND');
});

test('login：角色不在可见范围返回 NO_PERMISSION', async () => {
  const { main } = makeMain(
    baseSeed({ mp_config: [{ key: 'mp_visible_roles', value: ['r_admin'] }] }),
  );
  const res = await main({ action: 'login' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_PERMISSION');
});

test('stock.query：按商品聚合库存并支持关键字过滤', async () => {
  const { main } = makeMain(baseSeed());
  const all = await main({ action: 'query', page: 1, pageSize: 10 });
  assert.equal(all.ok, true);
  assert.equal(all.data.total, 2);

  const kw = await main({ action: 'query', keyword: '螺丝', page: 1, pageSize: 10 });
  assert.equal(kw.data.total, 1);
  const row = kw.data.items[0];
  assert.equal(row.productId, 'p1');
  assert.equal(row.unit, '个');
  assert.equal(row.warehouseName, '主仓');
  assert.equal(row.qty, 8);
  assert.equal(row.avgCost, 2); // 16 / 8
  assert.equal(row.salePrice, 2.5);
});

test('stock.lookup：主条码与商品条码表均可命中', async () => {
  const { main } = makeMain(baseSeed());
  const byMain = await main({ action: 'lookup', barcode: '6900001' });
  assert.equal(byMain.data.product.id, 'p1');
  const byAlt = await main({ action: 'lookup', barcode: '8800002' });
  assert.equal(byAlt.data.product.id, 'p2');
  const miss = await main({ action: 'lookup', barcode: 'nothing' });
  assert.equal(miss.ok, true);
  assert.equal(miss.data.product, null);
});

test('stock.detail：返回商品信息与多仓分布', async () => {
  const { main } = makeMain(baseSeed());
  const res = await main({ action: 'detail', productId: 'p1' });
  assert.equal(res.ok, true);
  assert.equal(res.data.product.name, '螺丝');
  assert.equal(res.data.balances.length, 1);
  assert.equal(res.data.balances[0].warehouseName, '主仓');
  assert.equal(res.data.balances[0].qty, 8);
});

test('stock.alerts：仅返回低于预警线的商品并按缺口升序', async () => {
  const { main } = makeMain(baseSeed());
  const res = await main({ action: 'alerts', limit: 5 });
  assert.equal(res.ok, true);
  assert.equal(res.data.items.length, 1);
  assert.equal(res.data.items[0].productId, 'p1');
  assert.equal(res.data.items[0].minStock, 10);
});

test('order.meta：返回启用的客户与仓库', async () => {
  const { main } = makeMain(baseSeed());
  const res = await main({ action: 'meta' });
  assert.equal(res.data.customers.length, 1);
  assert.equal(res.data.warehouses.length, 1);
  assert.equal(res.data.warehouses[0].name, '主仓');
});

test('order.create：落库待审核单据及明细，返回单号', async () => {
  const { main, db } = makeMain(baseSeed());
  const res = await main({
    action: 'create',
    customerId: 'c1',
    warehouseId: 'w1',
    bizDate: '2026-10-17',
    remark: '测试',
    items: [
      { productId: 'p1', qty: 2, price: 2.5 },
      { productId: 'p2', qty: 3, price: 1.5 },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.totalAmount, 2 * 2.5 + 3 * 1.5);
  assert.match(res.data.docNo, /^XS\d{8}\d{6}$/);

  const docs = db.__store.sales_outbound;
  assert.equal(docs.length, 1);
  assert.equal(docs[0].status, 0); // 待审核
  assert.equal(docs[0].outbound_type, '销售');
  assert.equal(docs[0].created_by, 'u1');
  assert.equal(docs[0].origin_device, 'mp');

  const items = db.__store.sales_outbound_item;
  assert.equal(items.length, 2);
  assert.equal(items[0].base_qty, 2);
  assert.equal(items[1].amount, 4.5);
});

test('order.create：同一 docId 幂等，不重复落库', async () => {
  const { main, db } = makeMain(baseSeed());
  const payload = {
    action: 'create',
    docId: 'mp-fixed-1',
    customerId: 'c1',
    warehouseId: 'w1',
    items: [{ productId: 'p1', qty: 1, price: 2.5 }],
  };
  const first = await main(payload);
  const second = await main(payload);
  assert.equal(first.data.docId, 'mp-fixed-1');
  assert.equal(second.data.docId, 'mp-fixed-1');
  assert.equal(second.data.docNo, first.data.docNo);
  assert.equal(db.__store.sales_outbound.length, 1);
  assert.equal(db.__store.sales_outbound_item.length, 1);
});

test('order.create：缺少客户 / 空明细 / 数量为 0 均校验失败', async () => {
  const { main } = makeMain(baseSeed());
  const noCustomer = await main({ action: 'create', warehouseId: 'w1', items: [{ productId: 'p1', qty: 1 }] });
  assert.equal(noCustomer.code, 'VALIDATION');

  const noItems = await main({ action: 'create', customerId: 'c1', warehouseId: 'w1', items: [] });
  assert.equal(noItems.code, 'VALIDATION');

  const zeroQty = await main({
    action: 'create',
    customerId: 'c1',
    warehouseId: 'w1',
    items: [{ productId: 'p1', qty: 0 }],
  });
  assert.equal(zeroQty.code, 'VALIDATION');
});

test('order.mine：列出本账号提交的单据并聚合明细数', async () => {
  const { main } = makeMain(baseSeed());
  await main({
    action: 'create',
    docId: 'd1',
    customerId: 'c1',
    warehouseId: 'w1',
    items: [{ productId: 'p1', qty: 2, price: 2.5 }],
  });
  const res = await main({ action: 'mine', page: 1, pageSize: 20 });
  assert.equal(res.data.total, 1);
  assert.equal(res.data.items[0].docId, 'd1');
  assert.equal(res.data.items[0].customerName, '客户A');
  assert.equal(res.data.items[0].amount, 5);
  assert.equal(res.data.items[0].itemCount, 1);
});

test('ar.arMine：仅返回未结清应收并计算未收金额', async () => {
  const { main } = makeMain(baseSeed());
  const res = await main({ action: 'arMine', page: 1, pageSize: 20 });
  assert.equal(res.ok, true);
  assert.equal(res.data.total, 1); // 只有 ar1 未结清
  assert.equal(res.data.items[0].customerName, '客户A');
  assert.equal(res.data.items[0].outstanding, 60);
});

test('权限：角色不在可见范围时业务查询也被拦截', async () => {
  const { main } = makeMain(
    baseSeed({ mp_config: [{ key: 'mp_visible_roles', value: ['r_admin'] }] }),
  );
  const res = await main({ action: 'query' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_PERMISSION');
});

test('未知动作返回 VALIDATION', async () => {
  const { main } = makeMain(baseSeed());
  const res = await main({ action: 'nope' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'VALIDATION');
});
