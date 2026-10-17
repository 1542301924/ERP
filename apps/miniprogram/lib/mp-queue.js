/**
 * 离线队列的单例（绑定微信本地存储）+ 网络恢复后自动补传。
 */
const { Queue } = require('./offline-queue');
const config = require('../config/index');

const STORAGE_KEY = 'offline_queue_v1';

const storage = {
  read() {
    try {
      const raw = wx.getStorageSync(STORAGE_KEY);
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      return [];
    }
  },
  write(list) {
    try {
      wx.setStorageSync(STORAGE_KEY, list);
    } catch (e) {
      console.error('[queue] 写入本地队列失败', e);
    }
  },
};

const queue = new Queue(storage, config.QUEUE);

/** 待投递操作 → 云端调用（由 api 层注入，避免循环依赖）。 */
let sender = null;
/** 投递完成后回调（页面刷新同步状态）。 */
let onChange = null;

function setSender(fn) {
  sender = fn;
}

function setOnChange(fn) {
  onChange = fn;
}

/** 手动补传（网络恢复或用户点「立即同步」时调用）。 */
async function flush() {
  if (!sender) return { skipped: true };
  const result = await queue.flush(sender);
  if (onChange) onChange(result);
  return result;
}

/** 注册网络恢复自动补传，只注册一次。 */
let networkBound = false;
function bindNetworkAutoFlush() {
  if (networkBound) return;
  networkBound = true;
  wx.onNetworkStatusChange((res) => {
    if (res.isConnected) {
      flush().catch((err) => console.warn('[queue] 自动补传失败', err));
    }
  });
}

module.exports = { queue, setSender, setOnChange, flush, bindNetworkAutoFlush, STORAGE_KEY };
