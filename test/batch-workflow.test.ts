import { access, mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RecognitionResult, Recognizer } from '../src/core/contracts';
import { DesktopSession } from '../src/main/desktop-session';
import { LocalApplication } from '../src/main/local-application';
import { OcrSettingsService } from '../src/main/ocr-settings';
import { Preferences } from '../src/main/preferences';

const sessions: DesktopSession[] = [];

const recognition: RecognitionResult = {
  platform: 'xianyu',
  sellerAccount: '批次测试账号',
  orderNumber: 'BATCH-001',
  alipayTransactionNumber: 'ALI-BATCH-001',
  buyerNickname: '批***家',
  recipient: '批次收件人',
  phone: '13800000000',
  phoneNormalized: '13800000000',
  addressOriginal: '广东省深圳市南山区批次路1号',
  addressNormalized: '广东省深圳市南山区批次路1号',
  province: '广东省',
  city: '深圳市',
  district: '南山区',
  orderedAtOriginal: '2026-07-30 10:00:00',
  orderedAtNormalized: '2026-07-30T10:00:00+08:00',
  paidAtOriginal: '2026-07-30 10:00:01',
  paidAtNormalized: '2026-07-30T10:00:01+08:00',
  productTotalCents: 800,
  shippingFeeCents: 0,
  amountCents: 800,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  items: [{
    sourceTitle: '批次商品',
    sourceSpec: '标准款',
    unitPriceCents: 800,
    quantity: 1,
    quantityInferred: true,
  }],
};

const unusedOcrSettings = new OcrSettingsService(
  { read: () => null, write: () => undefined },
  {
    getApiKey: async () => null,
    setApiKey: async () => undefined,
    deleteApiKey: async () => undefined,
    getDisplayName: () => '测试系统凭据库',
  },
  { testConnection: async () => ({ model: 'qwen3.5-ocr' }) },
);

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
});

async function openSession(recognizer: Recognizer): Promise<DesktopSession> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-workflow-'));
  const session = new DesktopSession(
    new Preferences(join(root, '启动配置')),
    recognizer,
    unusedOcrSettings,
  );
  sessions.push(session);
  session.useDataDirectory(join(root, '订单数据'));
  return session;
}

describe('批量来源截图识别队列', () => {
  it('Windows 删除目录时遇到瞬时 EPERM 会继续等待直到路径消失', async () => {
    const transientError = Object.assign(new Error('目录正在删除'), { code: 'EPERM' });
    const missingError = Object.assign(new Error('目录已不存在'), { code: 'ENOENT' });
    const probe = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(missingError);

    await eventuallyMissing('C:\\Temp\\recognition-batch', probe);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('在 OCR 调用前明确拒绝 0 张和 51 张截图', async () => {
    const recognize = vi.fn<Recognizer['recognize']>(async () => (
      attempt('BATCH-LIMIT')
    ));
    const session = await openSession({ recognize });

    expect(() => session.submitSourceScreenshots([])).toThrow('至少选择 1 张');
    expect(() => session.submitSourceScreenshots(
      Array.from({ length: 51 }, (_, index) => `/safe/${index}.png`),
    )).toThrow('一次最多选择 50 张，当前选择了 51 张，请重新选择');
    expect(recognize).not.toHaveBeenCalled();
  });

  it('在创建暂存目录前拒绝非图片、目录和超过 7.5 MB 的来源', async () => {
    const recognize = vi.fn<Recognizer['recognize']>(async () => attempt('NEVER'));
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-preflight-'));
    const dataDirectory = join(root, '订单数据');
    const session = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      { recognize },
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(dataDirectory);
    const valid = join(root, '有效.png');
    const unsupported = join(root, '误选.txt');
    const directory = join(root, '伪装目录.png');
    const oversized = join(root, '超大图片.png');
    await writeFile(valid, 'valid');
    await writeFile(unsupported, 'not-an-image');
    await mkdir(directory);
    await writeFile(oversized, Buffer.alloc(7_500_001));

    await expect(session.submitSourceScreenshots([valid, unsupported])).rejects.toThrow(
      '当前仅支持 PNG、JPG、JPEG 或 WebP 来源截图',
    );
    await expect(session.submitSourceScreenshots([valid, directory])).rejects.toThrow(
      '请选择一个来源截图文件',
    );
    await expect(session.submitSourceScreenshots([valid, oversized])).rejects.toThrow(
      '来源截图不能超过 7.5 MB，请压缩后重试',
    );
    expect(recognize).not.toHaveBeenCalled();
    expect(session.listRecognitionBatches()).toEqual([]);
    await expect(access(join(dataDirectory, '.recognition-queue'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('读取不存在的来源截图时只返回不含本机路径的固定提示', async () => {
    const recognize = vi.fn<Recognizer['recognize']>(async () => attempt('NEVER'));
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-private-path-'));
    const missingSource = join(root, '仅限本机可见', '不存在.png');

    const message = await rejectionMessage(
      session.submitSourceScreenshots([missingSource]),
    );

    expect(message).toBe('无法读取所选来源截图，请确认文件仍存在且可访问');
    expect(message).not.toContain(root);
    expect(recognize).not.toHaveBeenCalled();
    expect(session.listRecognitionBatches()).toEqual([]);
  });

  it('暂存目录不可写时使用固定提示且不暴露来源或数据目录路径', async () => {
    const recognize = vi.fn<Recognizer['recognize']>(async () => attempt('NEVER'));
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-staging-error-'));
    const dataDirectory = join(root, '私密订单数据');
    const sourcePath = join(root, '私密来源.png');
    const session = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      { recognize },
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(dataDirectory);
    await writeFile(sourcePath, 'staging-error');
    await writeFile(join(dataDirectory, '.recognition-queue'), '阻止创建暂存目录');

    const message = await rejectionMessage(
      session.submitSourceScreenshots([sourcePath]),
    );

    expect(message).toBe('无法接收所选来源截图，请确认文件仍存在且可访问');
    expect(message).not.toContain(root);
    expect(message).not.toContain(sourcePath);
    expect(message).not.toContain(dataDirectory);
    expect(recognize).not.toHaveBeenCalled();
    expect(session.listRecognitionBatches()).toEqual([]);
  });

  it('整批处理结束后删除批次暂存目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-staging-cleanup-'));
    const dataDirectory = join(root, '订单数据');
    const session = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      { recognize: async (source) => attempt(`CLEANUP-${source.originalName}`) },
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(dataDirectory);
    const paths = [join(root, '清理-1.png'), join(root, '清理-2.png')];
    await Promise.all(paths.map((path, index) => writeFile(path, `cleanup-${index}`)));

    const batch = await session.submitSourceScreenshots(paths);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0].processedCount).toBe(2);
    });
    await eventuallyMissing(join(dataDirectory, '.recognition-queue', batch.id));
  });

  it('允许 1 张和 50 张组成独立识别批次', async () => {
    const recognize = vi.fn<Recognizer['recognize']>(async (source) => (
      attempt(`LIMIT-${source.sha256}`)
    ));
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-limits-'));
    const paths = Array.from({ length: 51 }, (_, index) => join(root, `${index}.png`));
    await Promise.all(paths.map((path, index) => writeFile(path, `limit-${index}`)));

    const single = await session.submitSourceScreenshots(paths.slice(0, 1));
    const maximum = await session.submitSourceScreenshots(paths.slice(1));
    expect(single.totalCount).toBe(1);
    expect(maximum.totalCount).toBe(50);
    expect(single.id).not.toBe(maximum.id);
    await eventually(() => {
      expect(session.listRecognitionBatches().map((batch) => batch.processedCount))
        .toEqual([50, 1]);
    });
    expect(recognize).toHaveBeenCalledTimes(51);
  });

  it('立即返回批次，并在同一桌面会话中跨批次串行识别', async () => {
    const pending: Array<{
      resolve: (attempt: Awaited<ReturnType<Recognizer['recognize']>>) => void;
    }> = [];
    const recognize = vi.fn<Recognizer['recognize']>(() => new Promise((resolve) => {
      pending.push({ resolve });
    }));
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-images-'));
    const paths = [0, 1, 2].map((index) => join(root, `订单-${index}.png`));
    await Promise.all(paths.map((path, index) => writeFile(path, `image-${index}`)));

    const first = await session.submitSourceScreenshots(paths.slice(0, 2));
    const second = await session.submitSourceScreenshots(paths.slice(2));

    expect(first.items.map((item) => item.status)).toEqual([
      'waiting_recognition',
      'waiting_recognition',
    ]);
    expect(second.items[0].status).toBe('waiting_recognition');
    await eventually(() => expect(recognize).toHaveBeenCalledTimes(1));
    await Promise.all(paths.map((path) => unlink(path)));

    pending[0].resolve(attempt('BATCH-001'));
    await eventually(() => expect(recognize).toHaveBeenCalledTimes(2));
    expect(session.listRecognitionBatches().find((batch) => batch.id === first.id))
      .toMatchObject({
        counts: { awaiting_confirmation: 1, recognizing: 1 },
      });

    pending[1].resolve(attempt('BATCH-002'));
    await eventually(() => expect(recognize).toHaveBeenCalledTimes(3));
    expect(session.listRecognitionBatches().find((batch) => batch.id === second.id))
      .toMatchObject({ counts: { recognizing: 1 } });

    pending[2].resolve(attempt('BATCH-003'));
    await eventually(() => {
      expect(session.listRecognitionBatches().map((batch) => batch.processedCount))
        .toEqual([1, 2]);
    });
  });

  it('把暂时性错误留在等待重试，永久错误标失败，并继续后续截图', async () => {
    const recognize = vi.fn<Recognizer['recognize']>()
      .mockRejectedValueOnce(new Error('百炼 OCR 当前限流或额度不足，请稍后再试'))
      .mockRejectedValueOnce(new Error('百炼 OCR 无法识别这张截图，请确认图片完整清晰'))
      .mockResolvedValueOnce(attempt('BATCH-AFTER-FAILURES'));
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-failures-'));
    const paths = [0, 1, 2].map((index) => join(root, `异常-${index}.png`));
    await Promise.all(paths.map((path, index) => writeFile(path, `failure-${index}`)));

    const batch = await session.submitSourceScreenshots(paths);
    await eventually(() => expect(recognize).toHaveBeenCalledTimes(3));
    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        id: batch.id,
        processedCount: 3,
        counts: {
          waiting_retry: 1,
          failed: 1,
          awaiting_confirmation: 1,
        },
      });
    });
    expect(session.listRecognitionBatches()[0].items).toMatchObject([
      {
        status: 'waiting_retry',
        errorMessage: '百炼 OCR 当前限流或额度不足，请稍后再试',
      },
      {
        status: 'failed',
        errorMessage: '百炼 OCR 无法识别这张截图，请确认图片完整清晰',
      },
      { status: 'awaiting_confirmation' },
    ]);
    const currentState = session.getState();
    if (currentState.kind !== 'ready') throw new Error('测试数据目录未就绪');
    await eventuallyMissing(join(
      currentState.dataDirectory,
      '.recognition-queue',
      batch.id,
    ));
  });

  it('批次错误不会把来源路径或数据目录路径暴露给界面', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-error-boundary-'));
    const sourcePath = join(root, '网络资料', '订单.png');
    await mkdir(join(root, '网络资料'));
    await writeFile(sourcePath, 'private-path-error');
    const recognize = vi.fn<Recognizer['recognize']>(async () => {
      throw new Error(`EACCES: open '${sourcePath}'`);
    });
    const session = await openSession({ recognize });

    await session.submitSourceScreenshots([sourcePath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0].processedCount).toBe(1);
    });

    const failedItem = session.listRecognitionBatches()[0].items[0];
    expect(failedItem.status).toBe('failed');
    const errorMessage = failedItem.errorMessage;
    expect(errorMessage).toBe('来源截图识别失败，请检查图片完整清晰后重试');
    expect(errorMessage).not.toContain(root);
    expect(errorMessage).not.toContain(sourcePath);
  });

  it('来源证据文件丢失时不会把数据目录路径暴露给界面', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-evidence-error-boundary-'));
    const dataDirectory = join(root, '私密订单数据');
    const sourcePath = join(root, '订单.png');
    await writeFile(sourcePath, 'stored-evidence-error');
    const session = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      { recognize: async () => attempt('EVIDENCE-PATH-BOUNDARY') },
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(dataDirectory);
    await session.submitSourceScreenshots([sourcePath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0].items[0].status)
        .toBe('awaiting_confirmation');
    });
    const item = session.listRecognitionBatches()[0].items[0];
    const draft = session.getDraft(item.draftId!);
    await unlink(join(dataDirectory, 'screenshots', `${draft.screenshotId}.png`));

    const message = await rejectionMessage(
      session.getScreenshotDataUrl(draft.screenshotId),
    );

    expect(message).toBe('无法读取来源截图，请检查数据目录后重试');
    expect(message).not.toContain(root);
    expect(message).not.toContain(dataDirectory);
  });

  it('切换数据目录时让旧批次安全完成，且旧批次状态不会串入新目录', async () => {
    let finishRecognition!: (
      value: Awaited<ReturnType<Recognizer['recognize']>>,
    ) => void;
    const recognize = vi.fn<Recognizer['recognize']>(() => new Promise((resolve) => {
      finishRecognition = resolve;
    }));
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-directory-switch-'));
    const firstDataDirectory = join(root, '第一套订单数据');
    const secondDataDirectory = join(root, '第二套订单数据');
    const sourcePath = join(root, '切换时识别.png');
    await writeFile(sourcePath, 'switch-during-recognition');
    const session = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      { recognize },
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(firstDataDirectory);
    await session.submitSourceScreenshots([sourcePath]);
    await eventually(() => expect(recognize).toHaveBeenCalledOnce());

    expect(session.useDataDirectory(secondDataDirectory)).toMatchObject({
      kind: 'ready',
      dataDirectory: secondDataDirectory,
      orders: [],
    });
    expect(session.listRecognitionBatches()).toEqual([]);

    finishRecognition(attempt('COMPLETED-IN-FIRST-DIRECTORY'));
    await eventually(() => {
      expect(readStoredDraftCount(firstDataDirectory)).toBe(1);
    });
    expect(session.getState()).toMatchObject({
      kind: 'ready',
      dataDirectory: secondDataDirectory,
      orders: [],
    });
    expect(session.listRecognitionBatches()).toEqual([]);
  });

  it('识别失败后释放内容哈希预留，让相同内容的后续截图仍可识别', async () => {
    const recognize = vi.fn<Recognizer['recognize']>()
      .mockRejectedValueOnce(new Error('无法连接百炼服务，请检查网络后重试'))
      .mockResolvedValueOnce(attempt('BATCH-RETRY-SAME-CONTENT'));
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-released-hash-'));
    const paths = [join(root, '首次失败.png'), join(root, '相同内容.png')];
    await Promise.all(paths.map((path) => writeFile(path, 'same-after-failure')));

    await session.submitSourceScreenshots(paths);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: {
          waiting_retry: 1,
          awaiting_confirmation: 1,
          duplicate_skipped: 0,
        },
      });
    });
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it('按内容哈希在批内和跨批次跳过重复截图且不再次调用 OCR', async () => {
    const recognize = vi.fn<Recognizer['recognize']>()
      .mockResolvedValue(attempt('BATCH-DEDUPLICATED'));
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-duplicates-'));
    const firstPath = join(root, '第一次.png');
    const sameBatchPath = join(root, '批内副本.png');
    const laterBatchPath = join(root, '跨批副本.png');
    await Promise.all([
      writeFile(firstPath, 'identical-image'),
      writeFile(sameBatchPath, 'identical-image'),
      writeFile(laterBatchPath, 'identical-image'),
    ]);

    const firstBatch = await session.submitSourceScreenshots([firstPath, sameBatchPath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0].processedCount).toBe(2);
    });
    expect(session.listRecognitionBatches()[0]).toMatchObject({
      id: firstBatch.id,
      counts: { awaiting_confirmation: 1, duplicate_skipped: 1 },
    });

    const secondBatch = await session.submitSourceScreenshots([laterBatchPath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        id: secondBatch.id,
        counts: { duplicate_skipped: 1 },
      });
    });
    expect(recognize).toHaveBeenCalledOnce();
  });

  it('通过深拷贝快照实时通知，并在确认或取消后同步批次项状态', async () => {
    const recognize = vi.fn<Recognizer['recognize']>(async (source) => (
      attempt(`ORDER-${source.originalName}`)
    ));
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-events-'));
    const paths = [join(root, '确认.png'), join(root, '取消.png')];
    await Promise.all(paths.map((path, index) => writeFile(path, `event-${index}`)));
    const observed: ReturnType<DesktopSession['listRecognitionBatches']>[] = [];
    const cleanup = session.onRecognitionBatchesChanged((batches) => {
      observed.push(batches);
    });

    const batch = await session.submitSourceScreenshots(paths);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0].counts.awaiting_confirmation).toBe(2);
    });
    expect(observed.some((snapshot) => (
      snapshot[0]?.items.some((item) => item.status === 'recognizing')
    ))).toBe(true);
    expect(observed.some((snapshot) => (
      snapshot[0]?.items.some((item) => item.status === 'validating')
    ))).toBe(true);

    const leaked = session.listRecognitionBatches();
    leaked[0].items[0].sourceName = '被外部篡改.png';
    leaked[0].counts.awaiting_confirmation = 99;
    expect(session.listRecognitionBatches()[0]).toMatchObject({
      id: batch.id,
      counts: { awaiting_confirmation: 2 },
      items: [{ sourceName: '确认.png' }, { sourceName: '取消.png' }],
    });

    const [first, second] = session.listRecognitionBatches()[0].items;
    const draft = session.getDraft(first.draftId!);
    expect(draft.id).toBe(first.draftId);
    session.confirmDraft(draft);
    session.cancelDraft(second.draftId!);
    expect(session.listRecognitionBatches()[0]).toMatchObject({
      processedCount: 2,
      counts: { imported: 1, cancelled: 1, awaiting_confirmation: 0 },
      items: [{ status: 'imported' }, { status: 'cancelled' }],
    });

    const notificationCount = observed.length;
    cleanup();
    await session.submitSourceScreenshots([paths[0]]);
    expect(observed).toHaveLength(notificationCount);
  });

  it('同批次多个草稿只在最后一个完成校对后才把数据库批次标为完成', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-local-batch-status-'));
    const dataDirectory = join(root, '订单数据');
    const paths = [join(root, '第一张.png'), join(root, '第二张.png')];
    await Promise.all(paths.map((path, index) => writeFile(path, `db-batch-${index}`)));
    const application = new LocalApplication({
      recognize: async (source) => attempt(`DB-${source.originalName}`),
    });
    application.openDataDirectory(dataDirectory);
    try {
      const batch = await application.submitRecognitionBatch(paths);
      application.confirmDraft(batch.drafts[0]);
      expect(readStoredBatchStatus(dataDirectory, batch.id)).toBe('awaiting_review');

      application.cancelDraft(batch.drafts[1].id);
      expect(readStoredBatchStatus(dataDirectory, batch.id)).toBe('completed');
    } finally {
      application.close();
    }
  });
});

function attempt(orderNumber: string): Awaited<ReturnType<Recognizer['recognize']>> {
  return {
    result: { ...recognition, orderNumber },
    evidences: [{
      provider: 'controlled',
      model: 'controlled',
      requestId: `request-${orderNumber}`,
      schemaVersion: 1,
      rawResponse: '{}',
    }],
  };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}

function readStoredBatchStatus(dataDirectory: string, batchId: string): string {
  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare('SELECT status FROM recognition_batches WHERE id = ?')
      .get(batchId) as { status: string };
    return row.status;
  } finally {
    database.close();
  }
}

function readStoredDraftCount(dataDirectory: string): number {
  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare('SELECT COUNT(*) AS count FROM order_drafts')
      .get() as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error('预期操作失败，但操作成功了');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function eventuallyMissing(
  path: string,
  probe: (candidate: string) => Promise<void> = access,
): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    try {
      await probe(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (code !== 'EPERM' && code !== 'EBUSY') throw error;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`暂存路径仍然存在：${path}`);
}
