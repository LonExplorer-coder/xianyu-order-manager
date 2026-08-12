import type { FulfillmentStatus } from './contracts';

export const FULFILLMENT_STATUSES = [
  'pending_shipment',
  'partially_shipped',
  'shipped',
  'delivered',
  'unknown',
] as const satisfies readonly FulfillmentStatus[];

export const FULFILLMENT_STATUS_LABELS: Record<FulfillmentStatus, string> = {
  pending_shipment: '待发货',
  partially_shipped: '部分发货',
  shipped: '已发货',
  delivered: '已收货',
  unknown: '未知',
};

export function isFulfillmentStatus(value: unknown): value is FulfillmentStatus {
  return FULFILLMENT_STATUSES.some((status) => status === value);
}
