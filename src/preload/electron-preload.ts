import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopApi } from '../core/desktop-api';

const api: DesktopApi = {
  getBootstrapState: () => ipcRenderer.invoke('app:get-bootstrap-state'),
  retryDataDirectory: () => ipcRenderer.invoke('app:retry-data-directory'),
  selectDataDirectory: () => ipcRenderer.invoke('app:select-data-directory'),
  selectSourceScreenshots: () => ipcRenderer.invoke('workflow:select-source-screenshots'),
  listRecognitionBatches: () => ipcRenderer.invoke('workflow:list-recognition-batches'),
  getDraft: (draftId) => ipcRenderer.invoke('workflow:get-draft', draftId),
  onRecognitionBatchesChanged: (listener) => {
    const ipcListener = (
      _event: Electron.IpcRendererEvent,
      batches: Parameters<typeof listener>[0],
    ) => listener(batches);
    ipcRenderer.on('workflow:recognition-batches-changed', ipcListener);
    return () => {
      ipcRenderer.removeListener('workflow:recognition-batches-changed', ipcListener);
    };
  },
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
