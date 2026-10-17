import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHlc } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import { createDatabase } from '../src/main/db/sqlite';
import {
  backupKeep,
  createBackup,
  deleteBackup,
  listBackups,
  restoreFromBackup,
  setBackupKeep,
  validateBackupFile,
  type BackupContext,
} from '../src/main/services/backup';

/** 每个用例独立的临时目录。 */
function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'backup-test-'));
}

function makeRepo(db: ReturnType<typeof openAndInit>): Repository {
  return new Repository(db, { userId: 'u1', deviceId: 'devT', clock: createHlc('devT') }, () => 1_700_000_000_000);
}

/** 构造带可推进时间源的备份上下文。 */
function makeCtx(db: ReturnType<typeof openAndInit>, dir: string): { ctx: BackupContext; tick: () => void } {
  let clock = 1_700_000_000_000;
  return {
    ctx: { db, dbFile: join(dir, 'inventory.db'), backupsDir: join(dir, 'backups'), now: () => clock },
    tick: () => {
      clock += 1000;
    },
  };
}

test('createBackup：生成 SQLite 快照并写入 backup_record', () => {
  const dir = tmpDir();
  const db = openAndInit(join(dir, 'inventory.db'));
  makeRepo(db).insert('product', { code: 'P1', name: '商品1' });
  const { ctx } = makeCtx(db, dir);

  const rec = createBackup(ctx);
  assert.ok(existsSync(rec.file_path), '快照文件应已生成');
  assert.equal(rec.kind, 'manual');
  assert.ok(rec.size > 0);
  assert.ok(rec.file_path.startsWith(join(dir, 'backups')), '默认写入备份目录');

  const rows = listBackups(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, rec.id);
  assert.equal(rows[0].size, statSync(rec.file_path).size);

  // 快照内应包含刚写入的商品（用独立连接探测）
  validateBackupFile(rec.file_path);
  const probe = createDatabase(rec.file_path);
  const product = probe.prepare("SELECT name FROM product WHERE code = 'P1'").get();
  assert.equal(product?.name, '商品1');
  probe.close();

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('restoreFromBackup：覆盖主库并生成「恢复前自动快照」', () => {
  const dir = tmpDir();
  const db = openAndInit(join(dir, 'inventory.db'));
  const repo = makeRepo(db);
  repo.insert('product', { code: 'A', name: '原始' });
  const { ctx, tick } = makeCtx(db, dir);

  const backup = createBackup(ctx); // 备份仅含「原始」
  tick();
  repo.insert('product', { code: 'B', name: '新增' });
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM product').get()?.c), 2);

  const { safetyPath } = restoreFromBackup(ctx, backup.file_path);
  assert.ok(existsSync(safetyPath), '恢复前快照应已生成');
  assert.notEqual(safetyPath, backup.file_path, '快照不应覆盖所选备份');

  // 重开主库：只剩下备份时的「原始」
  const restored = openAndInit(join(dir, 'inventory.db'));
  const codes = restored
    .prepare('SELECT code FROM product ORDER BY code')
    .all()
    .map((r) => r.code);
  assert.deepEqual(codes, ['A']);
  restored.close();

  // 恢复前快照内含恢复前的两条数据
  const safetyProbe = createDatabase(safetyPath);
  assert.equal(Number(safetyProbe.prepare('SELECT COUNT(*) AS c FROM product').get()?.c), 2);
  safetyProbe.close();

  rmSync(dir, { recursive: true, force: true });
});

test('pruneBackups：按保留份数清理默认目录内的旧备份', () => {
  const dir = tmpDir();
  const db = openAndInit(join(dir, 'inventory.db'));
  const { ctx, tick } = makeCtx(db, dir);
  setBackupKeep(db, 2);
  assert.equal(backupKeep(db), 2);

  for (let i = 0; i < 4; i += 1) {
    createBackup(ctx);
    tick();
  }

  const rows = listBackups(db);
  assert.equal(rows.length, 2, '超出保留份数的备份应被清理');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('deleteBackup：删除记录并移除默认目录内的文件', () => {
  const dir = tmpDir();
  const db = openAndInit(join(dir, 'inventory.db'));
  const { ctx } = makeCtx(db, dir);
  const rec = createBackup(ctx);

  deleteBackup(ctx, rec.id);
  assert.equal(listBackups(db).length, 0);
  assert.equal(existsSync(rec.file_path), false);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('validateBackupFile：拒绝非 SQLite 文件', () => {
  const dir = tmpDir();
  const bad = join(dir, 'bad.db');
  writeFileSync(bad, 'this is not a sqlite database file at all');
  assert.throws(() => validateBackupFile(bad), /损坏|SQLite/);
  rmSync(dir, { recursive: true, force: true });
});

test('restoreFromBackup：非法备份不关闭当前连接', () => {
  const dir = tmpDir();
  const db = openAndInit(join(dir, 'inventory.db'));
  makeRepo(db).insert('product', { code: 'A', name: '原始' });
  const { ctx } = makeCtx(db, dir);
  const bad = join(dir, 'bad.db');
  writeFileSync(bad, 'garbage');

  assert.throws(() => restoreFromBackup(ctx, bad), /损坏|SQLite/);
  // 连接仍可用（未在校验阶段被关闭）
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM product').get()?.c), 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
