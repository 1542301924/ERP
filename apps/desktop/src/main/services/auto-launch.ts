/**
 * 开机自启：写入 / 移除系统登录项。
 *
 * 便携版进程运行在临时解压目录，因此登录项必须指向便携 exe 本体
 * （electron-builder portable 会注入 `PORTABLE_EXECUTABLE_FILE`）；
 * 开发态不写系统登录项，避免把 Electron 可执行文件注册进去。
 */

import { app } from 'electron';

export function applyAutoLaunch(enabled: boolean): void {
  if (!app.isPackaged) return;
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    ...(portableExe ? { path: portableExe } : {}),
  });
}
