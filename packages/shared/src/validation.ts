/**
 * 通用校验 / 解析辅助。
 */

/** 解析 `dirty_fields`（JSON 数组字符串）为字段名数组。 */
export function parseDirtyFields(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v));
  } catch {
    // 忽略非法 JSON
  }
  return [];
}

/** 序列化字段名数组为 `dirty_fields`。 */
export function stringifyDirtyFields(fields: string[]): string {
  return JSON.stringify([...new Set(fields)].sort());
}

/** §4.2 同步字段的列名清单。 */
export const SYNC_FIELD_NAMES = [
  'id',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
  'version',
  'origin_device',
  'hlc',
  'dirty_fields',
  'sync_state',
  'deleted',
] as const;

/** 返回行中缺失的必填同步字段（合法则返回空数组）。 */
export function validateSyncFields(row: Record<string, unknown>): string[] {
  const required = ['id', 'created_by', 'created_at', 'version', 'origin_device', 'hlc', 'sync_state', 'deleted'];
  return required.filter((k) => row[k] === undefined || row[k] === null);
}
