/**
 * 只读数据的本地缓存（带 TTL），减少云函数调用与离线时的空白页。
 */
const config = require('../config/index');

const PREFIX = 'cache_v1:';

function set(key, value) {
  try {
    wx.setStorageSync(PREFIX + key, { at: Date.now(), value });
  } catch (e) {
    console.warn('[cache] 写入失败', key, e);
  }
}

/** 读取缓存；过期仍可用时返回 stale 标记，便于页面先渲染再刷新。 */
function get(key, ttl = config.CACHE_TTL_MS) {
  try {
    const raw = wx.getStorageSync(PREFIX + key);
    if (!raw || typeof raw !== 'object') return null;
    return { value: raw.value, stale: Date.now() - raw.at > ttl, at: raw.at };
  } catch (e) {
    return null;
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(PREFIX + key);
  } catch (e) {
    /* ignore */
  }
}

module.exports = { set, get, remove };
