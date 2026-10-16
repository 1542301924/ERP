/**
 * 应用图标生成器（零依赖）。
 *
 * 以代码方式绘制「轻松进销存」图标：蓝色渐变圆角方块 + 白色纸箱。
 * 输出到 apps/desktop/build/：
 *   - icon.ico  多尺寸（16/24/32/48/64/128/256），经典 BMP 格式，兼容性最好
 *   - icon.png  512×512，供其它平台/预览使用
 *
 * 用法：node scripts/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');

/** 采样倍率（每像素 SS×SS 子采样，用于抗锯齿）。 */
const SS = 4;

// ---------------------------------------------------------------- 形状定义
// 坐标均为 [0,1] 归一化空间。

const BG = { x0: 0, y0: 0, x1: 1, y1: 1, r: 0.22 }; // 背景圆角方块（满幅）
const BODY = { x0: 0.28, y0: 0.4, x1: 0.72, y1: 0.78, r: 0.035 }; // 白色箱体
const GROOVE_H = { x0: 0.28, y0: 0.462, x1: 0.72, y1: 0.498 }; // 箱盖横缝
const GROOVE_V = { x0: 0.483, y0: 0.498, x1: 0.517, y1: 0.78 }; // 封箱竖胶带

const TOP = [79, 129, 250]; // 渐变上色 #4F81FA
const BOT = [37, 66, 199]; // 渐变下色 #2542C7
const NAVY = [26, 46, 140]; // 缝隙阴影色

// ---------------------------------------------------------------- 光栅化

function inRoundedRect(x, y, s) {
  const dx = Math.max(s.x0 + s.r - x, 0, x - (s.x1 - s.r));
  const dy = Math.max(s.y0 + s.r - y, 0, y - (s.y1 - s.r));
  return dx * dx + dy * dy <= s.r * s.r;
}

function inRect(x, y, s) {
  return x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1;
}

function gradient(y) {
  return [
    TOP[0] + (BOT[0] - TOP[0]) * y,
    TOP[1] + (BOT[1] - TOP[1]) * y,
    TOP[2] + (BOT[2] - TOP[2]) * y,
  ];
}

function mix(c, d, t) {
  return [c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t, c[2] + (d[2] - c[2]) * t];
}

/** 渲染为直通（非预乘）RGBA 缓冲。 */
function rasterize(size) {
  const out = Buffer.alloc(size * size * 4);
  const samples = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inRoundedRect(x, y, BG)) continue;
          let c = gradient(y);
          if (inRoundedRect(x, y, BODY)) c = [255, 255, 255];
          if (inRect(x, y, GROOVE_H) || inRect(x, y, GROOVE_V)) c = mix(c, NAVY, 0.5);
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a === 0) continue; // 全透明，保持 0
      out[i] = Math.round(r / a);
      out[i + 1] = Math.round(g / a);
      out[i + 2] = Math.round(b / a);
      out[i + 3] = Math.round((a / samples) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO 编码

/** 单个 ICO 图像项：BITMAPINFOHEADER + 32bpp BGRA（自下而上）+ AND 掩码。 */
function icoImage(rgba, size) {
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(size, 4);
  info.writeInt32LE(size * 2, 8); // 高度含掩码，故为 2 倍
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  info.writeUInt32LE(size * size * 4, 20);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }

  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    const mrow = y * maskRowBytes;
    for (let x = 0; x < size; x++) {
      if (rgba[srcRow + x * 4 + 3] < 128) mask[mrow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([info, pixels, mask]);
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = 图标
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  const blobs = [];
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const blob = icoImage(e.rgba, e.size);
    const dim = e.size >= 256 ? 0 : e.size; // 256 以 0 表示
    dir.writeUInt8(dim, i * 16);
    dir.writeUInt8(dim, i * 16 + 1);
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(blob.length, i * 16 + 8);
    dir.writeUInt32LE(offset, i * 16 + 12);
    blobs.push(blob);
    offset += blob.length;
  });
  return Buffer.concat([header, dir, ...blobs]);
}

// ---------------------------------------------------------------- 生成

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIco(ICO_SIZES.map((size) => ({ size, rgba: rasterize(size) }))));
writeFileSync(join(OUT_DIR, 'icon.png'), encodePng(rasterize(512), 512));
console.log(`icon.ico 已生成（${ICO_SIZES.join('/')}）`);
console.log('icon.png 已生成（512×512）');
