export type PurchaseSuggestionStatus = 'draft' | 'confirmed' | 'cancelled';

export type PurchaseSuggestionEventType =
  | 'created'
  | 'confirmed'
  | 'cancelled'
  | 'reduced';

export type PresaleDemandProductView = {
  standardProductId: string;
  sku: string;
  name: string;
  specification: string;
  demandQuantity: number;
  refundedOrCancelledQuantity: number;
  confirmedInTransitQuantity: number;
  draftSuggestionQuantity: number;
  uncoveredQuantity: number;
  overPurchaseRisk: boolean;
  draftExceedsUncovered: boolean;
};

export type PresaleDemandUnmappedView = {
  sourceTitle: string;
  sourceSpec: string;
  quantity: number;
  orderCount: number;
};

export type PurchaseSuggestionView = {
  id: string;
  planId: string;
  standardProductId: string;
  sku: string;
  name: string;
  specification: string;
  quantity: number;
  status: PurchaseSuggestionStatus;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
};

export type PresaleDemandTotals = {
  demandQuantity: number;
  refundedOrCancelledQuantity: number;
  confirmedInTransitQuantity: number;
  draftSuggestionQuantity: number;
  uncoveredQuantity: number;
  allocatedStockQuantity: number;
  pendingInspectionQuantity: number;
  releasedOrderCount: number;
};

export type PresaleDemandView = {
  planId: string;
  planName: string;
  demandAlertThreshold: number | null;
  products: PresaleDemandProductView[];
  unmapped: PresaleDemandUnmappedView[];
  suggestions: PurchaseSuggestionView[];
  totals: PresaleDemandTotals;
};

export type RegisterFulfillmentRefundInput = {
  planId: string;
  orderId: string;
  orderItemId: string;
  quantity: number;
  reason: string;
};

export type CreatePurchaseSuggestionInput = {
  planId: string;
  standardProductId: string;
  quantity: number;
  reason: string;
};

export type PurchaseSuggestionActionInput = {
  planId: string;
  suggestionId: string;
  reason: string;
};

export function normalizeRegisterFulfillmentRefundInput(
  input: unknown,
): RegisterFulfillmentRefundInput {
  const record = objectValue(input, '登记发货前退款参数无效');
  rejectUnknownKeys(
    record,
    ['planId', 'orderId', 'orderItemId', 'quantity', 'reason'],
    '登记发货前退款参数无效',
  );
  return {
    planId: identifier(record.planId, '履约计划标识无效'),
    orderId: identifier(record.orderId, '订单标识无效'),
    orderItemId: identifier(record.orderItemId, '订单商品标识无效'),
    quantity: positiveQuantity(record.quantity, '退款数量无效'),
    reason: requiredReason(record.reason),
  };
}

export function normalizeCreatePurchaseSuggestionInput(
  input: unknown,
): CreatePurchaseSuggestionInput {
  const record = objectValue(input, '创建采购建议参数无效');
  rejectUnknownKeys(
    record,
    ['planId', 'standardProductId', 'quantity', 'reason'],
    '创建采购建议参数无效',
  );
  return {
    planId: identifier(record.planId, '履约计划标识无效'),
    standardProductId: identifier(record.standardProductId, '标准商品标识无效'),
    quantity: positiveQuantity(record.quantity, '采购建议数量无效'),
    reason: requiredReason(record.reason),
  };
}

export function normalizePurchaseSuggestionActionInput(
  input: unknown,
): PurchaseSuggestionActionInput {
  const record = objectValue(input, '采购建议操作参数无效');
  rejectUnknownKeys(
    record,
    ['planId', 'suggestionId', 'reason'],
    '采购建议操作参数无效',
  );
  return {
    planId: identifier(record.planId, '履约计划标识无效'),
    suggestionId: identifier(record.suggestionId, '采购建议标识无效'),
    reason: requiredReason(record.reason),
  };
}

export function presaleDemandAlerts(view: PresaleDemandView): string[] {
  if (view.demandAlertThreshold === null) return [];
  return view.products
    .filter(({ uncoveredQuantity }) => uncoveredQuantity >= view.demandAlertThreshold!)
    .map(({ name, specification, uncoveredQuantity }) => (
      `${name}${specification ? `（${specification}）` : ''}未覆盖 ${uncoveredQuantity} 件，达到提醒阈值`
    ));
}

export function purchaseSuggestionStatusLabel(status: PurchaseSuggestionStatus): string {
  const labels: Record<PurchaseSuggestionStatus, string> = {
    draft: '待确认',
    confirmed: '已确认（采购在途）',
    cancelled: '已取消',
  };
  return labels[status];
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  message: string,
): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(message);
}

function boundedText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(message);
  return normalized;
}

function requiredReason(value: unknown): string {
  return boundedText(value, 500, '请填写非空原因');
}

function identifier(value: unknown, message: string): string {
  return boundedText(value, 200, message);
}

function positiveQuantity(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(message);
  return Number(value);
}
