/**
 * Tab3 开单（销售出库单）：客户/仓库/日期/备注 + 明细（搜索或扫码添加）+ 提交。
 */
const api = require('../../api/index');
const fmt = require('../../lib/format');
const Toast = require('tdesign-miniprogram/toast/index');

function eventValue(e) {
  const d = e && e.detail;
  if (typeof d === 'string') return d;
  if (d && typeof d.value === 'string') return d.value;
  if (d && d.value != null) return String(d.value);
  return '';
}

function today() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

Page({
  data: {
    customers: [],
    warehouses: [],
    customerNames: [],
    warehouseNames: [],
    customerIndex: -1,
    warehouseIndex: -1,
    bizDate: today(),
    remark: '',

    keyword: '',
    options: [],
    searching: false,

    items: [],
    totalText: '0.00',

    metaLoading: true,
    metaError: false,
    submitting: false,
  },

  onLoad() {
    this.loadMeta();
  },

  onPullDownRefresh() {
    this.loadMeta().then(() => wx.stopPullDownRefresh());
  },

  toast(message, theme) {
    Toast({ context: this, selector: '#t-toast', message, theme: theme || 'success' });
  },

  async loadMeta() {
    this.setData({ metaLoading: true, metaError: false });
    try {
      const meta = await api.orderMeta();
      const customers = (meta && meta.customers) || [];
      const warehouses = (meta && meta.warehouses) || [];
      this.setData({
        customers,
        warehouses,
        customerNames: customers.map((c) => c.name),
        warehouseNames: warehouses.map((w) => w.name),
        warehouseIndex: warehouses.length > 0 ? 0 : -1,
        metaLoading: false,
      });
    } catch (e) {
      this.setData({ metaLoading: false, metaError: true });
      this.toast('客户/仓库加载失败', 'error');
    }
  },

  onCustomerChange(e) {
    this.setData({ customerIndex: Number(e.detail.value) });
  },

  onWarehouseChange(e) {
    this.setData({ warehouseIndex: Number(e.detail.value) });
  },

  onDateChange(e) {
    this.setData({ bizDate: e.detail.value });
  },

  onRemarkChange(e) {
    this.setData({ remark: eventValue(e) });
  },

  onKeywordChange(e) {
    this.setData({ keyword: eventValue(e) });
  },

  async searchProducts(e) {
    const fromEvent = eventValue(e);
    const keyword = (fromEvent || this.data.keyword || '').trim();
    if (!keyword) {
      this.toast('请输入商品名称或编码', 'warning');
      return;
    }
    this.setData({ searching: true });
    try {
      const res = await api.queryStock({ keyword, page: 1, pageSize: 20 });
      const options = (res.items || []).map((it) => ({
        productId: it.productId,
        code: it.code,
        name: it.name,
        spec: it.spec,
        unit: it.unit,
        qtyText: fmt.qty(it.qty),
      }));
      this.setData({ options, searching: false });
      if (options.length === 0) this.toast('未找到商品', 'warning');
    } catch (err) {
      this.setData({ searching: false });
      this.toast('搜索失败，请重试', 'error');
    }
  },

  async addProduct(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const p = this.data.options[idx];
    if (!p) return;
    let salePrice = p.salePrice;
    if (salePrice == null) {
      try {
        const detail = await api.productDetail(p.productId);
        salePrice = detail && detail.product ? detail.product.salePrice : null;
      } catch (err) {
        salePrice = null;
      }
    }
    this.addItem(p.productId, p.name, p.unit, salePrice);
  },

  addItem(productId, productName, unit, salePrice) {
    if (!productId) return;
    if (this.data.items.some((x) => x.productId === productId)) {
      this.toast('该商品已在明细中', 'warning');
      return;
    }
    const price = Number.isFinite(Number(salePrice)) ? Number(salePrice) : 0;
    const items = this.data.items.concat({
      productId,
      productName: productName || '',
      unit: unit || '',
      qty: 1,
      price,
    });
    this.setData({ items, options: [], keyword: '' });
    this.recalc();
    this.toast('已加入明细');
  },

  onScan() {
    wx.scanCode({
      success: async (res) => {
        const barcode = (res && res.result) || '';
        if (!barcode) return;
        try {
          const found = await api.lookupBarcode(barcode);
          if (found && found.product) {
            this.addItem(
              found.product.id,
              found.product.name,
              found.product.unit,
              found.product.salePrice,
            );
          } else {
            this.toast('未找到该条码对应商品', 'warning');
          }
        } catch (err) {
          this.toast('未找到该条码对应商品', 'warning');
        }
      },
      fail: () => {},
    });
  },

  onQtyChange(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    if (!items[idx]) return;
    items[idx] = Object.assign({}, items[idx], { qty: Number(eventValue(e)) || 0 });
    this.setData({ items });
    this.recalc();
  },

  onPriceChange(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    if (!items[idx]) return;
    items[idx] = Object.assign({}, items[idx], { price: Number(eventValue(e)) || 0 });
    this.setData({ items });
    this.recalc();
  },

  removeItem(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const items = this.data.items.slice();
    items.splice(idx, 1);
    this.setData({ items });
    this.recalc();
  },

  recalc() {
    const items = this.data.items.map((it) => {
      const amount = (Number(it.qty) || 0) * (Number(it.price) || 0);
      return Object.assign({}, it, { amountText: fmt.money(amount) });
    });
    const total = items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
    this.setData({ items, totalText: fmt.money(total) });
  },

  resetForm() {
    this.setData({
      items: [],
      options: [],
      keyword: '',
      remark: '',
      bizDate: today(),
      warehouseIndex: this.data.warehouses.length > 0 ? 0 : -1,
    });
    this.recalc();
  },

  async onSubmit() {
    const d = this.data;
    if (d.customerIndex < 0 || !d.customers[d.customerIndex]) {
      this.toast('请选择客户', 'warning');
      return;
    }
    if (d.warehouseIndex < 0 || !d.warehouses[d.warehouseIndex]) {
      this.toast('请选择仓库', 'warning');
      return;
    }
    if (d.items.length === 0) {
      this.toast('请至少添加一条明细', 'warning');
      return;
    }
    if (d.items.some((it) => !(Number(it.qty) > 0))) {
      this.toast('存在数量为 0 的明细', 'warning');
      return;
    }

    const customer = d.customers[d.customerIndex];
    const warehouse = d.warehouses[d.warehouseIndex];
    const payload = {
      customerId: customer.id,
      customerName: customer.name,
      warehouseId: warehouse.id,
      bizDate: d.bizDate,
      remark: d.remark,
      items: d.items.map((it) => ({
        productId: it.productId,
        productName: it.productName,
        unit: it.unit,
        qty: Number(it.qty),
        price: Number(it.price) || 0,
      })),
    };

    this.setData({ submitting: true });
    try {
      const res = await api.submitSalesOrder(payload);
      if (res && res.queued) {
        this.toast('已离线保存，联网后自动提交', 'warning');
      } else if (res && res.docNo) {
        this.toast(`已提交：${res.docNo}`);
      } else {
        this.toast('提交成功');
      }
      this.resetForm();
    } catch (e) {
      this.toast('提交失败，请重试', 'error');
    } finally {
      this.setData({ submitting: false });
    }
  },
});
