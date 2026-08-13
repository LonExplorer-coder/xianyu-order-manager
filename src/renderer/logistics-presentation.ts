import type {
  LogisticsExceptionStage,
  LogisticsExceptionType,
} from '../core/logistics-exceptions';

export { nextLogisticsExceptionStages } from '../core/logistics-exceptions';

export const LOGISTICS_EXCEPTION_TYPE_OPTIONS = [
  { value: 'lost', label: '丢件' },
  { value: 'delivery_dispute', label: '签收争议' },
  { value: 'damaged', label: '运输破损' },
  { value: 'misdelivered', label: '错投' },
  { value: 'other', label: '其他物流异常' },
] as const satisfies ReadonlyArray<{ value: LogisticsExceptionType; label: string }>;

export function logisticsExceptionTypeLabel(type: LogisticsExceptionType): string {
  return LOGISTICS_EXCEPTION_TYPE_OPTIONS.find((option) => option.value === type)?.label
    ?? '其他物流异常';
}

export function logisticsExceptionStageLabel(stage: LogisticsExceptionStage): string {
  return {
    pending_verification: '待核实',
    investigating: '调查中',
    confirmed: '已确认',
    recovered: '已找回',
    resolved: '已解决',
  }[stage];
}
