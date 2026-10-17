import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc, type HlcClock } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import type { SqlDatabase } from '../src/main/db/sqlite';
import { httpTransport, startLanServer, type HealthResponse } from '../src/main/services/lan';
import { collectOutbox, integratePull, type SyncContext } from '../src/main/services/sync-core';

interface Peer {
  db: SqlDatabase;
  repo: Repository;
  ctx: SyncContext;
  clock: HlcClock;
}

function makePeer(deviceId: string, now: number): Peer {
  const db = openAndInit(':memory:');
  const clock = createHlc(deviceId, () => now);
  const ctx: SyncContext = { deviceId, clock, now: () => now };
  const repo = new Repository(db, { userId: `u_${deviceId}`, deviceId, clock }, () => now);
  return { db, repo, ctx, clock };
}

/** 从 SSE 流中读取下一个事件（以空行分隔）。 */
async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: { decode(input?: Uint8Array, options?: { stream?: boolean }): string },
  buf: { text: string },
): Promise<string> {
  for (;;) {
    const idx = buf.text.indexOf('\n\n');
    if (idx >= 0) {
      const evt = buf.text.slice(0, idx);
      buf.text = buf.text.slice(idx + 2);
      return evt;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error('SSE 流已关闭');
    buf.text += decoder.decode(value, { stream: true });
  }
}

test('LAN 服务：health / push / pull + SSE 通知 + 双端收敛', async () => {
  const m = makePeer('devM', 1_000);
  const a = makePeer('devA', 2_000);
  const b = makePeer('devB', 3_000);
  const server = await startLanServer({ db: m.db, ctx: m.ctx, port: 0, host: '127.0.0.1' });
  const url = server.url;

  try {
    // 1. health
    const health = await httpTransport.health(url);
    assert.equal(health.ok, true);
    assert.equal(health.deviceId, 'devM');

    // 2. SSE 握手：连接即收到 open 事件
    const controller = new AbortController();
    const sseRes = await fetch(`${url}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    const buf = { text: '' };
    const openEvt = await readEvent(reader, decoder, buf);
    assert.match(openEvt, /event: open/);
    assert.match(openEvt, /devM/);

    // 3. A 写入并推送
    a.repo.insert('unit', { name: '个', sort: 0, status: 1 });
    a.repo.insert('unit', { name: '件', sort: 0, status: 1 });
    const outbox = collectOutbox(a.db);
    assert.equal(outbox.length, 2);
    const push = await httpTransport.push(url, 'devA', outbox);
    assert.equal(push.ok, true);
    assert.equal(push.applied, 2);
    assert.ok(push.ackSeq >= 2);

    // SSE 收到变更通知
    const changeEvt = await readEvent(reader, decoder, buf);
    assert.match(changeEvt, /event: change/);
    controller.abort();

    // 4. 重复推送被去重
    const dup = await httpTransport.push(url, 'devA', outbox);
    assert.equal(dup.applied, 0);
    assert.equal(dup.duplicate, 2);

    // 5. B 拉取并收敛
    const pulled = await httpTransport.pull(url, 0);
    assert.ok(pulled.changes.length >= 2);
    const integrated = integratePull(b.db, b.ctx, pulled.changes, 'lan:master');
    assert.ok(integrated.applied >= 2);
    const names = b.repo.list('unit').map((r) => r.name).sort();
    assert.deepEqual(names, ['个', '件'].sort());

    // 6. 断点续传：游标之后同一批为重复
    const again = await httpTransport.pull(url, integrated.nextSeq);
    assert.equal(again.changes.length, 0);

    // 7. 未知路由 404
    const notFound = await fetch(`${url}/nope`);
    assert.equal(notFound.status, 404);

    // 8. health 再次确认中继 seq 已增长
    const health2 = (await httpTransport.health(url)) as HealthResponse;
    assert.ok(health2.seq >= 2);
  } finally {
    await server.close();
    m.db.close();
    a.db.close();
    b.db.close();
  }
});
