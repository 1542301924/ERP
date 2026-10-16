<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { api } from '../../composables/useCrud';

interface CategoryNode {
  id: string;
  parent_id: string | null;
  code: string | null;
  name: string;
  sort: number;
  status: number;
  children: CategoryNode[];
}

interface CategoryForm {
  id: string;
  parent_id: string | null;
  code: string | null;
  name: string;
  sort: number;
  status: number;
}

const treeData = ref<CategoryNode[]>([]);
const loading = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<CategoryForm>({
  id: '',
  parent_id: null,
  code: null,
  name: '',
  sort: 0,
  status: 1,
});

const treeProps = { label: 'name', children: 'children' };

const rules: FormRules = {
  name: [{ required: true, message: '请输入类别名称', trigger: 'blur' }],
};

/** 把树压平成下拉选项（带缩进，便于选择上级类别）。 */
const parentOptions = computed(() => flatten(treeData.value));

function flatten(nodes: CategoryNode[], depth = 0, acc: { id: string; label: string }[] = []) {
  for (const node of nodes) {
    acc.push({ id: node.id, label: `${'　'.repeat(depth)}${node.name}` });
    if (node.children?.length) {
      flatten(node.children, depth + 1, acc);
    }
  }
  return acc;
}

async function loadTree(): Promise<void> {
  loading.value = true;
  try {
    treeData.value = (await api().categoryTree()) as unknown as CategoryNode[];
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

function resetForm(): void {
  Object.assign(form, { id: '', parent_id: null, code: null, name: '', sort: 0, status: 1 });
}

function openEdit(node: CategoryNode): void {
  Object.assign(form, {
    id: node.id,
    parent_id: node.parent_id ?? null,
    code: node.code ?? null,
    name: node.name ?? '',
    sort: Number(node.sort) || 0,
    status: Number(node.status) || 0,
  });
}

function openAddChild(node: CategoryNode): void {
  resetForm();
  form.parent_id = node.id;
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (valid === false) return;
  saving.value = true;
  try {
    await api().saveCategory({
      id: form.id || undefined,
      parent_id: form.parent_id || null,
      code: form.code?.trim() || null,
      name: form.name.trim(),
      sort: Number(form.sort) || 0,
      status: form.status,
    });
    ElMessage.success('保存成功');
    resetForm();
    await loadTree();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

async function onDelete(node: CategoryNode): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除类别「${node.name}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api().deleteCategory(node.id);
    ElMessage.success('删除成功');
    if (form.id === node.id) resetForm();
    await loadTree();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

onMounted(loadTree);
</script>

<template>
  <el-row :gutter="16">
    <el-col :span="14">
      <el-card>
        <template #header>
          <div class="card-head">
            <span>类别树</span>
            <div>
              <el-button size="small" @click="resetForm">新增顶级类别</el-button>
              <el-button size="small" @click="loadTree">刷新</el-button>
            </div>
          </div>
        </template>
        <div v-loading="loading">
          <el-tree
            v-if="treeData.length"
            :data="treeData"
            node-key="id"
            :props="treeProps"
            default-expand-all
            :expand-on-click-node="false"
          >
            <template #default="{ data }">
              <span class="tree-node">
                <span class="tree-label">{{ data.name }}</span>
                <el-tag v-if="data.code" size="small" type="info">{{ data.code }}</el-tag>
                <el-tag size="small" :type="data.status ? 'success' : 'info'">
                  {{ data.status ? '启用' : '停用' }}
                </el-tag>
                <el-button link type="primary" size="small" @click.stop="openAddChild(data)">新增子类</el-button>
                <el-button link type="primary" size="small" @click.stop="openEdit(data)">编辑</el-button>
                <el-button link type="danger" size="small" @click.stop="onDelete(data)">删除</el-button>
              </span>
            </template>
          </el-tree>
          <el-empty v-else description="暂无类别，请新增" />
        </div>
      </el-card>
    </el-col>

    <el-col :span="10">
      <el-card>
        <template #header>{{ form.id ? '编辑类别' : '新增类别' }}</template>
        <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
          <el-form-item label="类别名称" prop="name">
            <el-input v-model="form.name" />
          </el-form-item>
          <el-form-item label="类别编码">
            <el-input v-model="form.code" />
          </el-form-item>
          <el-form-item label="上级类别">
            <el-select v-model="form.parent_id" clearable placeholder="顶级类别" style="width: 100%">
              <el-option
                v-for="opt in parentOptions"
                :key="opt.id"
                :label="opt.label"
                :value="opt.id"
                :disabled="opt.id === form.id"
              />
            </el-select>
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
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
        <el-button @click="resetForm">重置</el-button>
      </el-card>
    </el-col>
  </el-row>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tree-node {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.tree-label {
  font-weight: 500;
}
</style>
