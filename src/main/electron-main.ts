import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';

import { runPackagedCredentialStoreSmoke } from '../adapters/credentials/packaged-credential-smoke';
import { SystemApiKeyStore } from '../adapters/credentials/system-api-key-store';
import type { OrderDraft } from '../core/contracts';
import type {
  OcrConnectionTestInput,
  SaveOcrSettingsInput,
} from '../core/ocr-settings';
import type { SaveOrderIntakeSettingsInput } from '../core/order-intake';
import type { OrderWorkbenchQuery } from '../core/order-workbench';
import { DesktopSession } from './desktop-session';
import { createConfiguredDesktopSession } from './production-session';
import {
  selectedSourceScreenshotDirectory,
  sourceScreenshotDialogOptions,
} from './source-screenshot-dialog';

let mainWindow: BrowserWindow | undefined;
let session: DesktopSession | undefined;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 660,
    title: '闲鱼订单管理',
    backgroundColor: '#f2f3ef',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'electron-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  window.once('ready-to-show', () => window.show());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  return window;
}

function registerIpcHandlers(desktopSession: DesktopSession): void {
  ipcMain.handle('app:get-bootstrap-state', () => desktopSession.getState());
  ipcMain.handle('app:retry-data-directory', () => desktopSession.retryDataDirectory());

  ipcMain.handle('app:select-data-directory', async () => {
    const window = requireWindow();
    const selection = await dialog.showOpenDialog(window, {
      title: '选择闲鱼订单数据目录',
      buttonLabel: '使用此目录',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return desktopSession.getState();
    }
    return desktopSession.useDataDirectory(selection.filePaths[0]);
  });

  ipcMain.handle('workflow:select-source-screenshots', async () => {
    const window = requireWindow();
    const selection = await dialog.showOpenDialog(
      window,
      sourceScreenshotDialogOptions(
        desktopSession.getLastSourceScreenshotDirectory(),
      ),
    );
    if (selection.canceled || selection.filePaths.length === 0) return null;
    const sourceDirectory = selectedSourceScreenshotDirectory(selection);
    if (sourceDirectory) {
      desktopSession.rememberSourceScreenshotDirectory(sourceDirectory);
    }
    return desktopSession.submitSourceScreenshots(selection.filePaths);
  });
  ipcMain.handle('workflow:list-recognition-batches', () => (
    desktopSession.listRecognitionBatches()
  ));
  ipcMain.handle(
    'workflow:retry-recognition-item',
    (_event, batchId: unknown, itemId: unknown) => (
      desktopSession.retryRecognitionItem(
        parseWorkflowId(batchId, '识别批次'),
        parseWorkflowId(itemId, '来源截图'),
      )
    ),
  );
  ipcMain.handle(
    'workflow:create-manual-draft',
    (_event, batchId: unknown, itemId: unknown) => (
      desktopSession.createManualDraft(
        parseWorkflowId(batchId, '识别批次'),
        parseWorkflowId(itemId, '来源截图'),
      )
    ),
  );
  ipcMain.handle('workflow:get-draft', (_event, draftId: unknown) => {
    return desktopSession.getDraft(parseDraftId(draftId));
  });
  ipcMain.handle('workflow:get-draft-review', (_event, draftId: unknown) => {
    return desktopSession.getDraftReview(parseDraftId(draftId));
  });
  desktopSession.onRecognitionBatchesChanged((batches) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('workflow:recognition-batches-changed', batches);
  });
  desktopSession.onOrdersChanged((orders) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('orders:changed', orders);
  });

  ipcMain.handle('workflow:confirm-draft', (_event, draft: OrderDraft) => {
    return desktopSession.confirmDraft(draft);
  });
  ipcMain.handle(
    'workflow:confirm-order-update',
    (_event, draft: OrderDraft, expectedRevision: unknown) => (
      desktopSession.confirmOrderUpdate(
        draft,
        parseExpectedRevision(expectedRevision),
      )
    ),
  );
  ipcMain.handle('workflow:cancel-draft', (_event, draftId: unknown) => {
    return desktopSession.cancelDraft(parseDraftId(draftId));
  });
  ipcMain.handle('orders:list', () => desktopSession.listOrders());
  ipcMain.handle('orders:query', (_event, input: unknown) => (
    desktopSession.queryOrders(parseOrderWorkbenchQuery(input))
  ));
  ipcMain.handle('orders:get', (_event, orderId: string) => desktopSession.getOrder(orderId));
  ipcMain.handle('evidence:get-screenshot-data-url', (_event, screenshotId: string) => {
    return desktopSession.getScreenshotDataUrl(screenshotId);
  });
  ipcMain.handle('settings:get-order-intake', () => {
    return desktopSession.getOrderIntakeSettings();
  });
  ipcMain.handle('settings:save-order-intake', (_event, input: unknown) => {
    return desktopSession.saveOrderIntakeSettings(parseSaveOrderIntakeSettingsInput(input));
  });
  ipcMain.handle('settings:get-ocr', () => desktopSession.getOcrSettings());
  ipcMain.handle('settings:save-ocr', (_event, input: unknown) => {
    return desktopSession.saveOcrSettings(parseSaveOcrSettingsInput(input));
  });
  ipcMain.handle('settings:remove-ocr-api-key', () => {
    return desktopSession.removeOcrApiKey();
  });
  ipcMain.handle('settings:test-ocr', (_event, input: unknown) => {
    return desktopSession.testOcrConnection(parseConnectionTestInput(input));
  });
}

function parseDraftId(draftId: unknown): string {
  return parseWorkflowId(draftId, '订单草稿');
}

const ORDER_WORKBENCH_QUERY_KEYS = new Set([
  'text',
  'buyerText',
  'productText',
  'dateField',
  'dateFrom',
  'dateTo',
  'platform',
  'sellerAccount',
  'initialSourceRecognitionStatus',
  'platformTransactionStatus',
  'fulfillmentStatus',
  'lifecycleStatus',
  'sortField',
  'sortDirection',
]);

function parseOrderWorkbenchQuery(input: unknown): OrderWorkbenchQuery {
  if (!isRecord(input)) throw new Error('订单工作台查询格式无效');
  if (Object.keys(input).some((key) => !ORDER_WORKBENCH_QUERY_KEYS.has(key))) {
    throw new Error('订单工作台查询包含未知字段');
  }
  const dateFrom = optionalWorkbenchDate(input.dateFrom);
  const dateTo = optionalWorkbenchDate(input.dateTo);
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new Error('订单工作台开始日期不能晚于结束日期');
  }
  return {
    text: optionalWorkbenchText(input.text, 256),
    buyerText: optionalWorkbenchText(input.buyerText, 128),
    productText: optionalWorkbenchText(input.productText, 128),
    dateField: optionalWorkbenchEnum(
      input.dateField,
      ['ordered_at', 'paid_at', 'created_at'] as const,
      '日期字段',
    ),
    dateFrom,
    dateTo,
    platform: optionalWorkbenchEnum(input.platform, ['xianyu'] as const, '平台'),
    sellerAccount: optionalWorkbenchText(input.sellerAccount, 128),
    initialSourceRecognitionStatus: optionalWorkbenchEnum(
      input.initialSourceRecognitionStatus,
      [
        'waiting_recognition', 'recognizing', 'validating',
        'awaiting_confirmation', 'imported', 'waiting_retry', 'failed',
        'duplicate_skipped', 'cancelled',
      ] as const,
      '初始来源识别状态',
    ),
    platformTransactionStatus: optionalWorkbenchEnum(
      input.platformTransactionStatus,
      ['paid', 'cancelled', 'refunded', 'unknown'] as const,
      '平台交易状态',
    ),
    fulfillmentStatus: optionalWorkbenchEnum(
      input.fulfillmentStatus,
      ['pending_shipment', 'shipped', 'unknown'] as const,
      '履约状态',
    ),
    lifecycleStatus: optionalWorkbenchEnum(
      input.lifecycleStatus,
      ['active', 'trashed', 'deleted', 'all'] as const,
      '生命周期状态',
    ),
    sortField: optionalWorkbenchEnum(
      input.sortField,
      [
        'ordered_at', 'paid_at', 'created_at', 'amount', 'platform',
        'seller_account', 'buyer', 'product', 'initial_source_recognition_status',
        'platform_transaction_status', 'fulfillment_status', 'lifecycle_status',
      ] as const,
      '排序字段',
    ),
    sortDirection: optionalWorkbenchEnum(
      input.sortDirection,
      ['asc', 'desc'] as const,
      '排序方向',
    ),
  };
}

function optionalWorkbenchText(value: unknown, maximumLength: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new Error('订单工作台搜索文本格式无效');
  }
  const normalized = value.normalize('NFKC').trim();
  return normalized || undefined;
}

function optionalWorkbenchDate(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error('订单工作台日期格式无效');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('订单工作台日期格式无效');
  }
  return value;
}

function optionalWorkbenchEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new Error(`订单工作台${label}格式无效`);
  }
  return value as T[number];
}

function parseExpectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('订单版本无效，请刷新后重试');
  }
  return value as number;
}

function parseWorkflowId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new Error(`${label} ID 格式无效`);
  }
  return value.trim();
}

function requireWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('应用窗口尚未就绪');
  return mainWindow;
}

void app.whenReady().then(async () => {
  if (process.env.XIANYU_PACKAGED_CREDENTIAL_SMOKE === '1') {
    try {
      await runPackagedCredentialStoreSmoke();
      console.log('Packaged credential store smoke test passed and cleaned up.');
      app.exit(0);
    } catch (error) {
      console.error(
        'Packaged credential store smoke test failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
      app.exit(1);
    }
    return;
  }

  const configDirectory = join(app.getPath('userData'), 'bootstrap');
  session = createConfiguredDesktopSession({
    configDirectory,
    apiKeyStore: new SystemApiKeyStore(),
  });
  session.restore();
  registerIpcHandlers(session);
  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  session?.close();
});

function parseSaveOcrSettingsInput(input: unknown): SaveOcrSettingsInput {
  if (!isRecord(input)) throw new Error('OCR 设置格式无效');
  const workspaceId = asBoundedString(input.workspaceId, 128, 'Workspace ID');
  const apiKey = asBoundedString(input.apiKey, 4_096, 'API Key', true);
  if (input.region !== 'cn-beijing') throw new Error('当前暂不支持该百炼地域');
  return { workspaceId, apiKey, region: input.region };
}

function parseSaveOrderIntakeSettingsInput(input: unknown): SaveOrderIntakeSettingsInput {
  if (!isRecord(input) || typeof input.automaticImportEnabled !== 'boolean') {
    throw new Error('订单接收设置格式无效');
  }
  return { automaticImportEnabled: input.automaticImportEnabled };
}

function parseConnectionTestInput(input: unknown): OcrConnectionTestInput {
  if (!isRecord(input) || input.consentToPaidCall !== true) {
    throw new Error('请先确认本次测试会产生一次 OCR 调用');
  }
  return { consentToPaidCall: true };
}

function asBoundedString(
  value: unknown,
  maximumLength: number,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new Error(`${label} 格式无效`);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error(`请输入百炼 ${label}`);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
