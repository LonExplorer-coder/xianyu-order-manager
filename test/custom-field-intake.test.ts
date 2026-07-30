import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { RecognitionResult, Recognizer } from '../src/core/contracts';
import { DesktopSession } from '../src/main/desktop-session';
import { OcrSettingsService } from '../src/main/ocr-settings';
import { Preferences } from '../src/main/preferences';

const sessions: DesktopSession[] = [];

const completeRecognition: RecognitionResult = {
  platform: 'xianyu',
  sellerAccount: '自定义字段测试账号',
  orderNumber: 'CUSTOM-FIELD-INTAKE-001',
  alipayTransactionNumber: 'ALI-CUSTOM-FIELD-INTAKE-001',
  buyerNickname: '买***家',
  recipient: '张三',
  phone: '13800000000',
  phoneNormalized: '13800000000',
  addressOriginal: '广东省深圳市南山区测试路1号',
  addressNormalized: '广东省深圳市南山区测试路1号',
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
    sourceTitle: '自定义字段测试商品',
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

describe('自定义字段参与订单入库', () => {
  it('订单级必填字段没有默认值时阻止自动入库并留待确认原因', async () => {
    const session = await openSession('REQUIRED-CUSTOM-FIELD');
    session.createCustomFieldDefinition({
      name: '仓库备注',
      granularity: 'order',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    session.saveOrderIntakeSettings({ automaticImportEnabled: true });
    const sourcePath = await createSourceScreenshot('缺少必填字段.png');

    await session.submitSourceScreenshots([sourcePath]);

    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { awaiting_confirmation: 1, imported: 0 },
        items: [{
          status: 'awaiting_confirmation',
          reviewIssues: expect.arrayContaining(['missing_required_custom_field']),
        }],
      });
    });
    expect(session.listOrders()).toEqual([]);
  });

  it('订单级必填字段有默认值时可自动入库并保存默认值', async () => {
    const session = await openSession('DEFAULT-CUSTOM-FIELD');
    const definition = session.createCustomFieldDefinition({
      name: '处理渠道',
      granularity: 'order',
      type: 'single_select',
      required: true,
      defaultValue: '本机入库',
      options: ['本机入库', '人工录入'],
    });
    session.saveOrderIntakeSettings({ automaticImportEnabled: true });
    const sourcePath = await createSourceScreenshot('使用默认值.png');

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
      customFieldDefinitions: [{
        id: definition.id,
        granularity: 'order',
        defaultValue: '本机入库',
      }],
      customFieldValues: [{
        definitionId: definition.id,
        orderId: order.id,
        orderItemId: null,
        value: '本机入库',
      }],
    });
  });

  it('商品级必填字段不改变仅由订单级字段拦截自动入库的规则', async () => {
    const session = await openSession('ITEM-REQUIRED-CUSTOM-FIELD');
    session.createCustomFieldDefinition({
      name: '商品库位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    session.saveOrderIntakeSettings({ automaticImportEnabled: true });
    const sourcePath = await createSourceScreenshot('商品必填字段不拦截自动入库.png');

    await session.submitSourceScreenshots([sourcePath]);

    await eventually(() => {
      expect(session.listRecognitionBatches()[0]).toMatchObject({
        counts: { imported: 1, awaiting_confirmation: 0 },
        items: [{ status: 'imported', reviewIssues: [] }],
      });
      expect(session.listOrders()).toHaveLength(1);
    });
    expect(session.getOrder(session.listOrders()[0].id).customFieldValues).toEqual([]);
  });

  it('人工确认可为草稿单独补齐必填自定义字段后入库', async () => {
    const session = await openSession('MANUAL-CUSTOM-FIELD');
    const definition = session.createCustomFieldDefinition({
      name: '客服备注',
      granularity: 'order',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    session.saveOrderIntakeSettings({ automaticImportEnabled: true });
    const sourcePath = await createSourceScreenshot('人工补齐必填字段.png');

    await session.submitSourceScreenshots([sourcePath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0].counts.awaiting_confirmation).toBe(1);
    });
    const item = session.listRecognitionBatches()[0].items[0];
    expect(item.reviewIssues).toContain('missing_required_custom_field');
    expect(session.listOrders()).toEqual([]);
    const draft = session.getDraft(item.draftId!);

    const outcome = session.confirmDraft(draft, {
      orderValues: [{ definitionId: definition.id, value: '人工已核对' }],
      itemValues: [],
    });

    expect(outcome.resolution).toBe('new_order');
    expect(session.listRecognitionBatches()[0]).toMatchObject({
      counts: { imported: 1, awaiting_confirmation: 0 },
      items: [{ status: 'imported', reviewIssues: [] }],
    });
    expect(session.getOrder(outcome.order.id)).toMatchObject({
      order: { orderNumber: 'MANUAL-CUSTOM-FIELD' },
      customFieldValues: [{
        definitionId: definition.id,
        orderId: outcome.order.id,
        orderItemId: null,
        value: '人工已核对',
      }],
    });
  });
});

async function openSession(orderNumber: string): Promise<DesktopSession> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-custom-field-intake-'));
  const session = new DesktopSession(
    new Preferences(join(root, '启动配置')),
    { recognize: async () => recognitionAttempt(orderNumber) },
    unusedOcrSettings,
  );
  sessions.push(session);
  session.useDataDirectory(join(root, '订单数据'));
  return session;
}

async function createSourceScreenshot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-custom-field-source-'));
  const sourcePath = join(root, name);
  await writeFile(sourcePath, name);
  return sourcePath;
}

function recognitionAttempt(
  orderNumber: string,
): Awaited<ReturnType<Recognizer['recognize']>> {
  return {
    result: { ...completeRecognition, orderNumber },
    evidences: [{
      provider: 'controlled',
      model: 'controlled',
      requestId: `request-${orderNumber}`,
      schemaVersion: 1,
      rawResponse: '{}',
    }],
    reviewIssues: [],
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
