export type OcrCallKind = 'recognition' | 'connection_test' | 'candidate_adjudication';

export type OcrCallOutcome = 'success' | 'failure';

export type OcrQuotaMode = 'remind' | 'hard_stop';

export const DEFAULT_OCR_MONTHLY_LIMIT_CENTS = 1_000;
export const DEFAULT_OCR_ESTIMATED_PRICE_PER_CALL_CENTS = 5;

export type OcrUsageQuotaSettings = {
  /** 每月估算费用上限，单位分。 */
  monthlyLimitCents: number;
  mode: OcrQuotaMode;
  /** 每次成功付费调用的估算单价，单位分。 */
  estimatedPricePerCallCents: number;
  /** 已撞线暂停的月份（'YYYY-MM'）；null 表示未暂停。 */
  pausedMonth: string | null;
  /** 已确认继续放行的月份（'YYYY-MM'）；该月内不再自动暂停。 */
  resumedMonth: string | null;
};

export type OcrCallRecorded = {
  kind: OcrCallKind;
  outcome: OcrCallOutcome;
  provider: string;
  model: string;
  requestId?: string;
  occurredAt?: string;
};

export type OcrUsageEventRecord = Omit<OcrCallRecorded, 'occurredAt'> & {
  id: string;
  /** ISO 毫秒时间；事件记录由服务层保证必有值。 */
  occurredAt: string;
  /** 成功调用按当时单价估算的费用，分；失败调用为 0。 */
  estimatedCents: number;
};

export type OcrMonthlyUsage = {
  totalCalls: number;
  succeededCalls: number;
  failedCalls: number;
  estimatedCostCents: number;
};

export type OcrUsageView = {
  /** 当前统计月份（'YYYY-MM'，本地时区）。 */
  month: string;
  usage: OcrMonthlyUsage;
  quota: OcrUsageQuotaSettings;
  /** 硬暂停模式且本月已撞线。 */
  hardPaused: boolean;
  /** 本月估算费用已达到额度。 */
  overLimit: boolean;
  recentEvents: OcrUsageEventRecord[];
};

export type SaveOcrUsageQuotaInput = {
  monthlyLimitCents: number;
  mode: OcrQuotaMode;
  estimatedPricePerCallCents: number;
};

export interface OcrCallRecorder {
  recordCall(call: OcrCallRecorded): void;
}
