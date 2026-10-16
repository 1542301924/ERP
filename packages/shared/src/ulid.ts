/**
 * ULID 生成器（自实现，无第三方依赖）。
 *
 * 结构：26 个 Crockford Base32 字符 = 48bit 时间戳(10 字符) + 80bit 随机数(16 字符)。
 * 同一毫秒内通过计数递增（对 80bit 随机段 +1）保证**单调递增**。
 * 由于 Crockford Base32 字符表按 ASCII 升序，字符串比较即等价于 ULID 时间序比较。
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32（32 个字符）
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10; // 80bit

export type UlidFactory = () => string;

/** 将任意长度 bigint 编码为固定长度 Crockford Base32（低位对齐，高位截断）。 */
function encodeBase32(value: bigint, length: number): string {
  let v = value < 0n ? 0n : value;
  const out = new Array<string>(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = ENCODING[Number(v & 31n)];
    v >>= 5n;
  }
  return out.join('');
}

interface WebCryptoLike {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/** 读取 80bit 随机数。优先使用 Web Crypto（Node 与浏览器均可用）。 */
function randomBigInt(): bigint {
  const bytes = new Uint8Array(RANDOM_BYTES);
  const webCrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

let lastTime = -1;
let lastRandom = 0n;

/**
 * 生成一个新的 ULID。
 * @param nowMs 可注入的时间戳（毫秒），主要用于测试确定性；默认取 `Date.now()`。
 */
export function newId(nowMs?: number): string {
  const now = nowMs ?? Date.now();
  if (now > lastTime) {
    lastTime = now;
    lastRandom = randomBigInt();
  } else {
    // 同一毫秒（或时钟回拨）时保持物理段不变、随机段 +1，保证严格单调递增。
    lastRandom += 1n;
  }
  return encodeBase32(BigInt(lastTime), TIME_CHARS) + encodeBase32(lastRandom, RANDOM_CHARS);
}

/** 重置内部单调状态（仅用于测试隔离）。 */
export function resetUlidState(): void {
  lastTime = -1;
  lastRandom = 0n;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 校验字符串是否是合法的 ULID（26 位 Crockford Base32）。 */
export function isValidUlid(value: string): boolean {
  return typeof value === 'string' && ULID_RE.test(value);
}

/** 从 ULID 中解出毫秒时间戳。 */
export function timestampOf(id: string): number {
  return Number(decodeBase32(id.slice(0, TIME_CHARS)));
}

function decodeBase32(str: string): bigint {
  let v = 0n;
  for (const ch of str) {
    const idx = ENCODING.indexOf(ch);
    if (idx < 0) throw new Error(`非法的 Crockford Base32 字符: ${ch}`);
    v = (v << 5n) | BigInt(idx);
  }
  return v;
}
