/**
 * SQLite 薄适配层。
 *
 * 优先使用 `better-sqlite3`（同步 API，事务简单）；若原生编译失败或不可用，
 * 自动回退到 Node 内置 `node:sqlite`。二者 API 差异被本文件隔离，
 * 业务代码（database.ts / repository.ts）只依赖下面的 `SqlDatabase` 接口，
 * 因此将来可以无痛换回 better-sqlite3。
 */

import { createRequire } from 'node:module';

const require = createRequire(__filename);

export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(...params: unknown[]): SqlRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqlDatabase {
  /** 执行多语句 SQL（建表等） */
  exec(sql: string): void;
  /** 预编译语句 */
  prepare(sql: string): SqlStatement;
  /** 事务（支持嵌套，用 SAVEPOINT 实现） */
  transaction<T>(fn: () => T): T;
  /** 实际使用的驱动名称，便于排查 */
  readonly driver: 'better-sqlite3' | 'node:sqlite';
  close(): void;
}

/** 事务/保存点的通用实现，两个驱动共用。 */
abstract class BaseAdapter implements SqlDatabase {
  abstract driver: 'better-sqlite3' | 'node:sqlite';
  abstract exec(sql: string): void;
  abstract prepare(sql: string): SqlStatement;
  abstract close(): void;

  private depth = 0;

  transaction<T>(fn: () => T): T {
    const isOuter = this.depth === 0;
    const savepoint = `sp_${this.depth}`;
    if (isOuter) this.exec('BEGIN IMMEDIATE');
    else this.exec(`SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const result = fn();
      this.depth -= 1;
      if (isOuter) this.exec('COMMIT');
      else this.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.depth -= 1;
      if (isOuter) this.exec('ROLLBACK');
      else {
        this.exec(`ROLLBACK TO ${savepoint}`);
        this.exec(`RELEASE ${savepoint}`);
      }
      throw err;
    }
  }
}

class BetterSqliteAdapter extends BaseAdapter {
  driver = 'better-sqlite3' as const;
  constructor(private readonly db: any) {
    super();
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  prepare(sql: string): SqlStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => stmt.run(...params),
      get: (...params: unknown[]) => stmt.get(...params),
      all: (...params: unknown[]) => stmt.all(...params),
    };
  }
  close(): void {
    this.db.close();
  }
}

class NodeSqliteAdapter extends BaseAdapter {
  driver = 'node:sqlite' as const;
  constructor(private readonly db: any) {
    super();
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  prepare(sql: string): SqlStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => stmt.run(...(params as never[])),
      get: (...params: unknown[]) => stmt.get(...(params as never[])) as Record<string, unknown> | undefined,
      all: (...params: unknown[]) => stmt.all(...(params as never[])) as Record<string, unknown>[],
    };
  }
  close(): void {
    this.db.close();
  }
}

function loadBetterSqlite(): any | null {
  try {
    const mod = require('better-sqlite3');
    return (mod && mod.default) || mod;
  } catch {
    return null;
  }
}

/**
 * 打开（或创建）一个 SQLite 数据库。
 * @param file 文件路径，或 `:memory:`
 */
export function createDatabase(file: string): SqlDatabase {
  const Better = loadBetterSqlite();
  if (Better) {
    return new BetterSqliteAdapter(new Better(file));
  }
  // 回退：Node 内置 node:sqlite
  const { DatabaseSync } = require('node:sqlite');
  return new NodeSqliteAdapter(new DatabaseSync(file));
}
