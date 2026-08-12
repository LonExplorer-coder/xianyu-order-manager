import type { AftersalesCase, AftersalesStatus } from '../core/aftersales-cases';
import { aftersalesTodoForStatuses } from '../core/order-operations-projection';
import type { ShipmentRecord } from '../core/shipment-records';

export const AFTERSALES_STATUS_OPTIONS: ReadonlyArray<{
  value: AftersalesStatus;
  label: string;
}> = [
  { value: 'processing', label: '处理中' },
  { value: 'waiting_return', label: '等待退回' },
  { value: 'waiting_inspection', label: '等待检查' },
  { value: 'waiting_refund', label: '等待退款' },
  { value: 'waiting_replacement', label: '等待补发' },
  { value: 'partially_completed', label: '部分完成' },
  { value: 'completed', label: '已完成' },
];

export function aftersalesStatusLabel(status: AftersalesStatus): string {
  return AFTERSALES_STATUS_OPTIONS.find(({ value }) => value === status)?.label ?? status;
}

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
  const statuses = new Set(cases
    .filter((aftersalesCase) => (
      recordIds.has(aftersalesCase.shipmentRecordId) && aftersalesCase.status !== 'completed'
    ))
    .map(({ status }) => status));
  return aftersalesTodoForStatuses(statuses);
}
