/**
 * 开单：客户/仓库选项（meta）、提交销售出库单（create）、我的单据（mine）。
 *
 * 单据落库为「待审核」(status=0)，需桌面端审核后才生效（写库存流水）——与设计文档 §5.0 一致。
 * create 支持幂等：客户端在离线队列里带 docId 重试时，同一 docId 不会重复落库。
 */
const { ok, err, CODE, findOne, findMany, count, add, resolveUser, makeDocNo, newId, num, toTs } =
  require('./lib');

const MAX_SCAN = 1000;

/** 统一写库时携带的同步字段（与桌面端 schema §4.2 对齐，供 P7 拉取）。 */
function syncFields(userId, ts) {
  return {
    created_by: userId,
    created_at: ts,
    updated_by: null,
    updated_at: ts,
    version: 1,
    origin_device: 'mp',
    hlc: '',
    dirty_fields: null,
    sync_state: 0,
    deleted: 0,
  };
}

function createOrderActions({ db, getOpenId, now }) {
  return {
    /** 开单所需客户 / 仓库下拉项。 */
    async meta() {
      const guard = await resolveUser(db, getOpenId());
      if (guard.error) return guard.error;

      const customers = await findMany(db, 'customer', { status: 1, deleted: 0 }, { limit: MAX_SCAN });
      const warehouses = await findMany(db, 'warehouse', { status: 1, deleted: 0 }, { limit: MAX_SCAN });
      return ok({
        customers: customers.map((c) => ({ id: c.id, name: c.name })),
        warehouses: warehouses.map((w) => ({ id: w.id, name: w.name })),
      });
    },

    /** 提交销售出库单。 */
    async create(event = {}) {
      const guard = await resolveUser(db, getOpenId());
      if (guard.error) return guard.error;

      const customerId = String(event.customerId || '');
      const warehouseId = String(event.warehouseId || '');
      const rawItems = Array.isArray(event.items) ? event.items : [];

      if (!customerId) return err(CODE.VALIDATION, '请选择客户');
      if (!warehouseId) return err(CODE.VALIDATION, '请选择仓库');
      if (rawItems.length === 0) return err(CODE.VALIDATION, '请至少添加一条明细');

      const items = [];
      for (const it of rawItems) {
        const productId = String((it && it.productId) || '');
        const qty = num(it && it.qty, 0);
        if (!productId) return err(CODE.VALIDATION, '明细缺少商品');
        if (!(qty > 0)) return err(CODE.VALIDATION, '明细数量必须大于 0');
        items.push({ ...it, productId, qty, price: num(it && it.price, 0) });
      }

      const ts = now();
      const docId = String(event.docId || newId('mp', ts));

      // 幂等：同一 docId 已落库则直接返回既有单号（离线补传/重试不会重复）。
      const existing = await findOne(db, 'sales_outbound', { id: docId });
      if (existing) return ok({ docId, docNo: existing.doc_no, idempotent: true });

      const docNo = event.docNo || makeDocNo('XS', ts);
      const totalAmount = items.reduce((s, it) => s + it.qty * it.price, 0);
      const sync = syncFields(guard.user.id, ts);

      await add(db, 'sales_outbound', {
        id: docId,
        doc_no: docNo,
        outbound_type: '销售',
        customer_id: customerId,
        warehouse_id: warehouseId,
        source_order_id: null,
        biz_date: toTs(event.bizDate, ts),
        status: 0,
        handler_id: guard.user.id,
        total_amount: totalAmount,
        remark: event.remark || '',
        reversal_of: null,
        audited_by: null,
        audited_at: null,
        ...sync,
      });

      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        const factor = num(it.factor, 1) || 1;
        await add(db, 'sales_outbound_item', {
          id: `${docId}-${i + 1}`,
          outbound_id: docId,
          product_id: it.productId,
          location_id: it.locationId || null,
          unit_id: it.unitId || null,
          factor,
          qty: it.qty,
          base_qty: it.qty * factor,
          price: it.price,
          amount: it.qty * it.price,
          cost_price: null,
          cost_amount: null,
          remark: it.remark || '',
          ...sync,
        });
      }

      return ok({ docId, docNo, totalAmount });
    },

    /** 我的单据：本账号（微信绑定用户）提交的销售出库单，倒序分页。 */
    async mine(event = {}) {
      const guard = await resolveUser(db, getOpenId());
      if (guard.error) return guard.error;

      const page = Math.max(1, num(event.page, 1));
      const pageSize = Math.max(1, num(event.pageSize, 20));
      const where = { created_by: guard.user.id, deleted: 0 };

      const total = await count(db, 'sales_outbound', where);
      const rows = await findMany(db, 'sales_outbound', where, {
        limit: pageSize,
        skip: (page - 1) * pageSize,
        orderBy: { field: 'created_at', order: 'desc' },
      });

      const items = [];
      for (const r of rows) {
        const customer = r.customer_id
          ? await findOne(db, 'customer', { id: r.customer_id })
          : null;
        const itemCount = await count(db, 'sales_outbound_item', { outbound_id: r.id });
        items.push({
          docId: r.id,
          docNo: r.doc_no,
          customerName: customer ? customer.name : '',
          amount: num(r.total_amount),
          status: num(r.status, 0),
          bizDate: r.biz_date || null,
          itemCount,
        });
      }
      return ok({ items, total, page, pageSize });
    },
  };
}

module.exports = { createOrderActions };
