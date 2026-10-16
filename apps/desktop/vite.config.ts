import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 渲染进程（Vue3 + Vite）构建配置。P0 仅需 renderer 可 build。
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
});
