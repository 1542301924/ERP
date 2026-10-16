<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { useCrud } from '../../composables/useCrud';

/** 计量单位（unit 表）。 */
interface UnitRow {
  id: string;
  name: string;
  sort: number;
  status: number;
}

const { rows, loading, load, save, remove } = useCrud<UnitRow>('unit');

const dialogVisible = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<UnitRow>({ id: '', name: '', sort: 0, status: 1 });

const rules: FormRules = {
  name: [{ required: true, message: '请输入单位名称', trigger: 'blur' }],
};

function resetForm(): void {
  Object.assign(form, { id: '', name: '', sort: 0, status: 1 });
}

function openCreate(): void {
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row: UnitRow): void {
  Object.assign(form, {
    id: row.id,
    name: row.name ?? '',
    sort: Number(row.sort) || 0,
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
      sort: Number(form.sort) || 0,
      status: form.status,
    });
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(row: UnitRow): Promise<void> {
  const next = row.status ? 0 : 1;
  try {
    await ElMessageBox.confirm(`确定${next ? '启用' : '停用'}「${row.name}」？`, '状态变更', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await save({ id: row.id, status: next });
    ElMessage.success(next ? '已启用' : '已停用');
    await load();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function onDelete(row: UnitRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除计量单位「${row.name}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await remove(row.id);
    ElMessage.success('删除成功');
    await load();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

onMounted(load);
</script>

<template>
  <div>
    <el-card class="card-gap">
      <el-button type="primary" @click="openCreate">新增单位</el-button>
      <el-button @click="load">刷新</el-button>
    </el-card>

    <el-card>
      <el-table v-loading="loading" :data="rows" empty-text="暂无数据" border stripe>
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column prop="sort" label="排序" width="120" />
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

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑计量单位' : '新增计量单位'" width="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="如 个 / 箱 / 千克" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" />
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
