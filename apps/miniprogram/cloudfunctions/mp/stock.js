/**
 * 查库存：关键字检索 / 扫码定位 / 商品库存详情（多仓分布）/ 库存预警摘要。
 *
 * 云数据库无 join：商品、库存余额、仓库、单位分属不同集合，这里在云函数内做
 * 「小表关联 + 内存聚合」。面向轻量进销存场景（商品量级数千以内），一次性取回后过滤足够。
 * 所有动作先经过 resolveUser，确保「小程序可见角色范围」对每个入口都生效。
 */
const { ok, err, CODE, findOne, findMany, resolveUser, num } = require('./lib');

/** 单次扫描上限，避免超大集合一次性取回。 */
const MAX_SCAN = 1000;

function lower(v) {
  return String(v == null ? '' : v).toLowerCase();
}

function matchKeyword(p, kw) {
  if (!kw) return true;
  const k = lower(kw);
  return (
    lower(p.name).includes(k) ||
    lower(p.code).includes(k) ||
    lower(p.barcode).includes(k) ||
    lower(p.spec).includes(k)
  );
}

/** 按 id 集合批量取仓库名。 */
async function warehouseNameMap(db, ids) {
  const map = {};
  for (const id of ids) {
    const w = await findOne(db, 'warehouse', { id });
    if (w) map[id] = w.name;
  }
  return map;
}

/** 库存余额聚合：数量/可用量/成本金额 → 合计 + 移动加权均价。 */
function aggregate(balances) {
  let qty = 0;
  let availQty = 0;
  let costAmount = 0;
  const whIds = new Set();
  for (const b of balances) {
    qty += num(b.qty);
    availQty += num(b.avail_qty);
    costAmount += num(b.cost_amount);
    if (b.warehouse_id) whIds.add(b.warehouse_id);
  }
  return { qty, availQty, avgCost: qty > 0 ? costAmount / qty : 0, whIds: [...whIds] };
}

function warehouseLabel(whIds, nameMap) {
  if (whIds.length === 0) return '—';
  if (whIds.length === 1) return nameMap[whIds[0]] || '未知仓库';
  return `${whIds.length} 个仓库`;
}

async function unitName(db, baseUnitId) {
  if (!baseUnitId) return '';
  const u = await findOne(db, 'unit', { id: baseUnitId });
  return u ? u.name : '';
}

function createStockActions({ db, getOpenId }) {
  return {
    /** 关键字/条码检索，返回按商品聚合的库存行（分页）。 */
    async query(event = {}) {
      const guard = await resolveUser(db, getOpenId());
      if (guard.error) return guard.error;

      const keyword = event.keyword || '';
      const page = Math.max(1, num(event.page, 1));
      const pageSize = Math.max(1, num(event.pageSize, 10));

      const products = await findMany(
        db,
        'product',
        { status: 1, deleted: 0 },
        { limit: MAX_SCAN },
      );
      const hit = products.filter((p) => matchKeyword(p, keyword));
      const total = hit.length;
      const pageItems = hit.slice((page - 1) * pageSize, page * pageSize);

      const balancesByProduct = {};
      const whIds = new Set();
      for (const p of pageItems) {
        const bs = await findMany(db, 'stock_balance', { product_id: p.id }, { limit: 200 });
        balancesByProduct[p.id] = bs;
        bs.forEach((b) => b.warehouse_id && whIds.add(b.warehouse_id));
      }
      const nameMap = await warehouseNameMap(db, whIds);

      const items = [];
      for (const p of pageItems) {
        const agg = aggregate(balancesByProduct[p.id] || []);
        items.push({
          productId: p.id,
          code: p.code,
          name: p.name,
          spec: p.spec || '',
          barcode: p.barcode || '',
          unit: await unitName(db, p.base_unit_id),
          warehouseName: warehouseLabel(agg.whIds, nameMap),
          qty: agg.qty,
          availQty: agg.availQty,
          avgCost: agg.avgCost,
          salePrice: num(p.sale_price, 0),
        });
      }
      return ok({ items, total, page, pageSize });
    },

    /** 条码 → 商品（主条码优先，其次商品条码表）。 */
    async lookup(event = {}) {
      const guard = await resolveUser(db, getOpenId());
      if (guard.error) return guard.error;

      const barcode = String(event.barcode || '').trim();
      if (!barcode) return err(CODE.VALIDATION, '缺少条码');

      let product = await findOne(db, 'product', { barcode, deleted: 0 });
      if (!product) {
        const hit = await findOne(db, 'product_barcode', { barcode, deleted: 0 });
        if (hit) product = await findOne(db, 'product', { id: hit.product_id, deleted: 0 });
      }
      if (!product || Number(product.status) === 0) return ok({ product: null });

      return ok({
        product: {
          id: product.id,
          code: product.code,
          name: product.name,
          spec: product.spec || '',
          barcode: product.barcode || barcode,
          unit: await unitName(db, product.base_unit_id),
          salePrice: num(product.sale_price, 0),
        },
      });
    },

    /** 商品库存详情：基础信息 + 多仓分布。 */
    async detail(event = {}) {
      const guard = await resolveUser(db, getOpenId());
      if (guard.error) return guard.error;

      const productId = String(event.productId || '');
      if (!productId) return err(CODE.VALIDATION, '缺少商品 ID');

      const product = await findOne(db, 'product', { id: productId });
      if (!product || Number(product.deleted) === 1) {
        return err(CODE.VALIDATION, '商品不存在或已删除');
      }

      const balances = await findMany(db, 'stock_balance', { product_id: productId }, { limit: 200 });
      const nameMap = await warehouseNameMap(
        db,
        balances.map((b) => b.warehouse_id).filter(Boolean),
      );

      return ok({
        product: {
          id: product.id,
          code: product.code,
          name: product.name,
          spec: product.spec || '',
          unit: await unitName(db, product.base_unit_id),
          barcode: product.barcode || '',
          salePrice: num(product.sale_price, 0),
        },
        balances: balances.map((b) => ({
          warehouseId: b.warehouse_id,
          warehouseName: nameMap[b.warehouse_id] || '未知仓库',
          qty: num(b.qty),
          availQty: num(b.avail_qty),
        })),
      });
    },

    /** 库存预警摘要：低于 min_stock 的商品，按缺口升序取前 limit 条。 */
    async alerts(event = {}) {
      const guard = await resolveUser(db, getOpenId());
      if (guard.error) return guard.error;

      const limit = Math.max(1, num(event.limit, 5));
      const products = await findMany(
        db,
        'product',
        { status: 1, deleted: 0 },
        { limit: MAX_SCAN },
      );
      const watched = products.filter((p) => num(p.min_stock, 0) > 0);

      const rows = [];
      for (const p of watched) {
        const bs = await findMany(db, 'stock_balance', { product_id: p.id }, { limit: 200 });
        const qty = bs.reduce((s, b) => s + num(b.qty), 0);
        if (qty < num(p.min_stock, 0)) {
          rows.push({
            productId: p.id,
            name: p.name,
            code: p.code,
            qty,
            minStock: num(p.min_stock, 0),
          });
        }
      }
      rows.sort((a, b) => a.qty - b.qty);
      return ok({ items: rows.slice(0, limit), total: rows.length });
    },
  };
}

module.exports = { createStockActions };
