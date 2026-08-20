import type {
  OrderChangeEvent,
  OrderChangeValue,
  OrderDetails,
  OriginalOrder,
  SourceSnapshot,
} from './contracts';
import type { OrderLifecycleEvent } from './order-lifecycle';
import type { ShipmentGroupAdjustmentEvent } from './shipment-group-adjustments';
import { matchOrderItemIds, type IdentifiedOrderItem } from './order-item-matching';

export type OrderHistoryTimelineEntry =
  | {
    kind: 'source';
    id: string;
    occurredAt: string;
    sourceSnapshotId: string;
    sourceName: string;
    sourceType: NonNullable<SourceSnapshot['sourceType']>;
    recognitionStatus: OrderDetails['sources'][number]['recognitionStatus'];
    latestSourceSnapshot: boolean;
  }
  | {
    kind: 'source_confirmation';
    id: string;
    occurredAt: string;
    sourceSnapshotId: string;
    sourceName: string;
    sourceType: NonNullable<SourceSnapshot['sourceType']>;
  }
  | ({ kind: 'order_change'; occurredAt: string } & OrderChangeEvent)
  | ({ kind: 'shipment_group_adjustment'; occurredAt: string }
    & ShipmentGroupAdjustmentEvent)
  | ({ kind: 'lifecycle'; occurredAt: string } & OrderLifecycleEvent);

export type OrderSourceValueKind = 'source_value' | 'normalized_value';

export type OrderSourceValueRow = {
  path: string;
  kind: OrderSourceValueKind;
  recognition: OrderChangeValue;
  confirmed: OrderChangeValue;
  current: OrderChangeValue;
};

type OrderHistoryFacts = Pick<
  OrderDetails,
  | 'sourceSnapshot'
  | 'sources'
  | 'changeEvents'
  | 'shipmentGroupAdjustmentEvents'
  | 'lifecycleEvents'
>;

const SOURCE_VALUE_FIELDS = [
  'platform',
  'sellerAccount',
  'orderNumber',
  'alipayTransactionNumber',
  'buyerNickname',
  'recipient',
  'phone',
  'addressOriginal',
  'orderedAtOriginal',
  'paidAtOriginal',
  'productTotalCents',
  'shippingFeeCents',
  'amountCents',
  'platformTransactionStatus',
  'fulfillmentStatus',
] as const;

const NORMALIZED_VALUE_FIELDS = [
  'phoneNormalized',
  'addressNormalized',
  'province',
  'city',
  'district',
  'orderedAtNormalized',
  'paidAtNormalized',
] as const;

const ITEM_VALUE_FIELDS = [
  'sourceTitle',
  'sourceSpec',
  'unitPriceCents',
  'quantity',
] as const;

const HISTORY_KIND_ORDER: Record<OrderHistoryTimelineEntry['kind'], number> = {
  source: 0,
  source_confirmation: 1,
  order_change: 2,
  shipment_group_adjustment: 3,
  lifecycle: 4,
};

export function buildOrderHistoryTimeline(
  facts: OrderHistoryFacts,
): OrderHistoryTimelineEntry[] {
  const entries: OrderHistoryTimelineEntry[] = [
    ...facts.sources.flatMap(({ recognitionStatus, sourceScreenshot, sourceSnapshot }) => {
      const sourceName = sourceScreenshot?.originalName
        ?? sourceSnapshot.sourceName
        ?? '历史导入';
      const sourceType = sourceSnapshot.sourceType ?? 'screenshot';
      const sourceEntry: OrderHistoryTimelineEntry = {
        kind: 'source',
        id: `source:${sourceSnapshot.id}`,
        occurredAt: sourceSnapshot.createdAt,
        sourceSnapshotId: sourceSnapshot.id,
        sourceName,
        sourceType,
        recognitionStatus,
        latestSourceSnapshot: sourceSnapshot.id === facts.sourceSnapshot.id,
      };
      if (!sourceSnapshot.confirmed || !sourceSnapshot.confirmedAt) return [sourceEntry];
      return [{
        kind: 'source_confirmation' as const,
        id: `source-confirmation:${sourceSnapshot.id}`,
        occurredAt: sourceSnapshot.confirmedAt,
        sourceSnapshotId: sourceSnapshot.id,
        sourceName,
        sourceType,
      }, sourceEntry];
    }),
    ...facts.changeEvents.map((event) => ({
      ...event,
      kind: 'order_change' as const,
      occurredAt: event.createdAt,
    })),
    ...facts.shipmentGroupAdjustmentEvents.map((event) => ({
      ...event,
      kind: 'shipment_group_adjustment' as const,
      occurredAt: event.createdAt,
    })),
    ...facts.lifecycleEvents.map((event) => ({
      ...event,
      kind: 'lifecycle' as const,
      occurredAt: event.createdAt,
    })),
  ];
  return entries.sort((left, right) => (
    right.occurredAt.localeCompare(left.occurredAt)
    || HISTORY_KIND_ORDER[right.kind] - HISTORY_KIND_ORDER[left.kind]
    || right.id.localeCompare(left.id)
  ));
}

export function buildOrderSourceValueRows(
  snapshot: SourceSnapshot,
  currentOrder: OriginalOrder,
): OrderSourceValueRow[] {
  const confirmed = snapshot.confirmed;
  const rows: OrderSourceValueRow[] = [
    ...SOURCE_VALUE_FIELDS.map((field) => ({
      path: field,
      kind: 'source_value' as const,
      recognition: orderChangeValue(snapshot.recognition[field]),
      confirmed: orderChangeValue(confirmed?.[field]),
      current: orderChangeValue(currentOrder[field]),
    })),
    ...NORMALIZED_VALUE_FIELDS.map((field) => ({
      path: field,
      kind: 'normalized_value' as const,
      recognition: orderChangeValue(snapshot.recognition[field]),
      confirmed: orderChangeValue(confirmed?.[field]),
      current: orderChangeValue(currentOrder[field]),
    })),
  ];
  appendItemValueRows(rows, snapshot, currentOrder);
  return rows;
}

function appendItemValueRows(
  rows: OrderSourceValueRow[],
  snapshot: SourceSnapshot,
  currentOrder: OriginalOrder,
): void {
  const recognitionItems = identifiedItems(snapshot.recognition.items, 'recognition');
  const confirmedItems = snapshot.confirmed
    ? identifiedItems(snapshot.confirmed.items, 'confirmed')
    : null;
  const referenceItems = confirmedItems ?? recognitionItems;
  const recognitionByReferenceId = new Map<string, IdentifiedOrderItem>();
  if (confirmedItems) {
    const referenceIdByRecognitionId = matchOrderItemIds(confirmedItems, recognitionItems);
    for (const recognitionItem of recognitionItems) {
      const referenceId = referenceIdByRecognitionId.get(recognitionItem.id);
      if (referenceId) recognitionByReferenceId.set(referenceId, recognitionItem);
    }
  } else {
    for (const recognitionItem of recognitionItems) {
      recognitionByReferenceId.set(recognitionItem.id, recognitionItem);
    }
  }

  const currentIdByReferenceId = matchOrderItemIds(currentOrder.items, referenceItems);
  const currentById = new Map(currentOrder.items.map((item) => [item.id, item]));
  const matchedRecognitionIds = new Set<string>();
  const matchedCurrentIds = new Set<string>();
  for (const [position, referenceItem] of referenceItems.entries()) {
    const recognitionItem = recognitionByReferenceId.get(referenceItem.id);
    const currentId = currentIdByReferenceId.get(referenceItem.id);
    const currentItem = currentId ? currentById.get(currentId) : undefined;
    if (recognitionItem) matchedRecognitionIds.add(recognitionItem.id);
    if (currentItem) matchedCurrentIds.add(currentItem.id);
    appendItemFields(rows, `items[${position}]`, {
      recognition: recognitionItem,
      confirmed: confirmedItems?.[position],
      current: currentItem,
    });
  }

  for (const [position, recognitionItem] of recognitionItems.entries()) {
    if (matchedRecognitionIds.has(recognitionItem.id)) continue;
    appendItemFields(rows, `items.sourceSnapshotOnly[${position}]`, {
      recognition: recognitionItem,
      confirmed: undefined,
      current: undefined,
    });
  }
  for (const [position, currentItem] of currentOrder.items.entries()) {
    if (matchedCurrentIds.has(currentItem.id)) continue;
    appendItemFields(rows, `items.currentOrderOnly[${position}]`, {
      recognition: undefined,
      confirmed: undefined,
      current: currentItem,
    });
  }
}

function identifiedItems(
  items: SourceSnapshot['recognition']['items'],
  prefix: string,
): IdentifiedOrderItem[] {
  return items.map((item, position) => ({ ...item, id: `${prefix}:${position}` }));
}

function appendItemFields(
  rows: OrderSourceValueRow[],
  pathPrefix: string,
  items: {
    recognition: IdentifiedOrderItem | undefined;
    confirmed: IdentifiedOrderItem | undefined;
    current: OriginalOrder['items'][number] | undefined;
  },
): void {
  for (const field of ITEM_VALUE_FIELDS) {
    rows.push({
      path: `${pathPrefix}.${field}`,
      kind: 'source_value',
      recognition: orderChangeValue(items.recognition?.[field]),
      confirmed: orderChangeValue(items.confirmed?.[field]),
      current: orderChangeValue(items.current?.[field]),
    });
  }
}

function orderChangeValue(value: unknown): OrderChangeValue {
  if (value === undefined) return null;
  return value as OrderChangeValue;
}
