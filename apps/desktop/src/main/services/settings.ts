/**
 * 「设置」页可编辑的系统开关（sys_config 收口）。
 *
 * 只负责读写归一化，保持纯逻辑以便单测；备份保留份数归 `services/backup`、
 * 同步配置归 `services/sync`，此处不重复实现。
 */

import { SysConfigKey } from '@inventory/shared';
import { getSysConfig, setSysConfig } from '../db/database';
import type { SqlDatabase } from '../db/sqlite';

/** 「设置」页开关项。 */
export interface AppSettings {
  /** 允许负库存：关闭（默认）时出库/调拨审核校验可用量。 */
  allowNegativeStock: boolean;
  /** 开机自启。 */
  autoLaunch: boolean;
}

const KEYS: Record<keyof AppSettings, string> = {
  allowNegativeStock: SysConfigKey.ALLOW_NEGATIVE_STOCK,
  autoLaunch: SysConfigKey.AUTO_LAUNCH,
};

/** sys_config 以 '1' / '0' 存储开关，缺省视为关闭。 */
function toBool(value: string | null): boolean {
  return value === '1';
}

/** 读取开关（库内未写入时按默认关闭返回）。 */
export function readAppSettings(db: SqlDatabase): AppSettings {
  return {
    allowNegativeStock: toBool(getSysConfig(db, KEYS.allowNegativeStock)),
    autoLaunch: toBool(getSysConfig(db, KEYS.autoLaunch)),
  };
}

/** 更新开关（仅写入显式提供的字段），返回更新后的完整设置。 */
export function saveAppSettings(db: SqlDatabase, patch: Partial<AppSettings>): AppSettings {
  if (patch.allowNegativeStock !== undefined) {
    setSysConfig(db, KEYS.allowNegativeStock, patch.allowNegativeStock ? '1' : '0');
  }
  if (patch.autoLaunch !== undefined) {
    setSysConfig(db, KEYS.autoLaunch, patch.autoLaunch ? '1' : '0');
  }
  return readAppSettings(db);
}
