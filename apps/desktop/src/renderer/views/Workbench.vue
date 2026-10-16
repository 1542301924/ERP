<script setup lang="ts">
import { onMounted } from 'vue';
import { useConfigStore } from '../stores/config';
import { useThemeStore } from '../stores/theme';

const config = useConfigStore();
const theme = useThemeStore();

onMounted(() => {
  config.load();
});
</script>

<template>
  <div>
    <el-card class="card-gap">
      <template #header>工作台（占位）</template>
      <p>今日单据 · 库存预警 · 待同步提示——P0 阶段仅提供骨架，功能将在后续阶段实现。</p>
    </el-card>

    <el-card class="card-gap">
      <template #header>系统配置（读取本地 sys_config）</template>
      <el-descriptions :column="1" border>
        <el-descriptions-item label="禁止负库存 allow_negative_stock">
          {{ config.values.allow_negative_stock ?? '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="备份保留份数 backup_keep">
          {{ config.values.backup_keep ?? '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="局域网端口 lan_port">
          {{ config.values.lan_port ?? '-' }}
        </el-descriptions-item>
      </el-descriptions>
      <el-alert
        v-if="config.values._note"
        class="card-gap"
        style="margin-top: 12px"
        type="info"
        :title="config.values._note"
        :closable="false"
      />
    </el-card>

    <el-card>
      <template #header>主题切换</template>
      <el-button @click="theme.toggle()">
        切换到{{ theme.isDark ? '浅色' : '深色' }}主题
      </el-button>
      <span style="margin-left: 12px; color: var(--text-muted)">当前：{{ theme.mode }}</span>
    </el-card>
  </div>
</template>
