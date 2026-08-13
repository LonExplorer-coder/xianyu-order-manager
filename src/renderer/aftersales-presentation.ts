import {
  AFTERSALES_STATUSES,
  type AftersalesCase,
  type AftersalesReturnDiscrepancy,
  type AftersalesReturnLogisticsStatus,
  type AftersalesReturnStatus,
  type AftersalesStatus,
  type CarrierClaimStatus,
} from '../core/aftersales-cases';
import {
  aftersalesStatusLabel,
  aftersalesTodoForCases,
} from '../core/order-operations-projection';
import { isUnresolvedLogisticsExceptionStage } from '../core/logistics-exceptions';
import type { ShipmentRecord } from '../core/shipment-records';
import type {
  AftersalesHandlingDirection,
  AftersalesPhysicalControl,
} from '../core/aftersales-coordination';

export const AFTERSALES_STATUS_OPTIONS: ReadonlyArray<{
  value: AftersalesStatus;
  label: string;
}> = AFTERSALES_STATUSES
  .filter((value) => value !== 'ready_to_complete')
  .map((value) => ({ value, label: aftersalesStatusLabel(value) }));

export { aftersalesStatusLabel };

export function aftersalesHandlingDirectionLabel(
  direction: AftersalesHandlingDirection,
): string {
  return {
    waiting: '继续等待',
    intercept: '申请拦截',
    refuse: '约定拒收',
    only_refund: '仅退款',
    replacement: '补发',
    buyer_return: '买家寄回',
  }[direction];
}

export function aftersalesPhysicalControlLabel(control: AftersalesPhysicalControl): string {
  return {
    carrier: '承运方',
    buyer: '买家',
    seller: '卖家',
    confirmed_lost: '已确认丢失',
    mixed: '多种状态',
  }[control];
}

export function returnLogisticsStatusLabel(status: AftersalesReturnLogisticsStatus): string {
  return {
    awaiting_carrier: '待承运方接收',
    in_transit: '运输中',
    delivered: '已签收',
    returned: '已退回',
  }[status];
}

export function returnDiscrepancyLabel(kind: AftersalesReturnDiscrepancy['kind']): string {
  return {
    missing: '少件',
    empty_package: '空包',
    wrong_item: '错货',
    excess: '多退',
    mixed: '混装',
    damaged: '损坏',
    missing_accessory: '配件缺失',
    unidentified: '无法识别',
  }[kind];
}

export function carrierClaimStatusLabel(status: CarrierClaimStatus): string {
  return { pending: '处理中', approved: '已同意', rejected: '已拒赔', paid: '已赔付' }[status];
}

export function returnQuantityDifferenceSummary(returnPackage: {
  status: AftersalesReturnStatus;
  items: readonly {
    plannedQuantity?: number;
    quantity?: number;
    sourceTitle?: string;
    sourceSpec?: string;
    receivedQuantity: number;
    acceptedQuantity: number;
  }[];
}): string[] {
  return returnPackage.items.flatMap((item) => {
    const planned = item.plannedQuantity ?? item.quantity ?? 0;
    const label = item.sourceTitle
      ? `${item.sourceTitle}${item.sourceSpec ? ` · ${item.sourceSpec}` : ''}：`
      : '';
    const differences: string[] = [];
    if (returnPackage.status !== 'in_transit' && item.receivedQuantity < planned) {
      differences.push(`${label}计划与收到相差 ${planned - item.receivedQuantity} 件`);
    } else if (returnPackage.status !== 'in_transit' && item.receivedQuantity > planned) {
      differences.push(`${label}实际多收到 ${item.receivedQuantity - planned} 件`);
    }
    if (returnPackage.status === 'inspected' && item.acceptedQuantity < item.receivedQuantity) {
      differences.push(`${label}收到与检查通过相差 ${item.receivedQuantity - item.acceptedQuantity} 件`);
    }
    return differences;
  });
}

export function shipmentRecordsAftersalesSummary(
  records: readonly ShipmentRecord[],
  cases: readonly AftersalesCase[],
): string {
  const matching = aftersalesCasesForShipmentRecords(records, cases);
  if (matching.length === 0) return '无售后';
  const counts = matching.reduce((summary, aftersalesCase) => {
    summary.set(aftersalesCase.status, (summary.get(aftersalesCase.status) ?? 0) + 1);
    return summary;
  }, new Map<AftersalesStatus, number>());
  return [...counts].map(([status, count]) => (
    `${aftersalesStatusLabel(status)} ${count}`
  )).join('、');
}

export function shipmentRecordAftersalesSummary(
  record: ShipmentRecord,
  cases: readonly AftersalesCase[],
): string {
  return shipmentRecordsAftersalesSummary([record], cases);
}

export function aftersalesCurrentAction(
  records: readonly ShipmentRecord[],
  cases: readonly AftersalesCase[],
): string | null {
  const matchingCases = aftersalesCasesForShipmentRecords(records, cases)
    .map((aftersalesCase) => ({
      status: aftersalesCase.status,
      returnStatuses: aftersalesCase.returns.map(({ status }) => status),
      returnLogisticsStatuses: aftersalesCase.returns.map(({ logisticsStatus }) => logisticsStatus),
      carrierClaimStatuses: aftersalesCase.returns.flatMap(({ carrierClaim }) => (
        carrierClaim ? [carrierClaim.status] : []
      )),
      hasUnresolvedLogisticsException: aftersalesCase.returns.some(({ currentException }) => (
        currentException !== null
        && isUnresolvedLogisticsExceptionStage(currentException.stage)
      )),
    }));
  return aftersalesTodoForCases(matchingCases);
}

export function aftersalesCasesForShipmentRecords(
  records: readonly ShipmentRecord[],
  cases: readonly AftersalesCase[],
): AftersalesCase[] {
  const recordIds = new Set(records.map(({ id }) => id));
  return cases.filter((aftersalesCase) => (
    recordIds.has(aftersalesCase.shipmentRecordId)
    || aftersalesCase.rounds.some(({ replacementShipment }) => (
      replacementShipment !== null && recordIds.has(replacementShipment.id)
    ))
  ));
}

export function hasActiveParentAftersalesCase(
  record: ShipmentRecord,
  cases: readonly AftersalesCase[],
): boolean {
  if (record.sourceRecordRole !== 'aftersales_replacement') return false;
  return cases.some((aftersalesCase) => (
    aftersalesCase.status !== 'completed'
    && aftersalesCase.status !== 'cancelled'
    && aftersalesCase.rounds.some(({ replacementShipment }) => (
      replacementShipment?.id === record.id
    ))
  ));
}
