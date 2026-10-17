/**
 * 主进程 IPC handler 注册。
 *
 * 既有通道：`db:query`、`db:mutate`、`config:get`。
 * P1 新增：主数据查询 / 保存、编号规则、Excel 模板导入导出。
 * 文件选择与落盘只在本文件处理（electron dialog + node:fs/promises）。
 */

import { app, BrowserWindow, dialog, ipcMain, nativeImage, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHlc, SysConfigKey, type Row } from '@inventory/shared';
import { ensureDeviceId, getAllSysConfig, getSysConfig } from './db/database';
import { Repository } from './db/repository';
import type { SqlDatabase } from './db/sqlite';
import {
  categoryTree,
  deleteCategory,
  deleteProductUnit,
  getById,
  lookupBarcode,
  productDetail,
  productThumbnails,
  saveCategory,
  saveProductUnit,
  search,
} from './services/master-data';
import { nextCode } from './services/code-rule';
import { getOpLog, listOpLog, type OpLogFilter } from './services/op-log';
import {
  audit as auditDoc,
  get as getDoc,
  list as listDocs,
  reverse as reverseDoc,
  save as saveDoc,
  transfer as transferDoc,
  unaudit as unauditDoc,
  type DocContext,
  type DocFilter,
  type DocKind,
  type DocSaveInput,
} from './services/documents';
import { buildExportBuffer, buildTemplateBuffer, importFromBuffer, listTemplates } from './services/excel';
import { alertList, listBalance, listLedger, recompute as recomputeStock } from './services/stock';
import {
  audit as auditStockDoc,
  get as getStockDoc,
  list as listStockDocs,
  reverse as reverseStockDoc,
  save as saveStockDoc,
  unaudit as unauditStockDoc,
  type StockDocFilter,
  type StockDocKind,
  type StockDocSaveInput,
} from './services/stock-docs';
import {
  accountFlow,
  listAccounts,
  listBills,
  openBills,
  recomputeAccountBalance,
  type AccountFlowFilter,
  type BillFilter,
  type BillKind,
  type SettleDocFilter,
  type SettleDocKind,
} from './services/finance';
import {
  audit as auditSettleDoc,
  get as getSettleDoc,
  list as listSettleDocs,
  reverse as reverseSettleDoc,
  save as saveSettleDoc,
  unaudit as unauditSettleDoc,
  type SettleDocSaveInput,
} from './services/finance-docs';
import {
  buildReportBuffer,
  reportTitle,
  runReport,
  type ReportFilter,
  type ReportKind,
} from './services/reports';
import { startLanServer, type LanServerHandle } from './services/lan';
import {
  createSyncEngine,
  getSyncConfig,
  setSyncConfig,
  syncCenterState,
  syncNow,
  type SyncConfig,
} from './services/sync';
import {
  listConflicts,
  resolveConflict as resolveSyncConflict,
  type SyncContext,
} from './services/sync-core';
import {
  backupKeep,
  createBackup,
  deleteBackup,
  listBackups,
  restoreFromBackup,
  setBackupKeep,
  type BackupContext,
} from './services/backup';
import { readAppSettings, saveAppSettings, type AppSettings } from './services/settings';
import { applyAutoLaunch } from './services/auto-launch';
import {
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
  type RoleInput,
  type UserInput,
} from './services/auth';

export interface MutateRequest {
  op: 'insert' | 'update' | 'delete';
  entity: string;
  values?: Row;
  id?: string;
  patch?: Row;
}

const XLSX_FILTERS = [{ name: 'Excel 工作簿', extensions: ['xlsx'] }];
const DB_FILTERS = [{ name: 'SQLite 备份文件', extensions: ['db'] }];
const IMAGE_FILTERS = [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp'] }];

/** 商品图片导入的最大边长（像素）与 JPEG 质量。 */
const PRODUCT_IMAGE_MAX_SIDE = 600;
const PRODUCT_IMAGE_JPEG_QUALITY = 80;

/**
 * 读取本地图片并压缩成 data URL（存进 `product.image`）。
 *
 * 用 Electron 自带的 nativeImage 缩放转码，不引入额外图像库；
 * 统一输出 JPEG 以控制单条记录的体积（通常 30–80KB），避免拖慢列表与同步。
 */
function readProductImage(filePath: string): string {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) throw new Error('无法识别该图片，请选择 JPG / PNG 格式的文件');
  const { width, height } = image.getSize();
  const longest = Math.max(width, height);
  const sized =
    longest > PRODUCT_IMAGE_MAX_SIDE
      ? image.resize({
          width: Math.max(1, Math.round((width * PRODUCT_IMAGE_MAX_SIDE) / longest)),
          height: Math.max(1, Math.round((height * PRODUCT_IMAGE_MAX_SIDE) / longest)),
          quality: 'good',
        })
      : image;
  return `data:image/jpeg;base64,${sized.toJPEG(PRODUCT_IMAGE_JPEG_QUALITY).toString('base64')}`;
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerIpcHandlers(db: SqlDatabase, dbFile: string): void {
  const deviceId = ensureDeviceId(db);
  const clock = createHlc(deviceId);
  // P0 未做登录，写入统一记为内置 admin 用户
  const userId = 'user_admin';
  const repo = new Repository(db, { userId, deviceId, clock });
  const docCtx: DocContext = { userId, deviceId, now: () => Date.now() };
  const syncCtx: SyncContext = { deviceId, clock, now: () => Date.now() };
  const syncEngine = createSyncEngine(db, syncCtx);
  const backupCtx: BackupContext = {
    db,
    dbFile,
    backupsDir: join(app.getPath('userData'), 'backups'),
    now: () => Date.now(),
  };
  let lanServer: LanServerHandle | null = null;

  ipcMain.handle('config:get', (_event, key?: string) => {
    return key ? getSysConfig(db, key) : getAllSysConfig(db);
  });

  // ---------------- 设置 ----------------

  ipcMain.handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    deviceId,
    schemaVersion: Number(getSysConfig(db, SysConfigKey.SCHEMA_VERSION) ?? 0),
    dbFile,
    userDataDir: app.getPath('userData'),
    backupsDir: join(app.getPath('userData'), 'backups'),
  }));

  ipcMain.handle('settings:get', () => readAppSettings(db));

  ipcMain.handle('settings:set', (_event, patch: Partial<AppSettings>) => {
    const next = saveAppSettings(db, patch ?? {});
    // 开机自启除了写库，还需同步系统登录项
    if (patch?.autoLaunch !== undefined) applyAutoLaunch(next.autoLaunch);
    return next;
  });

  // ---------------- 登录与权限 ----------------

  /** 登录页用户下拉：启用且未删除的账号。 */
  ipcMain.handle('auth:users', () => loginUsers(db));
  /** 校验账号口令；口令为空的账号直接放行。 */
  ipcMain.handle('auth:login', (_event, id: string, password: string) => login(db, id, password ?? ''));
  /** 按角色取菜单权限（登录后刷新侧边栏用）。 */
  ipcMain.handle('auth:permissions', (_event, roleId: string | null) => rolePermissions(db, roleId));

  ipcMain.handle('auth:listUsers', () => listUsers(db));
  ipcMain.handle('auth:saveUser', (_event, input: UserInput) => saveUser(db, repo, input));
  ipcMain.handle('auth:deleteUser', (_event, id: string) => deleteUser(repo, id));

  ipcMain.handle('auth:listRoles', () => listRoles(db));
  ipcMain.handle('auth:saveRole', (_event, input: RoleInput) => saveRole(db, repo, input));
  ipcMain.handle('auth:deleteRole', (_event, id: string) => deleteRole(db, repo, id));
  ipcMain.handle('auth:rolePermissions', (_event, roleId: string) => rolePermissionKeys(db, roleId));
  ipcMain.handle('auth:setRolePermissions', (_event, roleId: string, keys: string[]) =>
    setRolePermissions(db, repo, roleId, keys ?? []),
  );

  ipcMain.handle(
    'db:query',
    (_event, entity: string, opts?: { includeDeleted?: boolean; limit?: number }) => repo.list(entity, opts),
  );

  ipcMain.handle('db:mutate', (_event, req: MutateRequest) => {
    switch (req.op) {
      case 'insert':
        return repo.insert(req.entity, req.values ?? {});
      case 'update':
        if (!req.id) throw new Error('update 需要 id');
        return repo.update(req.entity, req.id, req.patch ?? {});
      case 'delete':
        if (!req.id) throw new Error('delete 需要 id');
        return repo.softDelete(req.entity, req.id);
      default:
        throw new Error(`未知 op: ${String(req.op)}`);
    }
  });

  // ---------------- 主数据 ----------------

  ipcMain.handle('md:search', (_event, entity: string, query?: Parameters<typeof search>[2]) =>
    search(db, entity, query),
  );

  ipcMain.handle('md:getById', (_event, entity: string, id: string) => getById(db, entity, id));

  ipcMain.handle('md:productDetail', (_event, id: string) => productDetail(db, id));

  /** 商品列表缩略图批量补齐（仅返回带图商品，见 master-data.productThumbnails）。 */
  ipcMain.handle('md:productThumbnails', (_event, ids: string[]) =>
    productThumbnails(db, Array.isArray(ids) ? ids : []),
  );

  ipcMain.handle('md:lookupBarcode', (_event, barcode: string) => lookupBarcode(db, barcode));

  ipcMain.handle('md:saveProductUnit', (_event, input: Parameters<typeof saveProductUnit>[2]) =>
    saveProductUnit(db, repo, input),
  );

  ipcMain.handle('md:deleteProductUnit', (_event, id: string) => deleteProductUnit(repo, id));

  ipcMain.handle('md:categoryTree', (_event, opts?: { includeDisabled?: boolean }) => categoryTree(db, opts));

  ipcMain.handle('md:saveCategory', (_event, input: Parameters<typeof saveCategory>[2]) =>
    saveCategory(db, repo, input),
  );

  ipcMain.handle('md:deleteCategory', (_event, id: string) => deleteCategory(db, repo, id));

  ipcMain.handle('code:next', (_event, target: string) => nextCode(db, repo, target));

  // ---------------- 单据（出入库） ----------------

  ipcMain.handle('doc:list', (_event, kind: DocKind, filter?: DocFilter) => listDocs(db, kind, filter));

  ipcMain.handle('doc:get', (_event, kind: DocKind, id: string) => getDoc(db, kind, id));

  ipcMain.handle('doc:save', (_event, kind: DocKind, input: DocSaveInput) => saveDoc(db, repo, docCtx, kind, input));

  ipcMain.handle('doc:audit', (_event, kind: DocKind, id: string) => auditDoc(db, repo, docCtx, kind, id));

  ipcMain.handle('doc:unaudit', (_event, kind: DocKind, id: string) => unauditDoc(db, repo, docCtx, kind, id));

  ipcMain.handle('doc:reverse', (_event, kind: DocKind, id: string) => reverseDoc(db, repo, docCtx, kind, id));

  ipcMain.handle('doc:transfer', (_event, orderKind: 'purchase_order' | 'sales_order', orderId: string) =>
    transferDoc(db, repo, docCtx, orderKind, orderId),
  );

  // ---------------- 库存（P3） ----------------

  ipcMain.handle('stock:recompute', (_event, filter?: { productId?: string; warehouseId?: string }) =>
    recomputeStock(db, filter ?? {}),
  );

  ipcMain.handle('stock:balance', (_event, filter?: Parameters<typeof listBalance>[1]) => listBalance(db, filter));

  ipcMain.handle('stock:ledger', (_event, filter?: Parameters<typeof listLedger>[1]) => listLedger(db, filter));

  ipcMain.handle('stock:alert', () => alertList(db));

  ipcMain.handle('stock_doc:list', (_event, kind: StockDocKind, filter?: StockDocFilter) =>
    listStockDocs(db, kind, filter),
  );

  ipcMain.handle('stock_doc:get', (_event, kind: StockDocKind, id: string) => getStockDoc(db, kind, id));

  ipcMain.handle('stock_doc:save', (_event, kind: StockDocKind, input: StockDocSaveInput) =>
    saveStockDoc(db, repo, docCtx, kind, input),
  );

  ipcMain.handle('stock_doc:audit', (_event, kind: StockDocKind, id: string) =>
    auditStockDoc(db, repo, docCtx, kind, id),
  );

  ipcMain.handle('stock_doc:unaudit', (_event, kind: StockDocKind, id: string) =>
    unauditStockDoc(db, repo, docCtx, kind, id),
  );

  ipcMain.handle('stock_doc:reverse', (_event, kind: StockDocKind, id: string) =>
    reverseStockDoc(db, repo, docCtx, kind, id),
  );

  // ---------------- 财务（P4） ----------------

  ipcMain.handle('finance:listBills', (_event, kind: BillKind, filter?: BillFilter) => listBills(db, kind, filter));

  ipcMain.handle('finance:openBills', (_event, kind: BillKind, partnerId: string) => openBills(db, kind, partnerId));

  ipcMain.handle('finance:listSettle', (_event, kind: SettleDocKind, filter?: SettleDocFilter) =>
    listSettleDocs(db, kind, filter),
  );

  ipcMain.handle('finance:getSettle', (_event, kind: SettleDocKind, id: string) => getSettleDoc(db, kind, id));

  ipcMain.handle('finance:saveSettle', (_event, kind: SettleDocKind, input: SettleDocSaveInput) =>
    saveSettleDoc(db, repo, docCtx, kind, input),
  );

  ipcMain.handle('finance:auditSettle', (_event, kind: SettleDocKind, id: string) =>
    auditSettleDoc(db, repo, docCtx, kind, id),
  );

  ipcMain.handle('finance:unauditSettle', (_event, kind: SettleDocKind, id: string) =>
    unauditSettleDoc(db, repo, docCtx, kind, id),
  );

  ipcMain.handle('finance:reverseSettle', (_event, kind: SettleDocKind, id: string) =>
    reverseSettleDoc(db, repo, docCtx, kind, id),
  );

  ipcMain.handle('finance:accounts', () => listAccounts(db));

  ipcMain.handle('finance:flow', (_event, filter?: AccountFlowFilter) => accountFlow(db, filter));

  ipcMain.handle('finance:recomputeBalances', () => ({ rows: recomputeAccountBalance(db) }));

  // ---------------- 报表（P5） ----------------

  ipcMain.handle('report:run', (_event, kind: ReportKind, filter?: ReportFilter) =>
    runReport(db, kind, filter ?? {}),
  );

  ipcMain.handle('report:export', async (_event, kind: ReportKind, filter?: ReportFilter) => {
    try {
      const result = runReport(db, kind, filter ?? {});
      const options: SaveDialogOptions = { defaultPath: `${reportTitle(kind)}.xlsx`, filters: XLSX_FILTERS };
      const win = focusedWindow();
      const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (res.canceled || !res.filePath) return { ok: true, canceled: true };
      const buffer = await buildReportBuffer(result);
      await writeFile(res.filePath, buffer);
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  // ---------------- 操作日志（P2 审计） ----------------

  ipcMain.handle('op-log:list', (_event, filter?: OpLogFilter) => listOpLog(db, filter ?? {}));

  ipcMain.handle('op-log:get', (_event, id: string) => getOpLog(db, id));

  // ---------------- 同步（P7） ----------------

  ipcMain.handle('sync:state', () => {
    const state = syncCenterState(db, syncCtx);
    return {
      ...state,
      engineRunning: syncEngine.isRunning(),
      server: lanServer
        ? { running: true, port: lanServer.port, url: lanServer.url }
        : { running: false, port: 0, url: '' },
    };
  });

  ipcMain.handle('sync:config:get', () => getSyncConfig(db));

  ipcMain.handle('sync:config:set', (_event, patch: Partial<SyncConfig>) => setSyncConfig(db, patch));

  ipcMain.handle('sync:now', () => syncNow(db, syncCtx));

  ipcMain.handle('sync:conflicts', (_event, opts?: { status?: number }) => listConflicts(db, opts ?? {}));

  ipcMain.handle('sync:resolve', (_event, input: { id: string; resolvedValue: string | null }) =>
    resolveSyncConflict(db, repo, { ...input, userId, ctx: syncCtx }),
  );

  ipcMain.handle('sync:server:start', async () => {
    if (!lanServer) {
      lanServer = await startLanServer({ db, ctx: syncCtx, port: getSyncConfig(db).port });
    }
    return { running: true, port: lanServer.port, url: lanServer.url };
  });

  ipcMain.handle('sync:server:stop', async () => {
    if (lanServer) {
      await lanServer.close();
      lanServer = null;
    }
    return { running: false, port: 0, url: '' };
  });

  ipcMain.handle('sync:engine:start', () => {
    syncEngine.start();
    return { running: syncEngine.isRunning() };
  });

  ipcMain.handle('sync:engine:stop', () => {
    syncEngine.stop();
    return { running: false };
  });

  // ---------------- Excel ----------------

  ipcMain.handle('excel:templates', () => listTemplates());

  ipcMain.handle('excel:downloadTemplate', async (_event, id: string) => {
    try {
      const tpl = listTemplates().find((t) => t.id === id);
      const defaultPath = `${tpl ? tpl.name : id}.xlsx`;
      const options: SaveDialogOptions = { defaultPath, filters: XLSX_FILTERS };
      const win = focusedWindow();
      const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (res.canceled || !res.filePath) return { ok: true, canceled: true };
      const buffer = await buildTemplateBuffer(id);
      await writeFile(res.filePath, buffer);
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  // ---------------- 商品图片 ----------------

  /**
   * 选择本地图片并压缩为 data URL 返回（不落库）。
   * 由渲染进程放进商品表单，随商品保存一起写库，这样图片自然带上版本与同步字段。
   */
  ipcMain.handle('product:pickImage', async () => {
    try {
      const options: OpenDialogOptions = { properties: ['openFile'], filters: IMAGE_FILTERS };
      const win = focusedWindow();
      const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (res.canceled || res.filePaths.length === 0) return { ok: true, canceled: true };
      return { ok: true, dataUrl: readProductImage(res.filePaths[0]) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('excel:pickFile', async () => {
    try {
      const options: OpenDialogOptions = { properties: ['openFile'], filters: XLSX_FILTERS };
      const win = focusedWindow();
      const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (res.canceled || res.filePaths.length === 0) return { ok: true, canceled: true };
      return { ok: true, path: res.filePaths[0] };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('excel:import', async (_event, id: string, filePath: string) => {
    try {
      const buffer = await readFile(filePath);
      return await importFromBuffer(db, repo, id, buffer);
    } catch (err) {
      return { template: id, total: 0, success: 0, failed: 0, errors: [{ row: 0, message: errorMessage(err) }] };
    }
  });

  ipcMain.handle('excel:exportEntity', async (_event, entity: string) => {
    try {
      const options: SaveDialogOptions = { defaultPath: `${entity}.xlsx`, filters: XLSX_FILTERS };
      const win = focusedWindow();
      const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (res.canceled || !res.filePath) return { ok: true, canceled: true };
      const buffer = await buildExportBuffer(db, entity);
      await writeFile(res.filePath, buffer);
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  // ---------------- 备份 / 恢复（P8） ----------------

  ipcMain.handle('backup:list', () => listBackups(db));

  ipcMain.handle('backup:create', () => {
    try {
      return { ok: true, record: createBackup(backupCtx) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('backup:export', async () => {
    try {
      const d = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const options: SaveDialogOptions = { defaultPath: `轻松进销存备份-${stamp}.db`, filters: DB_FILTERS };
      const win = focusedWindow();
      const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (res.canceled || !res.filePath) return { ok: true, canceled: true };
      return { ok: true, record: createBackup(backupCtx, { destPath: res.filePath, remark: '另存副本' }) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('backup:pickFile', async () => {
    try {
      const options: OpenDialogOptions = { properties: ['openFile'], filters: DB_FILTERS };
      const win = focusedWindow();
      const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (res.canceled || res.filePaths.length === 0) return { ok: true, canceled: true };
      return { ok: true, path: res.filePaths[0] };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('backup:delete', (_event, id: string) => {
    try {
      deleteBackup(backupCtx, id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });

  ipcMain.handle('backup:keep:get', () => backupKeep(db));

  ipcMain.handle('backup:keep:set', (_event, keep: number) => setBackupKeep(db, keep));

  ipcMain.handle('backup:restore', async (_event, filePath: string) => {
    try {
      // 恢复会替换整个主库：先停掉后台同步与 LAN 服务，避免对即将关闭的连接继续写入
      syncEngine.stop();
      if (lanServer) {
        await lanServer.close();
        lanServer = null;
      }
      const { safetyPath } = restoreFromBackup(backupCtx, filePath);
      // 稍后重启：留出时间把 IPC 结果回给渲染进程
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 400);
      return { ok: true, safetyPath, restarting: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });
}
