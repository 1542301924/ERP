/**
 * 首批种子数据（计划 §2 任务 6）。
 * 全部写入走统一写入口（Repository），因此同样会追加 `_change_log`。
 */

import { createHlc, SysConfigKey, SysConfigDefault } from '@inventory/shared';
import { ensureDeviceId, getSysConfig, setSysConfig } from './database';
import { Repository } from './repository';
import { ADMIN_ROLE_ID, ADMIN_USER_ID, LEGACY_ADMIN_HASH } from '../services/auth';
import type { SqlDatabase } from './sqlite';

/** 默认单位 id -> 名称。 */
const DEFAULT_UNITS: Array<[string, string]> = [
  ['u_ge', '个'],
  ['u_jian', '件'],
  ['u_xiang', '箱'],
  ['u_kg', 'kg'],
];

/** 默认仓库 / 客户 / 供应商：装好即可直接开单，无需先建档。 */
const DEFAULT_BASIC_DATA: Array<{ entity: string; id: string; name: string }> = [
  { entity: 'warehouse', id: 'wh_default', name: '主仓库' },
  { entity: 'customer', id: 'cus_default', name: '普通客户' },
  { entity: 'supplier', id: 'sup_default', name: '普通供应商' },
];

/** 默认编号规则：纯数字、定长 8 位（如 00000001），装好即可「自动生成」编号。 */
const DEFAULT_CODE_RULES: Array<{ target: string; seqLen: number }> = [
  { target: 'product', seqLen: 8 },
];

/** 默认管理员账号：**免密登录**（口令留空即可，可在「用户与角色权限」中另行设置）。 */
const DEFAULT_ADMIN_ACCOUNT = 'admin';

export function seedDefaultData(db: SqlDatabase, options: { deviceId?: string } = {}): void {
  const deviceId = options.deviceId ?? ensureDeviceId(db);

  // sys_config 默认值（已存在则跳过）
  for (const [key, value] of Object.entries(SysConfigDefault)) {
    if (getSysConfig(db, key) === null) setSysConfig(db, key, value);
  }

  const repo = new Repository(db, {
    userId: 'system',
    deviceId,
    clock: createHlc(deviceId),
  });

  // 默认单位
  for (const [id, name] of DEFAULT_UNITS) {
    if (!repo.findById('unit', id)) repo.insert('unit', { name, sort: 0, status: 1 }, id);
  }

  // 默认基础资料：已存在同 id 或同名（含手工建档）时跳过，避免重复
  for (const item of DEFAULT_BASIC_DATA) {
    if (repo.findById(item.entity, item.id)) continue;
    if (repo.list(item.entity).some((row) => String(row.name) === item.name)) continue;
    repo.insert(item.entity, { name: item.name, status: 1 }, item.id);
  }

  // 默认编号规则：按 target 去重，已配置（含用户自定义）则不覆盖
  for (const item of DEFAULT_CODE_RULES) {
    const existing = db
      .prepare('SELECT id FROM code_rule WHERE target = ? AND deleted = 0')
      .get(item.target);
    if (existing) continue;
    repo.insert('code_rule', {
      target: item.target,
      prefix: null,
      category_code: null,
      seq_len: item.seqLen,
      next_seq: 1,
    });
  }

  // 默认管理员角色
  if (!repo.findById('role', ADMIN_ROLE_ID)) {
    repo.insert('role', { name: '管理员', remark: '系统内置管理员角色' }, ADMIN_ROLE_ID);
  }

  // 默认 admin 用户（免密）
  if (!repo.findById('app_user', ADMIN_USER_ID)) {
    repo.insert(
      'app_user',
      {
        account: DEFAULT_ADMIN_ACCOUNT,
        name: '管理员',
        pwd_hash: null,
        role_id: ADMIN_ROLE_ID,
        status: 1,
      },
      ADMIN_USER_ID,
    );
  } else {
    // 老库迁移：早期版本内置默认口令为 admin123，升级后清空以支持免密登录
    const admin = repo.findById('app_user', ADMIN_USER_ID)!;
    if (admin.pwd_hash === LEGACY_ADMIN_HASH) repo.update('app_user', ADMIN_USER_ID, { pwd_hash: null });
  }
}

export { SysConfigKey };
