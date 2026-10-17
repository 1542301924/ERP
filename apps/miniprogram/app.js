/**
 * 小程序入口：初始化云开发 + 全局登录态。
 */
const config = require('./config/index');
const api = require('./api/index');

App({
  globalData: {
    /** 当前登录用户（含角色与权限），null 表示未登录。 */
    user: null,
    /** 云环境是否初始化成功。 */
    envReady: false,
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('[app] 当前基础库不支持云开发，请在开发者工具中调高基础库版本');
      return;
    }
    wx.cloud.init({
      env: config.ENV.envId || undefined,
      traceUser: true,
    });
    this.globalData.envReady = true;
    // 静默尝试登录（失败不阻塞，各页面自行处理未登录态）
    api.login().then((user) => {
      this.globalData.user = user;
    }).catch(() => {});
  },

  /** 页面统一入口：确保已登录，未登录则拉起登录流程。 */
  async ensureLogin() {
    if (this.globalData.user) return this.globalData.user;
    const user = await api.login();
    this.globalData.user = user;
    return user;
  },
});
