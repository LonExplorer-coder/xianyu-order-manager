import type {
  FulfillmentStatus,
  LifecycleStatus,
  OrderPlatform,
  OrderSummary,
  PlatformTransactionStatus,
  RecognitionBatchItemStatus,
  OrderItem,
} from './contracts';
import type {
  CustomFieldFilter,
  CustomFieldSort,
  CustomFieldValueRecord,
} from './custom-fields';

export type OrderWorkbenchDateField = 'ordered_at' | 'paid_at' | 'created_at';

export type OrderWorkbenchSortField =
  | OrderWorkbenchDateField
  | 'amount'
  | 'platform'
  | 'seller_account'
  | 'buyer'
  | 'product'
  | 'initial_source_recognition_status'
  | 'platform_transaction_status'
  | 'fulfillment_status'
  | 'lifecycle_status';

export type OrderWorkbenchQuery = {
  text?: string;
  buyerText?: string;
  productText?: string;
  dateField?: OrderWorkbenchDateField;
  dateFrom?: string;
  dateTo?: string;
  platform?: OrderPlatform;
  sellerAccount?: string;
  initialSourceRecognitionStatus?: RecognitionBatchItemStatus;
  platformTransactionStatus?: PlatformTransactionStatus;
  fulfillmentStatus?: FulfillmentStatus;
  lifecycleStatus?: LifecycleStatus | 'all';
  sortField?: OrderWorkbenchSortField;
  sortDirection?: 'asc' | 'desc';
  customFieldFilter?: CustomFieldFilter;
  customFieldSort?: CustomFieldSort;
};

export type OrderWorkbenchResult = {
  orders: OrderSummary[];
  customFieldValues: CustomFieldValueRecord[];
  allLifecycleOrderCount: number;
  activeOrderCount: number;
  pendingShipmentCount: number;
  platforms: OrderPlatform[];
  sellerAccounts: string[];
};

export type OrderItemWorkbenchQuery = {
  customFieldFilter?: CustomFieldFilter;
  customFieldSort?: CustomFieldSort;
};

export type OrderItemWorkbenchItem = OrderItem & {
  orderId: string;
  orderNumber: string;
};

export type OrderItemWorkbenchResult = {
  items: OrderItemWorkbenchItem[];
  customFieldValues: CustomFieldValueRecord[];
};
