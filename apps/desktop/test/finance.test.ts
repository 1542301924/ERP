import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { Repository } from '../src/main/db/repository';
import { seedDefaultData } from '../src/main/db/seed';
import type { SqlDatabase } from '../src/main/db/sqlite';
import { audit, get, list, reverse, save, unaudit } from '../src/main/services/finance-docs';
import {
  accountFlow,
  listBills,
  listSettleDocs,
  openBills,
  recomputeAccountBalance,
} from '../src/main/services/finance';
import type { DocContext } from '../src/main/services/documents';

const T = 1_700_000_000_000;

interface Pack {
  db: SqlDatabase;
  repo: Repository;
  ctx: DocContext;
}

function setup(): Pack {
  const db = openAndInit(':memory:');
  seedDefaultData(db, { deviceId: 'devT' });
  const repo = new Repository(db, { userId: 'u1', deviceId: 'devT', clock: createHlc('devT') }, () => T);
  const ctx: DocContext = { userId: 'u1', deviceId: 'devT', now: () => T };
  return { db, repo, ctx };
}

/** 基础资料：两个客户、一个供应商、一个资金账户，以及三张往来单。 */
function fixtures(repo: Repository): void {
  repo.insert('customer', { name: '客户甲', status: 1 }, 'c1');
  repo.insert('customer', { name: '客户乙', status: 1 }, 'c2');
  repo.insert('supplier', { name: '供应商甲', status: 1 }, 's1');
  repo.insert('account', { name: '现金', type: '现金', balance: 0, status: 1 }, 'acc1');
  repo.insert('ar_bill', { customer_id: 'c1', amount: 1000, received_amount: 0, status: 1 }, 'ar1');
  repo.insert('ar_bill', { customer_id: 'c1', amount: 500, received_amount: 0, status: 1 }, 'ar2');
  repo.insert('ap_bill', { supplier_id: 's1', amount: 800, paid_amount: 0, status: 1 }, 'ap1');
}

function receivedOf(db: SqlDatabase, id: string): number {
  return Number(db.prepare('SELECT received_amount FROM ar_bill WHERE id = ?').get(id)?.received_amount ?? 0);
}

function paidOf(db: SqlDatabase, id: string): number {
  return Number(db.prepare('SELECT paid_amount FROM ap_bill WHERE id = ?').get(id)?.paid_amount ?? 0);
}

function balanceOf(db: SqlDatabase, id: string): number {
  return Number(db.prepare('SELECT balance FROM account WHERE id = ?').get(id)?.balance ?? 0);
}

test('收款单：审核后核销生效（往来单已收 + 账户余额），取消审核后回退', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const doc = save(db, repo, ctx, 'ar_receipt', {
    partner_id: 'c1',
    account_id: 'acc1',
    amount: 600,
    date: T,
    method: '现金',
    applies: [{ bill_id: 'ar1', amount: 600 }],
  });
  assert.equal(Number(doc.status), 0);
  assert.match(String(doc.doc_no), /^SK/);
  // 草稿阶段不影响派生计数
  assert.equal(receivedOf(db, 'ar1'), 0);
  assert.equal(balanceOf(db, 'acc1'), 0);

  const audited = audit(db, repo, ctx, 'ar_receipt', doc.id as string);
  assert.equal(Number(audited.status), 1);
  assert.equal(receivedOf(db, 'ar1'), 600);
  assert.equal(balanceOf(db, 'acc1'), 600);

  const back = unaudit(db, repo, ctx, 'ar_receipt', doc.id as string);
  assert.equal(Number(back.status), 0);
  assert.equal(receivedOf(db, 'ar1'), 0);
  assert.equal(balanceOf(db, 'acc1'), 0);

  db.close();
});

test('收款单：红冲生成反向已审核单据，净额为 0，原单置 9', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const doc = save(db, repo, ctx, 'ar_receipt', {
    partner_id: 'c1',
    account_id: 'acc1',
    amount: 1000,
    date: T,
    applies: [{ bill_id: 'ar1', amount: 1000 }],
  });
  audit(db, repo, ctx, 'ar_receipt', doc.id as string);
  assert.equal(receivedOf(db, 'ar1'), 1000);
  assert.equal(balanceOf(db, 'acc1'), 1000);

  const res = reverse(db, repo, ctx, 'ar_receipt', doc.id as string);
  assert.equal(Number(res.doc.status), 9);

  const rDoc = db.prepare('SELECT * FROM ar_receipt WHERE id = ?').get(res.reversalDocId) as Record<string, unknown>;
  assert.equal(Number(rDoc.status), 1);
  assert.equal(Number(rDoc.amount), -1000);
  assert.equal(rDoc.reversal_of, doc.id);

  // 净额为 0：原单（9）+ 反向单（1）相互冲销
  assert.equal(receivedOf(db, 'ar1'), 0);
  assert.equal(balanceOf(db, 'acc1'), 0);

  // 已红冲原单不可再次操作
  assert.throws(() => unaudit(db, repo, ctx, 'ar_receipt', doc.id as string), /单据已红冲，不能再次操作/);

  db.close();
});

test('付款单：审核后应付单已付 + 账户余额减少，红冲后回退', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const doc = save(db, repo, ctx, 'ap_payment', {
    partner_id: 's1',
    account_id: 'acc1',
    amount: 800,
    date: T,
    applies: [{ bill_id: 'ap1', amount: 800 }],
  });
  assert.match(String(doc.doc_no), /^FK/);

  audit(db, repo, ctx, 'ap_payment', doc.id as string);
  assert.equal(paidOf(db, 'ap1'), 800);
  assert.equal(balanceOf(db, 'acc1'), -800);

  reverse(db, repo, ctx, 'ap_payment', doc.id as string);
  assert.equal(paidOf(db, 'ap1'), 0);
  assert.equal(balanceOf(db, 'acc1'), 0);

  db.close();
});

test('收款单：单笔核销超过单据金额 / 合计超单据金额，保存即拒绝', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  // 单笔 200 > 单据金额 100：合计校验先行拦截
  assert.throws(
    () =>
      save(db, repo, ctx, 'ar_receipt', {
        partner_id: 'c1',
        account_id: 'acc1',
        amount: 100,
        date: T,
        applies: [{ bill_id: 'ar1', amount: 200 }],
      }),
    /核销金额合计不能超过单据金额/,
  );

  // 多笔合计 400 > 单据金额 300
  assert.throws(
    () =>
      save(db, repo, ctx, 'ar_receipt', {
        partner_id: 'c1',
        account_id: 'acc1',
        amount: 300,
        date: T,
        applies: [
          { bill_id: 'ar1', amount: 200 },
          { bill_id: 'ar2', amount: 200 },
        ],
      }),
    /核销金额合计不能超过单据金额/,
  );

  db.close();
});

test('收款单：核销的往来单不属于所选客户，保存即拒绝（中文错误）', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  assert.throws(
    () =>
      save(db, repo, ctx, 'ar_receipt', {
        partner_id: 'c2',
        account_id: 'acc1',
        amount: 500,
        date: T,
        applies: [{ bill_id: 'ar1', amount: 500 }],
      }),
    /核销的往来单不属于该客户/,
  );

  db.close();
});

test('收款单：审核时超过往来单未结清余额即拒绝，不改变派生计数', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  // 先审核一笔 600，ar1 剩余 400
  const first = save(db, repo, ctx, 'ar_receipt', {
    partner_id: 'c1',
    account_id: 'acc1',
    amount: 600,
    date: T,
    applies: [{ bill_id: 'ar1', amount: 600 }],
  });
  audit(db, repo, ctx, 'ar_receipt', first.id as string);

  // 再开一笔 500 核销 ar1（剩余 400）：保存通过，审核报错
  const second = save(db, repo, ctx, 'ar_receipt', {
    partner_id: 'c1',
    account_id: 'acc1',
    amount: 500,
    date: T,
    applies: [{ bill_id: 'ar1', amount: 500 }],
  });
  assert.throws(() => audit(db, repo, ctx, 'ar_receipt', second.id as string), /核销金额超过往来单未结清余额/);
  assert.equal(receivedOf(db, 'ar1'), 600);
  assert.equal(balanceOf(db, 'acc1'), 600);

  db.close();
});

test('往来单列表：结清状态由金额派生，openBills 只返回未结清单', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  // 全额核销 ar1
  const doc = save(db, repo, ctx, 'ar_receipt', {
    partner_id: 'c1',
    account_id: 'acc1',
    amount: 1000,
    date: T,
    applies: [{ bill_id: 'ar1', amount: 1000 }],
  });
  audit(db, repo, ctx, 'ar_receipt', doc.id as string);

  const all = listBills(db, 'ar', {});
  const ar1 = all.find((b) => b.id === 'ar1')!;
  const ar2 = all.find((b) => b.id === 'ar2')!;
  assert.equal(ar1.settle_state, 'settled');
  assert.equal(ar1.remaining, 0);
  assert.equal(ar2.settle_state, 'unsettled');
  assert.equal(ar2.remaining, 500);

  assert.equal(listBills(db, 'ar', { settleState: 'settled' }).length, 1);
  assert.equal(listBills(db, 'ar', { settleState: 'unsettled' }).length, 1);

  const open = openBills(db, 'ar', 'c1');
  assert.deepEqual(open.map((b) => b.id), ['ar2']);

  db.close();
});

test('收付款单列表与资金账户流水：由已审核单据派生（含红冲净额）', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const receipt = save(db, repo, ctx, 'ar_receipt', {
    partner_id: 'c1',
    account_id: 'acc1',
    amount: 400,
    date: T,
    method: '银行转账',
    applies: [{ bill_id: 'ar1', amount: 400 }],
  });
  audit(db, repo, ctx, 'ar_receipt', receipt.id as string);

  const rows = listSettleDocs(db, 'ar_receipt', {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].partner_name, '客户甲');
  assert.equal(rows[0].account_name, '现金');
  assert.equal(rows[0].applied_amount, 400);
  assert.equal(rows[0].status, 1);

  const flow = accountFlow(db, { accountId: 'acc1' });
  assert.equal(flow.length, 1);
  assert.equal(flow[0].direction, 'in');
  assert.equal(flow[0].amount, 400);
  assert.equal(flow[0].partner_name, '客户甲');
  assert.equal(flow[0].doc_no, receipt.doc_no);

  // 红冲后：原单（9，+400）+ 反向单（1，-400）净额为 0，且流水含两笔
  reverse(db, repo, ctx, 'ar_receipt', receipt.id as string);
  const flow2 = accountFlow(db, { accountId: 'acc1' });
  assert.equal(flow2.length, 2);
  assert.equal(flow2.reduce((s, r) => s + r.amount, 0), 0);
  assert.equal(balanceOf(db, 'acc1'), 0);

  // 详情含核销明细
  const got = get(db, 'ar_receipt', receipt.id as string)!;
  assert.equal(got.applies.length, 1);
  assert.equal(got.applies[0].bill_id, 'ar1');
  assert.equal(got.applies[0].bill_source_doc_no, null);

  db.close();
});

test('全量重算资金账户余额：与逐笔已审核收付款单口径一致', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const r = save(db, repo, ctx, 'ar_receipt', {
    partner_id: 'c1',
    account_id: 'acc1',
    amount: 300,
    date: T,
    applies: [],
  });
  audit(db, repo, ctx, 'ar_receipt', r.id as string);
  const p = save(db, repo, ctx, 'ap_payment', {
    partner_id: 's1',
    account_id: 'acc1',
    amount: 100,
    date: T,
    applies: [],
  });
  audit(db, repo, ctx, 'ap_payment', p.id as string);

  assert.equal(balanceOf(db, 'acc1'), 200);
  // 手工抹掉余额后用重算恢复
  db.prepare('UPDATE account SET balance = 0 WHERE id = ?').run('acc1');
  const n = recomputeAccountBalance(db);
  assert.equal(n, 1);
  assert.equal(balanceOf(db, 'acc1'), 200);

  db.close();
});

test('收款单：list 可按状态过滤', () => {
  const { db, repo, ctx } = setup();
  fixtures(repo);

  const doc = save(db, repo, ctx, 'ar_receipt', {
    partner_id: 'c1',
    account_id: 'acc1',
    amount: 100,
    date: T,
    applies: [],
  });
  assert.equal(list(db, 'ar_receipt', { status: 0 }).length, 1);
  assert.equal(list(db, 'ar_receipt', { status: 1 }).length, 0);

  audit(db, repo, ctx, 'ar_receipt', doc.id as string);
  assert.equal(list(db, 'ar_receipt', { status: 0 }).length, 0);
  assert.equal(list(db, 'ar_receipt', { status: 1 }).length, 1);

  db.close();
});
