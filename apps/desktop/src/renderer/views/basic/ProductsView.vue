<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { api, useCrud } from '../../composables/useCrud';

/** 商品（product 表）可编辑字段。 */
interface ProductRow {
  id: string;
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

interface UnitRow {
  id: string;
  name: string;
}

interface WarehouseRow {
  id: string;
  name: string;
}

interface LocationRow {
  id: string;
  name: string;
  warehouse_id: string;
}

interface CategoryNode {
  id: string;
  name: string;
  parent_id: string | null;
  children: CategoryNode[];
}

/** 多单位子表行（product_unit）。 */
interface ProductUnitForm {
  id?: string;
  unit_id: string;
  factor: number;
  is_base: number;
  barcode: string;
  purchase_price: number | null;
  sale_price: number | null;
}

/** 条码子表行（product_barcode）。 */
interface ProductBarcodeForm {
  id?: string;
  barcode: string;
  remark: string;
}

interface ScanResult {
  product: Record<string, unknown>;
  matchedBy: 'product' | 'product_unit' | 'product_barcode';
  unit?: Record<string, unknown>;
}

const { rows, loading, save } = useCrud<ProductRow>('product');

const searchForm = reactive<{
  keyword: string;
  category_id: string;
  status: number | '';
}>({ keyword: '', category_id: '', status: '' });

const categories = ref<CategoryNode[]>([]);
const units = ref<UnitRow[]>([]);
const warehouses = ref<WarehouseRow[]>([]);
const locations = ref<LocationRow[]>([]);

const dialogVisible = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<ProductRow>(emptyProduct());

const unitRows = ref<ProductUnitForm[]>([]);
const barcodeRows = ref<ProductBarcodeForm[]>([]);
const originalUnitIds = ref<string[]>([]);
const originalBarcodeIds = ref<string[]>([]);

const drawerVisible = ref(false);
const previewProduct = ref<ProductRow | null>(null);
const stockLoading = ref(false);
const stockRows = ref<Record<string, unknown>[]>([]);
const ledgerRows = ref<Record<string, unknown>[]>([]);

const scanCode = ref('');
const scanning = ref(false);
const scanResult = ref<ScanResult | null>(null);

const rules: FormRules = {
  code: [{ required: true, message: '请输入商品编号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入商品名称', trigger: 'blur' }],
  base_unit_id: [{ required: true, message: '请选择基本单位', trigger: 'change' }],
};

const matchedByLabel: Record<ScanResult['matchedBy'], string> = {
  product: '商品主条码',
  product_unit: '单位条码',
  product_barcode: '附属条码',
};

function emptyProduct(): ProductRow {
  return {
    id: '',
    category_id: null,
    code: '',
    name: '',
    barcode: null,
    spec: null,
    color: null,
    base_unit_id: null,
    weight: null,
    weight_unit: 'kg',
    manufacturer: null,
    default_warehouse_id: null,
    default_location_id: null,
    purchase_price: 0,
    sale_price: 0,
    cost_price: 0,
    init_qty: 0,
    init_cost: 0,
    min_stock: null,
    max_stock: null,
    status: 1,
  };
}

function pickProduct(p: Record<string, unknown>): ProductRow {
  const text = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
  const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
  return {
    id: String(p.id ?? ''),
    category_id: text(p.category_id),
    code: String(p.code ?? ''),
    name: String(p.name ?? ''),
    barcode: text(p.barcode),
    spec: text(p.spec),
    color: text(p.color),
    base_unit_id: text(p.base_unit_id),
    weight: num(p.weight),
    weight_unit: text(p.weight_unit),
    manufacturer: text(p.manufacturer),
    default_warehouse_id: text(p.default_warehouse_id),
    default_location_id: text(p.default_location_id),
    purchase_price: Number(p.purchase_price ?? 0),
    sale_price: Number(p.sale_price ?? 0),
    cost_price: Number(p.cost_price ?? 0),
    init_qty: Number(p.init_qty ?? 0),
    init_cost: Number(p.init_cost ?? 0),
    min_stock: num(p.min_stock),
    max_stock: num(p.max_stock),
    status: Number(p.status ?? 1),
  };
}

/** 把类别树压平成下拉选项（带缩进）。 */
const categoryOptions = computed(() => {
  const acc: { id: string; label: string }[] = [];
  const walk = (nodes: CategoryNode[], depth: number): void => {
    for (const node of nodes) {
      acc.push({ id: node.id, label: `${'　'.repeat(depth)}${node.name}` });
      if (node.children?.length) walk(node.children, depth + 1);
    }
  };
  walk(categories.value, 0);
  return acc;
});

const categoryNameMap = computed(() => {
  const map = new Map<string, string>();
  const walk = (nodes: CategoryNode[]): void => {
    for (const node of nodes) {
      map.set(node.id, node.name);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(categories.value);
  return map;
});

const unitNameMap = computed(() => new Map(units.value.map((u) => [u.id, u.name])));
const warehouseNameMap = computed(() => new Map(warehouses.value.map((w) => [w.id, w.name])));

function categoryName(id: unknown): string {
  return id ? categoryNameMap.value.get(String(id)) ?? '-' : '-';
}

function unitName(id: unknown): string {
  return id ? unitNameMap.value.get(String(id)) ?? '-' : '-';
}

function warehouseName(id: unknown): string {
  return id ? warehouseNameMap.value.get(String(id)) ?? String(id) : '-';
}

function formatDate(value: unknown): string {
  const n = Number(value);
  return n ? new Date(n).toLocaleString() : '-';
}

async function loadDicts(): Promise<void> {
  try {
    const a = api();
    const [cat, unitList, whs] = await Promise.all([
      a.categoryTree(),
      a.query('unit'),
      a.query('warehouse'),
    ]);
    categories.value = cat as unknown as CategoryNode[];
    units.value = unitList as unknown as UnitRow[];
    warehouses.value = whs as unknown as WarehouseRow[];
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function loadLocations(warehouseId: string | null): Promise<void> {
  if (!warehouseId) {
    locations.value = [];
    return;
  }
  try {
    locations.value = (await api().search('location', {
      equals: { warehouse_id: warehouseId },
    })) as unknown as LocationRow[];
  } catch (err) {
    locations.value = [];
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

/** 商品列表查询：关键字 / 类别 / 状态。 */
async function queryList(): Promise<void> {
  loading.value = true;
  try {
    const opts: {
      keyword?: string;
      fields?: string[];
      equals?: Record<string, string | number | null>;
      limit?: number;
    } = { limit: 500 };
    const key = searchForm.keyword.trim();
    if (key) {
      opts.keyword = key;
      opts.fields = ['code', 'name', 'barcode', 'spec'];
    }
    const equals: Record<string, string | number | null> = {};
    if (searchForm.category_id) equals.category_id = searchForm.category_id;
    if (typeof searchForm.status === 'number') equals.status = searchForm.status;
    if (Object.keys(equals).length) opts.equals = equals;
    rows.value = (await api().search('product', opts)) as unknown as ProductRow[];
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

function resetSearch(): void {
  searchForm.keyword = '';
  searchForm.category_id = '';
  searchForm.status = '';
  void queryList();
}

function openCreate(): void {
  Object.assign(form, emptyProduct());
  unitRows.value = [];
  barcodeRows.value = [];
  originalUnitIds.value = [];
  originalBarcodeIds.value = [];
  locations.value = [];
  dialogVisible.value = true;
}

async function openEdit(row: ProductRow): Promise<void> {
  try {
    const detail = await api().productDetail(row.id);
    if (!detail) {
      ElMessage.error('未找到商品详情');
      return;
    }
    Object.assign(form, pickProduct(detail.product));
    unitRows.value = (detail.units ?? []).map((u) => ({
      id: u.id ? String(u.id) : undefined,
      unit_id: String(u.unit_id ?? ''),
      factor: Number(u.factor ?? 1),
      is_base: Number(u.is_base ?? 0),
      barcode: u.barcode ? String(u.barcode) : '',
      purchase_price: u.purchase_price == null ? null : Number(u.purchase_price),
      sale_price: u.sale_price == null ? null : Number(u.sale_price),
    }));
    barcodeRows.value = (detail.barcodes ?? []).map((b) => ({
      id: b.id ? String(b.id) : undefined,
      barcode: String(b.barcode ?? ''),
      remark: b.remark ? String(b.remark) : '',
    }));
    originalUnitIds.value = unitRows.value.filter((r) => r.id).map((r) => r.id as string);
    originalBarcodeIds.value = barcodeRows.value.filter((r) => r.id).map((r) => r.id as string);
    await loadLocations(form.default_warehouse_id);
    dialogVisible.value = true;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function genCode(): Promise<void> {
  try {
    form.code = await api().nextCode('product');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function onWarehouseChange(): Promise<void> {
  form.default_location_id = null;
  await loadLocations(form.default_warehouse_id);
}

function addUnitRow(): void {
  unitRows.value.push({ unit_id: '', factor: 1, is_base: 0, barcode: '', purchase_price: null, sale_price: null });
}

function removeUnitRow(index: number): void {
  unitRows.value.splice(index, 1);
}

function addBarcodeRow(): void {
  barcodeRows.value.push({ barcode: '', remark: '' });
}

function removeBarcodeRow(index: number): void {
  barcodeRows.value.splice(index, 1);
}

/** 若设置了基本单位，则确保子表中存在对应单位行。 */
function ensureBaseUnitRow(): void {
  const baseId = form.base_unit_id;
  if (!baseId) return;
  if (!unitRows.value.some((r) => r.unit_id === baseId)) {
    unitRows.value.push({ unit_id: baseId, factor: 1, is_base: 1, barcode: '', purchase_price: null, sale_price: null });
  }
}

async function reconcileUnits(productId: string): Promise<void> {
  const a = api();
  const currentIds = new Set(unitRows.value.filter((r) => r.id).map((r) => r.id as string));
  for (const id of originalUnitIds.value) {
    if (!currentIds.has(id)) await a.deleteProductUnit(id);
  }
  for (const r of unitRows.value) {
    if (!r.unit_id) continue;
    const isBase = form.base_unit_id
      ? r.unit_id === form.base_unit_id
        ? 1
        : 0
      : r.is_base
        ? 1
        : 0;
    await a.saveProductUnit({
      id: r.id || undefined,
      product_id: productId,
      unit_id: r.unit_id,
      factor: Number(r.factor) || 1,
      is_base: isBase,
      barcode: r.barcode.trim() || null,
      purchase_price: r.purchase_price ?? null,
      sale_price: r.sale_price ?? null,
    });
  }
}

async function reconcileBarcodes(productId: string): Promise<void> {
  const a = api();
  const currentIds = new Set(barcodeRows.value.filter((r) => r.id).map((r) => r.id as string));
  for (const id of originalBarcodeIds.value) {
    if (!currentIds.has(id)) await a.mutate({ op: 'delete', entity: 'product_barcode', id });
  }
  for (const r of barcodeRows.value) {
    const barcode = r.barcode.trim();
    if (!barcode) continue;
    const remark = r.remark.trim() || null;
    if (r.id) {
      await a.mutate({ op: 'update', entity: 'product_barcode', id: r.id, patch: { barcode, remark } });
    } else {
      await a.mutate({
        op: 'insert',
        entity: 'product_barcode',
        values: { product_id: productId, barcode, remark },
      });
    }
  }
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (valid === false) return;
  saving.value = true;
  try {
    const payload = {
      category_id: form.category_id || null,
      code: form.code.trim(),
      name: form.name.trim(),
      barcode: form.barcode?.trim() || null,
      spec: form.spec?.trim() || null,
      color: form.color?.trim() || null,
      base_unit_id: form.base_unit_id || null,
      weight: form.weight ?? null,
      weight_unit: form.weight_unit?.trim() || null,
      manufacturer: form.manufacturer?.trim() || null,
      default_warehouse_id: form.default_warehouse_id || null,
      default_location_id: form.default_location_id || null,
      purchase_price: Number(form.purchase_price) || 0,
      sale_price: Number(form.sale_price) || 0,
      cost_price: Number(form.cost_price) || 0,
      init_qty: Number(form.init_qty) || 0,
      init_cost: Number(form.init_cost) || 0,
      min_stock: form.min_stock ?? null,
      max_stock: form.max_stock ?? null,
      status: form.status,
    };
    const saved = await save({ ...payload, id: form.id || undefined });
    const productId = String(saved.id ?? form.id);
    ensureBaseUnitRow();
    await reconcileUnits(productId);
    await reconcileBarcodes(productId);
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    await queryList();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(row: ProductRow): Promise<void> {
  const next = row.status ? 0 : 1;
  try {
    await ElMessageBox.confirm(`确定${next ? '启用' : '停用'}商品「${row.name}」？`, '状态变更', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await save({ id: row.id, status: next });
    ElMessage.success(next ? '已启用' : '已停用');
    await queryList();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function openStock(row: ProductRow): Promise<void> {
  previewProduct.value = row;
  drawerVisible.value = true;
  stockLoading.value = true;
  stockRows.value = [];
  ledgerRows.value = [];
  try {
    const a = api();
    const [balance, ledger] = await Promise.all([
      a.search('stock_balance', { equals: { product_id: row.id } }),
      a.search('stock_ledger', { equals: { product_id: row.id }, limit: 20 }),
    ]);
    stockRows.value = balance;
    ledgerRows.value = ledger;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    stockLoading.value = false;
  }
}

async function doScan(): Promise<void> {
  const code = scanCode.value.trim();
  if (!code) {
    ElMessage.warning('请输入或扫描条码');
    return;
  }
  scanning.value = true;
  scanResult.value = null;
  try {
    const res = await api().lookupBarcode(code);
    if (!res) {
      ElMessage.error(`未找到条码「${code}」对应的商品`);
      return;
    }
    scanResult.value = res as ScanResult;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    scanning.value = false;
  }
}

onMounted(async () => {
  await loadDicts();
  await queryList();
});
</script>

<template>
  <div>
    <el-card class="card-gap">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="关键字">
          <el-input
            v-model="searchForm.keyword"
            placeholder="编号 / 名称 / 条码 / 规格"
            clearable
            style="width: 220px"
            @keyup.enter="queryList"
          />
        </el-form-item>
        <el-form-item label="类别">
          <el-select v-model="searchForm.category_id" clearable placeholder="全部" style="width: 180px">
            <el-option v-for="c in categoryOptions" :key="c.id" :label="c.label" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select
            v-model="searchForm.status"
            clearable
            placeholder="全部"
            style="width: 120px"
            value-on-clear=""
          >
            <el-option label="启用" :value="1" />
            <el-option label="停用" :value="0" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="queryList">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="success" @click="openCreate">新增商品</el-button>
        </el-form-item>
      </el-form>

      <el-divider />

      <el-form :inline="true" @submit.prevent>
        <el-form-item label="扫码查询">
          <el-input
            v-model="scanCode"
            placeholder="扫描 / 输入条码"
            style="width: 240px"
            @keyup.enter="doScan"
          />
        </el-form-item>
        <el-form-item>
          <el-button :loading="scanning" @click="doScan">查询条码</el-button>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="scanResult"
        type="success"
        :closable="false"
        :title="`匹配到商品：${scanResult.product.name ?? ''}（${scanResult.product.code ?? ''}）`"
      >
        <div>
          命中方式：{{ matchedByLabel[scanResult.matchedBy] }}
          <span v-if="scanResult.matchedBy === 'product_unit' && scanResult.unit">
            · 单位：{{ scanResult.unit.name ?? '-' }}
          </span>
        </div>
      </el-alert>
    </el-card>

    <el-card>
      <el-table v-loading="loading" :data="rows" empty-text="暂无商品数据" border stripe>
        <el-table-column prop="code" label="商品编号" width="140" />
        <el-table-column prop="name" label="名称" min-width="160" />
        <el-table-column label="类别" width="140">
          <template #default="{ row }">{{ categoryName(row.category_id) }}</template>
        </el-table-column>
        <el-table-column prop="spec" label="规格" width="120" />
        <el-table-column label="基本单位" width="100">
          <template #default="{ row }">{{ unitName(row.base_unit_id) }}</template>
        </el-table-column>
        <el-table-column prop="purchase_price" label="预设进价" width="100" />
        <el-table-column prop="sale_price" label="预设售价" width="100" />
        <el-table-column prop="init_qty" label="期初数量" width="100" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status ? 'success' : 'info'">{{ row.status ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" size="small" @click="toggleStatus(row)">
              {{ row.status ? '停用' : '启用' }}
            </el-button>
            <el-button link type="primary" size="small" @click="openStock(row)">库存预览</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑商品' : '新增商品'" width="900px" top="5vh">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="商品编号" prop="code">
              <div class="row-inline">
                <el-input v-model="form.code" placeholder="商品编号" />
                <el-button @click="genCode">自动生成</el-button>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="名称" prop="name">
              <el-input v-model="form.name" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="类别">
              <el-select v-model="form.category_id" clearable filterable placeholder="请选择类别" style="width: 100%">
                <el-option v-for="c in categoryOptions" :key="c.id" :label="c.label" :value="c.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="基本单位" prop="base_unit_id">
              <el-select v-model="form.base_unit_id" clearable placeholder="请选择基本单位" style="width: 100%">
                <el-option v-for="u in units" :key="u.id" :label="u.name" :value="u.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="主条码">
              <el-input v-model="form.barcode" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="规格">
              <el-input v-model="form.spec" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="颜色">
              <el-input v-model="form.color" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="生产厂商">
              <el-input v-model="form.manufacturer" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="重量">
              <el-input-number v-model="form.weight" :min="0" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="重量单位">
              <el-input v-model="form.weight_unit" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="状态">
              <el-switch
                v-model="form.status"
                :active-value="1"
                :inactive-value="0"
                active-text="启用"
                inactive-text="停用"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="默认仓库">
              <el-select
                v-model="form.default_warehouse_id"
                clearable
                placeholder="请选择仓库"
                style="width: 100%"
                @change="onWarehouseChange"
              >
                <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="默认货位">
              <el-select v-model="form.default_location_id" clearable placeholder="请选择货位" style="width: 100%">
                <el-option v-for="l in locations" :key="l.id" :label="l.name" :value="l.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="预设进价">
              <el-input-number v-model="form.purchase_price" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="预设售价">
              <el-input-number v-model="form.sale_price" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="成本价">
              <el-input-number v-model="form.cost_price" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="期初数量">
              <el-input-number v-model="form.init_qty" :min="0" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="期初成本">
              <el-input-number v-model="form.init_cost" :min="0" :precision="2" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="最低库存">
              <el-input-number v-model="form.min_stock" :min="0" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="最高库存">
              <el-input-number v-model="form.max_stock" :min="0" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-divider content-position="left">多单位</el-divider>
        <el-button size="small" @click="addUnitRow">新增单位行</el-button>
        <el-table :data="unitRows" size="small" border style="margin-top: 8px" empty-text="暂无单位行">
          <el-table-column label="单位" min-width="160">
            <template #default="{ row }">
              <el-select v-model="row.unit_id" placeholder="请选择单位" size="small" style="width: 100%">
                <el-option v-for="u in units" :key="u.id" :label="u.name" :value="u.id" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="换算率" width="120">
            <template #default="{ row }">
              <el-input-number
                v-model="row.factor"
                :min="0"
                :precision="6"
                size="small"
                controls-position="right"
                style="width: 100%"
              />
            </template>
          </el-table-column>
          <el-table-column label="是否基本单位" width="120" align="center">
            <template #default="{ row }">
              <el-switch
                v-model="row.is_base"
                :active-value="1"
                :inactive-value="0"
                :disabled="!!form.base_unit_id && row.unit_id === form.base_unit_id"
              />
            </template>
          </el-table-column>
          <el-table-column label="条码" min-width="140">
            <template #default="{ row }">
              <el-input v-model="row.barcode" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="进价" width="120">
            <template #default="{ row }">
              <el-input-number
                v-model="row.purchase_price"
                :min="0"
                :precision="2"
                size="small"
                controls-position="right"
                style="width: 100%"
              />
            </template>
          </el-table-column>
          <el-table-column label="售价" width="120">
            <template #default="{ row }">
              <el-input-number
                v-model="row.sale_price"
                :min="0"
                :precision="2"
                size="small"
                controls-position="right"
                style="width: 100%"
              />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="70">
            <template #default="{ $index }">
              <el-button link type="danger" size="small" @click="removeUnitRow($index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-divider content-position="left">条码</el-divider>
        <el-button size="small" @click="addBarcodeRow">新增条码</el-button>
        <el-table :data="barcodeRows" size="small" border style="margin-top: 8px" empty-text="暂无条码">
          <el-table-column label="条码" min-width="200">
            <template #default="{ row }">
              <el-input v-model="row.barcode" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="200">
            <template #default="{ row }">
              <el-input v-model="row.remark" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="70">
            <template #default="{ $index }">
              <el-button link type="danger" size="small" @click="removeBarcodeRow($index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="drawerVisible" :title="`库存预览 - ${previewProduct?.name ?? ''}`" size="60%">
      <div v-loading="stockLoading">
        <h4 class="section-title">库存余额</h4>
        <el-table v-if="stockRows.length" :data="stockRows" border size="small">
          <el-table-column label="仓库" min-width="120">
            <template #default="{ row }">{{ warehouseName(row.warehouse_id) }}</template>
          </el-table-column>
          <el-table-column prop="location_id" label="货位" min-width="100" />
          <el-table-column prop="qty" label="数量" width="100" />
          <el-table-column prop="avail_qty" label="可用数量" width="110" />
          <el-table-column prop="avg_cost" label="平均成本" width="110" />
        </el-table>
        <el-empty v-else description="库存数据将在 P3 阶段生成" />

        <h4 class="section-title">库存流水（最近 20 条）</h4>
        <el-table v-if="ledgerRows.length" :data="ledgerRows" border size="small">
          <el-table-column prop="biz_type" label="业务类型" width="110" />
          <el-table-column prop="doc_no" label="单据号" min-width="140" />
          <el-table-column prop="qty_in" label="入库" width="90" />
          <el-table-column prop="qty_out" label="出库" width="90" />
          <el-table-column prop="unit_cost" label="单位成本" width="100" />
          <el-table-column prop="amount" label="金额" width="100" />
          <el-table-column label="业务日期" min-width="160">
            <template #default="{ row }">{{ formatDate(row.biz_date) }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="库存数据将在 P3 阶段生成" />
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.row-inline {
  display: flex;
  gap: 8px;
  width: 100%;
}
.section-title {
  margin: 0 0 8px;
}
</style>
