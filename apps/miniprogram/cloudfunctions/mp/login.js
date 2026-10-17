/**
 * 登录：openid → 绑定 app_user，返回用户与角色。
 *
 * 绑定关系由 mp_binding 集合维护（桌面端「小程序可见角色」配置时写入）。
 * 小程序侧不做自动注册：未绑定 → NOT_BOUND，提示用户在「我的」页联系管理员。
 */
const { ok, resolveUser } = require('./lib');

function createLoginActions({ db, getOpenId }) {
  return {
    /** 静默登录：只认已有绑定关系。 */
    async login() {
      const { user, error } = await resolveUser(db, getOpenId());
      if (error) return error;
      return ok({ user });
    },
  };
}

module.exports = { createLoginActions };
