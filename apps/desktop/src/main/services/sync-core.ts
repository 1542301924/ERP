/**
 * 同步核心纯逻辑（P7）。
 *
 * 本模块**不依赖 electron / 网络**，只依赖 `SqlDatabase` + `Repository` + `HlcClock`，
 * 因此可以在 `node:test` 下直接跑，用来验收「两端一致 / 不丢单 / 冲突可见」。
 *
 * 数据流（星型拓扑，主节点为权威中继）：
 *  - 客户端：`collectOutbox()` 取本端未推送变更 → 主节点 `receivePush()` 落库并中继 → 客户端 `integratePull()` 拉取收敛。
 *  - 去重：主节点按 `(device_id, seq)` 用 `_sync_cursor.last_push_seq` 幂等；客户端按主节点全局 `seq` 用 `last_pull_seq` 断点续传。
 *  - 落库规则复用 `packages/shared` 的 `applyChange()`：append-only 直插、主数据 HLC LWW + dirty_fields 字段级合并、派生状态跳过；同字段真冲突写 `_conflict` 并置 `sync_state=2`。
 */

import {
  applyChange,
  newId,
  serializeHlc,
  type ConflictInfo,
  type HlcClock,
  type IncomingChange,
  type Row,
} from '@inventory/shared';
import { SYNC_ENTITIES, type Repository } from '../db/repository';
import type { SqlDatabase } from '../db/sqlite';

/** 从 `_change_log` 读出的一条变更（跨端传输单位）。 */
export interface SyncChange {
  logId: string;
  seq: number;
  deviceId: string;
  entity: string;
  entityId: string;
  op: string;
  payload: Row | null;
  hlc: string;
  createdAt: number;
}

/** 同步游标（对应 `_sync_cursor` 一行）。 */
export interface SyncCursor {
  peerId: string;
  lastPullSeq: number;
  lastPushSeq: number;
  lastSyncAt: number | null;
  status: string | null;
}

/** 同步上下文（与写入口共享同一个 clock 实例，保证收到远端事件后本地时钟被推进）。 */
export interface SyncContext {
  deviceId: string;
  clock: HlcClock;
  now?: () => number;
}

/** 应用远端变更的汇总。 */
export interface ApplySummary {
  applied: number;
  inserted: number;
  updated: number;
  noop: number;
  skipped: number;
  conflicts: number;
  /** 因收到「裁决广播」而清除的本地未处理冲突条数。 */
  resolutions: number;
}

/**
 * 裁决广播的专用变更实体名。
 *
 * 裁决一条冲突时，除了把裁决值写回业务表（产生正常的 update 变更），
 * 还会额外广播一条本实体的变更；其他各端应用它时，按
 * `(entity, entity_id, field)` 清除本地**同字段的未处理冲突**，
 * 从而避免「值收敛了、冲突标记却赖在各端」的情况。
 */
export const CONFLICT_RESOLUTION_ENTITY = '_conflict_resolution';

/** 裁决广播的 payload 结构。 */
export interface ResolutionPayload {
  entity: string;
  entity_id: string;
  field: string;
  resolved_value: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
}

/** `_conflict` 行。 */
export interface ConflictRow {
  id: string;
  entity: string;
  entity_id: string;
  field: string;
  value_a: string | null;
  value_b: string | null;
  hlc_a: string;
  hlc_b: string;
  winner: string;
  resolved_value: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  status: number;
}

/** 同步状态摘要（供「同步中心」展示）。 */
export interface SyncStatus {
  deviceId: string;
  /** 本端待推送条数（`_change_log.pushed = 0`）。 */
  pendingCount: number;
  /** 待处理冲突条数（`_conflict.status = 0`）。 */
  conflictCount: number;
  lastSyncAt: number | null;
  cursor: SyncCursor;
}

function nowFn(ctx: SyncContext): () => number {
  return ctx.now ?? Date.now;
}

/** 把 `_change_log` 行转成传输单位。 */
function toChange(row: Record<string, unknown>): SyncChange {
  const raw = row.payload;
  let payload: Row | null = null;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      payload = JSON.parse(raw) as Row;
    } catch {
      payload = null;
    }
  }
  return {
    logId: String(row.log_id),
    seq: Number(row.seq),
    deviceId: String(row.device_id),
    entity: String(row.entity),
    entityId: String(row.entity_id),
    op: String(row.op),
    payload,
    hlc: String(row.hlc ?? ''),
    createdAt: Number(row.created_at ?? 0),
  };
}

// ---------------- 本地 outbox ----------------

/** 收集本端未推送变更（按 seq 升序）；可按设备过滤但本端日志天然只有本机写入。 */
export function collectOutbox(
  db: SqlDatabase,
  opts: { deviceId?: string; limit?: number } = {},
): SyncChange[] {
  const where = ['pushed = 0'];
  const params: unknown[] = [];
  if (opts.deviceId) {
    where.push('device_id = ?');
    params.push(opts.deviceId);
  }
  const limit = opts.limit ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '';
  const rows = db.prepare(`SELECT * FROM _change_log WHERE ${where.join(' AND ')} ORDER BY seq${limit}`).all(...params);
  return rows.map(toChange);
}

/** 把已成功推送的变更标记为 pushed=1，返回受影响条数。 */
export function markPushed(db: SqlDatabase, logIds: string[]): number {
  if (logIds.length === 0) return 0;
  const stmt = db.prepare('UPDATE _change_log SET pushed = 1 WHERE log_id = ?');
  let n = 0;
  db.transaction(() => {
    for (const id of logIds) n += Number(stmt.run(id).changes ?? 0);
  });
  return n;
}

/** 本端 `_change_log` 的最大 seq（主节点用于分配全局中继 seq）。 */
export function maxLocalSeq(db: SqlDatabase): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM _change_log').get();
  return Number(row?.s ?? 0);
}

/** 只保留 `seq > minSeq` 的变更（游标断点续传的核心）。 */
export function filterAfterSeq(changes: SyncChange[], minSeq: number): SyncChange[] {
  return changes.filter((c) => c.seq > minSeq);
}

/** 读取某 peer 的同步游标（缺省返回初始游标）。 */
export function readCursor(db: SqlDatabase, peerId: string): SyncCursor {
  const row = db.prepare('SELECT * FROM _sync_cursor WHERE peer_id = ?').get(peerId);
  if (!row) return { peerId, lastPullSeq: 0, lastPushSeq: 0, lastSyncAt: null, status: null };
  return {
    peerId,
    lastPullSeq: Number(row.last_pull_seq ?? 0),
    lastPushSeq: Number(row.last_push_seq ?? 0),
    lastSyncAt: row.last_sync_at === null || row.last_sync_at === undefined ? null : Number(row.last_sync_at),
    status: row.status === null || row.status === undefined ? null : String(row.status),
  };
}

/** 更新（或创建）某 peer 的同步游标；未提供的字段保留原值。 */
export function writeCursor(
  db: SqlDatabase,
  peerId: string,
  patch: Partial<Omit<SyncCursor, 'peerId'>>,
): SyncCursor {
  const current = readCursor(db, peerId);
  const next: SyncCursor = {
    peerId,
    lastPullSeq: patch.lastPullSeq ?? current.lastPullSeq,
    lastPushSeq: patch.lastPushSeq ?? current.lastPushSeq,
    lastSyncAt: patch.lastSyncAt === undefined ? current.lastSyncAt : patch.lastSyncAt,
    status: patch.status === undefined ? current.status : patch.status,
  };
  db.prepare(
    'INSERT INTO _sync_cursor (peer_id, last_pull_seq, last_push_seq, last_sync_at, status) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(peer_id) DO UPDATE SET last_pull_seq = excluded.last_pull_seq, last_push_seq = excluded.last_push_seq, ' +
      'last_sync_at = excluded.last_sync_at, status = excluded.status',
  ).run(next.peerId, next.lastPullSeq, next.lastPushSeq, next.lastSyncAt, next.status);
  return next;
}

// ---------------- 远端变更落库 ----------------

/** 缓存各表真实列名，避免把 payload 里的多余字段写进去。 */
function tableColumns(db: SqlDatabase, entity: string, cache: Map<string, Set<string>>): Set<string> {
  let cols = cache.get(entity);
  if (!cols) {
    cols = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(entity).map((r) => String(r.name)));
    cache.set(entity, cols);
  }
  return cols;
}

function writeRow(
  db: SqlDatabase,
  entity: string,
  row: Row,
  mode: 'insert' | 'update',
  cache: Map<string, Set<string>>,
): void {
  const cols = tableColumns(db, entity, cache);
  const keys = Object.keys(row).filter((k) => cols.has(k));
  if (keys.length === 0) return;
  if (mode === 'insert') {
    db.prepare(`INSERT OR REPLACE INTO ${entity} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(
      ...keys.map((k) => row[k] as never),
    );
  } else {
    const setKeys = keys.filter((k) => k !== 'id');
    if (setKeys.length === 0) return;
    db.prepare(`UPDATE ${entity} SET ${setKeys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...setKeys.map((k) => row[k] as never),
      row.id as never,
    );
  }
}

/** 冲突落库（同 entity/entity_id/field 的未处理冲突只记一条）。 */
function recordConflict(db: SqlDatabase, c: ConflictInfo): boolean {
  const exists = db
    .prepare('SELECT 1 FROM _conflict WHERE entity = ? AND entity_id = ? AND field = ? AND status = 0')
    .get(c.entity, c.entity_id, c.field);
  if (exists) return false;
  db.prepare(
    'INSERT INTO _conflict (id, entity, entity_id, field, value_a, value_b, hlc_a, hlc_b, winner, resolved_value, resolved_by, resolved_at, status) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)',
  ).run(newId(), c.entity, c.entity_id, c.field, c.value_a, c.value_b, c.hlc_a, c.hlc_b, c.winner);
  return true;
}

/**
 * 写入一条「裁决广播」变更（`pushed=0`，随本端 outbox 同步出去）。
 * 与业务表变更同事务，seq 紧跟在裁决产生的 update 之后，保证接收端先应用值、再清冲突。
 */
function recordResolutionBroadcast(
  db: SqlDatabase,
  ctx: SyncContext,
  info: ResolutionPayload,
): void {
  const now = nowFn(ctx);
  const seq = maxLocalSeq(db) + 1;
  db.prepare(
    'INSERT INTO _change_log (log_id, seq, device_id, entity, entity_id, op, payload, hlc, created_at, pushed) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
  ).run(
    newId(),
    seq,
    ctx.deviceId,
    CONFLICT_RESOLUTION_ENTITY,
    `${info.entity}:${info.entity_id}:${info.field}`,
    'resolve',
    JSON.stringify(info),
    serializeHlc(ctx.clock.tick()),
    now(),
  );
}

/**
 * 应用一条裁决广播：把本地同 `(entity, entity_id, field)` 的**未处理**冲突标记为已裁决。
 * 返回被清除的冲突条数（0 表示本地无对应冲突，属正常情况）。
 */
function applyResolutionBroadcast(db: SqlDatabase, change: SyncChange): number {
  const p = change.payload as unknown as ResolutionPayload | null;
  if (!p || typeof p.entity !== 'string' || typeof p.field !== 'string') return 0;
  const at = p.resolved_at ?? change.createdAt;
  const result = db
    .prepare(
      'UPDATE _conflict SET status = 1, winner = ?, resolved_value = ?, resolved_by = ?, resolved_at = ? ' +
        'WHERE entity = ? AND entity_id = ? AND field = ? AND status = 0',
    )
    .run('manual', p.resolved_value ?? null, p.resolved_by ?? null, at, p.entity, p.entity_id, p.field);
  return Number(result.changes ?? 0);
}

/**
 * 应用一批来自远端的变更（落库 + 冲突记录 + 推进本地时钟）。
 * 本端自身产生的变更（`device_id` 相同）会被跳过以避免回声。
 */
export function applyIncoming(
  db: SqlDatabase,
  ctx: SyncContext,
  changes: SyncChange[],
  opts: { skipOwnDevice?: boolean } = {},
): ApplySummary {
  const skipOwn = opts.skipOwnDevice ?? true;
  const cache = new Map<string, Set<string>>();
  const summary: ApplySummary = { applied: 0, inserted: 0, updated: 0, noop: 0, skipped: 0, conflicts: 0, resolutions: 0 };

  db.transaction(() => {
    for (const change of changes) {
      if (skipOwn && change.deviceId === ctx.deviceId) {
        summary.skipped += 1;
        continue;
      }
      // 裁决广播：清除本地同字段的未处理冲突，不写业务表
      if (change.entity === CONFLICT_RESOLUTION_ENTITY) {
        const cleared = applyResolutionBroadcast(db, change);
        if (cleared > 0) {
          summary.resolutions += cleared;
          summary.applied += cleared;
        } else {
          summary.noop += 1;
        }
        if (change.hlc) ctx.clock.receive(change.hlc);
        continue;
      }
      const known = SYNC_ENTITIES.has(change.entity);
      const localRow = known
        ? ((db.prepare(`SELECT * FROM ${change.entity} WHERE id = ?`).get(change.entityId) as Row | undefined) ?? null)
        : null;
      const incoming: IncomingChange = {
        entity: change.entity,
        entity_id: change.entityId,
        op: change.op,
        payload: change.payload,
        hlc: change.hlc,
      };
      const result = applyChange(localRow, incoming);

      if (!known) {
        summary.skipped += 1;
      } else if (result.action === 'insert' && result.row) {
        writeRow(db, change.entity, result.row, 'insert', cache);
        summary.inserted += 1;
        summary.applied += 1;
      } else if (result.action === 'update' && result.row) {
        writeRow(db, change.entity, result.row, 'update', cache);
        summary.updated += 1;
        summary.applied += 1;
      } else {
        summary.noop += 1;
      }

      for (const c of result.conflicts) {
        if (recordConflict(db, c)) summary.conflicts += 1;
      }

      if (change.hlc) ctx.clock.receive(change.hlc);
    }
  });

  return summary;
}

/**
 * 主节点接收某客户端推送：按 `(device_id, seq)` 幂等去重 → 落库 → 以全局 seq 中继写入本端 `_change_log`
 * （供其他客户端拉取）。返回 ack 信息。
 */
export function receivePush(
  db: SqlDatabase,
  ctx: SyncContext,
  deviceId: string,
  changes: SyncChange[],
): { applied: number; conflicts: number; duplicate: number; ackSeq: number; incomingSeq: number; resolutions: number } {
  const now = nowFn(ctx);
  const peerId = `device:${deviceId}`;
  const cursor = readCursor(db, peerId);
  const fresh = filterAfterSeq(changes, cursor.lastPushSeq);
  const summary = applyIncoming(db, ctx, fresh);
  const incomingSeq = changes.reduce((m, c) => Math.max(m, c.seq), cursor.lastPushSeq);

  let ackSeq = maxLocalSeq(db);
  db.transaction(() => {
    for (const change of fresh) ackSeq = recordRelayedChange(db, change, now);
    writeCursor(db, peerId, { lastPushSeq: incomingSeq, lastSyncAt: now(), status: 'ok' });
  });

  return {
    applied: summary.applied,
    conflicts: summary.conflicts,
    duplicate: changes.length - fresh.length,
    ackSeq,
    incomingSeq,
    resolutions: summary.resolutions,
  };
}

/**
 * 客户端整合一次拉取结果：按主节点 `seq` 断点续传 → 落库 → 更新 `last_pull_seq`。
 */
export function integratePull(
  db: SqlDatabase,
  ctx: SyncContext,
  changes: SyncChange[],
  peerId = 'lan:master',
): { applied: number; conflicts: number; duplicate: number; nextSeq: number; resolutions: number } {
  const now = nowFn(ctx);
  const cursor = readCursor(db, peerId);
  const fresh = filterAfterSeq(changes, cursor.lastPullSeq);
  const summary = applyIncoming(db, ctx, fresh);
  const nextSeq = changes.reduce((m, c) => Math.max(m, c.seq), cursor.lastPullSeq);
  writeCursor(db, peerId, { lastPullSeq: nextSeq, lastSyncAt: now(), status: 'ok' });
  return {
    applied: summary.applied,
    conflicts: summary.conflicts,
    duplicate: changes.length - fresh.length,
    nextSeq,
    resolutions: summary.resolutions,
  };
}

/** 把一条远端变更以新的全局 seq 写入本端 `_change_log`（pushed=1，不再回传）；相同 log_id 幂等。 */
export function recordRelayedChange(db: SqlDatabase, change: SyncChange, now: () => number = Date.now): number {
  const existing = db.prepare('SELECT seq FROM _change_log WHERE log_id = ?').get(change.logId);
  if (existing) return Number(existing.seq);
  const seq = maxLocalSeq(db) + 1;
  db.prepare(
    'INSERT INTO _change_log (log_id, seq, device_id, entity, entity_id, op, payload, hlc, created_at, pushed) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(
    change.logId,
    seq,
    change.deviceId,
    change.entity,
    change.entityId,
    change.op,
    change.payload ? JSON.stringify(change.payload) : null,
    change.hlc,
    now(),
  );
  return seq;
}

/** 按全局 seq 拉取变更（`seq > sinceSeq`，升序）。 */
export function pullSince(db: SqlDatabase, sinceSeq: number, limit = 500): SyncChange[] {
  const rows = db
    .prepare(`SELECT * FROM _change_log WHERE seq > ? ORDER BY seq LIMIT ${Math.max(1, Math.floor(limit))}`)
    .all(sinceSeq);
  return rows.map(toChange);
}

// ---------------- 冲突中心 ----------------

/** 列出冲突（可按状态过滤：0 待处理 / 1 已裁决）。 */
export function listConflicts(db: SqlDatabase, opts: { status?: number } = {}): ConflictRow[] {
  const where = opts.status === undefined ? '' : 'WHERE status = ?';
  const params = opts.status === undefined ? [] : [opts.status];
  const rows = db.prepare(`SELECT * FROM _conflict ${where} ORDER BY rowid DESC`).all(...params);
  return rows.map((row) => ({
    id: String(row.id),
    entity: String(row.entity ?? ''),
    entity_id: String(row.entity_id ?? ''),
    field: String(row.field ?? ''),
    value_a: row.value_a === null || row.value_a === undefined ? null : String(row.value_a),
    value_b: row.value_b === null || row.value_b === undefined ? null : String(row.value_b),
    hlc_a: String(row.hlc_a ?? ''),
    hlc_b: String(row.hlc_b ?? ''),
    winner: String(row.winner ?? ''),
    resolved_value: row.resolved_value === null || row.resolved_value === undefined ? null : String(row.resolved_value),
    resolved_by: row.resolved_by === null || row.resolved_by === undefined ? null : String(row.resolved_by),
    resolved_at: row.resolved_at === null || row.resolved_at === undefined ? null : Number(row.resolved_at),
    status: Number(row.status ?? 0),
  }));
}

/** 按实体列类型把裁决值从字符串还原为数值 / 文本。 */
function coerceValue(db: SqlDatabase, entity: string, field: string, raw: string | null): unknown {
  if (raw === null) return null;
  const info = db
    .prepare('SELECT name, type FROM pragma_table_info(?)')
    .all(entity)
    .find((r) => String(r.name) === field);
  const type = String(info?.type ?? '').toUpperCase();
  if (type.includes('INT')) {
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? raw : n;
  }
  if (type.includes('REAL') || type.includes('NUM') || type.includes('FLOA') || type.includes('DOUB')) {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

/**
 * 人工裁决一条冲突：把裁决值写回实体（走统一写入口，会作为本端变更继续同步出去），
 * 并把冲突置为已处理。若提供 `ctx`，还会额外写一条**裁决广播**，让其他各端
 * 按 `(entity, entity_id, field)` 清除同字段的未处理冲突。返回更新后的冲突行。
 */
export function resolveConflict(
  db: SqlDatabase,
  repo: Repository,
  input: { id: string; resolvedValue: string | null; userId: string; now?: () => number; ctx?: SyncContext },
): ConflictRow {
  const row = db.prepare('SELECT * FROM _conflict WHERE id = ?').get(input.id);
  if (!row) throw new Error(`冲突不存在: ${input.id}`);
  if (Number(row.status ?? 0) === 1) throw new Error('该冲突已裁决');

  const entity = String(row.entity ?? '');
  const entityId = String(row.entity_id ?? '');
  const field = String(row.field ?? '');
  const at = (input.now ?? input.ctx?.now ?? Date.now)();
  const value = coerceValue(db, entity, field, input.resolvedValue);

  db.transaction(() => {
    repo.update(entity, entityId, { [field]: value as never });
    db.prepare(
      'UPDATE _conflict SET resolved_value = ?, resolved_by = ?, resolved_at = ?, winner = ?, status = 1 WHERE id = ?',
    ).run(input.resolvedValue, input.userId, at, 'manual', input.id);
    if (input.ctx) {
      recordResolutionBroadcast(db, input.ctx, {
        entity,
        entity_id: entityId,
        field,
        resolved_value: input.resolvedValue,
        resolved_by: input.userId,
        resolved_at: at,
      });
    }
  });

  return listConflicts(db).find((c) => c.id === input.id) as ConflictRow;
}

// ---------------- 状态摘要 ----------------

/** 同步状态摘要：待同步条数 + 待处理冲突 + 上次同步时间 + 游标。 */
export function syncStatus(
  db: SqlDatabase,
  opts: { deviceId: string; peerId?: string },
): SyncStatus {
  const pending = db.prepare('SELECT COUNT(*) AS c FROM _change_log WHERE pushed = 0').get();
  const conflicts = db.prepare('SELECT COUNT(*) AS c FROM _conflict WHERE status = 0').get();
  const cursor = readCursor(db, opts.peerId ?? 'lan:master');
  return {
    deviceId: opts.deviceId,
    pendingCount: Number(pending?.c ?? 0),
    conflictCount: Number(conflicts?.c ?? 0),
    lastSyncAt: cursor.lastSyncAt,
    cursor,
  };
}
