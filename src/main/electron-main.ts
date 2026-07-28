import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';

import { ControlledRecognizer } from '../adapters/recognition/controlled-recognizer';
import type { OrderDraft } from '../core/contracts';
import { DesktopSession } from './desktop-session';
import { Preferences } from './preferences';

let mainWindow: BrowserWindow | undefined;
let session: DesktopSession | undefined;

const controlledRecognizer = new ControlledRecognizer({
  platform: 'xianyu',
  sellerAccount: '默认闲鱼账号',
  orderNumber: 'XY-DEMO-20260727-001',
  buyerNickname: '演示买家',
  recipient: '测试收件人',
  phone: '13800000000',
  addressOriginal: '广东省深圳市南山区测试路1号',
  amountCents: 2_600,
  items: [
    {
      sourceTitle: '演示商品 A',
      sourceSpec: '白色',
      unitPriceCents: 800,
      quantity: 2,
      quantityInferred: false,
    },
    {
      sourceTitle: '演示商品 B',
      sourceSpec: '标准款',
      unitPriceCents: 1_000,
      quantity: 1,
      quantityInferred: true,
    },
  ],
});

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

  ipcMain.handle('workflow:select-source-screenshot', async () => {
    const window = requireWindow();
    const selection = await dialog.showOpenDialog(window, {
      title: '选择一张包含完整闲鱼订单详情的来源截图',
      buttonLabel: '识别此来源截图',
      properties: ['openFile'],
      filters: [
        { name: '来源截图', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      ],
    });
    if (selection.canceled || selection.filePaths.length === 0) return null;
    return desktopSession.submitSourceScreenshot(selection.filePaths[0]);
  });

  ipcMain.handle('workflow:confirm-draft', (_event, draft: OrderDraft) => {
    return desktopSession.confirmDraft(draft);
  });
  ipcMain.handle('orders:list', () => desktopSession.listOrders());
  ipcMain.handle('orders:get', (_event, orderId: string) => desktopSession.getOrder(orderId));
  ipcMain.handle('evidence:get-screenshot-data-url', (_event, screenshotId: string) => {
    return desktopSession.getScreenshotDataUrl(screenshotId);
  });
}

function requireWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('应用窗口尚未就绪');
  return mainWindow;
}

void app.whenReady().then(() => {
  session = new DesktopSession(
    new Preferences(join(app.getPath('userData'), 'bootstrap')),
    controlledRecognizer,
  );
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
