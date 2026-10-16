<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { useCrud } from '../../composables/useCrud';

/** 编码规则（code_rule 表）。 */
interface CodeRuleRow {
  id: string;
  target: string;
  prefix: string | null;
  category_code: string | null;
  seq_len: number;
  next_seq: number;
}

const targetOptions = ['product', 'customer', 'supplier', 'doc_no'];

const { rows, loading, load, save, remove } = useCrud<CodeRuleRow>('code_rule');

const dialogVisible = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const form = reactive<CodeRuleRow>({
  id: '',
  target: 'product',
  prefix: null,
  category_code: null,
  seq_len: 4,
  next_seq: 1,
});

const rules: FormRules = {
  target: [{ required: true, message: '请输入目标实体', trigger: 'blur' }],
};

/** 客户端预览样例编码：prefix + category_code + 定长的 next_seq（不触发 nextCode 副作用）。 */
function preview(row: Pick<CodeRuleRow, 'prefix' | 'category_code' | 'seq_len' | 'next_seq'>): string {
  const prefix = row.prefix ?? '';
  const category = row.category_code ?? '';
  const len = Math.max(0, Number(row.seq_len) || 0);
  const seq = String(Number(row.next_seq) || 1).padStart(len, '0');
  return `${prefix}${category}${seq}`;
}

function resetForm(): void {
  Object.assign(form, { id: '', target: 'product', prefix: null, category_code: null, seq_len: 4, next_seq: 1 });
}

function openCreate(): void {
  resetForm();
  dialogVisible.value = true;
}

function openEdit(row: CodeRuleRow): void {
  Object.assign(form, {
    id: row.id,
    target: row.target ?? '',
    prefix: row.prefix ?? null,
    category_code: row.category_code ?? null,
    seq_len: Number(row.seq_len) || 0,
    next_seq: Number(row.next_seq) || 0,
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
      target: form.target.trim(),
      prefix: form.prefix?.trim() || null,
      category_code: form.category_code?.trim() || null,
      seq_len: Number(form.seq_len) || 0,
      next_seq: Number(form.next_seq) || 0,
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

async function onDelete(row: CodeRuleRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除编码规则「${row.target}」？`, '删除确认', { type: 'warning' });
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
      <el-button type="primary" @click="openCreate">新增规则</el-button>
      <el-button @click="load">刷新</el-button>
      <span class="hint">预览为客户端计算示例，不会消耗流水号</span>
    </el-card>

    <el-card>
      <el-table v-loading="loading" :data="rows" empty-text="暂无数据" border stripe>
        <el-table-column prop="target" label="目标实体" width="140" />
        <el-table-column prop="prefix" label="前缀" width="120" />
        <el-table-column prop="category_code" label="类别编码" width="120" />
        <el-table-column prop="seq_len" label="序号长度" width="110" />
        <el-table-column prop="next_seq" label="下一个序号" width="120" />
        <el-table-column label="预览" min-width="160">
          <template #default="{ row }">
            <span class="preview">{{ preview(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="onDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑编码规则' : '新增编码规则'" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="目标实体" prop="target">
          <el-select
            v-model="form.target"
            filterable
            allow-create
            default-first-option
            placeholder="如 product / customer"
            style="width: 100%"
          >
            <el-option v-for="opt in targetOptions" :key="opt" :label="opt" :value="opt" />
          </el-select>
        </el-form-item>
        <el-form-item label="前缀">
          <el-input v-model="form.prefix" />
        </el-form-item>
        <el-form-item label="类别编码">
          <el-input v-model="form.category_code" />
        </el-form-item>
        <el-form-item label="序号长度">
          <el-input-number v-model="form.seq_len" :min="0" :max="12" />
        </el-form-item>
        <el-form-item label="下一个序号">
          <el-input-number v-model="form.next_seq" :min="0" />
        </el-form-item>
        <el-form-item label="预览">
          <span class="preview">{{ preview(form) }}</span>
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
.hint {
  margin-left: 12px;
  color: var(--text-muted);
  font-size: 12px;
}
.preview {
  font-family: 'SFMono-Regular', Consolas, monospace;
}
</style>
