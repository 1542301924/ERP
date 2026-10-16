/**
 * 与设计文档 §5 表结构一一对应的 TS 实体类型（含 §4.2 同步字段）。
 * 供桌面端（SQLite）与云端（CloudBase 云函数）共用。
 */

/** §4.2 所有业务表统一携带的同步字段。 */
export interface SyncFields {
  id: string;
  created_by: string;
  created_at: number;
  updated_by: string | null;
  updated_at: number | null;
  version: number;
  origin_device: string;
  hlc: string;
  dirty_fields: string | null;
  sync_state: number;
  deleted: number;
}

/** §5.0 单据表统一的审核字段。 */
export interface AuditFields {
  audited_by: string | null;
  audited_at: number | null;
}

/** §5.0 单据明细表统一的计量字段。 */
export interface UomFields {
  unit_id: string | null;
  factor: number;
  base_qty: number | null;
}

// ---------------- §5.1 基础资料 ----------------

export interface Unit extends SyncFields {
  name: string;
  sort: number;
  status: number;
}

export interface ProductUnit extends SyncFields {
  product_id: string;
  unit_id: string;
  factor: number;
  is_base: number;
  barcode: string | null;
  purchase_price: number | null;
  sale_price: number | null;
}

export interface ProductCategory extends SyncFields {
  parent_id: string | null;
  code: string | null;
  name: string;
  path: string | null;
  sort: number;
  status: number;
}

export interface Product extends SyncFields {
  category_id: string | null;
  code: string;
  name: string;
  barcode: string | null;
  spec: string | null;
  color: string | null;
  base_unit_id: string | null;
  weight: number | null;
  weight_unit: string | null;
  manufacturer: string | null;
  default_warehouse_id: string | null;
  default_location_id: string | null;
  purchase_price: number;
  sale_price: number;
  cost_price: number;
  init_qty: number;
  init_cost: number;
  min_stock: number | null;
  max_stock: number | null;
  status: number;
}

export interface ProductBarcode extends SyncFields {
  product_id: string;
  barcode: string;
  remark: string | null;
}

export interface Warehouse extends SyncFields {
  name: string;
  address: string | null;
  manager: string | null;
  status: number;
}

export interface Location extends SyncFields {
  warehouse_id: string;
  parent_id: string | null;
  code: string | null;
  name: string;
  sort: number;
  status: number;
}

export interface Customer extends SyncFields {
  name: string;
  contact: string | null;
  phone: string | null;
  address: string | null;
  price_level: string | null;
  credit_note: string | null;
  status: number;
}

export interface Supplier extends SyncFields {
  name: string;
  contact: string | null;
  phone: string | null;
  address: string | null;
  settle_type: string | null;
  status: number;
}

export interface Department extends SyncFields {
  name: string;
  manager: string | null;
  status: number;
}

export interface AppUser extends SyncFields {
  account: string | null;
  name: string;
  pwd_hash: string | null;
  role_id: string | null;
  status: number;
}

export interface Role extends SyncFields {
  name: string;
  remark: string | null;
}

export interface RolePermission extends SyncFields {
  role_id: string;
  perm_key: string;
  allowed: number;
}

export interface CodeRule extends SyncFields {
  target: string;
  prefix: string | null;
  category_code: string | null;
  seq_len: number;
  next_seq: number;
}

// ---------------- §5.2 库存 ----------------

export interface StockLedger extends SyncFields {
  biz_type: string;
  doc_type: string | null;
  doc_id: string | null;
  doc_no: string | null;
  product_id: string;
  warehouse_id: string;
  location_id: string | null;
  qty_in: number;
  qty_out: number;
  unit_cost: number;
  amount: number;
  biz_date: number;
  operator_id: string | null;
  reversal_of: string | null;
  remark: string | null;
}

/** 派生表：由 stock_ledger 本地重算，不携带同步字段、不参与 apply。 */
export interface StockBalance {
  id: string;
  product_id: string;
  warehouse_id: string;
  location_id: string | null;
  qty: number;
  locked_qty: number;
  avail_qty: number;
  cost_amount: number;
  avg_cost: number;
  recomputed_at: number | null;
  recomputed_from_seq: number | null;
}

// ---------------- §5.3 采购 ----------------

export interface PurchaseOrder extends SyncFields, AuditFields {
  doc_no: string;
  supplier_id: string | null;
  warehouse_id: string | null;
  biz_date: number | null;
  status: number;
  handler_id: string | null;
  total_amount: number;
  remark: string | null;
}

export interface PurchaseOrderItem extends SyncFields, UomFields {
  order_id: string;
  product_id: string | null;
  qty: number | null;
  price: number | null;
  amount: number | null;
  remark: string | null;
}

export interface PurchaseInbound extends SyncFields, AuditFields {
  doc_no: string;
  inbound_type: string;
  supplier_id: string | null;
  warehouse_id: string | null;
  source_order_id: string | null;
  department_id: string | null;
  receiver_id: string | null;
  use_purpose: string | null;
  biz_date: number | null;
  status: number;
  handler_id: string | null;
  total_amount: number;
  remark: string | null;
}

export interface PurchaseInboundItem extends SyncFields {
  inbound_id: string;
  product_id: string | null;
  location_id: string | null;
  unit_id: string | null;
  factor: number;
  qty: number | null;
  base_qty: number | null;
  price: number | null;
  amount: number | null;
  cost_price: number | null;
  remark: string | null;
}

// ---------------- §5.4 销售 ----------------

export interface SalesOrder extends SyncFields, AuditFields {
  doc_no: string;
  customer_id: string | null;
  warehouse_id: string | null;
  biz_date: number | null;
  status: number;
  handler_id: string | null;
  total_amount: number;
  remark: string | null;
}

export interface SalesOrderItem extends SyncFields, UomFields {
  order_id: string;
  product_id: string | null;
  qty: number | null;
  price: number | null;
  amount: number | null;
  remark: string | null;
}

export interface SalesOutbound extends SyncFields, AuditFields {
  doc_no: string;
  outbound_type: string;
  customer_id: string | null;
  warehouse_id: string | null;
  source_order_id: string | null;
  biz_date: number | null;
  status: number;
  handler_id: string | null;
  total_amount: number;
  remark: string | null;
}

export interface SalesOutboundItem extends SyncFields {
  outbound_id: string;
  product_id: string | null;
  location_id: string | null;
  unit_id: string | null;
  factor: number;
  qty: number | null;
  base_qty: number | null;
  price: number | null;
  amount: number | null;
  cost_price: number | null;
  cost_amount: number | null;
  remark: string | null;
}

// ---------------- §5.5 调拨 / 盘点 ----------------

export interface StockTransfer extends SyncFields, AuditFields {
  doc_no: string | null;
  from_warehouse_id: string | null;
  to_warehouse_id: string | null;
  biz_date: number | null;
  status: number;
  handler_id: string | null;
  remark: string | null;
}

export interface StockTransferItem extends SyncFields, UomFields {
  transfer_id: string | null;
  product_id: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
  qty: number | null;
}

export interface StockCheck extends SyncFields, AuditFields {
  doc_no: string | null;
  warehouse_id: string | null;
  biz_date: number | null;
  status: number;
  handler_id: string | null;
  remark: string | null;
}

export interface StockCheckItem extends SyncFields, UomFields {
  check_id: string | null;
  product_id: string | null;
  location_id: string | null;
  book_qty: number | null;
  real_qty: number | null;
  diff_qty: number | null;
}

// ---------------- §5.6 财务 ----------------

export interface Account extends SyncFields {
  name: string;
  type: string | null;
  balance: number;
  status: number;
}

export interface ApBill extends SyncFields {
  supplier_id: string;
  source_inbound_id: string | null;
  amount: number;
  paid_amount: number;
  status: number;
  due_date: number | null;
}

export interface ApPayment extends SyncFields, AuditFields {
  doc_no: string | null;
  supplier_id: string | null;
  account_id: string | null;
  amount: number;
  pay_date: number | null;
  method: string | null;
  remark: string | null;
}

export interface ApPaymentApply extends SyncFields {
  payment_id: string | null;
  ap_bill_id: string | null;
  amount: number | null;
}

export interface ArBill extends SyncFields {
  customer_id: string;
  source_outbound_id: string | null;
  amount: number;
  received_amount: number;
  status: number;
  due_date: number | null;
}

export interface ArReceipt extends SyncFields, AuditFields {
  doc_no: string | null;
  customer_id: string | null;
  account_id: string | null;
  amount: number;
  receive_date: number | null;
  method: string | null;
  remark: string | null;
}

export interface ArReceiptApply extends SyncFields {
  receipt_id: string | null;
  ar_bill_id: string | null;
  amount: number | null;
}

// ---------------- §5.7 系统 / 同步 / 审计（无同步字段） ----------------

export interface ChangeLog {
  log_id: string;
  seq: number;
  device_id: string;
  entity: string;
  entity_id: string;
  op: string;
  payload: string | null;
  hlc: string;
  created_at: number;
  pushed: number;
}

export interface SyncCursor {
  peer_id: string;
  last_pull_seq: number;
  last_push_seq: number;
  last_sync_at: number | null;
  status: string | null;
}

export interface ConflictRecord {
  id: string;
  entity: string | null;
  entity_id: string | null;
  field: string | null;
  value_a: string | null;
  value_b: string | null;
  hlc_a: string | null;
  hlc_b: string | null;
  winner: string | null;
  resolved_value: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  status: number;
}

export interface OpLog {
  id: string;
  user_id: string | null;
  action: string | null;
  entity: string | null;
  entity_id: string | null;
  before_json: string | null;
  after_json: string | null;
  device_id: string | null;
  ip: string | null;
  at: number | null;
}

export interface SysConfig {
  id: string;
  cfg_key: string;
  cfg_value: string | null;
}

export interface BackupRecord {
  id: string;
  file_path: string | null;
  size: number | null;
  kind: string | null;
  at: number | null;
  remark: string | null;
}
