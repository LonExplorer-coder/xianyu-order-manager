import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopApi } from '../core/desktop-api';

const api: DesktopApi = {
  getBootstrapState: () => ipcRenderer.invoke('app:get-bootstrap-state'),
  retryDataDirectory: () => ipcRenderer.invoke('app:retry-data-directory'),
  selectDataDirectory: () => ipcRenderer.invoke('app:select-data-directory'),
  selectSourceScreenshots: () => ipcRenderer.invoke('workflow:select-source-screenshots'),
  listRecognitionBatches: () => ipcRenderer.invoke('workflow:list-recognition-batches'),
  retryRecognitionItem: (batchId, itemId) => (
    ipcRenderer.invoke('workflow:retry-recognition-item', batchId, itemId)
  ),
  createManualDraft: (batchId, itemId) => (
    ipcRenderer.invoke('workflow:create-manual-draft', batchId, itemId)
  ),
  getDraft: (draftId) => ipcRenderer.invoke('workflow:get-draft', draftId),
  getDraftReview: (draftId) => ipcRenderer.invoke('workflow:get-draft-review', draftId),
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
  confirmOrderUpdate: (draft, expectedRevision) => (
    ipcRenderer.invoke('workflow:confirm-order-update', draft, expectedRevision)
  ),
  listOrders: () => ipcRenderer.invoke('orders:list'),
  onOrdersChanged: (listener) => {
    const ipcListener = (
      _event: Electron.IpcRendererEvent,
      orders: Parameters<typeof listener>[0],
    ) => listener(orders);
    ipcRenderer.on('orders:changed', ipcListener);
    return () => {
      ipcRenderer.removeListener('orders:changed', ipcListener);
    };
  },
  getOrder: (orderId) => ipcRenderer.invoke('orders:get', orderId),
  getScreenshotDataUrl: (screenshotId) =>
    ipcRenderer.invoke('evidence:get-screenshot-data-url', screenshotId),
  getOrderIntakeSettings: () => ipcRenderer.invoke('settings:get-order-intake'),
  saveOrderIntakeSettings: (input) => (
    ipcRenderer.invoke('settings:save-order-intake', input)
  ),
  getOcrSettings: () => ipcRenderer.invoke('settings:get-ocr'),
  saveOcrSettings: (input) => ipcRenderer.invoke('settings:save-ocr', input),
  removeOcrApiKey: () => ipcRenderer.invoke('settings:remove-ocr-api-key'),
  testOcrConnection: (input) => ipcRenderer.invoke('settings:test-ocr', input),
};

contextBridge.exposeInMainWorld('xianyuApi', api);
