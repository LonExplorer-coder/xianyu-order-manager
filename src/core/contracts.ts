import type {
  CustomFieldDefinition,
  CustomFieldValueRecord,
} from './custom-fields';
import type { QuantitySource } from './quantity-source';

export type RecognitionItem = {
  sourceTitle: string;
  sourceSpec: string;
  unitPriceCents: number | null;
  quantity: number;
  quantityInferred: boolean;
  /** Missing only at legacy/provider input boundaries; application reads always normalize it. */
  quantitySource?: QuantitySource;
};

export type PlatformTransactionStatus = 'paid' | 'cancelled' | 'refunded' | 'unknown';

export type FulfillmentStatus = 'pending_shipment' | 'shipped' | 'unknown';

export type OrderPlatform = 'xianyu';

export type LifecycleStatus = 'active' | 'trashed' | 'deleted';

export const ORDER_REVIEW_ISSUE_CODES = [
  'automatic_import_disabled',
  'automatic_import_failed',
  'duplicate_order',
  'order_content_changed',
  'screenshot_content_incomplete',
  'targeted_review_failed',
  'targeted_review_conflict',
  'missing_seller_account',
  'missing_order_number',
  'invalid_order_number',
  'missing_recipient',
  'invalid_recipient',
  'missing_phone',
  'invalid_phone',
  'missing_address',
  'incomplete_address',
  'address_mismatch',
  'missing_items',
  'missing_item_title',
  'invalid_item_title',
  'missing_item_price',
  'invalid_item_price',
  'missing_item_quantity',
  'invalid_item_quantity',
  'missing_product_total',
  'invalid_product_total',
  'missing_shipping_fee',
  'invalid_shipping_fee',
  'missing_amount',
  'invalid_amount',
  'item_total_mismatch',
  'buyer_recipient_conflict',
  'invalid_order_time',
  'invalid_payment_time',
  'payment_before_order',
  'missing_required_custom_field',
] as const;

export type OrderReviewIssueCode = (typeof ORDER_REVIEW_ISSUE_CODES)[number];

export type RecognitionResult = {
  platform: OrderPlatform;
  sellerAccount: string;
  orderNumber: string;
  alipayTransactionNumber: string;
  buyerNickname: string;
  recipient: string;
  phone: string;
  phoneNormalized: string;
  addressOriginal: string;
  addressNormalized: string;
  province: string;
  city: string;
  district: string;
  orderedAtOriginal: string;
  orderedAtNormalized: string;
  paidAtOriginal: string;
  paidAtNormalized: string;
  productTotalCents: number | null;
  shippingFeeCents: number | null;
  amountCents: number | null;
  platformTransactionStatus: PlatformTransactionStatus;
  fulfillmentStatus: FulfillmentStatus;
  items: RecognitionItem[];
};

export type RecognitionEvidence = {
  provider: 'aliyun-bailian' | 'controlled';
  model: 'qwen3.5-ocr' | 'controlled';
  requestId: string;
  schemaVersion: 1;
  rawResponse: string;
};

export type RecognitionAttempt = {
  result: RecognitionResult;
  evidences: [RecognitionEvidence, ...RecognitionEvidence[]];
  reviewIssues?: OrderReviewIssueCode[];
};

export type RecognizerSource = {
  absolutePath: string;
  originalName: string;
  mimeType: string;
  sha256: string;
  bytes: Uint8Array;
};

export interface Recognizer {
  recognize(source: RecognizerSource): Promise<RecognitionAttempt>;
}

export type DraftItem = RecognitionItem & {
  id: string;
  position: number;
};

export type OrderDraft = Omit<RecognitionResult, 'items'> & {
  id: string;
  batchId: string;
  screenshotId: string;
  status: 'awaiting_review' | 'confirmed' | 'cancelled';
  reviewIssues?: OrderReviewIssueCode[];
  createdAt: string;
  items: DraftItem[];
};

export type RecognitionBatch = {
  id: string;
  drafts: OrderDraft[];
};

export type RecognitionBatchItemStatus =
  | 'waiting_recognition'
  | 'recognizing'
  | 'validating'
  | 'awaiting_confirmation'
  | 'imported'
  | 'waiting_retry'
  | 'failed'
  | 'duplicate_skipped'
  | 'cancelled';

export type RecognitionBatchItemResolution =
  | 'new_order'
  | 'identical_image'
  | 'equivalent_order'
  | 'order_updated';

export type RecognitionBatchItem = {
  id: string;
  batchId: string;
  sourceName: string;
  status: RecognitionBatchItemStatus;
  draftId?: string;
  errorMessage?: string;
  retryCount?: number;
  nextRetryAt?: string;
  reviewIssues?: OrderReviewIssueCode[];
  resolution?: RecognitionBatchItemResolution;
};

export type RecognitionBatchView = {
  id: string;
  items: RecognitionBatchItem[];
  totalCount: number;
  processedCount: number;
  counts: Record<RecognitionBatchItemStatus, number>;
  createdAt: string;
};

export type OrderItem = Omit<RecognitionItem, 'unitPriceCents'> & {
  id: string;
  position: number;
  unitPriceCents: number;
  subtotalCents: number;
};

export type OriginalOrder = Omit<RecognitionResult, 'items' | 'amountCents'> & {
  id: string;
  amountCents: number;
  revision: number;
  lifecycleStatus: LifecycleStatus;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
};

export type OrderUpdateConfirmation = {
  order: OriginalOrder;
  resolution: 'new_order' | 'order_updated' | 'equivalent_order';
};

export type OrderDraftConfirmation = {
  order: OriginalOrder;
  resolution: 'new_order' | 'equivalent_order';
};

export type OrderSummary = {
  id: string;
  platform: OrderPlatform;
  sellerAccount: string;
  orderNumber: string;
  alipayTransactionNumber: string;
  buyerNickname: string;
  recipient: string;
  phone: string;
  addressOriginal: string;
  province?: string;
  city?: string;
  district?: string;
  amountCents: number;
  itemCount: number;
  initialSourceRecognitionStatus: RecognitionBatchItemStatus;
  platformTransactionStatus: PlatformTransactionStatus;
  fulfillmentStatus: FulfillmentStatus;
  lifecycleStatus: LifecycleStatus;
  orderedAtNormalized: string;
  paidAtNormalized: string;
  createdAt: string;
  items: Array<Pick<OrderItem, 'sourceTitle' | 'sourceSpec' | 'quantity'>>;
};

export type SourceScreenshot = {
  id: string;
  originalName: string;
  relativePath: string;
  mimeType: string;
  sha256: string;
  createdAt: string;
};

export type SourceSnapshot = {
  id: string;
  createdAt: string;
  recognition: RecognitionResult;
  confirmed: RecognitionResult | null;
};

export type OrderChangeValue =
  | string
  | number
  | boolean
  | null
  | OrderChangeValue[]
  | { [key: string]: OrderChangeValue };

export type OrderFieldChange = {
  path: string;
  before: OrderChangeValue;
  after: OrderChangeValue;
};

export type OrderChangeEvent = {
  id: string;
  sourceSnapshotId: string | null;
  source: 'source_update' | 'manual_edit';
  baseRevision: number;
  resultRevision: number;
  createdAt: string;
  changes: OrderFieldChange[];
};

export type OrderDraftReview =
  | {
    kind: 'new_order';
    draft: OrderDraft;
  }
  | {
    kind: 'order_update';
    draft: OrderDraft;
    currentOrder: OriginalOrder;
    expectedRevision: number;
    changes: OrderFieldChange[];
    sourceSnapshot: SourceSnapshot;
    customFieldValues: CustomFieldValueRecord[];
  };

export type OrderSource = {
  recognitionStatus: RecognitionBatchItemStatus;
  sourceScreenshot: SourceScreenshot;
  sourceSnapshot: SourceSnapshot;
};

export type OrderDetails = {
  order: OriginalOrder;
  sourceScreenshot: SourceScreenshot;
  sourceSnapshot: SourceSnapshot;
  sources: OrderSource[];
  changeEvents: OrderChangeEvent[];
  customFieldDefinitions: CustomFieldDefinition[];
  customFieldValues: CustomFieldValueRecord[];
};
