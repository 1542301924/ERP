import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHlc,
  receiveHlc,
  compareHlc,
  serializeHlc,
  parseHlc,
  type Hlc,
} from '../src/hlc';

test('本地 tick：新毫秒 counter 归零，同毫秒 counter 递增', () => {
  let nowMs = 1000;
  const clock = createHlc('devA', () => nowMs);

  const h1 = clock.tick();
  assert.deepEqual(h1, { physical: 1000, counter: 0, deviceId: 'devA' });

  const h2 = clock.tick(); // 同一毫秒
  assert.deepEqual(h2, { physical: 1000, counter: 1, deviceId: 'devA' });

  nowMs = 1001;
  const h3 = clock.tick();
  assert.deepEqual(h3, { physical: 1001, counter: 0, deviceId: 'devA' });

  assert.ok(compareHlc(h3, h2) > 0);
});

test('序列化 / 反序列化往返一致', () => {
  const h: Hlc = { physical: 1730000000000, counter: 7, deviceId: 'dev-xyz' };
  const s = serializeHlc(h);
  assert.equal(s, '1730000000000:7:dev-xyz');
  assert.deepEqual(parseHlc(s), h);
  assert.throws(() => parseHlc('bad'));
});

test('compareHlc：先物理时间，再计数，最后 deviceId', () => {
  const a: Hlc = { physical: 1, counter: 0, deviceId: 'a' };
  const b: Hlc = { physical: 1, counter: 0, deviceId: 'b' };
  const c: Hlc = { physical: 1, counter: 1, deviceId: 'a' };
  const d: Hlc = { physical: 2, counter: 0, deviceId: 'a' };

  assert.equal(compareHlc(a, a), 0);
  assert.ok(compareHlc(a, b) < 0);
  assert.ok(compareHlc(b, c) < 0);
  assert.ok(compareHlc(c, d) < 0);
  // 支持字符串入参
  assert.ok(compareHlc(serializeHlc(a), serializeHlc(d)) < 0);
});

test('receiveHlc（纯函数）：收到远端后推进本地时钟，因果序严格', () => {
  const local: Hlc = { physical: 1000, counter: 2, deviceId: 'devLocal' };
  const remote: Hlc = { physical: 1005, counter: 0, deviceId: 'devRemote' };

  const advanced = receiveHlc(local, remote, 1005);
  // 物理时间取 max，且命中的是 remote 的物理时间 → counter = remote.counter + 1
  assert.equal(advanced.physical, 1005);
  assert.equal(advanced.counter, 1);
  assert.equal(advanced.deviceId, 'devLocal');
  assert.ok(compareHlc(advanced, remote) > 0, '本地后续事件必须严格晚于收到的远端事件');
});

test('receiveHlc：同一物理时间时 counter = max+1', () => {
  const local: Hlc = { physical: 1000, counter: 5, deviceId: 'devLocal' };
  const remote: Hlc = { physical: 1000, counter: 3, deviceId: 'devRemote' };
  const advanced = receiveHlc(local, remote, 1000);
  assert.equal(advanced.physical, 1000);
  assert.equal(advanced.counter, 6);
  assert.ok(compareHlc(advanced, remote) > 0);
  assert.ok(compareHlc(advanced, local) > 0);
});

test('HlcClock.receive 有状态推进', () => {
  let nowMs = 1000;
  const clock = createHlc('devLocal', () => nowMs);
  clock.tick();
  const remote = serializeHlc({ physical: 1200, counter: 4, deviceId: 'devRemote' });
  const advanced = clock.receive(remote);
  assert.equal(advanced.physical, 1200);
  assert.equal(advanced.counter, 5);
  nowMs = 1200;
  const next = clock.tick();
  assert.ok(compareHlc(next, parseHlc(remote)) > 0);
});
