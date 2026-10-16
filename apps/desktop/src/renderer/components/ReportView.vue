<script setup lang="ts">
import { computed, onMounted, reactive, ref, type Ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../composables/useCrud';
import type { ReportColumn, ReportFilter, ReportKind, ReportResult } from '../../../env';

interface DictItem {
  id: string;
  name: string;
}
interface GroupOption {
  label: string;
  value: 'product' | 'warehouse' | 'customer' | 'handler';
}

/**
 * 通用报表视图：按报表类型 `kind` 运行时拉取「列定义 + 数据行 + 合计行」，
 * 表格列、合计行、Excel 导出均由后端返回的 `columns` / `totals` 驱动，
 * 各报表页面只需传入 `kind` 与需要展示的筛选维度。
 */
const props = withDefaults(
  defineProps<{
    kind: ReportKind;
    /** 报表标题（缺省取后端返回的 title） */
    title?: string;
    showKeyword?: boolean;
    showWarehouse?: boolean;
    showProduct?: boolean;
    showCustomer?: boolean;
    showSupplier?: boolean;
    showHandler?: boolean;
    /** 汇总维度下拉项（进销存汇总表 / 销售毛利表使用） */
    groupOptions?: GroupOption[];
  }>(),
  {
    title: '',
    showKeyword: false,
    showWarehouse: false,
    showProduct: false,
    showCustomer: false,
    showSupplier: false,
    showHandler: false,
  },
);

const result = ref<ReportResult | null>(null);
const loading = ref(false);
const warehouses = ref<DictItem[]>([]);
const products = ref<DictItem[]>([]);
const customers = ref<DictItem[]>([]);
const suppliers = ref<DictItem[]>([]);
const handlers = ref<DictItem[]>([]);

const filters = reactive<{
  keyword: string;
  warehouseId: string;
  productId: string;
  customerId: string;
  supplierId: string;
  handlerId: string;
  groupBy: string;
  dateRange: [Date, Date] | null;
}>({
  keyword: '',
  warehouseId: '',
  productId: '',
  customerId: '',
  supplierId: '',
  handlerId: '',
  groupBy: '',
  dateRange: null,
});
if (props.groupOptions?.length) filters.groupBy = props.groupOptions[0].value;

const columns = computed<ReportColumn[]>(() => result.value?.columns ?? []);
const totals = computed<Record<string, number>>(() => result.value?.totals ?? {});
const title = computed(() => props.title || result.value?.title || '报表');
const colMap = computed<Record<string, ReportColumn>>(() => {
  const map: Record<string, ReportColumn> = {};
  for (const c of columns.value) map[c.key] = c;
  return map;
});

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadDict(
  entity: string,
  target: Ref<DictItem[]>,
  label?: (row: Record<string, unknown>) => string,
): Promise<void> {
  try {
    const list = await api().query(entity);
    target.value = list.map((r) => ({
      id: String(r.id),
      name: label ? label(r) : String(r.name ?? r.id),
    }));
  } catch {
    // 字典加载失败不阻断报表查询
  }
}

function productLabel(row: Record<string, unknown>): string {
  const code = row.code ? String(row.code) : '';
  const name = String(row.name ?? row.id);
  return code ? `${code} ${name}` : name;
}

function buildFilter(): ReportFilter {
  const f: ReportFilter = {};
  const kw = filters.keyword.trim();
  if (props.showKeyword && kw) f.keyword = kw;
  if (filters.warehouseId) f.warehouseId = filters.warehouseId;
  if (filters.productId) f.productId = filters.productId;
  if (filters.customerId) f.customerId = filters.customerId;
  if (filters.supplierId) f.supplierId = filters.supplierId;
  if (filters.handlerId) f.handlerId = filters.handlerId;
  if (props.groupOptions?.length && filters.groupBy) f.groupBy = filters.groupBy as ReportFilter['groupBy'];
  if (filters.dateRange && filters.dateRange.length === 2) {
    f.startDate = filters.dateRange[0].getTime();
    f.endDate = filters.dateRange[1].getTime() + 86_399_999;
  }
  return f;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    result.value = await api().report.run(props.kind, buildFilter());
  } catch (err) {
    result.value = null;
    ElMessage.error(message(err));
  } finally {
    loading.value = false;
  }
}

async function exportExcel(): Promise<void> {
  try {
    const res = await api().report.export(props.kind, buildFilter());
    if (res.ok) ElMessage.success(res.path ? `已导出到 ${res.path}` : '已导出');
    else ElMessage.error(res.error ?? '导出失败');
  } catch (err) {
    ElMessage.error(message(err));
  }
}

function resetSearch(): void {
  filters.keyword = '';
  filters.warehouseId = '';
  filters.productId = '';
  filters.customerId = '';
  filters.supplierId = '';
  filters.handlerId = '';
  filters.groupBy = props.groupOptions?.length ? props.groupOptions[0].value : '';
  filters.dateRange = null;
  void load();
}

function qtyText(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '0';
  return String(Number(n.toFixed(6)));
}

function moneyText(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

function percentText(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '';
}

function dateText(value: unknown): string {
  const n = Number(value);
  if (!n || !Number.isFinite(n)) return '-';
  const d = new Date(n);
  const pad = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatCell(col: ReportColumn | undefined, value: unknown): string {
  const type = col?.type;
  if (value === null || value === undefined || value === '') {
    return type === 'text' || !type ? '-' : '';
  }
  if (type === 'money') return moneyText(value);
  if (type === 'qty') return qtyText(value);
  if (type === 'percent') return percentText(value);
  if (type === 'date') return dateText(value);
  return String(value);
}

function alignOf(col: ReportColumn): 'left' | 'right' {
  return col.type === 'money' || col.type === 'qty' || col.type === 'percent' ? 'right' : 'left';
}

function summary({ columns: sumCols }: { columns: { property?: string }[] }): string[] {
  return sumCols.map((c, i) => {
    if (i === 0) return '合计';
    const key = c.property ?? '';
    const value = totals.value[key];
    if (value === undefined) return '';
    return formatCell(colMap.value[key], value);
  });
}

onMounted(async () => {
  if (props.showWarehouse) await loadDict('warehouse', warehouses);
  if (props.showProduct) await loadDict('product', products, productLabel);
  if (props.showCustomer) await loadDict('customer', customers);
  if (props.showSupplier) await loadDict('supplier', suppliers);
  if (props.showHandler) await loadDict('app_user', handlers);
  await load();
});
</script>

<template>
  <div>
    <el-card class="card-gap">
      <el-form :inline="true" @submit.prevent>
        <el-form-item v-if="showKeyword" label="关键字">
          <el-input
            v-model="filters.keyword"
            placeholder="单据编号 / 商品编号 / 名称"
            clearable
            style="width: 220px"
            @keyup.enter="load"
          />
        </el-form-item>
        <el-form-item v-if="showWarehouse" label="仓库">
          <el-select v-model="filters.warehouseId" clearable placeholder="全部" style="width: 150px" value-on-clear="">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="showProduct" label="商品">
          <el-select
            v-model="filters.productId"
            clearable
            filterable
            placeholder="全部"
            style="width: 200px"
            value-on-clear=""
          >
            <el-option v-for="p in products" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="showCustomer" label="客户">
          <el-select v-model="filters.customerId" clearable filterable placeholder="全部" style="width: 170px" value-on-clear="">
            <el-option v-for="c in customers" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="showSupplier" label="供应商">
          <el-select v-model="filters.supplierId" clearable filterable placeholder="全部" style="width: 170px" value-on-clear="">
            <el-option v-for="s in suppliers" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="showHandler" label="业务员">
          <el-select v-model="filters.handlerId" clearable filterable placeholder="全部" style="width: 150px" value-on-clear="">
            <el-option v-for="h in handlers" :key="h.id" :label="h.name" :value="h.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="groupOptions && groupOptions.length" label="汇总维度">
          <el-select v-model="filters.groupBy" placeholder="全部" style="width: 130px">
            <el-option v-for="g in groupOptions" :key="g.value" :label="g.label" :value="g.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="业务日期">
          <el-date-picker
            v-model="filters.dateRange"
            type="daterange"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            style="width: 260px"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="load">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="success" :disabled="!result" @click="exportExcel">导出 Excel</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <template #header>
        <span>{{ title }}</span>
      </template>
      <el-table
        v-loading="loading"
        :data="result?.rows ?? []"
        empty-text="暂无报表数据"
        border
        stripe
        show-summary
        :summary-method="summary"
      >
        <el-table-column
          v-for="col in columns"
          :key="col.key"
          :prop="col.key"
          :label="col.label"
          :align="alignOf(col)"
          :min-width="col.type === 'text' ? 140 : 120"
        >
          <template #default="{ row }">{{ formatCell(col, row[col.key]) }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
