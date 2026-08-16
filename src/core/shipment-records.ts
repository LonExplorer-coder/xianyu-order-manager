import type { OpenShipmentGroup, ShipmentGroupProjection } from './shipment-groups';
import {
  isOutboundLogisticsStatus,
  OUTBOUND_LOGISTICS_STATUSES,
  type CarrierClaim,
  type LogisticsExceptionMatter,
  type LogisticsExceptionImpact,
  type LogisticsExceptionStage,
  type LogisticsExceptionType,
  type OutboundLogisticsStatus,
} from './logistics-exceptions';

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
  systemOrderNumber: string;
  readableOrderNumber: string | null;
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
  carrierAcceptedAt: string | null;
  shippingCarrier: string;
  trackingNumber: string;
  revision: number;
  totalQuantity: number;
  items: ShipmentPackageItem[];
  cancellation: ShipmentCancellation | null;
  currentException: ShipmentPackageException | null;
  logisticsExceptions: LogisticsExceptionMatter[];
  carrierClaim: CarrierClaim | null;
  timeline: ShipmentPackageTimelineEvent[];
  createdAt: string;
};

export type ShipmentLogisticsStatus = OutboundLogisticsStatus;

export type ShipmentPackageException = LogisticsExceptionMatter & { direction: 'outbound' };

export type ShipmentPackageLogistics = {
  shippingCarrier: string;
  trackingNumber: string;
};

export type ShipmentPackageLogisticsChange = {
  kind: 'logistics_corrected';
  baseRevision: number;
  resultRevision: number;
  reason: string;
  before: ShipmentPackageLogistics;
  after: ShipmentPackageLogistics;
  occurredAt: string;
  createdAt: string;
};

export type ShipmentPackageLogisticsStatusChange = {
  kind: 'status_changed';
  baseRevision: number;
  resultRevision: number;
  beforeStatus: ShipmentLogisticsStatus;
  afterStatus: ShipmentLogisticsStatus;
  carrierAcceptedAt: string | null;
  reason: string;
  occurredAt: string;
  createdAt: string;
};

export type ShipmentPackageTimelineEvent =
  | ShipmentPackageLogisticsChange
  | ShipmentPackageLogisticsStatusChange;

export type ShipmentCancellation = {
  reason: string;
  createdAt: string;
};

export type ShipmentRecord = {
  id: string;
  sourceRecordRole: 'initial' | 'aftersales_replacement';
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
  occurredAt: string;
  reason: string;
};

export type ShipmentLogisticsCorrectionResult = ShipmentConfirmationResult;

export type UpdateShipmentPackageLogisticsStatusInput = {
  recordId: string;
  packageId: string;
  expectedRevision: number;
  logisticsStatus: ShipmentLogisticsStatus;
  carrierAcceptanceConfirmed?: boolean;
  occurredAt: string;
  reason: string;
};

export type ShipmentLogisticsStatusUpdateResult = ShipmentConfirmationResult;

export type RecordShipmentPackageLogisticsExceptionInput = {
  recordId: string;
  packageId: string;
  expectedRevision: number;
  exceptionType: LogisticsExceptionType;
  stage: Exclude<LogisticsExceptionStage, 'recovered' | 'resolved'>;
  impact: LogisticsExceptionImpact;
  carrierConfirmedLoss?: boolean;
  occurredAt: string;
  reason: string;
};

export type ProgressShipmentPackageLogisticsExceptionInput = {
  recordId: string;
  packageId: string;
  exceptionId: string;
  expectedExceptionRevision: number;
  stage: Exclude<LogisticsExceptionStage, 'pending_verification'>;
  carrierConfirmedLoss?: boolean;
  occurredAt: string;
  reason: string;
};

export type ShipmentLogisticsExceptionResult = ShipmentConfirmationResult;

export type ProgressShipmentPackageCarrierClaimInput =
  | {
    kind: 'open';
    recordId: string;
    packageId: string;
    expectedRevision: number;
    requestedAmountCents: number;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'resolve';
    recordId: string;
    packageId: string;
    expectedClaimRevision: number;
    outcome: 'approved' | 'rejected';
    approvedAmountCents?: number;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'confirm_compensation';
    recordId: string;
    packageId: string;
    expectedClaimRevision: number;
    amountCents: number;
    occurredAt: string;
    note: string;
  };

export type ShipmentCarrierClaimProgressResult = ShipmentConfirmationResult;

export const SHIPMENT_LOGISTICS_STATUSES = OUTBOUND_LOGISTICS_STATUSES;

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
      'occurredAt',
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
    occurredAt: optionalDateTime(record.occurredAt, '包裹物流更正时间无效'),
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的更正原因'),
  };
}

export function normalizeUpdateShipmentPackageLogisticsStatusInput(
  input: unknown,
): UpdateShipmentPackageLogisticsStatusInput {
  const record = asRecord(input, '更新包裹物流状态参数无效');
  rejectUnknownKeys(
    record,
    [
      'recordId', 'packageId', 'expectedRevision', 'logisticsStatus',
      'carrierAcceptanceConfirmed', 'occurredAt', 'reason',
    ],
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
    ...(record.carrierAcceptanceConfirmed === undefined
      ? {}
      : {
        carrierAcceptanceConfirmed: booleanValue(
          record.carrierAcceptanceConfirmed,
          '承运方揽收确认无效',
        ),
      }),
    occurredAt: optionalDateTime(record.occurredAt, '包裹物流状态时间无效'),
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的状态更新原因'),
  };
}

export function normalizeProgressShipmentPackageCarrierClaimInput(
  input: unknown,
): ProgressShipmentPackageCarrierClaimInput {
  const record = asRecord(input, '处理承运索赔参数无效');
  const common = {
    recordId: boundedText(record.recordId, 200, '发货记录标识无效'),
    packageId: boundedText(record.packageId, 200, '包裹标识无效'),
  };
  if (record.kind === 'open') {
    rejectUnknownKeys(record, [
      'kind', 'recordId', 'packageId', 'expectedRevision',
      'requestedAmountCents', 'occurredAt', 'reason',
    ], '建立承运索赔参数');
    return {
      kind: 'open',
      ...common,
      expectedRevision: positiveRevision(record.expectedRevision),
      requestedAmountCents: positiveMoney(record.requestedAmountCents, '索赔金额无效'),
      occurredAt: dateTime(record.occurredAt, '索赔发生时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的索赔原因'),
    };
  }
  if (record.kind === 'resolve') {
    rejectUnknownKeys(record, [
      'kind', 'recordId', 'packageId', 'expectedClaimRevision',
      'outcome', 'approvedAmountCents', 'occurredAt', 'reason',
    ], '登记承运索赔结果参数');
    if (record.outcome !== 'approved' && record.outcome !== 'rejected') {
      throw new Error('承运索赔结果无效');
    }
    if (record.outcome === 'approved' && record.approvedAmountCents === undefined) {
      throw new Error('请填写承运方同意赔付金额');
    }
    if (record.outcome === 'rejected' && record.approvedAmountCents !== undefined) {
      throw new Error('拒赔不能登记同意赔付金额');
    }
    return {
      kind: 'resolve',
      ...common,
      expectedClaimRevision: positiveRevision(record.expectedClaimRevision),
      outcome: record.outcome,
      ...(record.approvedAmountCents === undefined
        ? {}
        : {
          approvedAmountCents: positiveMoney(
            record.approvedAmountCents,
            '承运方同意赔付金额无效',
          ),
        }),
      occurredAt: dateTime(record.occurredAt, '索赔结果时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的索赔结果说明'),
    };
  }
  if (record.kind !== 'confirm_compensation') throw new Error('承运索赔操作无效');
  rejectUnknownKeys(record, [
    'kind', 'recordId', 'packageId', 'expectedClaimRevision',
    'amountCents', 'occurredAt', 'note',
  ], '确认承运赔付参数');
  return {
    kind: 'confirm_compensation',
    ...common,
    expectedClaimRevision: positiveRevision(record.expectedClaimRevision),
    amountCents: positiveMoney(record.amountCents, '实际赔付金额无效'),
    occurredAt: dateTime(record.occurredAt, '实际赔付时间无效'),
    note: boundedText(record.note, 500, '请填写 1 至 500 字的实际赔付说明'),
  };
}

export function normalizeRecordShipmentPackageLogisticsExceptionInput(
  input: unknown,
): RecordShipmentPackageLogisticsExceptionInput {
  const record = asRecord(input, '登记正向物流异常参数无效');
  rejectUnknownKeys(record, [
    'recordId', 'packageId', 'expectedRevision', 'exceptionType', 'stage',
    'impact', 'carrierConfirmedLoss', 'occurredAt', 'reason',
  ], '登记正向物流异常参数');
  if (!isLogisticsExceptionType(record.exceptionType)) throw new Error('物流异常类型无效');
  if (
    record.stage !== 'pending_verification'
    && record.stage !== 'investigating'
    && record.stage !== 'confirmed'
  ) throw new Error('物流异常初始阶段无效');
  return {
    recordId: boundedText(record.recordId, 200, '发货记录标识无效'),
    packageId: boundedText(record.packageId, 200, '包裹标识无效'),
    expectedRevision: positiveRevision(record.expectedRevision),
    exceptionType: record.exceptionType,
    stage: record.stage,
    impact: normalizeLogisticsImpact(record.impact),
    ...(record.carrierConfirmedLoss === undefined ? {} : {
      carrierConfirmedLoss: booleanValue(record.carrierConfirmedLoss, '承运方丢件确认无效'),
    }),
    occurredAt: dateTime(record.occurredAt, '物流异常时间无效'),
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的物流异常说明'),
  };
}

export function normalizeProgressShipmentPackageLogisticsExceptionInput(
  input: unknown,
): ProgressShipmentPackageLogisticsExceptionInput {
  const record = asRecord(input, '推进正向物流异常参数无效');
  rejectUnknownKeys(record, [
    'recordId', 'packageId', 'exceptionId', 'expectedExceptionRevision',
    'stage', 'carrierConfirmedLoss', 'occurredAt', 'reason',
  ], '推进正向物流异常参数');
  if (
    record.stage !== 'investigating'
    && record.stage !== 'confirmed'
    && record.stage !== 'recovered'
    && record.stage !== 'resolved'
  ) throw new Error('物流异常处理阶段无效');
  return {
    recordId: boundedText(record.recordId, 200, '发货记录标识无效'),
    packageId: boundedText(record.packageId, 200, '包裹标识无效'),
    exceptionId: boundedText(record.exceptionId, 200, '物流异常标识无效'),
    expectedExceptionRevision: positiveRevision(record.expectedExceptionRevision),
    stage: record.stage,
    ...(record.carrierConfirmedLoss === undefined ? {} : {
      carrierConfirmedLoss: booleanValue(record.carrierConfirmedLoss, '承运方丢件确认无效'),
    }),
    occurredAt: dateTime(record.occurredAt, '物流异常时间无效'),
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的物流异常处理说明'),
  };
}

export function isShipmentLogisticsStatus(value: unknown): value is ShipmentLogisticsStatus {
  return isOutboundLogisticsStatus(value);
}

function isLogisticsExceptionType(value: unknown): value is LogisticsExceptionType {
  return value === 'lost' || value === 'delivery_dispute' || value === 'damaged'
    || value === 'misdelivered' || value === 'other';
}

function normalizeLogisticsImpact(value: unknown): LogisticsExceptionImpact {
  if (value === undefined) return { scope: 'package' };
  const record = asRecord(value, '物流异常影响范围无效');
  if (record.scope === 'package') {
    rejectUnknownKeys(record, ['scope'], '物流异常影响范围');
    return { scope: 'package' };
  }
  if (record.scope !== 'items') throw new Error('物流异常影响范围无效');
  rejectUnknownKeys(record, ['scope', 'items'], '物流异常影响范围');
  const values = arrayValue(record.items, '请选择受影响商品');
  if (values.length === 0 || values.length > 10_000) throw new Error('请选择受影响商品');
  return {
    scope: 'items',
    items: values.map((value) => {
      const item = asRecord(value, '物流异常商品无效');
      rejectUnknownKeys(item, ['sourceItemId', 'quantity'], '物流异常商品');
      if (!Number.isSafeInteger(item.quantity) || Number(item.quantity) <= 0) {
        throw new Error('物流异常商品数量无效');
      }
      return {
        sourceItemId: boundedText(item.sourceItemId, 200, '物流异常商品标识无效'),
        quantity: Number(item.quantity),
      };
    }),
  };
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

function optionalDateTime(value: unknown, message: string): string {
  return value === undefined ? new Date().toISOString() : dateTime(value, message);
}

function dateTime(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) throw new Error(message);
  return normalized;
}

function booleanValue(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new Error(message);
  return value;
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('版本无效');
  return Number(value);
}

function positiveMoney(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 100_000_000_000) {
    throw new Error(message);
  }
  return Number(value);
}
