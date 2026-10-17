/**
 * 云函数公共助手（无第三方依赖，便于在 node:test 下直接单测）。
 *
 * 数据访问一律走「端口对象 db」，签名对齐 CloudBase：
 *   db.collection(name).where(cond).orderBy(f, dir).skip(n).limit(n).get() -> { data: [] }
 *   db.collection(name).where(cond).count() -> { total }
 *   db.collection(name).add({ data }) -> { _id }
 *   db.collection(name).doc(id).update({ data })
 * 单测用内存实现替换即可。
 */

const CODE = {
  VALIDATION: 'VALIDATION',
  NOT_BOUND: 'NOT_BOUND',
  NO_PERMISSION: 'NO_PERMISSION',
  CONFLICT: 'CONFLICT',
};

function ok(data) {
  return { ok: true, data };
}

function err(code, message, detail) {
  return { ok: false, code, message, detail };
}

function hasKeys(o) {
  return !!o && Object.keys(o).length > 0;
}

/** 取一条文档。 */
async function findOne(db, collection, where) {
  const c = db.collection(collection);
  const q = hasKeys(where) ? c.where(where) : c;
  const res = await q.limit(1).get();
  return (res && res.data && res.data[0]) || null;
}

/** 取一批文档。 */
async function findMany(db, collection, where = {}, opts = {}) {
  const { limit = 500, skip = 0, orderBy } = opts;
  const c = db.collection(collection);
  let q = hasKeys(where) ? c.where(where) : c;
  if (orderBy) q = q.orderBy(orderBy.field, orderBy.order || 'desc');
  const res = await q.skip(skip).limit(limit).get();
  return (res && res.data) || [];
}

/** 统计满足条件的文档数。 */
async function count(db, collection, where = {}) {
  const c = db.collection(collection);
  const q = hasKeys(where) ? c.where(where) : c;
  const res = await q.count();
  return (res && res.total) || 0;
}

async function add(db, collection, doc) {
  return db.collection(collection).add({ data: doc });
}

async function patch(db, collection, id, data) {
  return db.collection(collection).doc(id).update({ data });
}

/**
 * openid → 系统用户，并校验角色是否在「小程序可见范围」内。
 * 可见范围来自云数据库集合 mp_config 中文档 { key: 'mp_visible_roles', value: [roleId...] }；
 * value 为空数组或文档不存在 = 不限制（默认全部角色可用）。
 * @returns {{user?:object, error?:object}}
 */
async function resolveUser(db, openid) {
  if (!openid) return { error: err('NO_OPENID', '无法获取微信身份，请重新进入小程序') };

  const binding = await findOne(db, 'mp_binding', { openid });
  if (!binding || !binding.user_id) {
    return { error: err(CODE.NOT_BOUND, '当前微信未绑定系统用户，请先在「我的」页完成绑定') };
  }

  const user = await findOne(db, 'app_user', { id: binding.user_id });
  if (!user) return { error: err(CODE.NOT_BOUND, '绑定关系已失效，请重新绑定') };
  if (Number(user.status) === 0) return { error: err(CODE.NO_PERMISSION, '该账号已被停用') };

  const scope = await findOne(db, 'mp_config', { key: 'mp_visible_roles' });
  const allowed = scope && Array.isArray(scope.value) ? scope.value : [];
  if (allowed.length > 0 && !allowed.includes(user.role_id)) {
    return { error: err(CODE.NO_PERMISSION, '当前角色暂无小程序使用权限，请联系管理员开通') };
  }

  const role = user.role_id ? await findOne(db, 'role', { id: user.role_id }) : null;
  return {
    user: {
      id: user.id,
      name: user.name,
      account: user.account || '',
      roleId: user.role_id || '',
      roleName: role ? role.name : '',
    },
  };
}

/** 单号：前缀 + yyyymmdd + 6 位随机。P7 接入桌面端编码规则后会统一收敛。 */
function makeDocNo(prefix, now = Date.now(), rand = Math.random) {
  const d = new Date(now);
  const p = (x) => String(x).padStart(2, '0');
  const ymd = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const tail = String(Math.floor(rand() * 1000000)).padStart(6, '0');
  return `${prefix}${ymd}${tail}`;
}

/** 生成一个云端侧唯一 ID（离线补传时可复用客户端 docId 保证幂等）。 */
function newId(prefix = 'mp', now = Date.now(), rand = Math.random) {
  const tail = String(Math.floor(rand() * 1000000)).padStart(6, '0');
  return `${prefix}_${now.toString(36)}${tail}`;
}

/** 数值兜底，避免云端把 undefined 写进库。 */
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 日期兜底：支持时间戳 / 数字字符串 / YYYY-MM-DD。 */
function toTs(v, fallback = Date.now()) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') return n;
  const t = Date.parse(`${v}T00:00:00`);
  return Number.isNaN(t) ? fallback : t;
}

module.exports = {
  CODE,
  ok,
  err,
  findOne,
  findMany,
  count,
  add,
  patch,
  resolveUser,
  makeDocNo,
  newId,
  num,
  toTs,
};
