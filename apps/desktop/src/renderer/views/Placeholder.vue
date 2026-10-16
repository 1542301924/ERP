<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <el-card>
    <el-empty :description="`${title} —— P0 占位页面，功能将在后续阶段实现`" />
  </el-card>
</template>
