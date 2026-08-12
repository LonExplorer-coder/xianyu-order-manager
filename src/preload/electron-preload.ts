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
  getCandidateAdjudicationAudit: (draftId) => (
    ipcRenderer.invoke('workflow:get-candidate-adjudication-audit', draftId)
  ),
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
  confirmDraft: (draft, customValues) => (
    ipcRenderer.invoke('workflow:confirm-draft', draft, customValues)
  ),
  confirmOrderUpdate: (draft, expectedRevision, customValues) => (
    ipcRenderer.invoke(
      'workflow:confirm-order-update',
      draft,
      expectedRevision,
      customValues,
    )
  ),
  listOrders: () => ipcRenderer.invoke('orders:list'),
  queryOrders: (query, customFieldDefinitionIds) => (
    ipcRenderer.invoke('orders:query', query, customFieldDefinitionIds)
  ),
  queryOrderItems: (query, customFieldDefinitionIds) => (
    ipcRenderer.invoke('order-items:query', query, customFieldDefinitionIds)
  ),
  queryShipmentGroups: () => ipcRenderer.invoke('shipment-groups:query'),
  splitShipmentGroup: (input) => ipcRenderer.invoke('shipment-groups:split', input),
  mergeShipmentGroups: (input) => ipcRenderer.invoke('shipment-groups:merge', input),
  queryShipmentGroupArchives: () => ipcRenderer.invoke('shipment-group-archives:query'),
  confirmShipment: (input) => ipcRenderer.invoke('shipment-records:confirm', input),
  cancelShipmentPackages: (input) => (
    ipcRenderer.invoke('shipment-records:cancel-packages', input)
  ),
  correctShipmentPackageLogistics: (input) => (
    ipcRenderer.invoke('shipment-records:correct-package-logistics', input)
  ),
  updateShipmentPackageLogisticsStatus: (input) => (
    ipcRenderer.invoke('shipment-records:update-package-logistics-status', input)
  ),
  queryAftersalesCases: (query) => ipcRenderer.invoke('aftersales-cases:query', query),
  createAftersalesCase: (input) => ipcRenderer.invoke('aftersales-cases:create', input),
  updateAftersalesCase: (input) => ipcRenderer.invoke('aftersales-cases:update', input),
  exportOrders: (input) => ipcRenderer.invoke('orders:export', input),
  previewOrderExport: (input) => ipcRenderer.invoke('orders:preview-export', input),
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
  updateOrder: (input) => ipcRenderer.invoke('orders:update', input),
  updateOrderPlatformTransactionStatus: (input) => (
    ipcRenderer.invoke('orders:update-platform-transaction-status', input)
  ),
  listCustomFieldDefinitions: () => ipcRenderer.invoke('custom-fields:list'),
  createCustomFieldDefinition: (input) => (
    ipcRenderer.invoke('custom-fields:create', input)
  ),
  listTableTemplates: (granularity) => (
    ipcRenderer.invoke('table-templates:list', granularity)
  ),
  createTableTemplate: (input) => (
    ipcRenderer.invoke('table-templates:create', input)
  ),
  updateTableTemplate: (templateId, input) => (
    ipcRenderer.invoke('table-templates:update', templateId, input)
  ),
  deleteTableTemplate: (templateId) => (
    ipcRenderer.invoke('table-templates:delete', templateId)
  ),
  saveCustomFieldValues: (input) => ipcRenderer.invoke('custom-fields:save-values', input),
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
  getCandidateVerificationSettings: () => (
    ipcRenderer.invoke('settings:get-candidate-verification')
  ),
  saveCandidateVerificationSettings: (input) => (
    ipcRenderer.invoke('settings:save-candidate-verification', input)
  ),
  removeCandidateVerificationApiKey: () => (
    ipcRenderer.invoke('settings:remove-candidate-verification-api-key')
  ),
  testCandidateVerificationConnection: (input) => (
    ipcRenderer.invoke('settings:test-candidate-verification', input)
  ),
};

contextBridge.exposeInMainWorld('xianyuApi', api);
