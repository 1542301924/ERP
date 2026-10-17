/**
 * 主节点 LAN 同步服务（P7）。
 *
 * 主节点用 Node 内置 `http` 暴露局域网接口，**不依赖 electron / 第三方库**：
 *  - `GET  /health`     健康检查与状态摘要；
 *  - `POST /sync/push`  接收客户端推送的变更（幂等落库 + 以全局 seq 中继）；
 *  - `GET  /sync/pull`  客户端按全局 seq 断点续传拉取变更；
 *  - `GET  /events`     SSE 通知流：有新变更时推送提示，客户端据此触发拉取。
 *
 * 拓扑：星型。各桌面端（客户端）把自己的 `_change_log` 推给主节点；主节点落库后以**全局序号**
 * 写入自身 `_change_log`，其他客户端按游标拉取，从而收敛到一致状态。
 *
 * 本模块同样可在 `node:test` 下真实起服务并用 `fetch` 联调（本机回环地址）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SqlDatabase } from '../db/sqlite';
import { maxLocalSeq, pullSince, receivePush, syncStatus, type SyncChange, type SyncContext } from './sync-core';

/** 客户端推送请求体。 */
export interface PushRequest {
  deviceId: string;
  changes: SyncChange[];
}

export interface PushResponse {
  ok: boolean;
  ackSeq: number;
  applied: number;
  conflicts: number;
  duplicate: number;
}

export interface PullResponse {
  ok: boolean;
  changes: SyncChange[];
  nextSeq: number;
}

export interface HealthResponse {
  ok: boolean;
  deviceId: string;
  pendingCount: number;
  conflictCount: number;
  seq: number;
  time: number;
}

export interface LanServerOptions {
  db: SqlDatabase;
  /** 同步上下文（与主节点写入口共享 clock）。 */
  ctx: SyncContext;
  port?: number;
  /** 绑定地址，默认 `0.0.0.0`（局域网可访问）；测试可用 `127.0.0.1`。 */
  host?: string;
  now?: () => number;
}

export interface LanServerHandle {
  port: number;
  host: string;
  url: string;
  /** 主动向所有 SSE 订阅者广播一次变更提示。 */
  broadcast(seq: number): void;
  close(): Promise<void>;
}

/** 读取请求体并解析 JSON（空体返回 null）。 */
function readJson<T>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text) as T);
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * 启动主节点 LAN 服务。
 */
export function startLanServer(opts: LanServerOptions): Promise<LanServerHandle> {
  const { db, ctx } = opts;
  const host = opts.host ?? '0.0.0.0';
  const now = opts.now ?? ctx.now ?? Date.now;
  const sseClients = new Set<ServerResponse>();

  const broadcast = (seq: number): void => {
    const payload = `event: change\ndata: ${JSON.stringify({ seq })}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      const status = syncStatus(db, { deviceId: ctx.deviceId });
      const body: HealthResponse = {
        ok: true,
        deviceId: ctx.deviceId,
        pendingCount: status.pendingCount,
        conflictCount: status.conflictCount,
        seq: maxLocalSeq(db),
        time: now(),
      };
      sendJson(res, 200, body);
      return;
    }

    if (req.method === 'POST' && path === '/sync/push') {
      const body = await readJson<PushRequest>(req);
      if (!body || typeof body.deviceId !== 'string' || !Array.isArray(body.changes)) {
        sendJson(res, 400, { ok: false, error: '需要 { deviceId, changes }' });
        return;
      }
      const result = receivePush(db, ctx, body.deviceId, body.changes);
      broadcast(result.ackSeq);
      const response: PushResponse = {
        ok: true,
        ackSeq: result.ackSeq,
        applied: result.applied,
        conflicts: result.conflicts,
        duplicate: result.duplicate,
      };
      sendJson(res, 200, response);
      return;
    }

    if (req.method === 'GET' && path === '/sync/pull') {
      const since = Number(url.searchParams.get('since') ?? '0');
      const changes = pullSince(db, Number.isFinite(since) ? since : 0);
      const nextSeq = changes.length > 0 ? changes[changes.length - 1].seq : Math.max(0, since);
      const response: PullResponse = { ok: true, changes, nextSeq };
      sendJson(res, 200, response);
      return;
    }

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // 连接即回一个 open 事件，便于客户端确认握手成功
      res.write(`event: open\ndata: ${JSON.stringify({ deviceId: ctx.deviceId, seq: maxLocalSeq(db) })}\n\n`);
      sseClients.add(res);
      const cleanup = (): void => {
        sseClients.delete(res);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }

    sendJson(res, 404, { ok: false, error: `未知路由: ${req.method} ${path}` });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8765, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : (opts.port ?? 8765);
      resolve({
        port,
        host,
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
        broadcast,
        close: () =>
          new Promise<void>((done) => {
            for (const client of sseClients) {
              try {
                client.end();
              } catch {
                /* ignore */
              }
            }
            sseClients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

// ---------------- 客户端传输（基于 fetch） ----------------

/** 客户端 → 主节点的传输接口（可注入内存实现以便测试）。 */
export interface SyncTransport {
  health(baseUrl: string): Promise<HealthResponse>;
  push(baseUrl: string, deviceId: string, changes: SyncChange[]): Promise<PushResponse>;
  pull(baseUrl: string, sinceSeq: number): Promise<PullResponse>;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** 基于全局 `fetch` 的 HTTP 传输实现。 */
export const httpTransport: SyncTransport = {
  async health(baseUrl) {
    const res = await fetch(`${trimBase(baseUrl)}/health`);
    if (!res.ok) throw new Error(`health 失败: HTTP ${res.status}`);
    return (await res.json()) as HealthResponse;
  },
  async push(baseUrl, deviceId, changes) {
    const res = await fetch(`${trimBase(baseUrl)}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, changes } satisfies PushRequest),
    });
    if (!res.ok) throw new Error(`push 失败: HTTP ${res.status}`);
    return (await res.json()) as PushResponse;
  },
  async pull(baseUrl, sinceSeq) {
    const res = await fetch(`${trimBase(baseUrl)}/sync/pull?since=${encodeURIComponent(String(sinceSeq))}`);
    if (!res.ok) throw new Error(`pull 失败: HTTP ${res.status}`);
    return (await res.json()) as PullResponse;
  },
};
