/**
 * 构建期资源拷贝：把运行时按路径读取的非 TS 文件放到 dist 对应位置。
 *
 * 主进程由 esbuild 打包成单文件 dist/main/index.cjs，但 `database.ts` 会在
 * 运行时按 `__dirname` 旁边的路径读取 `schema.sql`；若不同步拷贝，
 * 打包进 asar 后会因 `dist/main/schema.sql` 缺失而在启动时报 ENOENT。
 *
 * 用法：node scripts/copy-assets.mjs
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [源文件, 目标文件]，均为相对 apps/desktop 的路径。 */
const ASSETS = [['src/main/db/schema.sql', 'dist/main/schema.sql']];

for (const [from, to] of ASSETS) {
  const dest = join(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(root, from), dest);
  console.log(`copied ${from} -> ${to}`);
}
