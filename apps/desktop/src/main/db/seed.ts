/**
 * 首批种子数据（计划 §2 任务 6）。
 * 全部写入走统一写入口（Repository），因此同样会追加 `_change_log`。
 */

import { createHash } from 'node:crypto';
import { createHlc, SysConfigKey, SysConfigDefault } from '@inventory/shared';
import { ensureDeviceId, getSysConfig, setSysConfig } from './database';
import { Repository } from './repository';
import type { SqlDatabase } from './sqlite';

/** 默认单位 id -> 名称。 */
const DEFAULT_UNITS: Array<[string, string]> = [
  ['u_ge', '个'],
  ['u_jian', '件'],
  ['u_xiang', '箱'],
  ['u_kg', 'kg'],
];

/** 默认管理员账号（首次登录用；密码为占位默认值，P1 接入登录后强制修改）。 */
const DEFAULT_ADMIN_ACCOUNT = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin123';

function hashPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

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

  // 默认管理员角色
  if (!repo.findById('role', 'role_admin')) {
    repo.insert('role', { name: '管理员', remark: '系统内置管理员角色' }, 'role_admin');
  }

  // 默认 admin 用户
  if (!repo.findById('app_user', 'user_admin')) {
    repo.insert(
      'app_user',
      {
        account: DEFAULT_ADMIN_ACCOUNT,
        name: '管理员',
        pwd_hash: hashPassword(DEFAULT_ADMIN_PASSWORD),
        role_id: 'role_admin',
        status: 1,
      },
      'user_admin',
    );
  }
}

export { SysConfigKey };
