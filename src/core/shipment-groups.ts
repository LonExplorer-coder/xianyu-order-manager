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

export type ShipmentGroupIdFactory = (
  phoneNormalized: string,
  addressNormalized: string,
) => string;

export function buildShipmentGroupProjection(
  candidateOrders: readonly OriginalOrder[],
  idFor: ShipmentGroupIdFactory,
): ShipmentGroupProjection {
  const grouped = new Map<string, OriginalOrder[]>();
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
    const matchIdentity = shipmentMatchIdentity(
      order.phoneNormalized,
      order.addressNormalized,
    );
    const orders = grouped.get(matchIdentity) ?? [];
    orders.push(order);
    grouped.set(matchIdentity, orders);
  }

  return {
    groups: [...grouped.values()]
      .map((orders) => openShipmentGroup(orders, idFor))
      .sort((left, right) => (
        left.addressNormalized.localeCompare(right.addressNormalized, 'zh-CN') ||
        left.phoneNormalized.localeCompare(right.phoneNormalized)
      )),
    attentionOrders: attentionOrders.sort((left, right) => (
      left.orderNumber.localeCompare(right.orderNumber) || left.id.localeCompare(right.id)
    )),
  };
}

function shipmentMatchIdentity(phoneNormalized: string, addressNormalized: string): string {
  return `${phoneNormalized.length}:${phoneNormalized}${addressNormalized}`;
}

function openShipmentGroup(
  sourceOrders: readonly OriginalOrder[],
  idFor: ShipmentGroupIdFactory,
): OpenShipmentGroup {
  const orders = [...sourceOrders].sort((left, right) => (
    left.orderNumber.localeCompare(right.orderNumber) || left.id.localeCompare(right.id)
  ));
  const first = orders[0];
  if (!first) throw new Error('发货组至少需要一笔订单');
  const recipients = unique(orders.map(({ recipient }) => recipient));
  const items = aggregateItems(orders);

  return {
    id: idFor(first.phoneNormalized, first.addressNormalized),
    phone: first.phone,
    phoneNormalized: first.phoneNormalized,
    addressOriginal: first.addressOriginal,
    addressNormalized: first.addressNormalized,
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
