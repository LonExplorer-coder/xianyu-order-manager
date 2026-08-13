export type AftersalesStatus =
  | 'processing'
  | 'waiting_return'
  | 'waiting_inspection'
  | 'waiting_refund'
  | 'waiting_replacement'
  | 'partially_completed'
  | 'ready_to_complete'
  | 'completed'
  | 'cancelled';

export type AftersalesWorkflow = 'general' | 'refund_only' | 'return_refund';

export type PendingFinancialItemStatus = 'pending' | 'confirmed' | 'cancelled';

export type AftersalesReturnStatus = 'in_transit' | 'received' | 'inspected';

export type ReturnInspectionResult = 'resellable' | 'defective' | 'scrapped' | 'other';

export type AftersalesRefund = {
  pendingItemId: string;
  requestedAmountCents: number;
  status: PendingFinancialItemStatus;
  actualRecord: AftersalesRefundFinancialRecord | null;
  createdAt: string;
};

export type AftersalesRefundFinancialRecord = {
  id: string;
  kind: 'aftersales_refund';
  amountCents: number;
  occurredAt: string;
  note: string;
  createdAt: string;
};

export type AftersalesReturnItem = AftersalesCaseItemInput & {
  id: string;
  orderId: string;
  orderItemId: string;
  orderNumber: string;
  sourceTitle: string;
  sourceSpec: string;
};

export type AftersalesReturnEvent =
  | {
    kind: 'registered';
    resultRevision: 1;
    occurredAt: string;
    reason: string;
    createdAt: string;
  }
  | {
    kind: 'received';
    baseRevision: number;
    resultRevision: number;
    occurredAt: string;
    reason: string;
    createdAt: string;
  }
  | {
    kind: 'inspected';
    baseRevision: number;
    resultRevision: number;
    occurredAt: string;
    result: ReturnInspectionResult;
    note: string;
    createdAt: string;
  };

export type AftersalesReturnRecord = {
  id: string;
  status: AftersalesReturnStatus;
  revision: number;
  shippingCarrier: string;
  trackingNumber: string;
  occurredAt: string;
  receivedAt: string | null;
  inspection: {
    result: ReturnInspectionResult;
    occurredAt: string;
    note: string;
  } | null;
  items: AftersalesReturnItem[];
  timeline: AftersalesReturnEvent[];
  createdAt: string;
  updatedAt: string;
};

export type ProgressAftersalesCaseInput =
  | {
    kind: 'register_return';
    caseId: string;
    expectedRevision: number;
    shippingCarrier: string;
    trackingNumber: string;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'receive_return';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    occurredAt: string;
    reason: string;
  }
  | {
    kind: 'inspect_return';
    caseId: string;
    expectedRevision: number;
    returnRecordId: string;
    result: ReturnInspectionResult;
    occurredAt: string;
    note: string;
  }
  | {
    kind: 'confirm_refund';
    caseId: string;
    expectedRevision: number;
    actualRefundCents: number;
    occurredAt: string;
    note: string;
  }
  | {
    kind: 'complete';
    caseId: string;
    expectedRevision: number;
    reason: string;
  }
  | {
    kind: 'cancel';
    caseId: string;
    expectedRevision: number;
    reason: string;
  };

export type AftersalesCaseItemInput = {
  shipmentPackageItemId: string;
  quantity: number;
};

export type CreateAftersalesCaseInput = {
  shipmentRecordId: string;
  workflow?: AftersalesWorkflow;
  occurredAt: string;
  reason: string;
  requestedRefundCents?: number;
  items: AftersalesCaseItemInput[];
};

export type NormalizedCreateAftersalesCaseInput = Omit<
  CreateAftersalesCaseInput,
  'workflow'
> & {
  workflow: AftersalesWorkflow;
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
  status: AftersalesStatus;
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
  workflow: AftersalesWorkflow;
  status: AftersalesStatus;
  revision: number;
  reason: string;
  occurredAt: string;
  items: AftersalesCaseItem[];
  refund: AftersalesRefund | null;
  returns: AftersalesReturnRecord[];
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
  'ready_to_complete',
  'completed',
  'cancelled',
] as const satisfies readonly AftersalesStatus[];

export const AFTERSALES_WORKFLOWS = [
  'general',
  'refund_only',
  'return_refund',
] as const satisfies readonly AftersalesWorkflow[];

export function isAftersalesStatus(value: unknown): value is AftersalesStatus {
  return typeof value === 'string' && (
    AFTERSALES_STATUSES as readonly string[]
  ).includes(value);
}

export function isAftersalesWorkflow(value: unknown): value is AftersalesWorkflow {
  return typeof value === 'string' && (
    AFTERSALES_WORKFLOWS as readonly string[]
  ).includes(value);
}

export function normalizeCreateAftersalesCaseInput(
  input: unknown,
): NormalizedCreateAftersalesCaseInput {
  const record = asRecord(input, '新建售后处理单参数无效');
  rejectUnknownKeys(
    record,
    [
      'shipmentRecordId',
      'workflow',
      'occurredAt',
      'reason',
      'requestedRefundCents',
      'items',
    ],
    '新建售后处理单参数',
  );
  const workflow = record.workflow ?? 'general';
  if (!isAftersalesWorkflow(workflow)) throw new Error('售后处理方式无效');
  if (workflow === 'general' && record.requestedRefundCents !== undefined) {
    throw new Error('一般处理不能登记申请退款金额');
  }
  const requestedRefundCents = workflow === 'general'
    ? undefined
    : money(record.requestedRefundCents, false);
  return {
    shipmentRecordId: boundedText(record.shipmentRecordId, 200, '发货记录标识无效'),
    workflow,
    occurredAt: dateTime(record.occurredAt, '售后发生时间无效'),
    reason: boundedText(record.reason, 500, '请填写 1 至 500 字的问题原因'),
    ...(requestedRefundCents === undefined ? {} : { requestedRefundCents }),
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

export function normalizeProgressAftersalesCaseInput(
  input: unknown,
): ProgressAftersalesCaseInput {
  const record = asRecord(input, '推进售后处理参数无效');
  const common = {
    caseId: boundedText(record.caseId, 200, '售后处理单标识无效'),
    expectedRevision: revision(record.expectedRevision),
  };
  if (record.kind === 'register_return') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'shippingCarrier',
        'trackingNumber', 'occurredAt', 'reason',
      ],
      '登记退货物流参数',
    );
    return {
      kind: 'register_return',
      ...common,
      shippingCarrier: boundedText(record.shippingCarrier, 100, '退货承运方无效'),
      trackingNumber: boundedText(record.trackingNumber, 200, '退货运单号无效'),
      occurredAt: dateTime(record.occurredAt, '退货寄出时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的退货登记说明'),
    };
  }
  if (record.kind === 'receive_return') {
    rejectUnknownKeys(
      record,
      ['kind', 'caseId', 'expectedRevision', 'returnRecordId', 'occurredAt', 'reason'],
      '确认收到退货参数',
    );
    return {
      kind: 'receive_return',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货记录标识无效'),
      occurredAt: dateTime(record.occurredAt, '退货收到时间无效'),
      reason: boundedText(record.reason, 500, '请填写 1 至 500 字的退货收到说明'),
    };
  }
  if (record.kind === 'inspect_return') {
    rejectUnknownKeys(
      record,
      [
        'kind', 'caseId', 'expectedRevision', 'returnRecordId',
        'result', 'occurredAt', 'note',
      ],
      '记录退货检查参数',
    );
    if (!isReturnInspectionResult(record.result)) throw new Error('退货检查结果无效');
    return {
      kind: 'inspect_return',
      ...common,
      returnRecordId: boundedText(record.returnRecordId, 200, '退货记录标识无效'),
      result: record.result,
      occurredAt: dateTime(record.occurredAt, '退货检查时间无效'),
      note: boundedText(record.note, 500, '请填写 1 至 500 字的退货检查说明'),
    };
  }
  if (record.kind === 'confirm_refund') {
    rejectUnknownKeys(
      record,
      ['kind', 'caseId', 'expectedRevision', 'actualRefundCents', 'occurredAt', 'note'],
      '确认实际退款参数',
    );
    return {
      kind: 'confirm_refund',
      ...common,
      actualRefundCents: money(record.actualRefundCents, false) as number,
      occurredAt: dateTime(record.occurredAt, '实际退款时间无效'),
      note: boundedText(record.note, 500, '请填写 1 至 500 字的退款确认说明'),
    };
  }
  if (record.kind === 'complete' || record.kind === 'cancel') {
    rejectUnknownKeys(
      record,
      ['kind', 'caseId', 'expectedRevision', 'reason'],
      record.kind === 'complete' ? '完成售后处理参数' : '取消售后处理参数',
    );
    return {
      kind: record.kind,
      ...common,
      reason: boundedText(
        record.reason,
        500,
        record.kind === 'complete'
          ? '请填写 1 至 500 字的完成原因'
          : '请填写 1 至 500 字的取消原因',
      ),
    };
  }
  throw new Error('售后处理动作无效');
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

function money(value: unknown, optional: boolean): number | undefined {
  if (value === undefined && optional) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 100_000_000_000) {
    throw new Error('申请退款金额无效');
  }
  return Number(value);
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error('售后处理单版本无效');
  }
  return Number(value);
}

function isReturnInspectionResult(value: unknown): value is ReturnInspectionResult {
  return value === 'resellable' || value === 'defective' || value === 'scrapped' || value === 'other';
}
