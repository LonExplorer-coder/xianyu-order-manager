import type { OpenShipmentGroup, ShipmentGroupProjection } from './shipment-groups';

export type ShipmentItemQuantityInput = {
  orderId: string;
  orderItemId: string;
  quantity: number;
};

export type ConfirmShipmentPackageInput = {
  shippingCarrier: string;
  trackingNumber: string;
  items: ShipmentItemQuantityInput[];
};

export type ConfirmShipmentInput = {
  groupId: string;
  archiveId?: string | null;
  expectedRemainingItems: ShipmentItemQuantityInput[];
  packages: ConfirmShipmentPackageInput[];
};

export type ShipmentPackageItem = ShipmentItemQuantityInput & {
  id: string;
  orderNumber: string;
  sellerAccount: string;
  buyerNickname: string;
  sourceTitle: string;
  sourceSpec: string;
  unitPriceCents: number;
  sourceItemQuantity: number;
  subtotalCents: number;
};

export type ShipmentSourceOrderSnapshot = {
  orderId: string;
  orderNumber: string;
  sellerAccount: string;
  buyerNickname: string;
  recipient: string;
  phone: string;
  addressOriginal: string;
  amountCents: number;
  revision: number;
};

export type ShipmentSourceDifference = {
  orderId: string;
  orderItemId: string | null;
  field: string;
  snapshotValue: string | number | null;
  currentValue: string | number | null;
};

export type ShipmentPackage = {
  id: string;
  position: number;
  status: 'active' | 'cancelled';
  logisticsStatus: ShipmentLogisticsStatus;
  shippingCarrier: string;
  trackingNumber: string;
  revision: number;
  totalQuantity: number;
  items: ShipmentPackageItem[];
  cancellation: ShipmentCancellation | null;
  logisticsChanges: ShipmentPackageLogisticsChange[];
  logisticsStatusChanges: ShipmentPackageLogisticsStatusChange[];
  createdAt: string;
};

export type ShipmentLogisticsStatus =
  | 'awaiting_carrier'
  | 'in_transit'
  | 'delivered'
  | 'intercepting'
  | 'intercepted_returned'
  | 'lost'
  | 'exception';

export type ShipmentPackageLogistics = {
  shippingCarrier: string;
  trackingNumber: string;
};

export type ShipmentPackageLogisticsChange = {
  baseRevision: number;
  resultRevision: number;
  reason: string;
  before: ShipmentPackageLogistics;
  after: ShipmentPackageLogistics;
  createdAt: string;
};

export type ShipmentPackageLogisticsStatusChange = {
  baseRevision: number;
  resultRevision: number;
  beforeStatus: ShipmentLogisticsStatus;
  afterStatus: ShipmentLogisticsStatus;
  reason: string;
  createdAt: string;
};

export type ShipmentCancellation = {
  reason: string;
  createdAt: string;
};

export type ShipmentRecord = {
  id: string;
  archiveId: string;
  sourceGroupId: string;
  status: 'active' | 'voided';
  recipient: string;
  phone: string;
  phoneNormalized: string;
  addressOriginal: string;
  addressNormalized: string;
  totalQuantity: number;
  packages: ShipmentPackage[];
  sourceOrders: ShipmentSourceOrderSnapshot[];
  sourceDifferences: ShipmentSourceDifference[];
  voiding: ShipmentCancellation | null;
  createdAt: string;
};

export type ShipmentGroupArchiveMember = {
  orderId: string;
  orderNumber: string;
  hasRemainingShipment: boolean;
};

export type ShipmentGroupArchiveRecipientDifference = {
  orderId: string;
  orderNumber: string;
  fields: Array<'recipient' | 'phone' | 'address'>;
};

export type ShipmentGroupArchive = {
  id: string;
  sourceGroupId: string;
  status: 'partially_shipped' | 'fully_shipped';
  recipient: string;
  phone: string;
  phoneNormalized: string;
  addressOriginal: string;
  addressNormalized: string;
  orderIds: string[];
  orderNumbers: string[];
  memberOrders: ShipmentGroupArchiveMember[];
  recipientDifferences: ShipmentGroupArchiveRecipientDifference[];
  shippedQuantity: number;
  remainingQuantity: number;
  totalQuantity: number;
  remainingGroup: OpenShipmentGroup | null;
  records: ShipmentRecord[];
  createdAt: string;
  fullyShippedAt: string | null;
};

export type ShipmentConfirmationResult = {
  record: ShipmentRecord;
  archive: ShipmentGroupArchive;
  projection: ShipmentGroupProjection;
};

export type CancelShipmentPackagesInput = {
  recordId: string;
  packageIds: string[];
  reason: string;
};

export type ShipmentCancellationResult = ShipmentConfirmationResult;

export type CorrectShipmentPackageLogisticsInput = ShipmentPackageLogistics & {
  recordId: string;
  packageId: string;
  expectedRevision: number;
  reason: string;
};

export type ShipmentLogisticsCorrectionResult = ShipmentConfirmationResult;

export type UpdateShipmentPackageLogisticsStatusInput = {
  recordId: string;
  packageId: string;
  expectedRevision: number;
  logisticsStatus: ShipmentLogisticsStatus;
  reason: string;
};

export type ShipmentLogisticsStatusUpdateResult = ShipmentConfirmationResult;

export const SHIPMENT_LOGISTICS_STATUSES = [
  'awaiting_carrier',
  'in_transit',
  'delivered',
  'intercepting',
  'intercepted_returned',
  'lost',
  'exception',
] as const satisfies readonly ShipmentLogisticsStatus[];

export function normalizeConfirmShipmentInput(input: unknown): ConfirmShipmentInput {
  const record = asRecord(input, '确认发货参数无效');
  rejectUnknownKeys(
    record,
    ['groupId', 'archiveId', 'expectedRemainingItems', 'packages'],
    '确认发货参数',
  );
  const groupId = boundedText(record.groupId, 200, '发货组标识无效');
  const archiveId = record.archiveId === undefined || record.archiveId === null
    ? null
    : boundedText(record.archiveId, 200, '发货组档案标识无效');
  const expectedRemainingItems = itemQuantities(
    record.expectedRemainingItems,
    '发货组剩余商品快照无效',
  );
  const rawPackages = arrayValue(record.packages, '请至少添加一个包裹');
  if (rawPackages.length === 0) throw new Error('请至少添加一个包裹');
  if (rawPackages.length > 100) throw new Error('一次发货最多包含 100 个包裹');
  const packages = rawPackages.map((value) => {
    const packageRecord = asRecord(value, '包裹信息无效');
    rejectUnknownKeys(
      packageRecord,
      ['shippingCarrier', 'trackingNumber', 'items'],
      '包裹信息',
    );
    return {
      shippingCarrier: optionalText(packageRecord.shippingCarrier, 200, '承运方过长'),
      trackingNumber: optionalText(packageRecord.trackingNumber, 200, '运单号过长'),
      items: itemQuantities(packageRecord.items, '包裹商品明细无效'),
    };
  });
  if (expectedRemainingItems.length === 0) {
    throw new Error('发货组没有可确认的剩余商品');
  }
  if (packages.some((shipmentPackage) => shipmentPackage.items.length === 0)) {
    throw new Error('每个包裹至少需要一条商品明细');
  }
  return { groupId, archiveId, expectedRemainingItems, packages };
}

export function normalizeCancelShipmentPackagesInput(
  input: unknown,
): CancelShipmentPackagesInput {
  const record = asRecord(input, '撤销未交寄包裹参数无效');
  rejectUnknownKeys(record, ['recordId', 'packageIds', 'reason'], '撤销未交寄包裹参数');
  const packageIds = arrayValue(record.packageIds, '请选择要撤销的未交寄包裹').map(
    (value) => boundedText(value, 200, '包裹标识无效'),
  );
  if (packageIds.length === 0 || new Set(packageIds).size !== packageIds.length) {
    throw new Error('请选择不重复的未交寄包裹');
  }
  return {
    recordId: boundedText(record.recordId, 200, '发货记录标识无效'),
    packageIds,
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的撤销原因'),
  };
}

export function normalizeCorrectShipmentPackageLogisticsInput(
  input: unknown,
): CorrectShipmentPackageLogisticsInput {
  const record = asRecord(input, '更正包裹物流参数无效');
  rejectUnknownKeys(
    record,
    [
      'recordId',
      'packageId',
      'expectedRevision',
      'shippingCarrier',
      'trackingNumber',
      'reason',
    ],
    '更正包裹物流参数',
  );
  const expectedRevision = record.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) {
    throw new Error('包裹版本无效');
  }
  return {
    recordId: boundedText(record.recordId, 200, '发货记录标识无效'),
    packageId: boundedText(record.packageId, 200, '包裹标识无效'),
    expectedRevision: Number(expectedRevision),
    shippingCarrier: optionalText(record.shippingCarrier, 200, '承运方过长'),
    trackingNumber: optionalText(record.trackingNumber, 200, '运单号过长'),
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的更正原因'),
  };
}

export function normalizeUpdateShipmentPackageLogisticsStatusInput(
  input: unknown,
): UpdateShipmentPackageLogisticsStatusInput {
  const record = asRecord(input, '更新包裹物流状态参数无效');
  rejectUnknownKeys(
    record,
    ['recordId', 'packageId', 'expectedRevision', 'logisticsStatus', 'reason'],
    '更新包裹物流状态参数',
  );
  const expectedRevision = record.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) {
    throw new Error('包裹版本无效');
  }
  if (!isShipmentLogisticsStatus(record.logisticsStatus)) {
    throw new Error('包裹物流状态无效');
  }
  return {
    recordId: boundedText(record.recordId, 200, '发货记录标识无效'),
    packageId: boundedText(record.packageId, 200, '包裹标识无效'),
    expectedRevision: Number(expectedRevision),
    logisticsStatus: record.logisticsStatus,
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的状态更新原因'),
  };
}

export function isShipmentLogisticsStatus(value: unknown): value is ShipmentLogisticsStatus {
  return typeof value === 'string' && (
    SHIPMENT_LOGISTICS_STATUSES as readonly string[]
  ).includes(value);
}

function itemQuantities(value: unknown, message: string): ShipmentItemQuantityInput[] {
  const values = arrayValue(value, message);
  if (values.length > 10_000) throw new Error(message);
  return values.map((item) => {
    const record = asRecord(item, message);
    rejectUnknownKeys(record, ['orderId', 'orderItemId', 'quantity'], message);
    const quantity = record.quantity;
    if (!Number.isSafeInteger(quantity) || Number(quantity) <= 0) throw new Error(message);
    return {
      orderId: boundedText(record.orderId, 200, message),
      orderItemId: boundedText(record.orderItemId, 200, message),
      quantity: Number(quantity),
    };
  });
}

function arrayValue(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownKey) throw new Error(`${label}包含未知字段：${unknownKey}`);
}

function boundedText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > maximum) throw new Error(message);
  return normalized;
}

function optionalText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length > maximum) throw new Error(message);
  return normalized;
}
