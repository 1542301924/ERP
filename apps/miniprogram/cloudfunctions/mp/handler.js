/**
 * 动作分发器：把 { action } 映射到具体处理函数，并统一兜住异常。
 *
 * 依赖注入（deps）：
 *   db        数据访问端口（见 lib.js 注释）
 *   getOpenId 取当前调用者 openid
 *   now       时间戳函数（便于单测固定时间）
 */
const { err } = require('./lib');
const { createLoginActions } = require('./login');
const { createStockActions } = require('./stock');
const { createOrderActions } = require('./order');
const { createArActions } = require('./ar');

function createHandler(deps) {
  const actions = {
    ...createLoginActions(deps),
    ...createStockActions(deps),
    ...createOrderActions(deps),
    ...createArActions(deps),
  };

  return async function main(event) {
    const action = (event && event.action) || 'login';
    const fn = actions[action];
    if (!fn) return err('VALIDATION', `未知动作：${action}`);
    try {
      return await fn(event || {});
    } catch (e) {
      console.error('[mp] 未捕获异常', action, e);
      return err('CLOUD', (e && e.message) || '云函数执行失败');
    }
  };
}

module.exports = { createHandler };
