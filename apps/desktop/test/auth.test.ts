import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHlc } from '@inventory/shared';
import { openAndInit } from '../src/main/db/database';
import { seedDefaultData } from '../src/main/db/seed';
import { Repository } from '../src/main/db/repository';
import {
  ADMIN_ROLE_ID,
  ADMIN_USER_ID,
  LEGACY_ADMIN_HASH,
  deleteRole,
  deleteUser,
  listRoles,
  listUsers,
  login,
  loginUsers,
  rolePermissionKeys,
  rolePermissions,
  saveRole,
  saveUser,
  setRolePermissions,
} from '../src/main/services/auth';
import type { SqlDatabase } from '../src/main/db/sqlite';

function makeRepo(db: SqlDatabase): Repository {
  return new Repository(db, { userId: 'u1', deviceId: 'devA', clock: createHlc('devA') }, () => 1_700_000_000_000);
}

function seeded(): SqlDatabase {
  const db = openAndInit(':memory:');
  seedDefaultData(db, { deviceId: 'devA' });
  return db;
}

test('内置 admin 免密登录并获得全部权限', () => {
  const db = seeded();
  const users = loginUsers(db);
  assert.equal(users.length, 1);
  assert.equal(users[0].account, 'admin');

  const res = login(db, ADMIN_USER_ID, '');
  assert.equal(res.ok, true);
  assert.equal(res.user?.name, '管理员');
  assert.equal(res.user?.roleName, '管理员');
  assert.deepEqual(res.permissions, { all: true, keys: [] });
  db.close();
});

test('未设口令的账号任意口令均可通过；设置口令后必须匹配', () => {
  const db = seeded();
  const repo = makeRepo(db);

  assert.equal(login(db, ADMIN_USER_ID, '任意').ok, true);

  saveUser(db, repo, { id: ADMIN_USER_ID, account: 'admin', name: '管理员', password: '123456' });
  assert.equal(login(db, ADMIN_USER_ID, '').ok, false);
  assert.equal(login(db, ADMIN_USER_ID, 'wrong').ok, false);
  assert.equal(login(db, ADMIN_USER_ID, '123456').ok, true);

  // 清除口令后恢复免密
  saveUser(db, repo, { id: ADMIN_USER_ID, account: 'admin', name: '管理员', password: '' });
  assert.equal(login(db, ADMIN_USER_ID, '').ok, true);
  db.close();
});

test('停用账号不可登录', () => {
  const db = seeded();
  const repo = makeRepo(db);
  const role = saveRole(db, repo, { name: '仓管员' });
  const user = saveUser(db, repo, { account: 'wg', name: '王工', roleId: String(role.id) });

  assert.equal(login(db, String(user.id), '').ok, true);
  saveUser(db, repo, { id: String(user.id), account: 'wg', name: '王工', status: 0 });
  const res = login(db, String(user.id), '');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /停用/);
  db.close();
});

test('用户管理：账号唯一、不下发口令摘要、内置 admin 受保护', () => {
  const db = seeded();
  const repo = makeRepo(db);
  saveUser(db, repo, { account: 'ls', name: '李四', password: 'abc' });

  const rows = listUsers(db);
  assert.equal(rows.length, 2);
  const lisi = rows.find((r) => r.account === 'ls')!;
  assert.equal(lisi.name, '李四');
  assert.equal(Object.hasOwn(lisi, 'pwd_hash'), false);
  assert.equal(Object.hasOwn(lisi, 'password'), false);

  assert.throws(() => saveUser(db, repo, { account: 'ls', name: '重复' }), /已存在/);
  assert.throws(() => saveUser(db, repo, { id: ADMIN_USER_ID, account: 'admin', name: '管理员', status: 0 }), /不可停用/);
  assert.throws(() => deleteUser(repo, ADMIN_USER_ID), /不可删除/);

  deleteUser(repo, lisi.id);
  assert.equal(listUsers(db).length, 1);
  db.close();
});

test('角色权限：内置管理员全量、未配置默认全量、配置后只留勾选项', () => {
  const db = seeded();
  const repo = makeRepo(db);
  const role = saveRole(db, repo, { name: '仓管员', remark: '只管库存' });
  const roleId = String(role.id);

  assert.deepEqual(rolePermissions(db, ADMIN_ROLE_ID), { all: true, keys: [] });
  assert.deepEqual(rolePermissions(db, null), { all: false, keys: [] });
  assert.deepEqual(rolePermissions(db, roleId), { all: true, keys: [] });

  setRolePermissions(db, repo, roleId, ['/basic/products', '/stock/realtime']);
  assert.deepEqual(rolePermissionKeys(db, roleId).sort(), ['/basic/products', '/stock/realtime']);
  assert.deepEqual(rolePermissions(db, roleId), { all: false, keys: ['/basic/products', '/stock/realtime'] });

  // 全量替换：去掉一个、保留一个
  setRolePermissions(db, repo, roleId, ['/stock/realtime']);
  assert.deepEqual(rolePermissionKeys(db, roleId), ['/stock/realtime']);

  // 清空后回到「默认全量」
  setRolePermissions(db, repo, roleId, []);
  assert.deepEqual(rolePermissions(db, roleId), { all: true, keys: [] });
  db.close();
});

test('角色管理：名称唯一、有用户的角色与内置角色不可删除', () => {
  const db = seeded();
  const repo = makeRepo(db);
  const role = saveRole(db, repo, { name: '仓管员' });
  const roleId = String(role.id);
  assert.throws(() => saveRole(db, repo, { name: '仓管员' }), /已存在/);
  assert.throws(() => deleteRole(db, repo, ADMIN_ROLE_ID), /不可删除/);

  const user = saveUser(db, repo, { account: 'wg', name: '王工', roleId });
  assert.throws(() => deleteRole(db, repo, roleId), /仍有用户/);

  saveUser(db, repo, { id: String(user.id), account: 'wg', name: '王工', roleId: null });
  deleteRole(db, repo, roleId);
  assert.equal(listRoles(db).length, 1);
  assert.equal(listRoles(db)[0].user_count, 1); // admin 挂在管理员角色上
  db.close();
});

test('老库迁移：内置 admin 的历史默认口令被清空', () => {
  const db = openAndInit(':memory:');
  const repo = makeRepo(db);
  repo.insert(
    'app_user',
    {
      account: 'admin',
      name: '管理员',
      pwd_hash: LEGACY_ADMIN_HASH, // 旧版本内置默认口令 admin123
      role_id: ADMIN_ROLE_ID,
      status: 1,
    },
    ADMIN_USER_ID,
  );
  repo.insert('role', { name: '管理员', remark: '' }, ADMIN_ROLE_ID);

  seedDefaultData(db, { deviceId: 'devA' });
  assert.equal(login(db, ADMIN_USER_ID, '').ok, true);
  db.close();
});
