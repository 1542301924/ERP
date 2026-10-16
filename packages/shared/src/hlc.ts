/**
 * 混合逻辑时钟（Hybrid Logical Clock，HLC）。
 *
 * 参考设计文档 §4.2：多台电脑墙钟可能不一致，直接用 updated_at 判先后会误判；
 * HLC 保证「物理时间近似 + 因果序严格」。
 *
 * 序列化格式：`"<physicalMillis>:<counter>:<deviceId>"`。
 */

export interface Hlc {
  /** 物理时间（epoch 毫秒，近似值） */
  physical: number;
  /** 同一物理时间内的逻辑计数 */
  counter: number;
  /** 产生该事件的设备 ID（作为全序的最终 tie-break） */
  deviceId: string;
}

export function serializeHlc(hlc: Hlc): string {
  return `${hlc.physical}:${hlc.counter}:${hlc.deviceId}`;
}

export function parseHlc(value: string): Hlc {
  const first = value.indexOf(':');
  const second = value.indexOf(':', first + 1);
  if (first < 0 || second < 0) {
    throw new Error(`非法的 HLC 格式: ${value}`);
  }
  const physical = Number(value.slice(0, first));
  const counter = Number(value.slice(first + 1, second));
  const deviceId = value.slice(second + 1);
  if (!Number.isFinite(physical) || !Number.isFinite(counter)) {
    throw new Error(`非法的 HLC 格式: ${value}`);
  }
  return { physical, counter, deviceId };
}

/** 全序比较：物理时间 → 逻辑计数 → deviceId。返回 -1 / 0 / 1。 */
export function compareHlc(a: Hlc | string, b: Hlc | string): number {
  const ha = typeof a === 'string' ? parseHlc(a) : a;
  const hb = typeof b === 'string' ? parseHlc(b) : b;
  if (ha.physical !== hb.physical) return ha.physical < hb.physical ? -1 : 1;
  if (ha.counter !== hb.counter) return ha.counter < hb.counter ? -1 : 1;
  if (ha.deviceId !== hb.deviceId) return ha.deviceId < hb.deviceId ? -1 : 1;
  return 0;
}

/**
 * 收到远端事件后推进本地时钟（纯函数版本）。
 * 规则：新的物理时间 = max(本地, 远端, 现在)；计数按命中情况 +1，否则归零。
 * 结果满足 compareHlc(返回值, remote) > 0，即远端事件严格先于本地后续事件。
 */
export function receiveHlc(local: Hlc, remote: Hlc, now: number = Date.now()): Hlc {
  const physical = Math.max(local.physical, remote.physical, now);
  let counter: number;
  if (physical === local.physical && physical === remote.physical) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (physical === local.physical) {
    counter = local.counter + 1;
  } else if (physical === remote.physical) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  return { physical, counter, deviceId: local.deviceId };
}

/**
 * 有状态的本地时钟。
 */
export class HlcClock {
  private physical = 0;
  private counter = 0;

  constructor(
    public readonly deviceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 本地事件 tick：产生一个新的 HLC 并推进本地时钟。 */
  tick(): Hlc {
    const nowMs = this.now();
    if (nowMs > this.physical) {
      this.physical = nowMs;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return { physical: this.physical, counter: this.counter, deviceId: this.deviceId };
  }

  /** 收到远端事件后推进本地时钟。 */
  receive(remote: Hlc | string): Hlc {
    const r = typeof remote === 'string' ? parseHlc(remote) : remote;
    const advanced = receiveHlc(this.current(), r, this.now());
    this.physical = advanced.physical;
    this.counter = advanced.counter;
    return this.current();
  }

  /** 当前时钟状态快照。 */
  current(): Hlc {
    return { physical: this.physical, counter: this.counter, deviceId: this.deviceId };
  }
}

/** 创建一个本地 HLC 时钟。`now` 可注入用于测试。 */
export function createHlc(deviceId: string, now: () => number = Date.now): HlcClock {
  return new HlcClock(deviceId, now);
}

export const serialize = serializeHlc;
export const parse = parseHlc;
