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
  confirmDraft: (draft, customValues, productStandardizations) => (
    ipcRenderer.invoke(
      'workflow:confirm-draft',
      draft,
      customValues,
      productStandardizations,
    )
  ),
  confirmOrderUpdate: (
    draft,
    expectedRevision,
    customValues,
    productStandardizations,
  ) => (
    ipcRenderer.invoke(
      'workflow:confirm-order-update',
      draft,
      expectedRevision,
      customValues,
      productStandardizations,
    )
  ),
  listStandardProducts: () => ipcRenderer.invoke('products:list'),
  createStandardProduct: (input) => ipcRenderer.invoke('products:create', input),
  updateStandardProduct: (productId, input) => (
    ipcRenderer.invoke('products:update', productId, input)
  ),
  listStandardProductPriceEvents: (productId) => (
    ipcRenderer.invoke('products:price-events', productId)
  ),
  getProductMappingStats: (productId) => (
    ipcRenderer.invoke('products:mapping-stats', productId)
  ),
  listProductMappings: (productId, search) => (
    ipcRenderer.invoke('products:list-mappings', productId, search)
  ),
  listProductMappingEvents: (productId) => (
    ipcRenderer.invoke('products:list-mapping-events', productId)
  ),
  createProductMapping: (productId, input) => (
    ipcRenderer.invoke('products:create-mapping', productId, input)
  ),
  findProductMappingConflict: (input) => (
    ipcRenderer.invoke('products:find-mapping-conflict', input)
  ),
  correctProductMapping: (mappingId, input) => (
    ipcRenderer.invoke('products:correct-mapping', mappingId, input)
  ),
  disableProductMapping: (mappingId, input) => (
    ipcRenderer.invoke('products:disable-mapping', mappingId, input)
  ),
  deleteProductMapping: (mappingId, input) => (
    ipcRenderer.invoke('products:delete-mapping', mappingId, input)
  ),
  previewDraftProductStandardizations: (draft) => (
    ipcRenderer.invoke('products:preview-draft-standardizations', draft)
  ),
  listOrders: () => ipcRenderer.invoke('orders:list'),
  queryOrders: (query, customFieldDefinitionIds) => (
    ipcRenderer.invoke('orders:query', query, customFieldDefinitionIds)
  ),
  queryOrderItems: (query, customFieldDefinitionIds) => (
    ipcRenderer.invoke('order-items:query', query, customFieldDefinitionIds)
  ),
  queryShipmentGroups: () => ipcRenderer.invoke('shipment-groups:query'),
  queryShipmentGroupWorkbench: (query, customFieldDefinitionIds) => (
    ipcRenderer.invoke(
      'shipment-groups:query-workbench',
      query,
      customFieldDefinitionIds,
    )
  ),
  saveShipmentGroupCustomFieldValues: (input) => (
    ipcRenderer.invoke('shipment-groups:save-custom-field-values', input)
  ),
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
  recordShipmentPackageLogisticsException: (input) => (
    ipcRenderer.invoke('shipment-records:record-package-logistics-exception', input)
  ),
  progressShipmentPackageLogisticsException: (input) => (
    ipcRenderer.invoke('shipment-records:progress-package-logistics-exception', input)
  ),
  progressShipmentPackageCarrierClaim: (input) => (
    ipcRenderer.invoke('shipment-records:progress-package-carrier-claim', input)
  ),
  queryAftersalesCases: (query) => ipcRenderer.invoke('aftersales-cases:query', query),
  listAftersalesWorkflowTemplates: () => ipcRenderer.invoke('aftersales-workflows:list'),
  setAftersalesWorkflowTemplateEnabled: (templateId, enabled) => (
    ipcRenderer.invoke('aftersales-workflows:set-enabled', templateId, enabled)
  ),
  createAftersalesWorkflowTemplate: (input) => (
    ipcRenderer.invoke('aftersales-workflows:create', input)
  ),
  copyAftersalesWorkflowTemplate: (input) => (
    ipcRenderer.invoke('aftersales-workflows:copy', input)
  ),
  updateAftersalesWorkflowTemplate: (templateId, input) => (
    ipcRenderer.invoke('aftersales-workflows:update', templateId, input)
  ),
  createAftersalesCase: (input) => ipcRenderer.invoke('aftersales-cases:create', input),
  changeAftersalesCaseWorkflowTemplate: (input) => (
    ipcRenderer.invoke('aftersales-cases:change-workflow', input)
  ),
  updateAftersalesCase: (input) => ipcRenderer.invoke('aftersales-cases:update', input),
  progressAftersalesCase: (input) => ipcRenderer.invoke('aftersales-cases:progress', input),
  queryFulfillmentPlans: (query) => ipcRenderer.invoke('fulfillment-plans:query', query),
  createFulfillmentPlan: (input) => ipcRenderer.invoke('fulfillment-plans:create', input),
  addFulfillmentPlanOrders: (input) => (
    ipcRenderer.invoke('fulfillment-plans:add-orders', input)
  ),
  removeFulfillmentPlanOrder: (input) => (
    ipcRenderer.invoke('fulfillment-plans:remove-order', input)
  ),
  releaseFulfillmentPlanOrders: (input) => (
    ipcRenderer.invoke('fulfillment-plans:release-orders', input)
  ),
  updateFulfillmentPlan: (input) => ipcRenderer.invoke('fulfillment-plans:update', input),
  closeFulfillmentPlan: (input) => ipcRenderer.invoke('fulfillment-plans:close', input),
  queryFulfillmentPlanProgress: (planId) => (
    ipcRenderer.invoke('fulfillment-plans:progress', planId)
  ),
  queryFulfillmentPlanOrderCandidates: () => (
    ipcRenderer.invoke('fulfillment-plans:order-candidates')
  ),
  exportOrders: (input) => ipcRenderer.invoke('orders:export', input),
  previewOrderExport: (input) => ipcRenderer.invoke('orders:preview-export', input),
  exportShipmentGroups: (input) => ipcRenderer.invoke('shipment-groups:export', input),
  previewShipmentGroupExport: (input) => (
    ipcRenderer.invoke('shipment-groups:preview-export', input)
  ),
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
  getReadableOrderNumbers: (orderIds) => ipcRenderer.invoke('orders:readable-numbers', orderIds),
  queryRecipients: () => ipcRenderer.invoke('recipients:query'),
  queryRecipientOrders: (recipientId) => ipcRenderer.invoke('recipients:orders', recipientId),
  mergeRecipients: (input) => ipcRenderer.invoke('recipients:merge', input),
  updateOrder: (input) => ipcRenderer.invoke('orders:update', input),
  updateOrderItemStandardization: (orderId, itemId, input) => (
    ipcRenderer.invoke('orders:update-item-standardization', orderId, itemId, input)
  ),
  previewOrderItemStandardizationBatch: (input) => (
    ipcRenderer.invoke('order-items:preview-standardization-batch', input)
  ),
  applyOrderItemStandardizationBatch: (input) => (
    ipcRenderer.invoke('order-items:apply-standardization-batch', input)
  ),
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
  getActiveTableTemplates: () => ipcRenderer.invoke('table-templates:get-active'),
  setActiveTableTemplate: (granularity, templateId) => (
    ipcRenderer.invoke('table-templates:set-active', granularity, templateId)
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
