<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../composables/useCrud';
import type { SyncConflictRow, SyncConfigShape, SyncState } from '../../../../env';

const state = ref<SyncState | null>(null);
const conflicts = ref<SyncConflictRow[]>([]);
const loading = ref(false);
const syncing = ref(false);
const busy = ref(false);

const form = ref<SyncConfigShape>({ role: 'standalone', masterUrl: '', port: 8765, intervalMs: 15000 });
const onlyPending = ref(true);

const resultText = ref('');

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatTime(at: number | null): string {
  if (!at) return '—';
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const roleTip = computed(() => {
  switch (form.value.role) {
    case 'master':
      return '本机作为主节点：启动 LAN 服务后，其他电脑填入本机地址即可同步。';
    case 'client':
      return '本机作为客户端：填写主节点地址，点「立即同步」或启动后台同步。';
    default:
      return '单机模式：不参与多端同步，数据仅保存在本机。';
  }
});

async function loadState(): Promise<void> {
  loading.value = true;
  try {
    const s = await api().sync.state();
    state.value = s;
    form.value = { ...s.config };
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    loading.value = false;
  }
}

async function loadConflicts(): Promise<void> {
  try {
    conflicts.value = await api().sync.conflicts(onlyPending.value ? { status: 0 } : {});
  } catch (err) {
    conflicts.value = [];
    ElMessage.error(message(err));
  }
}

async function refresh(): Promise<void> {
  await Promise.all([loadState(), loadConflicts()]);
}

async function saveConfig(): Promise<void> {
  busy.value = true;
  try {
    const saved = await api().sync.setConfig({ ...form.value });
    form.value = { ...saved };
    ElMessage.success('同步配置已保存');
    await loadState();
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    busy.value = false;
  }
}

async function syncNow(): Promise<void> {
  syncing.value = true;
  try {
    const r = await api().sync.now();
    if (r.ok) {
      resultText.value = `推送 ${r.pushed} 条，拉取 ${r.pulled} 条，冲突 ${r.conflicts} 条`;
      ElMessage.success(`同步完成：${resultText.value}`);
    } else {
      ElMessage.error(r.error ?? '同步失败');
    }
    await refresh();
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    syncing.value = false;
  }
}

async function toggleServer(): Promise<void> {
  busy.value = true;
  try {
    if (state.value?.server.running) {
      await api().sync.stopServer();
      ElMessage.info('主节点服务已停止');
    } else {
      const info = await api().sync.startServer();
      ElMessage.success(`主节点服务已启动：${info.url}`);
    }
    await loadState();
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    busy.value = false;
  }
}

async function toggleEngine(): Promise<void> {
  busy.value = true;
  try {
    if (state.value?.engineRunning) {
      await api().sync.stopEngine();
      ElMessage.info('后台同步已停止');
    } else {
      await api().sync.startEngine();
      ElMessage.success('后台同步已启动');
    }
    await loadState();
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    busy.value = false;
  }
}

async function resolve(row: SyncConflictRow, pick: 'a' | 'b'): Promise<void> {
  const value = pick === 'a' ? row.value_a : row.value_b;
  try {
    await ElMessageBox.confirm(
      `将 ${row.entity} 字段「${row.field}」裁决为：${value ?? '（空）'}？该值会写回并同步到其他端。`,
      '人工裁决冲突',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await api().sync.resolve({ id: row.id, resolvedValue: value });
    ElMessage.success('冲突已裁决');
    await refresh();
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
          <el-statistic title="待同步条数" :value="state?.status.pendingCount ?? 0" />
          <el-statistic title="待处理冲突" :value="state?.status.conflictCount ?? 0" />
          <div class="stat">
            <div class="stat-title">上次同步</div>
            <div class="stat-value">{{ formatTime(state?.status.lastSyncAt ?? null) }}</div>
          </div>
          <div class="stat">
            <div class="stat-title">本机设备</div>
            <div class="stat-value mono">{{ state?.status.deviceId ?? '—' }}</div>
          </div>
        </div>
        <div class="actions">
          <el-button :loading="syncing" type="primary" @click="syncNow">立即同步</el-button>
          <el-button :loading="loading" @click="refresh">刷新</el-button>
        </div>
      </div>
    </el-card>

    <el-card class="card-gap">
      <template #header>同步配置</template>
      <el-form label-width="120px" class="config-form">
        <el-form-item label="节点角色">
          <el-radio-group v-model="form.role">
            <el-radio-button value="standalone">单机</el-radio-button>
            <el-radio-button value="master">主节点</el-radio-button>
            <el-radio-button value="client">客户端</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.role === 'client'" label="主节点地址">
          <el-input v-model="form.masterUrl" placeholder="http://192.168.1.10:8765" />
        </el-form-item>
        <el-form-item v-if="form.role !== 'standalone'" label="LAN 端口">
          <el-input-number v-model="form.port" :min="1024" :max="65535" />
        </el-form-item>
        <el-form-item v-if="form.role === 'client'" label="同步间隔(ms)">
          <el-input-number v-model="form.intervalMs" :min="1000" :step="1000" />
        </el-form-item>
        <el-form-item>
          <el-button :loading="busy" type="primary" @click="saveConfig">保存配置</el-button>
          <span class="tip">{{ roleTip }}</span>
        </el-form-item>
      </el-form>

      <el-divider />

      <div class="server-bar">
        <div>
          <span class="label">主节点 LAN 服务：</span>
          <el-tag :type="state?.server.running ? 'success' : 'info'">
            {{ state?.server.running ? `运行中 ${state?.server.url}` : '未启动' }}
          </el-tag>
        </div>
        <div>
          <span class="label">后台定时同步：</span>
          <el-tag :type="state?.engineRunning ? 'success' : 'info'">
            {{ state?.engineRunning ? '运行中' : '未启动' }}
          </el-tag>
        </div>
        <div class="actions">
          <el-button :loading="busy" @click="toggleServer">
            {{ state?.server.running ? '停止主节点服务' : '启动主节点服务' }}
          </el-button>
          <el-button :loading="busy" @click="toggleEngine">
            {{ state?.engineRunning ? '停止后台同步' : '启动后台同步' }}
          </el-button>
        </div>
      </div>
    </el-card>

    <el-card>
      <template #header>
        <div class="head">
          <span>冲突中心</span>
          <el-checkbox v-model="onlyPending" @change="loadConflicts">仅看待处理</el-checkbox>
        </div>
      </template>

      <el-table v-loading="loading" :data="conflicts" empty-text="暂无冲突" border stripe>
        <el-table-column prop="entity" label="实体" width="140" />
        <el-table-column prop="field" label="字段" width="130" />
        <el-table-column prop="value_a" label="本地值 A" min-width="140" />
        <el-table-column prop="value_b" label="远端值 B" min-width="140" />
        <el-table-column label="自动裁决" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="row.winner === 'a' ? 'info' : 'warning'">{{ row.winner }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 0 ? 'danger' : 'success'">
              {{ row.status === 0 ? '待处理' : '已裁决' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" align="center">
          <template #default="{ row }">
            <template v-if="row.status === 0">
              <el-button size="small" @click="resolve(row, 'a')">采用本地</el-button>
              <el-button size="small" type="primary" @click="resolve(row, 'b')">采用远端</el-button>
            </template>
            <span v-else class="tip">{{ row.resolved_value ?? '（空）' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.metrics {
  display: flex;
  align-items: flex-start;
  gap: 40px;
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
.mono {
  font-size: 14px;
  font-weight: normal;
  font-family: monospace;
}
.tip {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-left: 12px;
}
.config-form {
  max-width: 640px;
}
.server-bar {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}
.server-bar .label {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.actions {
  display: flex;
  gap: 8px;
}
</style>
