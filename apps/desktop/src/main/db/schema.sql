-- 轻量级进销存系统 — SQLite 建表脚本（P0）
-- 依据：docs/superpowers/specs/2026-10-16-inventory-system-design.md §5
-- 说明：
--   * 所有业务表统一携带 §4.2 同步字段（下方以真实列写出，非注释占位）。
--   * 单据表统一追加 §5.0 审核字段 audited_by / audited_at。
--   * 单据明细表统一追加 §5.0 计量字段 unit_id / factor / base_qty。
--   * 系统表与派生表（stock_balance）不含同步字段（§5.2 / §5.7）。

------------------------------------------------------------------------
-- §5.1 基础资料（主数据）
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS unit (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  status INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_unit (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  factor REAL NOT NULL DEFAULT 1,          -- 1 个该单位 = factor 个基本单位（如 1 箱 = 12 个）
  is_base INTEGER DEFAULT 0,               -- 是否基本单位
  barcode TEXT,                            -- 该单位专属条码（如整箱码）
  purchase_price REAL, sale_price REAL,    -- 可选：按单位分别定价
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_product_unit ON product_unit(product_id, unit_id);

CREATE TABLE IF NOT EXISTS product_category (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  code TEXT,
  name TEXT NOT NULL,
  path TEXT,              -- 物化路径，如 /root/1/8/
  sort INTEGER DEFAULT 0,
  status INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product (
  id TEXT PRIMARY KEY,
  category_id TEXT,
  code TEXT NOT NULL,                             -- 商品编号，唯一
  name TEXT NOT NULL,
  barcode TEXT,                                   -- 主条码
  spec TEXT,
  color TEXT,
  base_unit_id TEXT,                              -- 基本计量单位（库存一律以此单位记录）
  weight REAL,
  weight_unit TEXT,
  manufacturer TEXT,                              -- 生产厂商
  default_warehouse_id TEXT,
  default_location_id TEXT,
  purchase_price REAL DEFAULT 0,                  -- 预设进价
  sale_price REAL DEFAULT 0,                      -- 预设售价
  cost_price REAL DEFAULT 0,                      -- 成本价（随流水更新）
  init_qty REAL DEFAULT 0,                        -- 期初建账数量
  init_cost REAL DEFAULT 0,                       -- 期初初始成本
  min_stock REAL,
  max_stock REAL,                                 -- 预警阈值（可选）
  status INTEGER DEFAULT 1,                       -- 1=启用 0=停用
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_product_code ON product(code);

CREATE TABLE IF NOT EXISTS product_barcode (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  barcode TEXT NOT NULL,
  remark TEXT,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_barcode ON product_barcode(barcode);

CREATE TABLE IF NOT EXISTS warehouse (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  manager TEXT,
  status INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS location (
  id TEXT PRIMARY KEY,
  warehouse_id TEXT NOT NULL,
  parent_id TEXT,
  code TEXT,
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  status INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customer (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  address TEXT,
  price_level TEXT,          -- 默认售价等级
  credit_note TEXT,          -- 应收额度备注
  status INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS supplier (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT,
  address TEXT,
  settle_type TEXT,          -- 默认结算方式
  status INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS department (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manager TEXT,
  status INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,
  account TEXT UNIQUE,
  name TEXT NOT NULL,
  pwd_hash TEXT,
  role_id TEXT,
  status INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  remark TEXT,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_permission (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  perm_key TEXT NOT NULL,      -- 形如 "purchase.inbound.audit"（菜单/按钮级）
  allowed INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS code_rule (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,        -- product / customer / supplier / doc_no ...
  prefix TEXT,
  category_code TEXT,
  seq_len INTEGER DEFAULT 4,
  next_seq INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

------------------------------------------------------------------------
-- §5.2 库存（派生 + 流水）
------------------------------------------------------------------------

-- 库存流水（append-only，不可改删，只能红冲）
CREATE TABLE IF NOT EXISTS stock_ledger (
  id TEXT PRIMARY KEY,
  biz_type TEXT NOT NULL,      -- 期初/采购入库/销售出库/部门领用/生产入库/退货入库/退货出库/调拨/盘点/红冲
  doc_type TEXT,
  doc_id TEXT,
  doc_no TEXT,
  product_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  location_id TEXT,
  qty_in REAL DEFAULT 0,
  qty_out REAL DEFAULT 0,
  unit_cost REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  biz_date INTEGER NOT NULL,
  operator_id TEXT,
  reversal_of TEXT,            -- 红冲时指向被冲销的 ledger_id
  remark TEXT,
  -- [+ 同步字段 §4.2]（本表只 insert，不做 update）
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

-- 库存余额（物化派生表，由流水重算；不参与主数据 LWW，不含同步字段）
CREATE TABLE IF NOT EXISTS stock_balance (
  id TEXT PRIMARY KEY,         -- 建议 = product_id + ':' + warehouse_id + ':' + location_id
  product_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  location_id TEXT,
  qty REAL DEFAULT 0,          -- 实时库存
  locked_qty REAL DEFAULT 0,   -- 占用量
  avail_qty REAL DEFAULT 0,    -- 可用量
  cost_amount REAL DEFAULT 0,  -- 成本金额
  avg_cost REAL DEFAULT 0,     -- 移动加权平均单价
  recomputed_at INTEGER,
  recomputed_from_seq INTEGER
);

------------------------------------------------------------------------
-- §5.3 采购（入库链路）
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS purchase_order (
  id TEXT PRIMARY KEY,
  doc_no TEXT NOT NULL,
  supplier_id TEXT,
  warehouse_id TEXT,
  biz_date INTEGER,
  status INTEGER DEFAULT 0,    -- 0 待审核 1 已审核 9 已红冲
  handler_id TEXT,
  total_amount REAL DEFAULT 0,
  remark TEXT,
  reversal_of TEXT,            -- 红冲单指向被红冲的原单据 id
  audited_by TEXT,
  audited_at INTEGER,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_order_item (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT,
  qty REAL,
  price REAL,
  amount REAL,
  remark TEXT,
  -- [+ 单据明细计量字段 §5.0]
  unit_id TEXT,
  factor REAL DEFAULT 1,
  base_qty REAL,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_inbound (
  id TEXT PRIMARY KEY,
  doc_no TEXT NOT NULL,
  inbound_type TEXT NOT NULL,      -- 采购/部门领用/生产入库/退货入库
  supplier_id TEXT,
  warehouse_id TEXT,
  source_order_id TEXT,
  department_id TEXT,              -- 部门领用：领用部门
  receiver_id TEXT,                -- 部门领用：领用人
  use_purpose TEXT,                -- 部门领用：用途
  biz_date INTEGER,
  status INTEGER DEFAULT 0,
  handler_id TEXT,
  total_amount REAL DEFAULT 0,
  remark TEXT,
  reversal_of TEXT,            -- 红冲单指向被红冲的原单据 id
  audited_by TEXT,
  audited_at INTEGER,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_inbound_item (
  id TEXT PRIMARY KEY,
  inbound_id TEXT NOT NULL,
  product_id TEXT,
  location_id TEXT,
  unit_id TEXT,
  factor REAL DEFAULT 1,
  qty REAL,
  base_qty REAL,
  price REAL,
  amount REAL,
  cost_price REAL,
  remark TEXT,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

------------------------------------------------------------------------
-- §5.4 销售（出库链路）
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales_order (
  id TEXT PRIMARY KEY,
  doc_no TEXT NOT NULL,
  customer_id TEXT,
  warehouse_id TEXT,
  biz_date INTEGER,
  status INTEGER DEFAULT 0,
  handler_id TEXT,
  total_amount REAL DEFAULT 0,
  remark TEXT,
  reversal_of TEXT,            -- 红冲单指向被红冲的原单据 id
  audited_by TEXT,
  audited_at INTEGER,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales_order_item (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT,
  qty REAL,
  price REAL,
  amount REAL,
  remark TEXT,
  -- [+ 单据明细计量字段 §5.0]
  unit_id TEXT,
  factor REAL DEFAULT 1,
  base_qty REAL,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales_outbound (
  id TEXT PRIMARY KEY,
  doc_no TEXT NOT NULL,
  outbound_type TEXT NOT NULL,     -- 销售/退货出库
  customer_id TEXT,
  warehouse_id TEXT,
  source_order_id TEXT,
  biz_date INTEGER,
  status INTEGER DEFAULT 0,
  handler_id TEXT,
  total_amount REAL DEFAULT 0,
  remark TEXT,
  reversal_of TEXT,            -- 红冲单指向被红冲的原单据 id
  audited_by TEXT,
  audited_at INTEGER,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales_outbound_item (
  id TEXT PRIMARY KEY,
  outbound_id TEXT NOT NULL,
  product_id TEXT,
  location_id TEXT,
  unit_id TEXT,
  factor REAL DEFAULT 1,
  qty REAL,
  base_qty REAL,
  price REAL,
  amount REAL,
  cost_price REAL,             -- 成本快照（按基本单位）
  cost_amount REAL,            -- 成本金额快照（供发货成本表 / 毛利表）
  remark TEXT,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

------------------------------------------------------------------------
-- §5.5 调拨 / 盘点
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_transfer (
  id TEXT PRIMARY KEY,
  doc_no TEXT,
  from_warehouse_id TEXT,
  to_warehouse_id TEXT,
  biz_date INTEGER,
  status INTEGER DEFAULT 0,
  handler_id TEXT,
  remark TEXT,
  audited_by TEXT,
  audited_at INTEGER,
  reversal_of TEXT,            -- 红冲单指向被红冲的原单据 id
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_transfer_item (
  id TEXT PRIMARY KEY,
  transfer_id TEXT,
  product_id TEXT,
  from_location_id TEXT,
  to_location_id TEXT,
  qty REAL,
  -- [+ 单据明细计量字段 §5.0]
  unit_id TEXT,
  factor REAL DEFAULT 1,
  base_qty REAL,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_check (
  id TEXT PRIMARY KEY,
  doc_no TEXT,
  warehouse_id TEXT,
  biz_date INTEGER,
  status INTEGER DEFAULT 0,
  handler_id TEXT,
  remark TEXT,
  audited_by TEXT,
  audited_at INTEGER,
  reversal_of TEXT,            -- 红冲单指向被红冲的原单据 id
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_check_item (
  id TEXT PRIMARY KEY,
  check_id TEXT,
  product_id TEXT,
  location_id TEXT,
  book_qty REAL,
  real_qty REAL,
  diff_qty REAL,
  -- [+ 单据明细计量字段 §5.0]
  qty REAL,
  unit_id TEXT,
  factor REAL DEFAULT 1,
  base_qty REAL,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

------------------------------------------------------------------------
-- §5.6 财务（应收应付）
------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,                   -- 现金/银行/微信/支付宝
  balance REAL DEFAULT 0,
  status INTEGER DEFAULT 1,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ap_bill (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  source_inbound_id TEXT,
  amount REAL DEFAULT 0,
  paid_amount REAL DEFAULT 0,
  status INTEGER DEFAULT 0,
  due_date INTEGER,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ap_payment (
  id TEXT PRIMARY KEY,
  doc_no TEXT,
  supplier_id TEXT,
  account_id TEXT,
  amount REAL DEFAULT 0,
  pay_date INTEGER,
  method TEXT,
  remark TEXT,
  audited_by TEXT,
  audited_at INTEGER,
  status INTEGER DEFAULT 0,           -- 0 待审核 → 1 已审核 → 9 已红冲
  reversal_of TEXT,                   -- 红冲单指向原单
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ap_payment_apply (
  id TEXT PRIMARY KEY,
  payment_id TEXT,
  ap_bill_id TEXT,
  amount REAL,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ar_bill (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  source_outbound_id TEXT,
  amount REAL DEFAULT 0,
  received_amount REAL DEFAULT 0,
  status INTEGER DEFAULT 0,
  due_date INTEGER,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ar_receipt (
  id TEXT PRIMARY KEY,
  doc_no TEXT,
  customer_id TEXT,
  account_id TEXT,
  amount REAL DEFAULT 0,
  receive_date INTEGER,
  method TEXT,
  remark TEXT,
  audited_by TEXT,
  audited_at INTEGER,
  status INTEGER DEFAULT 0,           -- 0 待审核 → 1 已审核 → 9 已红冲
  reversal_of TEXT,                   -- 红冲单指向原单
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ar_receipt_apply (
  id TEXT PRIMARY KEY,
  receipt_id TEXT,
  ar_bill_id TEXT,
  amount REAL,
  -- [+ 同步字段 §4.2]
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT NOT NULL,
  hlc           TEXT NOT NULL,
  dirty_fields  TEXT,
  sync_state    INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0
);

------------------------------------------------------------------------
-- §5.7 系统 / 同步 / 审计（系统表，不含同步字段）
------------------------------------------------------------------------

-- 操作日志（同步的基石）
CREATE TABLE IF NOT EXISTS _change_log (
  log_id TEXT PRIMARY KEY,        -- ULID，幂等去重键
  seq INTEGER NOT NULL,           -- 本端自增序号
  device_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,               -- insert / update / delete
  payload TEXT,                   -- 变更后整行 JSON
  hlc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  pushed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_changelog_seq ON _change_log(seq);
CREATE INDEX IF NOT EXISTS ix_changelog_pushed ON _change_log(pushed);

-- 同步游标
CREATE TABLE IF NOT EXISTS _sync_cursor (
  peer_id TEXT PRIMARY KEY,       -- 'lan:<deviceId>' / 'cloud'
  last_pull_seq INTEGER DEFAULT 0,
  last_push_seq INTEGER DEFAULT 0,
  last_sync_at INTEGER,
  status TEXT
);

-- 冲突记录
CREATE TABLE IF NOT EXISTS _conflict (
  id TEXT PRIMARY KEY,
  entity TEXT,
  entity_id TEXT,
  field TEXT,
  value_a TEXT,
  value_b TEXT,
  hlc_a TEXT,
  hlc_b TEXT,
  winner TEXT,                    -- a / b / manual
  resolved_value TEXT,
  resolved_by TEXT,
  resolved_at INTEGER,
  status INTEGER DEFAULT 0        -- 0 待处理 1 已裁决
);

-- 操作审计
CREATE TABLE IF NOT EXISTS op_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT,
  entity TEXT,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  device_id TEXT,
  ip TEXT,
  at INTEGER
);

-- 系统配置
-- 关键配置：allow_negative_stock(0/1，默认 0) · backup_keep(默认 7) · theme · auto_launch · lan_port(默认 8765)
CREATE TABLE IF NOT EXISTS sys_config (
  id TEXT PRIMARY KEY,
  cfg_key TEXT UNIQUE,
  cfg_value TEXT
);

-- 备份记录
CREATE TABLE IF NOT EXISTS backup_record (
  id TEXT PRIMARY KEY,
  file_path TEXT,
  size INTEGER,
  kind TEXT,
  at INTEGER,
  remark TEXT
);
