import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { basename, extname, join } from 'node:path';

import { runPackagedCredentialStoreSmoke } from '../adapters/credentials/packaged-credential-smoke';
import { SystemApiKeyStore } from '../adapters/credentials/system-api-key-store';
import type { OrderDraft } from '../core/contracts';
import type {
  CreateCustomFieldDefinitionInput,
  CustomFieldFilter,
  CustomFieldSort,
  CustomFieldValue,
  DraftCustomFieldValues,
  SaveCustomFieldValuesInput,
  SaveShipmentGroupCustomFieldValuesInput,
} from '../core/custom-fields';
import type {
  OcrConnectionTestInput,
  SaveOcrSettingsInput,
} from '../core/ocr-settings';
import type {
  CandidateVerificationConnectionTestInput,
  CandidateVerificationProvider,
  SaveCandidateVerificationSettingsInput,
} from '../core/candidate-verification-settings';
import type { SaveOrderIntakeSettingsInput } from '../core/order-intake';
import { normalizeOrderExportInput } from '../core/order-export';
import { normalizeShipmentGroupExportInput } from '../core/shipment-group-export';
import type {
  OrderItemWorkbenchQuery,
  OrderWorkbenchQuery,
} from '../core/order-workbench';
import { FULFILLMENT_STATUSES } from '../core/fulfillment-status';
import { QUANTITY_SOURCES } from '../core/quantity-source';
import {
  normalizeProductStandardizationConfirmations,
  normalizeStandardProductInput,
  normalizeUpdateStandardProductInput,
} from '../core/product-standardization';
import {
  normalizeCreateTableTemplateInput,
  normalizeShipmentGroupWorkbenchQuery,
  normalizeUpdateTableTemplateInput,
  type TableTemplateGranularity,
} from '../core/table-templates';
import { DesktopSession } from './desktop-session';
import { assertDataDirectoryOutsideProgram } from './portable-data-directory';
import { runPortableReleaseDataSmoke } from './portable-release-smoke';
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

export function registerIpcHandlers(desktopSession: DesktopSession): void {
  ipcMain.handle('app:get-bootstrap-state', () => desktopSession.getState());
  ipcMain.handle('app:retry-data-directory', () => desktopSession.retryDataDirectory());

  ipcMain.handle('app:select-data-directory', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? requireWindow();
    const currentState = desktopSession.getState();
    const selection = await dialog.showOpenDialog(window, {
      title: '选择闲鱼订单数据目录',
      buttonLabel: '使用此目录',
      defaultPath: currentState.kind === 'ready'
        ? currentState.dataDirectory
        : join(app.getPath('documents'), '闲鱼订单数据'),
      properties: process.platform === 'darwin'
        ? ['openDirectory', 'createDirectory']
        : ['openDirectory', 'promptToCreate'],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return desktopSession.getState();
    }
    assertDataDirectoryOutsideProgram({
      dataDirectory: selection.filePaths[0],
      executablePath: app.getPath('exe'),
      platform: process.platform,
    });
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
  ipcMain.handle(
    'workflow:get-candidate-adjudication-audit',
    (_event, draftId: unknown) => (
      desktopSession.getCandidateAdjudicationAudit(parseDraftId(draftId))
    ),
  );
  desktopSession.onRecognitionBatchesChanged((batches) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('workflow:recognition-batches-changed', batches);
  });
  desktopSession.onOrdersChanged((orders) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('orders:changed', orders);
  });

  ipcMain.handle(
    'workflow:confirm-draft',
    (
      _event,
      draft: OrderDraft,
      customValues: unknown,
      productStandardizations: unknown,
    ) => {
      return desktopSession.confirmDraft(
        draft,
        parseDraftCustomFieldValues(customValues),
        normalizeProductStandardizationConfirmations(productStandardizations),
      );
    },
  );
  ipcMain.handle(
    'workflow:confirm-order-update',
    (
      _event,
      draft: OrderDraft,
      expectedRevision: unknown,
      customValues: unknown,
      productStandardizations: unknown,
    ) => (
      desktopSession.confirmOrderUpdate(
        draft,
        parseExpectedRevision(expectedRevision),
        parseDraftCustomFieldValues(customValues),
        normalizeProductStandardizationConfirmations(productStandardizations),
      )
    ),
  );
  ipcMain.handle('workflow:cancel-draft', (_event, draftId: unknown) => {
    return desktopSession.cancelDraft(parseDraftId(draftId));
  });
  ipcMain.handle('products:list', () => desktopSession.listStandardProducts());
  ipcMain.handle('products:create', (_event, input: unknown) => (
    desktopSession.createStandardProduct(normalizeStandardProductInput(input))
  ));
  ipcMain.handle(
    'products:update',
    (_event, productId: unknown, input: unknown) => (
      desktopSession.updateStandardProduct(
        parseWorkflowId(productId, '标准商品'),
        normalizeUpdateStandardProductInput(input),
      )
    ),
  );
  ipcMain.handle(
    'products:preview-draft-standardizations',
    (_event, draft: OrderDraft) => desktopSession.previewDraftProductStandardizations(draft),
  );
  ipcMain.handle('orders:list', () => desktopSession.listOrders());
  ipcMain.handle('orders:query', (_event, input: unknown, definitionIds: unknown) => (
    desktopSession.queryOrders(
      parseOrderWorkbenchQuery(input),
      parseProjectedCustomFieldDefinitionIds(definitionIds),
    )
  ));
  ipcMain.handle('order-items:query', (_event, input: unknown, definitionIds: unknown) => (
    desktopSession.queryOrderItems(
      parseOrderItemWorkbenchQuery(input),
      parseProjectedCustomFieldDefinitionIds(definitionIds),
    )
  ));
  ipcMain.handle('shipment-groups:query', () => desktopSession.queryShipmentGroups());
  ipcMain.handle(
    'shipment-groups:query-workbench',
    (_event, query: unknown, customFieldDefinitionIds: unknown) => (
      desktopSession.queryShipmentGroupWorkbench(
        normalizeShipmentGroupWorkbenchQuery(
          query,
          desktopSession.listCustomFieldDefinitions(),
        ),
        parseProjectedCustomFieldDefinitionIds(customFieldDefinitionIds),
      )
    ),
  );
  ipcMain.handle('shipment-groups:split', (_event, input: unknown) => (
    desktopSession.splitShipmentGroup(input)
  ));
  ipcMain.handle('shipment-groups:merge', (_event, input: unknown) => (
    desktopSession.mergeShipmentGroups(input)
  ));
  ipcMain.handle('shipment-group-archives:query', () => (
    desktopSession.queryShipmentGroupArchives()
  ));
  ipcMain.handle('shipment-records:confirm', (_event, input: unknown) => (
    desktopSession.confirmShipment(input)
  ));
  ipcMain.handle('shipment-records:cancel-packages', (_event, input: unknown) => (
    desktopSession.cancelShipmentPackages(input)
  ));
  ipcMain.handle(
    'shipment-records:correct-package-logistics',
    (_event, input: unknown) => desktopSession.correctShipmentPackageLogistics(input),
  );
  ipcMain.handle(
    'shipment-records:update-package-logistics-status',
    (_event, input: unknown) => desktopSession.updateShipmentPackageLogisticsStatus(input),
  );
  ipcMain.handle(
    'shipment-records:record-package-logistics-exception',
    (_event, input: unknown) => desktopSession.recordShipmentPackageLogisticsException(input),
  );
  ipcMain.handle(
    'shipment-records:progress-package-logistics-exception',
    (_event, input: unknown) => desktopSession.progressShipmentPackageLogisticsException(input),
  );
  ipcMain.handle(
    'shipment-records:progress-package-carrier-claim',
    (_event, input: unknown) => desktopSession.progressShipmentPackageCarrierClaim(input),
  );
  ipcMain.handle('aftersales-cases:query', (_event, input: unknown) => (
    desktopSession.queryAftersalesCases(input)
  ));
  ipcMain.handle('aftersales-workflows:list', () => (
    desktopSession.listAftersalesWorkflowTemplates()
  ));
  ipcMain.handle(
    'aftersales-workflows:set-enabled',
    (_event, templateId: string, enabled: boolean) => (
      desktopSession.setAftersalesWorkflowTemplateEnabled(templateId, enabled)
    ),
  );
  ipcMain.handle('aftersales-workflows:create', (_event, input: unknown) => (
    desktopSession.createAftersalesWorkflowTemplate(input)
  ));
  ipcMain.handle('aftersales-workflows:copy', (_event, input: unknown) => (
    desktopSession.copyAftersalesWorkflowTemplate(input)
  ));
  ipcMain.handle(
    'aftersales-workflows:update',
    (_event, templateId: string, input: unknown) => (
      desktopSession.updateAftersalesWorkflowTemplate(templateId, input)
    ),
  );
  ipcMain.handle('aftersales-cases:create', (_event, input: unknown) => (
    desktopSession.createAftersalesCase(input)
  ));
  ipcMain.handle('aftersales-cases:change-workflow', (_event, input: unknown) => (
    desktopSession.changeAftersalesCaseWorkflowTemplate(input)
  ));
  ipcMain.handle('aftersales-cases:update', (_event, input: unknown) => (
    desktopSession.updateAftersalesCase(input)
  ));
  ipcMain.handle('aftersales-cases:progress', (_event, input: unknown) => (
    desktopSession.progressAftersalesCase(input)
  ));
  ipcMain.handle('fulfillment-plans:query', (_event, input: unknown) => (
    desktopSession.queryFulfillmentPlans(input)
  ));
  ipcMain.handle('fulfillment-plans:create', (_event, input: unknown) => (
    desktopSession.createFulfillmentPlan(input)
  ));
  ipcMain.handle('fulfillment-plans:add-orders', (_event, input: unknown) => (
    desktopSession.addFulfillmentPlanOrders(input)
  ));
  ipcMain.handle('fulfillment-plans:remove-order', (_event, input: unknown) => (
    desktopSession.removeFulfillmentPlanOrder(input)
  ));
  ipcMain.handle('fulfillment-plans:release-orders', (_event, input: unknown) => (
    desktopSession.releaseFulfillmentPlanOrders(input)
  ));
  ipcMain.handle('fulfillment-plans:update', (_event, input: unknown) => (
    desktopSession.updateFulfillmentPlan(input)
  ));
  ipcMain.handle('fulfillment-plans:close', (_event, input: unknown) => (
    desktopSession.closeFulfillmentPlan(input)
  ));
  ipcMain.handle('fulfillment-plans:progress', (_event, planId: unknown) => (
    desktopSession.queryFulfillmentPlanProgress(planId)
  ));
  ipcMain.handle('fulfillment-plans:order-candidates', () => (
    desktopSession.queryFulfillmentPlanOrderCandidates()
  ));
  ipcMain.handle('orders:export', async (event, input: unknown) => {
    const normalized = normalizeOrderExportInput(input);
    const window = BrowserWindow.fromWebContents(event.sender) ?? requireWindow();
    const selection = await dialog.showSaveDialog(window, {
      title: '导出订单 Excel',
      buttonLabel: '保存 Excel',
      defaultPath: defaultOrderExportFileName(new Date()),
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (selection.canceled || !selection.filePath) return { kind: 'cancelled' as const };
    const filePath = xlsxFilePath(selection.filePath);
    const outcome = await desktopSession.exportOrdersToWorkbook(normalized, filePath);
    return {
      kind: 'saved' as const,
      fileName: basename(filePath),
      filePath,
      ...outcome,
    };
  });
  ipcMain.handle('orders:preview-export', (_event, input: unknown) => (
    desktopSession.previewOrderExport(normalizeOrderExportInput(input))
  ));
  ipcMain.handle('shipment-groups:export', async (event, input: unknown) => {
    const normalized = normalizeShipmentGroupExportInput(input);
    const window = BrowserWindow.fromWebContents(event.sender) ?? requireWindow();
    const selection = await dialog.showSaveDialog(window, {
      title: '导出合并发货 Excel',
      buttonLabel: '保存 Excel',
      defaultPath: defaultShipmentGroupExportFileName(new Date()),
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (selection.canceled || !selection.filePath) return { kind: 'cancelled' as const };
    const filePath = xlsxFilePath(selection.filePath);
    const outcome = await desktopSession.exportShipmentGroupsToWorkbook(normalized, filePath);
    return {
      kind: 'saved' as const,
      fileName: basename(filePath),
      filePath,
      ...outcome,
    };
  });
  ipcMain.handle('shipment-groups:preview-export', (_event, input: unknown) => (
    desktopSession.previewShipmentGroupExport(normalizeShipmentGroupExportInput(input))
  ));
  ipcMain.handle('orders:get', (_event, orderId: string) => desktopSession.getOrder(orderId));
  ipcMain.handle('orders:readable-numbers', (_event, orderIds: unknown) => (
    desktopSession.getReadableOrderNumbers(orderIds)
  ));
  ipcMain.handle('recipients:query', () => desktopSession.queryRecipients());
  ipcMain.handle('recipients:orders', (_event, recipientId: unknown) => (
    desktopSession.queryRecipientOrders(recipientId)
  ));
  ipcMain.handle('recipients:merge', (_event, input: unknown) => (
    desktopSession.mergeRecipients(input)
  ));
  ipcMain.handle('orders:update', (_event, input: unknown) => desktopSession.updateOrder(input));
  ipcMain.handle('orders:update-platform-transaction-status', (_event, input: unknown) => (
    desktopSession.updateOrderPlatformTransactionStatus(input)
  ));
  ipcMain.handle('custom-fields:list', () => (
    desktopSession.listCustomFieldDefinitions()
  ));
  ipcMain.handle('custom-fields:create', (_event, input: unknown) => (
    desktopSession.createCustomFieldDefinition(
      parseCreateCustomFieldDefinitionInput(input),
    )
  ));
  ipcMain.handle('custom-fields:save-values', (_event, input: unknown) => (
    desktopSession.saveCustomFieldValues(parseSaveCustomFieldValuesInput(input))
  ));
  ipcMain.handle('shipment-groups:save-custom-field-values', (_event, input: unknown) => (
    desktopSession.saveShipmentGroupCustomFieldValues(
      parseSaveShipmentGroupCustomFieldValuesInput(input),
    )
  ));
  ipcMain.handle('table-templates:list', (_event, granularity: unknown) => (
    desktopSession.listTableTemplates(parseOptionalTableTemplateGranularity(granularity))
  ));
  ipcMain.handle('table-templates:create', (_event, input: unknown) => (
    desktopSession.createTableTemplate(
      normalizeCreateTableTemplateInput(
        input,
        desktopSession.listCustomFieldDefinitions(),
      ),
    )
  ));
  ipcMain.handle(
    'table-templates:update',
    (_event, templateIdValue: unknown, input: unknown) => {
      const templateId = parseTableTemplateId(templateIdValue);
      const existing = desktopSession.listTableTemplates()
        .find((template) => template.id === templateId);
      if (!existing) throw new Error('未找到表格模板');
      return desktopSession.updateTableTemplate(
        templateId,
        normalizeUpdateTableTemplateInput(
          templateId,
          existing.granularity,
          input,
          desktopSession.listCustomFieldDefinitions(),
        ),
      );
    },
  );
  ipcMain.handle('table-templates:delete', (_event, templateId: unknown) => (
    desktopSession.deleteTableTemplate(parseTableTemplateId(templateId))
  ));
  ipcMain.handle('table-templates:get-active', () => (
    desktopSession.getActiveTableTemplates()
  ));
  ipcMain.handle('table-templates:set-active', (_event, granularity: unknown, templateId: unknown) => (
    desktopSession.setActiveTableTemplate(granularity, templateId)
  ));
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
  ipcMain.handle('settings:get-candidate-verification', () => (
    desktopSession.getCandidateVerificationSettings()
  ));
  ipcMain.handle('settings:save-candidate-verification', (_event, input: unknown) => (
    desktopSession.saveCandidateVerificationSettings(
      parseSaveCandidateVerificationSettingsInput(input),
    )
  ));
  ipcMain.handle('settings:remove-candidate-verification-api-key', () => (
    desktopSession.removeCandidateVerificationApiKey()
  ));
  ipcMain.handle('settings:test-candidate-verification', (_event, input: unknown) => (
    desktopSession.testCandidateVerificationConnection(
      parseCandidateVerificationConnectionTestInput(input),
    )
  ));
}

function parseDraftId(draftId: unknown): string {
  return parseWorkflowId(draftId, '订单草稿');
}

function parseOptionalTableTemplateGranularity(
  value: unknown,
): TableTemplateGranularity | undefined {
  if (value === undefined) return undefined;
  if (value === 'order' || value === 'order_item') return value;
  throw new Error('表格模板数据粒度格式无效');
}

function parseTableTemplateId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error('表格模板 ID 格式无效');
  }
  return value.trim();
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
  'customFieldFilter',
  'customFieldSort',
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
      FULFILLMENT_STATUSES,
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
    customFieldFilter: parseCustomFieldFilter(input.customFieldFilter),
    customFieldSort: parseCustomFieldSort(input.customFieldSort),
  };
}

const ORDER_ITEM_WORKBENCH_QUERY_KEYS = new Set([
  'sourceTitle',
  'sourceSpec',
  'unitPriceCents',
  'quantity',
  'quantitySource',
  'sortField',
  'sortDirection',
  'customFieldFilter',
  'customFieldSort',
]);

function parseOrderItemWorkbenchQuery(input: unknown): OrderItemWorkbenchQuery {
  if (!isRecord(input)) throw new Error('订单商品明细工作台查询格式无效');
  rejectUnknownKeys(input, ORDER_ITEM_WORKBENCH_QUERY_KEYS, '订单商品明细工作台查询');
  const sortField = optionalWorkbenchEnum(
    input.sortField,
    ['source_title', 'source_spec', 'unit_price', 'quantity', 'quantity_source'] as const,
    '订单商品明细排序字段',
  );
  const customFieldSort = parseCustomFieldSort(input.customFieldSort);
  if (sortField && customFieldSort) {
    throw new Error('订单商品明细一次只能使用一种排序');
  }
  return {
    sourceTitle: optionalWorkbenchSourceText(input.sourceTitle, 20_000),
    sourceSpec: optionalWorkbenchSourceText(input.sourceSpec, 20_000),
    unitPriceCents: optionalWorkbenchInteger(input.unitPriceCents, 0, '商品单价'),
    quantity: optionalWorkbenchInteger(input.quantity, 1, '商品数量'),
    quantitySource: optionalWorkbenchEnum(
      input.quantitySource,
      QUANTITY_SOURCES,
      '商品数量来源',
    ),
    sortField,
    sortDirection: optionalWorkbenchEnum(
      input.sortDirection,
      ['asc', 'desc'] as const,
      '订单商品明细排序方向',
    ),
    customFieldFilter: parseCustomFieldFilter(input.customFieldFilter),
    customFieldSort,
  };
}

function parseProjectedCustomFieldDefinitionIds(input: unknown): string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 200) {
    throw new Error('投影自定义字段列表格式无效');
  }
  const definitionIds = input.map((value) => parseWorkflowId(value, '自定义字段'));
  if (new Set(definitionIds).size !== definitionIds.length) {
    throw new Error('投影自定义字段不能重复');
  }
  return definitionIds;
}

const CUSTOM_FIELD_FILTER_KEYS = new Set(['definitionId', 'value']);

function parseCustomFieldFilter(input: unknown): CustomFieldFilter | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error('自定义字段筛选格式无效');
  rejectUnknownKeys(input, CUSTOM_FIELD_FILTER_KEYS, '自定义字段筛选');
  requireOwnKeys(input, CUSTOM_FIELD_FILTER_KEYS, '自定义字段筛选');
  const value = parseCustomFieldValue(input.value, false);
  if (value === null) throw new Error('自定义字段筛选值格式无效');
  return {
    definitionId: parseWorkflowId(input.definitionId, '自定义字段'),
    value,
  };
}

const CUSTOM_FIELD_SORT_KEYS = new Set(['definitionId', 'direction']);

function parseCustomFieldSort(input: unknown): CustomFieldSort | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error('自定义字段排序格式无效');
  rejectUnknownKeys(input, CUSTOM_FIELD_SORT_KEYS, '自定义字段排序');
  requireOwnKeys(input, CUSTOM_FIELD_SORT_KEYS, '自定义字段排序');
  return {
    definitionId: parseWorkflowId(input.definitionId, '自定义字段'),
    direction: requiredEnum(
      input.direction,
      ['asc', 'desc'] as const,
      '自定义字段排序方向',
    ),
  };
}

const CREATE_CUSTOM_FIELD_KEYS = new Set([
  'name',
  'granularity',
  'type',
  'required',
  'defaultValue',
  'options',
]);

function parseCreateCustomFieldDefinitionInput(
  input: unknown,
): CreateCustomFieldDefinitionInput {
  if (!isRecord(input)) throw new Error('自定义字段设置格式无效');
  rejectUnknownKeys(input, CREATE_CUSTOM_FIELD_KEYS, '自定义字段设置');
  requireOwnKeys(input, CREATE_CUSTOM_FIELD_KEYS, '自定义字段设置');
  if (typeof input.required !== 'boolean') {
    throw new Error('自定义字段必填设置格式无效');
  }
  return {
    name: requiredBoundedText(input.name, 80, '自定义字段名称'),
    granularity: requiredEnum(
      input.granularity,
      ['order', 'order_item'] as const,
      '自定义字段数据粒度',
    ),
    type: requiredEnum(
      input.type,
      [
        'text',
        'number',
        'money',
        'datetime',
        'single_select',
        'multi_select',
        'checkbox',
      ] as const,
      '自定义字段类型',
    ),
    required: input.required,
    defaultValue: parseCustomFieldValue(input.defaultValue, true),
    options: parseCustomFieldOptions(input.options),
  };
}

const SAVE_CUSTOM_FIELD_VALUES_KEYS = new Set([
  'orderId',
  'orderValues',
  'itemValues',
]);
const SAVE_SHIPMENT_GROUP_CUSTOM_FIELD_VALUES_KEYS = new Set([
  'shipmentGroupId',
  'expectedMemberOrderIds',
  'values',
]);
const CUSTOM_FIELD_ORDER_VALUE_KEYS = new Set(['definitionId', 'value']);
const CUSTOM_FIELD_ITEM_VALUE_KEYS = new Set([
  'definitionId',
  'orderItemId',
  'value',
]);
const DRAFT_CUSTOM_FIELD_VALUES_KEYS = new Set(['orderValues', 'itemValues']);
const DRAFT_CUSTOM_FIELD_ITEM_VALUE_KEYS = new Set([
  'definitionId',
  'draftItemId',
  'value',
]);
const MAX_CUSTOM_FIELD_ASSIGNMENTS = 1_000;

function parseSaveCustomFieldValuesInput(input: unknown): SaveCustomFieldValuesInput {
  if (!isRecord(input)) throw new Error('自定义字段值格式无效');
  rejectUnknownKeys(input, SAVE_CUSTOM_FIELD_VALUES_KEYS, '自定义字段值');
  requireOwnKeys(input, SAVE_CUSTOM_FIELD_VALUES_KEYS, '自定义字段值');
  return {
    orderId: parseWorkflowId(input.orderId, '订单'),
    orderValues: parseOrderCustomFieldValues(input.orderValues),
    itemValues: parsePersistedItemCustomFieldValues(input.itemValues),
  };
}

function parseSaveShipmentGroupCustomFieldValuesInput(
  input: unknown,
): SaveShipmentGroupCustomFieldValuesInput {
  if (!isRecord(input)) throw new Error('发货组自定义字段值格式无效');
  rejectUnknownKeys(
    input,
    SAVE_SHIPMENT_GROUP_CUSTOM_FIELD_VALUES_KEYS,
    '发货组自定义字段值',
  );
  requireOwnKeys(
    input,
    SAVE_SHIPMENT_GROUP_CUSTOM_FIELD_VALUES_KEYS,
    '发货组自定义字段值',
  );
  const expectedMemberOrderIds = boundedArray(
    input.expectedMemberOrderIds,
    10_000,
    '发货组成员快照',
  ).map((orderId) => parseWorkflowId(orderId, '发货组成员订单'));
  return {
    shipmentGroupId: parseWorkflowId(input.shipmentGroupId, '发货组'),
    expectedMemberOrderIds,
    values: parseOrderCustomFieldValues(input.values),
  };
}

function parseDraftCustomFieldValues(
  input: unknown,
): DraftCustomFieldValues | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error('草稿自定义字段值格式无效');
  rejectUnknownKeys(input, DRAFT_CUSTOM_FIELD_VALUES_KEYS, '草稿自定义字段值');
  requireOwnKeys(input, DRAFT_CUSTOM_FIELD_VALUES_KEYS, '草稿自定义字段值');
  return {
    orderValues: parseOrderCustomFieldValues(input.orderValues),
    itemValues: parseDraftItemCustomFieldValues(input.itemValues),
  };
}

function parseOrderCustomFieldValues(
  input: unknown,
): DraftCustomFieldValues['orderValues'] {
  const values = boundedArray(input, MAX_CUSTOM_FIELD_ASSIGNMENTS, '订单自定义字段值');
  return values.map((value) => {
    if (!isRecord(value)) throw new Error('订单自定义字段值格式无效');
    rejectUnknownKeys(value, CUSTOM_FIELD_ORDER_VALUE_KEYS, '订单自定义字段值');
    requireOwnKeys(value, CUSTOM_FIELD_ORDER_VALUE_KEYS, '订单自定义字段值');
    return {
      definitionId: parseWorkflowId(value.definitionId, '自定义字段'),
      value: parseCustomFieldValue(value.value, true),
    };
  });
}

function parsePersistedItemCustomFieldValues(
  input: unknown,
): SaveCustomFieldValuesInput['itemValues'] {
  const values = boundedArray(input, MAX_CUSTOM_FIELD_ASSIGNMENTS, '商品自定义字段值');
  return values.map((value) => {
    if (!isRecord(value)) throw new Error('商品自定义字段值格式无效');
    rejectUnknownKeys(value, CUSTOM_FIELD_ITEM_VALUE_KEYS, '商品自定义字段值');
    requireOwnKeys(value, CUSTOM_FIELD_ITEM_VALUE_KEYS, '商品自定义字段值');
    return {
      definitionId: parseWorkflowId(value.definitionId, '自定义字段'),
      orderItemId: parseWorkflowId(value.orderItemId, '订单商品'),
      value: parseCustomFieldValue(value.value, true),
    };
  });
}

function parseDraftItemCustomFieldValues(
  input: unknown,
): DraftCustomFieldValues['itemValues'] {
  const values = boundedArray(input, MAX_CUSTOM_FIELD_ASSIGNMENTS, '草稿商品自定义字段值');
  return values.map((value) => {
    if (!isRecord(value)) throw new Error('草稿商品自定义字段值格式无效');
    rejectUnknownKeys(value, DRAFT_CUSTOM_FIELD_ITEM_VALUE_KEYS, '草稿商品自定义字段值');
    requireOwnKeys(value, DRAFT_CUSTOM_FIELD_ITEM_VALUE_KEYS, '草稿商品自定义字段值');
    return {
      definitionId: parseWorkflowId(value.definitionId, '自定义字段'),
      draftItemId: parseWorkflowId(value.draftItemId, '草稿商品'),
      value: parseCustomFieldValue(value.value, true),
    };
  });
}

function parseCustomFieldOptions(input: unknown): string[] {
  return boundedArray(input, 100, '自定义字段可选项')
    .map((option) => requiredBoundedText(option, 120, '自定义字段可选项'));
}

function parseCustomFieldValue(
  value: unknown,
  allowNull: boolean,
): CustomFieldValue | null {
  if (value === null && allowNull) return null;
  if (typeof value === 'string') {
    if (value.length > 20_000) throw new Error('自定义字段文本过长');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('自定义字段数值格式无效');
    }
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > 100 || value.some((entry) => (
      typeof entry !== 'string' || entry.length > 128
    ))) {
      throw new Error('自定义字段多选值格式无效');
    }
    return [...value] as string[];
  }
  throw new Error('自定义字段值格式无效');
}

function boundedArray(
  input: unknown,
  maximumLength: number,
  label: string,
): unknown[] {
  if (!Array.isArray(input) || input.length > maximumLength) {
    throw new Error(`${label}格式无效`);
  }
  return input;
}

function requiredBoundedText(
  input: unknown,
  maximumLength: number,
  label: string,
): string {
  if (typeof input !== 'string' || input.length > maximumLength) {
    throw new Error(`${label}格式无效`);
  }
  const normalized = input.normalize('NFKC').trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function requiredEnum<const T extends readonly string[]>(
  input: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof input !== 'string' || !(values as readonly string[]).includes(input)) {
    throw new Error(`${label}格式无效`);
  }
  return input as T[number];
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label}包含未知字段`);
  }
}

function requireOwnKeys(
  input: Record<string, unknown>,
  requiredKeys: ReadonlySet<string>,
  label: string,
): void {
  if ([...requiredKeys].some((key) => !Object.hasOwn(input, key))) {
    throw new Error(`${label}缺少必要字段`);
  }
}

function optionalWorkbenchText(value: unknown, maximumLength: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new Error('订单工作台搜索文本格式无效');
  }
  const normalized = value.normalize('NFKC').trim();
  return normalized || undefined;
}

function optionalWorkbenchSourceText(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new Error('商品工作台原始文本格式无效');
  }
  return value.trim() || undefined;
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

function optionalWorkbenchInteger(
  value: unknown,
  minimum: number,
  label: string,
): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label}格式无效`);
  }
  return value as number;
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

function defaultOrderExportFileName(now: Date): string {
  const part = (value: number): string => String(value).padStart(2, '0');
  return `闲鱼订单-${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}.xlsx`;
}

function defaultShipmentGroupExportFileName(now: Date): string {
  const part = (value: number): string => String(value).padStart(2, '0');
  return `合并发货-${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}.xlsx`;
}

function xlsxFilePath(value: string): string {
  return extname(value).toLowerCase() === '.xlsx' ? value : `${value}.xlsx`;
}

void app.whenReady().then(async () => {
  if (process.env.XIANYU_PACKAGED_PORTABLE_SMOKE) {
    try {
      if (!app.isPackaged) throw new Error('便携版冒烟只能针对打包后的应用运行');
      const result = await runPortableReleaseDataSmoke({
        phase: portableSmokePhase(process.env.XIANYU_PACKAGED_PORTABLE_SMOKE),
        configDirectory: requiredSmokePath(
          process.env.XIANYU_PORTABLE_SMOKE_CONFIG_DIRECTORY,
          '启动配置目录',
        ),
        dataDirectory: requiredSmokePath(
          process.env.XIANYU_PORTABLE_SMOKE_DATA_DIRECTORY,
          '订单数据目录',
        ),
      });
      console.log(`Packaged portable release smoke passed: ${JSON.stringify(result)}`);
      app.exit(0);
    } catch (error) {
      console.error(
        'Packaged portable release smoke failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
      app.exit(1);
    }
    return;
  }

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
  const validateDataDirectory = (dataDirectory: string): void => {
    assertDataDirectoryOutsideProgram({
      dataDirectory,
      executablePath: app.getPath('exe'),
      platform: process.platform,
    });
  };
  session = createConfiguredDesktopSession({
    configDirectory,
    apiKeyStore: new SystemApiKeyStore(),
    candidateVerificationApiKeyStores: {
      deepseek: new SystemApiKeyStore({
        accountName: 'candidate-verification-deepseek-api-key',
        secretLabel: 'DeepSeek 候选裁决 API Key',
      }),
      'aliyun-bailian': new SystemApiKeyStore({
        accountName: 'candidate-verification-aliyun-bailian-api-key',
        secretLabel: '百炼候选裁决 API Key',
      }),
      'openai-compatible': new SystemApiKeyStore({
        accountName: 'candidate-verification-openai-compatible-api-key',
        secretLabel: '自定义候选裁决 API Key',
      }),
    },
    validateDataDirectory,
  });
  session.restore();
  registerIpcHandlers(session);
  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

function portableSmokePhase(value: string): 'write' | 'read' {
  if (value === 'write' || value === 'read') return value;
  throw new Error('便携版冒烟阶段无效');
}

function requiredSmokePath(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`便携版冒烟缺少${label}`);
  return value;
}

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

const CANDIDATE_VERIFICATION_SETTINGS_KEYS = new Set([
  'enabled',
  'provider',
  'baseUrl',
  'model',
  'apiKey',
]);

const CANDIDATE_VERIFICATION_CONNECTION_TEST_KEYS = new Set([
  'consentToPaidCall',
]);

function parseSaveCandidateVerificationSettingsInput(
  input: unknown,
): SaveCandidateVerificationSettingsInput {
  if (!isRecord(input) || typeof input.enabled !== 'boolean') {
    throw new Error('候选裁决设置格式无效');
  }
  rejectUnknownKeys(
    input,
    CANDIDATE_VERIFICATION_SETTINGS_KEYS,
    '候选裁决设置',
  );
  requireOwnKeys(
    input,
    CANDIDATE_VERIFICATION_SETTINGS_KEYS,
    '候选裁决设置',
  );
  return {
    enabled: input.enabled,
    provider: parseCandidateVerificationProvider(input.provider),
    baseUrl: asCandidateVerificationString(input.baseUrl, 2_048, 'Base URL'),
    model: asCandidateVerificationString(input.model, 200, '模型名称'),
    apiKey: asCandidateVerificationString(input.apiKey, 4_096, 'API Key', true),
  };
}

function parseCandidateVerificationProvider(
  value: unknown,
): CandidateVerificationProvider {
  if (
    value === 'deepseek' ||
    value === 'aliyun-bailian' ||
    value === 'openai-compatible'
  ) return value;
  throw new Error('候选裁决服务商格式无效');
}

function parseCandidateVerificationConnectionTestInput(
  input: unknown,
): CandidateVerificationConnectionTestInput {
  if (!isRecord(input)) {
    throw new Error('请先确认本次测试会产生一次文本模型调用');
  }
  rejectUnknownKeys(
    input,
    CANDIDATE_VERIFICATION_CONNECTION_TEST_KEYS,
    '候选裁决连接测试',
  );
  requireOwnKeys(
    input,
    CANDIDATE_VERIFICATION_CONNECTION_TEST_KEYS,
    '候选裁决连接测试',
  );
  if (input.consentToPaidCall !== true) {
    throw new Error('请先确认本次测试会产生一次文本模型调用');
  }
  return { consentToPaidCall: true };
}

function asCandidateVerificationString(
  value: unknown,
  maximumLength: number,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new Error(`候选裁决${label}格式无效`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`候选裁决${label}格式无效`);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error(`请输入候选裁决${label}`);
  return normalized;
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
