import { defineStore } from 'pinia';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'inventory-theme';

function initial(): ThemeMode {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  return saved === 'dark' ? 'dark' : 'light';
}

/** 深 / 浅主题（CSS 变量 + html[data-theme]；同时切换 Element Plus 的 dark class）。 */
export const useThemeStore = defineStore('theme', {
  state: () => ({ mode: initial() as ThemeMode }),
  getters: {
    isDark: (state) => state.mode === 'dark',
  },
  actions: {
    apply() {
      const root = document.documentElement;
      root.setAttribute('data-theme', this.mode);
      root.classList.toggle('dark', this.mode === 'dark');
    },
    set(mode: ThemeMode) {
      this.mode = mode;
      localStorage.setItem(STORAGE_KEY, mode);
      this.apply();
    },
    toggle() {
      this.set(this.mode === 'light' ? 'dark' : 'light');
    },
  },
});
