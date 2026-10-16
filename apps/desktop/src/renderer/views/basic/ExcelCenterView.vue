<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../composables/useCrud';

interface TemplateItem {
  id: string;
  name: string;
  importable: boolean;
}

interface ImportError {
  row: number;
  message: string;
  data?: Record<string, unknown>;
}

interface ImportResult {
  template: string;
  total: number;
  success: number;
  failed: number;
  errors: ImportError[];
}

const exportOptions = [
  { label: '商品', value: 'product' },
  { label: '客户', value: 'customer' },
  { label: '供应商', value: 'supplier' },
  { label: '计量单位', value: 'unit' },
  { label: '仓库', value: 'warehouse' },
  { label: '部门', value: 'department' },
];

const templates = ref<TemplateItem[]>([]);
const templatesLoading = ref(false);
const downloadingId = ref('');

const importTemplateId = ref('');
const filePath = ref('');
const importing = ref(false);
const importResult = ref<ImportResult | null>(null);

const exportEntity = ref('product');
const exporting = ref(false);

/** 仅可导入的模板可用于导入下拉。 */
const importableTemplates = computed(() => templates.value.filter((item) => item.importable));

async function loadTemplates(): Promise<void> {
  templatesLoading.value = true;
  try {
    templates.value = (await api().excel.templates()) as TemplateItem[];
    if (!importTemplateId.value) {
      const first = importableTemplates.value[0];
      if (first) importTemplateId.value = first.id;
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    templatesLoading.value = false;
  }
}

async function downloadTemplate(id: string): Promise<void> {
  downloadingId.value = id;
  try {
    const res = await api().excel.downloadTemplate(id);
    if (res.canceled) {
      ElMessage.info('已取消下载');
    } else if (res.ok) {
      ElMessage.success(res.path ? `模板已保存到：${res.path}` : '模板下载成功');
    } else {
      ElMessage.error(res.error ?? '模板下载失败');
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    downloadingId.value = '';
  }
}

async function pickFile(): Promise<void> {
  try {
    const res = await api().excel.pickFile();
    if (res.canceled) return;
    if (res.ok && res.path) {
      filePath.value = res.path;
    } else {
      ElMessage.error('未选择到文件');
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function startImport(): Promise<void> {
  if (!importTemplateId.value) {
    ElMessage.warning('请选择导入模板');
    return;
  }
  if (!filePath.value) {
    ElMessage.warning('请先选择文件');
    return;
  }
  importing.value = true;
  importResult.value = null;
  try {
    importResult.value = (await api().excel.import(importTemplateId.value, filePath.value)) as ImportResult;
    const result = importResult.value;
    if (result.failed > 0) {
      ElMessage.warning(`导入完成：成功 ${result.success} 条，失败 ${result.failed} 条`);
    } else {
      ElMessage.success(`导入完成：成功 ${result.success} 条`);
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    importing.value = false;
  }
}

async function doExport(): Promise<void> {
  exporting.value = true;
  try {
    const res = await api().excel.exportEntity(exportEntity.value);
    if (res.canceled) {
      ElMessage.info('已取消导出');
    } else if (res.ok) {
      ElMessage.success(res.path ? `已导出到：${res.path}` : '导出成功');
    } else {
      ElMessage.error(res.error ?? '导出失败');
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    exporting.value = false;
  }
}

/** 错误数据摘要（截断显示）。 */
function summarize(data?: Record<string, unknown>): string {
  if (!data) return '-';
  const text = JSON.stringify(data);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

onMounted(loadTemplates);
</script>

<template>
  <div>
    <el-card class="card-gap">
      <template #header>模板列表</template>
      <el-table v-loading="templatesLoading" :data="templates" empty-text="暂无模板" border stripe>
        <el-table-column prop="name" label="模板名称" min-width="220" />
        <el-table-column label="可导入" width="140">
          <template #default="{ row }">
            <el-tag v-if="row.importable" type="success">支持导入</el-tag>
            <el-tag v-else type="info">暂不支持导入</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              size="small"
              :loading="downloadingId === row.id"
              @click="downloadTemplate(row.id)"
            >
              下载模板
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="card-gap">
      <template #header>数据导入</template>
      <el-form label-width="100px">
        <el-form-item label="导入模板">
          <el-select v-model="importTemplateId" placeholder="请选择模板" style="width: 320px">
            <el-option v-for="t in importableTemplates" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="数据文件">
          <el-input v-model="filePath" readonly placeholder="尚未选择文件" style="width: 420px" />
          <el-button style="margin-left: 8px" @click="pickFile">选择文件</el-button>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="importing" @click="startImport">开始导入</el-button>
        </el-form-item>
      </el-form>

      <div v-if="importResult" class="import-result">
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item label="模板">{{ importResult.template }}</el-descriptions-item>
          <el-descriptions-item label="总数">{{ importResult.total }}</el-descriptions-item>
          <el-descriptions-item label="成功">
            <el-tag type="success">{{ importResult.success }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="失败">
            <el-tag :type="importResult.failed ? 'danger' : 'info'">{{ importResult.failed }}</el-tag>
          </el-descriptions-item>
        </el-descriptions>

        <el-table
          v-if="importResult.errors.length"
          :data="importResult.errors"
          empty-text="无错误"
          border
          size="small"
          style="margin-top: 12px"
        >
          <el-table-column prop="row" label="Excel 行号" width="120" />
          <el-table-column prop="message" label="错误原因" min-width="240" />
          <el-table-column label="数据摘要" min-width="260">
            <template #default="{ row }">{{ summarize(row.data) }}</template>
          </el-table-column>
        </el-table>
        <el-alert
          v-else
          style="margin-top: 12px"
          type="success"
          :closable="false"
          title="全部导入成功，无错误行"
        />
      </div>
    </el-card>

    <el-card>
      <template #header>数据导出</template>
      <el-form :inline="true" label-width="80px">
        <el-form-item label="导出实体">
          <el-select v-model="exportEntity" style="width: 200px">
            <el-option v-for="opt in exportOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="exporting" @click="doExport">导出 Excel</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.import-result {
  margin-top: 8px;
}
</style>
