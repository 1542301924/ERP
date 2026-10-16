<script setup lang="ts">
import ReportView from '../../components/ReportView.vue';

const groupOptions = [
  { label: '按商品', value: 'product' as const },
  { label: '按仓库', value: 'warehouse' as const },
];
</script>

<template>
  <ReportView kind="inventory_summary" show-keyword show-warehouse show-product :group-options="groupOptions" />
</template>
