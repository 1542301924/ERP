/**
 * 本地 SQLite 库的打开 / 初始化。
 *
 * - 打开即设置 `PRAGMA journal_mode = WAL`、`PRAGMA foreign_keys = ON`。
 * - 通过 `sys_config.schema_version` 记录并执行 `schema.sql`（幂等，后续迁移在此接入）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newId, SysConfigKey } from '@inventory/shared';
import { createDatabase, type SqlDatabase } from './sqlite';

export const SCHEMA_VERSION = 2;

const SCHEMA_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8');

/** 需要新增 `reversal_of` 列的单据表（硬编码字面量，不接受外部输入）。 */
const REVERSAL_OF_TABLES = ['purchase_order', 'purchase_inbound', 'sales_order', 'sales_outbound'] as const;

/**
 * 幂等迁移：为四类单据表补齐 `reversal_of` 列。
 *
 * 依据 `pragma_table_info` 的列检查（而非 schema_version 值）决定是否需要 ALTER，
 * 因此即使旧库中 `sys_config.schema_version` 仍为 '1' 也能正确升级。
 */
function migrateReversalOf(db: SqlDatabase): void {
  for (const table of REVERSAL_OF_TABLES) {
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table);
    const hasColumn = columns.some((c) => c.name === 'reversal_of');
    if (!hasColumn) db.exec(`ALTER TABLE ${table} ADD COLUMN reversal_of TEXT`);
  }
}

/** 打开并配置 SQLite 连接。 */
export function openDatabase(file: string): SqlDatabase {
  const db = createDatabase(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

/** 执行建表脚本并写入 schema 版本。 */
export function initSchema(db: SqlDatabase): void {
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    migrateReversalOf(db);
    if (getSysConfig(db, SysConfigKey.SCHEMA_VERSION) === null) {
      setSysConfig(db, SysConfigKey.SCHEMA_VERSION, String(SCHEMA_VERSION));
    }
  });
}

/** 打开 + 初始化，一步到位。 */
export function openAndInit(file: string): SqlDatabase {
  const db = openDatabase(file);
  initSchema(db);
  return db;
}

export function getSysConfig(db: SqlDatabase, key: string): string | null {
  const row = db.prepare('SELECT cfg_value FROM sys_config WHERE cfg_key = ?').get(key);
  return row ? (row.cfg_value as string | null) : null;
}

export function setSysConfig(db: SqlDatabase, key: string, value: string): void {
  db.prepare(
    'INSERT INTO sys_config (id, cfg_key, cfg_value) VALUES (?, ?, ?) ' +
      'ON CONFLICT(cfg_key) DO UPDATE SET cfg_value = excluded.cfg_value',
  ).run(newId(), key, value);
}

export function getAllSysConfig(db: SqlDatabase): Record<string, string> {
  const rows = db.prepare('SELECT cfg_key, cfg_value FROM sys_config').all();
  const out: Record<string, string> = {};
  for (const row of rows) out[row.cfg_key as string] = (row.cfg_value as string | null) ?? '';
  return out;
}

/** 获取（或首次生成并持久化）本机设备 ID。 */
export function ensureDeviceId(db: SqlDatabase): string {
  const existing = getSysConfig(db, SysConfigKey.DEVICE_ID);
  if (existing) return existing;
  const id = newId();
  setSysConfig(db, SysConfigKey.DEVICE_ID, id);
  return id;
}
