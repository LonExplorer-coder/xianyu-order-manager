import type {
  AftersalesReturnLogisticsStatus,
  AftersalesReturnDiscrepancy,
  AftersalesReturnStatus,
  AftersalesStatus,
  CarrierClaimStatus,
} from './aftersales-cases';
import type { ShipmentLogisticsStatus } from './shipment-records';
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
  shippingCarrier: string;
  trackingNumber: string;
  cancellationReason: string | null;
  currentException: {
    direction: 'outbound';
    exceptionType: LogisticsExceptionType;
    stage: LogisticsExceptionStage;
    affectedQuantity: number;
    reason: string;
    occurredAt: string;
  } | null;
  carrierClaimStatus: CarrierClaimStatus | null;
  items: OrderOperationsShipmentItem[];
};

export type OrderOperationsShipmentRecord = {
  id: string;
  archiveId: string;
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
  currentTodo: string;
  items: OrderOperationsAftersalesItem[];
  returnPackages: Array<{
    id: string;
    status: AftersalesReturnStatus;
    shippingCarrier: string;
    trackingNumber: string;
    logisticsStatus: AftersalesReturnLogisticsStatus;
    currentException: {
      direction: 'return';
      exceptionType: LogisticsExceptionType;
      stage: LogisticsExceptionStage;
      affectedQuantity: number;
      reason: string;
      occurredAt: string;
    } | null;
    discrepancies: AftersalesReturnDiscrepancy[];
    carrierClaimStatus: CarrierClaimStatus | null;
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
};

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
  if (cases.some(({ carrierClaimStatuses = [] }) => carrierClaimStatuses.includes('pending'))) {
    return '跟进承运索赔';
  }
  if (cases.some(({ carrierClaimStatuses = [] }) => carrierClaimStatuses.includes('approved'))) {
    return '确认承运赔付';
  }
  if (cases.some(({ hasPendingReturnExceptionDecision }) => hasPendingReturnExceptionDecision)) {
    return '选择退货异常退款处理';
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
