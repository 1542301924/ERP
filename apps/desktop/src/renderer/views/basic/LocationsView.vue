<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { api } from '../../composables/useCrud';

interface WarehouseRow {
  id: string;
  name: string;
}

interface LocationRow {
  id: string;
  warehouse_id: string;
  parent_id: string | null;
  code: string | null;
  name: string;
  sort: number;
  status: number;
}

interface LocationNode extends LocationRow {
  children: LocationNode[];
}

const warehouses = ref<WarehouseRow[]>([]);
const flatLocations = ref<LocationRow[]>([]);
const loading = ref(false);
const selectedWarehouse = ref('');

const dialogVisible = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<LocationRow>({
  id: '',
  warehouse_id: '',
  parent_id: null,
  code: null,
  name: '',
  sort: 0,
  status: 1,
});

const treeProps = { label: 'name', children: 'children' };

const rules: FormRules = {
  name: [{ required: true, message: '请输入货位名称', trigger: 'blur' }],
};

/** 客户端按 parent_id 组装货位树。 */
function buildTree(list: LocationRow[], parentId: string | null): LocationNode[] {
  return list
    .filter((item) => (item.parent_id ?? null) === parentId)
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    .map((item) => ({ ...item, children: buildTree(list, item.id) }));
}

const treeData = computed<LocationNode[]>(() =>
  buildTree(flatLocations.value, null),
);

async function loadWarehouses(): Promise<void> {
  try {
    warehouses.value = (await api().query('warehouse')) as unknown as WarehouseRow[];
    if (!selectedWarehouse.value && warehouses.value.length) {
      selectedWarehouse.value = warehouses.value[0].id;
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function loadLocations(): Promise<void> {
  if (!selectedWarehouse.value) {
    flatLocations.value = [];
    return;
  }
  loading.value = true;
  try {
    flatLocations.value = (await api().search('location', {
      equals: { warehouse_id: selectedWarehouse.value },
    })) as unknown as LocationRow[];
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

function resetForm(): void {
  Object.assign(form, {
    id: '',
    warehouse_id: selectedWarehouse.value,
    parent_id: null,
    code: null,
    name: '',
    sort: 0,
    status: 1,
  });
}

function openAddRoot(): void {
  if (!selectedWarehouse.value) {
    ElMessage.warning('请先选择仓库');
    return;
  }
  resetForm();
  dialogVisible.value = true;
}

function openAddChild(node: LocationNode): void {
  resetForm();
  form.parent_id = node.id;
  dialogVisible.value = true;
}

function openEdit(node: LocationNode): void {
  Object.assign(form, {
    id: node.id,
    warehouse_id: node.warehouse_id,
    parent_id: node.parent_id ?? null,
    code: node.code ?? null,
    name: node.name ?? '',
    sort: Number(node.sort) || 0,
    status: Number(node.status) || 0,
  });
  dialogVisible.value = true;
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (valid === false) return;
  saving.value = true;
  try {
    const payload = {
      warehouse_id: form.warehouse_id || selectedWarehouse.value,
      parent_id: form.parent_id || null,
      code: form.code?.trim() || null,
      name: form.name.trim(),
      sort: Number(form.sort) || 0,
      status: form.status,
    };
    if (form.id) {
      await api().mutate({ op: 'update', entity: 'location', id: form.id, patch: payload });
    } else {
      await api().mutate({ op: 'insert', entity: 'location', values: payload });
    }
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    await loadLocations();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

async function onDelete(node: LocationNode): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除货位「${node.name}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api().mutate({ op: 'delete', entity: 'location', id: node.id });
    ElMessage.success('删除成功');
    await loadLocations();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

async function onWarehouseChange(): Promise<void> {
  await loadLocations();
}

onMounted(async () => {
  await loadWarehouses();
  await loadLocations();
});
</script>

<template>
  <div>
    <el-card class="card-gap">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="仓库">
          <el-select
            v-model="selectedWarehouse"
            placeholder="请选择仓库"
            style="width: 220px"
            @change="onWarehouseChange"
          >
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="openAddRoot">新增顶级货位</el-button>
          <el-button @click="loadLocations">刷新</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
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
              <el-button link type="primary" size="small" @click.stop="openAddChild(data)">新增子货位</el-button>
              <el-button link type="primary" size="small" @click.stop="openEdit(data)">编辑</el-button>
              <el-button link type="danger" size="small" @click.stop="onDelete(data)">删除</el-button>
            </span>
          </template>
        </el-tree>
        <el-empty v-else description="该仓库暂无货位" />
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑货位' : '新增货位'" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="货位名称" prop="name">
          <el-input v-model="form.name" placeholder="如 A区-01-01" />
        </el-form-item>
        <el-form-item label="编码">
          <el-input v-model="form.code" />
        </el-form-item>
        <el-form-item label="上级货位">
          <span class="muted">{{ form.parent_id ? '已在所选节点下新增' : '顶级货位' }}</span>
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

<style scoped>
.tree-node {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.tree-label {
  font-weight: 500;
}
.muted {
  color: var(--text-muted);
}
</style>
