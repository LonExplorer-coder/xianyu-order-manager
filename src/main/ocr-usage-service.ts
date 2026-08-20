import { randomUUID } from 'node:crypto';

import type {
  OcrCallRecorder,
  OcrCallRecorded,
  OcrMonthlyUsage,
  OcrUsageEventRecord,
  OcrUsageQuotaSettings,
  OcrUsageView,
  SaveOcrUsageQuotaInput,
} from '../core/ocr-usage';
import type { OcrUsageSettingsRepository } from './ocr-usage-settings-file';

export interface OcrUsageEventStore {
  recordOcrUsageEvent(event: OcrUsageEventRecord): void;
  queryOcrMonthlyUsage(fromIso: string, toIso: string): OcrMonthlyUsage;
  queryRecentOcrUsageEvents(limit: number): OcrUsageEventRecord[];
}

const MAX_MONTHLY_LIMIT_CENTS = 10_000_000;
const MAX_ESTIMATED_PRICE_PER_CALL_CENTS = 100_000;

export class OcrUsageService implements OcrCallRecorder {
  private settings: OcrUsageQuotaSettings;
  private eventStore: OcrUsageEventStore | null = null;

  public constructor(
    private readonly repository: OcrUsageSettingsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.settings = repository.read();
  }

  public bindEventStore(eventStore: OcrUsageEventStore | null): void {
    this.eventStore = eventStore;
  }

  public recordCall(call: OcrCallRecorded): void {
    const store = this.eventStore;
    if (!store) return;
    try {
      store.recordOcrUsageEvent({
        id: randomUUID(),
        kind: call.kind,
        outcome: call.outcome,
        provider: call.provider,
        model: call.model,
        ...(call.requestId ? { requestId: call.requestId } : {}),
        occurredAt: call.occurredAt ?? new Date().toISOString(),
        estimatedCents:
          call.outcome === 'success' ? this.settings.estimatedPricePerCallCents : 0,
      });
    } catch (error) {
      // 用量记录是旁路监控，写入失败不能影响识别或连接测试主流程。
      console.warn('无法记录 OCR 用量事件', error);
    }
  }

  public getView(): OcrUsageView {
    const { key } = monthRangeAt(this.now());
    const usage = this.currentMonthlyUsage();
    return {
      month: key,
      usage,
      quota: { ...this.settings },
      hardPaused:
        this.settings.mode === 'hard_stop' && this.settings.pausedMonth === key,
      overLimit: this.isOverLimit(usage.estimatedCostCents),
      recentEvents: this.eventStore?.queryRecentOcrUsageEvents(50) ?? [],
    };
  }

  public saveQuota(input: SaveOcrUsageQuotaInput): OcrUsageView {
    const monthlyLimitCents = Number(input.monthlyLimitCents);
    const estimatedPricePerCallCents = Number(input.estimatedPricePerCallCents);
    if (
      !Number.isSafeInteger(monthlyLimitCents) ||
      monthlyLimitCents < 0 ||
      monthlyLimitCents > MAX_MONTHLY_LIMIT_CENTS
    ) {
      throw new Error('月度额度必须是 0 到 100000 元之间的整数');
    }
    if (
      !Number.isSafeInteger(estimatedPricePerCallCents) ||
      estimatedPricePerCallCents < 0 ||
      estimatedPricePerCallCents > MAX_ESTIMATED_PRICE_PER_CALL_CENTS
    ) {
      throw new Error('单次估算单价必须是 0 到 1000 元之间的整数');
    }
    if (input.mode !== 'remind' && input.mode !== 'hard_stop') {
      throw new Error('额度模式无效');
    }
    this.settings = {
      monthlyLimitCents,
      mode: input.mode,
      estimatedPricePerCallCents,
      // 调整额度视为用户主动处置暂停状态，暂停与放行标记一并复位。
      pausedMonth: null,
      resumedMonth: null,
    };
    this.repository.write(this.settings);
    return this.getView();
  }

  public confirmResume(): OcrUsageView {
    const { key } = monthRangeAt(this.now());
    if (this.settings.pausedMonth !== null || this.settings.resumedMonth !== key) {
      this.settings = {
        ...this.settings,
        pausedMonth: null,
        resumedMonth: key,
      };
      this.repository.write(this.settings);
    }
    return this.getView();
  }

  public assertCanProceed(): void {
    if (this.settings.mode !== 'hard_stop') return;
    const { key } = monthRangeAt(this.now());
    if (this.settings.resumedMonth === key) return;
    if (!this.isOverLimit(this.currentMonthlyUsage().estimatedCostCents)) {
      return;
    }
    if (this.settings.pausedMonth !== key) {
      this.settings = { ...this.settings, pausedMonth: key };
      this.repository.write(this.settings);
    }
    throw new Error('本月 OCR 用量已达硬暂停额度，请在设置中调整额度或确认继续');
  }

  private isOverLimit(estimatedCostCents: number): boolean {
    return this.settings.monthlyLimitCents > 0 &&
      estimatedCostCents >= this.settings.monthlyLimitCents;
  }

  private currentMonthlyUsage(): OcrMonthlyUsage {
    if (!this.eventStore) {
      return { totalCalls: 0, succeededCalls: 0, failedCalls: 0, estimatedCostCents: 0 };
    }
    const { fromIso, toIso } = monthRangeAt(this.now());
    return this.eventStore.queryOcrMonthlyUsage(fromIso, toIso);
  }
}

export function monthRangeAt(date: Date): {
  key: string;
  fromIso: string;
  toIso: string;
} {
  const year = date.getFullYear();
  const month = date.getMonth();
  const key = `${year}-${String(month + 1).padStart(2, '0')}`;
  return {
    key,
    fromIso: new Date(year, month, 1).toISOString(),
    toIso: new Date(year, month + 1, 1).toISOString(),
  };
}
