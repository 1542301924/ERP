<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../composables/useCrud';
import { type DocKind } from '../composables/useDocPage';

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
  unit_id: string | null;
  unit_name: string;
  factor: number;
  qty: number;
  price: number;
  location_id: string | null;
  remark: string | null;
  units: UnitOpt[];
}

interface DocItemPayload {
  product_id: string;
  unit_id?: string | null;
  factor?: number;
  qty: number;
  price: number;
  location_id?: string | null;
  remark?: string | null;
}

interface HeaderForm {
  id: string;
  docType: string;
  supplier_id: string | null;
  customer_id: string | null;
  warehouse_id: string | null;
  department_id: string | null;
  receiver_id: string | null;
  use_purpose: string | null;
  biz_date: Date | null;
  handler_id: string | null;
  remark: string | null;
}

const props = defineProps<{
  kind: DocKind;
  docType?: string;
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

const form = reactive<HeaderForm>({
  id: '',
  docType: '',
  supplier_id: null,
  customer_id: null,
  warehouse_id: null,
  department_id: null,
  receiver_id: null,
  use_purpose: null,
  biz_date: null,
  handler_id: null,
  remark: null,
});

const items = ref<ItemRow[]>([]);
const readonly = ref(false);
const saving = ref(false);

const suppliers = ref<DictItem[]>([]);
const customers = ref<DictItem[]>([]);
const warehouses = ref<DictItem[]>([]);
const departments = ref<DictItem[]>([]);
const users = ref<DictItem[]>([]);

const locationOptions = ref<DictItem[]>([]);
const productOptions = ref<{ id: string; label: string }[]>([]);
const productSearching = ref(false);
const addProductId = ref('');
const scanCode = ref('');

const isOrder = computed(() => props.kind === 'purchase_order' || props.kind === 'sales_order');
const isPurchaseKind = computed(() => props.kind === 'purchase_order' || props.kind === 'purchase_inbound');
const effectiveDocType = computed(() =>
  isOrder.value ? '' : form.docType || props.docType || '',
);
const showSupplier = computed(
  () =>
    props.kind === 'purchase_order' ||
    (props.kind === 'purchase_inbound' && ['采购', '退货入库'].includes(effectiveDocType.value)),
);
const showCustomer = computed(
  () =>
    props.kind === 'sales_order' ||
    (props.kind === 'sales_outbound' && ['销售', '退货出库'].includes(effectiveDocType.value)),
);
const showDeptUse = computed(
  () => props.kind === 'purchase_inbound' && effectiveDocType.value === '部门领用',
);
const showLocation = computed(
  () => props.kind === 'purchase_inbound' || props.kind === 'sales_outbound',
);
const title = computed(() => (readonly.value ? '查看单据' : form.id ? '编辑单据' : '新增单据'));
const totalAmount = computed(() => items.value.reduce((sum, r) => sum + lineAmount(r), 0));

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

function lineAmount(row: ItemRow): number {
  return num(row.qty) * num(row.price);
}

function lineBaseQty(row: ItemRow): number {
  return num(row.qty) * num(row.factor);
}

function money(value: unknown): string {
  return num(value).toFixed(2);
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
    unit_id: null,
    unit_name: '',
    factor: 1,
    qty: 0,
    price: 0,
    location_id: null,
    remark: null,
    units: [],
  };
}

function addProductOption(id: string, label: string): void {
  if (!productOptions.value.some((o) => o.id === id)) productOptions.value.push({ id, label });
}

async function loadDicts(): Promise<void> {
  try {
    const a = api();
    const [sup, cus, whs, deps, usr] = await Promise.all([
      a.query('supplier'),
      a.query('customer'),
      a.query('warehouse'),
      a.query('department'),
      a.query('app_user'),
    ]);
    suppliers.value = toDicts(sup);
    customers.value = toDicts(cus);
    warehouses.value = toDicts(whs);
    departments.value = toDicts(deps);
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

async function loadLocations(): Promise<void> {
  if (!showLocation.value || !form.warehouse_id) {
    locationOptions.value = [];
    return;
  }
  try {
    const list = await api().search('location', {
      equals: { warehouse_id: form.warehouse_id },
      limit: 500,
    });
    locationOptions.value = list.map((l) => ({ id: String(l.id), name: String(l.name ?? '') }));
  } catch (err) {
    locationOptions.value = [];
    ElMessage.error(message(err));
  }
}

async function onWarehouseChange(): Promise<void> {
  for (const row of items.value) row.location_id = null;
  await loadLocations();
}

function resetDraft(): void {
  Object.assign(form, {
    id: '',
    docType: props.docType ?? '',
    supplier_id: null,
    customer_id: null,
    warehouse_id: null,
    department_id: null,
    receiver_id: null,
    use_purpose: null,
    biz_date: new Date(),
    handler_id: null,
    remark: null,
  });
  readonly.value = false;
  locationOptions.value = [];
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
    unit_id: it.unit_id ? String(it.unit_id) : null,
    unit_name: String(it.unit_name ?? ''),
    factor: Number(it.factor ?? 1),
    qty: Number(it.qty ?? 0),
    price: Number(it.price ?? 0),
    location_id: it.location_id ? String(it.location_id) : null,
    remark: it.remark === null || it.remark === undefined ? null : String(it.remark),
    units,
  };
}

async function loadDoc(id: string): Promise<void> {
  try {
    const res = await api().doc.get(props.kind, id);
    if (!res) {
      ElMessage.error('未找到单据');
      visible.value = false;
      return;
    }
    const doc = res.doc as Record<string, unknown>;
    Object.assign(form, {
      id: String(doc.id ?? ''),
      docType: String(doc.inbound_type ?? doc.outbound_type ?? props.docType ?? ''),
      supplier_id: text(doc.supplier_id),
      customer_id: text(doc.customer_id),
      warehouse_id: text(doc.warehouse_id),
      department_id: text(doc.department_id),
      receiver_id: text(doc.receiver_id),
      use_purpose: text(doc.use_purpose),
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
    await loadLocations();
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
    row.units = units;
    row.unit_id = base?.unit_id ?? null;
    row.unit_name = base?.unit_name ?? '';
    row.factor = base?.factor ?? 1;
    if (!Number(row.qty)) row.qty = 1;
    row.price = num(isPurchaseKind.value ? prod.purchase_price : prod.sale_price);
    addProductOption(productId, `${prod.name ?? ''} (${prod.code ?? ''})`);
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

function buildItems(): DocItemPayload[] {
  return items.value
    .filter((r) => r.product_id && num(r.qty) > 0)
    .map((r) => ({
      product_id: r.product_id,
      unit_id: r.unit_id,
      factor: num(r.factor) || 1,
      qty: num(r.qty),
      price: num(r.price),
      location_id: showLocation.value ? r.location_id : null,
      remark: r.remark,
    }));
}

async function submit(): Promise<void> {
  if (readonly.value) return;
  const payloadItems = buildItems();
  if (!payloadItems.length) {
    ElMessage.warning('请至少添加一条有效明细（商品 + 数量 > 0）');
    return;
  }
  if (!isOrder.value && !effectiveDocType.value) {
    ElMessage.warning('缺少单据类型，无法保存');
    return;
  }
  saving.value = true;
  try {
    await api().doc.save(props.kind, {
      id: form.id || undefined,
      docType: isOrder.value ? undefined : effectiveDocType.value || undefined,
      supplier_id: showSupplier.value ? form.supplier_id : null,
      customer_id: showCustomer.value ? form.customer_id : null,
      warehouse_id: form.warehouse_id,
      department_id: showDeptUse.value ? form.department_id : null,
      receiver_id: showDeptUse.value ? form.receiver_id : null,
      use_purpose: showDeptUse.value ? form.use_purpose : null,
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
        <el-col v-if="showSupplier" :span="8">
          <el-form-item label="供应商">
            <el-select v-model="form.supplier_id" filterable clearable placeholder="请选择供应商" style="width: 100%">
              <el-option v-for="s in suppliers" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col v-if="showCustomer" :span="8">
          <el-form-item label="客户">
            <el-select v-model="form.customer_id" filterable clearable placeholder="请选择客户" style="width: 100%">
              <el-option v-for="c in customers" :key="c.id" :label="c.name" :value="c.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="仓库">
            <el-select
              v-model="form.warehouse_id"
              filterable
              clearable
              placeholder="请选择仓库"
              style="width: 100%"
              @change="onWarehouseChange"
            >
              <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col v-if="showDeptUse" :span="8">
          <el-form-item label="领用部门">
            <el-select v-model="form.department_id" filterable clearable placeholder="请选择部门" style="width: 100%">
              <el-option v-for="d in departments" :key="d.id" :label="d.name" :value="d.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col v-if="showDeptUse" :span="8">
          <el-form-item label="领用人">
            <el-select v-model="form.receiver_id" filterable clearable placeholder="请选择领用人" style="width: 100%">
              <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col v-if="showDeptUse" :span="8">
          <el-form-item label="用途">
            <el-input v-model="form.use_purpose" placeholder="领用用途" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="业务日期">
            <el-date-picker
              v-model="form.biz_date"
              type="date"
              placeholder="选择业务日期"
              style="width: 100%"
            />
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
          <el-input
            v-model="scanCode"
            placeholder="扫码 / 输入条码"
            style="width: 180px"
            @keyup.enter="onScan"
          />
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
        <el-table-column label="单位" width="130">
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
        <el-table-column label="换算率" width="110">
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
        <el-table-column label="单价" width="110">
          <template #default="{ row }">
            <el-input-number
              v-model="row.price"
              :min="0"
              :precision="2"
              size="small"
              controls-position="right"
              style="width: 100%"
            />
          </template>
        </el-table-column>
        <el-table-column label="金额" width="100" align="right">
          <template #default="{ row }">{{ money(lineAmount(row)) }}</template>
        </el-table-column>
        <el-table-column label="基本数量" width="110" align="right">
          <template #default="{ row }">{{ plain(lineBaseQty(row)) }}</template>
        </el-table-column>
        <el-table-column v-if="showLocation" label="货位" width="140">
          <template #default="{ row }">
            <el-select v-model="row.location_id" size="small" clearable placeholder="货位" style="width: 100%">
              <el-option v-for="l in locationOptions" :key="l.id" :label="l.name" :value="l.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="备注" width="150">
          <template #default="{ row }">
            <el-input v-model="row.remark" size="small" />
          </template>
        </el-table-column>
        <el-table-column v-if="!readonly" label="删除" width="70" fixed="right">
          <template #default="{ $index }">
            <el-button link type="danger" size="small" @click="removeRow($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="detail-total">合计：{{ money(totalAmount) }}</div>
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
.detail-total {
  margin-top: 10px;
  text-align: right;
  font-weight: 600;
}
</style>
