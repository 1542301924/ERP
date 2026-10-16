<script setup lang="ts">
import { onMounted, ref } from 'vue';
import DocFormDialog from '../../components/DocFormDialog.vue';
import { useDocPage, type DocListRow } from '../../composables/useDocPage';

const purchaseIn = useDocPage('purchase_inbound', '退货入库');
const salesOut = useDocPage('sales_outbound', '退货出库');
const { statusLabel, statusTagType, handlerName, formatDate, money } = purchaseIn;

const purchaseDialog = ref(false);
const purchaseDocId = ref<string | undefined>(undefined);
const salesDialog = ref(false);
const salesDocId = ref<string | undefined>(undefined);

function openPurchase(row?: DocListRow): void {
  purchaseDocId.value = row ? String(row.id ?? '') : undefined;
  purchaseDialog.value = true;
}

function openSales(row?: DocListRow): void {
  salesDocId.value = row ? String(row.id ?? '') : undefined;
  salesDialog.value = true;
}

function resetPurchase(): void {
  purchaseIn.filters.keyword = '';
  purchaseIn.filters.status = '';
  purchaseIn.filters.dateRange = null;
  void purchaseIn.load();
}

function resetSales(): void {
  salesOut.filters.keyword = '';
  salesOut.filters.status = '';
  salesOut.filters.dateRange = null;
  void salesOut.load();
}

onMounted(() => {
  void purchaseIn.load();
  void salesOut.load();
});
</script>

<template>
  <el-card>
    <el-tabs>
      <el-tab-pane label="采购退货（退回供应商）">
        <el-form :inline="true" class="card-gap" @submit.prevent>
          <el-form-item label="关键字">
            <el-input
              v-model="purchaseIn.filters.keyword"
              placeholder="单据编号 / 供应商 / 备注"
              clearable
              style="width: 240px"
              @keyup.enter="purchaseIn.load"
            />
          </el-form-item>
          <el-form-item label="状态">
            <el-select
              v-model="purchaseIn.filters.status"
              clearable
              placeholder="全部"
              style="width: 130px"
              value-on-clear=""
            >
              <el-option label="待审核" :value="0" />
              <el-option label="已审核" :value="1" />
              <el-option label="已红冲" :value="9" />
            </el-select>
          </el-form-item>
          <el-form-item label="业务日期">
            <el-date-picker
              v-model="purchaseIn.filters.dateRange"
              type="daterange"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              style="width: 260px"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="purchaseIn.load">查询</el-button>
            <el-button @click="resetPurchase">重置</el-button>
            <el-button type="success" @click="openPurchase()">新增退货入库单</el-button>
          </el-form-item>
        </el-form>

        <el-table
          v-loading="purchaseIn.loading.value"
          :data="purchaseIn.rows.value"
          empty-text="暂无单据数据"
          border
          stripe
        >
          <el-table-column prop="doc_no" label="单据编号" width="160" />
          <el-table-column prop="doc_type" label="类型" width="100" />
          <el-table-column prop="partner_name" label="供应商" min-width="150" />
          <el-table-column prop="warehouse_name" label="仓库" width="130" />
          <el-table-column label="业务日期" width="120">
            <template #default="{ row }">{{ formatDate(row.biz_date) }}</template>
          </el-table-column>
          <el-table-column label="金额" width="110" align="right">
            <template #default="{ row }">{{ money(row.total_amount) }}</template>
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
              <el-button v-if="row.status === 0" link type="primary" size="small" @click="openPurchase(row)">
                编辑
              </el-button>
              <el-button
                v-if="row.status === 0"
                link
                type="success"
                size="small"
                @click="purchaseIn.audit(String(row.id))"
              >
                审核
              </el-button>
              <el-button v-if="row.status !== 0" link type="primary" size="small" @click="openPurchase(row)">
                查看
              </el-button>
              <el-button
                v-if="row.status === 1"
                link
                type="warning"
                size="small"
                @click="purchaseIn.unaudit(String(row.id))"
              >
                取消审核
              </el-button>
              <el-button
                v-if="row.status === 1"
                link
                type="danger"
                size="small"
                @click="purchaseIn.reverse(String(row.id))"
              >
                红冲
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="销售退货（客户退回）">
        <el-form :inline="true" class="card-gap" @submit.prevent>
          <el-form-item label="关键字">
            <el-input
              v-model="salesOut.filters.keyword"
              placeholder="单据编号 / 客户 / 备注"
              clearable
              style="width: 240px"
              @keyup.enter="salesOut.load"
            />
          </el-form-item>
          <el-form-item label="状态">
            <el-select
              v-model="salesOut.filters.status"
              clearable
              placeholder="全部"
              style="width: 130px"
              value-on-clear=""
            >
              <el-option label="待审核" :value="0" />
              <el-option label="已审核" :value="1" />
              <el-option label="已红冲" :value="9" />
            </el-select>
          </el-form-item>
          <el-form-item label="业务日期">
            <el-date-picker
              v-model="salesOut.filters.dateRange"
              type="daterange"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              style="width: 260px"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="salesOut.load">查询</el-button>
            <el-button @click="resetSales">重置</el-button>
            <el-button type="success" @click="openSales()">新增退货出库单</el-button>
          </el-form-item>
        </el-form>

        <el-table
          v-loading="salesOut.loading.value"
          :data="salesOut.rows.value"
          empty-text="暂无单据数据"
          border
          stripe
        >
          <el-table-column prop="doc_no" label="单据编号" width="160" />
          <el-table-column prop="doc_type" label="类型" width="100" />
          <el-table-column prop="partner_name" label="客户" min-width="150" />
          <el-table-column prop="warehouse_name" label="仓库" width="130" />
          <el-table-column label="业务日期" width="120">
            <template #default="{ row }">{{ formatDate(row.biz_date) }}</template>
          </el-table-column>
          <el-table-column label="金额" width="110" align="right">
            <template #default="{ row }">{{ money(row.total_amount) }}</template>
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
              <el-button v-if="row.status === 0" link type="primary" size="small" @click="openSales(row)">
                编辑
              </el-button>
              <el-button
                v-if="row.status === 0"
                link
                type="success"
                size="small"
                @click="salesOut.audit(String(row.id))"
              >
                审核
              </el-button>
              <el-button v-if="row.status !== 0" link type="primary" size="small" @click="openSales(row)">
                查看
              </el-button>
              <el-button
                v-if="row.status === 1"
                link
                type="warning"
                size="small"
                @click="salesOut.unaudit(String(row.id))"
              >
                取消审核
              </el-button>
              <el-button
                v-if="row.status === 1"
                link
                type="danger"
                size="small"
                @click="salesOut.reverse(String(row.id))"
              >
                红冲
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
  </el-card>

  <DocFormDialog
    v-model="purchaseDialog"
    kind="purchase_inbound"
    doc-type="退货入库"
    :doc-id="purchaseDocId"
    @saved="purchaseIn.load"
  />
  <DocFormDialog
    v-model="salesDialog"
    kind="sales_outbound"
    doc-type="退货出库"
    :doc-id="salesDocId"
    @saved="salesOut.load"
  />
</template>
