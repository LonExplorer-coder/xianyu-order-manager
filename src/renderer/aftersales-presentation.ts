import {
  AFTERSALES_STATUSES,
  type AftersalesCase,
  type AftersalesStatus,
} from '../core/aftersales-cases';
import {
  aftersalesStatusLabel,
  aftersalesTodoForCases,
} from '../core/order-operations-projection';
import type { ShipmentRecord } from '../core/shipment-records';

export const AFTERSALES_STATUS_OPTIONS: ReadonlyArray<{
  value: AftersalesStatus;
  label: string;
}> = AFTERSALES_STATUSES
  .filter((value) => value !== 'ready_to_complete')
  .map((value) => ({ value, label: aftersalesStatusLabel(value) }));

export { aftersalesStatusLabel };

export function shipmentRecordsAftersalesSummary(
  records: readonly ShipmentRecord[],
  cases: readonly AftersalesCase[],
): string {
  const recordIds = new Set(records.map(({ id }) => id));
  const matching = cases.filter(({ shipmentRecordId }) => recordIds.has(shipmentRecordId));
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
  const recordIds = new Set(records.map(({ id }) => id));
  const matchingCases = cases
    .filter((aftersalesCase) => (
      recordIds.has(aftersalesCase.shipmentRecordId)
    ))
    .map((aftersalesCase) => ({
      status: aftersalesCase.status,
      returnStatuses: aftersalesCase.returns.map(({ status }) => status),
    }));
  return aftersalesTodoForCases(matchingCases);
}
