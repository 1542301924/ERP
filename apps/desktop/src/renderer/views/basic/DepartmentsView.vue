<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { api, useCrud } from '../../composables/useCrud';

/** 部门（department 表）。 */
interface DepartmentRow {
  id: string;
  name: string;
  manager: string | null;
  status: number;
}

const { rows, loading, save, remove } = useCrud<DepartmentRow>('department');

const searchForm = reactive({ keyword: '' });

const dialogVisible = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<DepartmentRow>({ id: '', name: '', manager: null, status: 1 });

const rules: FormRules = {
  name: [{ required: true, message: '请输入部门名称', trigger: 'blur' }],
};

/** 列表查询：有关键字走 search，否则走 query。 */
async function refresh(): Promise<void> {
  loading.value = true;
  try {
    const key = searchForm.keyword.trim();
    if (key) {
      rows.value = (await api().search('department', {
        keyword: key,
        fields: ['name', 'manager'],
      })) as unknown as DepartmentRow[];
    } else {
      rows.value = (await api().query('department')) as unknown as DepartmentRow[];
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
  Object.assign(form, { id: '', name: '', manager: null, status: 1 });
}

function openCreate(): void {
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row: DepartmentRow): void {
  Object.assign(form, {
    id: row.id,
    name: row.name ?? '',
    manager: row.manager ?? null,
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
      manager: form.manager?.trim() || null,
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

async function toggleStatus(row: DepartmentRow): Promise<void> {
  const next = row.status ? 0 : 1;
  try {
    await ElMessageBox.confirm(`确定${next ? '启用' : '停用'}部门「${row.name}」？`, '状态变更', { type: 'warning' });
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

async function onDelete(row: DepartmentRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除部门「${row.name}」？`, '删除确认', { type: 'warning' });
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
            placeholder="部门名称 / 负责人"
            clearable
            style="width: 220px"
            @keyup.enter="refresh"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="refresh">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="success" @click="openCreate">新增部门</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <el-table v-loading="loading" :data="rows" empty-text="暂无数据" border stripe>
        <el-table-column prop="name" label="部门名称" min-width="180" />
        <el-table-column prop="manager" label="负责人" min-width="160" />
        <el-table-column label="状态" width="120">
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

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑部门' : '新增部门'" width="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="部门名称" prop="name">
          <el-input v-model="form.name" placeholder="如 采购部" />
        </el-form-item>
        <el-form-item label="负责人">
          <el-input v-model="form.manager" />
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
