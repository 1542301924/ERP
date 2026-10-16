import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, isValidUlid, timestampOf, resetUlidState } from '../src/ulid';

test('ULID 长度与字符集合法', () => {
  const id = newId();
  assert.equal(id.length, 26);
  assert.ok(isValidUlid(id), `应满足 Crockford Base32: ${id}`);
  assert.ok(!isValidUlid(id.slice(0, 25)));
  assert.ok(!isValidUlid(id.replace(id[0], 'I')), 'I 不在 Crockford 字符集');
});

test('ULID 大量生成全局唯一', () => {
  const set = new Set<string>();
  for (let i = 0; i < 5000; i++) set.add(newId());
  assert.equal(set.size, 5000);
});

test('同一毫秒内严格单调递增（字符串序 == 时间序）', () => {
  resetUlidState();
  const now = 1_700_000_000_000;
  const ids: string[] = [];
  for (let i = 0; i < 1000; i++) ids.push(newId(now));
  for (let i = 1; i < ids.length; i++) {
    assert.ok(ids[i] > ids[i - 1], `第 ${i} 个应大于前一个: ${ids[i - 1]} !< ${ids[i]}`);
  }
});

test('时钟回拨仍保持单调递增', () => {
  resetUlidState();
  const a = newId(2_000_000_000_000);
  const b = newId(1_500_000_000_000); // 回拨
  assert.ok(b > a, '回拨后生成的 ID 仍应大于之前的 ID');
});

test('时间戳前缀可解析且与生成时间一致', () => {
  resetUlidState();
  const now = 1_700_000_000_123;
  const id = newId(now);
  assert.equal(timestampOf(id), now);
});
