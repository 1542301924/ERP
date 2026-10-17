/**
 * 小程序全量 JS 语法检查（不执行代码，仅解析）。
 * 用法：npm run lint:syntax
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', 'miniprogram_npm', '.git']);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
let bad = 0;
for (const file of files) {
  try {
    // 仅解析，不执行：能捕获所有语法错误。
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  } catch (e) {
    bad += 1;
    console.error(`✖ ${path.relative(ROOT, file)}: ${e.message}`);
  }
}
console.log(`语法检查：${files.length} 个文件，${bad} 个失败`);
process.exit(bad ? 1 : 0);
