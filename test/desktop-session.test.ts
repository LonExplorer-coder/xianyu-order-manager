import { access, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import { DesktopSession } from '../src/main/desktop-session';
import { OcrSettingsService } from '../src/main/ocr-settings';
import { Preferences } from '../src/main/preferences';

const sessions: DesktopSession[] = [];
const unusedRecognition: RecognitionResult = {
  platform: 'xianyu',
  sellerAccount: '默认闲鱼账号',
  orderNumber: 'unused',
  alipayTransactionNumber: '',
  buyerNickname: '',
  recipient: 'unused',
  phone: 'unused',
  phoneNormalized: '',
  addressOriginal: 'unused',
  addressNormalized: 'unused',
  province: '',
  city: '',
  district: '',
  orderedAtOriginal: '',
  orderedAtNormalized: '',
  paidAtOriginal: '',
  paidAtNormalized: '',
  productTotalCents: 0,
  shippingFeeCents: 0,
  amountCents: 0,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  items: [],
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

describe('桌面启动状态', () => {
  it('通过桌面会话公开订单工作台查询', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-desktop-workbench-'));
    const session = new DesktopSession(
      new Preferences(join(testRoot, '启动配置')),
      new ControlledRecognizer(unusedRecognition),
      unusedOcrSettings,
    );
    sessions.push(session);
    session.useDataDirectory(join(testRoot, '订单数据'));

    expect(session.queryOrders({})).toEqual({
      orders: [],
      customFieldValues: [],
      allLifecycleOrderCount: 0,
      activeOrderCount: 0,
      pendingShipmentCount: 0,
      platforms: [],
      sellerAccounts: [],
    });
    expect(session.queryShipmentGroups()).toEqual({
      groups: [],
      attentionOrders: [],
    });
  });

  it('首次要求选择数据目录，并在重启后自动打开最近目录', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-desktop-session-'));
    const preferences = new Preferences(join(testRoot, '启动配置'));
    const dataDirectory = join(testRoot, '订单数据');
    const recognizer = new ControlledRecognizer(unusedRecognition);

    const first = new DesktopSession(preferences, recognizer, unusedOcrSettings);
    sessions.push(first);
    expect(first.restore()).toEqual({ kind: 'needs_data_directory' });
    expect(first.useDataDirectory(dataDirectory)).toMatchObject({
      kind: 'ready',
      dataDirectory,
      orders: [],
    });
    first.close();
    sessions.splice(sessions.indexOf(first), 1);

    const reopened = new DesktopSession(preferences, recognizer, unusedOcrSettings);
    sessions.push(reopened);
    expect(reopened.restore()).toMatchObject({
      kind: 'ready',
      dataDirectory,
      orders: [],
    });
  });

  it('已连接时切换到不可用目录会保留当前工作区和启动指针', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-directory-switch-rollback-'));
    const preferences = new Preferences(join(testRoot, '启动配置'));
    const currentDataDirectory = join(testRoot, '当前订单数据');
    const rejectedDataDirectory = join(testRoot, '不可用订单数据');
    const session = new DesktopSession(
      preferences,
      new ControlledRecognizer(unusedRecognition),
      unusedOcrSettings,
      (dataDirectory) => {
        if (dataDirectory === rejectedDataDirectory) {
          throw new Error('新数据目录不可用');
        }
      },
    );
    sessions.push(session);
    expect(session.useDataDirectory(currentDataDirectory)).toMatchObject({
      kind: 'ready',
      dataDirectory: currentDataDirectory,
    });

    expect(() => session.useDataDirectory(rejectedDataDirectory))
      .toThrow('新数据目录不可用');

    expect(session.getState()).toMatchObject({
      kind: 'ready',
      dataDirectory: currentDataDirectory,
      orders: [],
    });
    expect(preferences.getLastDataDirectory()).toBe(currentDataDirectory);
    expect(session.queryOrders({})).toMatchObject({ orders: [] });
  });

  it('启动遇到短暂错误后可重新打开记住的数据目录', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-desktop-retry-'));
    const preferences = new Preferences(join(testRoot, '启动配置'));
    const dataDirectory = join(testRoot, '订单数据');
    const recognizer = new ControlledRecognizer(unusedRecognition);

    preferences.setLastDataDirectory(dataDirectory);
    await writeFile(dataDirectory, '暂时占位');

    const session = new DesktopSession(preferences, recognizer, unusedOcrSettings);
    sessions.push(session);
    expect(session.restore()).toMatchObject({ kind: 'error' });

    await unlink(dataDirectory);
    await mkdir(dataDirectory);
    expect(session.retryDataDirectory()).toMatchObject({
      kind: 'ready',
      dataDirectory,
      orders: [],
    });
  });

  it('记住的数据目录被移除后明确报错且不静默创建空订单库', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-missing-workspace-'));
    const configDirectory = join(testRoot, '启动配置');
    const dataDirectory = join(testRoot, '订单数据');
    const recognizer = new ControlledRecognizer(unusedRecognition);
    const first = new DesktopSession(
      new Preferences(configDirectory),
      recognizer,
      unusedOcrSettings,
    );
    sessions.push(first);
    expect(first.useDataDirectory(dataDirectory)).toMatchObject({ kind: 'ready' });
    first.close();
    sessions.splice(sessions.indexOf(first), 1);
    await rm(dataDirectory, { recursive: true, force: true });

    const reopened = new DesktopSession(
      new Preferences(configDirectory),
      recognizer,
      unusedOcrSettings,
    );
    sessions.push(reopened);
    expect(reopened.restore()).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('上次使用的数据目录不存在'),
    });
    await expect(access(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('新选和恢复数据目录都必须通过目录安全校验', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-directory-validator-'));
    const preferences = new Preferences(join(testRoot, '启动配置'));
    const rememberedDirectory = join(testRoot, '已记住目录');
    const newlySelectedDirectory = join(testRoot, '新选目录');
    await mkdir(rememberedDirectory);
    preferences.setLastDataDirectory(rememberedDirectory);
    const session = new DesktopSession(
      preferences,
      new ControlledRecognizer(unusedRecognition),
      unusedOcrSettings,
      (dataDirectory) => {
        if (
          dataDirectory === rememberedDirectory ||
          dataDirectory === newlySelectedDirectory
        ) {
          throw new Error('数据目录必须位于程序目录之外');
        }
      },
    );
    sessions.push(session);

    expect(session.restore()).toEqual({
      kind: 'error',
      message: '数据目录必须位于程序目录之外',
    });
    expect(session.useDataDirectory(newlySelectedDirectory)).toEqual({
      kind: 'error',
      message: '数据目录必须位于程序目录之外',
    });
    await expect(access(newlySelectedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('自动入库只有显式开启才生效，并在重启后保留', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-auto-import-settings-'));
    const preferences = new Preferences(join(testRoot, '启动配置'));
    const recognizer = new ControlledRecognizer(unusedRecognition);
    const first = new DesktopSession(preferences, recognizer, unusedOcrSettings);
    sessions.push(first);

    expect(first.getOrderIntakeSettings()).toEqual({ automaticImportEnabled: false });
    expect(first.saveOrderIntakeSettings({ automaticImportEnabled: true })).toEqual({
      automaticImportEnabled: true,
    });
    first.close();
    sessions.splice(sessions.indexOf(first), 1);

    const reopened = new DesktopSession(preferences, recognizer, unusedOcrSettings);
    sessions.push(reopened);
    expect(reopened.getOrderIntakeSettings()).toEqual({ automaticImportEnabled: true });
    expect(reopened.saveOrderIntakeSettings({ automaticImportEnabled: false })).toEqual({
      automaticImportEnabled: false,
    });
  });

  it('自动入库设置写入成功后不因额外读取失败而向界面误报保存失败', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-auto-import-write-result-'));
    const configDirectory = join(testRoot, '启动配置');
    const preferences = new WriteThenReadFailsPreferences(configDirectory);
    const session = new DesktopSession(
      preferences,
      new ControlledRecognizer(unusedRecognition),
      unusedOcrSettings,
    );
    sessions.push(session);

    expect(session.saveOrderIntakeSettings({ automaticImportEnabled: true })).toEqual({
      automaticImportEnabled: true,
    });
    expect(new Preferences(configDirectory).getAutomaticImportEnabled()).toBe(true);
  });
});

class WriteThenReadFailsPreferences extends Preferences {
  private failReads = false;

  public override saveOrderIntakeSettings(
    input: Parameters<Preferences['saveOrderIntakeSettings']>[0],
  ): ReturnType<Preferences['saveOrderIntakeSettings']> {
    const saved = super.saveOrderIntakeSettings(input);
    this.failReads = true;
    return saved;
  }

  public override setAutomaticImportEnabled(automaticImportEnabled: boolean): void {
    this.saveOrderIntakeSettings({ automaticImportEnabled });
  }

  public override getAutomaticImportEnabled(): boolean {
    if (this.failReads) throw new Error('模拟写入后的瞬时读取失败');
    return super.getAutomaticImportEnabled();
  }
}
