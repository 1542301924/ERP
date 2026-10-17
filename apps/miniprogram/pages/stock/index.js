/**
 * Tab2 查库存：关键字 / 扫码查询，分页列表，点击进入商品库存详情。
 */
const api = require('../../api/index');
const fmt = require('../../lib/format');
const Toast = require('tdesign-miniprogram/toast/index');

const PAGE_SIZE = 10;

function mapRow(it) {
  return {
    productId: it.productId,
    code: it.code,
    name: it.name,
    spec: it.spec,
    unit: it.unit,
    warehouseName: it.warehouseName,
    qtyText: fmt.qty(it.qty),
    availText: fmt.qty(it.availQty),
    costText: fmt.money(it.avgCost),
  };
}

function eventValue(e) {
  const d = e && e.detail;
  if (typeof d === 'string') return d;
  if (d && typeof d.value === 'string') return d.value;
  if (d && d.value != null) return String(d.value);
  return '';
}

Page({
  data: {
    keyword: '',
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

  onKeywordChange(e) {
    this.setData({ keyword: eventValue(e) });
  },

  onSearch(e) {
    const value = eventValue(e);
    this.setData({ keyword: value, items: [], page: 0, finished: false });
    this.loadPage(true);
  },

  async loadPage(reset) {
    if (this.data.loading) return;
    if (!reset && this.data.finished) return;

    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: false });

    try {
      const res = await api.queryStock({
        keyword: this.data.keyword,
        page,
        pageSize: PAGE_SIZE,
      });
      const rows = (res.items || []).map(mapRow);
      const items = reset ? rows : this.data.items.concat(rows);
      const total = res.total || 0;
      const finished = rows.length === 0 || items.length >= total;
      this.setData({ items, page, total, finished, loading: false });
    } catch (e) {
      this.setData({ loading: false, error: true });
      this.toast('加载失败，请下拉重试', 'error');
    }
  },

  openDetail(e) {
    const productId = e.currentTarget.dataset.productId;
    if (!productId) return;
    wx.navigateTo({ url: `/pages/stock-detail/index?productId=${productId}` });
  },

  onScan() {
    wx.scanCode({
      success: async (res) => {
        const barcode = (res && res.result) || '';
        if (!barcode) return;
        try {
          const found = await api.lookupBarcode(barcode);
          if (found && found.product) {
            wx.navigateTo({ url: `/pages/stock-detail/index?productId=${found.product.id}` });
          } else {
            this.toast('未找到该条码对应商品', 'warning');
          }
        } catch (err) {
          this.toast('未找到该条码对应商品', 'warning');
        }
      },
      fail: () => {},
    });
  },
});
