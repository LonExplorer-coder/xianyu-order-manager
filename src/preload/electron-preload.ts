import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopApi } from '../core/desktop-api';

const api: DesktopApi = {
  getBootstrapState: () => ipcRenderer.invoke('app:get-bootstrap-state'),
  retryDataDirectory: () => ipcRenderer.invoke('app:retry-data-directory'),
  selectDataDirectory: () => ipcRenderer.invoke('app:select-data-directory'),
  selectSourceScreenshot: () => ipcRenderer.invoke('workflow:select-source-screenshot'),
  cancelDraft: (draftId) => ipcRenderer.invoke('workflow:cancel-draft', draftId),
  confirmDraft: (draft) => ipcRenderer.invoke('workflow:confirm-draft', draft),
  listOrders: () => ipcRenderer.invoke('orders:list'),
  getOrder: (orderId) => ipcRenderer.invoke('orders:get', orderId),
  getScreenshotDataUrl: (screenshotId) =>
    ipcRenderer.invoke('evidence:get-screenshot-data-url', screenshotId),
  getOcrSettings: () => ipcRenderer.invoke('settings:get-ocr'),
  saveOcrSettings: (input) => ipcRenderer.invoke('settings:save-ocr', input),
  removeOcrApiKey: () => ipcRenderer.invoke('settings:remove-ocr-api-key'),
  testOcrConnection: (input) => ipcRenderer.invoke('settings:test-ocr', input),
};

contextBridge.exposeInMainWorld('xianyuApi', api);
