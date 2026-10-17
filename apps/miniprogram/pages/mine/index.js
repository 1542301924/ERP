/**
 * Tab4 我的：用户信息 + 分组入口 + 同步状态 + 切换账号 + 云环境状态。
 */
const api = require('../../api/index');
const Toast = require('tdesign-miniprogram/toast/index');

Page({
  data: {
    user: null,
    envReady: false,
    queueDesc: '待发 0 · 重试 0 · 阻塞 0',
    flushing: false,
  },

  onShow() {
    this.refreshUser();
    this.refreshQueue();
    const app = getApp();
    this.setData({ envReady: !!(app && app.globalData && app.globalData.envReady) });
  },

  onPullDownRefresh() {
    this.refreshQueue();
    wx.stopPullDownRefresh();
  },

  refreshUser() {
    const app = getApp();
    this.setData({ user: (app && app.globalData ? app.globalData.user : null) || null });
  },

  refreshQueue() {
    try {
      const s = api.queueSummary();
      this.setData({
        queueDesc: `待发 ${s.pending || 0} · 重试 ${s.retrying || 0} · 阻塞 ${s.blocked || 0}`,
      });
    } catch (e) {
      this.setData({ queueDesc: '待发 0 · 重试 0 · 阻塞 0' });
    }
  },

  toast(message, theme) {
    Toast({ context: this, selector: '#t-toast', message, theme: theme || 'success' });
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

  onSwitchAccount() {
    try {
      wx.clearStorageSync();
    } catch (e) {
      /* ignore */
    }
    const app = getApp();
    if (app && app.globalData) app.globalData.user = null;
    this.setData({ user: null });
    this.toast('已清除本地登录态');
    this.refreshQueue();
    this.login();
  },

  async login() {
    try {
      const user = await api.login();
      const app = getApp();
      if (app && app.globalData) app.globalData.user = user;
      this.setData({ user: user || null });
      this.toast('登录成功');
    } catch (e) {
      this.toast('登录失败，请稍后重试', 'error');
    }
  },

  onEnvTap() {
    this.toast('请检查云开发环境配置', 'warning');
  },
});
