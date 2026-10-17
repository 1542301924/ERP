/**
 * 商品库存详情：基础信息 + 多仓分布 + 合计。
 */
const api = require('../../api/index');
const fmt = require('../../lib/format');
const Toast = require('tdesign-miniprogram/toast/index');

Page({
  data: {
    productId: '',
    product: null,
    balances: [],
    totalQtyText: '0',
    totalAvailText: '0',
    loading: true,
    error: false,
  },

  onLoad(query) {
    const productId = (query && query.productId) || '';
    this.setData({ productId });
    this.loadDetail();
  },

  onPullDownRefresh() {
    this.loadDetail().then(() => wx.stopPullDownRefresh());
  },

  toast(message, theme) {
    Toast({ context: this, selector: '#t-toast', message, theme: theme || 'success' });
  },

  async loadDetail() {
    if (!this.data.productId) {
      this.setData({ loading: false, error: true });
      return;
    }
    this.setData({ loading: true, error: false });
    try {
      const res = await api.productDetail(this.data.productId);
      const p = (res && res.product) || {};
      const rawBalances = (res && res.balances) || [];
      const balances = rawBalances.map((b) => ({
        warehouseName: b.warehouseName || '未知仓库',
        qtyText: fmt.qty(b.qty),
        availText: fmt.qty(b.availQty),
      }));
      const totalQty = rawBalances.reduce((s, b) => s + (Number(b.qty) || 0), 0);
      const totalAvail = rawBalances.reduce((s, b) => s + (Number(b.availQty) || 0), 0);

      this.setData({
        product: {
          code: p.code,
          name: p.name,
          spec: p.spec,
          unit: p.unit,
          barcode: p.barcode,
          salePriceText: fmt.money(p.salePrice),
        },
        balances,
        totalQtyText: fmt.qty(totalQty),
        totalAvailText: fmt.qty(totalAvail),
        loading: false,
      });
    } catch (e) {
      this.setData({ loading: false, error: true });
      this.toast('加载失败，请重试', 'error');
    }
  },
});
