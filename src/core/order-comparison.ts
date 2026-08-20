import type {
  FulfillmentStatus,
  OrderChangeValue,
  OrderFieldChange,
  OriginalOrder,
  RecognitionItem,
  RecognitionResult,
} from './contracts';
import {
  normalizeAddress,
  normalizePhone,
  normalizeShanghaiDateTime,
} from './order-normalization';

type ComparableOrder = Omit<RecognitionResult, 'items' | 'fulfillmentStatus'> & {
  fulfillmentStatus: FulfillmentStatus;
  items: readonly RecognitionItem[];
};

export function normalizedOrderIdentityPart(value: string): string {
  return value.normalize('NFKC').trim();
}

export function hasSameOrderIdentity(
  left: Pick<ComparableOrder, 'platform' | 'sellerAccount' | 'orderNumber'>,
  right: Pick<ComparableOrder, 'platform' | 'sellerAccount' | 'orderNumber'>,
): boolean {
  return left.platform === right.platform &&
    normalizedOrderIdentityPart(left.sellerAccount) ===
      normalizedOrderIdentityPart(right.sellerAccount) &&
    normalizedOrderIdentityPart(left.orderNumber) ===
      normalizedOrderIdentityPart(right.orderNumber);
}

export function hasEquivalentOrderContent(
  existing: OriginalOrder,
  candidate: ComparableOrder,
): boolean {
  return JSON.stringify(canonicalOrderContent(existing)) ===
    JSON.stringify(canonicalOrderContent(candidate));
}

const ORDER_FIELD_PATHS = [
  'alipayTransactionNumber',
  'buyerNickname',
  'recipient',
  'phone',
  'phoneNormalized',
  'addressOriginal',
  'addressNormalized',
  'province',
  'city',
  'district',
  'orderedAtOriginal',
  'orderedAtNormalized',
  'paidAtOriginal',
  'paidAtNormalized',
  'productTotalCents',
  'shippingFeeCents',
  'amountCents',
  'platformTransactionStatus',
  'fulfillmentStatus',
] as const;

const ITEM_FIELD_PATHS = [
  'sourceTitle',
  'sourceSpec',
  'unitPriceCents',
  'quantity',
  'quantitySource',
] as const;

export function diffOrderCurrentValues(
  existing: OriginalOrder,
  candidate: ComparableOrder,
): OrderFieldChange[] {
  const changes: OrderFieldChange[] = [];
  for (const path of ORDER_FIELD_PATHS) {
    if (existing[path] === candidate[path]) continue;
    changes.push({
      path,
      before: existing[path] as OrderChangeValue,
      after: candidate[path] as OrderChangeValue,
    });
  }

  changes.push(...diffOrderItems(existing.items, candidate.items));
  return changes;
}

function diffOrderItems(
  beforeItems: readonly RecognitionItem[],
  afterItems: readonly RecognitionItem[],
): OrderFieldChange[] {
  const pairs = pairOrderItemsForComparison(beforeItems, afterItems);
  const unmatchedBefore = new Set(beforeItems.map((_item, index) => index));
  const unmatchedAfter = new Set(afterItems.map((_item, index) => index));
  for (const pair of pairs) {
    unmatchedBefore.delete(pair.beforeIndex);
    unmatchedAfter.delete(pair.afterIndex);
  }

  const changes: OrderFieldChange[] = [];
  for (const { beforeIndex, afterIndex } of pairs.sort((left, right) => (
    left.afterIndex - right.afterIndex
  ))) {
    const beforeItem = beforeItems[beforeIndex];
    const afterItem = afterItems[afterIndex];
    for (const field of ITEM_FIELD_PATHS) {
      if (beforeItem[field] === afterItem[field]) continue;
      changes.push({
        path: `items[${afterIndex}].${field}`,
        before: beforeItem[field] as OrderChangeValue,
        after: afterItem[field] as OrderChangeValue,
      });
    }
  }
  for (const afterIndex of [...unmatchedAfter].sort((left, right) => left - right)) {
    changes.push({
      path: `items[${afterIndex}]`,
      before: null,
      after: comparableItemValue(afterItems[afterIndex]),
    });
  }
  for (const beforeIndex of [...unmatchedBefore].sort((left, right) => left - right)) {
    changes.push({
      path: `items.removed[${beforeIndex}]`,
      before: comparableItemValue(beforeItems[beforeIndex]),
      after: null,
    });
  }
  return changes;
}

export type OrderItemComparisonPair = { beforeIndex: number; afterIndex: number };

/**
 * Returns the deterministic item pairing used by both the visible diff and
 * historical-import persistence. Equal items keep source order; the remainder
 * uses the same minimum-difference assignment shown in the preview.
 */
export function pairOrderItemsForComparison(
  beforeItems: readonly RecognitionItem[],
  afterItems: readonly RecognitionItem[],
): OrderItemComparisonPair[] {
  const unmatchedBefore = new Set(beforeItems.map((_item, index) => index));
  const unmatchedAfter = new Set(afterItems.map((_item, index) => index));
  const pairs: OrderItemComparisonPair[] = [];

  for (const beforeIndex of unmatchedBefore) {
    const signature = persistedItemSignature(beforeItems[beforeIndex]);
    const exactAfterIndex = [...unmatchedAfter].find((afterIndex) => (
      persistedItemSignature(afterItems[afterIndex]) === signature
    ));
    if (exactAfterIndex === undefined) continue;
    unmatchedBefore.delete(beforeIndex);
    unmatchedAfter.delete(exactAfterIndex);
    pairs.push({ beforeIndex, afterIndex: exactAfterIndex });
  }

  pairs.push(...minimumDifferenceItemPairs(
    [...unmatchedBefore],
    [...unmatchedAfter],
    beforeItems,
    afterItems,
  ));
  return pairs;
}

function minimumDifferenceItemPairs(
  beforeIndices: readonly number[],
  afterIndices: readonly number[],
  beforeItems: readonly RecognitionItem[],
  afterItems: readonly RecognitionItem[],
): OrderItemComparisonPair[] {
  if (beforeIndices.length === 0 || afterIndices.length === 0) return [];

  if (beforeIndices.length <= afterIndices.length) {
    return minimumCostAssignment(
      beforeIndices.length,
      afterIndices.length,
      (beforePosition, afterPosition) => itemDifferenceCount(
        beforeItems[beforeIndices[beforePosition]],
        afterItems[afterIndices[afterPosition]],
      ),
    ).map((afterPosition, beforePosition) => ({
      beforeIndex: beforeIndices[beforePosition],
      afterIndex: afterIndices[afterPosition],
    }));
  }

  return minimumCostAssignment(
    afterIndices.length,
    beforeIndices.length,
    (afterPosition, beforePosition) => itemDifferenceCount(
      beforeItems[beforeIndices[beforePosition]],
      afterItems[afterIndices[afterPosition]],
    ),
  ).map((beforePosition, afterPosition) => ({
    beforeIndex: beforeIndices[beforePosition],
    afterIndex: afterIndices[afterPosition],
  }));
}

/**
 * Finds a minimum-cost injection from rows to columns in O(rows² × columns).
 * Rows and columns are visited in source order, so equal-cost assignments have
 * a deterministic tie-break without changing the primary field-difference cost.
 */
function minimumCostAssignment(
  rowCount: number,
  columnCount: number,
  cost: (row: number, column: number) => number,
): number[] {
  const rowPotential = Array<number>(rowCount + 1).fill(0);
  const columnPotential = Array<number>(columnCount + 1).fill(0);
  const columnMatch = Array<number>(columnCount + 1).fill(0);
  const previousColumn = Array<number>(columnCount + 1).fill(0);

  for (let row = 1; row <= rowCount; row += 1) {
    columnMatch[0] = row;
    const minimumReducedCost = Array<number>(columnCount + 1).fill(Infinity);
    const visitedColumns = Array<boolean>(columnCount + 1).fill(false);
    let currentColumn = 0;

    do {
      visitedColumns[currentColumn] = true;
      const currentRow = columnMatch[currentColumn];
      let adjustment = Infinity;
      let nextColumn = 0;

      for (let column = 1; column <= columnCount; column += 1) {
        if (visitedColumns[column]) continue;
        const reducedCost = cost(currentRow - 1, column - 1) -
          rowPotential[currentRow] - columnPotential[column];
        if (reducedCost < minimumReducedCost[column]) {
          minimumReducedCost[column] = reducedCost;
          previousColumn[column] = currentColumn;
        }
        if (minimumReducedCost[column] < adjustment) {
          adjustment = minimumReducedCost[column];
          nextColumn = column;
        }
      }

      for (let column = 0; column <= columnCount; column += 1) {
        if (visitedColumns[column]) {
          rowPotential[columnMatch[column]] += adjustment;
          columnPotential[column] -= adjustment;
        } else {
          minimumReducedCost[column] -= adjustment;
        }
      }
      currentColumn = nextColumn;
    } while (columnMatch[currentColumn] !== 0);

    do {
      const priorColumn = previousColumn[currentColumn];
      columnMatch[currentColumn] = columnMatch[priorColumn];
      currentColumn = priorColumn;
    } while (currentColumn !== 0);
  }

  const assignedColumnByRow = Array<number>(rowCount).fill(-1);
  for (let column = 1; column <= columnCount; column += 1) {
    const row = columnMatch[column];
    if (row !== 0) assignedColumnByRow[row - 1] = column - 1;
  }
  return assignedColumnByRow;
}

function itemDifferenceCount(left: RecognitionItem, right: RecognitionItem): number {
  return ITEM_FIELD_PATHS.reduce((count, field) => (
    count + (left[field] === right[field] ? 0 : 1)
  ), 0);
}

function canonicalOrderContent(value: ComparableOrder) {
  return {
    alipayTransactionNumber: normalizedOrderIdentityPart(value.alipayTransactionNumber),
    buyerNickname: normalizedText(value.buyerNickname),
    recipient: normalizedText(value.recipient),
    phone: canonicalPhone(value.phoneNormalized || value.phone),
    address: normalizeAddress(value.addressNormalized || value.addressOriginal),
    province: normalizeAddress(value.province),
    city: normalizeAddress(value.city),
    district: normalizeAddress(value.district),
    orderedAt: canonicalDateTime(value.orderedAtNormalized, value.orderedAtOriginal),
    paidAt: canonicalDateTime(value.paidAtNormalized, value.paidAtOriginal),
    productTotalCents: value.productTotalCents,
    shippingFeeCents: value.shippingFeeCents,
    amountCents: value.amountCents,
    platformTransactionStatus: value.platformTransactionStatus,
    fulfillmentStatus: value.fulfillmentStatus,
    items: canonicalItems(value.items),
  };
}

function canonicalItems(items: readonly RecognitionItem[]) {
  return items
    .map(canonicalItem)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function canonicalItem(item: RecognitionItem) {
  return {
    sourceTitle: normalizedText(item.sourceTitle),
    sourceSpec: normalizedText(item.sourceSpec),
    unitPriceCents: item.unitPriceCents,
    quantity: item.quantity,
    quantitySource: item.quantitySource ?? null,
  };
}

function persistedItemSignature(item: RecognitionItem): string {
  return JSON.stringify(comparableItemValue(item));
}

function comparableItemValue(item: RecognitionItem): { [key: string]: OrderChangeValue } {
  return {
    sourceTitle: item.sourceTitle,
    sourceSpec: item.sourceSpec,
    unitPriceCents: item.unitPriceCents,
    quantity: item.quantity,
    quantitySource: item.quantitySource ?? null,
  };
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function canonicalPhone(value: string): string {
  const digits = normalizePhone(value);
  return digits.length === 13 && digits.startsWith('86') ? digits.slice(2) : digits;
}

function canonicalDateTime(normalized: string, original: string): string {
  return normalized.trim() || normalizeShanghaiDateTime(original) || normalizedText(original);
}
