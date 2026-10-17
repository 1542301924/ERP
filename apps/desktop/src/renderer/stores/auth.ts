import { defineStore } from 'pinia';
import type { RolePermissions, SessionUser } from '../../../env';
import { api } from '../composables/useCrud';

const STORAGE_KEY = 'inventory-session';

interface SessionSnapshot {
  user: SessionUser | null;
}

function readSnapshot(): SessionSnapshot {
  if (typeof localStorage === 'undefined') return { user: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SessionSnapshot) : { user: null };
  } catch {
    return { user: null };
  }
}

/**
 * 登录会话（localStorage 记住上次登录的用户，重启免登录）。
 *
 * 权限由角色决定：`all=true` 不受限；否则仅可见 `keys` 中的菜单。
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: readSnapshot().user,
    permissions: null as RolePermissions | null,
    /** 首次路由守卫前是否已读取本地会话 */
    ready: false,
  }),
  getters: {
    loggedIn: (state) => !!state.user,
    displayName: (state) => state.user?.name ?? '',
    roleName: (state) => state.user?.roleName ?? '',
  },
  actions: {
    /** 读取本地会话（同步）；权限异步刷新。 */
    restore(): void {
      if (this.ready) return;
      this.user = readSnapshot().user;
      this.ready = true;
      if (this.user) void this.refreshPermissions();
    },
    /** 校验账号口令并建立会话。 */
    async login(userId: string, password: string): Promise<void> {
      const res = await api().auth.login(userId, password);
      if (!res.ok || !res.user) throw new Error(res.error ?? '登录失败');
      this.user = res.user;
      this.permissions = res.permissions ?? { all: false, keys: [] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ user: this.user } satisfies SessionSnapshot));
      void this.refreshPermissions();
    },
    /** 退出登录（仅清除本地会话，不删除账号）。 */
    logout(): void {
      this.user = null;
      this.permissions = null;
      localStorage.removeItem(STORAGE_KEY);
    },
    /** 按当前用户角色刷新权限（用户/角色改动后调用）。 */
    async refreshPermissions(): Promise<void> {
      if (!this.user) return;
      try {
        this.permissions = await api().auth.permissions(this.user.roleId);
      } catch {
        this.permissions = { all: false, keys: [] };
      }
    },
    /** 是否可访问某菜单路径。 */
    canAccess(path: string): boolean {
      if (!this.permissions) return false;
      if (this.permissions.all) return true;
      return this.permissions.keys.includes(path);
    },
  },
});
