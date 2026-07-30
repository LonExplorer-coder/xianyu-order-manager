import type {
  OrderDetails,
  OrderDraft,
  OrderSummary,
  OriginalOrder,
  RecognitionBatchView,
} from './contracts';
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
  onRecognitionBatchesChanged(
    listener: (batches: RecognitionBatchView[]) => void,
  ): () => void;
  cancelDraft(draftId: string): Promise<void>;
  confirmDraft(draft: OrderDraft): Promise<OriginalOrder>;
  listOrders(): Promise<OrderSummary[]>;
  onOrdersChanged(listener: (orders: OrderSummary[]) => void): () => void;
  getOrder(orderId: string): Promise<OrderDetails>;
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
