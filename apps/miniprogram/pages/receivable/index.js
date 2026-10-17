/**
 * 我的应收：按客户汇总的未收款列表（分页）。
 */
const api = require('../../api/index');
const fmt = require('../../lib/format');
const Toast = require('tdesign-miniprogram/toast/index');

const PAGE_SIZE = 20;

/** 兼容时间戳 / 日期字符串两种到期日格式。 */
function dateText(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') return fmt.date(value);
  if (/^\d+$/.test(String(value))) return fmt.date(Number(value));
  return String(value);
}

Page({
  data: {
    items: [],
    page: 0,
    total: 0,
    loading: false,
    finished: false,
    error: false,
  },

  onLoad() {
    this.loadPage(true);
  },

  onPullDownRefresh() {
    this.loadPage(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadPage(false);
  },

  toast(message, theme) {
    Toast({ context: this, selector: '#t-toast', message, theme: theme || 'success' });
  },

  async loadPage(reset) {
    if (this.data.loading) return;
    if (!reset && this.data.finished) return;

    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: false });

    try {
      const res = await api.myReceivables({ page, pageSize: PAGE_SIZE });
      const rows = (res.items || []).map((it) => ({
        customerId: it.customerId,
        customerName: it.customerName,
        amountText: fmt.money(it.amount),
        receivedText: fmt.money(it.receivedAmount),
        outstandingText: fmt.money(it.outstanding),
        dueText: dateText(it.dueDate),
      }));
      const items = reset ? rows : this.data.items.concat(rows);
      const total = res.total || 0;
      const finished = rows.length === 0 || items.length >= total;
      this.setData({ items, page, total, finished, loading: false });
    } catch (e) {
      this.setData({ loading: false, error: true });
      this.toast('加载失败，请下拉重试', 'error');
    }
  },
});
