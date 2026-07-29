export type RecognitionItem = {
  sourceTitle: string;
  sourceSpec: string;
  unitPriceCents: number | null;
  quantity: number;
  quantityInferred: boolean;
};

export type PlatformTransactionStatus = 'paid' | 'cancelled' | 'refunded' | 'unknown';

export type FulfillmentStatus = 'pending_shipment' | 'shipped' | 'unknown';

export type RecognitionResult = {
  platform: 'xianyu';
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
  createdAt: string;
  items: DraftItem[];
};

export type RecognitionBatch = {
  id: string;
  drafts: OrderDraft[];
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
  lifecycleStatus: 'active' | 'trashed' | 'deleted';
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
};

export type OrderSummary = {
  id: string;
  orderNumber: string;
  buyerNickname: string;
  recipient: string;
  amountCents: number;
  itemCount: number;
  platformTransactionStatus: PlatformTransactionStatus;
  fulfillmentStatus: FulfillmentStatus;
  createdAt: string;
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
  confirmed: RecognitionResult;
};

export type OrderDetails = {
  order: OriginalOrder;
  sourceScreenshot: SourceScreenshot;
  sourceSnapshot: SourceSnapshot;
};
