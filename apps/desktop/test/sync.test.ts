import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc, type HlcClock } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import type { SqlDatabase } from '../src/main/db/sqlite';
import type { SyncTransport } from '../src/main/services/lan';
import {
  collectOutbox,
  maxLocalSeq,
  pullSince,
  receivePush,
  syncStatus,
  type SyncContext,
} from '../src/main/services/sync-core';
import {
  createSyncEngine,
  getSyncConfig,
  setSyncConfig,
  syncCenterState,
  syncNow,
} from '../src/main/services/sync';

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

/** 内存传输：直接调用主节点的 push/pull 原语（等价于 LAN 服务的两端，便于确定性测试）。 */
function memoryTransport(master: Peer): SyncTransport {
  return {
    async health() {
      const st = syncStatus(master.db, { deviceId: master.ctx.deviceId });
      return {
        ok: true,
        deviceId: master.ctx.deviceId,
        pendingCount: st.pendingCount,
        conflictCount: st.conflictCount,
        seq: maxLocalSeq(master.db),
        time: 0,
      };
    },
    async push(url, deviceId, changes) {
      void url;
      const r = receivePush(master.db, master.ctx, deviceId, changes);
      return { ok: true, ackSeq: r.ackSeq, applied: r.applied, conflicts: r.conflicts, duplicate: r.duplicate };
    },
    async pull(url, sinceSeq) {
      void url;
      const changes = pullSince(master.db, sinceSeq);
      return { ok: true, changes, nextSeq: changes.length > 0 ? changes[changes.length - 1].seq : sinceSeq };
    },
  };
}

test('同步配置：读写与默认值', () => {
  const a = makePeer('devA', 1_000);
  const def = getSyncConfig(a.db);
  assert.equal(def.role, 'standalone');
  assert.equal(def.masterUrl, '');
  assert.equal(def.port, 8765);

  const saved = setSyncConfig(a.db, { role: 'client', masterUrl: ' http://192.168.1.9:8765 ' });
  assert.equal(saved.role, 'client');
  assert.equal(saved.masterUrl, 'http://192.168.1.9:8765', '地址应被 trim');
  assert.equal(getSyncConfig(a.db).masterUrl, 'http://192.168.1.9:8765');
  a.db.close();
});

test('syncNow：客户端推 outbox → 拉增量，两端收敛且待同步归零', async () => {
  const m = makePeer('devM', 1_000);
  const a = makePeer('devA', 2_000);
  const b = makePeer('devB', 3_000);
  const transport = memoryTransport(m);

  setSyncConfig(a.db, { role: 'client', masterUrl: 'mem://master' });
  setSyncConfig(b.db, { role: 'client', masterUrl: 'mem://master' });

  a.repo.insert('product', { code: 'P1', name: '甲', status: 1 }, 'p1');
  a.repo.insert('product', { code: 'P2', name: '乙', status: 1 }, 'p2');

  const first = await syncNow(a.db, a.ctx, { transport });
  assert.equal(first.ok, true);
  assert.equal(first.pushed, 2);
  assert.equal(syncStatus(a.db, { deviceId: 'devA' }).pendingCount, 0, '推送后待同步归零');

  const second = await syncNow(b.db, b.ctx, { transport });
  assert.equal(second.ok, true);
  assert.equal(second.pulled, 2);
  const bCodes = b.repo.list('product').map((r) => r.code).sort();
  assert.deepEqual(bCodes, ['P1', 'P2'], 'B 收敛到 A 的数据');

  // 再次同步为幂等（无新增）
  const third = await syncNow(b.db, b.ctx, { transport });
  assert.equal(third.pulled, 0);
  assert.equal(third.duplicate, 0);
  m.db.close();
  a.db.close();
  b.db.close();
});

test('syncNow：未配置主节点地址时报错且不改动数据', async () => {
  const a = makePeer('devA', 1_000);
  a.repo.insert('unit', { name: '个', sort: 0, status: 1 });
  const r = await syncNow(a.db, a.ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, '未配置主节点地址');
  assert.equal(collectOutbox(a.db).length, 1, '未推送变更仍保留');
  a.db.close();
});

test('syncCenterState：汇总状态与配置', () => {
  const a = makePeer('devA', 1_000);
  a.repo.insert('unit', { name: '个', sort: 0, status: 1 });
  setSyncConfig(a.db, { role: 'master', port: 9000 });
  const state = syncCenterState(a.db, a.ctx);
  assert.equal(state.status.pendingCount, 1);
  assert.equal(state.status.conflictCount, 0);
  assert.equal(state.config.role, 'master');
  assert.equal(state.config.port, 9000);
  a.db.close();
});

test('syncEngine：start/stop 切换运行状态，非 client 角色不做同步', async () => {
  const a = makePeer('devA', 1_000);
  const engine = createSyncEngine(a.db, a.ctx, { intervalMs: 1000 });
  assert.equal(engine.isRunning(), false);
  engine.start();
  assert.equal(engine.isRunning(), true);
  engine.stop();
  assert.equal(engine.isRunning(), false);

  // standalone 角色：syncNow 直接返回未启用
  const r = await engine.syncNow();
  assert.equal(r.ok, false);
  assert.equal(r.error, '未启用客户端同步');
  a.db.close();
});
