import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';

import { runPackagedCredentialStoreSmoke } from '../adapters/credentials/packaged-credential-smoke';
import { SystemApiKeyStore } from '../adapters/credentials/system-api-key-store';
import type { OrderDraft } from '../core/contracts';
import type {
  OcrConnectionTestInput,
  SaveOcrSettingsInput,
} from '../core/ocr-settings';
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
  ipcMain.handle('workflow:get-draft', (_event, draftId: unknown) => {
    return desktopSession.getDraft(parseDraftId(draftId));
  });
  desktopSession.onRecognitionBatchesChanged((batches) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('workflow:recognition-batches-changed', batches);
  });

  ipcMain.handle('workflow:confirm-draft', (_event, draft: OrderDraft) => {
    return desktopSession.confirmDraft(draft);
  });
  ipcMain.handle('workflow:cancel-draft', (_event, draftId: unknown) => {
    return desktopSession.cancelDraft(parseDraftId(draftId));
  });
  ipcMain.handle('orders:list', () => desktopSession.listOrders());
  ipcMain.handle('orders:get', (_event, orderId: string) => desktopSession.getOrder(orderId));
  ipcMain.handle('evidence:get-screenshot-data-url', (_event, screenshotId: string) => {
    return desktopSession.getScreenshotDataUrl(screenshotId);
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
  if (typeof draftId !== 'string' || !draftId.trim() || draftId.length > 128) {
    throw new Error('订单草稿 ID 格式无效');
  }
  return draftId.trim();
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
