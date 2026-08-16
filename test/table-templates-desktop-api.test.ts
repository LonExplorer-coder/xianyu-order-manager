import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import type { CreateTableTemplateInput } from '../src/core/table-templates';
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

describe('表格模板桌面接口', () => {
  it('通过窄接口管理多套模板，重启后仍能按数据粒度读取', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-template-session-'));
    const preferences = new Preferences(join(testRoot, '启动配置'));
    const dataDirectory = join(testRoot, '订单数据');
    const first = createSession(preferences);
    first.useDataDirectory(dataDirectory);
    const ordersChanged = vi.fn();
    first.onOrdersChanged(ordersChanged);

    const orderTemplate = first.createTableTemplate({
      name: '待发货订单',
      granularity: 'order',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
        { field: { kind: 'computed', key: 'order_total' }, displayName: '订单总额' },
      ],
      query: {
        fulfillmentStatus: 'pending_shipment',
        sortField: 'amount',
        sortDirection: 'desc',
      },
    });
    const itemTemplate = first.createTableTemplate({
      name: '商品明细',
      granularity: 'order_item',
      columns: [
        { field: { kind: 'builtin', key: 'product_title' }, displayName: '商品' },
        { field: { kind: 'computed', key: 'item_subtotal' }, displayName: '小计' },
      ],
      query: {},
    });

    expect(first.listTableTemplates().map(({ id }) => id).sort()).toEqual(
      [orderTemplate.id, itemTemplate.id].sort(),
    );
    expect(first.listTableTemplates('order_item')).toEqual([itemTemplate]);
    const updated = first.updateTableTemplate(orderTemplate.id, {
      name: '待发货订单清单',
      columns: [
        { field: { kind: 'computed', key: 'order_total' }, displayName: '成交金额' },
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '平台订单号' },
      ],
      query: { fulfillmentStatus: 'pending_shipment' },
    });
    expect(updated).toMatchObject({
      id: orderTemplate.id,
      name: '待发货订单清单',
      granularity: 'order',
    });
    expect(ordersChanged).not.toHaveBeenCalled();

    first.close();
    sessions.splice(sessions.indexOf(first), 1);
    const reopened = createSession(preferences);
    expect(reopened.restore()).toMatchObject({ kind: 'ready', dataDirectory });
    expect(reopened.listTableTemplates('order')).toEqual([updated]);
    reopened.deleteTableTemplate(updated.id);
    expect(reopened.listTableTemplates()).toEqual([itemTemplate]);
    expect(ordersChanged).not.toHaveBeenCalled();
  });

  it('在桌面边界拒绝任意公式、未知字段和非法模板 ID', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-template-boundary-'));
    const session = createSession(new Preferences(join(testRoot, '启动配置')));
    session.useDataDirectory(join(testRoot, '订单数据'));
    const valid: CreateTableTemplateInput = {
      name: '日常订单',
      granularity: 'order',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
      ],
      query: {},
    };

    expect(() => session.createTableTemplate({
      ...valid,
      formula: 'amount * quantity',
    } as CreateTableTemplateInput)).toThrow(/未知属性/);
    expect(() => session.createTableTemplate({
      ...valid,
      columns: [{
        field: { kind: 'builtin', key: 'order_number', expression: '1 + 1' },
        displayName: '订单号',
      }],
    } as unknown as CreateTableTemplateInput)).toThrow(/未知属性/);
    expect(() => session.createTableTemplate({
      ...valid,
      columns: [{
        field: { kind: 'builtin', key: 'not_a_field' },
        displayName: '未知字段',
      }],
    } as unknown as CreateTableTemplateInput)).toThrow(/字段无效/);
    expect(() => session.updateTableTemplate('', {
      name: '日常订单',
      columns: valid.columns,
      query: {},
    })).toThrow(/ID/);
    expect(() => session.deleteTableTemplate('x'.repeat(201))).toThrow(/ID/);
    expect(session.listTableTemplates()).toEqual([]);
  });

  it('按粒度持久化模板选中，删除模板时清除其偏好记录', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-template-active-'));
    const preferences = new Preferences(join(testRoot, '启动配置'));
    const first = createSession(preferences);
    first.useDataDirectory(join(testRoot, '订单数据'));
    const orderTemplate = first.createTableTemplate({
      name: '待发货订单',
      granularity: 'order',
      columns: [{ field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' }],
      query: { fulfillmentStatus: 'pending_shipment' },
    });
    const groupTemplate = first.createTableTemplate({
      name: '按拣货区',
      granularity: 'shipment_group',
      columns: [{ field: { kind: 'builtin', key: 'shipment_group_id' }, displayName: '发货组标识' }],
      query: {},
    });

    expect(first.getActiveTableTemplates()).toEqual({});
    first.setActiveTableTemplate('order', orderTemplate.id);
    first.setActiveTableTemplate('shipment_group', groupTemplate.id);
    expect(first.getActiveTableTemplates()).toEqual({
      order: orderTemplate.id,
      shipment_group: groupTemplate.id,
    });
    first.close();
    sessions.splice(sessions.indexOf(first), 1);

    const reopened = createSession(preferences);
    reopened.useDataDirectory(join(testRoot, '订单数据'));
    expect(reopened.getActiveTableTemplates()).toEqual({
      order: orderTemplate.id,
      shipment_group: groupTemplate.id,
    });

    reopened.setActiveTableTemplate('order', null);
    expect(reopened.getActiveTableTemplates()).toEqual({
      shipment_group: groupTemplate.id,
    });

    reopened.setActiveTableTemplate('order', orderTemplate.id);
    reopened.deleteTableTemplate(orderTemplate.id);
    expect(reopened.getActiveTableTemplates()).toEqual({
      shipment_group: groupTemplate.id,
    });

    expect(() => reopened.setActiveTableTemplate('unknown', 'template-x'))
      .toThrow(/粒度/);
    expect(() => reopened.setActiveTableTemplate('order', ''))
      .toThrow(/标识/);
  });
});

function createSession(preferences: Preferences): DesktopSession {
  const session = new DesktopSession(
    preferences,
    new ControlledRecognizer(unusedRecognition),
    unusedOcrSettings,
  );
  sessions.push(session);
  return session;
}
