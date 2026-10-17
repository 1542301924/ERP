/**
 * 同步编排（P7）。
 *
 * 把「同步核心（sync-core）」与「主节点 LAN 服务（lan）」串起来，向 IPC / 界面提供：
 *  - 主节点角色与地址配置（持久化在 `sys_config`）；
 *  - 手动「立即同步」：客户端把本端 outbox 推给主节点，再按游标拉取增量收敛；
 *  - 后台定时同步引擎（仅 client 角色启用）。
 *
 * 传输层通过 `SyncTransport` 注入，便于单测替换为内存实现。
 */

import { getSysConfig, setSysConfig } from '../db/database';
import type { SqlDatabase } from '../db/sqlite';
import { httpTransport, type SyncTransport } from './lan';
import {
  collectOutbox,
  integratePull,
  markPushed,
  readCursor,
  syncStatus,
  writeCursor,
  type SyncContext,
  type SyncStatus,
} from './sync-core';

/** 节点角色：standalone 单机（不同步）/ master 主节点 / client 客户端。 */
export type SyncRole = 'standalone' | 'master' | 'client';

export interface SyncConfig {
  role: SyncRole;
  masterUrl: string;
  port: number;
  intervalMs: number;
}

export interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  conflicts: number;
  duplicate: number;
  nextSeq: number;
  error?: string;
}

export const SYNC_ROLE_KEY = 'sync_role';
export const SYNC_MASTER_URL_KEY = 'sync_master_url';
export const SYNC_INTERVAL_KEY = 'sync_interval_ms';
const LAN_PORT_KEY = 'lan_port';

const MASTER_PEER_ID = 'lan:master';

function toRole(value: string | null): SyncRole {
  return value === 'master' || value === 'client' ? value : 'standalone';
}

/** 读取同步配置（缺省为单机角色）。 */
export function getSyncConfig(db: SqlDatabase): SyncConfig {
  return {
    role: toRole(getSysConfig(db, SYNC_ROLE_KEY)),
    masterUrl: getSysConfig(db, SYNC_MASTER_URL_KEY) ?? '',
    port: Number(getSysConfig(db, LAN_PORT_KEY) ?? 8765) || 8765,
    intervalMs: Number(getSysConfig(db, SYNC_INTERVAL_KEY) ?? 15000) || 15000,
  };
}

/** 更新同步配置（仅写入显式提供的字段）。 */
export function setSyncConfig(db: SqlDatabase, patch: Partial<SyncConfig>): SyncConfig {
  if (patch.role !== undefined) setSysConfig(db, SYNC_ROLE_KEY, patch.role);
  if (patch.masterUrl !== undefined) setSysConfig(db, SYNC_MASTER_URL_KEY, patch.masterUrl.trim());
  if (patch.port !== undefined) setSysConfig(db, LAN_PORT_KEY, String(patch.port));
  if (patch.intervalMs !== undefined) setSysConfig(db, SYNC_INTERVAL_KEY, String(patch.intervalMs));
  return getSyncConfig(db);
}

/**
 * 立即同步一次：先推本端 outbox，再按游标拉取主节点增量。
 * 需要配置 `masterUrl`（或通过参数显式传入）。
 */
export async function syncNow(
  db: SqlDatabase,
  ctx: SyncContext,
  opts: { transport?: SyncTransport; masterUrl?: string } = {},
): Promise<SyncResult> {
  const config = getSyncConfig(db);
  const masterUrl = (opts.masterUrl ?? config.masterUrl).trim();
  const transport = opts.transport ?? httpTransport;
  const base: SyncResult = { ok: false, pushed: 0, pulled: 0, conflicts: 0, duplicate: 0, nextSeq: 0 };

  if (!masterUrl) {
    return { ...base, error: '未配置主节点地址' };
  }

  try {
    // 1. 推送本端未同步变更
    const outbox = collectOutbox(db, { deviceId: ctx.deviceId });
    let pushed = 0;
    if (outbox.length > 0) {
      await transport.push(masterUrl, ctx.deviceId, outbox);
      pushed = markPushed(db, outbox.map((c) => c.logId));
      writeCursor(db, MASTER_PEER_ID, { lastSyncAt: (ctx.now ?? Date.now)() });
    }

    // 2. 按游标拉取主节点增量并整合
    const cursor = readCursor(db, MASTER_PEER_ID);
    const pullResp = await transport.pull(masterUrl, cursor.lastPullSeq);
    const integrated = integratePull(db, ctx, pullResp.changes, MASTER_PEER_ID);

    return {
      ok: true,
      pushed,
      pulled: integrated.applied,
      conflicts: integrated.conflicts,
      duplicate: integrated.duplicate,
      nextSeq: integrated.nextSeq,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 组合状态：同步摘要 + 配置。 */
export interface SyncCenterState {
  status: SyncStatus;
  config: SyncConfig;
}

export function syncCenterState(db: SqlDatabase, ctx: SyncContext): SyncCenterState {
  return {
    status: syncStatus(db, { deviceId: ctx.deviceId, peerId: MASTER_PEER_ID }),
    config: getSyncConfig(db),
  };
}

/** 后台同步引擎：仅 client 角色且配置了 masterUrl 时按间隔轮询同步。 */
export interface SyncEngine {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  syncNow(): Promise<SyncResult>;
}

export function createSyncEngine(
  db: SqlDatabase,
  ctx: SyncContext,
  opts: { transport?: SyncTransport; intervalMs?: number; onResult?: (r: SyncResult) => void } = {},
): SyncEngine {
  let timer: ReturnType<typeof setInterval> | null = null;

  const run = async (): Promise<SyncResult> => {
    const config = getSyncConfig(db);
    if (config.role !== 'client' || !config.masterUrl.trim()) {
      return { ok: false, pushed: 0, pulled: 0, conflicts: 0, duplicate: 0, nextSeq: 0, error: '未启用客户端同步' };
    }
    const result = await syncNow(db, ctx, { transport: opts.transport, masterUrl: config.masterUrl });
    opts.onResult?.(result);
    return result;
  };

  return {
    isRunning: () => timer !== null,
    syncNow: run,
    start() {
      if (timer) return;
      const interval = Math.max(1000, opts.intervalMs ?? getSyncConfig(db).intervalMs);
      timer = setInterval(() => {
        void run();
      }, interval);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
