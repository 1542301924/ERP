/**
 * 离线队列纯逻辑单测（node:test，无需微信环境）。
 * 运行：cd apps/miniprogram && node --test test/
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const q = require('../lib/offline-queue');

// ---------------------------------------------------------------- 纯函数

test('enqueue 按 type:docId 去重，只保留最新 payload', () => {
  let list = [];
  list = q.enqueue(list, { type: 'sales_order.create', docId: 'A', payload: { n: 1 }, createdAt: 1 }, 10);
  list = q.enqueue(list, { type: 'sales_order.create', docId: 'A', payload: { n: 2 }, createdAt: 2 }, 10);
  assert.equal(list.length, 1);
  assert.equal(list[0].payload.n, 2);
  assert.equal(list[0].key, 'sales_order.create:A');
  assert.equal(list[0].retries, 0);
});

test('enqueue 超出上限时丢弃最早的操作', () => {
  let list = [];
  for (let i = 0; i < 5; i += 1) {
    list = q.enqueue(list, { type: 't', docId: `d${i}`, payload: {}, createdAt: i }, 3);
  }
  assert.deepEqual(list.map((x) => x.docId), ['d2', 'd3', 'd4']);
});

test('takeBatch 先进先出且不改动原数组', () => {
  const list = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  const { batch, rest } = q.takeBatch(list, 2);
  assert.deepEqual(batch.map((x) => x.key), ['a', 'b']);
  assert.deepEqual(rest.map((x) => x.key), ['c']);
  assert.equal(list.length, 3);
});

test('ack 按 key 移除，fail 累加重试与错误信息', () => {
  let list = [{ key: 'a', retries: 0 }, { key: 'b', retries: 0 }];
  list = q.fail(list, 'a', '云端拒绝');
  assert.equal(list.find((x) => x.key === 'a').retries, 1);
  assert.equal(list.find((x) => x.key === 'a').lastError, '云端拒绝');
  list = q.ack(list, ['a']);
  assert.deepEqual(list.map((x) => x.key), ['b']);
});

test('retryable / blocked 按重试上限切分', () => {
  const list = [
    { key: 'a', retries: 0 },
    { key: 'b', retries: 4 },
    { key: 'c', retries: 5 },
  ];
  assert.deepEqual(q.retryable(list, 5).map((x) => x.key), ['a', 'b']);
  assert.deepEqual(q.blocked(list, 5).map((x) => x.key), ['c']);
});

test('retryDelay 为线性退避', () => {
  assert.equal(q.retryDelay(0, 3000), 0);
  assert.equal(q.retryDelay(3, 3000), 9000);
});

test('summarize 汇总待发/重试/阻塞数量', () => {
  const list = [
    { key: 'a', retries: 0 },
    { key: 'b', retries: 2 },
    { key: 'c', retries: 5 },
  ];
  assert.deepEqual(q.summarize(list, 5), { total: 3, pending: 1, retrying: 1, blocked: 1 });
});

// ---------------------------------------------------------------- Queue 编排

function fakeStorage(initial = []) {
  let data = initial.slice();
  return {
    read: () => data.slice(),
    write: (list) => {
      data = list.slice();
    },
  };
}

test('Queue.push 落地到存储并返回摘要', () => {
  const storage = fakeStorage();
  const queue = new q.Queue(storage, { max: 10 });
  const summary = queue.push({ type: 't', docId: 'd1', payload: {}, createdAt: 1 });
  assert.equal(summary.total, 1);
  assert.equal(storage.read().length, 1);
});

test('Queue.flush 成功后移除操作', async () => {
  const storage = fakeStorage();
  const queue = new q.Queue(storage, { max: 10, batch: 10 });
  queue.push({ type: 't', docId: 'd1', payload: {}, createdAt: 1 });
  const sent = [];
  const result = await queue.flush(async (op) => {
    sent.push(op.key);
  });
  assert.deepEqual(sent, ['t:d1']);
  assert.equal(result.sent, 1);
  assert.equal(result.remaining, 0);
});

test('Queue.flush 业务失败累加重试，达到上限后不再投递', async () => {
  const storage = fakeStorage();
  const queue = new q.Queue(storage, { max: 10, batch: 10, maxRetry: 2 });
  queue.push({ type: 't', docId: 'd1', payload: {}, createdAt: 1 });
  const sender = async () => {
    const err = new Error('业务失败');
    err.code = 'BIZ';
    throw err;
  };
  await queue.flush(sender);
  assert.equal(queue.list()[0].retries, 1);
  await queue.flush(sender);
  assert.equal(queue.list()[0].retries, 2);
  // 已达上限，不再出现在可投递批次里
  const third = await queue.flush(sender);
  assert.equal(third.sent, 0);
  assert.equal(third.blocked, 1);
});

test('Queue.flush 遇网络错误立即中断且不消耗重试额度', async () => {
  const storage = fakeStorage();
  const queue = new q.Queue(storage, { max: 10, batch: 10, maxRetry: 2 });
  queue.push({ type: 't', docId: 'd1', payload: {}, createdAt: 1 });
  queue.push({ type: 't', docId: 'd2', payload: {}, createdAt: 2 });
  let calls = 0;
  const sender = async () => {
    calls += 1;
    const err = new Error('网络不可用');
    err.code = 'NETWORK';
    throw err;
  };
  const result = await queue.flush(sender);
  assert.equal(calls, 1, '网络错误后应立刻中断，不再继续投递');
  assert.equal(result.remaining, 2);
  assert.equal(queue.list()[0].retries, 0, '网络错误不累加重试次数');
});

test('Queue.flush 并发调用时第二次直接跳过', async () => {
  const storage = fakeStorage();
  const queue = new q.Queue(storage, { max: 10, batch: 10 });
  queue.push({ type: 't', docId: 'd1', payload: {}, createdAt: 1 });
  let resolveFirst;
  const first = queue.flush(() => new Promise((resolve) => {
    resolveFirst = resolve;
  }));
  const second = await queue.flush(async () => {});
  assert.equal(second.skipped, true);
  resolveFirst();
  await first;
});
