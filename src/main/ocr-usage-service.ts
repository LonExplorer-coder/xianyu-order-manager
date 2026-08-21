import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type {
  OcrCallRecorder,
  OcrCallRecorded,
  OcrMonthlyUsage,
  OcrUsageEventRecord,
  OcrUsageQuotaSettings,
  OcrUsageView,
  SaveOcrUsageQuotaInput,
} from '../core/ocr-usage';
import { OcrQuotaPausedError } from '../core/ocr-usage';
import type { OcrUsageSettingsRepository } from './ocr-usage-settings-file';

export interface OcrUsageEventStore {
  recordOcrUsageEvent(event: OcrUsageEventRecord): void;
  queryOcrMonthlyUsage(fromIso: string, toIso: string): OcrMonthlyUsage;
  queryRecentOcrUsageEvents(limit: number): OcrUsageEventRecord[];
  importWorkspaceEvents(
    workspaceKey: string,
    events: readonly OcrUsageEventRecord[],
  ): void;
}

const MAX_MONTHLY_LIMIT_CENTS = 10_000_000;
const MAX_ESTIMATED_PRICE_PER_CALL_CENTS = 100_000;
type OcrUsageOperationContext = {
  workspaceKey: string;
  estimatedPricePerCallCents: number;
};

export interface OcrPaidOperationRunner {
  runPaidOperation<T>(operation: () => Promise<T>): Promise<T>;
}

export class OcrUsageWorkspace implements OcrPaidOperationRunner {
  public constructor(
    private readonly owner: OcrUsageService,
    public readonly workspaceKey: string,
  ) {}

  public runPaidOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.owner.runPaidOperation(this.workspaceKey, operation);
  }
}

export class OcrUsageService implements OcrCallRecorder {
  private settings: OcrUsageQuotaSettings;
  private readonly operationContext = new AsyncLocalStorage<OcrUsageOperationContext>();
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly repository: OcrUsageSettingsRepository,
    private readonly eventStore: OcrUsageEventStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.settings = repository.read();
  }

  public forDataDirectory(dataDirectory: string): OcrUsageWorkspace {
    const workspaceKey = createHash('sha256').update(resolve(dataDirectory)).digest('hex');
    return new OcrUsageWorkspace(this, workspaceKey);
  }

  public importWorkspaceEvents(
    dataDirectory: string,
    events: readonly OcrUsageEventRecord[],
  ): void {
    try {
      this.eventStore.importWorkspaceEvents(
        this.forDataDirectory(dataDirectory).workspaceKey,
        events,
      );
    } catch (error) {
      throw new Error('无法导入旧 OCR 用量事件，已阻止付费调用', { cause: error });
    }
  }

  public runPaidOperation<T>(workspaceKey: string, operation: () => Promise<T>): Promise<T> {
    const execute = () => {
      this.assertCanProceed();
      return this.operationContext.run({
        workspaceKey,
        estimatedPricePerCallCents: this.settings.estimatedPricePerCallCents,
      }, operation);
    };
    const result = this.operationTail.then(execute, execute);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  public recordCall(call: OcrCallRecorded): void {
    const operation = this.operationContext.getStore();
    if (!operation) {
      console.warn('已忽略脱离付费操作的 OCR 用量事件');
      return;
    }
    try {
      this.eventStore.recordOcrUsageEvent({
        id: randomUUID(),
        workspaceKey: operation.workspaceKey,
        kind: call.kind,
        outcome: call.outcome,
        provider: call.provider,
        model: call.model,
        ...(call.requestId ? { requestId: call.requestId } : {}),
        occurredAt: call.occurredAt ?? new Date().toISOString(),
        estimatedCents:
          call.outcome === 'success'
            ? operation.estimatedPricePerCallCents
            : 0,
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
      recentEvents: this.eventStore.queryRecentOcrUsageEvents(50),
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
    const nextSettings: OcrUsageQuotaSettings = {
      monthlyLimitCents,
      mode: input.mode,
      estimatedPricePerCallCents,
      // 调整额度视为用户主动处置暂停状态，暂停与放行标记一并复位。
      pausedMonth: null,
      resumedMonth: null,
    };
    this.repository.write(nextSettings);
    this.settings = nextSettings;
    return this.getView();
  }

  public confirmResume(): OcrUsageView {
    const { key } = monthRangeAt(this.now());
    if (this.settings.pausedMonth !== null || this.settings.resumedMonth !== key) {
      const nextSettings: OcrUsageQuotaSettings = {
        ...this.settings,
        pausedMonth: null,
        resumedMonth: key,
      };
      this.repository.write(nextSettings);
      this.settings = nextSettings;
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
      const nextSettings = { ...this.settings, pausedMonth: key };
      try {
        this.repository.write(nextSettings);
        this.settings = nextSettings;
      } catch (error) {
        throw new OcrQuotaPausedError({ cause: error });
      }
    }
    throw new OcrQuotaPausedError();
  }

  private isOverLimit(estimatedCostCents: number): boolean {
    return this.settings.monthlyLimitCents > 0 &&
      estimatedCostCents >= this.settings.monthlyLimitCents;
  }

  private currentMonthlyUsage(): OcrMonthlyUsage {
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
