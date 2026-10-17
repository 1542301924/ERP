/**
 * 云函数调用封装：统一超时、错误归一、幂等查询重试。
 *
 * 错误码约定：
 *   NETWORK     网络不可用 / 超时 —— 提交类操作应转入离线队列
 *   BIZ         云端返回的业务失败（如校验不通过、无权限）
 *   CLOUD       云函数本身异常
 *   NOT_BOUND   微信账号未绑定桌面端 app_user
 */
const config = require('../config/index');

class ApiError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
  }
}

const NETWORK_PATTERN = /timeout|timed out|fail|network|ERR_|abort/i;

function isNetworkError(err) {
  const msg = (err && (err.errMsg || err.message)) || '';
  return NETWORK_PATTERN.test(msg);
}

function normalize(err, fnName) {
  if (err instanceof ApiError) return err;
  const msg = (err && (err.errMsg || err.message)) || '未知错误';
  if (isNetworkError(err)) return new ApiError('NETWORK', '网络不可用，请稍后重试', msg);
  return new ApiError('CLOUD', `调用云函数 ${fnName} 失败：${msg}`, msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** wx.cloud.callFunction 无法自带超时，用 Promise.race 兜住挂死。 */
function callWithTimeout(name, data, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error('云函数调用超时'), { errMsg: 'timeout' }));
    }, timeoutMs);
    wx.cloud.callFunction({ name, data })
      .then((res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * 调用云函数并解包 result。
 * 云函数统一返回 { ok:true, data } 或 { ok:false, code, message, detail }。
 * @param {string} name 云函数名
 * @param {object} data 参数
 * @param {{retry?:number}} [opts] retry 仅用于幂等只读接口
 */
async function call(name, data = {}, opts = {}) {
  const tries = (opts.retry ?? config.CALL.retry) + 1;
  let lastError;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await callWithTimeout(name, data, config.CALL.timeoutMs);
      const payload = res && res.result;
      if (!payload || typeof payload !== 'object') {
        throw new ApiError('CLOUD', '云端返回格式异常');
      }
      if (payload.ok === false) {
        throw new ApiError(payload.code || 'BIZ', payload.message || '业务处理失败', payload.detail);
      }
      return payload.data;
    } catch (err) {
      lastError = normalize(err, name);
      const canRetry = lastError.code === 'NETWORK' && i < tries - 1;
      if (!canRetry) break;
      await sleep(config.CALL.retryDelayMs * (i + 1));
    }
  }
  throw lastError;
}

module.exports = { call, ApiError, isNetworkError, normalize };
