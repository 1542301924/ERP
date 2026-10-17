<script setup lang="ts">
/**
 * 设置页：外观主题 · 通用开关 · 业务规则 · 主节点地址 · 关于。
 *
 * 主题复用全局 theme store（localStorage 持久化，与顶栏开关同一份状态）；
 * 开关类设置改动即保存到 sys_config；同步项与「同步中心」共用同一份配置。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../../composables/useCrud';
import { useThemeStore } from '../../stores/theme';
import type { AppInfo, AppSettings, SyncConfigShape } from '../../../../env';

const router = useRouter();
const theme = useThemeStore();

const loading = ref(false);
const saving = ref(false);

const settings = reactive<AppSettings>({ allowNegativeStock: false, autoLaunch: false });
const info = ref<AppInfo | null>(null);
const sync = reactive<{ role: SyncConfigShape['role']; masterUrl: string; port: number }>({
  role: 'standalone',
  masterUrl: '',
  port: 8765,
});

const isDark = computed({
  get: () => theme.isDark,
  set: (value: boolean) => theme.set(value ? 'dark' : 'light'),
});

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [s, cfg, app] = await Promise.all([api().getSettings(), api().sync.getConfig(), api().info()]);
    Object.assign(settings, s);
    Object.assign(sync, { role: cfg.role, masterUrl: cfg.masterUrl, port: cfg.port });
    info.value = app;
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    loading.value = false;
  }
}

/** 开关类设置：改动即保存；失败则回滚为库内值。 */
async function saveSwitch(patch: Partial<AppSettings>): Promise<void> {
  saving.value = true;
  try {
    const next = await api().setSettings(patch);
    Object.assign(settings, next);
    ElMessage.success('已保存');
  } catch (err) {
    ElMessage.error(message(err));
    await load();
  } finally {
    saving.value = false;
  }
}

async function saveSync(): Promise<void> {
  saving.value = true;
  try {
    const saved = await api().sync.setConfig({
      role: sync.role,
      masterUrl: sync.masterUrl.trim(),
      port: Number(sync.port) || 8765,
    });
    Object.assign(sync, { role: saved.role, masterUrl: saved.masterUrl, port: saved.port });
    ElMessage.success('主节点配置已保存');
  } catch (err) {
    ElMessage.error(message(err));
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <el-card class="card-gap">
      <template #header>界面与外观</template>
      <div class="row">
        <span class="label">主题</span>
        <el-switch v-model="isDark" active-text="深色" inactive-text="浅色" inline-prompt />
        <span class="hint">切换后立即生效，下次启动沿用</span>
      </div>
    </el-card>

    <el-card class="card-gap">
      <template #header>通用</template>
      <div class="row">
        <span class="label">开机自启</span>
        <el-switch
          v-model="settings.autoLaunch"
          :loading="saving"
          @change="() => saveSwitch({ autoLaunch: settings.autoLaunch })"
        />
        <span class="hint">开机后自动启动本软件（便携版需保持 exe 位置不变）</span>
      </div>
    </el-card>

    <el-card class="card-gap">
      <template #header>业务规则</template>
      <div class="row">
        <span class="label">允许负库存</span>
        <el-switch
          v-model="settings.allowNegativeStock"
          :loading="saving"
          @change="() => saveSwitch({ allowNegativeStock: settings.allowNegativeStock })"
        />
        <span class="hint">
          关闭（默认）时，出库 / 调拨审核会校验可用量，不足则不允许生效；开启后不做校验，可出成负数（不建议）
        </span>
      </div>
    </el-card>

    <el-card class="card-gap">
      <template #header>网络与同步</template>
      <el-form label-width="110px" class="sync-form">
        <el-form-item label="节点角色">
          <el-select v-model="sync.role" style="width: 200px">
            <el-option label="单机（不同步）" value="standalone" />
            <el-option label="主节点" value="master" />
            <el-option label="客户端" value="client" />
          </el-select>
        </el-form-item>
        <el-form-item label="主节点 IP">
          <el-input v-model="sync.masterUrl" placeholder="如 192.168.1.10:8765" style="width: 260px" />
        </el-form-item>
        <el-form-item label="服务端口">
          <el-input-number v-model="sync.port" :min="1024" :max="65535" controls-position="right" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="saveSync">保存</el-button>
          <el-button @click="router.push('/system/sync')">前往同步中心</el-button>
        </el-form-item>
      </el-form>
      <div class="hint">与「同步中心」共用同一份配置；冲突处理与手动同步请到同步中心操作。</div>
    </el-card>

    <el-card>
      <template #header>关于</template>
      <el-descriptions v-if="info" :column="1" border>
        <el-descriptions-item label="软件名称">{{ info.name }}</el-descriptions-item>
        <el-descriptions-item label="版本">{{ info.version }}</el-descriptions-item>
        <el-descriptions-item label="数据库版本">v{{ info.schemaVersion }}</el-descriptions-item>
        <el-descriptions-item label="设备 ID">{{ info.deviceId }}</el-descriptions-item>
        <el-descriptions-item label="数据文件">{{ info.dbFile }}</el-descriptions-item>
        <el-descriptions-item label="数据目录">{{ info.userDataDir }}</el-descriptions-item>
        <el-descriptions-item label="备份目录">{{ info.backupsDir }}</el-descriptions-item>
      </el-descriptions>
    </el-card>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.label {
  min-width: 96px;
  color: var(--el-text-color-regular);
}
.sync-form {
  max-width: 560px;
}
</style>
