<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../composables/useCrud';
import type { BackupRecord } from '../../../../env';

const rows = ref<BackupRecord[]>([]);
const loading = ref(false);
const busy = ref(false);
const keep = ref(7);
const savedKeep = ref(7);

const kindLabel: Record<string, string> = { manual: '手动', auto: '自动', safety: '恢复前快照' };
const kindTag: Record<string, 'primary' | 'success' | 'warning' | 'info'> = {
  manual: 'primary',
  auto: 'success',
  safety: 'warning',
};

const lastBackupAt = computed(() => (rows.value.length ? rows.value[0].at : null));

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatTime(at: number | null): string {
  if (!at) return '—';
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = await api().backup.list();
  } catch (err) {
    rows.value = [];
    ElMessage.error(message(err));
  } finally {
    loading.value = false;
  }
}

async function loadKeep(): Promise<void> {
  try {
    keep.value = await api().backup.getKeep();
    savedKeep.value = keep.value;
  } catch (err) {
    ElMessage.error(message(err));
  }
}

async function refresh(): Promise<void> {
  await Promise.all([load(), loadKeep()]);
}

async function saveKeep(): Promise<void> {
  busy.value = true;
  try {
    keep.value = await api().backup.setKeep(keep.value);
    savedKeep.value = keep.value;
    ElMessage.success('保留份数已保存');
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    busy.value = false;
  }
}

async function backupNow(): Promise<void> {
  busy.value = true;
  try {
    const res = await api().backup.create();
    if (!res.ok) {
      ElMessage.error(res.error ?? '备份失败');
      return;
    }
    ElMessage.success('备份完成');
    await load();
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    busy.value = false;
  }
}

async function backupToPath(): Promise<void> {
  busy.value = true;
  try {
    const res = await api().backup.export();
    if (!res.ok) {
      ElMessage.error(res.error ?? '备份失败');
      return;
    }
    if (res.canceled) return;
    ElMessage.success('已备份到指定位置');
    await load();
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    busy.value = false;
  }
}

async function confirmAndRestore(filePath: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '恢复将用所选备份覆盖当前全部数据，恢复前会自动创建一份当前数据的快照；恢复完成后应用会自动重启。是否继续？',
      '恢复数据',
      { type: 'warning', confirmButtonText: '确认恢复', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    const res = await api().backup.restore(filePath);
    if (!res.ok) {
      ElMessage.error(res.error ?? '恢复失败');
      busy.value = false;
      return;
    }
    ElMessage.success('恢复完成，应用即将自动重启…');
  } catch (err) {
    ElMessage.error(message(err));
    busy.value = false;
  }
}

async function restoreFromFile(): Promise<void> {
  const picked = await api().backup.pickFile();
  if (!picked.ok || picked.canceled || !picked.path) return;
  await confirmAndRestore(picked.path);
}

async function remove(row: BackupRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除备份「${formatTime(row.at)}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    const res = await api().backup.remove(row.id);
    if (!res.ok) {
      ElMessage.error(res.error ?? '删除失败');
      return;
    }
    ElMessage.success('删除成功');
    await load();
  } catch (err) {
    ElMessage.error(message(err));
  }
}

onMounted(refresh);
</script>

<template>
  <div>
    <el-card class="card-gap">
      <div class="head">
        <div class="metrics">
          <el-statistic title="备份份数" :value="rows.length" />
          <div class="stat">
            <div class="stat-title">最近备份</div>
            <div class="stat-value">{{ formatTime(lastBackupAt) }}</div>
          </div>
          <div class="stat keep">
            <div class="stat-title">保留份数</div>
            <div class="keep-row">
              <el-input-number v-model="keep" :min="0" :max="100" :disabled="busy" controls-position="right" />
              <el-button :loading="busy" :disabled="keep === savedKeep" @click="saveKeep">保存</el-button>
            </div>
          </div>
        </div>
        <div class="actions">
          <el-button :loading="busy" type="primary" @click="backupNow">立即备份</el-button>
          <el-button :loading="busy" @click="backupToPath">备份到指定位置</el-button>
          <el-button :loading="busy" @click="restoreFromFile">从文件恢复</el-button>
          <el-button :loading="loading" @click="refresh">刷新</el-button>
        </div>
      </div>
      <div class="tip">备份为本地数据库单文件快照，可直接拷贝留存；恢复前会自动保存一份当前数据快照。</div>
    </el-card>

    <el-card>
      <template #header>备份记录</template>
      <el-table v-loading="loading" :data="rows" empty-text="暂无备份" border stripe>
        <el-table-column label="备份时间" width="180">
          <template #default="{ row }">{{ formatTime(row.at) }}</template>
        </el-table-column>
        <el-table-column label="类型" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="kindTag[row.kind] ?? 'info'">{{ kindLabel[row.kind] ?? row.kind }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="file_path" label="文件位置" min-width="320" show-overflow-tooltip />
        <el-table-column label="大小" width="110" align="right">
          <template #default="{ row }">{{ formatSize(row.size) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" width="140" />
        <el-table-column label="操作" width="180" align="center">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="confirmAndRestore(row.file_path)">恢复</el-button>
            <el-button size="small" type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  flex-wrap: wrap;
}
.metrics {
  display: flex;
  align-items: flex-start;
  gap: 40px;
  flex-wrap: wrap;
}
.stat-title {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-bottom: 6px;
}
.stat-value {
  font-size: 20px;
  font-weight: 600;
}
.keep-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.tip {
  margin-top: 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
