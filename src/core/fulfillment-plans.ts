import type { ShipmentLogisticsStatus } from './shipment-records';

export type FulfillmentPlanType = 'presale' | 'group_buy';

export type FulfillmentPlanStatus =
  | 'pending'
  | 'partially_released'
  | 'released'
  | 'delayed'
  | 'closed';

export type FulfillmentPlanDisplayStatus = FulfillmentPlanStatus | 'ready';

export type FulfillmentPlanEventType =
  | 'created'
  | 'orders_added'
  | 'order_removed'
  | 'orders_released'
  | 'updated'
  | 'delayed'
  | 'closed';

export type FulfillmentPlanMemberView = {
  orderId: string;
  systemOrderNumber: string;
  platformOrderNumber: string;
  buyerNickname: string;
  joinedAt: string;
  joinReason: string;
  releasedAt: string | null;
  releasedReason: string | null;
  removedAt: string | null;
  removedReason: string | null;
  items: Array<{
    itemId: string;
    sourceTitle: string;
    sourceSpec: string;
    quantity: number;
  }>;
};

export type FulfillmentPlanEventView = {
  id: string;
  planId: string;
  orderId: string | null;
  eventType: FulfillmentPlanEventType;
  reason: string;
  orderIds: string[];
  occurredAt: string;
  createdAt: string;
};

export type FulfillmentPlanView = {
  id: string;
  type: FulfillmentPlanType;
  name: string;
  status: FulfillmentPlanStatus;
  expectedShipAt: string | null;
  targetQuantity: number | null;
  deadlineAt: string | null;
  demandAlertThreshold: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  members: FulfillmentPlanMemberView[];
  events: FulfillmentPlanEventView[];
  activeOrderCount: number;
  activeItemQuantity: number;
  releasedOrderCount: number;
};

export type FulfillmentPlanQuery = {
  type?: FulfillmentPlanType;
  status?: FulfillmentPlanStatus;
};

export type FulfillmentPlanProgressPackage = {
  id: string;
  shippingCarrier: string;
  trackingNumber: string;
  logisticsStatus: ShipmentLogisticsStatus;
  items: Array<{
    sourceTitle: string;
    sourceSpec: string;
    quantity: number;
  }>;
};

export type FulfillmentPlanProgressShipment = {
  recordId: string;
  createdAt: string;
  packages: FulfillmentPlanProgressPackage[];
};

export type FulfillmentPlanProgressOrder = {
  orderId: string;
  systemOrderNumber: string;
  buyerNickname: string;
  items: Array<{
    sourceTitle: string;
    sourceSpec: string;
    quantity: number;
  }>;
  releasedAt: string;
  releasedReason: string;
  shipments: FulfillmentPlanProgressShipment[];
};

export type FulfillmentPlanProgressView = {
  planId: string;
  orders: FulfillmentPlanProgressOrder[];
};

export type CreateFulfillmentPlanInput = {
  type: FulfillmentPlanType;
  name: string;
  expectedShipAt: string | null;
  targetQuantity: number | null;
  deadlineAt: string | null;
  demandAlertThreshold: number | null;
  reason: string;
};

export type AddFulfillmentPlanOrdersInput = {
  planId: string;
  expectedRevision: number;
  orderIds: string[];
  reason: string;
};

export type RemoveFulfillmentPlanOrderInput = {
  planId: string;
  expectedRevision: number;
  orderId: string;
  reason: string;
};

export type ReleaseFulfillmentPlanOrdersInput = {
  planId: string;
  expectedRevision: number;
  orderIds: string[] | null;
  reason: string;
};

export type UpdateFulfillmentPlanInput = {
  planId: string;
  expectedRevision: number;
  name: string | null;
  expectedShipAt: string | null;
  targetQuantity: number | null;
  deadlineAt: string | null;
  demandAlertThreshold: number | null;
  markDelayed: boolean;
  reason: string;
};

export type CloseFulfillmentPlanInput = {
  planId: string;
  expectedRevision: number;
  reason: string;
};

export function isFulfillmentPlanType(value: unknown): value is FulfillmentPlanType {
  return value === 'presale' || value === 'group_buy';
}

export function isFulfillmentPlanStatus(value: unknown): value is FulfillmentPlanStatus {
  return typeof value === 'string' && [
    'pending',
    'partially_released',
    'released',
    'delayed',
    'closed',
  ].includes(value);
}

export function normalizeFulfillmentPlanQuery(input: unknown): FulfillmentPlanQuery {
  if (input === undefined || input === null) return {};
  const record = objectValue(input, '履约计划查询参数无效');
  rejectUnknownKeys(record, ['type', 'status'], '履约计划查询参数无效');
  const query: FulfillmentPlanQuery = {};
  if (record.type !== undefined) {
    if (!isFulfillmentPlanType(record.type)) throw new Error('履约计划类型无效');
    query.type = record.type;
  }
  if (record.status !== undefined) {
    if (!isFulfillmentPlanStatus(record.status)) throw new Error('履约计划状态无效');
    query.status = record.status;
  }
  return query;
}

export function normalizeFulfillmentPlanId(input: unknown): string {
  return planId(input);
}

export function normalizeCreateFulfillmentPlanInput(
  input: unknown,
): CreateFulfillmentPlanInput {
  const record = objectValue(input, '创建履约计划参数无效');
  rejectUnknownKeys(record, [
    'type',
    'name',
    'expectedShipAt',
    'targetQuantity',
    'deadlineAt',
    'demandAlertThreshold',
    'reason',
  ], '创建履约计划参数无效');
  if (!isFulfillmentPlanType(record.type)) throw new Error('履约计划类型无效');
  const expectedShipAt = optionalTime(record.expectedShipAt, '预计发货时间无效');
  const targetQuantity = optionalTargetQuantity(record.targetQuantity);
  const deadlineAt = optionalTime(record.deadlineAt, '团购截止时间无效');
  const demandAlertThreshold = optionalAlertThreshold(record.demandAlertThreshold);
  if (record.type === 'presale' && expectedShipAt === null) {
    throw new Error('预售计划需要预计发货时间');
  }
  if (record.type === 'group_buy' && targetQuantity === null && deadlineAt === null) {
    throw new Error('团购计划需要成团数量或截止时间');
  }
  return {
    type: record.type,
    name: boundedText(record.name, 100, '请填写 1 至 100 字的履约计划名称'),
    expectedShipAt,
    targetQuantity,
    deadlineAt,
    demandAlertThreshold,
    reason: requiredReason(record.reason),
  };
}

export function normalizeAddFulfillmentPlanOrdersInput(
  input: unknown,
): AddFulfillmentPlanOrdersInput {
  const record = objectValue(input, '加入履约计划参数无效');
  rejectUnknownKeys(
    record,
    ['planId', 'expectedRevision', 'orderIds', 'reason'],
    '加入履约计划参数无效',
  );
  const orderIds = orderIdList(record.orderIds, '请选择要加入的订单');
  if (orderIds.length === 0) throw new Error('请选择要加入的订单');
  return {
    planId: planId(record.planId),
    expectedRevision: expectedRevision(record.expectedRevision),
    orderIds,
    reason: requiredReason(record.reason),
  };
}

export function normalizeRemoveFulfillmentPlanOrderInput(
  input: unknown,
): RemoveFulfillmentPlanOrderInput {
  const record = objectValue(input, '退出履约计划参数无效');
  rejectUnknownKeys(
    record,
    ['planId', 'expectedRevision', 'orderId', 'reason'],
    '退出履约计划参数无效',
  );
  return {
    planId: planId(record.planId),
    expectedRevision: expectedRevision(record.expectedRevision),
    orderId: orderId(record.orderId),
    reason: requiredReason(record.reason),
  };
}

export function normalizeReleaseFulfillmentPlanOrdersInput(
  input: unknown,
): ReleaseFulfillmentPlanOrdersInput {
  const record = objectValue(input, '释放履约计划参数无效');
  rejectUnknownKeys(
    record,
    ['planId', 'expectedRevision', 'orderIds', 'reason'],
    '释放履约计划参数无效',
  );
  const orderIds = record.orderIds === undefined || record.orderIds === null
    ? null
    : orderIdList(record.orderIds, '请选择要释放的订单');
  if (orderIds !== null && orderIds.length === 0) throw new Error('请选择要释放的订单');
  return {
    planId: planId(record.planId),
    expectedRevision: expectedRevision(record.expectedRevision),
    orderIds,
    reason: requiredReason(record.reason),
  };
}

export function normalizeUpdateFulfillmentPlanInput(
  input: unknown,
): UpdateFulfillmentPlanInput {
  const record = objectValue(input, '更新履约计划参数无效');
  rejectUnknownKeys(record, [
    'planId',
    'expectedRevision',
    'name',
    'expectedShipAt',
    'targetQuantity',
    'deadlineAt',
    'demandAlertThreshold',
    'markDelayed',
    'reason',
  ], '更新履约计划参数无效');
  const name = record.name === undefined || record.name === null
    ? null
    : boundedText(record.name, 100, '请填写 1 至 100 字的履约计划名称');
  const expectedShipAt = record.expectedShipAt === undefined
    ? null
    : optionalTime(record.expectedShipAt, '预计发货时间无效');
  const targetQuantity = record.targetQuantity === undefined
    ? null
    : optionalTargetQuantity(record.targetQuantity);
  const deadlineAt = record.deadlineAt === undefined
    ? null
    : optionalTime(record.deadlineAt, '团购截止时间无效');
  const demandAlertThreshold = record.demandAlertThreshold === undefined
    ? null
    : optionalAlertThreshold(record.demandAlertThreshold);
  const markDelayed = record.markDelayed === true;
  if (name === null && expectedShipAt === null && targetQuantity === null
    && deadlineAt === null && demandAlertThreshold === null && !markDelayed) {
    throw new Error('没有需要更新的履约计划内容');
  }
  return {
    planId: planId(record.planId),
    expectedRevision: expectedRevision(record.expectedRevision),
    name,
    expectedShipAt,
    targetQuantity,
    deadlineAt,
    demandAlertThreshold,
    markDelayed,
    reason: requiredReason(record.reason),
  };
}

export function normalizeCloseFulfillmentPlanInput(input: unknown): CloseFulfillmentPlanInput {
  const record = objectValue(input, '关闭履约计划参数无效');
  rejectUnknownKeys(
    record,
    ['planId', 'expectedRevision', 'reason'],
    '关闭履约计划参数无效',
  );
  return {
    planId: planId(record.planId),
    expectedRevision: expectedRevision(record.expectedRevision),
    reason: requiredReason(record.reason),
  };
}

export function isFulfillmentPlanReleaseReady(
  plan: Pick<
    FulfillmentPlanView,
    'type' | 'status' | 'expectedShipAt' | 'targetQuantity' | 'deadlineAt'
  >,
  activeItemQuantity: number,
  now: string,
): boolean {
  if (plan.status !== 'pending' && plan.status !== 'delayed'
    && plan.status !== 'partially_released') {
    return false;
  }
  if (plan.type === 'presale') {
    return plan.expectedShipAt !== null && now >= plan.expectedShipAt;
  }
  return (plan.targetQuantity !== null && activeItemQuantity >= plan.targetQuantity)
    || (plan.deadlineAt !== null && now >= plan.deadlineAt);
}

export function fulfillmentPlanDisplayStatus(
  plan: Pick<
    FulfillmentPlanView,
    'type' | 'status' | 'expectedShipAt' | 'targetQuantity' | 'deadlineAt'
  >,
  activeItemQuantity: number,
  now: string,
): FulfillmentPlanDisplayStatus {
  if (isFulfillmentPlanReleaseReady(plan, activeItemQuantity, now)) return 'ready';
  return plan.status;
}

export function fulfillmentPlanStatusLabel(
  type: FulfillmentPlanType,
  status: FulfillmentPlanDisplayStatus,
): string {
  if (status === 'ready') {
    return type === 'presale' ? '预售·具备释放条件' : '团购·已成团待释放';
  }
  if (status === 'released') return '已释放待发货';
  if (status === 'closed') return type === 'presale' ? '预售·已关闭' : '未成团已关闭';
  const labels: Record<
    FulfillmentPlanType,
    Record<'pending' | 'partially_released' | 'delayed', string>
  > = {
    presale: {
      pending: '预售·待备货',
      partially_released: '预售·部分已释放',
      delayed: '预售·已延期',
    },
    group_buy: {
      pending: '团购·待成团',
      partially_released: '团购·部分已释放',
      delayed: '团购·已延期',
    },
  };
  return labels[type][status];
}

export function fulfillmentPlanTodo(
  plan: Pick<
    FulfillmentPlanView,
    'type' | 'status' | 'expectedShipAt' | 'targetQuantity' | 'deadlineAt'
  >,
  activeItemQuantity: number,
  now: string,
): string {
  const displayStatus = fulfillmentPlanDisplayStatus(plan, activeItemQuantity, now);
  if (displayStatus === 'ready') return '具备释放条件，请人工确认释放';
  switch (plan.status) {
    case 'released':
      return '已全部释放，订单可进入开放发货组';
    case 'closed':
      return '已关闭，无待办';
    case 'partially_released':
      return '部分订单已释放，剩余订单待人工确认释放';
    case 'delayed':
      return '已延期，确认新的计划条件后人工释放';
    default:
      if (plan.type === 'presale') {
        return plan.expectedShipAt
          ? '待到发货日或人工确认释放'
          : '等待设置预计发货时间';
      }
      return plan.targetQuantity !== null
        ? `待成团（${activeItemQuantity}/${plan.targetQuantity}）`
        : '待成团，到达截止时间后由人工确认';
  }
}

export function fulfillmentPlanStatusAfterRelease(
  activeBefore: number,
  releasingCount: number,
): 'partially_released' | 'released' {
  if (releasingCount <= 0) throw new Error('请选择要释放的订单');
  if (releasingCount > activeBefore) throw new Error('释放订单超出计划成员');
  return releasingCount === activeBefore ? 'released' : 'partially_released';
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  message: string,
): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(message);
}

function boundedText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(message);
  return normalized;
}

function requiredReason(value: unknown): string {
  return boundedText(value, 500, '请填写非空原因');
}

function optionalTime(value: unknown, message: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.trim();
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw new Error(message);
  return normalized;
}

function optionalTargetQuantity(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('成团数量无效');
  return Number(value);
}

function optionalAlertThreshold(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('需求提醒阈值无效');
  return Number(value);
}

function planId(value: unknown): string {
  return boundedText(value, 200, '履约计划标识无效');
}

function orderId(value: unknown): string {
  return boundedText(value, 200, '订单标识无效');
}

function orderIdList(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) throw new Error(message);
  return [...new Set(value.map((entry) => orderId(entry)))];
}

function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('履约计划版本无效');
  return Number(value);
}
