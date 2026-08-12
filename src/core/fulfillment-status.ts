import type { FulfillmentStatus, ManualFulfillmentStatus } from './contracts';

export const FULFILLMENT_STATUSES = [
  'pending_shipment',
  'partially_shipped',
  'shipped',
  'delivered',
  'returned',
  'unknown',
] as const satisfies readonly FulfillmentStatus[];

export const MANUAL_FULFILLMENT_STATUSES = [
  'pending_shipment',
  'shipped',
  'delivered',
  'returned',
  'unknown',
] as const satisfies readonly ManualFulfillmentStatus[];

export const FULFILLMENT_STATUS_LABELS: Record<FulfillmentStatus, string> = {
  pending_shipment: '待发货',
  partially_shipped: '部分发货',
  shipped: '已发货',
  delivered: '已收货',
  returned: '已退货',
  unknown: '未知',
};

export function isFulfillmentStatus(value: unknown): value is FulfillmentStatus {
  return FULFILLMENT_STATUSES.some((status) => status === value);
}

export function isManualFulfillmentStatus(
  value: unknown,
): value is (typeof MANUAL_FULFILLMENT_STATUSES)[number] {
  return MANUAL_FULFILLMENT_STATUSES.some((status) => status === value);
}
