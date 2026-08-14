import type { OriginalOrder } from './contracts';
import type {
  CustomFieldDefinition,
  CustomFieldFilter,
  CustomFieldSort,
  CustomFieldValue,
} from './custom-fields';

export type ShipmentGroupWorkbenchSortField =
  | 'recipient'
  | 'address'
  | 'order_count'
  | 'total_quantity'
  | 'total_amount';

export type ShipmentGroupWorkbenchQuery = {
  text?: string;
  sortField?: ShipmentGroupWorkbenchSortField;
  sortDirection?: 'asc' | 'desc';
  customFieldFilter?: CustomFieldFilter;
  customFieldSort?: CustomFieldSort;
};

export type ShipmentGroupCustomFieldValue = {
  shipmentGroupId: string;
  definitionId: string;
  value: CustomFieldValue | null;
};

export type ShipmentGroupWorkbenchResult = ShipmentGroupProjection & {
  customFieldValues: ShipmentGroupCustomFieldValue[];
  allGroupCount: number;
};

export type ShipmentGroupOrderItem = {
  id: string;
  sourceTitle: string;
  sourceSpec: string;
  unitPriceCents: number;
  quantity: number;
  subtotalCents: number;
};

export type ShipmentGroupOrder = {
  id: string;
  orderNumber: string;
  sellerAccount: string;
  buyerNickname: string;
  recipient: string;
  phone: string;
  phoneNormalized: string;
  addressOriginal: string;
  addressNormalized: string;
  amountCents: number;
  items: ShipmentGroupOrderItem[];
};

export type ShipmentGroupItem = {
  sourceTitle: string;
  sourceSpec: string;
  quantity: number;
  subtotalCents: number;
  unitPricesCents: number[];
  orderIds: string[];
};

export type OpenShipmentGroup = {
  id: string;
  formation: 'automatic' | 'manual';
  selectedRecipientOrderId: string | null;
  recipient: string;
  phone: string;
  phoneNormalized: string;
  addressOriginal: string;
  addressNormalized: string;
  recipients: string[];
  recipientConflict: boolean;
  orderCount: number;
  totalQuantity: number;
  totalAmountCents: number;
  orders: ShipmentGroupOrder[];
  items: ShipmentGroupItem[];
};

export type ShipmentGroupAttentionReason = 'missing_phone' | 'missing_address';

export type ShipmentGroupAttentionOrder = {
  id: string;
  orderNumber: string;
  recipient: string;
  phone: string;
  addressOriginal: string;
  reasons: ShipmentGroupAttentionReason[];
};

export type ShipmentGroupProjection = {
  groups: OpenShipmentGroup[];
  attentionOrders: ShipmentGroupAttentionOrder[];
};

export function buildShipmentGroupWorkbench(
  projection: ShipmentGroupProjection,
  query: ShipmentGroupWorkbenchQuery,
  definitions: readonly CustomFieldDefinition[],
  storedValues: readonly ShipmentGroupCustomFieldValue[],
): ShipmentGroupWorkbenchResult {
  const groupDefinitions = definitions.filter(
    ({ granularity }) => granularity === 'shipment_group',
  );
  const values = effectiveShipmentGroupCustomFieldValues(
    projection.groups,
    groupDefinitions,
    storedValues,
  );
  const valueByOwnerAndDefinition = new Map(values.map((entry) => [
    shipmentGroupCustomFieldValueKey(entry.shipmentGroupId, entry.definitionId),
    entry.value,
  ]));
  const normalizedText = query.text?.normalize('NFKC').trim().toLocaleLowerCase('zh-CN') ?? '';
  const filtered = projection.groups.filter((group) => {
    if (normalizedText && !shipmentGroupSearchText(group).includes(normalizedText)) return false;
    if (!query.customFieldFilter) return true;
    const value = valueByOwnerAndDefinition.get(shipmentGroupCustomFieldValueKey(
      group.id,
      query.customFieldFilter.definitionId,
    ));
    return value !== undefined
      && value !== null
      && sameCustomFieldValue(value, query.customFieldFilter.value);
  });
  const sorted = [...filtered].sort((left, right) => {
    let compared = 0;
    if (query.customFieldSort) {
      compared = compareCustomFieldValues(
        valueByOwnerAndDefinition.get(shipmentGroupCustomFieldValueKey(
          left.id,
          query.customFieldSort.definitionId,
        )),
        valueByOwnerAndDefinition.get(shipmentGroupCustomFieldValueKey(
          right.id,
          query.customFieldSort.definitionId,
        )),
      );
      if (query.customFieldSort.direction === 'desc') compared *= -1;
    } else if (query.sortField) {
      compared = compareShipmentGroupField(left, right, query.sortField);
      if (query.sortDirection === 'desc') compared *= -1;
    }
    return compared || left.id.localeCompare(right.id);
  });
  const visibleIds = new Set(sorted.map(({ id }) => id));
  return {
    groups: sorted,
    attentionOrders: projection.attentionOrders.map((order) => ({
      ...order,
      reasons: [...order.reasons],
    })),
    customFieldValues: values.filter(({ shipmentGroupId }) => visibleIds.has(shipmentGroupId)),
    allGroupCount: projection.groups.length,
  };
}

function effectiveShipmentGroupCustomFieldValues(
  groups: readonly OpenShipmentGroup[],
  definitions: readonly CustomFieldDefinition[],
  storedValues: readonly ShipmentGroupCustomFieldValue[],
): ShipmentGroupCustomFieldValue[] {
  const currentGroupIds = new Set(groups.map(({ id }) => id));
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const valuesByKey = new Map<string, ShipmentGroupCustomFieldValue>();
  for (const entry of storedValues) {
    if (!currentGroupIds.has(entry.shipmentGroupId) || !definitionsById.has(entry.definitionId)) {
      continue;
    }
    valuesByKey.set(
      shipmentGroupCustomFieldValueKey(entry.shipmentGroupId, entry.definitionId),
      structuredClone(entry),
    );
  }
  for (const group of groups) {
    for (const definition of definitions) {
      if (definition.defaultValue === null) continue;
      const key = shipmentGroupCustomFieldValueKey(group.id, definition.id);
      if (valuesByKey.has(key)) continue;
      valuesByKey.set(key, {
        shipmentGroupId: group.id,
        definitionId: definition.id,
        value: structuredClone(definition.defaultValue),
      });
    }
  }
  return [...valuesByKey.values()].sort((left, right) => (
    left.shipmentGroupId.localeCompare(right.shipmentGroupId)
    || left.definitionId.localeCompare(right.definitionId)
  ));
}

function shipmentGroupSearchText(group: OpenShipmentGroup): string {
  return [
    group.id,
    group.recipient,
    group.phone,
    group.addressOriginal,
    ...group.orders.flatMap((order) => [
      order.orderNumber,
      order.sellerAccount,
      order.buyerNickname,
    ]),
    ...group.items.flatMap((item) => [item.sourceTitle, item.sourceSpec]),
  ].join('\n').normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function compareShipmentGroupField(
  left: OpenShipmentGroup,
  right: OpenShipmentGroup,
  field: ShipmentGroupWorkbenchSortField,
): number {
  switch (field) {
    case 'recipient': return left.recipient.localeCompare(right.recipient, 'zh-CN');
    case 'address': return left.addressOriginal.localeCompare(right.addressOriginal, 'zh-CN');
    case 'order_count': return left.orderCount - right.orderCount;
    case 'total_quantity': return left.totalQuantity - right.totalQuantity;
    case 'total_amount': return left.totalAmountCents - right.totalAmountCents;
  }
}

function compareCustomFieldValues(
  left: CustomFieldValue | null | undefined,
  right: CustomFieldValue | null | undefined,
): number {
  if (left === undefined || left === null) return right === undefined || right === null ? 0 : 1;
  if (right === undefined || right === null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return customFieldComparableText(left).localeCompare(customFieldComparableText(right), 'zh-CN');
}

function customFieldComparableText(value: CustomFieldValue): string {
  return Array.isArray(value) ? value.join('\n') : String(value);
}

function sameCustomFieldValue(left: CustomFieldValue, right: CustomFieldValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shipmentGroupCustomFieldValueKey(
  shipmentGroupId: string,
  definitionId: string,
): string {
  return JSON.stringify([shipmentGroupId, definitionId]);
}

export type ShipmentMatchKey = Readonly<{
  phoneNormalized: string;
  addressNormalized: string;
}>;

export type ShipmentGroupIdFactory = (matchKey: ShipmentMatchKey) => string;

export type ManualShipmentGroupDefinition = {
  id: string;
  orderIds: string[];
  selectedRecipientOrder: OriginalOrder | null;
};

export type ShipmentGroupRecipientSnapshot = Pick<
  ShipmentMatchKey,
  'phoneNormalized' | 'addressNormalized'
> & {
  recipient: string;
  phone: string;
  addressOriginal: string;
};

export function shipmentMatchKeyIdentity(matchKey: ShipmentMatchKey): string {
  return JSON.stringify([
    matchKey.phoneNormalized,
    matchKey.addressNormalized,
  ]);
}

export function shipmentGroupsRequireFinalRecipient(
  groups: readonly OpenShipmentGroup[],
): boolean {
  return new Set(groups.map((group) => shipmentMatchKeyIdentity(group))).size > 1;
}

export function buildFixedMemberShipmentGroup(
  candidateOrders: readonly OriginalOrder[],
  id: string,
  recipientSnapshot: ShipmentGroupRecipientSnapshot,
): OpenShipmentGroup | null {
  if (candidateOrders.length === 0) return null;
  const group = openShipmentGroup(candidateOrders, id, 'automatic', null);
  return {
    ...group,
    selectedRecipientOrderId: null,
    recipient: recipientSnapshot.recipient,
    phone: recipientSnapshot.phone,
    phoneNormalized: recipientSnapshot.phoneNormalized,
    addressOriginal: recipientSnapshot.addressOriginal,
    addressNormalized: recipientSnapshot.addressNormalized,
  };
}

export function buildShipmentGroupProjection(
  candidateOrders: readonly OriginalOrder[],
  idFor: ShipmentGroupIdFactory,
  manualGroups: readonly ManualShipmentGroupDefinition[] = [],
): ShipmentGroupProjection {
  const candidateOrdersById = new Map(candidateOrders.map((order) => [order.id, order]));
  const manuallyAssignedOrderIds = new Set(
    manualGroups.flatMap(({ orderIds }) => orderIds),
  );
  const grouped = new Map<string, {
    matchKey: ShipmentMatchKey;
    orders: OriginalOrder[];
  }>();
  const attentionOrders: ShipmentGroupAttentionOrder[] = [];
  for (const order of candidateOrders) {
    const reasons: ShipmentGroupAttentionReason[] = [];
    if (!order.phoneNormalized.trim()) reasons.push('missing_phone');
    if (!order.addressNormalized.trim()) reasons.push('missing_address');
    if (reasons.length > 0) {
      attentionOrders.push({
        id: order.id,
        orderNumber: order.orderNumber,
        recipient: order.recipient,
        phone: order.phone,
        addressOriginal: order.addressOriginal,
        reasons,
      });
      continue;
    }
    if (manuallyAssignedOrderIds.has(order.id)) continue;
    const matchKey: ShipmentMatchKey = {
      phoneNormalized: order.phoneNormalized,
      addressNormalized: order.addressNormalized,
    };
    const matchIdentity = shipmentMatchKeyIdentity(matchKey);
    const group = grouped.get(matchIdentity) ?? { matchKey, orders: [] };
    group.orders.push(order);
    grouped.set(matchIdentity, group);
  }

  return {
    groups: [
      ...manualGroups.flatMap((manualGroup) => {
        const orders = manualGroup.orderIds
          .map((orderId) => candidateOrdersById.get(orderId))
          .filter((order): order is OriginalOrder => (
            order !== undefined && isShipmentGroupableOrder(order)
          ));
        return orders.length > 0
          ? [openShipmentGroup(
            orders,
            manualGroup.id,
            'manual',
            manualGroup.selectedRecipientOrder,
          )]
          : [];
      }),
      ...[...grouped.values()].map(({ matchKey, orders }) => openShipmentGroup(
        orders,
        idFor(matchKey),
        'automatic',
        null,
      )),
    ].sort((left, right) => (
        left.addressNormalized.localeCompare(right.addressNormalized, 'zh-CN') ||
        left.phoneNormalized.localeCompare(right.phoneNormalized) ||
        left.id.localeCompare(right.id)
      )),
    attentionOrders: attentionOrders.sort((left, right) => (
      left.orderNumber.localeCompare(right.orderNumber) || left.id.localeCompare(right.id)
    )),
  };
}

function openShipmentGroup(
  sourceOrders: readonly OriginalOrder[],
  id: string,
  formation: OpenShipmentGroup['formation'],
  selectedRecipientOrder: OriginalOrder | null,
): OpenShipmentGroup {
  const orders = [...sourceOrders].sort((left, right) => (
    left.orderNumber.localeCompare(right.orderNumber) || left.id.localeCompare(right.id)
  ));
  const first = orders[0];
  if (!first) throw new Error('发货组至少需要一笔订单');
  const recipientSource = selectedRecipientOrder ?? first;
  const recipients = unique(orders.map(({ recipient }) => recipient));
  const items = aggregateItems(orders);

  return {
    id,
    formation,
    selectedRecipientOrderId: selectedRecipientOrder?.id ?? null,
    recipient: recipientSource.recipient,
    phone: recipientSource.phone,
    phoneNormalized: recipientSource.phoneNormalized,
    addressOriginal: recipientSource.addressOriginal,
    addressNormalized: recipientSource.addressNormalized,
    recipients,
    recipientConflict: recipients.length > 1,
    orderCount: orders.length,
    totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
    totalAmountCents: orders.reduce((total, order) => total + order.amountCents, 0),
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      sellerAccount: order.sellerAccount,
      buyerNickname: order.buyerNickname,
      recipient: order.recipient,
      phone: order.phone,
      phoneNormalized: order.phoneNormalized,
      addressOriginal: order.addressOriginal,
      addressNormalized: order.addressNormalized,
      amountCents: order.amountCents,
      items: order.items.map((item) => ({
        id: item.id,
        sourceTitle: item.sourceTitle,
        sourceSpec: item.sourceSpec,
        unitPriceCents: item.unitPriceCents,
        quantity: item.quantity,
        subtotalCents: item.subtotalCents,
      })),
    })),
    items,
  };
}

function aggregateItems(orders: readonly OriginalOrder[]): ShipmentGroupItem[] {
  const summaries = new Map<string, ShipmentGroupItem>();
  for (const order of orders) {
    for (const item of order.items) {
      const sourceTitle = item.sourceTitle.normalize('NFKC').trim();
      const sourceSpec = item.sourceSpec.normalize('NFKC').trim();
      const identity = `${sourceTitle.length}:${sourceTitle}${sourceSpec}`;
      const existing = summaries.get(identity);
      if (existing) {
        existing.quantity += item.quantity;
        existing.subtotalCents += item.subtotalCents;
        if (!existing.unitPricesCents.includes(item.unitPriceCents)) {
          existing.unitPricesCents.push(item.unitPriceCents);
          existing.unitPricesCents.sort((left, right) => left - right);
        }
        if (!existing.orderIds.includes(order.id)) existing.orderIds.push(order.id);
        continue;
      }
      summaries.set(identity, {
        sourceTitle,
        sourceSpec,
        quantity: item.quantity,
        subtotalCents: item.subtotalCents,
        unitPricesCents: [item.unitPriceCents],
        orderIds: [order.id],
      });
    }
  }
  return [...summaries.values()].sort((left, right) => (
    left.sourceTitle.localeCompare(right.sourceTitle, 'zh-CN') ||
    left.sourceSpec.localeCompare(right.sourceSpec, 'zh-CN')
  ));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isShipmentGroupableOrder(order: OriginalOrder): boolean {
  return Boolean(order.phoneNormalized.trim() && order.addressNormalized.trim());
}
