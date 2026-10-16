<script setup lang="ts">
import ReportView from '../../components/ReportView.vue';

const groupOptions = [
  { label: '按商品', value: 'product' as const },
  { label: '按客户', value: 'customer' as const },
  { label: '按业务员', value: 'handler' as const },
];
</script>

<template>
  <ReportView kind="gross_profit" show-customer show-product show-handler :group-options="groupOptions" />
</template>
