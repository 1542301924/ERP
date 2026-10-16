/**
 * 编号规则服务（P1）。
 *
 * 不依赖 electron；`nextCode` 在同一事务内「读取规则 -> 生成编号 -> 递增序号」，
 * 递增走 `Repository.update`，因此会记入 `_change_log`。
 */

import type { Repository } from '../db/repository';
import type { SqlDatabase } from '../db/sqlite';

/** 读取 `code_rule` 并生成下一个编号，同时原子递增序号。 */
export function nextCode(db: SqlDatabase, repo: Repository, target: string): string {
  return db.transaction(() => {
    const rule = db.prepare('SELECT * FROM code_rule WHERE target = ? AND deleted = 0').get(target);
    if (!rule) throw new Error(`未配置编号规则: ${target}`);

    const prefix = (rule.prefix as string | null) ?? '';
    const categoryCode = (rule.category_code as string | null) ?? '';
    const seqLen = Number(rule.seq_len ?? 4);
    const nextSeq = Number(rule.next_seq ?? 1);

    const code = `${prefix}${categoryCode}${String(nextSeq).padStart(seqLen, '0')}`;
    repo.update('code_rule', rule.id as string, { next_seq: nextSeq + 1 });
    return code;
  });
}
