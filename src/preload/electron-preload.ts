import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopApi } from '../core/desktop-api';

const api: DesktopApi = {
  getBootstrapState: () => ipcRenderer.invoke('app:get-bootstrap-state'),
  retryDataDirectory: () => ipcRenderer.invoke('app:retry-data-directory'),
  selectDataDirectory: () => ipcRenderer.invoke('app:select-data-directory'),
  selectSourceScreenshot: () => ipcRenderer.invoke('workflow:select-source-screenshot'),
  confirmDraft: (draft) => ipcRenderer.invoke('workflow:confirm-draft', draft),
  listOrders: () => ipcRenderer.invoke('orders:list'),
  getOrder: (orderId) => ipcRenderer.invoke('orders:get', orderId),
  getScreenshotDataUrl: (screenshotId) =>
    ipcRenderer.invoke('evidence:get-screenshot-data-url', screenshotId),
};

contextBridge.exposeInMainWorld('xianyuApi', api);
