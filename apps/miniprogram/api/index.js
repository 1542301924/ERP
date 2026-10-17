/**
 * 业务 API：小程序各页面只依赖这里，不直接碰 wx.cloud。
 *
 * 设计约定：
 * - 所有只读接口（查库存 / 详情 / 应收 / 单据 / 元数据）走 client.call，失败自动重试。
 * - 所有写接口（开单）在**离线或网络失败**时转入离线队列，页面无需分支处理。
 */
const client = require('./client');
const config = require('../config/index');
const cache = require('../lib/cache');
const mpQueue = require('../lib/mp-queue');

const FN = config.FN;

// ---------------------------------------------------------------- 登录

/** 微信登录：openid → 绑定 app_user，返回用户与权限。 */
async function login() {
  const data = await client.call(FN.MP, { action: 'login' }, { retry: 0 });
  return data.user;
}

// ---------------------------------------------------------------- 查库存

/** 查库存（关键字 / 条码 / 仓库）。 */
async function queryStock(params) {
  return client.call(FN.MP, { action: 'query', ...params });
}

/** 条码 → 商品 + 库存（扫码后直接定位）。 */
async function lookupBarcode(barcode) {
  return client.call(FN.MP, { action: 'lookup', barcode }, { retry: 1 });
}

/** 商品库存详情（多仓分布）。 */
async function productDetail(productId) {
  return client.call(FN.MP, { action: 'detail', productId });
}

/** 库存预警摘要（工作台用），带本地缓存。 */
async function stockAlerts(limit = 5) {
  const key = `alerts:${limit}`;
  try {
    const data = await client.call(FN.MP, { action: 'alerts', limit });
    cache.set(key, data);
    return { ...data, fromCache: false };
  } catch (err) {
    const cached = cache.get(key);
    if (cached) return { ...cached.value, fromCache: true };
    throw err;
  }
}

// ---------------------------------------------------------------- 开单

/** 开单所需的客户 / 仓库选项。 */
async function orderMeta() {
  const key = 'order:meta';
  try {
    const data = await client.call(FN.MP, { action: 'meta' });
    cache.set(key, data);
    return data;
  } catch (err) {
    const cached = cache.get(key);
    if (cached) return cached.value;
    throw err;
  }
}

/** 提交销售出库单：在线直连，离线/失败转离线队列。 */
async function submitSalesOrder(payload) {
  try {
    return await client.call(FN.MP, { action: 'create', ...payload }, { retry: 0 });
  } catch (err) {
    if (err.code === 'NETWORK') {
      const docId = payload.docId || `mp-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const op = {
        type: 'sales_order.create',
        docId,
        payload: { ...payload, docId },
        createdAt: Date.now(),
      };
      const summary = mpQueue.queue.push(op);
      return { queued: true, docId, docNo: payload.docNo || '', summary };
    }
    throw err;
  }
}

/** 我的单据（本账号在小程序提交的销售出库单）。 */
async function myOrders(params = {}) {
  return client.call(FN.MP, { action: 'mine', ...params });
}

// ---------------------------------------------------------------- 应收

/** 我的应收（按客户汇总的未收款）。 */
async function myReceivables(params = {}) {
  return client.call(FN.MP, { action: 'arMine', ...params });
}

// ---------------------------------------------------------------- 同步

/** 立即补传离线队列。 */
function flushQueue() {
  return mpQueue.flush();
}

/** 队列摘要。 */
function queueSummary() {
  return mpQueue.queue.summary();
}

module.exports = {
  ApiError: client.ApiError,
  login,
  queryStock,
  lookupBarcode,
  productDetail,
  stockAlerts,
  orderMeta,
  submitSalesOrder,
  myOrders,
  myReceivables,
  flushQueue,
  queueSummary,
};

// ---------------------------------------------------------------- 初始化
// 把离线队列的「投递实现」接到云函数上：队列负责重试/阻塞，云端负责落库。
mpQueue.setSender((op) =>
  client.call(FN.MP, { action: 'create', ...op.payload }, { retry: 0 }),
);
try {
  mpQueue.bindNetworkAutoFlush();
} catch (e) {
  console.warn('[api] 网络监听注册失败（可忽略）', e);
}
