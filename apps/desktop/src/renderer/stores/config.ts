import { defineStore } from 'pinia';

/** 系统配置（sys_config）读取。浏览器预览无 window.api 时给出可读回退值。 */
export const useConfigStore = defineStore('config', {
  state: () => ({
    values: {} as Record<string, string>,
    loaded: false,
    error: '' as string,
  }),
  actions: {
    async load() {
      try {
        if (window.api) {
          this.values = (await window.api.getConfig()) as Record<string, string>;
        } else {
          this.values = {
            allow_negative_stock: '0',
            backup_keep: '7',
            lan_port: '8765',
            _note: '浏览器预览模式：未接入 Electron IPC，显示的是默认值',
          };
        }
      } catch (err) {
        this.error = String(err);
      } finally {
        this.loaded = true;
      }
    },
  },
});
