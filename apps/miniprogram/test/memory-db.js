/**
 * 内存版云数据库端口：签名对齐 CloudBase，供云函数「纯逻辑」单测使用。
 *
 * 支持：where(相等条件) / orderBy / skip / limit / get / count / add / doc(id).update。
 * 不做嵌套查询与复合命令——云函数实现里也未使用，保持一致即可。
 */
function createMemoryDb(seed = {}) {
  const store = {};
  for (const [name, rows] of Object.entries(seed)) {
    store[name] = rows.map((r) => ({ ...r }));
  }

  function ensure(name) {
    if (!store[name]) store[name] = [];
    return store[name];
  }

  function match(row, cond) {
    return Object.keys(cond).every((k) => row[k] === cond[k]);
  }

  function collection(name) {
    const cond = {};
    let order = null;
    let skipN = 0;
    let limitN = Infinity;
    const hasCond = () => Object.keys(cond).length > 0;
    const filtered = () => ensure(name).filter((r) => (hasCond() ? match(r, cond) : true));

    const api = {
      where(c) {
        Object.assign(cond, c);
        return api;
      },
      orderBy(field, dir) {
        order = { field, dir };
        return api;
      },
      skip(n) {
        skipN = n;
        return api;
      },
      limit(n) {
        limitN = n;
        return api;
      },
      async get() {
        let rows = filtered();
        if (order) {
          const { field, dir } = order;
          rows = rows.slice().sort((a, b) => {
            if (a[field] === b[field]) return 0;
            const r = a[field] > b[field] ? 1 : -1;
            return dir === 'asc' ? r : -r;
          });
        }
        return { data: rows.slice(skipN, skipN + limitN).map((r) => ({ ...r })) };
      },
      async count() {
        return { total: filtered().length };
      },
      async add({ data }) {
        ensure(name).push({ ...data });
        return { _id: data.id };
      },
      doc(id) {
        return {
          async update({ data }) {
            const row = ensure(name).find((r) => r.id === id || r._id === id);
            if (row) Object.assign(row, data);
            return { updated: row ? 1 : 0 };
          },
        };
      },
    };
    return api;
  }

  return { collection, __store: store };
}

module.exports = { createMemoryDb };
