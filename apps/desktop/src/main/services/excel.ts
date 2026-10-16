/**
 * Excel 模板 / 导入 / 导出服务（P1）。
 *
 * 不依赖 electron：只提供纯函数式能力（生成模板 Buffer、从 Buffer 导入、导出 Buffer），
 * 文件选择与落盘由 IPC 层负责。
 */

import ExcelJS from 'exceljs';
import type { Repository } from '../db/repository';
import type { SqlDatabase } from '../db/sqlite';

/** 导入结果。`row` 为物理 Excel 行号（表头为第 1 行，首行数据为第 2 行）。 */
export interface ImportResult {
  template: string;
  total: number;
  success: number;
  failed: number;
  errors: { row: number; message: string; data?: Record<string, unknown> }[];
}

/** 模板列定义。 */
interface TemplateColumn {
  header: string;
  key: string;
  sample: string | number | null;
}

/** 模板定义。 */
interface TemplateDef {
  id: string;
  name: string;
  importable: boolean;
  sheet: string;
  columns: TemplateColumn[];
}

/** 6 个模板注册表。 */
const TEMPLATES: TemplateDef[] = [
  {
    id: 'product',
    name: '商品档案',
    importable: true,
    sheet: '商品档案',
    columns: [
      { header: '商品编号*', key: 'code', sample: 'P0001' },
      { header: '商品名称*', key: 'name', sample: '示例商品' },
      { header: '类别编码', key: 'category_code', sample: '' },
      { header: '主条码', key: 'barcode', sample: '6900000000001' },
      { header: '规格', key: 'spec', sample: '' },
      { header: '颜色', key: 'color', sample: '' },
      { header: '基本单位*', key: 'base_unit', sample: '个' },
      { header: '预设进价', key: 'purchase_price', sample: 10 },
      { header: '预设售价', key: 'sale_price', sample: 15 },
      { header: '最低库存', key: 'min_stock', sample: 0 },
      { header: '最高库存', key: 'max_stock', sample: 100 },
      { header: '期初数量', key: 'init_qty', sample: 0 },
      { header: '期初成本', key: 'init_cost', sample: 0 },
      { header: '生产厂商', key: 'manufacturer', sample: '' },
      { header: '状态(1启用/0停用)', key: 'status', sample: 1 },
    ],
  },
  {
    id: 'customer',
    name: '客户档案',
    importable: true,
    sheet: '客户档案',
    columns: [
      { header: '客户名称*', key: 'name', sample: '示例客户' },
      { header: '联系人', key: 'contact', sample: '' },
      { header: '电话', key: 'phone', sample: '' },
      { header: '地址', key: 'address', sample: '' },
      { header: '售价等级', key: 'price_level', sample: '' },
      { header: '应收额度备注', key: 'credit_note', sample: '' },
      { header: '状态(1启用/0停用)', key: 'status', sample: 1 },
    ],
  },
  {
    id: 'supplier',
    name: '供应商档案',
    importable: true,
    sheet: '供应商档案',
    columns: [
      { header: '供应商名称*', key: 'name', sample: '示例供应商' },
      { header: '联系人', key: 'contact', sample: '' },
      { header: '电话', key: 'phone', sample: '' },
      { header: '地址', key: 'address', sample: '' },
      { header: '结算方式', key: 'settle_type', sample: '' },
      { header: '状态(1启用/0停用)', key: 'status', sample: 1 },
    ],
  },
  {
    id: 'init_stock',
    name: '期初库存',
    importable: true,
    sheet: '期初库存',
    columns: [
      { header: '商品编号*', key: 'code', sample: 'P0001' },
      { header: '商品名称', key: 'name', sample: '示例商品' },
      { header: '数量*', key: 'qty', sample: 0 },
      { header: '成本单价*', key: 'cost', sample: 0 },
    ],
  },
  {
    id: 'purchase_inbound',
    name: '采购入库单',
    importable: false,
    sheet: '采购入库单',
    columns: [
      { header: '单据编号*', key: 'doc_no', sample: '' },
      { header: '供应商编码', key: 'supplier_code', sample: '' },
      { header: '仓库编码', key: 'warehouse_code', sample: '' },
      { header: '业务日期', key: 'biz_date', sample: '' },
      { header: '商品编号*', key: 'product_code', sample: '' },
      { header: '数量*', key: 'qty', sample: '' },
      { header: '单价', key: 'price', sample: '' },
      { header: '金额', key: 'amount', sample: '' },
      { header: '备注', key: 'remark', sample: '' },
    ],
  },
  {
    id: 'sales_outbound',
    name: '销售出库单',
    importable: false,
    sheet: '销售出库单',
    columns: [
      { header: '单据编号*', key: 'doc_no', sample: '' },
      { header: '客户编码', key: 'customer_code', sample: '' },
      { header: '仓库编码', key: 'warehouse_code', sample: '' },
      { header: '业务日期', key: 'biz_date', sample: '' },
      { header: '商品编号*', key: 'product_code', sample: '' },
      { header: '数量*', key: 'qty', sample: '' },
      { header: '单价', key: 'price', sample: '' },
      { header: '金额', key: 'amount', sample: '' },
      { header: '备注', key: 'remark', sample: '' },
    ],
  },
];

/** 导出规格：实体 -> { 工作表名; [英文列, 中文表头][] }。 */
const EXPORT_SPECS: Record<string, { sheet: string; columns: Array<[string, string]> }> = {
  product: {
    sheet: '商品档案',
    columns: [
      ['code', '商品编号'],
      ['name', '商品名称'],
      ['barcode', '主条码'],
      ['spec', '规格'],
      ['color', '颜色'],
      ['purchase_price', '预设进价'],
      ['sale_price', '预设售价'],
      ['min_stock', '最低库存'],
      ['max_stock', '最高库存'],
      ['init_qty', '期初数量'],
      ['init_cost', '期初成本'],
      ['manufacturer', '生产厂商'],
      ['status', '状态'],
    ],
  },
  customer: {
    sheet: '客户档案',
    columns: [
      ['name', '客户名称'],
      ['contact', '联系人'],
      ['phone', '电话'],
      ['address', '地址'],
      ['price_level', '售价等级'],
      ['credit_note', '应收额度备注'],
      ['status', '状态'],
    ],
  },
  supplier: {
    sheet: '供应商档案',
    columns: [
      ['name', '供应商名称'],
      ['contact', '联系人'],
      ['phone', '电话'],
      ['address', '地址'],
      ['settle_type', '结算方式'],
      ['status', '状态'],
    ],
  },
  unit: {
    sheet: '计量单位',
    columns: [
      ['name', '名称'],
      ['sort', '排序'],
      ['status', '状态'],
    ],
  },
  warehouse: {
    sheet: '仓库',
    columns: [
      ['name', '仓库名称'],
      ['address', '地址'],
      ['manager', '负责人'],
      ['status', '状态'],
    ],
  },
  department: {
    sheet: '部门',
    columns: [
      ['name', '部门名称'],
      ['manager', '负责人'],
      ['status', '状态'],
    ],
  },
};

/** 列出模板注册表。 */
export function listTemplates(): { id: string; name: string; importable: boolean }[] {
  return TEMPLATES.map((t) => ({ id: t.id, name: t.name, importable: t.importable }));
}

function findTemplate(id: string): TemplateDef {
  const tpl = TEMPLATES.find((t) => t.id === id);
  if (!tpl) throw new Error(`未知模板: ${id}`);
  return tpl;
}

/** 生成模板工作簿 Buffer（表头 + 1 行示例数据 + 列宽）。 */
export async function buildTemplateBuffer(id: string): Promise<Buffer> {
  const tpl = findTemplate(id);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(tpl.sheet);
  ws.addRow(tpl.columns.map((c) => c.header));
  ws.addRow(tpl.columns.map((c) => c.sample));
  tpl.columns.forEach((c, i) => {
    const width = Math.max(12, Math.min(24, c.header.replace(/\(.*/, '').length * 2 + 4));
    ws.getColumn(i + 1).width = width;
  });
  ws.getRow(1).font = { bold: true };
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** 导出实体数据 Buffer（中文表头，排除已软删除行）。 */
export async function buildExportBuffer(db: SqlDatabase, entity: string): Promise<Buffer> {
  const spec = EXPORT_SPECS[entity];
  if (!spec) throw new Error(`不支持的导出实体: ${entity}`);
  const rows = db.prepare(`SELECT * FROM ${entity} WHERE deleted = 0`).all();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(spec.sheet);
  ws.addRow(spec.columns.map(([, zh]) => zh));
  for (const r of rows) ws.addRow(spec.columns.map(([en]) => (r[en] as string | number | null) ?? null));
  spec.columns.forEach((_, i) => {
    ws.getColumn(i + 1).width = 16;
  });
  ws.getRow(1).font = { bold: true };
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

// ---------------- 单元格归一化 ----------------

/** exceljs 单元格取值可能是富文本等对象；统一归一化为 string | number | null。 */
function normalizeCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? null : t;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) {
    const s = value
      .map((v) => normalizeCell(v))
      .filter((v) => v !== null)
      .map((v) => String(v))
      .join('');
    return s === '' ? null : s;
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      const s = o.richText
        .map((p) => (p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : ''))
        .join('');
      return s === '' ? null : s.trim();
    }
    if ('result' in o) return normalizeCell(o.result);
    if ('text' in o) return normalizeCell(o.text);
    if ('hyperlink' in o) return normalizeCell(o.text ?? o.hyperlink);
    if ('error' in o) return String(o.error);
  }
  return null;
}

/** 表头归一化：去掉所有空白并去掉尾部 `*`。 */
function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, '').replace(/\*+$/, '');
}

function asText(value: string | number | null): string {
  return value === null ? '' : String(value).trim();
}

function num(value: string | number | null, fallback: number | null): number | null {
  if (value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new Error(`数值格式不正确: ${String(value)}`);
  return n;
}

function requiredNum(value: string | number | null, label: string): number {
  if (value === null) throw new Error(`${label}不能为空`);
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new Error(`${label}格式不正确: ${String(value)}`);
  return n;
}

interface DataRow {
  rowNumber: number;
  data: Record<string, string | number | null>;
}

/** 从工作簿读出数据行（跳过表头，按模板列映射）。 */
function readDataRows(ws: ExcelJS.Worksheet, tpl: TemplateDef): DataRow[] {
  const headerMap = new Map<string, number>();
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = normalizeHeader(asText(normalizeCell(cell.value)));
    if (key) headerMap.set(key, colNumber);
  });

  const rows: DataRow[] = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const data: Record<string, string | number | null> = {};
    for (const col of tpl.columns) {
      const idx = headerMap.get(normalizeHeader(col.header));
      data[col.key] = idx ? normalizeCell(row.getCell(idx).value) : null;
    }
    rows.push({ rowNumber, data });
  });
  return rows;
}

/** 从 Buffer 导入指定模板。 */
export async function importFromBuffer(
  db: SqlDatabase,
  repo: Repository,
  templateId: string,
  buffer: Buffer,
): Promise<ImportResult> {
  const tpl = findTemplate(templateId);
  if (!tpl.importable) throw new Error('导入将在 P2 开放，当前仅支持模板下载');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Excel 文件为空');

  const rows = readDataRows(ws, tpl);
  const result: ImportResult = { template: templateId, total: rows.length, success: 0, failed: 0, errors: [] };

  const handlers: Record<string, (data: DataRow['data'], rowNumber: number) => void> = {
    product: (data) => importProductRow(db, repo, data),
    init_stock: (data) => importInitStockRow(db, repo, data),
    customer: (data) => importSimpleRow(repo, 'customer', data),
    supplier: (data) => importSimpleRow(repo, 'supplier', data),
  };

  // 商品档案：预扫描整表，标记「文件内重复的商品编号」
  const duplicateCodes = new Set<string>();
  if (templateId === 'product') {
    const counts = new Map<string, number>();
    for (const { data } of rows) {
      const code = asText(data.code);
      if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    for (const [code, count] of counts) if (count > 1) duplicateCodes.add(code);
  }

  const handler = handlers[templateId];
  if (!handler) throw new Error(`模板暂不支持导入: ${templateId}`);

  for (const { rowNumber, data } of rows) {
    try {
      if (templateId === 'product' && duplicateCodes.has(asText(data.code))) {
        throw new Error(`商品编号在文件内重复: ${asText(data.code)}`);
      }
      handler(data, rowNumber);
      result.success += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        row: rowNumber,
        message: err instanceof Error ? err.message : String(err),
        data,
      });
    }
  }
  return result;
}

function importProductRow(db: SqlDatabase, repo: Repository, data: DataRow['data']): void {
  const code = asText(data.code);
  if (!code) throw new Error('商品编号不能为空');
  const name = asText(data.name);
  if (!name) throw new Error('商品名称不能为空');

  const baseUnitName = asText(data.base_unit);
  if (!baseUnitName) throw new Error('基本单位不能为空');
  const unit = db.prepare('SELECT * FROM unit WHERE name = ? AND deleted = 0').get(baseUnitName);
  if (!unit) throw new Error(`基本单位不存在: ${baseUnitName}`);

  let categoryId: string | null = null;
  const categoryCode = asText(data.category_code);
  if (categoryCode) {
    const cat = db.prepare('SELECT * FROM product_category WHERE code = ? AND deleted = 0').get(categoryCode);
    if (!cat) throw new Error(`类别编码不存在: ${categoryCode}`);
    categoryId = cat.id as string;
  }

  const purchasePrice = num(data.purchase_price, 0) as number;
  const salePrice = num(data.sale_price, 0) as number;
  const minStock = num(data.min_stock, null);
  const maxStock = num(data.max_stock, null);
  const initQty = num(data.init_qty, 0) as number;
  const initCost = num(data.init_cost, 0) as number;
  const status = num(data.status, 1) as number;

  const exists = db.prepare('SELECT 1 AS x FROM product WHERE code = ? AND deleted = 0').get(code);
  if (exists) throw new Error(`商品编号已存在: ${code}`);

  const product = repo.insert('product', {
    category_id: categoryId,
    code,
    name,
    barcode: asText(data.barcode) || null,
    spec: asText(data.spec) || null,
    color: asText(data.color) || null,
    base_unit_id: unit.id as string,
    manufacturer: asText(data.manufacturer) || null,
    purchase_price: purchasePrice,
    sale_price: salePrice,
    cost_price: purchasePrice,
    init_qty: initQty,
    init_cost: initCost,
    min_stock: minStock,
    max_stock: maxStock,
    status,
  });

  repo.insert('product_unit', {
    product_id: product.id as string,
    unit_id: unit.id as string,
    factor: 1,
    is_base: 1,
    barcode: null,
    purchase_price: null,
    sale_price: null,
  });
}

function importInitStockRow(db: SqlDatabase, repo: Repository, data: DataRow['data']): void {
  const code = asText(data.code);
  if (!code) throw new Error('商品编号不能为空');
  const qty = requiredNum(data.qty, '数量');
  const cost = requiredNum(data.cost, '成本单价');

  const product = db.prepare('SELECT * FROM product WHERE code = ? AND deleted = 0').get(code);
  if (!product) throw new Error(`商品编号不存在: ${code}`);

  repo.update('product', product.id as string, { init_qty: qty, init_cost: cost });
}

function importSimpleRow(repo: Repository, entity: 'customer' | 'supplier', data: DataRow['data']): void {
  const name = asText(data.name);
  if (!name) throw new Error(`${entity === 'customer' ? '客户' : '供应商'}名称不能为空`);
  const status = num(data.status, 1) as number;
  if (entity === 'customer') {
    repo.insert('customer', {
      name,
      contact: asText(data.contact) || null,
      phone: asText(data.phone) || null,
      address: asText(data.address) || null,
      price_level: asText(data.price_level) || null,
      credit_note: asText(data.credit_note) || null,
      status,
    });
  } else {
    repo.insert('supplier', {
      name,
      contact: asText(data.contact) || null,
      phone: asText(data.phone) || null,
      address: asText(data.address) || null,
      settle_type: asText(data.settle_type) || null,
      status,
    });
  }
}
