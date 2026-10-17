/** 展示格式化工具（金额一律保留 2 位，数量去掉无意义的尾零）。 */

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : '0.00';
}

function qty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return String(Math.round(v * 10000) / 10000);
}

/** 时间戳 → YYYY-MM-DD。 */
function date(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 时间戳 → YYYY-MM-DD HH:mm。 */
function dateTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${date(ts)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 单据状态码 → 文案（与桌面端 DocStatus 一致）。 */
function docStatusText(status) {
  if (status === 1) return '已审核';
  if (status === 9) return '已红冲';
  return '待审核';
}

module.exports = { money, qty, date, dateTime, docStatusText };
