import type {
  AftersalesReturnLogisticsStatus,
  AftersalesReturnDiscrepancy,
  AftersalesReturnStatus,
  AftersalesStatus,
  CarrierClaimStatus,
  PendingFinancialItemStatus,
} from './aftersales-cases';
import type { ShipmentLogisticsStatus } from './shipment-records';
import type { FulfillmentPlanType } from './fulfillment-plans';
import type { LogisticsExceptionStage, LogisticsExceptionType } from './logistics-exceptions';

export type OrderOperationsShipmentItem = {
  shipmentPackageItemId: string;
  orderItemId: string;
  sourceTitle: string;
  sourceSpec: string;
  quantity: number;
};

export type OrderOperationsPackage = {
  id: string;
  position: number;
  status: 'active' | 'cancelled';
  logisticsStatus: ShipmentLogisticsStatus;
  updatedAt: string;
  shippingCarrier: string;
  trackingNumber: string;
  cancellationReason: string | null;
  currentException: OrderOperationsLogisticsException | null;
  logisticsExceptions: OrderOperationsLogisticsException[];
  carrierClaimStatus: CarrierClaimStatus | null;
  carrierClaimUpdatedAt: string | null;
  carrierClaimAffectedQuantity?: number;
  carrierClaimAffectedItems?: OrderOperationsAffectedItem[];
  items: OrderOperationsShipmentItem[];
};

export type OrderOperationsLogisticsException = {
  id: string;
  direction: 'outbound' | 'return';
  exceptionType: LogisticsExceptionType;
  stage: LogisticsExceptionStage;
  affectedQuantity: number;
  affectedItems: OrderOperationsAffectedItem[];
  reason: string;
  occurredAt: string;
};

export type OrderOperationsAffectedItem = {
  shipmentPackageItemId?: string;
  sourceTitle: string;
  sourceSpec: string;
  quantity: number;
};

export type OrderOperationsShipmentRecord = {
  id: string;
  archiveId: string;
  sourceRole: 'initial' | 'replacement';
  replacementAftersalesCaseId: string | null;
  status: 'active' | 'voided';
  createdAt: string;
  packages: OrderOperationsPackage[];
};

export type OrderOperationsAftersalesItem = {
  shipmentPackageItemId: string;
  packageId: string;
  orderItemId: string;
  sourceTitle: string;
  sourceSpec: string;
  quantity: number;
};

export type OrderOperationsAftersalesCase = {
  id: string;
  shipmentRecordId: string;
  status: AftersalesStatus;
  reason: string;
  occurredAt: string;
  updatedAt: string;
  currentTodo: string;
  refund: {
    requestedAmountCents: number;
    status: 'pending' | 'confirmed' | 'cancelled';
    actualAmountCents: number | null;
    occurredAt: string | null;
  } | null;
  items: OrderOperationsAftersalesItem[];
  returnPackages: Array<{
    id: string;
    status: AftersalesReturnStatus;
    shippingCarrier: string;
    trackingNumber: string;
    logisticsStatus: AftersalesReturnLogisticsStatus;
    updatedAt: string;
    currentException: OrderOperationsLogisticsException | null;
    logisticsExceptions: OrderOperationsLogisticsException[];
    discrepancies: AftersalesReturnDiscrepancy[];
    carrierClaimStatus: CarrierClaimStatus | null;
    carrierClaimUpdatedAt: string | null;
    carrierClaimAffectedQuantity?: number;
    carrierClaimAffectedItems?: OrderOperationsAffectedItem[];
    items: Array<{
      shipmentPackageItemId: string;
      sourceTitle: string;
      sourceSpec: string;
      plannedQuantity: number;
      receivedQuantity: number;
      acceptedQuantity: number;
    }>;
  }>;
};

export type OrderOperationsProjection = {
  shipmentRecords: OrderOperationsShipmentRecord[];
  aftersalesCases: OrderOperationsAftersalesCase[];
  currentTodo: string;
  coordination: OrderOperationsCoordination;
  risks: OrderOperationsRisk[];
  facts: OrderOperationsFact[];
  history: OrderOperationsHistoryEntry[];
  fulfillmentPlanAttribution: OrderFulfillmentPlanAttribution;
};

export type OrderFulfillmentPlanAttribution =
  | { status: 'none' }
  | {
    status: 'active' | 'released';
    planId: string;
    planType: FulfillmentPlanType;
    planName: string;
  };

export function fulfillmentPlanAttributionLabel(
  attribution: OrderFulfillmentPlanAttribution,
): string {
  if (attribution.status === 'none') return '未归属';
  if (attribution.status === 'active') {
    return `${attribution.planType === 'presale' ? '预售' : '团购'}·${attribution.planName}（进行中）`;
  }
  return `已被${attribution.planName}释放`;
}

export type OrderOperationsTarget =
  | {
    kind: 'shipment_record';
    shipmentRecordId: string;
    packageId?: string;
  }
  | {
    kind: 'aftersales_case';
    shipmentRecordId: string;
    aftersalesCaseId: string;
    returnRecordId?: string;
  };

export type OrderOperationsTodoPriority =
  | 'deadline'
  | 'financial_risk'
  | 'physical_risk'
  | 'follow_up';

export type OrderOperationsTodoCandidate = {
  id: string;
  priority: OrderOperationsTodoPriority;
  title: string;
  detail: string;
  dueAt?: string;
  occurredAt: string;
  target: OrderOperationsTarget;
};

export type OrderOperationsCoordination = {
  primaryTodo: OrderOperationsTodoCandidate | null;
  secondaryTodoCount: number;
  todos: OrderOperationsTodoCandidate[];
};

export type AftersalesOperationsCoordinationInput = {
  id: string;
  shipmentRecordId: string;
  status: AftersalesStatus;
  currentTodo: string;
  updatedAt: string;
  itemQuantity: number;
  refund: null | {
    status: PendingFinancialItemStatus;
    requestedAmountCents: number;
    occurredAt: string;
  };
  outboundClaims: Array<{
    packageId: string;
    status: CarrierClaimStatus;
    updatedAt: string;
    affectedQuantity: number;
  }>;
  outboundExceptions: Array<{
    id: string;
    stage: LogisticsExceptionStage;
    affectedQuantity: number;
    occurredAt: string;
    requiresDecision?: boolean;
  }>;
  returns: Array<{
    id: string;
    status: AftersalesReturnStatus;
    logisticsStatus: AftersalesReturnLogisticsStatus;
    updatedAt: string;
    exceptions: Array<{
      id: string;
      exceptionType: LogisticsExceptionType;
      stage: LogisticsExceptionStage;
      affectedQuantity: number;
      occurredAt: string;
    }>;
    claim: null | {
      status: CarrierClaimStatus;
      updatedAt: string;
      affectedQuantity: number;
    };
  }>;
  hasPendingReturnExceptionDecision: boolean;
  suppressGenericTodo?: boolean;
};

export type OrderOperationsRisk = {
  id: string;
  kind: 'logistics_exception' | 'refund_without_goods' | 'replacement_before_return';
  packageRole: 'original_outbound' | 'return' | 'replacement';
  exceptionType?: LogisticsExceptionType;
  affectedQuantity: number;
  items: OrderOperationsAffectedItem[];
  title: string;
  detail: string;
  occurredAt: string;
  target: OrderOperationsTarget;
};

export type OrderOperationsFact = {
  id: string;
  kind:
    | 'outbound_logistics'
    | 'logistics_exception'
    | 'aftersales'
    | 'return_logistics'
    | 'refund'
    | 'replacement'
    | 'carrier_claim';
  label: string;
  value: string;
  detail: string;
  affectedQuantity: number;
  occurredAt: string;
  target: OrderOperationsTarget;
};

export type OrderOperationsHistoryTarget =
  | OrderOperationsTarget
  | {
    kind: 'fulfillment_plan';
    planId: string;
  };

export type OrderOperationsHistoryEntry = {
  id: string;
  kind:
    | 'shipment'
    | 'logistics'
    | 'logistics_exception'
    | 'aftersales'
    | 'return'
    | 'refund'
    | 'replacement'
    | 'carrier_claim'
    | 'fulfillment_plan';
  title: string;
  detail: string;
  occurredAt: string;
  target: OrderOperationsHistoryTarget;
};

const TODO_PRIORITY_RANK: Readonly<Record<OrderOperationsTodoPriority, number>> = {
  deadline: 0,
  financial_risk: 1,
  physical_risk: 2,
  follow_up: 3,
};

export function coordinateOrderOperations(
  candidates: readonly OrderOperationsTodoCandidate[],
): OrderOperationsCoordination {
  const newestById = new Map<string, OrderOperationsTodoCandidate>();
  for (const candidate of candidates) {
    const current = newestById.get(candidate.id);
    if (!current || compareOccurredAt(candidate.occurredAt, current.occurredAt) >= 0) {
      newestById.set(candidate.id, candidate);
    }
  }
  const todos = [...newestById.values()].sort((first, second) => {
    const priorityDifference = TODO_PRIORITY_RANK[first.priority]
      - TODO_PRIORITY_RANK[second.priority];
    if (priorityDifference !== 0) return priorityDifference;
    if (first.dueAt !== undefined || second.dueAt !== undefined) {
      if (first.dueAt === undefined) return 1;
      if (second.dueAt === undefined) return -1;
      const dueDifference = compareOccurredAt(first.dueAt, second.dueAt);
      if (dueDifference !== 0) return dueDifference;
    }
    const occurredDifference = compareOccurredAt(second.occurredAt, first.occurredAt);
    return occurredDifference !== 0 ? occurredDifference : first.id.localeCompare(second.id);
  });
  return {
    primaryTodo: todos[0] ?? null,
    secondaryTodoCount: Math.max(0, todos.length - 1),
    todos,
  };
}

export function shipmentOrderOperationCandidates(
  records: readonly OrderOperationsShipmentRecord[],
): OrderOperationsTodoCandidate[] {
  const candidates: OrderOperationsTodoCandidate[] = [];
  for (const record of records) {
    if (record.status !== 'active') continue;
    for (const shipmentPackage of record.packages) {
      if (shipmentPackage.status !== 'active') continue;
      const target = {
        kind: 'shipment_record' as const,
        shipmentRecordId: record.id,
        packageId: shipmentPackage.id,
      };
      for (const exception of shipmentPackage.logisticsExceptions) {
        if (!isUnresolvedLogisticsExceptionStageValue(exception.stage)) continue;
        candidates.push({
          id: `logistics-exception:${exception.id}`,
          priority: 'physical_risk',
          title: record.sourceRole === 'replacement'
            ? '处理补发物流异常'
            : '处理正向物流异常',
          detail: `${exception.exceptionType} · 影响 ${exception.affectedQuantity} 件商品`,
          occurredAt: exception.occurredAt,
          target,
        });
      }
      if (shipmentPackage.carrierClaimStatus === 'pending'
        || shipmentPackage.carrierClaimStatus === 'approved') {
        candidates.push({
          id: `carrier-claim:outbound:${shipmentPackage.id}`,
          priority: 'financial_risk',
          title: shipmentPackage.carrierClaimStatus === 'pending'
            ? '跟进承运索赔'
            : '确认承运赔付',
          detail: `影响 ${shipmentPackage.carrierClaimAffectedQuantity
            ?? shipmentPackage.items.reduce((total, item) => total + item.quantity, 0)
          } 件商品 · 承运责任与买家侧处理分别推进`,
          occurredAt: shipmentPackage.carrierClaimUpdatedAt ?? shipmentPackage.updatedAt,
          target,
        });
      }
      if (shipmentPackage.logisticsStatus !== 'delivered') {
        candidates.push({
          id: `outbound-logistics:${shipmentPackage.id}`,
          priority: 'follow_up',
          title: shipmentPackage.logisticsStatus === 'returned'
            ? '确认退回货物'
            : shipmentPackage.logisticsStatus === 'awaiting_carrier'
              ? '确认承运方接收'
              : '跟进运输进度',
          detail: `${record.sourceRole === 'replacement' ? '补发包裹' : '正向包裹'} · ${shipmentPackage.items.reduce(
            (total, item) => total + item.quantity,
            0,
          )} 件商品`,
          occurredAt: shipmentPackage.updatedAt,
          target,
        });
      }
    }
  }
  return candidates;
}

export function coordinateAftersalesOrderOperations(
  input: AftersalesOperationsCoordinationInput,
): OrderOperationsCoordination {
  const baseTarget = {
    kind: 'aftersales_case' as const,
    shipmentRecordId: input.shipmentRecordId,
    aftersalesCaseId: input.id,
  };
  const candidates: OrderOperationsTodoCandidate[] = [];
  if (input.refund?.status === 'pending') {
    candidates.push({
      id: `refund:${input.id}`,
      priority: 'financial_risk',
      title: '确认实际退款',
      detail: `待退款 ¥${(input.refund.requestedAmountCents / 100).toFixed(2)}`,
      occurredAt: input.refund.occurredAt,
      target: baseTarget,
    });
  }
  for (const claim of input.outboundClaims) {
    if (claim.status !== 'pending' && claim.status !== 'approved') continue;
    candidates.push({
      id: `carrier-claim:outbound:${claim.packageId}`,
      priority: 'financial_risk',
      title: claim.status === 'pending' ? '跟进承运索赔' : '确认承运赔付',
      detail: `正向包裹影响 ${claim.affectedQuantity} 件商品 · 承运责任与买家侧处理分别推进`,
      occurredAt: claim.updatedAt,
      target: baseTarget,
    });
  }
  for (const exception of input.outboundExceptions) {
    if (!isUnresolvedLogisticsExceptionStageValue(exception.stage)) continue;
    candidates.push({
      id: `logistics-exception:${exception.id}`,
      priority: 'physical_risk',
      title: input.currentTodo.includes('正向物流异常')
        ? input.currentTodo
        : exception.requiresDecision
          ? '选择正向异常处理'
          : '处理正向物流异常',
      detail: `影响 ${exception.affectedQuantity} 件商品`,
      occurredAt: exception.occurredAt,
      target: baseTarget,
    });
  }
  for (const returnPackage of input.returns) {
    const target = { ...baseTarget, returnRecordId: returnPackage.id };
    for (const exception of returnPackage.exceptions) {
      if (!isUnresolvedLogisticsExceptionStageValue(exception.stage)) continue;
      candidates.push({
        id: `logistics-exception:${exception.id}`,
        priority: 'physical_risk',
        title: input.currentTodo.includes('退货物流异常')
          ? input.currentTodo
          : '处理退货物流异常',
        detail: `${exception.exceptionType} · 影响 ${exception.affectedQuantity} 件商品`,
        occurredAt: exception.occurredAt,
        target,
      });
    }
    const claim = returnPackage.claim;
    if (claim?.status === 'pending' || claim?.status === 'approved') {
      candidates.push({
        id: `carrier-claim:return:${returnPackage.id}`,
        priority: 'financial_risk',
        title: claim.status === 'pending' ? '跟进承运索赔' : '确认承运赔付',
        detail: `退货影响 ${claim.affectedQuantity} 件商品 · 承运责任与买家侧处理分别推进`,
        occurredAt: claim.updatedAt,
        target,
      });
    }
  }
  const independentTodo = aftersalesTodoForCases([{
    status: input.status,
    returnStatuses: input.returns.map(({ status }) => status),
    returnLogisticsStatuses: input.returns.map(({ logisticsStatus }) => logisticsStatus),
    carrierClaimStatuses: input.returns.flatMap(({ claim }) => claim ? [claim.status] : []),
    hasUnresolvedLogisticsException: input.returns.some(({ exceptions }) => (
      exceptions.some(({ stage }) => isUnresolvedLogisticsExceptionStageValue(stage))
    )),
    hasPendingReturnExceptionDecision: input.hasPendingReturnExceptionDecision,
  }]);
  const terminal = input.status === 'completed' || input.status === 'cancelled';
  const title = terminal ? independentTodo : input.currentTodo;
  if (!input.suppressGenericTodo
    && title
    && !caseTodoCoveredBySpecificCandidate(title, candidates)) {
    const occurredAt = terminal
      ? latestOccurredAt([input.updatedAt, ...input.returns.map(({ updatedAt }) => updatedAt)])
      : input.updatedAt;
    candidates.push({
      id: `aftersales:${input.id}`,
      priority: operationTodoPriority(title),
      title,
      detail: `${input.itemQuantity} 件商品`,
      occurredAt,
      target: baseTarget,
    });
  }
  return coordinateOrderOperations(candidates);
}

function latestOccurredAt(values: readonly string[]): string {
  return values.reduce((latest, value) => (
    compareOccurredAt(value, latest) > 0 ? value : latest
  ));
}

function isUnresolvedLogisticsExceptionStageValue(stage: LogisticsExceptionStage): boolean {
  return stage !== 'recovered' && stage !== 'resolved';
}

function caseTodoCoveredBySpecificCandidate(
  title: string,
  candidates: readonly OrderOperationsTodoCandidate[],
): boolean {
  if (title === '处理售后问题' && candidates.length > 0) return true;
  return candidates.some((candidate) => (
    candidate.title === title
    || (candidate.id.startsWith('refund:')
      && (title === '确认退款' || title === '确认实际退款'))
    || (candidate.id.startsWith('carrier-claim:')
      && (title === '跟进承运索赔' || title === '确认承运赔付'))
  ));
}

function operationTodoPriority(title: string): OrderOperationsTodoCandidate['priority'] {
  if (title.includes('今天') || title.includes('截止') || title.includes('期限')) return 'deadline';
  if (title.includes('确认实际退款') || title.includes('赔付') || title.includes('索赔')) {
    return 'financial_risk';
  }
  if (title.includes('异常') || title.includes('退货') || title.includes('检查')
    || title.includes('拦截') || title.includes('收回')) {
    return 'physical_risk';
  }
  return 'follow_up';
}

function compareOccurredAt(first: string, second: string): number {
  const firstTimestamp = Date.parse(first);
  const secondTimestamp = Date.parse(second);
  if (Number.isNaN(firstTimestamp) || Number.isNaN(secondTimestamp)) {
    return first.localeCompare(second);
  }
  return firstTimestamp - secondTimestamp;
}

export type OrderOperationsOverview = {
  shipmentSummary: string;
  logisticsSummary: string;
  aftersalesSummary: string;
  currentTodo: string;
};

const AFTERSALES_STATUS_LABELS: Record<AftersalesStatus, string> = {
  processing: '处理中',
  waiting_return: '等待退回',
  waiting_inspection: '等待检查',
  waiting_refund: '等待退款',
  waiting_replacement: '等待补发',
  partially_completed: '部分完成',
  ready_to_complete: '待完成',
  completed: '已完成',
  cancelled: '已取消',
};

const SHIPMENT_LOGISTICS_STATUS_LABELS: Record<ShipmentLogisticsStatus, string> = {
  awaiting_carrier: '待承运方接收',
  in_transit: '运输中',
  delivered: '已签收',
  returned: '已退回',
};

export function orderOperationsOverview(
  projection: OrderOperationsProjection,
  orderedQuantity: number,
): OrderOperationsOverview {
  const activePackages = projection.shipmentRecords
    .filter(({ status }) => status === 'active')
    .flatMap(({ packages }) => packages)
    .filter(({ status }) => status === 'active');
  const shippedQuantity = activePackages
    .flatMap(({ items }) => items)
    .reduce((total, { quantity }) => total + quantity, 0);
  const shipmentSummary = shippedQuantity === 0
    ? '无发货'
    : shippedQuantity < orderedQuantity
      ? `部分发货（已发 ${shippedQuantity} / 共 ${orderedQuantity} 件）`
      : `已全部发货（${shippedQuantity} 件）`;
  const logisticsSummary = activePackages.length === 0
    ? '无物流'
    : countLabels(
      activePackages.map(({ logisticsStatus }) => logisticsStatus),
      shipmentLogisticsStatusLabel,
    );
  const aftersalesSummary = projection.aftersalesCases.length === 0
    ? '无售后'
    : `${countLabels(
      projection.aftersalesCases.map(({ status }) => status),
      aftersalesStatusLabel,
    )}（${projection.aftersalesCases.length === 1
      ? `${aftersalesQuantity(projection)} 件`
      : `${projection.aftersalesCases.length} 张处理单 / ${aftersalesQuantity(projection)} 件`
    }）`;
  return {
    shipmentSummary,
    logisticsSummary,
    aftersalesSummary,
    currentTodo: projection.currentTodo === '无需物流操作'
      ? '无需处理'
      : projection.currentTodo,
  };
}

function aftersalesQuantity(projection: OrderOperationsProjection): number {
  return projection.aftersalesCases
    .flatMap(({ items }) => items)
    .reduce((total, { quantity }) => total + quantity, 0);
}

export function aftersalesStatusLabel(status: AftersalesStatus): string {
  return AFTERSALES_STATUS_LABELS[status];
}

export function shipmentLogisticsStatusLabel(status: ShipmentLogisticsStatus): string {
  return SHIPMENT_LOGISTICS_STATUS_LABELS[status];
}

export function aftersalesTodoForStatuses(
  statuses: ReadonlySet<AftersalesStatus>,
): string | null {
  if (statuses.has('waiting_inspection')) return '检查退回商品';
  if (statuses.has('waiting_refund')) return '确认退款';
  if (statuses.has('waiting_replacement')) return '安排补发';
  if (statuses.has('waiting_return')) return '等待买家退回';
  if (statuses.has('partially_completed')) return '继续处理未完成售后';
  if (statuses.has('ready_to_complete')) return '确认完成售后';
  if (statuses.has('processing')) return '处理售后问题';
  return null;
}

export function aftersalesTodoForCases(
  cases: readonly {
    status: AftersalesStatus;
    returnStatuses: readonly AftersalesReturnStatus[];
    returnLogisticsStatuses?: readonly AftersalesReturnLogisticsStatus[];
    carrierClaimStatuses?: readonly CarrierClaimStatus[];
    hasUnresolvedLogisticsException?: boolean;
    hasPendingReturnExceptionDecision?: boolean;
  }[],
): string | null {
  const activeCases = cases.filter(({ status }) => status !== 'completed');
  if (cases.some(({ returnStatuses }) => returnStatuses.includes('received'))) {
    return '检查退回商品';
  }
  if (activeCases.some(({ status }) => status === 'waiting_refund')) {
    return '确认退款';
  }
  if (cases.some(({ hasPendingReturnExceptionDecision }) => hasPendingReturnExceptionDecision)) {
    return '选择退货异常退款处理';
  }
  if (cases.some(({ carrierClaimStatuses = [] }) => carrierClaimStatuses.includes('pending'))) {
    return '跟进承运索赔';
  }
  if (cases.some(({ carrierClaimStatuses = [] }) => carrierClaimStatuses.includes('approved'))) {
    return '确认承运赔付';
  }
  if (cases.some(({ hasUnresolvedLogisticsException }) => hasUnresolvedLogisticsException)) {
    return '处理退货物流异常';
  }
  if (cases.some(({ returnStatuses }) => (
    returnStatuses.includes('in_transit')
  ))) {
    return '确认收到退货';
  }
  const caseTodo = aftersalesTodoForStatuses(new Set(
    activeCases
      .filter(({ status }) => status !== 'cancelled')
      .map(({ status }) => status),
  ));
  if (caseTodo) return caseTodo;
  return null;
}

export function shipmentTodoForStatuses(
  statuses: ReadonlySet<ShipmentLogisticsStatus>,
  carrierClaimStatuses: ReadonlySet<CarrierClaimStatus> = new Set(),
  hasUnresolvedLogisticsException = false,
): string {
  if (carrierClaimStatuses.has('pending')) return '跟进承运索赔';
  if (carrierClaimStatuses.has('approved')) return '确认承运赔付';
  if (hasUnresolvedLogisticsException) return '处理物流异常';
  if (statuses.size === 0 || [...statuses].every((status) => status === 'delivered')) {
    return '无需物流操作';
  }
  if (statuses.has('returned')) return '确认退回货物';
  if (statuses.has('awaiting_carrier')) return '确认承运方接收';
  return '跟进运输进度';
}

function countLabels<T extends string>(
  values: readonly T[],
  label: (value: T) => string,
): string {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => (
    values.length === 1 ? label(value) : `${label(value)} ${count}`
  )).join('、');
}
