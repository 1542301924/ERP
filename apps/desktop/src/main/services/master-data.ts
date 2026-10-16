/**
 * 主数据服务（P1「主数据」）。
 *
 * 本模块**不依赖 electron**，只依赖 `SqlDatabase` / `Repository`，便于单元测试。
 * 所有 SQL 均使用参数化查询；任何拼入 SQL 的标识符（表名 / 列名）都先经白名单校验。
 */

import { newId, type Row } from '@inventory/shared';
import { SYNC_ENTITIES, type Repository } from '../db/repository';
import type { SqlDatabase } from '../db/sqlite';

/** 物料化路径根前缀。 */
const ROOT_PATH = '/root/';

/** 分类树节点。 */
export type CategoryNode = Row & { children: CategoryNode[] };

/** 通用查询条件。 */
export interface SearchQuery {
  keyword?: string;
  fields?: string[];
  equals?: Record<string, string | number | null>;
  limit?: number;
  includeDeleted?: boolean;
}

/** 每个实体的默认关键字匹配字段。 */
const DEFAULT_KEYWORD_FIELDS: Record<string, string[]> = {
  product: ['code', 'name', 'barcode', 'spec'],
  customer: ['name', 'contact', 'phone'],
  supplier: ['name', 'contact', 'phone'],
  unit: ['name'],
  warehouse: ['name'],
  department: ['name'],
  location: ['code', 'name'],
  product_category: ['code', 'name'],
  product_barcode: ['barcode'],
  code_rule: ['target', 'prefix'],
};

/** 校验实体是否在安全白名单内（携带同步字段的业务表）。 */
function assertEntity(entity: string): void {
  if (!SYNC_ENTITIES.has(entity)) throw new Error(`未知实体: ${entity}`);
}

/** 读取某表的列名集合（使用 table-valued pragma，无需拼接用户输入）。 */
function tableColumns(db: SqlDatabase, entity: string): Set<string> {
  const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(entity);
  return new Set(rows.map((r) => r.name as string));
}

/** 按 id 取一行（不过滤 deleted）。 */
export function getById(db: SqlDatabase, entity: string, id: string): Row | null {
  assertEntity(entity);
  const row = db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(id);
  return row ?? null;
}

/** 通用条件查询（默认排除软删除行）。 */
export function search(db: SqlDatabase, entity: string, query: SearchQuery = {}): Row[] {
  assertEntity(entity);
  const columns = tableColumns(db, entity);
  const where: string[] = [];
  const params: unknown[] = [];

  if (!query.includeDeleted) where.push('deleted = 0');

  const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';
  if (keyword) {
    const fields = query.fields && query.fields.length > 0 ? query.fields : DEFAULT_KEYWORD_FIELDS[entity] ?? [];
    for (const field of fields) {
      if (!columns.has(field)) throw new Error(`查询字段不存在: ${field}`);
    }
    if (fields.length === 0) {
      where.push('1 = 0');
    } else {
      where.push(`(${fields.map((f) => `${f} LIKE ?`).join(' OR ')})`);
      for (let i = 0; i < fields.length; i++) params.push(`%${keyword}%`);
    }
  }

  if (query.equals) {
    for (const [key, value] of Object.entries(query.equals)) {
      if (!columns.has(key)) throw new Error(`查询字段不存在: ${key}`);
      if (value === null) {
        where.push(`${key} IS NULL`);
      } else {
        where.push(`${key} = ?`);
        params.push(value);
      }
    }
  }

  const limitSuffix = query.limit ? ` LIMIT ${Math.max(0, Math.floor(query.limit))}` : '';
  const sql = `SELECT * FROM ${entity}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${limitSuffix}`;
  return db.prepare(sql).all(...params) as Row[];
}

/** 商品详情：商品 + 单位（带 unit_name）+ 条码。 */
export function productDetail(
  db: SqlDatabase,
  id: string,
): { product: Row; units: Row[]; barcodes: Row[] } | null {
  const product = db.prepare('SELECT * FROM product WHERE id = ? AND deleted = 0').get(id);
  if (!product) return null;
  const units = db
    .prepare(
      'SELECT pu.*, u.name AS unit_name FROM product_unit pu ' +
        'LEFT JOIN unit u ON u.id = pu.unit_id ' +
        'WHERE pu.product_id = ? AND pu.deleted = 0 ' +
        'ORDER BY pu.is_base DESC, pu.factor',
    )
    .all(id);
  const barcodes = db.prepare('SELECT * FROM product_barcode WHERE product_id = ? AND deleted = 0').all(id);
  return { product, units, barcodes };
}

/** 条码查询：product.barcode -> product_unit.barcode -> product_barcode.barcode。 */
export function lookupBarcode(
  db: SqlDatabase,
  barcode: string,
): { product: Row; matchedBy: 'product' | 'product_unit' | 'product_barcode'; unit?: Row } | null {
  if (!barcode) return null;

  const product = db.prepare('SELECT * FROM product WHERE barcode = ? AND deleted = 0 LIMIT 1').get(barcode);
  if (product) return { product, matchedBy: 'product' };

  const unitRow = db.prepare('SELECT * FROM product_unit WHERE barcode = ? AND deleted = 0 LIMIT 1').get(barcode);
  if (unitRow) {
    const owner = db.prepare('SELECT * FROM product WHERE id = ? AND deleted = 0').get(unitRow.product_id);
    if (owner) return { product: owner, matchedBy: 'product_unit', unit: unitRow };
  }

  const barcodeRow = db
    .prepare('SELECT * FROM product_barcode WHERE barcode = ? AND deleted = 0 LIMIT 1')
    .get(barcode);
  if (barcodeRow) {
    const owner = db.prepare('SELECT * FROM product WHERE id = ? AND deleted = 0').get(barcodeRow.product_id);
    if (owner) return { product: owner, matchedBy: 'product_barcode' };
  }

  return null;
}

/** 保存商品单位：按 (product_id, unit_id) upsert；is_base=1 时同步商品基本单位。 */
export function saveProductUnit(
  db: SqlDatabase,
  repo: Repository,
  input: {
    id?: string;
    product_id: string;
    unit_id: string;
    factor: number;
    is_base?: number;
    barcode?: string | null;
    purchase_price?: number | null;
    sale_price?: number | null;
  },
): Row {
  const values: Row = {
    product_id: input.product_id,
    unit_id: input.unit_id,
    factor: input.factor,
    is_base: input.is_base ?? 0,
    barcode: input.barcode ?? null,
    purchase_price: input.purchase_price ?? null,
    sale_price: input.sale_price ?? null,
  };

  const existing = db
    .prepare('SELECT * FROM product_unit WHERE product_id = ? AND unit_id = ? AND deleted = 0')
    .get(input.product_id, input.unit_id);

  const row = existing
    ? repo.update('product_unit', existing.id as string, values)
    : repo.insert('product_unit', values, input.id);

  if (Number(input.is_base) === 1) {
    repo.update('product', input.product_id, { base_unit_id: input.unit_id });
  }
  return row;
}

/** 删除商品单位。 */
export function deleteProductUnit(repo: Repository, id: string): Row {
  return repo.softDelete('product_unit', id);
}

/** 分类树（默认仅启用状态；按 sort、name 排序）。 */
export function categoryTree(db: SqlDatabase, opts: { includeDisabled?: boolean } = {}): CategoryNode[] {
  const rows = db.prepare('SELECT * FROM product_category WHERE deleted = 0').all();
  const visible = opts.includeDisabled ? rows : rows.filter((r) => Number(r.status ?? 1) !== 0);

  const nodes = new Map<string, CategoryNode>();
  for (const r of visible) nodes.set(r.id as string, { ...r, children: [] });

  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.parent_id as string | null;
    if (parentId && nodes.has(parentId)) nodes.get(parentId)!.children.push(node);
    else roots.push(node);
  }

  const sortFn = (a: CategoryNode, b: CategoryNode): number => {
    const diff = Number(a.sort ?? 0) - Number(b.sort ?? 0);
    if (diff !== 0) return diff;
    return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-Hans-CN');
  };
  const sortRecursive = (list: CategoryNode[]): void => {
    list.sort(sortFn);
    for (const n of list) sortRecursive(n.children);
  };
  sortRecursive(roots);
  return roots;
}

/** 新增 / 更新分类，维护物料化路径；移动节点时级联重算后代路径。 */
export function saveCategory(
  db: SqlDatabase,
  repo: Repository,
  input: {
    id?: string;
    parent_id?: string | null;
    code?: string | null;
    name: string;
    sort?: number;
    status?: number;
  },
): Row {
  const parentId = input.parent_id ?? null;

  if (input.id) {
    const current = repo.findById('product_category', input.id);
    if (!current || Number(current.deleted) === 1) throw new Error('分类不存在');

    if (parentId) {
      if (parentId === input.id) throw new Error('不能将分类的上级设为自己');
      const parent = repo.findById('product_category', parentId);
      if (!parent || Number(parent.deleted) === 1) throw new Error('上级分类不存在');
      const currentPath = String(current.path ?? '');
      if (currentPath && String(parent.path ?? '').startsWith(currentPath)) {
        throw new Error('不能将分类移动到其子分类之下');
      }
    }

    const oldPath = String(current.path ?? '');
    const newPath = parentId
      ? `${String(repo.findById('product_category', parentId)!.path ?? ROOT_PATH)}${input.id}/`
      : `${ROOT_PATH}${input.id}/`;

    const updated = repo.update('product_category', input.id, {
      parent_id: parentId,
      code: input.code ?? current.code ?? null,
      name: input.name,
      sort: input.sort ?? current.sort ?? 0,
      status: input.status ?? current.status ?? 1,
      path: newPath,
    });

    if (oldPath && oldPath !== newPath) {
      const descendants = db
        .prepare('SELECT * FROM product_category WHERE deleted = 0 AND path LIKE ? AND id <> ?')
        .all(`${oldPath}%`, input.id);
      for (const d of descendants) {
        const rest = String(d.path ?? '').slice(oldPath.length);
        repo.update('product_category', d.id as string, { path: `${newPath}${rest}` });
      }
    }
    return updated;
  }

  // 新增：需要先确定 id 才能计算 path，因此自行生成 id 并交给 Repository
  const id = newId();
  const parentPath = parentId ? String(repo.findById('product_category', parentId)?.path ?? ROOT_PATH) : ROOT_PATH;
  if (parentId) {
    const parent = repo.findById('product_category', parentId);
    if (!parent || Number(parent.deleted) === 1) throw new Error('上级分类不存在');
  }
  return repo.insert(
    'product_category',
    {
      parent_id: parentId,
      code: input.code ?? null,
      name: input.name,
      sort: input.sort ?? 0,
      status: input.status ?? 1,
      path: `${parentPath}${id}/`,
    },
    id,
  );
}

/** 删除分类：存在子分类或被商品引用时禁止。 */
export function deleteCategory(db: SqlDatabase, repo: Repository, id: string): Row {
  const child = db
    .prepare('SELECT COUNT(*) AS c FROM product_category WHERE parent_id = ? AND deleted = 0')
    .get(id);
  if (Number(child?.c ?? 0) > 0) throw new Error('该分类下存在子分类，无法删除');

  const ref = db.prepare('SELECT COUNT(*) AS c FROM product WHERE category_id = ? AND deleted = 0').get(id);
  if (Number(ref?.c ?? 0) > 0) throw new Error('该分类已被商品引用，无法删除');

  return repo.softDelete('product_category', id);
}
