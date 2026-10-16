<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { MENU } from '../router';
import { useThemeStore } from '../stores/theme';

const route = useRoute();
const theme = useThemeStore();
theme.apply();

const active = computed(() => route.path);
const isDark = computed({
  get: () => theme.isDark,
  set: (value: boolean) => theme.set(value ? 'dark' : 'light'),
});
</script>

<template>
  <el-container class="layout">
    <el-aside width="240px" class="aside">
      <div class="brand">轻松进销存</div>
      <el-menu :default-active="active" router class="menu">
        <el-menu-item index="/workbench">工作台</el-menu-item>
        <el-sub-menu v-for="group in MENU" :key="group.title" :index="group.title">
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
        <el-switch
          v-model="isDark"
          active-text="深色"
          inactive-text="浅色"
          inline-prompt
        />
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>
