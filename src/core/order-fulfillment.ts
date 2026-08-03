import type {
  OrderFieldChange,
  OrderStatusAndLogisticsPatch,
  OrderStatusAndLogisticsTarget,
  OrderStatusAndLogisticsUpdateInput,
  OriginalOrder,
} from './contracts';

export type PreparedOrderStatusAndLogisticsUpdate = {
  input: OrderStatusAndLogisticsUpdateInput;
};

export function prepareOrderStatusAndLogisticsUpdate(
  input: unknown,
): PreparedOrderStatusAndLogisticsUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('订单状态与物流修改格式无效');
  }
  const record = input as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => (
    key !== 'targets' && key !== 'patch'
  ));
  if (unknownKey) {
    throw new Error(`订单状态与物流修改包含未知字段：${unknownKey}`);
  }
  if (!Array.isArray(record.targets)) {
    throw new Error('订单状态与物流修改目标格式无效');
  }
  if (record.targets.length === 0) {
    throw new Error('订单状态与物流修改至少需要一笔目标订单');
  }
  if (record.targets.length > 200) {
    throw new Error('订单状态与物流修改每批最多处理 200 笔订单');
  }
  if (!record.patch || typeof record.patch !== 'object' || Array.isArray(record.patch)) {
    throw new Error('订单状态与物流修改内容格式无效');
  }
  const targets = record.targets.map((target, index) => normalizeTarget(target, index));
  if (new Set(targets.map((target) => target.orderId)).size !== targets.length) {
    throw new Error('订单状态与物流修改目标不能重复');
  }
  const patch = normalizePatch(record.patch as Record<string, unknown>);
  return {
    input: {
      targets,
      patch,
    },
  };
}

function normalizePatch(record: Record<string, unknown>): OrderStatusAndLogisticsPatch {
  const allowedKeys = new Set([
    'platformTransactionStatus',
    'fulfillmentStatus',
    'shippingCarrier',
    'trackingNumber',
  ]);
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(`订单状态与物流修改内容包含未知字段：${unknownKey}`);
  }
  if (Object.keys(record).length === 0) {
    throw new Error('订单状态与物流修改至少需要一个修改字段');
  }
  const patch: OrderStatusAndLogisticsPatch = {};
  if (Object.hasOwn(record, 'platformTransactionStatus')) {
    const value = record.platformTransactionStatus;
    if (value !== 'paid' && value !== 'cancelled' && value !== 'refunded' && value !== 'unknown') {
      throw new Error('平台交易状态格式无效');
    }
    patch.platformTransactionStatus = value;
  }
  if (Object.hasOwn(record, 'fulfillmentStatus')) {
    const value = record.fulfillmentStatus;
    if (
      value !== 'pending_shipment' &&
      value !== 'shipped' &&
      value !== 'delivered' &&
      value !== 'returned' &&
      value !== 'unknown'
    ) {
      throw new Error('履约状态格式无效');
    }
    patch.fulfillmentStatus = value;
  }
  if (Object.hasOwn(record, 'shippingCarrier')) {
    patch.shippingCarrier = normalizedText(record.shippingCarrier, '快递公司');
  }
  if (Object.hasOwn(record, 'trackingNumber')) {
    patch.trackingNumber = normalizedText(record.trackingNumber, '运单号');
  }
  return patch;
}

function normalizedText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length > 200) throw new Error(`${label}格式无效`);
  return normalized;
}

function normalizeTarget(value: unknown, index: number): OrderStatusAndLogisticsTarget {
  const label = `目标订单 ${index + 1}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => (
    key !== 'orderId' && key !== 'expectedRevision'
  ));
  if (unknownKey) throw new Error(`${label} 包含未知字段：${unknownKey}`);
  for (const key of ['orderId', 'expectedRevision'] as const) {
    if (!Object.hasOwn(record, key)) throw new Error(`${label} 缺少字段：${key}`);
  }
  if (typeof record.orderId !== 'string') throw new Error(`${label} 的订单标识格式无效`);
  const orderId = record.orderId.normalize('NFKC').trim();
  if (!orderId || orderId.length > 200) throw new Error(`${label} 的订单标识格式无效`);
  if (!Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 1) {
    throw new Error(`${label} 的订单版本格式无效`);
  }
  return { orderId, expectedRevision: record.expectedRevision as number };
}

export function resolveOrderStatusAndLogisticsPatch(
  current: OriginalOrder,
  patch: OrderStatusAndLogisticsPatch,
): OrderStatusAndLogisticsPatch {
  const resolved = { ...patch };
  const fulfillmentStatus = patch.fulfillmentStatus ?? current.fulfillmentStatus;
  const trackingNumber = Object.hasOwn(patch, 'trackingNumber')
    ? patch.trackingNumber ?? current.trackingNumber
    : current.trackingNumber;

  if (fulfillmentStatus === 'pending_shipment' && trackingNumber) {
    resolved.fulfillmentStatus = 'shipped';
  } else if (fulfillmentStatus === 'shipped' && !trackingNumber) {
    resolved.fulfillmentStatus = 'pending_shipment';
  }
  return resolved;
}

export function diffOrderStatusAndLogistics(
  current: OriginalOrder,
  patch: OrderStatusAndLogisticsPatch,
): OrderFieldChange[] {
  const changes: OrderFieldChange[] = [];
  for (const field of [
    'platformTransactionStatus',
    'fulfillmentStatus',
    'shippingCarrier',
    'trackingNumber',
  ] as const) {
    if (!Object.hasOwn(patch, field)) continue;
    const after = patch[field];
    if (after === undefined || current[field] === after) continue;
    changes.push({ path: field, before: current[field], after });
  }
  return changes;
}
