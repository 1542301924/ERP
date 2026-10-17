/**
 * Tab1 工作台：问候 + 库存预警摘要 + 快捷入口 + 离线待同步提示。
 */
const api = require('../../api/index');
const fmt = require('../../lib/format');
const Toast = require('tdesign-miniprogram/toast/index');

function greetingText() {
  const h = new Date().getHours();
  if (h < 6) return '凌晨好';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

Page({
  data: {
    greeting: greetingText(),
    user: null,
    alerts: [],
    alertsLoading: true,
    alertsError: false,
    alertsFromCache: false,
    queueTotal: 0,
    flushing: false,
  },

  onLoad() {
    this._syncUser();
  },

  onShow() {
    this._syncUser();
    this.loadAlerts();
    this.refreshQueue();
  },

  onPullDownRefresh() {
    Promise.all([this.loadAlerts(), this.refreshQueue()]).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  _syncUser() {
    const app = getApp();
    const user = app && app.globalData ? app.globalData.user : null;
    this.setData({ user: user || null });
    if (!user && app && app.ensureLogin) {
      app.ensureLogin()
        .then((u) => this.setData({ user: u || null }))
        .catch(() => {});
    }
  },

  toast(message, theme) {
    Toast({ context: this, selector: '#t-toast', message, theme: theme || 'success' });
  },

  async goLogin() {
    try {
      const user = await getApp().ensureLogin();
      this.setData({ user: user || null });
      this.toast('登录成功');
    } catch (e) {
      this.toast('登录失败，请稍后重试', 'error');
    }
  },

  async loadAlerts() {
    this.setData({ alertsLoading: true, alertsError: false });
    try {
      const res = await api.stockAlerts(5);
      const alerts = (res.items || []).map((it) => {
        const stock = Number(it.qty);
        return {
          productId: it.productId,
          name: it.name,
          code: it.code,
          qtyText: fmt.qty(it.qty),
          minText: fmt.qty(it.minStock),
          tagText: stock <= 0 ? '缺货' : '偏低',
          tagTheme: stock <= 0 ? 'danger' : 'warning',
        };
      });
      this.setData({ alerts, alertsFromCache: !!res.fromCache, alertsLoading: false });
    } catch (e) {
      this.setData({ alertsLoading: false, alertsError: true });
    }
  },

  refreshQueue() {
    try {
      const summary = api.queueSummary();
      this.setData({ queueTotal: summary.total || 0 });
    } catch (e) {
      this.setData({ queueTotal: 0 });
    }
  },

  openAlert(e) {
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

  goReceivable() {
    wx.navigateTo({ url: '/pages/receivable/index' });
  },

  goDocs() {
    wx.navigateTo({ url: '/pages/docs/index' });
  },

  async onFlush() {
    if (this.data.flushing) return;
    this.setData({ flushing: true });
    try {
      const res = await api.flushQueue();
      this.refreshQueue();
      if (res && res.sent) {
        this.toast(`已同步 ${res.sent} 条`);
      } else {
        this.toast('已是最新，无需同步', 'warning');
      }
    } catch (e) {
      this.toast('同步失败，请检查网络', 'error');
    } finally {
      this.setData({ flushing: false });
    }
  },
});
