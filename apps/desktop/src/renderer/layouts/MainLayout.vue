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
    <el-aside width="240px" class="aside">
      <div class="brand">轻松进销存</div>
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
        <span class="title">{{ route.meta.title ?? '工作台' }}</span>
        <div class="header-right">
          <el-tag v-if="auth.roleName" size="small" type="info">{{ auth.roleName }}</el-tag>
          <span class="user">{{ auth.displayName }}</span>
          <el-switch
            v-model="isDark"
            active-text="深色"
            inactive-text="浅色"
            inline-prompt
          />
          <el-button link @click="logout">退出登录</el-button>
        </div>
      </el-header>
      <el-main class="main">
        <router-view :key="route.path" />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.user {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
</style>
