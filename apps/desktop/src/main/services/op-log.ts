/**
 * 操作日志服务（P2）：将关键操作写入 `op_log`。
 *
 * 注意：`op_log` **不含同步字段**，无法经由 `Repository` 写入，
 * 因此这里直接用 `db.prepare` 原始插入（符合设计约定）。
 */

import { newId } from '@inventory/shared';
import type { SqlDatabase } from '../db/sqlite';

/** 操作日志查询条件（时间为毫秒，闭区间）。 */
export interface OpLogFilter {
  keyword?: string;
  action?: string;
  entity?: string;
  userId?: string;
  startDate?: number;
  endDate?: number;
  limit?: number;
}

/** 操作日志列表行（日志 + 操作人名称）。 */
export interface OpLogRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  account: string | null;
  action: string;
  entity: string;
  entity_id: string;
  device_id: string | null;
  at: number;
}

/** 操作日志详情（含变更前后快照）。 */
export interface OpLogDetail extends OpLogRow {
  before_json: string | null;
  after_json: string | null;
  ip: string | null;
}

/** 写入一条操作日志。 */
export function writeOpLog(
  db: SqlDatabase,
  input: {
    user_id: string;
    action: string;
    entity: string;
    entity_id: string;
    before?: unknown;
    after?: unknown;
    device_id: string;
    at?: number;
  },
): void {
  db.prepare(
    'INSERT INTO op_log (id, user_id, action, entity, entity_id, before_json, after_json, device_id, ip, at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
  ).run(
    newId(),
    input.user_id,
    input.action,
    input.entity,
    input.entity_id,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.device_id,
    input.at ?? Date.now(),
  );
}

/** 操作日志列表（按时间倒序，可按操作人 / 动作 / 实体 / 日期过滤）。 */
export function listOpLog(db: SqlDatabase, filter: OpLogFilter = {}): OpLogRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.action) {
    where.push('l.action = ?');
    params.push(filter.action);
  }
  if (filter.entity) {
    where.push('l.entity = ?');
    params.push(filter.entity);
  }
  if (filter.userId) {
    where.push('l.user_id = ?');
    params.push(filter.userId);
  }
  if (filter.startDate !== undefined && filter.startDate !== null) {
    where.push('l.at >= ?');
    params.push(filter.startDate);
  }
  if (filter.endDate !== undefined && filter.endDate !== null) {
    where.push('l.at <= ?');
    params.push(filter.endDate);
  }
  const keyword = filter.keyword?.trim();
  if (keyword) {
    where.push('(l.entity_id LIKE ? OR u.name LIKE ? OR u.account LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  const limitSuffix = filter.limit ? ` LIMIT ${Math.max(0, Math.floor(filter.limit))}` : '';

  const sql =
    'SELECT l.id, l.user_id, l.action, l.entity, l.entity_id, l.device_id, l.at, ' +
    'u.name AS user_name, u.account AS account ' +
    'FROM op_log l ' +
    'LEFT JOIN app_user u ON u.id = l.user_id ' +
    (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
    `ORDER BY l.at DESC, l.id DESC${limitSuffix}`;

  return db.prepare(sql).all(...params) as unknown as OpLogRow[];
}

/** 操作日志详情（含变更前后快照，用于审计比对）。 */
export function getOpLog(db: SqlDatabase, id: string): OpLogDetail | null {
  const row = db
    .prepare(
      'SELECT l.id, l.user_id, l.action, l.entity, l.entity_id, l.device_id, l.at, l.ip, ' +
        'l.before_json, l.after_json, u.name AS user_name, u.account AS account ' +
        'FROM op_log l LEFT JOIN app_user u ON u.id = l.user_id WHERE l.id = ?',
    )
    .get(id) as unknown as OpLogDetail | undefined;

  return row ?? null;
}
