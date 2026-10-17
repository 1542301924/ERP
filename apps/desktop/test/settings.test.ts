import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAndInit } from '../src/main/db/database';
import { seedDefaultData } from '../src/main/db/seed';
import { readAppSettings, saveAppSettings } from '../src/main/services/settings';
import type { SqlDatabase } from '../src/main/db/sqlite';

function cfgValue(db: SqlDatabase, key: string): string | null {
  const row = db.prepare('SELECT cfg_value FROM sys_config WHERE cfg_key = ?').get(key);
  return row ? (row.cfg_value as string | null) : null;
}

test('readAppSettings：默认全部关闭', () => {
  const db = openAndInit(':memory:');
  seedDefaultData(db, { deviceId: 'devS' });
  assert.deepEqual(readAppSettings(db), { allowNegativeStock: false, autoLaunch: false });
  db.close();
});

test('saveAppSettings：以 0/1 落库并可读回', () => {
  const db = openAndInit(':memory:');
  const saved = saveAppSettings(db, { allowNegativeStock: true });
  assert.equal(cfgValue(db, 'allow_negative_stock'), '1');
  assert.deepEqual(saved, { allowNegativeStock: true, autoLaunch: false });
  assert.equal(readAppSettings(db).allowNegativeStock, true);
  db.close();
});

test('saveAppSettings：只更新显式提供的字段', () => {
  const db = openAndInit(':memory:');
  saveAppSettings(db, { allowNegativeStock: true, autoLaunch: true });
  saveAppSettings(db, { autoLaunch: false });
  const s = readAppSettings(db);
  assert.equal(s.allowNegativeStock, true, '未被提供的字段不应被覆盖');
  assert.equal(s.autoLaunch, false);
  assert.equal(cfgValue(db, 'auto_launch'), '0');
  db.close();
});
