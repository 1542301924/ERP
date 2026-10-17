/**
 * 我的单据：本账号提交的销售出库单列表（分页）。
 */
const api = require('../../api/index');
const fmt = require('../../lib/format');
const Toast = require('tdesign-miniprogram/toast/index');

const PAGE_SIZE = 20;

function dateText(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') return fmt.date(value);
  if (/^\d+$/.test(String(value))) return fmt.date(Number(value));
  return String(value);
}

function statusMeta(status) {
  const s = Number(status);
  if (s === 1) return { text: fmt.docStatusText(s), theme: 'success' };
  if (s === 9) return { text: fmt.docStatusText(s), theme: 'default' };
  return { text: fmt.docStatusText(s), theme: 'primary' };
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
      const res = await api.myOrders({ page, pageSize: PAGE_SIZE });
      const rows = (res.items || []).map((it) => {
        const meta = statusMeta(it.status);
        return {
          docId: it.docId,
          docNo: it.docNo,
          customerName: it.customerName,
          amountText: fmt.money(it.amount),
          statusText: meta.text,
          statusTheme: meta.theme,
          bizDateText: dateText(it.bizDate),
          itemCount: it.itemCount || 0,
        };
      });
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
