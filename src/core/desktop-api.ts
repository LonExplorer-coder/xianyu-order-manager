import type {
  OrderDetails,
  OrderDraft,
  OrderDraftConfirmation,
  OrderDraftReview,
  OrderSummary,
  OrderUpdateConfirmation,
  OriginalOrder,
  OrderEditInput,
  OrderPlatformTransactionStatusUpdateInput,
  RecognitionBatchView,
} from './contracts';
import type {
  BackupCreateOutcome,
  BackupRestoreOutcome,
  BackupSelectRootOutcome,
  BackupSettingsView,
  BackupStatusView,
  BackupVerifyOutcome,
  SaveBackupSettingsInput,
} from './backup';
import type {
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinition,
  CustomFieldValueRecord,
  DraftCustomFieldValues,
  SaveCustomFieldValuesInput,
  SaveShipmentGroupCustomFieldValuesInput,
} from './custom-fields';
import type {
  OcrConnectionTestInput,
  OcrConnectionTestResult,
  OcrSettingsView,
  SaveOcrSettingsInput,
} from './ocr-settings';
import type {
  CandidateVerificationConnectionTestInput,
  CandidateVerificationConnectionTestResult,
  CandidateVerificationSettingsView,
  SaveCandidateVerificationSettingsInput,
} from './candidate-verification-settings';
import type { CandidateAdjudicationAuditView } from './candidate-adjudication-audit';
import type {
  CreateProductMappingInput,
  ProductMappingConflictQueryInput,
  CreateStandardProductInput,
  CorrectProductMappingInput,
  DraftItemProductStandardization,
  OrderItemStandardizationBatchApplyInput,
  OrderItemStandardizationBatchPreview,
  OrderItemStandardizationBatchPreviewInput,
  OrderItemStandardizationBatchResult,
  ProductMappingEvent,
  ProductMappingHistoryCandidatePreview,
  ProductMappingHistoryCorrectionInput,
  ProductMappingHistoryCorrectionResult,
  ProductMappingReasonInput,
  ProductMappingStats,
  ProductMappingView,
  ProductStandardizationConfirmation,
  StandardProduct,
  StandardProductPriceEvent,
  UpdateOrderItemStandardizationInput,
  UpdateStandardProductInput,
} from './product-standardization';
import type {
  OrderIntakeSettingsView,
  SaveOrderIntakeSettingsInput,
} from './order-intake';
import type {
  OrderItemWorkbenchQuery,
  OrderItemWorkbenchResult,
  OrderWorkbenchQuery,
  OrderWorkbenchResult,
} from './order-workbench';
import type {
  OrderExportInput,
  OrderExportPreviewResult,
  OrderExportResult,
} from './order-export';
import type {
  ShipmentGroupCustomFieldValue,
  ShipmentGroupProjection,
  ShipmentGroupWorkbenchQuery,
  ShipmentGroupWorkbenchResult,
} from './shipment-groups';
import type {
  ShipmentGroupExportInput,
  ShipmentGroupExportPreviewResult,
  ShipmentGroupExportResult,
} from './shipment-group-export';
import type {
  MergeShipmentGroupsInput,
  ShipmentGroupAdjustmentResult,
  SplitShipmentGroupInput,
} from './shipment-group-adjustments';
import type {
  CancelShipmentPackagesInput,
  ConfirmShipmentInput,
  CorrectShipmentPackageLogisticsInput,
  ProgressShipmentPackageCarrierClaimInput,
  ProgressShipmentPackageLogisticsExceptionInput,
  RecordShipmentPackageLogisticsExceptionInput,
  ShipmentCancellationResult,
  ShipmentConfirmationResult,
  ShipmentGroupArchive,
  ShipmentLogisticsCorrectionResult,
  ShipmentLogisticsStatusUpdateResult,
  ShipmentLogisticsExceptionResult,
  ShipmentCarrierClaimProgressResult,
  UpdateShipmentPackageLogisticsStatusInput,
} from './shipment-records';
import type {
  ActiveTableTemplateIds,
  CreateTableTemplateInput,
  TableTemplate,
  TableTemplateGranularity,
  UpdateTableTemplateInput,
} from './table-templates';
import type {
  AftersalesCase,
  AftersalesCaseQuery,
  ChangeAftersalesCaseWorkflowTemplateInput,
  CreateAftersalesCaseInput,
  ProgressAftersalesCaseInput,
  RecordAftersalesWorkflowStepEventInput,
  UpdateAftersalesCaseInput,
} from './aftersales-cases';
import type {
  AftersalesWorkflowTemplate,
  CopyAftersalesWorkflowTemplateInput,
  CreateAftersalesWorkflowTemplateInput,
  UpdateAftersalesWorkflowTemplateInput,
} from './aftersales-workflow-templates';
import type {
  AddFulfillmentPlanOrdersInput,
  CloseFulfillmentPlanInput,
  ConfirmGroupFormationInput,
  CreateFulfillmentPlanInput,
  FulfillmentPlanProgressView,
  FulfillmentPlanQuery,
  FulfillmentPlanView,
  ReleaseFulfillmentPlanOrdersInput,
  RemoveFulfillmentPlanOrderInput,
  UpdateFulfillmentPlanInput,
} from './fulfillment-plans';
import type {
  CreatePurchaseSuggestionInput,
  FulfillmentDemandView,
  PurchaseSuggestionActionInput,
  RegisterFulfillmentRefundInput,
} from './fulfillment-demand';
import type {
  InventoryMovementView,
  InventoryView,
  RecordInventoryAdjustmentInput,
  RecordInventoryInspectionInput,
} from './inventory-ledger';
import type {
  CancelPendingFinanceItemInput,
  ConfirmPendingFinanceItemInput,
  FinanceFactsForSource,
  FinanceSourceTypeName,
  FundsView,
  RecordFinanceRecordInput,
  ReverseFinanceRecordInput,
} from './funds';
import type { ProfitReportView } from './profit';
import type {
  ChangePurchaseOrderExpectedDateInput,
  ChangePurchaseOrderItemQuantityInput,
  CreatePurchaseOrderFromSuggestionInput,
  CreatePurchaseOrderInput,
  CreateSupplierInput,
  PurchaseOrderActionInput,
  PurchaseView,
  RecordPurchaseArrivalInput,
  RecordSupplierReturnInput,
} from './purchase-orders';
import type {
  MergeRecipientsInput,
  RecipientSummaryView,
} from './recipients';

export type BootstrapState =
  | { kind: 'needs_data_directory' }
  | { kind: 'ready'; dataDirectory: string; orders: OrderSummary[] }
  | { kind: 'locked'; dataDirectory: string; message: string }
  | { kind: 'error'; message: string };

export interface DesktopApi {
  getBootstrapState(): Promise<BootstrapState>;
  retryDataDirectory(): Promise<BootstrapState>;
  selectDataDirectory(): Promise<BootstrapState>;
  createBackup(): Promise<BackupCreateOutcome>;
  verifyBackup(): Promise<BackupVerifyOutcome>;
  restoreBackup(): Promise<BackupRestoreOutcome>;
  getBackupSettings(): Promise<BackupSettingsView>;
  saveBackupSettings(input: SaveBackupSettingsInput): Promise<BackupSettingsView>;
  selectBackupRoot(purpose?: 'backup' | 'restore'): Promise<BackupSelectRootOutcome>;
  getBackupStatus(): Promise<BackupStatusView | null>;
  selectSourceScreenshots(): Promise<RecognitionBatchView | null>;
  listRecognitionBatches(): Promise<RecognitionBatchView[]>;
  retryRecognitionItem(batchId: string, itemId: string): Promise<void>;
  createManualDraft(batchId: string, itemId: string): Promise<OrderDraft>;
  getDraft(draftId: string): Promise<OrderDraft>;
  getDraftReview(draftId: string): Promise<OrderDraftReview>;
  getCandidateAdjudicationAudit(
    draftId: string,
  ): Promise<CandidateAdjudicationAuditView[]>;
  onRecognitionBatchesChanged(
    listener: (batches: RecognitionBatchView[]) => void,
  ): () => void;
  cancelDraft(draftId: string): Promise<void>;
  confirmDraft(
    draft: OrderDraft,
    customValues?: DraftCustomFieldValues,
    productStandardizations?: readonly ProductStandardizationConfirmation[],
  ): Promise<OrderDraftConfirmation>;
  confirmOrderUpdate(
    draft: OrderDraft,
    expectedRevision: number,
    customValues?: DraftCustomFieldValues,
    productStandardizations?: readonly ProductStandardizationConfirmation[],
  ): Promise<OrderUpdateConfirmation>;
  listStandardProducts(): Promise<StandardProduct[]>;
  createStandardProduct(input: CreateStandardProductInput): Promise<StandardProduct>;
  updateStandardProduct(
    productId: string,
    input: UpdateStandardProductInput,
  ): Promise<StandardProduct>;
  listStandardProductPriceEvents(productId: string): Promise<StandardProductPriceEvent[]>;
  previewDraftProductStandardizations(
    draft: OrderDraft,
  ): Promise<DraftItemProductStandardization[]>;
  getProductMappingStats(productId: string): Promise<ProductMappingStats>;
  listProductMappings(productId: string, search?: string): Promise<ProductMappingView[]>;
  listProductMappingEvents(productId: string): Promise<ProductMappingEvent[]>;
  createProductMapping(
    productId: string,
    input: CreateProductMappingInput,
  ): Promise<ProductMappingView>;
  findProductMappingConflict(
    input: ProductMappingConflictQueryInput,
  ): Promise<ProductMappingView | null>;
  correctProductMapping(
    mappingId: string,
    input: CorrectProductMappingInput,
  ): Promise<ProductMappingView>;
  disableProductMapping(
    mappingId: string,
    input: ProductMappingReasonInput,
  ): Promise<ProductMappingView>;
  deleteProductMapping(mappingId: string, input: ProductMappingReasonInput): Promise<void>;
  previewProductMappingHistoryCandidates(
    mappingId: string,
  ): Promise<ProductMappingHistoryCandidatePreview>;
  relinkProductMappingHistoryCandidates(
    mappingId: string,
    input: ProductMappingHistoryCorrectionInput,
  ): Promise<ProductMappingHistoryCorrectionResult>;
  listOrders(): Promise<OrderSummary[]>;
  queryOrders(
    query: OrderWorkbenchQuery,
    customFieldDefinitionIds?: readonly string[],
  ): Promise<OrderWorkbenchResult>;
  queryOrderItems(
    query: OrderItemWorkbenchQuery,
    customFieldDefinitionIds?: readonly string[],
  ): Promise<OrderItemWorkbenchResult>;
  queryShipmentGroups(): Promise<ShipmentGroupProjection>;
  queryShipmentGroupWorkbench(
    query: ShipmentGroupWorkbenchQuery,
    customFieldDefinitionIds?: readonly string[],
  ): Promise<ShipmentGroupWorkbenchResult>;
  saveShipmentGroupCustomFieldValues(
    input: SaveShipmentGroupCustomFieldValuesInput,
  ): Promise<ShipmentGroupCustomFieldValue[]>;
  splitShipmentGroup(input: SplitShipmentGroupInput): Promise<ShipmentGroupAdjustmentResult>;
  mergeShipmentGroups(input: MergeShipmentGroupsInput): Promise<ShipmentGroupAdjustmentResult>;
  queryShipmentGroupArchives(): Promise<ShipmentGroupArchive[]>;
  confirmShipment(input: ConfirmShipmentInput): Promise<ShipmentConfirmationResult>;
  cancelShipmentPackages(
    input: CancelShipmentPackagesInput,
  ): Promise<ShipmentCancellationResult>;
  correctShipmentPackageLogistics(
    input: CorrectShipmentPackageLogisticsInput,
  ): Promise<ShipmentLogisticsCorrectionResult>;
  updateShipmentPackageLogisticsStatus(
    input: UpdateShipmentPackageLogisticsStatusInput,
  ): Promise<ShipmentLogisticsStatusUpdateResult>;
  recordShipmentPackageLogisticsException(
    input: RecordShipmentPackageLogisticsExceptionInput,
  ): Promise<ShipmentLogisticsExceptionResult>;
  progressShipmentPackageLogisticsException(
    input: ProgressShipmentPackageLogisticsExceptionInput,
  ): Promise<ShipmentLogisticsExceptionResult>;
  progressShipmentPackageCarrierClaim(
    input: ProgressShipmentPackageCarrierClaimInput,
  ): Promise<ShipmentCarrierClaimProgressResult>;
  queryAftersalesCases(query?: AftersalesCaseQuery): Promise<AftersalesCase[]>;
  listAftersalesWorkflowTemplates(): Promise<AftersalesWorkflowTemplate[]>;
  setAftersalesWorkflowTemplateEnabled(
    templateId: string,
    enabled: boolean,
  ): Promise<AftersalesWorkflowTemplate>;
  createAftersalesWorkflowTemplate(
    input: CreateAftersalesWorkflowTemplateInput,
  ): Promise<AftersalesWorkflowTemplate>;
  copyAftersalesWorkflowTemplate(
    input: CopyAftersalesWorkflowTemplateInput,
  ): Promise<AftersalesWorkflowTemplate>;
  updateAftersalesWorkflowTemplate(
    templateId: string,
    input: UpdateAftersalesWorkflowTemplateInput,
  ): Promise<AftersalesWorkflowTemplate>;
  createAftersalesCase(input: CreateAftersalesCaseInput): Promise<AftersalesCase>;
  changeAftersalesCaseWorkflowTemplate(
    input: ChangeAftersalesCaseWorkflowTemplateInput,
  ): Promise<AftersalesCase>;
  updateAftersalesCase(input: UpdateAftersalesCaseInput): Promise<AftersalesCase>;
  progressAftersalesCase(input: ProgressAftersalesCaseInput): Promise<AftersalesCase>;
  recordAftersalesWorkflowStepEvent(
    input: RecordAftersalesWorkflowStepEventInput,
  ): Promise<AftersalesCase>;
  queryFulfillmentPlans(query?: FulfillmentPlanQuery): Promise<FulfillmentPlanView[]>;
  createFulfillmentPlan(input: CreateFulfillmentPlanInput): Promise<FulfillmentPlanView>;
  addFulfillmentPlanOrders(input: AddFulfillmentPlanOrdersInput): Promise<FulfillmentPlanView>;
  removeFulfillmentPlanOrder(
    input: RemoveFulfillmentPlanOrderInput,
  ): Promise<FulfillmentPlanView>;
  releaseFulfillmentPlanOrders(
    input: ReleaseFulfillmentPlanOrdersInput,
  ): Promise<FulfillmentPlanView>;
  updateFulfillmentPlan(input: UpdateFulfillmentPlanInput): Promise<FulfillmentPlanView>;
  closeFulfillmentPlan(input: CloseFulfillmentPlanInput): Promise<FulfillmentPlanView>;
  confirmGroupFormation(input: ConfirmGroupFormationInput): Promise<FulfillmentPlanView>;
  queryFulfillmentPlanProgress(planId: string): Promise<FulfillmentPlanProgressView>;
  queryFulfillmentPlanOrderCandidates(): Promise<OrderSummary[]>;
  queryFulfillmentDemand(planId: string): Promise<FulfillmentDemandView>;
  registerFulfillmentRefund(input: RegisterFulfillmentRefundInput): Promise<FulfillmentDemandView>;
  createPurchaseSuggestion(
    input: CreatePurchaseSuggestionInput,
  ): Promise<FulfillmentDemandView>;
  confirmPurchaseSuggestion(
    input: PurchaseSuggestionActionInput,
  ): Promise<FulfillmentDemandView>;
  cancelPurchaseSuggestion(
    input: PurchaseSuggestionActionInput,
  ): Promise<FulfillmentDemandView>;
  queryInventory(): Promise<InventoryView>;
  queryAftersalesInventoryImpact(caseId: string): Promise<InventoryMovementView[]>;
  recordInventoryAdjustment(input: RecordInventoryAdjustmentInput): Promise<InventoryView>;
  recordInventoryInspection(input: RecordInventoryInspectionInput): Promise<InventoryView>;
  queryFunds(): Promise<FundsView>;
  queryProfitReport(): Promise<ProfitReportView>;
  queryFinanceFactsForSource(
    sourceType: FinanceSourceTypeName,
    sourceId: string,
  ): Promise<FinanceFactsForSource>;
  queryFinanceFactsForAftersalesCase(caseId: string): Promise<FinanceFactsForSource>;
  queryFinanceFactsForShipmentRecord(recordId: string): Promise<FinanceFactsForSource>;
  confirmPendingFinanceItem(input: ConfirmPendingFinanceItemInput): Promise<FundsView>;
  cancelPendingFinanceItem(input: CancelPendingFinanceItemInput): Promise<FundsView>;
  recordFinanceRecord(input: RecordFinanceRecordInput): Promise<FundsView>;
  reverseFinanceRecord(input: ReverseFinanceRecordInput): Promise<FundsView>;
  queryPurchases(): Promise<PurchaseView>;
  createSupplier(input: CreateSupplierInput): Promise<PurchaseView>;
  createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseView>;
  createPurchaseOrderFromSuggestion(
    input: CreatePurchaseOrderFromSuggestionInput,
  ): Promise<PurchaseView>;
  confirmPurchaseOrder(input: PurchaseOrderActionInput): Promise<PurchaseView>;
  cancelPurchaseOrder(input: PurchaseOrderActionInput): Promise<PurchaseView>;
  changePurchaseOrderItemQuantity(
    input: ChangePurchaseOrderItemQuantityInput,
  ): Promise<PurchaseView>;
  changePurchaseOrderExpectedDate(
    input: ChangePurchaseOrderExpectedDateInput,
  ): Promise<PurchaseView>;
  recordPurchaseArrival(input: RecordPurchaseArrivalInput): Promise<PurchaseView>;
  recordSupplierReturn(input: RecordSupplierReturnInput): Promise<PurchaseView>;
  exportOrders(input: OrderExportInput): Promise<OrderExportResult>;
  previewOrderExport(input: OrderExportInput): Promise<OrderExportPreviewResult>;
  exportShipmentGroups(input: ShipmentGroupExportInput): Promise<ShipmentGroupExportResult>;
  previewShipmentGroupExport(
    input: ShipmentGroupExportInput,
  ): Promise<ShipmentGroupExportPreviewResult>;
  onOrdersChanged(listener: (orders: OrderSummary[]) => void): () => void;
  getOrder(orderId: string): Promise<OrderDetails>;
  getReadableOrderNumbers(orderIds: string[]): Promise<Record<string, string | null>>;
  queryRecipients(): Promise<RecipientSummaryView[]>;
  queryRecipientOrders(recipientId: string): Promise<OrderSummary[]>;
  mergeRecipients(input: MergeRecipientsInput): Promise<RecipientSummaryView[]>;
  updateOrder(input: OrderEditInput): Promise<OrderDetails>;
  updateOrderItemStandardization(
    orderId: string,
    itemId: string,
    input: UpdateOrderItemStandardizationInput,
  ): Promise<OrderDetails>;
  previewOrderItemStandardizationBatch(
    input: OrderItemStandardizationBatchPreviewInput,
  ): Promise<OrderItemStandardizationBatchPreview>;
  applyOrderItemStandardizationBatch(
    input: OrderItemStandardizationBatchApplyInput,
  ): Promise<OrderItemStandardizationBatchResult>;
  updateOrderPlatformTransactionStatus(
    input: OrderPlatformTransactionStatusUpdateInput,
  ): Promise<OrderDetails[]>;
  listCustomFieldDefinitions(): Promise<CustomFieldDefinition[]>;
  createCustomFieldDefinition(
    input: CreateCustomFieldDefinitionInput,
  ): Promise<CustomFieldDefinition>;
  listTableTemplates(
    granularity?: TableTemplateGranularity,
  ): Promise<TableTemplate[]>;
  createTableTemplate(input: CreateTableTemplateInput): Promise<TableTemplate>;
  updateTableTemplate(
    templateId: string,
    input: UpdateTableTemplateInput,
  ): Promise<TableTemplate>;
  deleteTableTemplate(templateId: string): Promise<void>;
  getActiveTableTemplates(): Promise<ActiveTableTemplateIds>;
  setActiveTableTemplate(
    granularity: TableTemplateGranularity,
    templateId: string | null,
  ): Promise<ActiveTableTemplateIds>;
  saveCustomFieldValues(
    input: SaveCustomFieldValuesInput,
  ): Promise<CustomFieldValueRecord[]>;
  getScreenshotDataUrl(screenshotId: string): Promise<string>;
  getOrderIntakeSettings(): Promise<OrderIntakeSettingsView>;
  saveOrderIntakeSettings(
    input: SaveOrderIntakeSettingsInput,
  ): Promise<OrderIntakeSettingsView>;
  getOcrSettings(): Promise<OcrSettingsView>;
  saveOcrSettings(input: SaveOcrSettingsInput): Promise<OcrSettingsView>;
  removeOcrApiKey(): Promise<OcrSettingsView>;
  testOcrConnection(input: OcrConnectionTestInput): Promise<OcrConnectionTestResult>;
  getCandidateVerificationSettings(): Promise<CandidateVerificationSettingsView>;
  saveCandidateVerificationSettings(
    input: SaveCandidateVerificationSettingsInput,
  ): Promise<CandidateVerificationSettingsView>;
  removeCandidateVerificationApiKey(): Promise<CandidateVerificationSettingsView>;
  testCandidateVerificationConnection(
    input: CandidateVerificationConnectionTestInput,
  ): Promise<CandidateVerificationConnectionTestResult>;
}
