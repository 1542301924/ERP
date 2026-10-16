<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../composables/useCrud';
import { type StockDocKind } from '../composables/useStockDocPage';

interface DictItem {
  id: string;
  name: string;
}

interface UnitOpt {
  unit_id: string;
  unit_name: string;
  factor: number;
  is_base: number;
}

interface ItemRow {
  product_id: string;
  product_name: string;
  product_code: string;
  unit_id: string | null;
  unit_name: string;
  factor: number;
  qty: number;
  book_qty: number;
  from_location_id: string | null;
  to_location_id: string | null;
  location_id: string | null;
  units: UnitOpt[];
}

interface HeaderForm {
  id: string;
  from_warehouse_id: string | null;
  to_warehouse_id: string | null;
  warehouse_id: string | null;
  biz_date: Date | null;
  handler_id: string | null;
  remark: string | null;
}

/** 明细提交载荷（调拨用 from/to location，盘点用 location）。 */
interface StockItemPayload {
  product_id: string;
  from_location_id?: string | null;
  to_location_id?: string | null;
  location_id?: string | null;
  unit_id?: string | null;
  factor?: number;
  qty: number;
}

const props = defineProps<{
  kind: StockDocKind;
  modelValue: boolean;
  docId?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'saved'): void;
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

const isTransfer = computed(() => props.kind === 'stock_transfer');

const form = reactive<HeaderForm>({
  id: '',
  from_warehouse_id: null,
  to_warehouse_id: null,
  warehouse_id: null,
  biz_date: null,
  handler_id: null,
  remark: null,
});

const items = ref<ItemRow[]>([]);
const readonly = ref(false);
const saving = ref(false);

const warehouses = ref<DictItem[]>([]);
const users = ref<DictItem[]>([]);
const fromLocations = ref<DictItem[]>([]);
const toLocations = ref<DictItem[]>([]);
const checkLocations = ref<DictItem[]>([]);

const productOptions = ref<{ id: string; label: string }[]>([]);
const productSearching = ref(false);
const addProductId = ref('');
const scanCode = ref('');

const title = computed(() => (readonly.value ? '查看单据' : form.id ? '编辑单据' : '新增单据'));

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function plain(value: number): string {
  return String(Number(value.toFixed(6)));
}

function toDicts(list: Record<string, unknown>[]): DictItem[] {
  return list.map((r) => ({ id: String(r.id), name: String(r.name ?? r.account ?? r.id) }));
}

function mapUnits(list: Record<string, unknown>[] | undefined): UnitOpt[] {
  return (list ?? []).map((u) => ({
    unit_id: String(u.unit_id ?? ''),
    unit_name: String(u.unit_name ?? ''),
    factor: Number(u.factor ?? 1),
    is_base: Number(u.is_base ?? 0),
  }));
}

function emptyItem(): ItemRow {
  return {
    product_id: '',
    product_name: '',
    product_code: '',
    unit_id: null,
    unit_name: '',
    factor: 1,
    qty: 0,
    book_qty: 0,
    from_location_id: null,
    to_location_id: null,
    location_id: null,
    units: [],
  };
}

function addProductOption(id: string, label: string): void {
  if (!productOptions.value.some((o) => o.id === id)) productOptions.value.push({ id, label });
}

async function loadDicts(): Promise<void> {
  try {
    const a = api();
    const [whs, usr] = await Promise.all([a.query('warehouse'), a.query('app_user')]);
    warehouses.value = toDicts(whs);
    users.value = toDicts(usr);
  } catch (err) {
    ElMessage.error(message(err));
  }
}

async function searchProducts(keyword: string): Promise<void> {
  productSearching.value = true;
  try {
    const key = keyword.trim();
    const list = await api().search('product', key ? { keyword: key, limit: 20 } : { limit: 20 });
    productOptions.value = list.map((p) => ({
      id: String(p.id),
      label: `${p.name ?? ''} (${p.code ?? ''})`,
    }));
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    productSearching.value = false;
  }
}

async function loadLocations(warehouseId: string | null): Promise<DictItem[]> {
  if (!warehouseId) return [];
  try {
    const list = await api().search('location', { equals: { warehouse_id: warehouseId }, limit: 500 });
    return list.map((l) => ({ id: String(l.id), name: String(l.name ?? '') }));
  } catch (err) {
    ElMessage.error(message(err));
    return [];
  }
}

async function onFromWarehouseChange(): Promise<void> {
  fromLocations.value = await loadLocations(form.from_warehouse_id);
  for (const row of items.value) row.from_location_id = null;
}

async function onToWarehouseChange(): Promise<void> {
  toLocations.value = await loadLocations(form.to_warehouse_id);
  for (const row of items.value) row.to_location_id = null;
}

async function onCheckWarehouseChange(): Promise<void> {
  checkLocations.value = await loadLocations(form.warehouse_id);
  for (const row of items.value) row.location_id = null;
  await refreshBookQtyAll();
}

/** 拉取账面数量（现有量），用于盘点差异展示；服务端保存时会再次权威计算。 */
async function refreshBookQty(row: ItemRow): Promise<void> {
  if (!row.product_id || !form.warehouse_id) {
    row.book_qty = 0;
    return;
  }
  try {
    const filter: { productId: string; warehouseId: string; locationId?: string } = {
      productId: row.product_id,
      warehouseId: form.warehouse_id,
    };
    if (row.location_id) filter.locationId = row.location_id;
    const list = await api().stock.balance(filter);
    row.book_qty = list.reduce((sum, r) => sum + num(r.qty), 0);
  } catch {
    row.book_qty = 0;
  }
}

async function refreshBookQtyAll(): Promise<void> {
  await Promise.all(items.value.map((row) => refreshBookQty(row)));
}

function resetDraft(): void {
  Object.assign(form, {
    id: '',
    from_warehouse_id: null,
    to_warehouse_id: null,
    warehouse_id: null,
    biz_date: new Date(),
    handler_id: null,
    remark: null,
  });
  readonly.value = false;
  fromLocations.value = [];
  toLocations.value = [];
  checkLocations.value = [];
  items.value = [emptyItem()];
}

async function buildItemFromServer(it: Record<string, unknown>): Promise<ItemRow> {
  const pid = it.product_id ? String(it.product_id) : '';
  let units: UnitOpt[] = [];
  if (pid) {
    try {
      const detail = await api().productDetail(pid);
      if (detail) units = mapUnits(detail.units);
    } catch {
      // 单个商品详情失败不影响其余明细
    }
  }
  return {
    product_id: pid,
    product_name: String(it.product_name ?? ''),
    product_code: String(it.product_code ?? ''),
    unit_id: it.unit_id ? String(it.unit_id) : null,
    unit_name: String(it.unit_name ?? ''),
    factor: Number(it.factor ?? 1),
    qty: Number(it.qty ?? 0),
    book_qty: Number(it.book_qty ?? 0),
    from_location_id: it.from_location_id ? String(it.from_location_id) : null,
    to_location_id: it.to_location_id ? String(it.to_location_id) : null,
    location_id: it.location_id ? String(it.location_id) : null,
    units,
  };
}

async function loadDoc(id: string): Promise<void> {
  try {
    const res = await api().stockDoc.get(props.kind, id);
    if (!res) {
      ElMessage.error('未找到单据');
      visible.value = false;
      return;
    }
    const doc = res.doc;
    Object.assign(form, {
      id: String(doc.id ?? ''),
      from_warehouse_id: text(doc.from_warehouse_id),
      to_warehouse_id: text(doc.to_warehouse_id),
      warehouse_id: text(doc.warehouse_id),
      biz_date: doc.biz_date ? new Date(Number(doc.biz_date)) : new Date(),
      handler_id: text(doc.handler_id),
      remark: text(doc.remark),
    });
    readonly.value = Number(doc.status ?? 0) !== 0;

    const serverItems = res.items ?? [];
    items.value = await Promise.all(serverItems.map((it) => buildItemFromServer(it)));
    for (const it of serverItems) {
      const pid = it.product_id ? String(it.product_id) : '';
      if (pid) addProductOption(pid, `${it.product_name ?? ''} (${it.product_code ?? ''})`);
    }

    if (isTransfer.value) {
      fromLocations.value = await loadLocations(form.from_warehouse_id);
      toLocations.value = await loadLocations(form.to_warehouse_id);
    } else {
      checkLocations.value = await loadLocations(form.warehouse_id);
    }
  } catch (err) {
    ElMessage.error(message(err));
    visible.value = false;
  }
}

async function applyProduct(row: ItemRow, productId: string): Promise<void> {
  if (!productId) {
    row.units = [];
    row.unit_id = null;
    row.unit_name = '';
    row.factor = 1;
    row.product_name = '';
    row.product_code = '';
    row.book_qty = 0;
    return;
  }
  try {
    const detail = await api().productDetail(productId);
    if (!detail) {
      ElMessage.error('未找到商品详情');
      return;
    }
    const prod = detail.product;
    const units = mapUnits(detail.units);
    const base = units.find((u) => u.is_base === 1) ?? units[0];
    row.product_id = productId;
    row.product_name = String(prod.name ?? '');
    row.product_code = String(prod.code ?? '');
    row.units = units;
    row.unit_id = base?.unit_id ?? null;
    row.unit_name = base?.unit_name ?? '';
    row.factor = base?.factor ?? 1;
    if (!Number(row.qty)) row.qty = 1;
    addProductOption(productId, `${prod.name ?? ''} (${prod.code ?? ''})`);
    if (!isTransfer.value) await refreshBookQty(row);
  } catch (err) {
    ElMessage.error(message(err));
  }
}

function onUnitChange(row: ItemRow): void {
  const unit = row.units.find((u) => u.unit_id === row.unit_id);
  if (unit) {
    row.factor = unit.factor;
    row.unit_name = unit.unit_name;
  }
}

function addEmptyRow(): void {
  items.value.push(emptyItem());
}

function removeRow(index: number): void {
  items.value.splice(index, 1);
}

async function onAddProduct(productId: string): Promise<void> {
  if (!productId) return;
  const row = emptyItem();
  items.value.push(row);
  await applyProduct(row, productId);
  addProductId.value = '';
}

async function onScan(): Promise<void> {
  const code = scanCode.value.trim();
  if (!code) {
    ElMessage.warning('请输入或扫描条码');
    return;
  }
  try {
    const res = await api().lookupBarcode(code);
    if (!res) {
      ElMessage.error(`未找到条码「${code}」对应的商品`);
      return;
    }
    const row = emptyItem();
    items.value.push(row);
    await applyProduct(row, String(res.product.id ?? ''));
    scanCode.value = '';
  } catch (err) {
    ElMessage.error(message(err));
  }
}

function buildItems(): StockItemPayload[] {
  return items.value
    .filter((r) => r.product_id && num(r.qty) > 0)
    .map((r) => {
      const base = {
        product_id: r.product_id,
        unit_id: r.unit_id,
        factor: num(r.factor) || 1,
        qty: num(r.qty),
      };
      if (isTransfer.value) {
        return { ...base, from_location_id: r.from_location_id, to_location_id: r.to_location_id };
      }
      return { ...base, location_id: r.location_id };
    });
}

async function submit(): Promise<void> {
  if (readonly.value) return;
  const payloadItems = buildItems();
  if (!payloadItems.length) {
    ElMessage.warning('请至少添加一条有效明细（商品 + 数量 > 0）');
    return;
  }
  if (isTransfer.value) {
    if (!form.from_warehouse_id || !form.to_warehouse_id) {
      ElMessage.warning('请选择调出仓库与调入仓库');
      return;
    }
    if (form.from_warehouse_id === form.to_warehouse_id) {
      ElMessage.warning('调出仓库与调入仓库不能相同');
      return;
    }
  } else if (!form.warehouse_id) {
    ElMessage.warning('请选择盘点仓库');
    return;
  }
  saving.value = true;
  try {
    await api().stockDoc.save(props.kind, {
      id: form.id || undefined,
      from_warehouse_id: isTransfer.value ? form.from_warehouse_id : null,
      to_warehouse_id: isTransfer.value ? form.to_warehouse_id : null,
      warehouse_id: isTransfer.value ? null : form.warehouse_id,
      biz_date: form.biz_date ? form.biz_date.getTime() : Date.now(),
      handler_id: form.handler_id,
      remark: form.remark,
      items: payloadItems,
    });
    ElMessage.success('保存成功');
    emit('saved');
    visible.value = false;
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    await loadDicts();
    void searchProducts('');
    if (props.docId) {
      await loadDoc(props.docId);
    } else {
      resetDraft();
    }
  },
);
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="title"
    width="1100px"
    top="5vh"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <el-form :model="form" label-width="90px" :disabled="readonly">
      <el-row :gutter="12">
        <template v-if="isTransfer">
          <el-col :span="8">
            <el-form-item label="调出仓库">
              <el-select
                v-model="form.from_warehouse_id"
                filterable
                clearable
                placeholder="请选择调出仓库"
                style="width: 100%"
                @change="onFromWarehouseChange"
              >
                <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="调入仓库">
              <el-select
                v-model="form.to_warehouse_id"
                filterable
                clearable
                placeholder="请选择调入仓库"
                style="width: 100%"
                @change="onToWarehouseChange"
              >
                <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
              </el-select>
            </el-form-item>
          </el-col>
        </template>
        <el-col v-else :span="8">
          <el-form-item label="盘点仓库">
            <el-select
              v-model="form.warehouse_id"
              filterable
              clearable
              placeholder="请选择仓库"
              style="width: 100%"
              @change="onCheckWarehouseChange"
            >
              <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="业务日期">
            <el-date-picker v-model="form.biz_date" type="date" placeholder="选择业务日期" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="经手人">
            <el-select v-model="form.handler_id" filterable clearable placeholder="请选择经手人" style="width: 100%">
              <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="24">
          <el-form-item label="备注">
            <el-input v-model="form.remark" type="textarea" :rows="2" />
          </el-form-item>
        </el-col>
      </el-row>

      <div class="detail-head">
        <span class="detail-title">明细</span>
        <template v-if="!readonly">
          <el-select
            v-model="addProductId"
            filterable
            remote
            clearable
            :remote-method="searchProducts"
            :loading="productSearching"
            placeholder="搜索并添加商品"
            style="width: 260px"
            @change="onAddProduct"
          >
            <el-option v-for="p in productOptions" :key="p.id" :label="p.label" :value="p.id" />
          </el-select>
          <el-input v-model="scanCode" placeholder="扫码 / 输入条码" style="width: 180px" @keyup.enter="onScan" />
          <el-button @click="onScan">扫码添加</el-button>
          <el-button @click="addEmptyRow">新增空行</el-button>
        </template>
      </div>

      <el-table :data="items" size="small" border empty-text="暂无明细" style="width: 100%">
        <el-table-column label="商品" min-width="200">
          <template #default="{ row }">
            <el-select
              v-model="row.product_id"
              filterable
              remote
              :remote-method="searchProducts"
              :loading="productSearching"
              size="small"
              placeholder="选择商品"
              style="width: 100%"
              :disabled="readonly"
              @change="(value: string) => applyProduct(row, value)"
            >
              <el-option v-for="p in productOptions" :key="p.id" :label="p.label" :value="p.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="单位" width="120">
          <template #default="{ row }">
            <el-select
              v-model="row.unit_id"
              size="small"
              placeholder="单位"
              style="width: 100%"
              :disabled="readonly"
              @change="onUnitChange(row)"
            >
              <el-option v-for="u in row.units" :key="u.unit_id" :label="u.unit_name" :value="u.unit_id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="换算率" width="100">
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

        <template v-if="isTransfer">
          <el-table-column label="数量" width="110">
            <template #default="{ row }">
              <el-input-number
                v-model="row.qty"
                :min="0"
                :precision="4"
                size="small"
                controls-position="right"
                style="width: 100%"
              />
            </template>
          </el-table-column>
          <el-table-column label="调出货位" width="140">
            <template #default="{ row }">
              <el-select v-model="row.from_location_id" size="small" clearable placeholder="货位" style="width: 100%">
                <el-option v-for="l in fromLocations" :key="l.id" :label="l.name" :value="l.id" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="调入货位" width="140">
            <template #default="{ row }">
              <el-select v-model="row.to_location_id" size="small" clearable placeholder="货位" style="width: 100%">
                <el-option v-for="l in toLocations" :key="l.id" :label="l.name" :value="l.id" />
              </el-select>
            </template>
          </el-table-column>
        </template>

        <template v-else>
          <el-table-column label="货位" width="130">
            <template #default="{ row }">
              <el-select
                v-model="row.location_id"
                size="small"
                clearable
                placeholder="货位"
                style="width: 100%"
                :disabled="readonly"
                @change="refreshBookQty(row)"
              >
                <el-option v-for="l in checkLocations" :key="l.id" :label="l.name" :value="l.id" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="账面数量" width="100" align="right">
            <template #default="{ row }">{{ plain(num(row.book_qty)) }}</template>
          </el-table-column>
          <el-table-column label="实盘数量" width="120">
            <template #default="{ row }">
              <el-input-number
                v-model="row.qty"
                :min="0"
                :precision="4"
                size="small"
                controls-position="right"
                style="width: 100%"
              />
            </template>
          </el-table-column>
          <el-table-column label="差异" width="100" align="right">
            <template #default="{ row }">
              <span :class="num(row.qty) - num(row.book_qty) < 0 ? 'diff-neg' : 'diff-pos'">
                {{ plain(num(row.qty) - num(row.book_qty)) }}
              </span>
            </template>
          </el-table-column>
        </template>

        <el-table-column v-if="!readonly" label="删除" width="70" fixed="right">
          <template #default="{ $index }">
            <el-button link type="danger" size="small" @click="removeRow($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">{{ readonly ? '关闭' : '取消' }}</el-button>
      <el-button v-if="!readonly" type="primary" :loading="saving" @click="submit">保存草稿</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 10px;
}
.detail-title {
  font-weight: 600;
  margin-right: 6px;
}
.diff-pos {
  color: #67c23a;
}
.diff-neg {
  color: #f56c6c;
}
</style>
