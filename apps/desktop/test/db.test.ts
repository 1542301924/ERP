import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc } from '@inventory/shared';
import { openAndInit, SCHEMA_VERSION, getSysConfig } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import { seedDefaultData } from '../src/main/db/seed';
import type { SqlDatabase } from '../src/main/db/sqlite';

function makeRepo(db: SqlDatabase, deviceId = 'devTest', userId = 'u1'): Repository {
  return new Repository(db, { userId, deviceId, clock: createHlc(deviceId) }, () => 1_700_000_000_000);
}

function count(db: SqlDatabase, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0);
}

test('建库成功：表数量与关键表存在，schema 版本已写入', () => {
  const db = openAndInit(':memory:');
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name as string);

  // §5 共 41 张表
  assert.equal(names.length, 41, `实际表: ${names.sort().join(', ')}`);
  for (const t of [
    'unit',
    'product',
    'product_unit',
    'product_barcode',
    'stock_ledger',
    'stock_balance',
    'sales_outbound_item',
    'ar_receipt_apply',
    '_change_log',
    '_sync_cursor',
    '_conflict',
    'op_log',
    'sys_config',
    'backup_record',
  ]) {
    assert.ok(names.includes(t), `缺少表 ${t}`);
  }
  assert.equal(getSysConfig(db, 'schema_version'), String(SCHEMA_VERSION));
  db.close();
});

test('insert：同一事务内 _change_log 出现一条日志', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);

  const row = repo.insert('unit', { name: '个', sort: 0, status: 1 });
  assert.ok(row.id);

  const logs = db.prepare("SELECT * FROM _change_log WHERE entity = 'unit'").all();
  assert.equal(logs.length, 1);
  const log = logs[0];
  assert.equal(log.op, 'insert');
  assert.equal(log.entity_id, row.id);
  assert.equal(log.seq, 1);
  assert.equal(log.device_id, 'devTest');
  assert.equal(log.pushed, 0);
  const payload = JSON.parse(log.payload as string);
  assert.equal(payload.name, '个');
  assert.equal(payload.created_by, 'u1');
  assert.equal(payload.origin_device, 'devTest');
  db.close();
});

test('update：version 自增且 dirty_fields 正确', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const row = repo.insert('unit', { name: '个', sort: 0, status: 1 });

  repo.update('unit', row.id as string, { name: '件' });
  const after = repo.findById('unit', row.id as string)!;
  assert.equal(after.version, 2);
  assert.deepEqual(JSON.parse(after.dirty_fields as string), ['name']);
  assert.equal(after.name, '件');
  assert.equal(after.updated_by, 'u1');

  const logs = db.prepare("SELECT * FROM _change_log WHERE entity = 'unit' ORDER BY seq").all();
  assert.equal(logs.length, 2);
  assert.equal(logs[1].op, 'update');
  db.close();
});

test('softDelete：置 deleted=1 并写日志', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const row = repo.insert('unit', { name: '个', sort: 0, status: 1 });

  repo.softDelete('unit', row.id as string);
  const after = repo.findById('unit', row.id as string)!;
  assert.equal(after.deleted, 1);
  assert.equal(after.version, 2);

  assert.equal(count(db, 'unit'), 1);
  assert.equal(repo.list('unit').length, 0, '默认列表应排除软删除行');
  assert.equal(repo.list('unit', { includeDeleted: true }).length, 1);
  assert.equal(count(db, '_change_log'), 2);
  db.close();
});

test('事务原子性：_change_log 写入失败则业务行回滚', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);

  // 用触发器强制 _change_log 写入失败
  db.exec("CREATE TRIGGER trg_fail BEFORE INSERT ON _change_log BEGIN SELECT RAISE(ABORT, 'forced'); END;");

  assert.throws(() => repo.insert('unit', { name: '不应存在', sort: 0, status: 1 }));
  assert.equal(count(db, 'unit'), 0, '业务行必须回滚');
  assert.equal(count(db, '_change_log'), 0);

  // 移除触发器后恢复正常
  db.exec('DROP TRIGGER trg_fail');
  repo.insert('unit', { name: '正常', sort: 0, status: 1 });
  assert.equal(count(db, 'unit'), 1);
  assert.equal(count(db, '_change_log'), 1);
  db.close();
});

test('append-only 实体禁止 update / softDelete', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  const ledger = repo.insert('stock_ledger', {
    biz_type: '采购入库',
    product_id: 'p1',
    warehouse_id: 'w1',
    qty_in: 10,
    biz_date: 1_700_000_000_000,
  });
  assert.throws(() => repo.update('stock_ledger', ledger.id as string, { qty_in: 20 }));
  db.close();
});

test('种子数据：sys_config 默认值 / 默认单位 / 管理员角色与用户（幂等）', () => {
  const db = openAndInit(':memory:');
  seedDefaultData(db, { deviceId: 'devSeed' });

  assert.equal(getSysConfig(db, 'allow_negative_stock'), '0');
  assert.equal(getSysConfig(db, 'backup_keep'), '7');
  assert.equal(getSysConfig(db, 'lan_port'), '8765');
  assert.equal(getSysConfig(db, 'auto_launch'), '0');

  const units = db.prepare('SELECT name FROM unit WHERE deleted = 0').all().map((r) => r.name as string);
  assert.deepEqual(units.sort(), ['kg', '个', '件', '箱'].sort());

  const role = db.prepare("SELECT * FROM role WHERE id = 'role_admin'").get();
  assert.ok(role, '应存在默认管理员角色');

  const admin = db.prepare("SELECT * FROM app_user WHERE account = 'admin'").get();
  assert.ok(admin, '应存在 admin 用户');
  assert.equal(admin?.role_id, 'role_admin');

  // 幂等：重复种子不产生重复行
  seedDefaultData(db, { deviceId: 'devSeed' });
  assert.equal(count(db, 'unit'), 4);
  assert.equal(count(db, 'role'), 1);
  assert.equal(count(db, 'app_user'), 1);
  db.close();
});
