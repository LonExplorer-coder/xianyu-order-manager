import type {
  CustomFieldDefinition,
  CustomFieldValue,
  CustomFieldValueRecord,
} from './custom-fields';
import type { QuantitySource } from './quantity-source';
import type { CandidateAdjudicationAudit } from './candidate-adjudication-audit';
import type { OrderSpendingView } from './recipients';
import type {
  ProductStandardizationSource,
  StandardDisplayPreference,
  StandardProduct,
} from './product-standardization';
import type {
  OrderOperationsOverview,
  OrderOperationsProjection,
} from './order-operations-projection';
import type { OrderLifecycleEvent } from './order-lifecycle';
import type { ShipmentGroupAdjustmentEvent } from './shipment-group-adjustments';

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

export type RecognitionFulfillmentStatus = 'pending_shipment' | 'shipped' | 'unknown';

export type FulfillmentStatus = RecognitionFulfillmentStatus
  | 'partially_shipped'
  | 'delivered';

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

export const RECOGNITION_CONFLICT_REGIONS = [
  'platform_status',
  'shipping_information',
  'purchased_items',
  'amount_summary',
  'order_details',
] as const;

export type RecognitionConflictRegion =
  (typeof RECOGNITION_CONFLICT_REGIONS)[number];

export const RECOGNITION_CONFLICT_FIELDS = [
  'module_structure',
  'platform_status',
  'recipient',
  'recipient_phone_line_text',
  'phone',
  'address',
  'province',
  'city',
  'district',
  'shipping_controls',
  'item_title',
  'item_spec',
  'item_unit_price',
  'item_quantity',
  'item_controls',
  'product_total',
  'shipping_fee',
  'amount',
  'detail_state',
  'order_number',
  'alipay_transaction_number',
  'buyer_nickname_label',
  'buyer_nickname',
  'order_time',
  'payment_time',
  'order_detail_controls',
] as const;

export type RecognitionConflictField =
  (typeof RECOGNITION_CONFLICT_FIELDS)[number];

export const RECOGNITION_CONFLICT_KINDS = [
  'multiple_candidates',
  'value_mismatch',
  'unsupported_value',
  'outside_region',
  'instruction_echo',
] as const;

export type RecognitionConflictKind =
  (typeof RECOGNITION_CONFLICT_KINDS)[number];

export const RECOGNITION_CONFLICT_LIMITS = {
  details: 100,
  valuesPerSide: 20,
  textLength: 1_000,
} as const;

export type RecognitionConflictDetail = {
  region: RecognitionConflictRegion;
  field: RecognitionConflictField;
  kind: RecognitionConflictKind;
  itemIndex?: number;
  locatedValues: string[];
  extractedValues: string[];
  retainedValue: string | null;
};

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
  fulfillmentStatus: RecognitionFulfillmentStatus;
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
  recognitionConflicts?: RecognitionConflictDetail[];
  candidateAdjudication?: CandidateAdjudicationAudit;
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

export type OrderDraft = Omit<RecognitionResult, 'items' | 'fulfillmentStatus'> & {
  id: string;
  batchId: string;
  screenshotId: string;
  fulfillmentStatus: RecognitionFulfillmentStatus;
  status: 'awaiting_review' | 'confirmed' | 'cancelled';
  reviewIssues?: OrderReviewIssueCode[];
  recognitionConflicts?: RecognitionConflictDetail[];
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
  recognitionConflicts?: RecognitionConflictDetail[];
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
  standardProduct: StandardProduct | null;
  standardizationSource: ProductStandardizationSource | null;
  standardDisplayPreference: StandardDisplayPreference | null;
};

export type OriginalOrder = Omit<
  RecognitionResult,
  'items' | 'amountCents' | 'fulfillmentStatus'
> & {
  id: string;
  systemOrderNumber: string;
  amountCents: number;
  fulfillmentStatus: FulfillmentStatus;
  note?: string;
  shippingCarrier: string;
  trackingNumber: string;
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
  systemOrderNumber: string;
  readableOrderNumber: string | null;
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
  note?: string;
  shippingCarrier: string;
  trackingNumber: string;
  revision?: number;
  updatedAt?: string;
  lastManualEditAt?: string | null;
  itemCount: number;
  initialSourceRecognitionStatus: RecognitionBatchItemStatus;
  platformTransactionStatus: PlatformTransactionStatus;
  fulfillmentStatus: FulfillmentStatus;
  lifecycleStatus: LifecycleStatus;
  orderedAtNormalized: string;
  paidAtNormalized: string;
  createdAt: string;
  items: Array<Pick<OrderItem, 'sourceTitle' | 'sourceSpec' | 'quantity'> & {
    /** Present for persisted application projections; optional for lightweight consumers. */
    standardProduct?: StandardProduct | null;
    standardDisplayPreference?: StandardDisplayPreference | null;
  }>;
  operations: OrderOperationsOverview;
  /** 收件人累计消费与回购投影；未归属收件人的订单为 null，轻量调用方可缺省。 */
  spending?: OrderSpendingView | null;
};

export type SourceScreenshot = {
  id: string;
  originalName: string;
  relativePath: string;
  mimeType: string;
  sha256: string;
  createdAt: string;
};

export type ConfirmedOrderSnapshot = Omit<RecognitionResult, 'fulfillmentStatus'> & {
  fulfillmentStatus: FulfillmentStatus;
};

export type SourceSnapshot = {
  id: string;
  createdAt: string;
  confirmedAt: string | null;
  sourceType?: 'screenshot' | 'historical_import';
  sourceName?: string | null;
  sourceRowNumbers?: number[];
  recognition: ConfirmedOrderSnapshot;
  confirmed: ConfirmedOrderSnapshot | null;
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
  source: 'source_update' | 'manual_edit' | 'shipment_sync';
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
  sourceScreenshot: SourceScreenshot | null;
  sourceSnapshot: SourceSnapshot;
};

export type OrderDetails = {
  order: OriginalOrder;
  sourceScreenshot: SourceScreenshot | null;
  sourceSnapshot: SourceSnapshot;
  sources: OrderSource[];
  changeEvents: OrderChangeEvent[];
  shipmentGroupAdjustmentEvents: ShipmentGroupAdjustmentEvent[];
  lifecycleEvents: OrderLifecycleEvent[];
  lastManualEditAt?: string | null;
  customFieldDefinitions: CustomFieldDefinition[];
  customFieldValues: CustomFieldValueRecord[];
  operations: OrderOperationsProjection;
  readableOrderNumber: string | null;
  /** 收件人累计消费与回购投影；未归属收件人的订单为 null。 */
  spending: OrderSpendingView | null;
};

export type OrderEditIdentityCorrection = {
  platform: OrderPlatform;
  sellerAccount: string;
  orderNumber: string;
};

export type OrderEditItemInput = {
  /** Existing persisted item id, or null for a new item. */
  id: string | null;
  sourceTitle: string;
  sourceSpec: string;
  unitPriceCents: number;
  quantity: number;
  /** 仅新增商品可携带：保存时同时建立商品标准化关联。 */
  standardProductId?: string | null;
  customFieldValues?: Array<{
    definitionId: string;
    value: CustomFieldValue | null;
  }>;
};

export type OrderEditInput = {
  orderId: string;
  expectedRevision: number;
  identityCorrection: OrderEditIdentityCorrection | null;
  alipayTransactionNumber: string;
  buyerNickname: string;
  recipient: string;
  phone: string;
  addressOriginal: string;
  province: string;
  city: string;
  district: string;
  orderedAtOriginal: string;
  paidAtOriginal: string;
  productTotalCents: number | null;
  shippingFeeCents: number | null;
  amountCents: number;
  note: string;
  items: OrderEditItemInput[];
};

export type OrderEditReview = {
  orderId: string;
  expectedRevision: number;
  input: OrderEditInput;
  changes: OrderFieldChange[];
  shippedSnapshotWarning: boolean;
};

export type OrderPlatformTransactionStatusTarget = {
  orderId: string;
  expectedRevision: number;
};

export type OrderPlatformTransactionStatusPatch = {
  platformTransactionStatus: PlatformTransactionStatus;
};

export type OrderPlatformTransactionStatusUpdateInput = {
  targets: OrderPlatformTransactionStatusTarget[];
  patch: OrderPlatformTransactionStatusPatch;
};
