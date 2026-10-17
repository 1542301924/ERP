/**
 * 我的应收：未结清的应收单据（ar_bill），客户名在云函数内关联补齐。
 *
 * ar_bill 为「客户级」账款（无单据归属人），这里返回全部未结清账款，
 * 由客户维度汇总展示；outstanding = amount - received_amount，<= 0 视为已结清并过滤。
 */
const { ok, findOne, findMany, resolveUser, num } = require('./lib');

const MAX_SCAN = 1000;

function createArActions({ db, getOpenId }) {
  return {
    /** 未结清应收（分页，按到期日升序）。action 名与 order.mine 区分，避免合并时覆盖。 */
    async arMine(event = {}) {
      const guard = await resolveUser(db, getOpenId());
      if (guard.error) return guard.error;

      const page = Math.max(1, num(event.page, 1));
      const pageSize = Math.max(1, num(event.pageSize, 20));

      const rows = await findMany(db, 'ar_bill', { deleted: 0 }, { limit: MAX_SCAN });
      const open = rows
        .map((r) => ({ ...r, outstanding: num(r.amount) - num(r.received_amount) }))
        .filter((r) => r.outstanding > 0)
        .sort((a, b) => num(a.due_date) - num(b.due_date));

      const total = open.length;
      const pageItems = open.slice((page - 1) * pageSize, page * pageSize);

      const items = [];
      for (const r of pageItems) {
        const customer = r.customer_id ? await findOne(db, 'customer', { id: r.customer_id }) : null;
        items.push({
          customerId: r.customer_id,
          customerName: customer ? customer.name : '',
          amount: num(r.amount),
          receivedAmount: num(r.received_amount),
          outstanding: r.outstanding,
          dueDate: r.due_date || null,
        });
      }
      return ok({ items, total, page, pageSize });
    },
  };
}

module.exports = { createArActions };
