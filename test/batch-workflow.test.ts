import { access, mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  OrderReviewIssueCode,
  RecognitionResult,
  Recognizer,
} from '../src/core/contracts';
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
  vi.useRealTimers();
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
  it('自动入库默认关闭，完整识别结果仍保留明确的待确认原因', async () => {
    const session = await openSession({
      recognize: async () => attempt('AUTO-IMPORT-DEFAULT-OFF'),
    });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-auto-import-off-'));
    const sourcePath = join(root, '默认校对.png');
    await writeFile(sourcePath, 'auto-import-default-off');

    expect(session.getOrderIntakeSettings()).toEqual({ automaticImportEnabled: false });
    await session.submitSourceScreenshots([sourcePath]);

    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { awaiting_confirmation: 1, imported: 0 },
        items: [{
          status: 'awaiting_confirmation',
          reviewIssues: ['automatic_import_disabled'],
        }],
      });
    });
    expect(session.listOrders()).toEqual([]);
  });

  it('后台无法读取自动入库偏好时安全回退为人工确认', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-auto-import-pref-failure-'));
    const preferences = new Preferences(join(root, '启动配置'));
    const session = new DesktopSession(
      preferences,
      { recognize: async () => attempt('AUTO-PREFERENCE-FAIL-CLOSED') },
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(join(root, '订单数据'));
    vi.spyOn(preferences, 'getAutomaticImportEnabled').mockImplementation(() => {
      throw new Error('无法读取启动配置');
    });
    const sourcePath = join(root, '安全回退.png');
    await writeFile(sourcePath, 'auto-import-fail-closed');

    await session.submitSourceScreenshots([sourcePath]);

    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { awaiting_confirmation: 1, failed: 0 },
        items: [{
          status: 'awaiting_confirmation',
          reviewIssues: ['automatic_import_disabled'],
        }],
      });
    });
  });

  it('开启后把完整、格式有效且无冲突的草稿直接入库', async () => {
    const session = await openSession({
      recognize: async () => attempt('AUTO-IMPORT-COMPLETE'),
    });
    session.saveOrderIntakeSettings({ automaticImportEnabled: true });
    const observedOrders: ReturnType<DesktopSession['listOrders']>[] = [];
    session.onOrdersChanged((orders) => observedOrders.push(orders));
    const root = await mkdtemp(join(tmpdir(), 'xianyu-auto-import-complete-'));
    const sourcePath = join(root, '可自动入库.png');
    await writeFile(sourcePath, 'auto-import-complete');

    await session.submitSourceScreenshots([sourcePath]);

    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { imported: 1, awaiting_confirmation: 0 },
        items: [{ status: 'imported', reviewIssues: [] }],
      });
      expect(session.listOrders()).toHaveLength(1);
    });
    const order = session.listOrders()[0];
    expect(session.getOrder(order.id)).toMatchObject({
      order: { orderNumber: 'AUTO-IMPORT-COMPLETE' },
      sourceSnapshot: {
        recognition: { orderNumber: 'AUTO-IMPORT-COMPLETE' },
        confirmed: { orderNumber: 'AUTO-IMPORT-COMPLETE' },
      },
    });
    expect(observedOrders.at(-1)).toMatchObject([{ orderNumber: 'AUTO-IMPORT-COMPLETE' }]);
  });

  it('已入库订单的同平台账号与订单号不会被静默重复导入', async () => {
    const session = await openSession({
      recognize: async () => attempt('AUTO-DUPLICATE-IDENTITY'),
    });
    session.saveOrderIntakeSettings({ automaticImportEnabled: true });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-auto-import-duplicate-'));
    const firstPath = join(root, '首次识别.png');
    const secondPath = join(root, '更新截图.png');
    await Promise.all([
      writeFile(firstPath, 'auto-duplicate-first'),
      writeFile(secondPath, 'auto-duplicate-second'),
    ]);

    await session.submitSourceScreenshots([firstPath]);
    await eventually(() => expect(session.listOrders()).toHaveLength(1));
    await session.submitSourceScreenshots([secondPath]);

    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { awaiting_confirmation: 1, imported: 0 },
        items: [{
          status: 'awaiting_confirmation',
          reviewIssues: ['duplicate_order'],
        }],
      });
    });
    expect(session.listOrders()).toHaveLength(1);
  });

  it('开启后对六类关键信息缺失逐项给出确定性原因', async () => {
    const cases: Array<{
      sourceName: string;
      issue: OrderReviewIssueCode;
      result: RecognitionResult;
    }> = [
      {
        sourceName: '缺订单号.png',
        issue: 'missing_order_number',
        result: { ...recognition, orderNumber: '' },
      },
      {
        sourceName: '缺收件人.png',
        issue: 'missing_recipient',
        result: { ...recognition, orderNumber: 'AUTO-MISSING-RECIPIENT', recipient: '' },
      },
      {
        sourceName: '缺手机号.png',
        issue: 'missing_phone',
        result: {
          ...recognition,
          orderNumber: 'AUTO-MISSING-PHONE',
          phone: '',
          phoneNormalized: '',
        },
      },
      {
        sourceName: '地址不完整.png',
        issue: 'incomplete_address',
        result: {
          ...recognition,
          orderNumber: 'AUTO-INCOMPLETE-ADDRESS',
          addressOriginal: '南山区',
          addressNormalized: '南山区',
          province: '',
          city: '',
          district: '南山区',
        },
      },
      {
        sourceName: '缺商品.png',
        issue: 'missing_items',
        result: { ...recognition, orderNumber: 'AUTO-MISSING-ITEMS', items: [] },
      },
      {
        sourceName: '缺成交金额.png',
        issue: 'missing_amount',
        result: { ...recognition, orderNumber: 'AUTO-MISSING-AMOUNT', amountCents: null },
      },
    ];
    const results = new Map<string, RecognitionResult>(
      cases.map((entry) => [entry.sourceName, entry.result]),
    );
    const session = await openSession({
      recognize: async (source) => recognitionAttempt(
        results.get(source.originalName) ?? recognition,
      ),
    });
    session.saveOrderIntakeSettings({ automaticImportEnabled: true });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-auto-import-missing-'));
    const paths = cases.map((entry) => join(root, entry.sourceName));
    await Promise.all(paths.map((path, index) => writeFile(path, `missing-${index}`)));

    await session.submitSourceScreenshots(paths);

    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { awaiting_confirmation: cases.length, imported: 0 },
      });
    });
    const items = session.listRecognitionBatches()[0].items;
    for (const entry of cases) {
      expect(items.find((item) => item.sourceName === entry.sourceName)?.reviewIssues)
        .toContain(entry.issue);
    }
    expect(session.listOrders()).toEqual([]);
  });

  it('字段格式异常、交叉校验冲突和定向复核未解决时不会自动入库', async () => {
    const cases: Array<{
      sourceName: string;
      issue: OrderReviewIssueCode;
      result: RecognitionResult;
    }> = [
      {
        sourceName: '手机号格式异常.png',
        issue: 'invalid_phone',
        result: {
          ...recognition,
          orderNumber: 'AUTO-INVALID-PHONE',
          phone: '12345',
          phoneNormalized: '12345',
        },
      },
      {
        sourceName: '商品明细交叉冲突.png',
        issue: 'item_total_mismatch',
        result: {
          ...recognition,
          orderNumber: 'AUTO-ITEM-TOTAL-CONFLICT',
          productTotalCents: 900,
          amountCents: 900,
        },
      },
      {
        sourceName: '买家收件人冲突.png',
        issue: 'buyer_recipient_conflict',
        result: {
          ...recognition,
          orderNumber: 'AUTO-IDENTITY-CONFLICT',
          buyerNickname: recognition.recipient,
        },
      },
      {
        sourceName: '两次识别仍冲突.png',
        issue: 'targeted_review_conflict',
        result: { ...recognition, orderNumber: 'AUTO-REVIEW-CONFLICT' },
      },
    ];
    const byName = new Map<string, (typeof cases)[number]>(
      cases.map((entry) => [entry.sourceName, entry]),
    );
    const session = await openSession({
      recognize: async (source) => {
        const entry = byName.get(source.originalName)!;
        return recognitionAttempt(
          entry.result,
          entry.issue === 'targeted_review_conflict' ? [entry.issue] : [],
        );
      },
    });
    session.saveOrderIntakeSettings({ automaticImportEnabled: true });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-auto-import-conflicts-'));
    const paths = cases.map((entry) => join(root, entry.sourceName));
    await Promise.all(paths.map((path, index) => writeFile(path, `conflict-${index}`)));

    await session.submitSourceScreenshots(paths);

    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { awaiting_confirmation: cases.length, imported: 0 },
      });
    });
    const items = session.listRecognitionBatches()[0].items;
    for (const entry of cases) {
      expect(items.find((item) => item.sourceName === entry.sourceName)?.reviewIssues)
        .toContain(entry.issue);
    }
    expect(session.listOrders()).toEqual([]);
  });

  it('待确认原因随草稿持久化，重启后仍可继续校对', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-auto-import-review-restart-'));
    const preferencesDirectory = join(root, '启动配置');
    const dataDirectory = join(root, '订单数据');
    const sourcePath = join(root, '缺失手机号.png');
    await writeFile(sourcePath, 'persist-review-issues');
    const preferences = new Preferences(preferencesDirectory);
    preferences.setAutomaticImportEnabled(true);
    const first = new DesktopSession(
      preferences,
      {
        recognize: async () => recognitionAttempt({
          ...recognition,
          orderNumber: 'AUTO-REVIEW-RESTART',
          phone: '',
          phoneNormalized: '',
        }),
      },
      unusedOcrSettings,
    );
    sessions.push(first);
    first.useDataDirectory(dataDirectory);
    const batch = await first.submitSourceScreenshots([sourcePath]);
    await eventually(() => {
      expect(first.listRecognitionBatches()[0]).toMatchObject({
        id: batch.id,
        items: [{ reviewIssues: ['missing_phone'] }],
      });
    });
    first.close();
    sessions.splice(sessions.indexOf(first), 1);

    const reopened = new DesktopSession(
      new Preferences(preferencesDirectory),
      { recognize: async () => attempt('SHOULD-NOT-RUN') },
      unusedOcrSettings,
    );
    sessions.push(reopened);
    await eventually(() => {
      expect(reopened.restore()).toMatchObject({ kind: 'ready', dataDirectory });
    });
    expect(reopened.listRecognitionBatches()[0]).toMatchObject({
      id: batch.id,
      counts: { awaiting_confirmation: 1 },
      items: [{ status: 'awaiting_confirmation', reviewIssues: ['missing_phone'] }],
    });
  });

  it('草稿落盘后在入库决策前退出，重启会恢复未完成的自动入库', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-auto-import-decision-recovery-'));
    const dataDirectory = join(root, '订单数据');
    const sourcePath = join(root, '待决策订单.png');
    await writeFile(sourcePath, 'pending-intake-decision');
    const seed = new LocalApplication({
      recognize: async () => attempt('AUTO-DECISION-RECOVERY'),
    });
    seed.openDataDirectory(dataDirectory);
    const pendingBatch = await seed.submitRecognitionBatch([sourcePath]);
    expect(seed.listRecognitionBatches()[0]).toMatchObject({
      id: pendingBatch.id,
      counts: { awaiting_confirmation: 1 },
      items: [{ reviewIssues: [] }],
    });
    seed.close();

    const preferences = new Preferences(join(root, '启动配置'));
    preferences.setAutomaticImportEnabled(true);
    const reopened = new DesktopSession(
      preferences,
      { recognize: async () => attempt('SHOULD-NOT-RUN') },
      unusedOcrSettings,
    );
    sessions.push(reopened);

    expect(reopened.useDataDirectory(dataDirectory)).toMatchObject({
      kind: 'ready',
      orders: [{ orderNumber: 'AUTO-DECISION-RECOVERY' }],
    });
    expect(reopened.listRecognitionBatches()[0]).toMatchObject({
      id: pendingBatch.id,
      counts: { imported: 1, awaiting_confirmation: 0 },
      items: [{ status: 'imported', reviewIssues: [] }],
    });
  });

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
        processedCount: 2,
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
    expect(session.listRecognitionBatches()[0].items).toHaveLength(3);
  });

  it('临时错误保留来源截图，并在 30 秒受控退避后自动继续识别', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const recognize = vi.fn<Recognizer['recognize']>()
      .mockRejectedValueOnce(new Error('无法连接百炼服务，请检查网络后重试'))
      .mockImplementationOnce(async (source) => {
        expect(Buffer.from(source.bytes).toString()).toBe('retry-after-backoff');
        return attempt('BACKOFF-RECOVERED');
      });
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-backoff-'));
    const sourcePath = join(root, '恢复后继续.png');
    await writeFile(sourcePath, 'retry-after-backoff');

    const batch = await session.submitSourceScreenshots([sourcePath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        id: batch.id,
        counts: { waiting_retry: 1 },
      });
    });
    expect(recognize).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(recognize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await eventually(() => {
      expect(recognize).toHaveBeenCalledTimes(2);
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        id: batch.id,
        counts: { awaiting_confirmation: 1, waiting_retry: 0 },
      });
    });
  });

  it('重开应用后从本机队列恢复目标截图，并只等待剩余退避时间', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-07-30T08:00:00.000Z'));
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-restart-resume-'));
    const dataDirectory = join(root, '订单数据');
    const preferencesDirectory = join(root, '启动配置');
    const sourcePath = join(root, '断网时订单.png');
    await writeFile(sourcePath, 'persisted-retry-source');
    const firstRecognition = vi.fn<Recognizer['recognize']>()
      .mockRejectedValueOnce(new Error('无法连接百炼服务，请检查网络后重试'));
    const first = new DesktopSession(
      new Preferences(preferencesDirectory),
      { recognize: firstRecognition },
      unusedOcrSettings,
    );
    sessions.push(first);
    first.useDataDirectory(dataDirectory);

    const batch = await first.submitSourceScreenshots([sourcePath]);
    await eventually(() => {
      expect(first.listRecognitionBatches()[0]).toMatchObject({
        id: batch.id,
        counts: { waiting_retry: 1 },
        items: [{
          retryCount: 1,
          nextRetryAt: '2026-07-30T08:00:30.000Z',
        }],
      });
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await unlink(sourcePath);
    first.close();

    const resumedRecognition = vi.fn<Recognizer['recognize']>(async (source) => {
      expect(Buffer.from(source.bytes).toString()).toBe('persisted-retry-source');
      return attempt('RESTART-RECOVERED');
    });
    const reopened = new DesktopSession(
      new Preferences(preferencesDirectory),
      { recognize: resumedRecognition },
      unusedOcrSettings,
    );
    sessions.push(reopened);
    const reopenedState = reopened.useDataDirectory(dataDirectory);
    if (reopenedState.kind !== 'ready') {
      throw new Error(`重开数据目录失败：${JSON.stringify(reopenedState)}`);
    }
    expect(reopened.listRecognitionBatches()[0]).toMatchObject({
      id: batch.id,
      counts: { waiting_retry: 1 },
      items: [{
        retryCount: 1,
        nextRetryAt: '2026-07-30T08:00:30.000Z',
      }],
    });

    await vi.advanceTimersByTimeAsync(19_999);
    expect(resumedRecognition).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await eventually(() => {
      expect(resumedRecognition).toHaveBeenCalledOnce();
      expect(reopened.listRecognitionBatches()[0]).toMatchObject({
        id: batch.id,
        counts: { awaiting_confirmation: 1, waiting_retry: 0 },
      });
    });
  });

  it('重开应用后恢复等待识别、识别中和校验中的本机任务', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-restart-inflight-'));
    const dataDirectory = join(root, '订单数据');
    const batchId = 'restart-inflight-batch';
    const statuses = ['waiting_recognition', 'recognizing', 'validating'] as const;
    const queuePaths = statuses.map((status, index) => join(
      dataDirectory,
      '.recognition-queue',
      batchId,
      `item-${index}`,
      `${status}.png`,
    ));
    for (const [index, queuePath] of queuePaths.entries()) {
      await mkdir(dirname(queuePath), { recursive: true });
      await writeFile(queuePath, `restart-${statuses[index]}`);
    }
    const seed = new LocalApplication({
      recognize: async () => {
        throw new Error('种子应用不应执行 OCR');
      },
    });
    seed.openDataDirectory(dataDirectory);
    seed.createRecognitionBatch({
      id: batchId,
      createdAt: '2026-07-30T10:30:00.000Z',
      items: statuses.map((status, index) => ({
        id: `item-${index}`,
        sourceName: `${status}.png`,
        queuePath: queuePaths[index],
      })),
    });
    seed.updateRecognitionBatchItem({
      batchId,
      itemId: 'item-1',
      status: 'recognizing',
    });
    seed.updateRecognitionBatchItem({
      batchId,
      itemId: 'item-2',
      status: 'validating',
    });
    seed.close();

    const recognize = vi.fn<Recognizer['recognize']>(async (source) => (
      attempt(`RESTART-${source.originalName}`)
    ));
    const reopened = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      { recognize },
      unusedOcrSettings,
    );
    sessions.push(reopened);
    expect(reopened.useDataDirectory(dataDirectory)).toMatchObject({ kind: 'ready' });
    expect(reopened.listRecognitionBatches()[0]).toMatchObject({
      id: batchId,
      counts: { waiting_recognition: 1, waiting_retry: 2 },
      items: [
        { status: 'waiting_recognition', retryCount: 0 },
        { status: 'waiting_retry', retryCount: 1 },
        { status: 'waiting_retry', retryCount: 1 },
      ],
    });
    expect(reopened.listRecognitionBatches()[0].items[0]).not.toHaveProperty('nextRetryAt');

    await eventually(() => {
      expect(recognize).toHaveBeenCalledTimes(3);
      expect(reopened.listRecognitionBatches()[0]).toMatchObject({
        id: batchId,
        counts: { awaiting_confirmation: 3, waiting_retry: 0 },
      });
    });
  });

  it('旧版等待重试记录没有队列文件时明确标记失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-missing-legacy-queue-'));
    const dataDirectory = join(root, '订单数据');
    const batchId = 'legacy-waiting-retry-batch';
    const seed = new LocalApplication({
      recognize: async () => {
        throw new Error('种子应用不应执行 OCR');
      },
    });
    seed.openDataDirectory(dataDirectory);
    seed.createRecognitionBatch({
      id: batchId,
      createdAt: '2026-07-30T10:40:00.000Z',
      items: [{ id: 'legacy-item', sourceName: '旧版截图.png' }],
    });
    seed.updateRecognitionBatchItem({
      batchId,
      itemId: 'legacy-item',
      status: 'waiting_retry',
      retryCount: 1,
      nextRetryAt: '2026-07-30T10:41:00.000Z',
    });
    seed.close();

    const recognize = vi.fn<Recognizer['recognize']>(async () => attempt('NEVER'));
    const reopened = new DesktopSession(
      new Preferences(join(root, '启动配置')),
      { recognize },
      unusedOcrSettings,
    );
    sessions.push(reopened);
    expect(reopened.useDataDirectory(dataDirectory)).toMatchObject({ kind: 'ready' });

    expect(reopened.listRecognitionBatches()[0]).toMatchObject({
      id: batchId,
      counts: { failed: 1, waiting_retry: 0 },
      items: [{
        status: 'failed',
        errorMessage: '上次退出时处理未完成，且本机队列文件已不可用',
      }],
    });
    expect(recognize).not.toHaveBeenCalled();
  });

  it('临时错误最多自动重试 5 次，之后保留截图等待用户处理', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-07-30T09:00:00.000Z'));
    const attemptTimes: number[] = [];
    const recognize = vi.fn<Recognizer['recognize']>(async () => {
      attemptTimes.push(Date.now());
      throw new Error('百炼 OCR 服务暂时不可用，请稍后再试');
    });
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-retry-limit-'));
    const sourcePath = join(root, '持续服务异常.png');
    await writeFile(sourcePath, 'retry-limit-source');

    await session.submitSourceScreenshots([sourcePath]);
    await eventually(() => expect(recognize).toHaveBeenCalledOnce());
    for (let index = 0; index < 5; index += 1) {
      await eventually(() => expect(vi.getTimerCount()).toBe(1));
      await vi.advanceTimersToNextTimerAsync();
      await eventually(() => expect(recognize).toHaveBeenCalledTimes(index + 2));
    }

    expect(attemptTimes.slice(1).map((time, index) => time - attemptTimes[index])).toEqual([
      30_000,
      120_000,
      600_000,
      1_800_000,
      1_800_000,
    ]);

    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { failed: 1, waiting_retry: 0 },
        items: [{
          status: 'failed',
          errorMessage: '已自动重试 5 次，服务仍不可用，请手动重试或改为人工录入',
        }],
      });
    });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(recognize).toHaveBeenCalledTimes(6);
  });

  it('手动重试只重新识别目标截图，不连带处理同批其他失败项', async () => {
    const recognize = vi.fn<Recognizer['recognize']>()
      .mockRejectedValueOnce(new Error('百炼 OCR 无法识别这张截图，请确认图片完整清晰'))
      .mockRejectedValueOnce(new Error('百炼 OCR 无法识别这张截图，请确认图片完整清晰'))
      .mockImplementationOnce(async (source) => {
        expect(Buffer.from(source.bytes).toString()).toBe('manual-retry-target');
        return attempt('MANUAL-RETRY-TARGET');
      });
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-manual-retry-'));
    const paths = [join(root, '保持失败.png'), join(root, '只重试这一张.png')];
    await Promise.all([
      writeFile(paths[0], 'leave-failed'),
      writeFile(paths[1], 'manual-retry-target'),
    ]);

    const batch = await session.submitSourceScreenshots(paths);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        id: batch.id,
        counts: { failed: 2 },
      });
    });
    await Promise.all(paths.map((path) => unlink(path)));
    const target = session.listRecognitionBatches()[0].items[1];

    await session.retryRecognitionItem(batch.id, target.id);

    await eventually(() => {
      expect(recognize).toHaveBeenCalledTimes(3);
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        id: batch.id,
        counts: { failed: 1, awaiting_confirmation: 1 },
        items: [
          { sourceName: '保持失败.png', status: 'failed' },
          { sourceName: '只重试这一张.png', status: 'awaiting_confirmation' },
        ],
      });
    });
  });

  it('自动计时器与手动重试同时到达时，同一截图只完成一次重试', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
    let releaseBlocker!: (value: Awaited<ReturnType<Recognizer['recognize']>>) => void;
    const blocker = new Promise<Awaited<ReturnType<Recognizer['recognize']>>>((resolve) => {
      releaseBlocker = resolve;
    });
    let targetAttempts = 0;
    const recognize = vi.fn<Recognizer['recognize']>(async (source) => {
      const contents = Buffer.from(source.bytes).toString();
      if (contents === 'retry-race-target') {
        targetAttempts += 1;
        if (targetAttempts === 1) {
          throw new Error('无法连接百炼服务，请检查网络后重试');
        }
        return attempt('RETRY-RACE-TARGET');
      }
      return blocker;
    });
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-retry-race-'));
    const paths = [join(root, '竞态目标.png'), join(root, '占用队列.png')];
    await Promise.all([
      writeFile(paths[0], 'retry-race-target'),
      writeFile(paths[1], 'queue-blocker'),
    ]);

    const batch = await session.submitSourceScreenshots(paths);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { waiting_retry: 1, recognizing: 1 },
      });
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const target = session.listRecognitionBatches()[0].items[0];
    await session.retryRecognitionItem(batch.id, target.id);
    releaseBlocker(attempt('RETRY-RACE-BLOCKER'));

    await eventually(() => {
      expect(session.listRecognitionBatches()[0].items[0]).toMatchObject({
        status: 'awaiting_confirmation',
      });
    });
    for (let index = 0; index < 20; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(targetAttempts).toBe(2);
    expect(session.listRecognitionBatches()[0].items[0]).toMatchObject({
      status: 'awaiting_confirmation',
    });
  });

  it('已入队的旧计时任务不会消耗手动重置后的重试预算', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-07-30T10:00:00.000Z'));
    let releaseBlocker!: (value: Awaited<ReturnType<Recognizer['recognize']>>) => void;
    const blocker = new Promise<Awaited<ReturnType<Recognizer['recognize']>>>((resolve) => {
      releaseBlocker = resolve;
    });
    let targetAttempts = 0;
    const recognize = vi.fn<Recognizer['recognize']>(async (source) => {
      if (Buffer.from(source.bytes).toString() === 'retry-budget-target') {
        targetAttempts += 1;
        throw new Error('无法连接百炼服务，请检查网络后重试');
      }
      return blocker;
    });
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-retry-budget-race-'));
    const paths = [join(root, '竞态预算目标.png'), join(root, '占用队列.png')];
    await Promise.all([
      writeFile(paths[0], 'retry-budget-target'),
      writeFile(paths[1], 'queue-blocker'),
    ]);

    const batch = await session.submitSourceScreenshots(paths);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { waiting_retry: 1, recognizing: 1 },
      });
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const target = session.listRecognitionBatches()[0].items[0];
    await session.retryRecognitionItem(batch.id, target.id);
    releaseBlocker(attempt('RETRY-BUDGET-BLOCKER'));

    await eventually(() => {
      expect(session.listRecognitionBatches()[0].items[0]).toMatchObject({
        status: 'waiting_retry',
        retryCount: 1,
        nextRetryAt: '2026-07-30T10:01:00.000Z',
      });
    });
    for (let index = 0; index < 20; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(targetAttempts).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('永久失败项可从本机截图人工录入，并在入库后保留来源快照', async () => {
    const recognize = vi.fn<Recognizer['recognize']>()
      .mockRejectedValueOnce(new Error('百炼 OCR 无法识别这张截图，请确认图片完整清晰'));
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-manual-entry-'));
    const sourcePath = join(root, '人工录入来源.png');
    await writeFile(sourcePath, 'manual-entry-source');

    const batch = await session.submitSourceScreenshots([sourcePath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        id: batch.id,
        counts: { failed: 1 },
      });
    });
    await unlink(sourcePath);
    const item = session.listRecognitionBatches()[0].items[0];

    const manualDraft = await session.createManualDraft(batch.id, item.id);

    expect(recognize).toHaveBeenCalledOnce();
    expect(manualDraft).toMatchObject({
      batchId: batch.id,
      status: 'awaiting_review',
      orderNumber: '',
      recipient: '',
      phone: '',
      amountCents: null,
      items: [{ sourceTitle: '', unitPriceCents: null, quantity: 1 }],
    });
    expect(session.listRecognitionBatches()[0]).toMatchObject({
      id: batch.id,
      counts: { awaiting_confirmation: 1, failed: 0 },
    });

    const completedDraft = {
      ...manualDraft,
      sellerAccount: '人工录入账号',
      orderNumber: 'MANUAL-ENTRY-001',
      recipient: '人工收件人',
      phone: '13800000000',
      phoneNormalized: '13800000000',
      addressOriginal: '广东省深圳市南山区人工录入路1号',
      addressNormalized: '广东省深圳市南山区人工录入路1号',
      province: '广东省',
      city: '深圳市',
      district: '南山区',
      productTotalCents: 800,
      shippingFeeCents: 0,
      amountCents: 800,
      platformTransactionStatus: 'paid' as const,
      fulfillmentStatus: 'pending_shipment' as const,
      items: [{
        ...manualDraft.items[0],
        sourceTitle: '人工录入商品',
        unitPriceCents: 800,
      }],
    };
    const order = session.confirmDraft(completedDraft);
    const details = session.getOrder(order.id);

    expect(details).toMatchObject({
      order: { orderNumber: 'MANUAL-ENTRY-001' },
      sourceScreenshot: { originalName: '人工录入来源.png' },
      sourceSnapshot: {
        recognition: { orderNumber: '', recipient: '', amountCents: null },
        confirmed: {
          orderNumber: 'MANUAL-ENTRY-001',
          recipient: '人工收件人',
          amountCents: 800,
        },
      },
    });
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

  it('取消未入库草稿后再次提交相同内容会重新识别而不是重复跳过', async () => {
    let recognitionCount = 0;
    const recognize = vi.fn<Recognizer['recognize']>(async () => {
      recognitionCount += 1;
      return attempt(`CANCELLED-RETRY-${recognitionCount}`);
    });
    const session = await openSession({ recognize });
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-cancelled-retry-'));
    const firstPath = join(root, '首次处理.png');
    const retryPath = join(root, '取消后重试.png');
    await Promise.all([
      writeFile(firstPath, 'same-cancelled-image'),
      writeFile(retryPath, 'same-cancelled-image'),
    ]);

    await session.submitSourceScreenshots([firstPath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0]?.items[0]?.status)
        .toBe('awaiting_confirmation');
    });
    session.cancelDraft(session.listRecognitionBatches()[0].items[0].draftId!);
    expect(session.listOrders()).toEqual([]);

    const retry = await session.submitSourceScreenshots([retryPath]);
    await eventually(() => {
      expect(session.listRecognitionBatches().find((batch) => batch.id === retry.id))
        .toMatchObject({
          counts: { awaiting_confirmation: 1, duplicate_skipped: 0 },
        });
    });
    expect(recognize).toHaveBeenCalledTimes(2);
  });

  it('重新打开同一数据目录后恢复完整识别批次记录并允许重传已取消截图', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-batch-persisted-history-'));
    const dataDirectory = join(root, '订单数据');
    const preferencesDirectory = join(root, '启动配置');
    const sourcePaths = [
      join(root, '已取消.png'),
      join(root, '批内重复.png'),
      join(root, '已入库.png'),
      join(root, '等待重试.png'),
      join(root, '识别失败.png'),
    ];
    await Promise.all([
      writeFile(sourcePaths[0], 'persisted-shared-image'),
      writeFile(sourcePaths[1], 'persisted-shared-image'),
      writeFile(sourcePaths[2], 'persisted-imported-image'),
      writeFile(sourcePaths[3], 'persisted-temporary-error'),
      writeFile(sourcePaths[4], 'persisted-permanent-error'),
    ]);
    const recognize = vi.fn<Recognizer['recognize']>()
      .mockResolvedValueOnce(attempt('PERSISTED-HISTORY'))
      .mockResolvedValueOnce(attempt('PERSISTED-IMPORTED'))
      .mockRejectedValueOnce(new Error('百炼 OCR 当前限流或额度不足，请稍后再试'))
      .mockRejectedValueOnce(new Error('百炼 OCR 无法识别这张截图，请确认图片完整清晰'));
    const first = new DesktopSession(
      new Preferences(preferencesDirectory),
      { recognize },
      unusedOcrSettings,
    );
    sessions.push(first);
    first.useDataDirectory(dataDirectory);

    const originalBatch = await first.submitSourceScreenshots(sourcePaths);
    await eventually(() => {
      expect(first.listRecognitionBatches()[0]?.processedCount).toBe(4);
    });
    first.cancelDraft(first.listRecognitionBatches()[0].items[0].draftId!);
    const importedDraft = first.getDraft(
      first.listRecognitionBatches()[0].items[2].draftId!,
    );
    first.confirmDraft(importedDraft);
    expect(first.listRecognitionBatches()[0]).toMatchObject({
      id: originalBatch.id,
      totalCount: 5,
      processedCount: 4,
      counts: {
        cancelled: 1,
        duplicate_skipped: 1,
        imported: 1,
        waiting_retry: 1,
        failed: 1,
      },
    });
    first.close();

    const retryRecognition = vi.fn<Recognizer['recognize']>(async () => (
      attempt('PERSISTED-CANCELLED-RETRY')
    ));
    const reopened = new DesktopSession(
      new Preferences(preferencesDirectory),
      { recognize: retryRecognition },
      unusedOcrSettings,
    );
    sessions.push(reopened);
    reopened.useDataDirectory(dataDirectory);

    expect(reopened.listRecognitionBatches()).toMatchObject([{
      id: originalBatch.id,
      totalCount: 5,
      processedCount: 4,
      counts: {
        cancelled: 1,
        duplicate_skipped: 1,
        imported: 1,
        waiting_retry: 1,
        failed: 1,
      },
      items: [
        { sourceName: '已取消.png', status: 'cancelled' },
        { sourceName: '批内重复.png', status: 'duplicate_skipped' },
        { sourceName: '已入库.png', status: 'imported' },
        {
          sourceName: '等待重试.png',
          status: 'waiting_retry',
          errorMessage: '百炼 OCR 当前限流或额度不足，请稍后再试',
        },
        {
          sourceName: '识别失败.png',
          status: 'failed',
          errorMessage: '百炼 OCR 无法识别这张截图，请确认图片完整清晰',
        },
      ],
    }]);

    const retryPath = join(root, '重启后重试已取消.png');
    await writeFile(retryPath, 'persisted-shared-image');
    const retryBatch = await reopened.submitSourceScreenshots([retryPath]);
    await eventually(() => {
      expect(reopened.listRecognitionBatches().find((batch) => (
        batch.id === retryBatch.id
      ))).toMatchObject({
        counts: { awaiting_confirmation: 1, duplicate_skipped: 0 },
      });
    });
    expect(retryRecognition).toHaveBeenCalledOnce();
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

  it('确认或取消草稿后重启不会重新显示已经处理过的待确认原因', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-cleared-review-reasons-'));
    const dataDirectory = join(root, '订单数据');
    const paths = [join(root, '确认原因.png'), join(root, '取消原因.png')];
    await Promise.all(paths.map((path, index) => writeFile(path, `review-reason-${index}`)));
    const application = new LocalApplication({
      recognize: async (source) => recognitionAttempt(
        { ...recognition, orderNumber: `REVIEW-${source.originalName}` },
        ['targeted_review_conflict'],
      ),
    });
    application.openDataDirectory(dataDirectory);
    const batch = await application.submitRecognitionBatch(paths);
    application.confirmDraft(batch.drafts[0]);
    application.cancelDraft(batch.drafts[1].id);
    application.close();

    const reopened = new LocalApplication({ recognize: async () => attempt('SHOULD-NOT-RUN') });
    reopened.openDataDirectory(dataDirectory);
    try {
      expect(reopened.restoreRecognitionBatches()[0]).toMatchObject({
        counts: { imported: 1, cancelled: 1, awaiting_confirmation: 0 },
        items: [
          { status: 'imported', reviewIssues: [] },
          { status: 'cancelled', reviewIssues: [] },
        ],
      });
    } finally {
      reopened.close();
    }
  });
});

function attempt(orderNumber: string): Awaited<ReturnType<Recognizer['recognize']>> {
  return recognitionAttempt({ ...recognition, orderNumber });
}

function recognitionAttempt(
  result: RecognitionResult,
  reviewIssues: Awaited<ReturnType<Recognizer['recognize']>>['reviewIssues'] = [],
): Awaited<ReturnType<Recognizer['recognize']>> {
  return {
    result,
    evidences: [{
      provider: 'controlled',
      model: 'controlled',
      requestId: `request-${result.orderNumber || 'missing-order-number'}`,
      schemaVersion: 1,
      rawResponse: '{}',
    }],
    reviewIssues,
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
