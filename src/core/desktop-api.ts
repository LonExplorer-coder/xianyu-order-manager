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
  CreateStandardProductInput,
  DraftItemProductStandardization,
  ProductStandardizationConfirmation,
  StandardProduct,
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
  UpdateAftersalesCaseInput,
} from './aftersales-cases';
import type {
  AftersalesWorkflowTemplate,
  CopyAftersalesWorkflowTemplateInput,
  CreateAftersalesWorkflowTemplateInput,
  UpdateAftersalesWorkflowTemplateInput,
} from './aftersales-workflow-templates';

export type BootstrapState =
  | { kind: 'needs_data_directory' }
  | { kind: 'ready'; dataDirectory: string; orders: OrderSummary[] }
  | { kind: 'locked'; dataDirectory: string; message: string }
  | { kind: 'error'; message: string };

export interface DesktopApi {
  getBootstrapState(): Promise<BootstrapState>;
  retryDataDirectory(): Promise<BootstrapState>;
  selectDataDirectory(): Promise<BootstrapState>;
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
  previewDraftProductStandardizations(
    draft: OrderDraft,
  ): Promise<DraftItemProductStandardization[]>;
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
  exportOrders(input: OrderExportInput): Promise<OrderExportResult>;
  previewOrderExport(input: OrderExportInput): Promise<OrderExportPreviewResult>;
  exportShipmentGroups(input: ShipmentGroupExportInput): Promise<ShipmentGroupExportResult>;
  previewShipmentGroupExport(
    input: ShipmentGroupExportInput,
  ): Promise<ShipmentGroupExportPreviewResult>;
  onOrdersChanged(listener: (orders: OrderSummary[]) => void): () => void;
  getOrder(orderId: string): Promise<OrderDetails>;
  updateOrder(input: OrderEditInput): Promise<OrderDetails>;
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
