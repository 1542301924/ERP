/**
 * Electron 主进程入口（P0：创建窗口 + 初始化本地库 + 注册 IPC）。
 * 说明：无 GUI 环境下不要求真正弹窗，能通过类型校验 / 构建即可。
 */

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openAndInit } from './db/database';
import { seedDefaultData } from './db/seed';
import { registerIpcHandlers } from './ipc';

const currentDir = dirname(fileURLToPath(import.meta.url));

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: '轻松进销存',
    webPreferences: {
      preload: join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(currentDir, '../renderer/index.html'));
  }
  return win;
}

app.whenReady().then(() => {
  // 本地主库：位于用户数据目录
  const dbFile = join(app.getPath('userData'), 'inventory.db');
  const db = openAndInit(dbFile);
  seedDefaultData(db);
  registerIpcHandlers(db);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
