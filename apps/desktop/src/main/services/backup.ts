/**
 * 数据备份 / 恢复服务（P8）。
 *
 * 设计：不依赖 electron，仅用 node:fs 与 SqlDatabase 抽象，便于单测。
 *  - 备份：`VACUUM INTO` 生成「单文件、一致性」快照（WAL 下亦安全，不阻塞读）。
 *  - 恢复：校验备份 -> 生成恢复前快照 -> checkpoint -> 关闭连接 -> 覆盖主库文件；
 *          当前连接关闭后由调用方重启应用完成恢复。
 * 说明：备份 / 恢复是本地运维动作，不参与多端同步（backup_record 非同步表）。
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { newId, SysConfigKey } from '@inventory/shared';
import { getSysConfig, setSysConfig } from '../db/database';
import { createDatabase, type SqlDatabase } from '../db/sqlite';

/** 备份类型：manual 手动 / auto 自动 / safety 恢复前自动快照。 */
export type BackupKind = 'manual' | 'auto' | 'safety';

/** 备份记录行（backup_record）。 */
export interface BackupRecord {
  id: string;
  file_path: string;
  size: number;
  kind: string;
  at: number;
  remark: string | null;
}

/** 备份上下文：主库连接、主库文件路径、默认备份目录、时间源（便于测试）。 */
export interface BackupContext {
  db: SqlDatabase;
  dbFile: string;
  backupsDir: string;
  now?: () => number;
}

/** SQLite 文件头魔数（16 字节）。 */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'utf8');
const DEFAULT_KEEP = 7;

function timestampName(now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** SQL 字符串字面量转义（用于 VACUUM INTO 的文件名）。 */
function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 只读取文件前 n 字节（避免把大备份整文件读入内存）。 */
function readHead(file: string, n: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

function removeFile(path: string): void {
  if (existsSync(path)) rmSync(path, { force: true });
}

/** 判断路径是否位于指定目录内（区分「受管备份」与「用户另存副本」）。 */
export function isInsideDir(filePath: string, dir: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return filePath.startsWith(prefix);
}

/** 生成一致性快照到目标路径，返回文件大小；目标已存在则先删除。 */
function writeSnapshot(db: SqlDatabase, destPath: string): number {
  mkdirSync(dirname(destPath), { recursive: true });
  removeFile(destPath);
  db.exec(`VACUUM INTO ${sqlString(destPath)};`);
  return statSync(destPath).size;
}

function listRecordRows(db: SqlDatabase): BackupRecord[] {
  return db
    .prepare('SELECT id, file_path, size, kind, at, remark FROM backup_record ORDER BY at DESC, id DESC')
    .all() as unknown as BackupRecord[];
}

/** 备份记录列表（按时间倒序）。 */
export function listBackups(db: SqlDatabase): BackupRecord[] {
  return listRecordRows(db);
}

/** 读取保留份数（sys_config.backup_keep，默认 7）。 */
export function backupKeep(db: SqlDatabase): number {
  const raw = Number(getSysConfig(db, SysConfigKey.BACKUP_KEEP) ?? DEFAULT_KEEP);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_KEEP;
}

/** 设置保留份数，返回规范化后的值。 */
export function setBackupKeep(db: SqlDatabase, keep: number): number {
  const normalized = Math.max(0, Math.floor(Number(keep) || 0));
  setSysConfig(db, SysConfigKey.BACKUP_KEEP, String(normalized));
  return normalized;
}

/**
 * 创建一次备份。
 * @param opts.destPath 目标路径；缺省写入默认备份目录（受保留份数管理）。
 */
export function createBackup(
  ctx: BackupContext,
  opts: { destPath?: string; kind?: BackupKind; remark?: string } = {},
): BackupRecord {
  const now = ctx.now?.() ?? Date.now();
  const kind = opts.kind ?? 'manual';
  const dest = opts.destPath ?? join(ctx.backupsDir, `inventory-${timestampName(now)}.db`);
  const size = writeSnapshot(ctx.db, dest);

  const record: BackupRecord = {
    id: newId(),
    file_path: dest,
    size,
    kind,
    at: now,
    remark: opts.remark ?? null,
  };
  ctx.db
    .prepare(
      'INSERT INTO backup_record (id, file_path, size, kind, at, remark) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(record.id, record.file_path, record.size, record.kind, record.at, record.remark);

  if (kind !== 'safety') pruneBackups(ctx);
  return record;
}

/**
 * 按保留份数清理「默认备份目录内」的 manual / auto 备份（恢复前快照不受影响）。
 * @returns 被删除的记录 id 列表
 */
export function pruneBackups(ctx: BackupContext): string[] {
  const keep = backupKeep(ctx.db);
  if (keep <= 0) return [];
  const managed = listRecordRows(ctx.db).filter(
    (row) => row.kind !== 'safety' && isInsideDir(row.file_path, ctx.backupsDir),
  );
  const removed: string[] = [];
  for (const row of managed.slice(keep)) {
    removeFile(row.file_path);
    ctx.db.prepare('DELETE FROM backup_record WHERE id = ?').run(row.id);
    removed.push(row.id);
  }
  return removed;
}

/** 删除一条备份记录；记录位于默认备份目录内时连同文件一起删除。 */
export function deleteBackup(ctx: BackupContext, id: string): void {
  const row = ctx.db
    .prepare('SELECT id, file_path FROM backup_record WHERE id = ?')
    .get(id) as { id: string; file_path: string } | undefined;
  if (!row) return;
  if (isInsideDir(row.file_path, ctx.backupsDir)) removeFile(row.file_path);
  ctx.db.prepare('DELETE FROM backup_record WHERE id = ?').run(id);
}

/** 校验备份文件：存在、非空、SQLite 头、含预期表 `sys_config`。不符合则抛错。 */
export function validateBackupFile(filePath: string): void {
  if (!existsSync(filePath)) throw new Error('备份文件不存在');
  if (statSync(filePath).size < 512) throw new Error('备份文件过小或已损坏');
  if (!readHead(filePath, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    throw new Error('不是有效的 SQLite 备份文件');
  }
  const probe = createDatabase(filePath);
  try {
    const table = probe
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sys_config'")
      .get();
    if (!table) throw new Error('备份文件缺少必要的表结构，可能来自其他系统');
  } finally {
    probe.close();
  }
}

/** 恢复结果：恢复前自动快照的路径。 */
export interface RestoreResult {
  safetyPath: string;
}

/**
 * 从备份文件恢复主库。
 *
 * 步骤：校验 -> 生成恢复前自动快照 -> WAL checkpoint -> 关闭当前连接 -> 用备份覆盖主库文件。
 * 成功后当前连接已关闭，调用方必须重启应用（否则无法继续访问数据库）。
 */
export function restoreFromBackup(ctx: BackupContext, backupPath: string): RestoreResult {
  validateBackupFile(backupPath);

  // 1) 恢复前先给当前数据留一份快照，出问题可回退
  const safety = createBackup(ctx, { kind: 'safety', remark: '恢复前自动快照' });

  // 2) 落盘并关闭连接，避免覆盖时发生写入冲突
  try {
    ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    // 忽略：非 WAL 或驱动不支持时无需 checkpoint
  }
  ctx.db.close();

  // 3) 覆盖主库文件（先清掉 WAL/SHM 旁文件，避免残留旧数据）
  try {
    removeFile(`${ctx.dbFile}-wal`);
    removeFile(`${ctx.dbFile}-shm`);
    copyFileSync(backupPath, ctx.dbFile);
  } catch (err) {
    // 尽力回滚：把恢复前快照拷回主库，保证下次启动仍可用
    try {
      copyFileSync(safety.file_path, ctx.dbFile);
    } catch {
      // 忽略回滚失败
    }
    throw err;
  }
  return { safetyPath: safety.file_path };
}
