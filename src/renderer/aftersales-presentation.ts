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
  coordinateAftersalesOrderOperations,
  type AftersalesOperationsCoordinationInput,
  type OrderOperationsCoordination,
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

export function aftersalesCaseOperationsCoordination(
  aftersalesCase: AftersalesCase,
): OrderOperationsCoordination {
  const scopedReturns = aftersalesReturnsForPresentation(aftersalesCase);
  return coordinateAftersalesOrderOperations({
    id: aftersalesCase.id,
    shipmentRecordId: aftersalesCase.shipmentRecordId,
    status: aftersalesCase.status,
    currentTodo: aftersalesCase.coordination.currentTodo,
    updatedAt: aftersalesCase.updatedAt,
    itemQuantity: aftersalesCase.items.reduce((total, item) => total + item.quantity, 0),
    refund: aftersalesCase.refund ? {
      status: aftersalesCase.refund.status,
      requestedAmountCents: aftersalesCase.refund.requestedAmountCents,
      occurredAt: aftersalesCase.refund.latestEventAt,
    } : null,
    outboundClaims: aftersalesCase.coordination.sourcePackages.flatMap((sourcePackage) => (
      sourcePackage.carrierClaim
        ? outboundClaimForAftersalesSourcePackage(sourcePackage)
        : []
    )),
    outboundExceptions: aftersalesCase.coordination.outboundExceptionHistory.map((exception) => ({
      id: exception.exceptionId,
      stage: exception.stage,
      affectedQuantity: exception.affectedQuantity,
      occurredAt: exception.occurredAt,
      requiresDecision: exception.stage === 'confirmed' && exception.decision === null,
    })),
    returns: scopedReturns.map((returnRecord) => ({
      id: returnRecord.id,
      status: returnRecord.status,
      logisticsStatus: returnRecord.logisticsStatus,
      updatedAt: returnRecord.updatedAt,
      exceptions: returnRecord.logisticsExceptions.map((exception) => ({
        id: exception.id,
        exceptionType: exception.exceptionType,
        stage: exception.stage,
        affectedQuantity: exception.impact.scope === 'package'
          ? returnRecord.items.reduce((total, item) => total + item.quantity, 0)
          : exception.impact.items.reduce((total, item) => total + item.quantity, 0),
        occurredAt: exception.occurredAt,
      })),
      claim: returnRecord.carrierClaim ? {
        status: returnRecord.carrierClaim.status,
        updatedAt: returnRecord.carrierClaim.timeline.at(-1)?.occurredAt
          ?? returnRecord.carrierClaim.updatedAt,
        affectedQuantity: returnRecord.carrierClaim.impact.scope === 'package'
          ? returnRecord.items.reduce((total, item) => total + item.quantity, 0)
          : returnRecord.carrierClaim.impact.items.reduce(
            (total, item) => total + item.quantity,
            0,
          ),
      } : null,
    })),
    hasPendingReturnExceptionDecision: aftersalesCase.coordination.returnException !== null
      && aftersalesCase.coordination.returnException.decision === null,
  });
}

export function aftersalesReturnsForPresentation(
  aftersalesCase: AftersalesCase,
): AftersalesCase['returns'] {
  const caseShipmentItemIds = new Set(aftersalesCase.items.map(({ shipmentPackageItemId }) => (
    shipmentPackageItemId
  )));
  return aftersalesCase.returns.flatMap((returnRecord) => {
    const items = returnRecord.items.filter(({ shipmentPackageItemId }) => (
      caseShipmentItemIds.has(shipmentPackageItemId)
    ));
    if (items.length === 0) return [];
    const visibleReturnItemIds = new Set(items.map(({ id }) => id));
    const visibleShipmentItemIds = new Set(items.map(({ shipmentPackageItemId }) => (
      shipmentPackageItemId
    )));
    const logisticsExceptions = returnRecord.logisticsExceptions.flatMap((exception) => {
      if (exception.impact.scope === 'package') return [exception];
      const affectedItems = exception.impact.items.filter(({ sourceItemId }) => (
        visibleReturnItemIds.has(sourceItemId)
      ));
      return affectedItems.length === 0 ? [] : [{
        ...exception,
        impact: { scope: 'items' as const, items: affectedItems },
      }];
    });
    const claim = returnRecord.carrierClaim;
    const scopedClaim = claim?.impact.scope === 'package'
      ? claim
      : claim
        ? (() => {
          const affectedItems = claim.impact.items.filter(({ sourceItemId }) => (
            visibleReturnItemIds.has(sourceItemId)
          ));
          return affectedItems.length === 0 ? null : {
            ...claim,
            impact: { scope: 'items' as const, items: affectedItems },
          };
        })()
        : null;
    const timeline = returnRecord.timeline.map((event) => {
      if (event.kind === 'items_combined') return {
        ...event,
        items: event.items.filter(({ shipmentPackageItemId }) => (
          visibleShipmentItemIds.has(shipmentPackageItemId)
        )),
      };
      if (event.kind === 'received') return {
        ...event,
        ...(event.items === undefined ? {} : {
          items: event.items.filter(({ returnRecordItemId }) => (
            visibleReturnItemIds.has(returnRecordItemId)
          )),
        }),
        ...(event.discrepancies === undefined ? {} : {
          discrepancies: event.discrepancies.filter((difference) => (
            difference.returnRecordItemId === undefined
            || visibleReturnItemIds.has(difference.returnRecordItemId)
          )),
        }),
      };
      if (event.kind === 'inspected') return {
        ...event,
        ...(event.items === undefined ? {} : {
          items: event.items.filter(({ returnRecordItemId }) => (
            visibleReturnItemIds.has(returnRecordItemId)
          )),
        }),
        ...(event.discrepancies === undefined ? {} : {
          discrepancies: event.discrepancies.filter((difference) => (
            difference.returnRecordItemId === undefined
            || visibleReturnItemIds.has(difference.returnRecordItemId)
          )),
        }),
      };
      return event;
    });
    return [{
      ...returnRecord,
      items,
      discrepancies: returnRecord.discrepancies.filter((difference) => (
        difference.returnRecordItemId === undefined
        || visibleReturnItemIds.has(difference.returnRecordItemId)
      )),
      logisticsExceptions,
      currentException: [...logisticsExceptions].reverse().find(({ stage }) => (
        isUnresolvedLogisticsExceptionStage(stage)
      )) as AftersalesCase['returns'][number]['currentException'] ?? null,
      carrierClaim: scopedClaim,
      timeline,
    }];
  });
}

function outboundClaimForAftersalesSourcePackage(
  sourcePackage: AftersalesCase['coordination']['sourcePackages'][number],
): AftersalesOperationsCoordinationInput['outboundClaims'] {
  const claim = sourcePackage.carrierClaim;
  if (!claim) return [];
  const quantityByItemId = claim.impact.scope === 'package'
    ? null
    : new Map(claim.impact.items.map(({ sourceItemId, quantity }) => (
      [sourceItemId, quantity] as const
    )));
  const affectedQuantity = sourcePackage.items.reduce((total, item) => {
    const claimedQuantity = quantityByItemId?.get(item.shipmentPackageItemId);
    if (quantityByItemId && claimedQuantity === undefined) return total;
    return total + Math.min(item.quantity, claimedQuantity ?? item.quantity);
  }, 0);
  return affectedQuantity > 0 ? [{
    packageId: sourcePackage.packageId,
    status: claim.status,
    updatedAt: claim.updatedAt,
    affectedQuantity,
  }] : [];
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
