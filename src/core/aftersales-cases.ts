export type AftersalesStatus =
  | 'processing'
  | 'waiting_return'
  | 'waiting_inspection'
  | 'waiting_refund'
  | 'waiting_replacement'
  | 'partially_completed'
  | 'completed';

export type AftersalesCaseItemInput = {
  shipmentPackageItemId: string;
  quantity: number;
};

export type CreateAftersalesCaseInput = {
  shipmentRecordId: string;
  occurredAt: string;
  reason: string;
  items: AftersalesCaseItemInput[];
};

export type UpdateAftersalesCaseInput = {
  caseId: string;
  expectedRevision: number;
  status: AftersalesStatus;
  reason: string;
  items: AftersalesCaseItemInput[];
  changeReason: string;
};

export type AftersalesCaseItem = AftersalesCaseItemInput & {
  id: string;
  packageId: string;
  orderId: string;
  orderItemId: string;
  orderNumber: string;
  sourceTitle: string;
  sourceSpec: string;
  sourceShippedQuantity: number;
};

export type AftersalesCaseSnapshot = {
  status: AftersalesStatus;
  reason: string;
  items: AftersalesCaseItemInput[];
};

export type AftersalesCaseCreatedEvent = {
  kind: 'created';
  resultRevision: 1;
  status: 'processing';
  reason: string;
  occurredAt: string;
  items: AftersalesCaseItemInput[];
  createdAt: string;
};

export type AftersalesCaseUpdatedEvent = {
  kind: 'updated';
  baseRevision: number;
  resultRevision: number;
  changeReason: string;
  before: AftersalesCaseSnapshot;
  after: AftersalesCaseSnapshot;
  createdAt: string;
};

export type AftersalesCaseEvent = AftersalesCaseCreatedEvent | AftersalesCaseUpdatedEvent;

export type AftersalesCase = {
  id: string;
  shipmentRecordId: string;
  status: AftersalesStatus;
  revision: number;
  reason: string;
  occurredAt: string;
  items: AftersalesCaseItem[];
  timeline: AftersalesCaseEvent[];
  createdAt: string;
  updatedAt: string;
};

export type AftersalesCaseQuery = {
  status?: AftersalesStatus;
  shipmentRecordId?: string;
};

export const AFTERSALES_STATUSES = [
  'processing',
  'waiting_return',
  'waiting_inspection',
  'waiting_refund',
  'waiting_replacement',
  'partially_completed',
  'completed',
] as const satisfies readonly AftersalesStatus[];

export function isAftersalesStatus(value: unknown): value is AftersalesStatus {
  return typeof value === 'string' && (
    AFTERSALES_STATUSES as readonly string[]
  ).includes(value);
}

export function normalizeCreateAftersalesCaseInput(input: unknown): CreateAftersalesCaseInput {
  const record = asRecord(input, '新建售后处理单参数无效');
  rejectUnknownKeys(
    record,
    ['shipmentRecordId', 'occurredAt', 'reason', 'items'],
    '新建售后处理单参数',
  );
  return {
    shipmentRecordId: boundedText(record.shipmentRecordId, 200, '发货记录标识无效'),
    occurredAt: dateTime(record.occurredAt, '售后发生时间无效'),
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的问题原因'),
    items: itemInputs(record.items),
  };
}

export function normalizeUpdateAftersalesCaseInput(input: unknown): UpdateAftersalesCaseInput {
  const record = asRecord(input, '更新售后处理单参数无效');
  rejectUnknownKeys(
    record,
    ['caseId', 'expectedRevision', 'status', 'reason', 'items', 'changeReason'],
    '更新售后处理单参数',
  );
  if (!Number.isSafeInteger(record.expectedRevision) || Number(record.expectedRevision) < 1) {
    throw new Error('售后处理单版本无效');
  }
  if (!isAftersalesStatus(record.status)) throw new Error('售后状态无效');
  return {
    caseId: boundedText(record.caseId, 200, '售后处理单标识无效'),
    expectedRevision: Number(record.expectedRevision),
    status: record.status,
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的问题原因'),
    items: itemInputs(record.items),
    changeReason: boundedText(record.changeReason, 500, '请填写 1 至 500 字的变更原因'),
  };
}

export function normalizeAftersalesCaseQuery(input: unknown): AftersalesCaseQuery {
  if (input === undefined) return {};
  const record = asRecord(input, '售后处理单查询参数无效');
  rejectUnknownKeys(record, ['status', 'shipmentRecordId'], '售后处理单查询参数');
  if (record.status !== undefined && !isAftersalesStatus(record.status)) {
    throw new Error('售后状态筛选无效');
  }
  return {
    status: record.status as AftersalesStatus | undefined,
    shipmentRecordId: record.shipmentRecordId === undefined
      ? undefined
      : boundedText(record.shipmentRecordId, 200, '发货记录筛选无效'),
  };
}

function itemInputs(value: unknown): AftersalesCaseItemInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new Error('请至少选择一条售后商品明细');
  }
  const items = value.map((item) => {
    const record = asRecord(item, '售后商品明细无效');
    rejectUnknownKeys(record, ['shipmentPackageItemId', 'quantity'], '售后商品明细');
    if (!Number.isSafeInteger(record.quantity) || Number(record.quantity) <= 0) {
      throw new Error('售后商品数量无效');
    }
    return {
      shipmentPackageItemId: boundedText(
        record.shipmentPackageItemId,
        200,
        '发货快照商品标识无效',
      ),
      quantity: Number(record.quantity),
    };
  });
  if (new Set(items.map(({ shipmentPackageItemId }) => shipmentPackageItemId)).size !== items.length) {
    throw new Error('同一发货快照商品不能重复选择');
  }
  return items;
}

function dateTime(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) throw new Error(message);
  return normalized;
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
