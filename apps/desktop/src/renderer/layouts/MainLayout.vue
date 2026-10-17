<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { MENU } from '../router';
import { useThemeStore } from '../stores/theme';
import { useAuthStore } from '../stores/auth';

const route = useRoute();
const router = useRouter();
const theme = useThemeStore();
const auth = useAuthStore();
theme.apply();
auth.restore();

const active = computed(() => route.path);
const isDark = computed({
  get: () => theme.isDark,
  set: (value: boolean) => theme.set(value ? 'dark' : 'light'),
});

/** 按当前用户角色的菜单权限过滤侧边栏。 */
const menu = computed(() =>
  MENU.map((group) => ({ ...group, items: group.items.filter((item) => auth.canAccess(item.path)) })).filter(
    (group) => group.items.length > 0,
  ),
);

/** 头像取显示名首字，兼顾中英文。 */
const avatarText = computed(() => (auth.displayName || '?').trim().slice(0, 1).toUpperCase());

async function logout(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定退出登录？', '退出确认', { type: 'warning' });
  } catch {
    return;
  }
  auth.logout();
  await router.replace('/login');
}
</script>

<template>
  <el-container class="layout">
    <el-aside width="236px" class="aside">
      <div class="brand">
        <span class="brand-mark">轻</span>
        <span class="brand-text">
          <span class="brand-name">轻松进销存</span>
          <span class="brand-sub">进销存 · 库存 · 账目</span>
        </span>
      </div>
      <el-menu :default-active="active" router class="menu">
        <el-menu-item index="/workbench">工作台</el-menu-item>
        <el-sub-menu v-for="group in menu" :key="group.title" :index="group.title">
          <template #title>{{ group.title }}</template>
          <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path">
            {{ item.title }}
          </el-menu-item>
        </el-sub-menu>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="page-head">
          <span class="page-group">{{ route.meta.group ?? '工作台' }}</span>
          <span class="page-title">{{ route.meta.title ?? '工作台' }}</span>
        </div>
        <div class="header-right">
          <el-tag v-if="auth.roleName" size="small" type="info" effect="plain">{{ auth.roleName }}</el-tag>
          <span class="user">
            <span class="avatar">{{ avatarText }}</span>
            <span class="user-name">{{ auth.displayName }}</span>
          </span>
          <span class="divider" />
          <el-switch v-model="isDark" active-text="深色" inactive-text="浅色" inline-prompt />
          <el-button link @click="logout">退出登录</el-button>
        </div>
      </el-header>
      <el-main class="main">
        <transition name="page" mode="out-in">
          <router-view :key="route.path" />
        </transition>
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
/* 品牌区：方章 + 主副标题两行，比单行纯文字更有识别度 */
.brand-mark {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 9px;
  background: var(--brand);
  color: var(--brand-ink);
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  letter-spacing: 0;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand-name {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.brand-sub {
  font-size: 10.5px;
  font-weight: 400;
  color: var(--text-3);
  letter-spacing: 0.02em;
}

/* 顶栏：上方分组小标题 + 下方页面名，充当轻量面包屑 */
.page-head {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.page-group {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--text-3);
}

.page-title {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--text);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user {
  display: flex;
  align-items: center;
  gap: 8px;
}

.avatar {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  background: var(--surface-3);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.user-name {
  font-size: 13px;
  color: var(--text-2);
}

.divider {
  width: 1px;
  height: 18px;
  background: var(--border);
}
</style>
