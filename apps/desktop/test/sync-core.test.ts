import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc, type HlcClock } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import type { SqlDatabase } from '../src/main/db/sqlite';
import {
  applyIncoming,
  collectOutbox,
  integratePull,
  listConflicts,
  markPushed,
  pullSince,
  readCursor,
  receivePush,
  resolveConflict,
  syncStatus,
  type SyncContext,
} from '../src/main/services/sync-core';

interface Peer {
  db: SqlDatabase;
  repo: Repository;
  ctx: SyncContext;
  clock: HlcClock;
}

/** 固定物理时钟，便于构造可比较的 HLC。 */
function makePeer(deviceId: string, now: number): Peer {
  const db = openAndInit(':memory:');
  const clock = createHlc(deviceId, () => now);
  const ctx: SyncContext = { deviceId, clock, now: () => now };
  const repo = new Repository(db, { userId: `u_${deviceId}`, deviceId, clock }, () => now);
  return { db, repo, ctx, clock };
}

function count(db: SqlDatabase, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0);
}

test('collectOutbox / markPushed：只取本端未推送变更', () => {
  const a = makePeer('devA', 1_000);
  a.repo.insert('unit', { name: '个', sort: 0, status: 1 });
  a.repo.insert('unit', { name: '件', sort: 0, status: 1 });

  const outbox = collectOutbox(a.db, { deviceId: 'devA' });
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0].seq, 1);
  assert.equal(outbox[0].entity, 'unit');
  assert.equal(outbox[0].op, 'insert');

  assert.equal(markPushed(a.db, outbox.map((c) => c.logId)), 2);
  assert.equal(collectOutbox(a.db).length, 0);
  a.db.close();
});

test('applyIncoming：append-only 直插且重复应用幂等（去重）', () => {
  const a = makePeer('devA', 1_000);
  const b = makePeer('devB', 1_000);
  b.repo.insert('stock_ledger', {
    biz_type: '采购入库',
    product_id: 'p1',
    warehouse_id: 'w1',
    qty_in: 10,
    amount: 30,
    biz_date: 1_000,
  });
  const changes = collectOutbox(b.db);

  const first = applyIncoming(a.db, a.ctx, changes);
  assert.equal(first.inserted, 1);
  const second = applyIncoming(a.db, a.ctx, changes);
  assert.equal(second.inserted, 0);
  assert.equal(second.noop, 1, '第二次应用应为 noop');
  assert.equal(count(a.db, 'stock_ledger'), 1);
  a.db.close();
  b.db.close();
});

test('applyIncoming：跳过本端设备自身回声', () => {
  const a = makePeer('devA', 1_000);
  a.repo.insert('unit', { name: '个', sort: 0, status: 1 });
  const own = collectOutbox(a.db);
  const summary = applyIncoming(a.db, a.ctx, own);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.applied, 0);
  a.db.close();
});

test('主数据字段级合并：不同字段互不冲突', () => {
  const m = makePeer('devM', 1_000);
  const a = makePeer('devA', 2_000);
  m.repo.insert('product', { code: 'P1', name: '原名', sale_price: 10, status: 1 }, 'prod1');

  // A 与 M 同步基线
  integratePull(a.db, a.ctx, pullSince(m.db, 0), 'lan:master');
  // A 改名称，M 改售价（不同字段）
  a.repo.update('product', 'prod1', { name: '新名' });
  m.repo.update('product', 'prod1', { sale_price: 99 });

  const push = receivePush(m.db, m.ctx, 'devA', collectOutbox(a.db));
  assert.equal(push.applied, 1);
  assert.equal(push.conflicts, 0, '不同字段不应产生冲突');

  const row = m.repo.findById('product', 'prod1')!;
  assert.equal(row.name, '新名', '采纳远端名称');
  assert.equal(row.sale_price, 99, '保留本地售价');
  assert.equal(row.sync_state, 1);
  m.db.close();
  a.db.close();
});

test('同字段真冲突：落 _conflict、置 sync_state=2，可人工裁决', () => {
  const m = makePeer('devM', 1_000);
  const a = makePeer('devA', 2_000);
  const b = makePeer('devB', 3_000);
  m.repo.insert('product', { code: 'P1', name: '基线', status: 1 }, 'prod1');
  const base = pullSince(m.db, 0);
  integratePull(a.db, a.ctx, base, 'lan:master');
  integratePull(b.db, b.ctx, base, 'lan:master');

  a.repo.update('product', 'prod1', { name: 'A 名' });
  b.repo.update('product', 'prod1', { name: 'B 名' });

  receivePush(m.db, m.ctx, 'devA', collectOutbox(a.db));
  const push = receivePush(m.db, m.ctx, 'devB', collectOutbox(b.db));
  assert.equal(push.conflicts, 1, '同字段不同值应产生冲突');

  const row = m.repo.findById('product', 'prod1')!;
  assert.equal(row.sync_state, 2);
  assert.equal(row.name, 'B 名', 'HLC 晚者胜');

  const conflicts = listConflicts(m.db, { status: 0 });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, 'name');
  assert.equal(conflicts[0].value_a, 'A 名');
  assert.equal(conflicts[0].value_b, 'B 名');
  assert.equal(conflicts[0].winner, 'b');

  const resolved = resolveConflict(m.db, m.repo, {
    id: conflicts[0].id,
    resolvedValue: 'A 名',
    userId: 'u_admin',
    now: () => 5_000,
  });
  assert.equal(resolved.status, 1);
  assert.equal(resolved.winner, 'manual');
  assert.equal(resolved.resolved_value, 'A 名');
  assert.equal(m.repo.findById('product', 'prod1')!.name, 'A 名');
  assert.equal(listConflicts(m.db, { status: 0 }).length, 0, '裁决后不再有未处理冲突');
  m.db.close();
  a.db.close();
  b.db.close();
});

test('裁决广播：其他端拉取后自动清除同字段未处理冲突', () => {
  const m = makePeer('devM', 1_000);
  const a = makePeer('devA', 2_000);
  const b = makePeer('devB', 3_000);
  m.repo.insert('product', { code: 'P1', name: '基线', status: 1 }, 'prod1');
  const base = pullSince(m.db, 0);
  integratePull(a.db, a.ctx, base, 'lan:master');
  integratePull(b.db, b.ctx, base, 'lan:master');

  a.repo.update('product', 'prod1', { name: 'A 名' });
  b.repo.update('product', 'prod1', { name: 'B 名' });
  receivePush(m.db, m.ctx, 'devA', collectOutbox(a.db));
  assert.equal(receivePush(m.db, m.ctx, 'devB', collectOutbox(b.db)).conflicts, 1);

  const conflict = listConflicts(m.db, { status: 0 })[0];
  // 主节点带 ctx 裁决 → 额外写一条裁决广播
  resolveConflict(m.db, m.repo, {
    id: conflict.id,
    resolvedValue: 'A 名',
    userId: 'u_admin',
    ctx: m.ctx,
  });

  // B 拉取裁决结果：先应用值变更（会再次判定冲突），再应用广播（清除冲突）
  const delta = pullSince(m.db, readCursor(b.db, 'lan:master').lastPullSeq);
  const integrated = integratePull(b.db, b.ctx, delta, 'lan:master');
  assert.equal(integrated.resolutions, 1, '裁决广播应清除 1 条冲突');
  assert.equal(b.repo.findById('product', 'prod1')!.name, 'A 名', '值收敛到裁决值');
  assert.equal(listConflicts(b.db, { status: 0 }).length, 0, 'B 端未处理冲突已清除');
  assert.equal(syncStatus(b.db, { deviceId: 'devB' }).conflictCount, 0);

  m.db.close();
  a.db.close();
  b.db.close();
});

test('receivePush：相同批次重复推送被 (device_id, seq) 幂等去重', () => {
  const m = makePeer('devM', 1_000);
  const a = makePeer('devA', 1_000);
  a.repo.insert('unit', { name: '个', sort: 0, status: 1 });
  const batch = collectOutbox(a.db);

  const first = receivePush(m.db, m.ctx, 'devA', batch);
  assert.equal(first.applied, 1);
  assert.equal(first.duplicate, 0);

  const second = receivePush(m.db, m.ctx, 'devA', batch);
  assert.equal(second.applied, 0);
  assert.equal(second.duplicate, 1, '重复推送应被去重');
  assert.equal(count(m.db, '_change_log'), 1, '中继日志不应重复写入');
  m.db.close();
  a.db.close();
});

test('integratePull：按主节点 seq 断点续传', () => {
  const a = makePeer('devA', 1_000);
  const all = pullSince(a.db, 0);
  assert.equal(all.length, 0);

  // 直接构造一批带 seq 的中继结果，验证游标只推进一次
  const m = makePeer('devM', 1_000);
  const b = makePeer('devB', 2_000);
  b.repo.insert('unit', { name: '箱', sort: 0, status: 1 });
  receivePush(m.db, m.ctx, 'devB', collectOutbox(b.db));

  const snapshot = pullSince(m.db, 0);
  const first = integratePull(a.db, a.ctx, snapshot, 'lan:master');
  assert.equal(first.applied, 1);
  assert.equal(first.nextSeq, snapshot[snapshot.length - 1].seq);

  // 再次整合同样的快照：游标已推进 → 全部视为重复
  const second = integratePull(a.db, a.ctx, snapshot, 'lan:master');
  assert.equal(second.applied, 0);
  assert.equal(second.duplicate, 1);

  // 主节点再新增一条，只拉增量
  b.repo.insert('unit', { name: '件', sort: 0, status: 1 });
  receivePush(m.db, m.ctx, 'devB', collectOutbox(b.db));
  const delta = integratePull(a.db, a.ctx, pullSince(m.db, second.nextSeq), 'lan:master');
  assert.equal(delta.applied, 1, '仅增量被应用');
  m.db.close();
  a.db.close();
  b.db.close();
});

test('双端收敛：A 开单 → 主节点中继 → B 拉取后两端一致（不丢单、库存一致）', () => {
  const m = makePeer('devM', 1_000);
  const a = makePeer('devA', 2_000);
  const b = makePeer('devB', 3_000);

  // A 写入 3 条单据流水（append-only）
  for (let i = 0; i < 3; i++) {
    a.repo.insert(
      'sales_outbound',
      { doc_no: `SO-${i}`, outbound_type: '销售', status: 1, total_amount: 100 + i },
      `so_${i}`,
    );
  }
  // 推送到主节点
  receivePush(m.db, m.ctx, 'devA', collectOutbox(a.db));
  markPushed(a.db, collectOutbox(a.db).map((c) => c.logId));

  // B 拉取
  integratePull(b.db, b.ctx, pullSince(m.db, 0), 'lan:master');

  assert.equal(count(b.db, 'sales_outbound'), 3, 'B 不丢单');
  const aDocs = a.repo.list('sales_outbound').map((r) => r.doc_no).sort();
  const bDocs = b.repo.list('sales_outbound').map((r) => r.doc_no).sort();
  assert.deepEqual(bDocs, aDocs, '两端单据一致');

  // 幂等：B 再次拉取同批不再变化
  const again = integratePull(b.db, b.ctx, pullSince(m.db, 0), 'lan:master');
  assert.equal(again.applied, 0);
  m.db.close();
  a.db.close();
  b.db.close();
});

test('syncStatus：待同步条数与冲突数统计正确', () => {
  const a = makePeer('devA', 1_000);
  a.repo.insert('unit', { name: '个', sort: 0, status: 1 });
  a.repo.insert('unit', { name: '件', sort: 0, status: 1 });
  const st = syncStatus(a.db, { deviceId: 'devA' });
  assert.equal(st.pendingCount, 2);
  assert.equal(st.conflictCount, 0);
  assert.equal(st.cursor.lastPullSeq, 0);
  a.db.close();
});
