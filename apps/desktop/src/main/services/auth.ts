/**
 * 登录与权限（用户 / 角色 / 角色权限）。
 *
 * 约定：
 *  - `app_user.pwd_hash` 为空表示**免密登录**（内置 admin 默认免密）；
 *  - 内置管理员角色 `role_admin` 恒拥有全部菜单权限；
 *  - 其余角色：勾选了权限则「只可见勾选项」，未勾选任何权限时默认可见全部
 *    （避免新建角色后菜单空白，管理员随后按需收窄）。
 *
 * 本模块保持纯逻辑（不依赖 electron），便于单测。
 */

import { createHash } from 'node:crypto';
import type { Row } from '@inventory/shared';
import { Repository } from '../db/repository';
import type { SqlDatabase } from '../db/sqlite';

/** 内置管理员用户 / 角色 id（种子数据创建，禁止停用或删除）。 */
export const ADMIN_USER_ID = 'user_admin';
export const ADMIN_ROLE_ID = 'role_admin';

/** 口令摘要（与种子数据一致，便于老库迁移比对）。 */
export function hashPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

/** 旧版本内置 admin 的口令摘要，升级时清空以支持免密登录。 */
export const LEGACY_ADMIN_HASH = hashPassword('admin123');

export interface LoginUser {
  id: string;
  account: string;
  name: string;
}

export interface SessionUser extends LoginUser {
  roleId: string | null;
  roleName: string | null;
}

export interface RolePermissions {
  /** true 表示不受限（内置管理员 / 未配置权限的角色）。 */
  all: boolean;
  keys: string[];
}

export interface AuthResult {
  ok: boolean;
  user?: SessionUser;
  permissions?: RolePermissions;
  error?: string;
}

/** 登录页下拉可选账号：启用且未删除。 */
export function loginUsers(db: SqlDatabase): LoginUser[] {
  const rows = db
    .prepare('SELECT id, account, name FROM app_user WHERE deleted = 0 AND status = 1 ORDER BY account')
    .all();
  return rows.map((r) => ({ id: String(r.id), account: String(r.account ?? ''), name: String(r.name ?? '') }));
}

/** 角色权限：内置管理员全量；未配置权限的角色默认全量；否则取勾选项。 */
export function rolePermissions(db: SqlDatabase, roleId: string | null): RolePermissions {
  if (!roleId) return { all: false, keys: [] };
  if (roleId === ADMIN_ROLE_ID) return { all: true, keys: [] };
  const keys = db
    .prepare('SELECT perm_key FROM role_permission WHERE role_id = ? AND deleted = 0 AND allowed = 1')
    .all(roleId)
    .map((r) => String(r.perm_key));
  return keys.length === 0 ? { all: true, keys: [] } : { all: false, keys: keys.sort() };
}

/** 校验账号口令并返回会话信息（口令为空账号直接放行）。 */
export function login(db: SqlDatabase, id: string, password: string): AuthResult {
  const row = db.prepare('SELECT * FROM app_user WHERE id = ? AND deleted = 0').get(id);
  if (!row) return { ok: false, error: '账号不存在或已被删除' };
  if (Number(row.status) !== 1) return { ok: false, error: '账号已停用，请联系管理员' };

  const stored = (row.pwd_hash as string | null) ?? '';
  if (stored && stored !== hashPassword(password ?? '')) return { ok: false, error: '密码不正确' };

  const roleId = (row.role_id as string | null) ?? null;
  const role = roleId ? db.prepare('SELECT name FROM role WHERE id = ?').get(roleId) : null;
  return {
    ok: true,
    user: {
      id: String(row.id),
      account: String(row.account ?? ''),
      name: String(row.name ?? ''),
      roleId,
      roleName: role ? String(role.name ?? '') : null,
    },
    permissions: rolePermissions(db, roleId),
  };
}

// ---------------- 用户管理 ----------------

export interface UserRow {
  id: string;
  account: string;
  name: string;
  role_id: string | null;
  role_name: string | null;
  status: number;
  created_at: number;
}

/** 用户列表（不下发 pwd_hash）。 */
export function listUsers(db: SqlDatabase): UserRow[] {
  const rows = db
    .prepare(
      'SELECT u.id, u.account, u.name, u.role_id, u.status, u.created_at, r.name AS role_name ' +
        'FROM app_user u LEFT JOIN role r ON r.id = u.role_id ' +
        'WHERE u.deleted = 0 ORDER BY u.created_at',
    )
    .all();
  return rows.map((r) => ({
    id: String(r.id),
    account: String(r.account ?? ''),
    name: String(r.name ?? ''),
    role_id: (r.role_id as string | null) ?? null,
    role_name: (r.role_name as string | null) ?? null,
    status: Number(r.status ?? 0),
    created_at: Number(r.created_at ?? 0),
  }));
}

export interface UserInput {
  id?: string;
  account: string;
  name: string;
  roleId?: string | null;
  status?: number;
  /** 提供即改密；空串 / null 表示清除口令（免密登录）。 */
  password?: string | null;
}

/** 新增 / 修改用户（口令仅在显式提供时改写）。 */
export function saveUser(db: SqlDatabase, repo: Repository, input: UserInput): Row {
  const account = input.account.trim();
  const name = input.name.trim();
  if (!account) throw new Error('账号不能为空');
  if (!name) throw new Error('姓名不能为空');

  const dup = db.prepare('SELECT id FROM app_user WHERE account = ? AND deleted = 0').get(account);
  if (dup && dup.id !== input.id) throw new Error(`账号「${account}」已存在`);

  const values: Row = {
    account,
    name,
    role_id: input.roleId ?? null,
    status: input.status ?? 1,
  };
  if (input.password !== undefined) values.pwd_hash = input.password ? hashPassword(input.password) : null;

  if (!input.id) return repo.insert('app_user', { ...values, pwd_hash: (values.pwd_hash as string | null) ?? null });
  if (input.id === ADMIN_USER_ID && Number(values.status) !== 1) throw new Error('内置管理员不可停用');
  return repo.update('app_user', input.id, values);
}

/** 删除用户（内置管理员不可删除）。 */
export function deleteUser(repo: Repository, id: string): void {
  if (id === ADMIN_USER_ID) throw new Error('内置管理员不可删除');
  repo.softDelete('app_user', id);
}

// ---------------- 角色管理 ----------------

export interface RoleRow {
  id: string;
  name: string;
  remark: string | null;
  user_count: number;
  perm_count: number;
}

/** 角色列表（含在用用户数与已勾选权限数）。 */
export function listRoles(db: SqlDatabase): RoleRow[] {
  const rows = db
    .prepare(
      'SELECT r.id, r.name, r.remark, ' +
        '(SELECT COUNT(*) FROM app_user u WHERE u.role_id = r.id AND u.deleted = 0) AS user_count, ' +
        '(SELECT COUNT(*) FROM role_permission p WHERE p.role_id = r.id AND p.deleted = 0 AND p.allowed = 1) AS perm_count ' +
        'FROM role r WHERE r.deleted = 0 ORDER BY r.created_at',
    )
    .all();
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    remark: (r.remark as string | null) ?? null,
    user_count: Number(r.user_count ?? 0),
    perm_count: Number(r.perm_count ?? 0),
  }));
}

export interface RoleInput {
  id?: string;
  name: string;
  remark?: string | null;
}

/** 新增 / 修改角色。 */
export function saveRole(db: SqlDatabase, repo: Repository, input: RoleInput): Row {
  const name = input.name.trim();
  if (!name) throw new Error('角色名称不能为空');
  const dup = db.prepare('SELECT id FROM role WHERE name = ? AND deleted = 0').get(name);
  if (dup && dup.id !== input.id) throw new Error(`角色「${name}」已存在`);
  const values: Row = { name, remark: input.remark?.trim() || null };
  if (!input.id) return repo.insert('role', values);
  if (input.id === ADMIN_ROLE_ID && name !== '管理员') throw new Error('内置管理员角色不可改名');
  return repo.update('role', input.id, values);
}

/** 删除角色（内置管理员角色、仍有用户的角色不可删除）。 */
export function deleteRole(db: SqlDatabase, repo: Repository, id: string): void {
  if (id === ADMIN_ROLE_ID) throw new Error('内置管理员角色不可删除');
  const used = db.prepare('SELECT COUNT(*) AS n FROM app_user WHERE role_id = ? AND deleted = 0').get(id);
  if (Number(used?.n ?? 0) > 0) throw new Error('该角色下仍有用户，请先调整这些用户的角色');
  repo.softDelete('role', id);
}

/** 某角色已勾选的权限键。 */
export function rolePermissionKeys(db: SqlDatabase, roleId: string): string[] {
  return db
    .prepare('SELECT perm_key FROM role_permission WHERE role_id = ? AND deleted = 0 AND allowed = 1')
    .all(roleId)
    .map((r) => String(r.perm_key));
}

/** 全量替换角色权限（按传入的键集合增删）。 */
export function setRolePermissions(
  db: SqlDatabase,
  repo: Repository,
  roleId: string,
  keys: string[],
): string[] {
  const wanted = new Set(keys.map((k) => k.trim()).filter(Boolean));
  const existing = repo.list('role_permission').filter((row) => String(row.role_id) === roleId);

  for (const row of existing) {
    const key = String(row.perm_key);
    if (wanted.has(key)) {
      if (Number(row.allowed) !== 1) repo.update('role_permission', String(row.id), { allowed: 1 });
      wanted.delete(key);
    } else {
      repo.softDelete('role_permission', String(row.id));
    }
  }
  for (const key of wanted) {
    repo.insert('role_permission', { role_id: roleId, perm_key: key, allowed: 1 });
  }
  return rolePermissionKeys(db, roleId);
}
