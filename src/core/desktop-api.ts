import type {
  OrderDetails,
  OrderDraft,
  OrderDraftConfirmation,
  OrderDraftReview,
  OrderSummary,
  OrderUpdateConfirmation,
  OriginalOrder,
  OrderEditInput,
  RecognitionBatchView,
} from './contracts';
import type {
  CreateCustomFieldDefinitionInput,
  CustomFieldDefinition,
  CustomFieldValueRecord,
  DraftCustomFieldValues,
  SaveCustomFieldValuesInput,
} from './custom-fields';
import type {
  OcrConnectionTestInput,
  OcrConnectionTestResult,
  OcrSettingsView,
  SaveOcrSettingsInput,
} from './ocr-settings';
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
import type { OrderExportInput, OrderExportResult } from './order-export';
import type {
  CreateTableTemplateInput,
  TableTemplate,
  TableTemplateGranularity,
  UpdateTableTemplateInput,
} from './table-templates';

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
  onRecognitionBatchesChanged(
    listener: (batches: RecognitionBatchView[]) => void,
  ): () => void;
  cancelDraft(draftId: string): Promise<void>;
  confirmDraft(
    draft: OrderDraft,
    customValues?: DraftCustomFieldValues,
  ): Promise<OrderDraftConfirmation>;
  confirmOrderUpdate(
    draft: OrderDraft,
    expectedRevision: number,
    customValues?: DraftCustomFieldValues,
  ): Promise<OrderUpdateConfirmation>;
  listOrders(): Promise<OrderSummary[]>;
  queryOrders(
    query: OrderWorkbenchQuery,
    customFieldDefinitionIds?: readonly string[],
  ): Promise<OrderWorkbenchResult>;
  queryOrderItems(
    query: OrderItemWorkbenchQuery,
    customFieldDefinitionIds?: readonly string[],
  ): Promise<OrderItemWorkbenchResult>;
  exportOrders(input: OrderExportInput): Promise<OrderExportResult>;
  onOrdersChanged(listener: (orders: OrderSummary[]) => void): () => void;
  getOrder(orderId: string): Promise<OrderDetails>;
  updateOrder(input: OrderEditInput): Promise<OrderDetails>;
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
}
