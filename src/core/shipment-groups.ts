import type { OriginalOrder } from './contracts';

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
