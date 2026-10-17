import { type Component } from 'vue';
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import MainLayout from '../layouts/MainLayout.vue';
import Workbench from '../views/Workbench.vue';
import Placeholder from '../views/Placeholder.vue';
import ProductsView from '../views/basic/ProductsView.vue';
import CategoriesView from '../views/basic/CategoriesView.vue';
import UnitsView from '../views/basic/UnitsView.vue';
import WarehousesView from '../views/basic/WarehousesView.vue';
import LocationsView from '../views/basic/LocationsView.vue';
import CustomersView from '../views/basic/CustomersView.vue';
import SuppliersView from '../views/basic/SuppliersView.vue';
import DepartmentsView from '../views/basic/DepartmentsView.vue';
import CodeRulesView from '../views/basic/CodeRulesView.vue';
import ExcelCenterView from '../views/basic/ExcelCenterView.vue';
import PurchaseOrdersView from '../views/docs/PurchaseOrdersView.vue';
import PurchaseInboundView from '../views/docs/PurchaseInboundView.vue';
import DeptUseView from '../views/docs/DeptUseView.vue';
import ProductionInView from '../views/docs/ProductionInView.vue';
import SalesOrdersView from '../views/docs/SalesOrdersView.vue';
import SalesOutboundView from '../views/docs/SalesOutboundView.vue';
import ReturnsView from '../views/docs/ReturnsView.vue';
import RealtimeStockView from '../views/stock/RealtimeStockView.vue';
import LedgerView from '../views/stock/LedgerView.vue';
import AlertsView from '../views/stock/AlertsView.vue';
import TransferView from '../views/stock/TransferView.vue';
import CheckView from '../views/stock/CheckView.vue';
import ReceivableView from '../views/finance/ReceivableView.vue';
import PayableView from '../views/finance/PayableView.vue';
import AccountsView from '../views/finance/AccountsView.vue';
import InventoryDetailView from '../views/reports/InventoryDetailView.vue';
import InventorySummaryView from '../views/reports/InventorySummaryView.vue';
import ReceiptStatementView from '../views/reports/ReceiptStatementView.vue';
import ShipmentStatementView from '../views/reports/ShipmentStatementView.vue';
import ShipmentCostView from '../views/reports/ShipmentCostView.vue';
import GrossProfitView from '../views/reports/GrossProfitView.vue';
import SyncCenterView from '../views/system/SyncCenterView.vue';
import BackupView from '../views/system/BackupView.vue';

/** P1 主数据页面（基础资料 10 个菜单）。其余分组仍走 Placeholder。 */
const basicViews: Record<string, Component> = {
  '/basic/products': ProductsView,
  '/basic/categories': CategoriesView,
  '/basic/units': UnitsView,
  '/basic/warehouses': WarehousesView,
  '/basic/locations': LocationsView,
  '/basic/customers': CustomersView,
  '/basic/suppliers': SuppliersView,
  '/basic/departments': DepartmentsView,
  '/basic/code-rules': CodeRulesView,
  '/basic/excel': ExcelCenterView,
};

/** P2 单据页面（采购 / 销售 出入库链路）。 */
const docViews: Record<string, Component> = {
  '/purchase/orders': PurchaseOrdersView,
  '/purchase/inbound': PurchaseInboundView,
  '/purchase/dept-use': DeptUseView,
  '/purchase/production-in': ProductionInView,
  '/sales/orders': SalesOrdersView,
  '/sales/outbound': SalesOutboundView,
  '/sales/returns': ReturnsView,
};

/** P3 库存页面（实时库存 / 流水 / 预警 / 调拨 / 盘点）。 */
const stockViews: Record<string, Component> = {
  '/stock/realtime': RealtimeStockView,
  '/stock/ledger': LedgerView,
  '/stock/alerts': AlertsView,
  '/stock/transfer': TransferView,
  '/stock/check': CheckView,
};

/** P4 财务页面（应收 / 应付 / 资金账户流水）。 */
const financeViews: Record<string, Component> = {
  '/finance/receivable': ReceivableView,
  '/finance/payable': PayableView,
  '/finance/accounts': AccountsView,
};

/** P5 报表页面（6 张报表）。 */
const reportViews: Record<string, Component> = {
  '/reports/detail': InventoryDetailView,
  '/reports/summary': InventorySummaryView,
  '/reports/receipt-statement': ReceiptStatementView,
  '/reports/shipment-statement': ShipmentStatementView,
  '/reports/shipment-cost': ShipmentCostView,
  '/reports/gross-profit': GrossProfitView,
};

/** P7 系统页面（同步中心 / 数据备份恢复）。 */
const systemViews: Record<string, Component> = {
  '/system/sync': SyncCenterView,
  '/system/backup': BackupView,
};

/** 左侧菜单结构（严格按设计文档 §6.1 页面结构）。 */
export interface MenuItem {
  path: string;
  title: string;
}
export interface MenuGroup {
  title: string;
  items: MenuItem[];
}

export const MENU: MenuGroup[] = [
  {
    title: '基础资料',
    items: [
      { path: '/basic/products', title: '商品管理' },
      { path: '/basic/categories', title: '商品类别' },
      { path: '/basic/units', title: '计量单位' },
      { path: '/basic/warehouses', title: '仓库管理' },
      { path: '/basic/locations', title: '货位管理' },
      { path: '/basic/customers', title: '客户管理' },
      { path: '/basic/suppliers', title: '供应商管理' },
      { path: '/basic/departments', title: '部门管理' },
      { path: '/basic/code-rules', title: '编码规则' },
      { path: '/basic/excel', title: 'Excel 模板中心' },
    ],
  },
  {
    title: '采购（入库）',
    items: [
      { path: '/purchase/orders', title: '采购订单' },
      { path: '/purchase/inbound', title: '采购入库单' },
      { path: '/purchase/dept-use', title: '部门领用单' },
      { path: '/purchase/production-in', title: '生产入库单' },
    ],
  },
  {
    title: '销售（出库）',
    items: [
      { path: '/sales/orders', title: '销售订单' },
      { path: '/sales/outbound', title: '销售出库单' },
      { path: '/sales/returns', title: '退货入库 / 退货出库' },
    ],
  },
  {
    title: '库存',
    items: [
      { path: '/stock/realtime', title: '实时库存查询' },
      { path: '/stock/ledger', title: '库存流水' },
      { path: '/stock/alerts', title: '库存预警' },
      { path: '/stock/transfer', title: '库存调拨' },
      { path: '/stock/check', title: '库存盘点' },
    ],
  },
  {
    title: '财务',
    items: [
      { path: '/finance/receivable', title: '应收管理' },
      { path: '/finance/payable', title: '应付管理' },
      { path: '/finance/accounts', title: '资金账户流水' },
    ],
  },
  {
    title: '报表',
    items: [
      { path: '/reports/detail', title: '进销存明细表' },
      { path: '/reports/summary', title: '进销存汇总表' },
      { path: '/reports/receipt-statement', title: '收货对账单' },
      { path: '/reports/shipment-statement', title: '发货对账单' },
      { path: '/reports/shipment-cost', title: '发货成本表' },
      { path: '/reports/gross-profit', title: '销售毛利表' },
    ],
  },
  {
    title: '系统',
    items: [
      { path: '/system/users', title: '用户与角色权限' },
      { path: '/system/op-log', title: '操作日志' },
      { path: '/system/sync', title: '同步中心' },
      { path: '/system/backup', title: '数据备份恢复' },
      { path: '/system/settings', title: '设置' },
    ],
  },
];

const placeholderRoutes: RouteRecordRaw[] = MENU.flatMap((group) =>
  group.items.map((item) => {
    const component =
      docViews[item.path] ??
      stockViews[item.path] ??
      financeViews[item.path] ??
      reportViews[item.path] ??
      systemViews[item.path] ??
      basicViews[item.path] ??
      Placeholder;
    return {
      path: item.path.slice(1),
      name: item.path,
      component,
      props: component === Placeholder ? { title: item.title } : {},
      meta: { title: item.title, group: group.title },
    };
  }),
);

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: MainLayout,
    redirect: '/workbench',
    children: [
      {
        path: 'workbench',
        name: 'workbench',
        component: Workbench,
        meta: { title: '工作台' },
      },
      ...placeholderRoutes,
    ],
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
