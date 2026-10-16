<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { api, useCrud } from '../../composables/useCrud';

/** 供应商（supplier 表）。 */
interface SupplierRow {
  id: string;
  name: string;
  contact: string | null;
  phone: string | null;
  address: string | null;
  settle_type: string | null;
  status: number;
}

const { rows, loading, save, remove } = useCrud<SupplierRow>('supplier');

const searchForm = reactive({ keyword: '' });

const dialogVisible = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<SupplierRow>({
  id: '',
  name: '',
  contact: null,
  phone: null,
  address: null,
  settle_type: null,
  status: 1,
});

const rules: FormRules = {
  name: [{ required: true, message: '请输入供应商名称', trigger: 'blur' }],
};

/** 列表查询：有关键字走 search，否则走 query。 */
async function refresh(): Promise<void> {
  loading.value = true;
  try {
    const key = searchForm.keyword.trim();
    if (key) {
      rows.value = (await api().search('supplier', {
        keyword: key,
        fields: ['name', 'contact', 'phone'],
      })) as unknown as SupplierRow[];
    } else {
      rows.value = (await api().query('supplier')) as unknown as SupplierRow[];
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

function resetSearch(): void {
  searchForm.keyword = '';
  void refresh();
}

function resetForm(): void {
  Object.assign(form, {
    id: '',
    name: '',
    contact: null,
    phone: null,
    address: null,
    settle_type: null,
    status: 1,
  });
}

function openCreate(): void {
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row: SupplierRow): void {
  Object.assign(form, {
    id: row.id,
    name: row.name ?? '',
    contact: row.contact ?? null,
    phone: row.phone ?? null,
    address: row.address ?? null,
    settle_type: row.settle_type ?? null,
    status: Number(row.status) || 0,
  });
  dialogVisible.value = true;
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (valid === false) return;
  saving.value = true;
  try {
    await save({
      id: form.id || undefined,
      name: form.name.trim(),
      contact: form.contact?.trim() || null,
      phone: form.phone?.trim() || null,
      address: form.address?.trim() || null,
      settle_type: form.settle_type?.trim() || null,
      status: form.status,
    });
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    await refresh();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(row: SupplierRow): Promise<void> {
  const next = row.status ? 0 : 1;
  try {
    await ElMessageBox.confirm(`确定${next ? '启用' : '停用'}供应商「${row.name}」？`, '状态变更', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await save({ id: row.id, status: next });
    ElMessage.success(next ? '已启用' : '已停用');
    await refresh();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function onDelete(row: SupplierRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除供应商「${row.name}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await remove(row.id);
    ElMessage.success('删除成功');
    await refresh();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

onMounted(refresh);
</script>

<template>
  <div>
    <el-card class="card-gap">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="关键字">
          <el-input
            v-model="searchForm.keyword"
            placeholder="供应商名称 / 联系人 / 电话"
            clearable
            style="width: 240px"
            @keyup.enter="refresh"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="refresh">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="success" @click="openCreate">新增供应商</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <el-table v-loading="loading" :data="rows" empty-text="暂无数据" border stripe>
        <el-table-column prop="name" label="供应商名称" min-width="160" />
        <el-table-column prop="contact" label="联系人" width="120" />
        <el-table-column prop="phone" label="电话" width="150" />
        <el-table-column prop="settle_type" label="结算方式" width="130" />
        <el-table-column prop="address" label="地址" min-width="180" />
        <el-table-column label="状态" width="100">
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
            <el-button link type="danger" size="small" @click="onDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑供应商' : '新增供应商'" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="供应商名称" prop="name">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="form.contact" />
        </el-form-item>
        <el-form-item label="电话">
          <el-input v-model="form.phone" />
        </el-form-item>
        <el-form-item label="结算方式">
          <el-input v-model="form.settle_type" placeholder="如 现结 / 月结" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="form.address" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch
            v-model="form.status"
            :active-value="1"
            :inactive-value="0"
            active-text="启用"
            inactive-text="停用"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
