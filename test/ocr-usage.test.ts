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
import { LocalApplication } from '../src/main/local-application';

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

  public importWorkspaceEvents(
    workspaceKey: string,
    events: readonly OcrUsageEventRecord[],
  ): void {
    const existingIds = new Set(this.events.map(({ id }) => id));
    for (const event of events) {
      if (existingIds.has(event.id)) continue;
      this.events.push({ ...event, workspaceKey });
      existingIds.add(event.id);
    }
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
  const service = new OcrUsageService(repository, store, () => now);
  return { service, store, repository };
}

function seedSuccessfulUsage(
  store: MemoryUsageEventStore,
  count: number,
  estimatedCents = 5,
): void {
  for (let index = 0; index < count; index += 1) {
    store.recordOcrUsageEvent({
      id: `seeded-usage-${store.events.length}-${index}`,
      workspaceKey: '1'.repeat(64),
      kind: 'recognition',
      outcome: 'success',
      provider: 'aliyun-bailian',
      model: 'qwen3.5-ocr',
      occurredAt: '2026-08-15T02:00:00.000Z',
      estimatedCents,
    });
  }
}

describe('OCR 用量监控', () => {
  it('成功调用按单价计入估算费用，失败调用不计费', async () => {
    const { service, store } = createService();
    await service.forDataDirectory('/tmp/ocr-usage-recording').runPaidOperation(async () => {
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

  it('按本地时区自然月统计，不跨月串号', async () => {
    const repository = new MemoryUsageSettingsRepository();
    const store = new MemoryUsageEventStore();
    // 月中时刻，任何系统时区下都落在 8 月。
    const now = new Date('2026-08-15T10:00:00+08:00');
    const service = new OcrUsageService(repository, store, () => now);
    // 8 月 1 日 12:00 UTC：对全球任意时区都落在本地 8 月（UTC+14 最早、UTC-12 最晚）。
    // 月边界换算（如北京 8 月 1 日 00:30 = UTC 7 月 31 日 16:30）由 monthRangeAt 负责，
    // 此处只验证事件能按本地月正确归类。
    await service.forDataDirectory('/tmp/ocr-usage-month').runPaidOperation(async () => {
      service.recordCall({
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
        occurredAt: '2026-08-01T12:00:00.000Z',
      });
    });
    expect(service.getView().usage.totalCalls).toBe(1);
  });

  it('事件存储写入失败时记录调用不抛出，不影响识别主流程', async () => {
    const repository = new MemoryUsageSettingsRepository();
    const service = new OcrUsageService(repository, {
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
      importWorkspaceEvents: () => undefined,
    }, () => new Date('2026-08-15T10:00:00+08:00'));
    await expect(service.forDataDirectory('/tmp/ocr-usage-write-failure').runPaidOperation(async () => {
      service.recordCall({
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      });
    })).resolves.toBeUndefined();
    expect(service.getView().usage.totalCalls).toBe(0);
  });

  it('默认仅提醒，不拦截付费调用', () => {
    const { service, store } = createService();
    seedSuccessfulUsage(store, 200);
    expect(() => service.assertCanProceed()).not.toThrow();
    expect(service.getView().overLimit).toBe(true);
    expect(service.getView().hardPaused).toBe(false);
  });

  it('额度为 0 表示不设额度：即使已有费用也不提醒不暂停', () => {
    const { service, store } = createService();
    service.saveQuota({
      monthlyLimitCents: 0,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 5,
    });
    seedSuccessfulUsage(store, 200);
    expect(service.getView().overLimit).toBe(false);
    expect(service.getView().hardPaused).toBe(false);
    expect(() => service.assertCanProceed()).not.toThrow();
  });

  it('硬暂停：达到额度后在下一次付费调用前拦截，并只记录一次暂停月份', () => {
    const { service, store, repository } = createService();
    service.saveQuota({
      monthlyLimitCents: 100,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 5,
    });
    expect(repository.read().pausedMonth).toBeNull();
    seedSuccessfulUsage(store, 20);
    expect(repository.read().pausedMonth).toBeNull();
    expect(() => service.assertCanProceed()).toThrow(/硬暂停额度/u);
    expect(repository.read().pausedMonth).toBe('2026-08');
    expect(service.getView().hardPaused).toBe(true);
    // 再次检查不会重复写设置文件。
    expect(() => service.assertCanProceed()).toThrow(/硬暂停额度/u);
    expect(repository.read().pausedMonth).toBe('2026-08');
  });

  it('独立付费操作串行过闸，不能并发越过最后一次额度', async () => {
    const { service } = createService();
    service.saveQuota({
      monthlyLimitCents: 5,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 5,
    });
    const firstWorkspace = service.forDataDirectory('/tmp/ocr-usage-a');
    const secondWorkspace = service.forDataDirectory('/tmp/ocr-usage-b');
    let releaseFirst!: () => void;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    const first = firstWorkspace.runPaidOperation(async () => {
      await firstBarrier;
      service.recordCall({
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      });
    });
    const second = secondWorkspace.runPaidOperation(async () => {
      secondStarted = true;
      service.recordCall({
        kind: 'connection_test',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
      });
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondStarted).toBe(false);
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow(/硬暂停额度/u);
    expect(service.getView().usage).toMatchObject({
      totalCalls: 1,
      estimatedCostCents: 5,
    });
  });

  it('确认继续后本月不再拦截，下个月自动恢复拦截', () => {
    const { service, store, repository } = createService();
    service.saveQuota({
      monthlyLimitCents: 100,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 5,
    });
    seedSuccessfulUsage(store, 20);
    expect(() => service.assertCanProceed()).toThrow(/硬暂停额度/u);
    const resumed = service.confirmResume();
    expect(resumed.hardPaused).toBe(false);
    expect(repository.read().pausedMonth).toBeNull();
    expect(() => service.assertCanProceed()).not.toThrow();

    // 跨月后累计费用仍超额度，重新进入暂停（9 月 15 日对任何时区都落在 9 月）。
    for (let index = 0; index < 20; index += 1) {
      store.recordOcrUsageEvent({
        id: `september-event-${index}`,
        workspaceKey: '1'.repeat(64),
        kind: 'recognition',
        outcome: 'success',
        provider: 'aliyun-bailian',
        model: 'qwen3.5-ocr',
        occurredAt: '2026-09-02T10:00:00.000Z',
        estimatedCents: 5,
      });
    }
    const nextMonth = new Date('2026-09-15T10:00:00+08:00');
    const secondService = new OcrUsageService(repository, store, () => nextMonth);
    expect(() => secondService.assertCanProceed()).toThrow(/硬暂停额度/u);
    expect(repository.read().pausedMonth).toBe('2026-09');
  });

  it('确认继续写入失败时保持原硬暂停状态', () => {
    const settings: OcrUsageQuotaSettings = {
      monthlyLimitCents: 100,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 5,
      pausedMonth: '2026-08',
      resumedMonth: null,
    };
    const repository: OcrUsageSettingsRepository = {
      read: () => ({ ...settings }),
      write: () => {
        throw new Error('配置目录只读');
      },
    };
    const service = new OcrUsageService(
      repository,
      new MemoryUsageEventStore(),
      () => new Date('2026-08-15T10:00:00+08:00'),
    );

    expect(() => service.confirmResume()).toThrow('配置目录只读');
    expect(service.getView().quota).toMatchObject({
      pausedMonth: '2026-08',
      resumedMonth: null,
    });
    expect(service.getView().hardPaused).toBe(true);
  });

  it('硬暂停状态写入失败时仍拦截付费操作且不改变内存设置', () => {
    const settings: OcrUsageQuotaSettings = {
      monthlyLimitCents: 5,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 5,
      pausedMonth: null,
      resumedMonth: null,
    };
    const repository: OcrUsageSettingsRepository = {
      read: () => ({ ...settings }),
      write: () => {
        throw new Error('配置目录只读');
      },
    };
    const store = new MemoryUsageEventStore();
    store.recordOcrUsageEvent({
      id: 'already-at-limit',
      workspaceKey: '1'.repeat(64),
      kind: 'recognition',
      outcome: 'success',
      provider: 'aliyun-bailian',
      model: 'qwen3.5-ocr',
      occurredAt: '2026-08-15T02:00:00.000Z',
      estimatedCents: 5,
    });
    const service = new OcrUsageService(
      repository,
      store,
      () => new Date('2026-08-15T10:00:00+08:00'),
    );

    expect(() => service.assertCanProceed()).toThrow(/硬暂停额度/u);
    expect(service.getView().quota.pausedMonth).toBeNull();
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

  it('调整额度写入失败时不改变当前额度与暂停状态', () => {
    const settings: OcrUsageQuotaSettings = {
      monthlyLimitCents: 100,
      mode: 'hard_stop',
      estimatedPricePerCallCents: 5,
      pausedMonth: '2026-08',
      resumedMonth: null,
    };
    const repository: OcrUsageSettingsRepository = {
      read: () => ({ ...settings }),
      write: () => {
        throw new Error('配置目录只读');
      },
    };
    const service = new OcrUsageService(
      repository,
      new MemoryUsageEventStore(),
      () => new Date('2026-08-15T10:00:00+08:00'),
    );

    expect(() => service.saveQuota({
      monthlyLimitCents: 5_000,
      mode: 'remind',
      estimatedPricePerCallCents: 10,
    })).toThrow('配置目录只读');
    expect(service.getView().quota).toEqual(settings);
  });

  it('被硬暂停的识别项按稳定错误代码恢复，不依赖显示文案', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-ocr-quota-code-'));
    const application = new LocalApplication({
      recognize: async () => { throw new Error('硬暂停持久化测试不应调用 OCR'); },
    });
    application.openDataDirectory(dataDirectory);
    application.createRecognitionBatch({
      id: 'quota-code-batch',
      createdAt: '2026-08-21T10:00:00.000Z',
      items: [{ id: 'quota-code-item', sourceName: '待恢复截图.png' }],
    });
    application.updateRecognitionBatchItem({
      batchId: 'quota-code-batch',
      itemId: 'quota-code-item',
      status: 'failed',
      errorMessage: '这句显示文案可以任意变化',
      failureCode: 'ocr_quota_paused',
    } as Parameters<LocalApplication['updateRecognitionBatchItem']>[0] & {
      failureCode: 'ocr_quota_paused';
    });

    expect(application.listRecognitionItemsPausedByQuota()).toEqual([{
      batchId: 'quota-code-batch',
      itemId: 'quota-code-item',
    }]);
    application.close();
  });

  it('旧用量事件未能导入全局账本时拒绝打开数据目录', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-ocr-import-failure-'));
    const service = new OcrUsageService(
      new MemoryUsageSettingsRepository(),
      {
        recordOcrUsageEvent: () => undefined,
        queryOcrMonthlyUsage: () => ({
          totalCalls: 0,
          succeededCalls: 0,
          failedCalls: 0,
          estimatedCostCents: 0,
        }),
        queryRecentOcrUsageEvents: () => [],
        importWorkspaceEvents: () => {
          throw new Error('全局账本暂时不可写');
        },
      },
      () => new Date('2026-08-15T10:00:00+08:00'),
    );
    const application = new LocalApplication({
      recognize: async () => { throw new Error('导入失败不应调用 OCR'); },
    }, service);

    expect(() => application.openDataDirectory(dataDirectory))
      .toThrow(/无法导入旧 OCR 用量事件/u);
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

  it('拒绝不符合 YYYY-MM 的暂停或放行月份', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'ocr-usage-settings-month-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(configDirectory, 'ocr-usage-settings.json'),
      JSON.stringify({
        monthlyLimitCents: 1_000,
        mode: 'hard_stop',
        estimatedPricePerCallCents: 5,
        pausedMonth: '2026-99',
        resumedMonth: null,
      }),
      'utf8',
    );

    const file = new OcrUsageSettingsFile(configDirectory);
    expect(() => file.read()).toThrow(/无法读取 OCR 用量设置/u);
  });
});
