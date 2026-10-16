import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChange, type IncomingChange, type Row } from '../src/sync/apply';

function masterRow(overrides: Partial<Row>): Row {
  return {
    id: 'p1',
    name: '旧商品',
    sale_price: 10,
    version: 1,
    hlc: '500:0:base',
    dirty_fields: '[]',
    sync_state: 0,
    deleted: 0,
    ...overrides,
  };
}

test('场景一：两端各新增单据（append-only）互不冲突，直接插入', () => {
  const changeA: IncomingChange = {
    entity: 'sales_outbound',
    entity_id: 'doc-A',
    op: 'insert',
    hlc: '1000:0:devA',
    payload: { id: 'doc-A', doc_no: 'XS0001', status: 1, deleted: 0 },
  };
  const changeB: IncomingChange = {
    entity: 'purchase_inbound',
    entity_id: 'doc-B',
    op: 'insert',
    hlc: '1000:0:devB',
    payload: { id: 'doc-B', doc_no: 'RK0001', status: 1, deleted: 0 },
  };

  const rA = applyChange(null, changeA);
  const rB = applyChange(null, changeB);

  assert.equal(rA.action, 'insert');
  assert.equal(rB.action, 'insert');
  assert.equal(rA.conflicts.length, 0);
  assert.equal(rB.conflicts.length, 0);
  assert.equal(rA.row?.doc_no, 'XS0001');
  assert.equal(rB.row?.doc_no, 'RK0001');

  // append-only 幂等：同一变更再次到达 → noop
  const again = applyChange(rA.row, changeA);
  assert.equal(again.action, 'noop');
  assert.equal(again.conflicts.length, 0);
});

test('场景二：两端改同一商品的不同字段 → 字段级合并，无冲突', () => {
  // 本地改了 sale_price，远端改了 name
  const local = masterRow({ sale_price: 12, name: '旧商品', dirty_fields: '["sale_price"]', hlc: '1000:0:devA' });
  const incoming: IncomingChange = {
    entity: 'product',
    entity_id: 'p1',
    op: 'update',
    hlc: '1001:0:devB',
    payload: masterRow({ name: '新商品', sale_price: 10, dirty_fields: '["name"]', hlc: '1001:0:devB' }),
  };

  const result = applyChange(local, incoming);
  assert.equal(result.action, 'update');
  assert.equal(result.conflicts.length, 0, '不同字段不应产生冲突');
  assert.equal(result.row?.name, '新商品', '远端字段被合入');
  assert.equal(result.row?.sale_price, 12, '本地字段被保留');
  assert.equal(result.syncState, 1);
});

test('场景三：两端改同一字段 → HLC 晚者胜并留痕冲突', () => {
  const local = masterRow({ sale_price: 12, dirty_fields: '["sale_price"]', hlc: '1000:0:devA' });
  const incoming: IncomingChange = {
    entity: 'product',
    entity_id: 'p1',
    op: 'update',
    hlc: '2000:0:devB', // 更晚
    payload: masterRow({ sale_price: 15, dirty_fields: '["sale_price"]', hlc: '2000:0:devB' }),
  };

  const result = applyChange(local, incoming);
  assert.equal(result.conflicts.length, 1);
  const c = result.conflicts[0];
  assert.equal(c.field, 'sale_price');
  assert.equal(c.winner, 'b', 'HLC 晚者（远端）胜');
  assert.equal(c.value_a, '12');
  assert.equal(c.value_b, '15');
  assert.equal(result.row?.sale_price, 15);
  assert.equal(result.syncState, 2, '冲突时置 sync_state=2');

  // 反向：远端更早 → 本地胜
  const localLate = masterRow({ sale_price: 12, dirty_fields: '["sale_price"]', hlc: '3000:0:devA' });
  const incomingEarly: IncomingChange = {
    entity: 'product',
    entity_id: 'p1',
    op: 'update',
    hlc: '1000:0:devB',
    payload: masterRow({ sale_price: 15, dirty_fields: '["sale_price"]', hlc: '1000:0:devB' }),
  };
  const r2 = applyChange(localLate, incomingEarly);
  assert.equal(r2.conflicts[0].winner, 'a');
  assert.equal(r2.row?.sale_price, 12);
  assert.equal(r2.syncState, 2);
});

test('场景四：LWW 收敛（应用顺序不影响最终结果）', () => {
  const base = masterRow({ sale_price: 10, dirty_fields: '[]', hlc: '500:0:base' });
  const changeA: IncomingChange = {
    entity: 'product',
    entity_id: 'p1',
    op: 'update',
    hlc: '1000:0:devA',
    payload: masterRow({ sale_price: 12, dirty_fields: '["sale_price"]', hlc: '1000:0:devA' }),
  };
  const changeB: IncomingChange = {
    entity: 'product',
    entity_id: 'p1',
    op: 'update',
    hlc: '2000:0:devB',
    payload: masterRow({ sale_price: 15, dirty_fields: '["sale_price"]', hlc: '2000:0:devB' }),
  };

  // 端 1：先应用 A 再应用 B
  const afterA = applyChange(base, changeA).row!;
  const end1 = applyChange(afterA, changeB).row!;

  // 端 2：先应用 B 再应用 A
  const afterB = applyChange(base, changeB).row!;
  const end2 = applyChange(afterB, changeA).row!;

  assert.equal(end1.sale_price, 15);
  assert.equal(end2.sale_price, 15);
  assert.equal(end1.hlc, end2.hlc, '收敛后 HLC 一致');
});

test('派生状态（stock_balance / ar_bill / ap_bill）不参与 apply', () => {
  const incoming: IncomingChange = {
    entity: 'stock_balance',
    entity_id: 'p1:w1:',
    op: 'update',
    hlc: '9000:0:devX',
    payload: { id: 'p1:w1:', qty: 999 },
  };
  const r = applyChange(null, incoming);
  assert.equal(r.action, 'skip');
  assert.equal(r.row, null);
});
