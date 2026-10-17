/**
 * 云函数入口（微信云开发）。
 *
 * 部署：微信开发者工具 → 云开发 → 云函数 → 右键 mp →「上传并部署（云端安装依赖）」。
 * 环境变量不需要额外配置，云环境由 DYNAMIC_CURRENT_ENV 自动指向当前环境。
 */
const cloud = require('wx-server-sdk');
const { createHandler } = require('./handler');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = createHandler({
  db: cloud.database(),
  getOpenId: () => cloud.getWXContext().OPENID,
  now: () => Date.now(),
});
