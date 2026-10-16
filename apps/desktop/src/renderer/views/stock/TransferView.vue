<script setup lang="ts">
import { onMounted, ref } from 'vue';
import StockDocFormDialog from '../../components/StockDocFormDialog.vue';
import { useStockDocPage, type StockDocListRow } from '../../composables/useStockDocPage';

const KIND = 'stock_transfer' as const;
const { rows, loading, filters, load, audit, unaudit, reverse, statusLabel, statusTagType, handlerName, formatDate } =
  useStockDocPage(KIND);

const dialogVisible = ref(false);
const dialogDocId = ref<string | undefined>(undefined);

function openCreate(): void {
  dialogDocId.value = undefined;
  dialogVisible.value = true;
}

function openEdit(row: StockDocListRow): void {
  dialogDocId.value = String(row.id ?? '');
  dialogVisible.value = true;
}

function resetSearch(): void {
  filters.keyword = '';
  filters.status = '';
  filters.dateRange = null;
  void load();
}

onMounted(load);
</script>

<template>
  <div>
    <el-card class="card-gap">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="关键字">
          <el-input
            v-model="filters.keyword"
            placeholder="单据编号 / 备注"
            clearable
            style="width: 220px"
            @keyup.enter="load"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 130px" value-on-clear="">
            <el-option label="待审核" :value="0" />
            <el-option label="已审核" :value="1" />
            <el-option label="已红冲" :value="9" />
          </el-select>
        </el-form-item>
        <el-form-item label="业务日期">
          <el-date-picker
            v-model="filters.dateRange"
            type="daterange"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            style="width: 260px"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="load">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
          <el-button type="success" @click="openCreate">新增调拨单</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card>
      <el-table v-loading="loading" :data="rows" empty-text="暂无调拨单" border stripe>
        <el-table-column prop="doc_no" label="单据编号" width="160" />
        <el-table-column prop="from_warehouse_name" label="调出仓库" min-width="140">
          <template #default="{ row }">{{ row.from_warehouse_name || '-' }}</template>
        </el-table-column>
        <el-table-column prop="to_warehouse_name" label="调入仓库" min-width="140">
          <template #default="{ row }">{{ row.to_warehouse_name || '-' }}</template>
        </el-table-column>
        <el-table-column label="业务日期" width="120">
          <template #default="{ row }">{{ formatDate(row.biz_date) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="经手人" width="110">
          <template #default="{ row }">{{ handlerName(row) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="140" />
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 0" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="row.status === 0" link type="success" size="small" @click="audit(String(row.id))">
              审核
            </el-button>
            <el-button v-if="row.status !== 0" link type="primary" size="small" @click="openEdit(row)">查看</el-button>
            <el-button v-if="row.status === 1" link type="warning" size="small" @click="unaudit(String(row.id))">
              取消审核
            </el-button>
            <el-button v-if="row.status === 1" link type="danger" size="small" @click="reverse(String(row.id))">
              红冲
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <StockDocFormDialog
      v-model="dialogVisible"
      kind="stock_transfer"
      :doc-id="dialogDocId"
      @saved="load"
    />
  </div>
</template>
