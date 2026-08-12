import type { AftersalesStatus } from './aftersales-cases';
import type { ShipmentLogisticsStatus } from './shipment-records';

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
};

export type OrderOperationsProjection = {
  shipmentRecords: OrderOperationsShipmentRecord[];
  aftersalesCases: OrderOperationsAftersalesCase[];
  currentTodo: string;
};

export function aftersalesTodoForStatuses(
  statuses: ReadonlySet<AftersalesStatus>,
): string | null {
  if (statuses.has('waiting_inspection')) return '检查退回商品';
  if (statuses.has('waiting_refund')) return '确认退款';
  if (statuses.has('waiting_replacement')) return '安排补发';
  if (statuses.has('waiting_return')) return '等待买家退回';
  if (statuses.has('partially_completed')) return '继续处理未完成售后';
  if (statuses.has('processing')) return '处理售后问题';
  return null;
}

export function shipmentTodoForStatuses(
  statuses: ReadonlySet<ShipmentLogisticsStatus>,
): string {
  if (statuses.size === 0 || [...statuses].every((status) => status === 'delivered')) {
    return '无需物流操作';
  }
  if (statuses.has('lost')) return '处理丢件';
  if (statuses.has('exception')) return '处理物流异常';
  if (statuses.has('intercepting')) return '跟进拦截结果';
  if (statuses.has('intercepted_returned')) return '确认退回货物';
  if (statuses.has('awaiting_carrier')) return '确认承运方接收';
  return '跟进运输进度';
}
