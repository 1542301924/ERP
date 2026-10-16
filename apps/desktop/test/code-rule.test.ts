import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import { nextCode } from '../src/main/services/code-rule';
import type { SqlDatabase } from '../src/main/db/sqlite';

function makeRepo(db: SqlDatabase): Repository {
  return new Repository(db, { userId: 'u1', deviceId: 'devT', clock: createHlc('devT') }, () => 1_700_000_000_000);
}

test('nextCode：按 seq_len 零填充并递增', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  repo.insert('code_rule', { target: 'product', prefix: 'P', category_code: '', seq_len: 4, next_seq: 1 });

  assert.equal(nextCode(db, repo, 'product'), 'P0001');
  assert.equal(nextCode(db, repo, 'product'), 'P0002');

  const rule = db.prepare("SELECT * FROM code_rule WHERE target = 'product'").get()!;
  assert.equal(Number(rule.next_seq), 3);
  db.close();
});

test('nextCode：拼接 prefix + category_code', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  repo.insert('code_rule', { target: 'customer', prefix: 'C', category_code: 'BJ', seq_len: 3, next_seq: 7 });
  assert.equal(nextCode(db, repo, 'customer'), 'CBJ007');
  db.close();
});

test('nextCode：递增持久化并写入 _change_log(update)', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  repo.insert('code_rule', { target: 'product', prefix: 'P', category_code: null, seq_len: 4, next_seq: 1 });

  nextCode(db, repo, 'product');

  const logs = db.prepare("SELECT * FROM _change_log WHERE entity = 'code_rule' ORDER BY seq").all();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].op, 'insert');
  assert.equal(logs[1].op, 'update');
  const payload = JSON.parse(logs[1].payload as string);
  assert.equal(payload.next_seq, 2);
  db.close();
});

test('nextCode：缺少规则时抛错', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  assert.throws(() => nextCode(db, repo, 'unknown'), /未配置编号规则/);
  db.close();
});
