import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type {
  OcrMonthlyUsage,
  OcrUsageEventRecord,
  OcrUsageQuotaSettings,
} from '../src/core/ocr-usage';
import {
  OcrUsageService,
  type OcrUsageEventStore,
} from '../src/main/ocr-usage-service';
import {
  OcrUsageSettingsFile,
  type OcrUsageSettingsRepository,
} from '../src/main/ocr-usage-settings-file';

class MemoryUsageSettingsRepository implements OcrUsageSettingsRepository {
  public constructor(public settings: OcrUsageQuotaSettings | null = null) {}

  public read(): OcrUsageQuotaSettings {
    return this.settings ?? {
      monthlyLimitCents: 1_000,
      mode: 'remind',
      estimatedPricePerCallCents: 5,
      pausedMonth: null,
      resumedMonth: null,
    };
  }

  public write(settings: OcrUsageQuotaSettings): void {
    this.settings = structuredClone(settings);
  }
}

class MemoryUsageEventStore implements OcrUsageEventStore {
  public readonly events: OcrUsageEventRecord[] = [];

  public recordOcrUsageEvent(event: OcrUsageEventRecord): void {
    this.events.push(structuredClone(event));
  }

  public queryOcrMonthlyUsage(fromIso: string, toIso: string): OcrMonthlyUsage {
    const monthEvents = this.events.filter(
      (event) => event.occurredAt >= fromIso && event.occurredAt < toIso,
    );
    return {
      totalCalls: monthEvents.length,
      succeededCalls: monthEvents.filter((event) => event.outcome === 'success').length,
      failedCalls: monthEvents.filter((event) => event.outcome === 'failure').length,
      estimatedCostCents: monthEvents.reduce(
        (total, event) => total + event.estimatedCents,
        0,
      ),
    };
  }

  public queryRecentOcrUsageEvents(limit: number): OcrUsageEventRecord[] {
    return this.events.slice(0, limit);
  }
}

function createService(
  repository = new MemoryUsageSettingsRepository(),
  now = new Date('2026-08-15T10:00:00+08:00'),
): {
  service: OcrUsageService;
  store: MemoryUsageEventStore;
  repository: MemoryUsageSettingsRepository;
} {
  const store = new MemoryUsageEventStore();
  const service = new OcrUsageService(repository, () => now);
  service.bindEventStore(store);
  return { service, store, repository };
}

describe('OCR 用量监控', () => {
  it('成功调用按单价计入估算费用，失败调用不计费', () => {
    const { service, store } = createService();
    service.recordCall({
      kind: 'recognition',
      outcome: 'success',
      provider: 'aliyun-bailian',
      model: 'qwen3.5-ocr',
    });
    service.recordCall({
      kind: 'recognition',
      outcome: 'failure',
      provider: 'aliyun-bailian',
      model: 'qwen3.5-ocr',
    });
    service.recordCall({
      kind: 'candidate_adjudication',
      outcome: 'success',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    expect(store.events).toHaveLength(3);
    expect(store.events[0]).toMatchObject({
      kind: 'recognition',
      outcome: 'success',
      provider: 'aliyun-bailian',
      estimatedCents: 5,
    });
    expect(store.events[1]).toMatchObject({ outcome: 'failure', estimatedCents: 0 });
    expect(store.events[2]).toMatchObject({
      kind: 'candidate_adjudication',
      provider: 'deepseek',
      estimatedCents: 5,
    });

    const view = service.getView();
    expect(view.usage).toEqual({
      totalCalls: 3,
      succeededCalls: 2,
      failedCalls: 1,
      estimatedCostCents: 10,
    });
    expect(view.month).toBe('2026-08');
  });

  it('按本地时区自然月统计，不跨月串号', () => {
    const repository = new MemoryUsageSettingsRepository();
    const store = new MemoryUsageEventStore();
    const now = new Date('2026-08-01T00:30:00+08:00');
    const service = new OcrUsageService(repository, () => now);
    service.bindEventStore(store);
    service.recordCall({
      kind: 'recognition',
      outcome: 'success',
      provider: 'aliyun-bailian',
      model: 'qwen3.5-ocr',
      occurredAt: '2026-08-01T00:30:00+08:00',
    });
    // 北京 8 月 1 日 00:30 对应 UTC 7 月 31 日 16:30；按本地月统计应计入 8 月。
    expect(service.getView().usage.totalCalls).toBe(1);
  });

  it('未绑定事件存储时静默跳过记录', () => {
    const repository = new MemoryUsageSettingsRepository();
    const service = new OcrUsageService(repository, () => new Date('2026-08-15T10:00:00+08:00'));
    expect(() => {
      service.recordCall({
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      });
    }).not.toThrow();
    expect(service.getView().usage).toEqual({
      totalCalls: 0,
      succeededCalls: 0,
      failedCalls: 0,
      estimatedCostCents: 0,
    });
  });

  it('事件存储写入失败时记录调用不抛出，不影响识别主流程', () => {
    const repository = new MemoryUsageSettingsRepository();
    const service = new OcrUsageService(repository, () => new Date('2026-08-15T10:00:00+08:00'));
    service.bindEventStore({
      recordOcrUsageEvent: () => {
        throw new Error('磁盘写入失败');
      },
      queryOcrMonthlyUsage: () => ({
        totalCalls: 0,
        succeededCalls: 0,
        failedCalls: 0,
        estimatedCostCents: 0,
      }),
      queryRecentOcrUsageEvents: () => [],
    });
    expect(() => {
      service.recordCall({
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      });
    }).not.toThrow();
    expect(service.getView().usage.totalCalls).toBe(0);
  });

  it('默认仅提醒，不拦截付费调用', () => {
    const { service } = createService();
    for (let index = 0; index < 200; index += 1) {
      service.recordCall({
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      });
    }
    expect(() => service.assertCanProceed()).not.toThrow();
    expect(service.getView().overLimit).toBe(true);
    expect(service.getView().hardPaused).toBe(false);
  });

  it('额度为 0 表示不设额度：即使已有费用也不提醒不暂停', () => {
    const { service } = createService();
    service.saveQuota({
      monthlyLimitCents: 0,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 5,
    });
    for (let index = 0; index < 200; index += 1) {
      service.recordCall({
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      });
    }
    expect(service.getView().overLimit).toBe(false);
    expect(service.getView().hardPaused).toBe(false);
    expect(() => service.assertCanProceed()).not.toThrow();
  });

  it('硬暂停：达到额度后在下一次付费调用前拦截，并只记录一次暂停月份', () => {
    const { service, repository } = createService();
    service.saveQuota({
      monthlyLimitCents: 100,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 5,
    });
    expect(repository.read().pausedMonth).toBeNull();
    for (let index = 0; index < 20; index += 1) {
      service.recordCall({
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      });
    }
    expect(repository.read().pausedMonth).toBeNull();
    expect(() => service.assertCanProceed()).toThrow(/硬暂停额度/u);
    expect(repository.read().pausedMonth).toBe('2026-08');
    expect(service.getView().hardPaused).toBe(true);
    // 再次检查不会重复写设置文件。
    expect(() => service.assertCanProceed()).toThrow(/硬暂停额度/u);
    expect(repository.read().pausedMonth).toBe('2026-08');
  });

  it('确认继续后本月不再拦截，下个月自动恢复拦截', () => {
    const { service, store, repository } = createService();
    service.saveQuota({
      monthlyLimitCents: 100,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 5,
    });
    for (let index = 0; index < 20; index += 1) {
      service.recordCall({
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      });
    }
    expect(() => service.assertCanProceed()).toThrow(/硬暂停额度/u);
    const resumed = service.confirmResume();
    expect(resumed.hardPaused).toBe(false);
    expect(repository.read().pausedMonth).toBeNull();
    expect(() => service.assertCanProceed()).not.toThrow();

    // 跨月后累计费用仍超额度，重新进入暂停。
    for (let index = 0; index < 20; index += 1) {
      store.recordOcrUsageEvent({
        id: `september-event-${index}`,
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
        occurredAt: '2026-09-02T10:00:00.000Z',
        estimatedCents: 5,
      });
    }
    const nextMonth = new Date('2026-09-01T00:00:00+08:00');
    const secondService = new OcrUsageService(repository, () => nextMonth);
    secondService.bindEventStore(store);
    expect(() => secondService.assertCanProceed()).toThrow(/硬暂停额度/u);
    expect(repository.read().pausedMonth).toBe('2026-09');
  });

  it('调整额度视为主动处置暂停状态，并校验输入', () => {
    const { service, repository } = createService();
    const quota = repository.read();
    repository.write({
      ...quota,
      mode: 'hard_stop',
      monthlyLimitCents: 100,
      pausedMonth: '2026-08',
      resumedMonth: null,
    });
    const view = service.saveQuota({
      monthlyLimitCents: 50_000,
      mode: 'remind',
      estimatedPricePerCallCents: 3,
    });
    expect(view.quota).toEqual({
      monthlyLimitCents: 50_000,
      mode: 'remind',
      estimatedPricePerCallCents: 3,
      pausedMonth: null,
      resumedMonth: null,
    });
    expect(repository.read().pausedMonth).toBeNull();
    expect(() => service.saveQuota({
      monthlyLimitCents: -1,
      mode: 'remind',
      estimatedPricePerCallCents: 3,
    })).toThrow(/月度额度/u);
    expect(() => service.saveQuota({
      monthlyLimitCents: 100,
      mode: 'hard_stop',
      estimatedPricePerCallCents: Number.NaN,
    })).toThrow(/单次估算单价/u);
  });

  it('设置文件读写与默认值', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'ocr-usage-settings-'));
    const file = new OcrUsageSettingsFile(configDirectory);
    expect(file.read()).toEqual({
      monthlyLimitCents: 1_000,
      mode: 'remind',
      estimatedPricePerCallCents: 5,
      pausedMonth: null,
      resumedMonth: null,
    });
    file.write({
      monthlyLimitCents: 2_000,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 8,
      pausedMonth: '2026-08',
      resumedMonth: null,
    });
    const persisted = JSON.parse(await readFile(
      join(configDirectory, 'ocr-usage-settings.json'),
      'utf8',
    )) as OcrUsageQuotaSettings;
    expect(persisted).toEqual({
      monthlyLimitCents: 2_000,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 8,
      pausedMonth: '2026-08',
      resumedMonth: null,
    });
    expect(file.read()).toEqual(persisted);
  });

  it('损坏的设置文件抛错而不是静默使用默认值', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'ocr-usage-settings-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(configDirectory, 'ocr-usage-settings.json'),
      '{ "monthlyLimitCents": "not-a-number" }',
      'utf8',
    );
    const file = new OcrUsageSettingsFile(configDirectory);
    expect(() => file.read()).toThrow(/无法读取 OCR 用量设置/u);
  });
});
