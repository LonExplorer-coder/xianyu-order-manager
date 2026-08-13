export type LogisticsDirection = 'outbound' | 'return';

export type OutboundLogisticsStatus =
  | 'awaiting_carrier'
  | 'in_transit'
  | 'delivered'
  | 'returned';

export type ReturnLogisticsStatus =
  | 'awaiting_carrier'
  | 'in_transit'
  | 'delivered'
  | 'returned';

export type LogisticsStatus = OutboundLogisticsStatus | ReturnLogisticsStatus;

export type LogisticsAffectedItem = {
  sourceItemId: string;
  quantity: number;
};

export type LogisticsExceptionImpact =
  | { scope: 'package' }
  | { scope: 'items'; items: LogisticsAffectedItem[] };

export type LogisticsExceptionType =
  | 'lost'
  | 'delivery_dispute'
  | 'damaged'
  | 'misdelivered'
  | 'other';

export type LogisticsExceptionStage =
  | 'pending_verification'
  | 'investigating'
  | 'confirmed'
  | 'recovered'
  | 'resolved';

export type LogisticsExceptionEvent =
  | {
    kind: 'opened';
    resultRevision: 1;
    stage: LogisticsExceptionStage;
    impact: LogisticsExceptionImpact;
    reason: string;
    occurredAt: string;
    createdAt: string;
  }
  | {
    kind: 'stage_changed';
    baseRevision: number;
    resultRevision: number;
    beforeStage: LogisticsExceptionStage;
    afterStage: LogisticsExceptionStage;
    reason: string;
    occurredAt: string;
    createdAt: string;
  };

export type LogisticsExceptionMatter = {
  id: string;
  direction: LogisticsDirection;
  packageId: string;
  exceptionType: LogisticsExceptionType;
  stage: LogisticsExceptionStage;
  revision: number;
  impact: LogisticsExceptionImpact;
  reason: string;
  occurredAt: string;
  timeline: LogisticsExceptionEvent[];
  createdAt: string;
  updatedAt: string;
};

export type LogisticsExceptionEvidence = {
  carrierAcceptedAt: string | null;
  physicalReceiptAt: string | null;
  carrierConfirmedLoss: boolean;
};

export type CarrierClaimStatus = 'pending' | 'approved' | 'rejected' | 'paid';

export type CarrierClaimEvent =
  | {
    kind: 'opened';
    resultRevision: 1;
    requestedAmountCents: number;
    impact: LogisticsExceptionImpact;
    reason: string;
    occurredAt: string;
    createdAt: string;
  }
  | {
    kind: 'approved' | 'rejected';
    baseRevision: number;
    resultRevision: number;
    approvedAmountCents: number | null;
    reason: string;
    occurredAt: string;
    createdAt: string;
  }
  | {
    kind: 'compensation_confirmed';
    baseRevision: number;
    resultRevision: number;
    amountCents: number;
    note: string;
    occurredAt: string;
    createdAt: string;
  };

export type CarrierClaim = {
  id: string;
  status: CarrierClaimStatus;
  revision: number;
  requestedAmountCents: number;
  approvedAmountCents: number | null;
  impact: LogisticsExceptionImpact;
  reason: string;
  actualCompensation: {
    id: string;
    amountCents: number;
    occurredAt: string;
    note: string;
    createdAt: string;
  } | null;
  timeline: CarrierClaimEvent[];
  createdAt: string;
  updatedAt: string;
};

export type LogisticsStatusChangeFacts = {
  direction: LogisticsDirection;
  currentStatus: LogisticsStatus;
  nextStatus: LogisticsStatus;
  carrierAcceptedAt: string | null;
  physicalReceiptAt: string | null;
  carrierAcceptanceConfirmed: boolean;
  occurredAt: string;
  latestOccurredAt: string;
};

export type PreparedLogisticsStatusChange = {
  nextStatus: LogisticsStatus;
  carrierAcceptedAt: string | null;
};

export type LogisticsInformation = {
  shippingCarrier: string;
  trackingNumber: string;
};

export type LogisticsCorrectionFacts = {
  current: LogisticsInformation;
  next: LogisticsInformation;
  occurredAt: string;
  latestOccurredAt: string;
};

export const OUTBOUND_LOGISTICS_STATUSES = [
  'awaiting_carrier',
  'in_transit',
  'delivered',
  'returned',
] as const satisfies readonly OutboundLogisticsStatus[];

export const RETURN_LOGISTICS_STATUSES = [
  'awaiting_carrier',
  'in_transit',
  'delivered',
  'returned',
] as const satisfies readonly ReturnLogisticsStatus[];

const CLAIMABLE_LOGISTICS_EXCEPTION_TYPES = new Set<LogisticsExceptionType>([
  'lost',
  'delivery_dispute',
  'damaged',
  'misdelivered',
  'other',
]);

const BEFORE_RECEIPT_LOGISTICS_STATUSES = new Set<LogisticsStatus>([
  'awaiting_carrier',
  'in_transit',
]);

const EXCEPTION_STAGE_TRANSITIONS: Readonly<Record<
  LogisticsExceptionStage,
  readonly LogisticsExceptionStage[]
>> = {
  pending_verification: ['investigating', 'confirmed', 'resolved'],
  investigating: ['confirmed', 'resolved'],
  confirmed: ['recovered', 'resolved'],
  recovered: ['resolved'],
  resolved: [],
};

export function isUnresolvedLogisticsExceptionStage(
  stage: LogisticsExceptionStage,
): boolean {
  return stage !== 'recovered' && stage !== 'resolved';
}

export function nextLogisticsExceptionStages(
  type: LogisticsExceptionType,
  stage: LogisticsExceptionStage,
): readonly LogisticsExceptionStage[] {
  return type === 'lost'
    ? EXCEPTION_STAGE_TRANSITIONS[stage]
    : EXCEPTION_STAGE_TRANSITIONS[stage].filter((nextStage) => nextStage !== 'recovered');
}

export function prepareLogisticsExceptionOpening(input: {
  exceptionType: LogisticsExceptionType;
  stage: LogisticsExceptionStage;
  impact: LogisticsExceptionImpact;
  availableItems: readonly LogisticsAffectedItem[];
  evidence: LogisticsExceptionEvidence;
  occurredAt: string;
}): void {
  if (input.stage === 'recovered' || input.stage === 'resolved') {
    throw new Error('新物流异常不能从已找回或已解决开始');
  }
  assertImpact(input.impact, input.availableItems);
  assertConfirmedExceptionEvidence(
    input.exceptionType,
    input.stage,
    input.evidence,
    input.occurredAt,
  );
}

export function prepareLogisticsExceptionProgress(input: {
  exceptionType: LogisticsExceptionType;
  currentStage: LogisticsExceptionStage;
  nextStage: LogisticsExceptionStage;
  occurredAt: string;
  latestOccurredAt: string;
  evidence: LogisticsExceptionEvidence;
}): void {
  if (!EXCEPTION_STAGE_TRANSITIONS[input.currentStage].includes(input.nextStage)) {
    throw new Error('物流异常处理阶段不能这样推进');
  }
  if (input.nextStage === 'recovered' && input.exceptionType !== 'lost') {
    throw new Error('只有丢件异常可以登记已找回');
  }
  assertOccurredAtNotBefore(
    input.occurredAt,
    input.latestOccurredAt,
    '物流异常时间不能早于上一条异常事件',
  );
  assertConfirmedExceptionEvidence(
    input.exceptionType,
    input.nextStage,
    input.evidence,
    input.occurredAt,
  );
}

export function prepareLogisticsStatusChange(
  facts: LogisticsStatusChangeFacts,
): PreparedLogisticsStatusChange {
  assertDirectionStatus(facts.direction, facts.currentStatus);
  assertDirectionStatus(facts.direction, facts.nextStatus);
  assertOccurredAtNotBefore(
    facts.occurredAt,
    facts.latestOccurredAt,
    '物流事件时间不能早于上一条事件',
  );
  const carrierAcceptedAt = facts.carrierAcceptedAt
    ?? (facts.carrierAcceptanceConfirmed ? facts.occurredAt : null);
  if (
    facts.physicalReceiptAt !== null
    && BEFORE_RECEIPT_LOGISTICS_STATUSES.has(facts.nextStatus)
  ) {
    throw new Error(facts.direction === 'return'
      ? '已收到或检查的退货包裹不能回退到收件前的物流状态'
      : '已经收到的包裹不能回退到收件前状态');
  }
  if (facts.nextStatus === 'awaiting_carrier' && carrierAcceptedAt !== null) {
    throw new Error('已有承运方揽收证据，不能登记为待承运方接收');
  }
  return {
    nextStatus: facts.nextStatus,
    carrierAcceptedAt,
  };
}

export function prepareLogisticsCorrection(
  facts: LogisticsCorrectionFacts,
): LogisticsInformation {
  if (
    facts.current.shippingCarrier === facts.next.shippingCarrier
    && facts.current.trackingNumber === facts.next.trackingNumber
  ) {
    throw new Error('物流信息没有变化');
  }
  assertOccurredAtNotBefore(
    facts.occurredAt,
    facts.latestOccurredAt,
    '物流更正时间不能早于上一条物流事件',
  );
  return { ...facts.next };
}

export function isOutboundLogisticsStatus(
  value: unknown,
): value is OutboundLogisticsStatus {
  return typeof value === 'string'
    && (OUTBOUND_LOGISTICS_STATUSES as readonly string[]).includes(value);
}

export function isReturnLogisticsStatus(
  value: unknown,
): value is ReturnLogisticsStatus {
  return typeof value === 'string'
    && (RETURN_LOGISTICS_STATUSES as readonly string[]).includes(value);
}

export function supportsCarrierClaim(exception: {
  exceptionType: LogisticsExceptionType;
  stage: LogisticsExceptionStage;
}): boolean {
  return exception.stage === 'confirmed'
    && CLAIMABLE_LOGISTICS_EXCEPTION_TYPES.has(exception.exceptionType);
}

export function sameLogisticsExceptionImpact(
  first: LogisticsExceptionImpact,
  second: LogisticsExceptionImpact,
): boolean {
  if (first.scope !== second.scope) return false;
  if (first.scope === 'package' || second.scope === 'package') return true;
  if (first.items.length !== second.items.length) return false;
  const secondQuantities = new Map(
    second.items.map((item) => [item.sourceItemId, item.quantity]),
  );
  return first.items.every((item) => secondQuantities.get(item.sourceItemId) === item.quantity);
}

export function assertOccurredAtNotBefore(
  occurredAt: string,
  earliestAt: string,
  message: string,
): void {
  if (Date.parse(occurredAt) < Date.parse(earliestAt)) throw new Error(message);
}

function assertDirectionStatus(
  direction: LogisticsDirection,
  status: LogisticsStatus,
): void {
  if (
    (direction === 'outbound' && !isOutboundLogisticsStatus(status))
    || (direction === 'return' && !isReturnLogisticsStatus(status))
  ) {
    throw new Error('物流状态与运输方向不匹配');
  }
}

function assertImpact(
  impact: LogisticsExceptionImpact,
  availableItems: readonly LogisticsAffectedItem[],
): void {
  if (impact.scope === 'package') return;
  if (impact.items.length === 0) throw new Error('请至少选择一件受影响商品');
  const quantities = new Map(availableItems.map((item) => [item.sourceItemId, item.quantity]));
  const seen = new Set<string>();
  for (const item of impact.items) {
    if (seen.has(item.sourceItemId)) throw new Error('同一物流异常商品不能重复');
    seen.add(item.sourceItemId);
    const available = quantities.get(item.sourceItemId);
    if (available === undefined) throw new Error('物流异常商品不属于当前包裹');
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new Error('物流异常商品数量无效');
    }
    if (item.quantity > available) {
      throw new Error('物流异常商品数量不能超过包裹内数量');
    }
  }
}

function assertConfirmedExceptionEvidence(
  exceptionType: LogisticsExceptionType,
  stage: LogisticsExceptionStage,
  evidence: LogisticsExceptionEvidence,
  occurredAt: string,
): void {
  if (exceptionType !== 'lost' || stage !== 'confirmed') return;
  if (evidence.physicalReceiptAt !== null) {
    throw new Error('已有可信收到证据，不能确认丢件');
  }
  if (evidence.carrierAcceptedAt === null) {
    throw new Error('没有承运方揽收证据，不能确认丢件');
  }
  if (Date.parse(occurredAt) < Date.parse(evidence.carrierAcceptedAt)) {
    throw new Error('丢件确认时间不能早于承运方揽收时间');
  }
  if (!evidence.carrierConfirmedLoss) {
    throw new Error('请确认承运方已经认定包裹遗失');
  }
}
