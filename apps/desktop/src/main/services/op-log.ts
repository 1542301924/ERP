/**
 * 操作日志服务（P2）：将关键操作写入 `op_log`。
 *
 * 注意：`op_log` **不含同步字段**，无法经由 `Repository` 写入，
 * 因此这里直接用 `db.prepare` 原始插入（符合设计约定）。
 */

import { newId } from '@inventory/shared';
import type { SqlDatabase } from '../db/sqlite';

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
