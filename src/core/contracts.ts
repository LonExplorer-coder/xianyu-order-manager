export type RecognitionItem = {
  sourceTitle: string;
  sourceSpec: string;
  unitPriceCents: number;
  quantity: number;
  quantityInferred: boolean;
};

export type RecognitionResult = {
  platform: 'xianyu';
  sellerAccount: string;
  orderNumber: string;
  buyerNickname: string;
  recipient: string;
  phone: string;
  addressOriginal: string;
  amountCents: number;
  items: RecognitionItem[];
};

export type RecognizerSource = {
  absolutePath: string;
  originalName: string;
  mimeType: string;
  sha256: string;
  bytes: Uint8Array;
};

export interface Recognizer {
  recognize(source: RecognizerSource): Promise<RecognitionResult>;
}

export type DraftItem = RecognitionItem & {
  id: string;
  position: number;
};

export type OrderDraft = Omit<RecognitionResult, 'items'> & {
  id: string;
  batchId: string;
  screenshotId: string;
  status: 'awaiting_review' | 'confirmed';
  createdAt: string;
  items: DraftItem[];
};

export type RecognitionBatch = {
  id: string;
  drafts: OrderDraft[];
};

export type OrderItem = RecognitionItem & {
  id: string;
  position: number;
  subtotalCents: number;
};

export type OriginalOrder = Omit<RecognitionResult, 'items'> & {
  id: string;
  platformTransactionStatus: 'paid';
  fulfillmentStatus: 'pending_shipment';
  lifecycleStatus: 'active';
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
