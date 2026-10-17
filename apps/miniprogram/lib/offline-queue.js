/**
 * 离线队列核心（纯逻辑，无 wx 依赖）。
 *
 * 设计要点：
 * - 每个待同步操作带幂等键 `type:docId`，入队时按 key 去重（同一单据只保留最新 payload），
 *   保证「离线改单 → 反复入队」不会产生重复提交。
 * - 队列只保存「尚未被云端确认」的操作；投递成功即移除，失败则累加 retries。
 * - 所有函数均为纯函数（不改动入参），Queue 类只做「存储读写 + 投递编排」。
 */

/** 幂等键：同一业务对象的同一操作只应被云端处理一次。 */
function opKey(op) {
  return `${op.type}:${op.docId}`;
}

/**
 * 入队。
 * @param {Array} list 现有队列
 * @param {object} op 待入队操作 { type, docId, payload, createdAt }
 * @param {number} max 队列上限
 */
function enqueue(list, op, max = 200) {
  const key = opKey(op);
  const next = list.filter((x) => opKey(x) !== key);
  next.push({
    type: op.type,
    docId: op.docId,
    payload: op.payload,
    createdAt: op.createdAt,
    key,
    retries: 0,
    lastError: null,
    updatedAt: op.createdAt,
  });
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 取一批待投递操作（按入队顺序，先进先出）。 */
function takeBatch(list, n) {
  return { batch: list.slice(0, n), rest: list.slice(n) };
}

/** 投递成功：按 key 移除。 */
function ack(list, keys) {
  const set = new Set(keys);
  return list.filter((x) => !set.has(x.key));
}

/** 投递失败：累加重试次数并记录最后一次错误。 */
function fail(list, key, message) {
  return list.map((x) => (x.key === key ? { ...x, retries: x.retries + 1, lastError: message } : x));
}

/** 仍可重试的项（未超过上限）。 */
function retryable(list, maxRetry) {
  return list.filter((x) => x.retries < maxRetry);
}

/** 需要人工处理的项（超过重试上限）。 */
function blocked(list, maxRetry) {
  return list.filter((x) => x.retries >= maxRetry);
}

/** 线性退避：第 n 次重试等待 n × base 毫秒。 */
function retryDelay(retries, base) {
  return Math.max(0, retries) * base;
}

/** 队列状态摘要，用于「我的」页展示同步情况。 */
function summarize(list, maxRetry) {
  return {
    total: list.length,
    pending: list.filter((x) => x.retries === 0).length,
    retrying: list.filter((x) => x.retries > 0 && x.retries < maxRetry).length,
    blocked: list.filter((x) => x.retries >= maxRetry).length,
  };
}

/**
 * 队列编排：存储端口 + 投递端口均注入，便于单测与替换。
 *
 * storage 需实现：
 *   read() -> Array      读取当前队列
 *   write(list) -> void  持久化队列
 * sender(op)  -> Promise 投递单个操作；成功 resolve，失败 reject
 */
class Queue {
  constructor(storage, options = {}) {
    this.storage = storage;
    this.max = options.max ?? 200;
    this.batch = options.batch ?? 20;
    this.maxRetry = options.maxRetry ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? 3000;
    /** 投递互斥：避免「网络恢复」与「手动提交」并发投递同一批。 */
    this.flushing = false;
  }

  list() {
    return this.storage.read();
  }

  /** 入队一条操作，返回当前队列摘要。 */
  push(op) {
    const next = enqueue(this.list(), op, this.max);
    this.storage.write(next);
    return summarize(next, this.maxRetry);
  }

  summary() {
    return summarize(this.list(), this.maxRetry);
  }

  /**
   * 投递队列中最多 batch 条可重试操作。
   * @returns {Promise<{sent:number, failed:number, blocked:number, remaining:number}>}
   */
  async flush(sender) {
    if (this.flushing) return { skipped: true };
    this.flushing = true;
    try {
      let list = this.list();
      const { batch } = takeBatch(retryable(list, this.maxRetry), this.batch);
      let sent = 0;
      let failed = 0;
      for (const op of batch) {
        try {
          await sender(op);
          list = ack(this.list(), [op.key]);
          this.storage.write(list);
          sent += 1;
        } catch (err) {
          const message = (err && (err.message || err.errMsg)) || '未知错误';
          // 网络类失败不累加重试次数，避免离线时把重试额度耗尽
          const isNetwork = err && err.code === 'NETWORK';
          list = isNetwork
            ? this.list()
            : fail(this.list(), op.key, message);
          this.storage.write(list);
          failed += 1;
          if (isNetwork) break;
        }
      }
      const after = this.list();
      return {
        sent,
        failed,
        blocked: blocked(after, this.maxRetry).length,
        remaining: after.length,
      };
    } finally {
      this.flushing = false;
    }
  }
}

module.exports = {
  opKey,
  enqueue,
  takeBatch,
  ack,
  fail,
  retryable,
  blocked,
  retryDelay,
  summarize,
  Queue,
};
