/**
 * Electron 主进程入口（创建窗口 + 初始化本地库 + 注册 IPC）。
 *
 * 主进程以 CommonJS 打包为 `dist/main/index.cjs`：CJS 入口在 asar 归档内加载最稳妥；
 * 启动异常会弹出可见错误框并写入 `startup-error.log`，避免出现「双击无反应」却无从排查。
 */

import { app, BrowserWindow, Menu, dialog } from 'electron';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { SysConfigKey } from '@inventory/shared';
import { getSysConfig, openAndInit } from './db/database';
import { seedDefaultData } from './db/seed';
import { registerIpcHandlers } from './ipc';
import { applyAutoLaunch } from './services/auto-launch';

/** 启动失败时：写日志 + 弹窗提示原因，并结束进程。 */
function reportStartupError(err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    appendFileSync(join(app.getPath('userData'), 'startup-error.log'), `[${new Date().toISOString()}] ${detail}\n\n`);
  } catch {
    // 日志写入失败不影响下面的弹窗
  }
  try {
    dialog.showErrorBox('轻松进销存启动失败', detail);
  } catch {
    // 无 GUI 环境下忽略
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: '轻松进销存',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

app.whenReady().then(() => {
  try {
    // 去掉系统默认菜单栏（File/Edit/View/Window/Help）
    Menu.setApplicationMenu(null);

    // 本地主库：位于用户数据目录
    const dbFile = join(app.getPath('userData'), 'inventory.db');
    const db = openAndInit(dbFile);
    seedDefaultData(db);
    // 恢复用户的「开机自启」偏好（系统登录项可能被清理或系统重装）
    applyAutoLaunch(getSysConfig(db, SysConfigKey.AUTO_LAUNCH) === '1');
    registerIpcHandlers(db, dbFile);

    createWindow();
  } catch (err) {
    reportStartupError(err);
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
