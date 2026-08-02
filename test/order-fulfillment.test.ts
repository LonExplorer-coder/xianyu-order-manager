import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult, Recognizer } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';

const openedApplications: LocalApplication[] = [];

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('订单状态与手工物流', () => {
  it('打开 v14 数据库时把既有订单物流迁移为空字符串', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-logistics-migration-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    await mkdir(dataDirectory);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations (version, applied_at) VALUES (14, '2026-08-03T00:00:00.000Z');
      CREATE TABLE original_orders (
        id TEXT PRIMARY KEY
      ) STRICT;
      INSERT INTO original_orders (id) VALUES ('legacy-order');
    `);
    legacy.close();

    const workspace = Workspace.open(dataDirectory);
    try {
      expect(workspace.database.prepare(`
        SELECT shipping_carrier, tracking_number
        FROM original_orders
        WHERE id = 'legacy-order'
      `).get()).toEqual({
        shipping_carrier: '',
        tracking_number: '',
      });
      expect(workspace.database.prepare(`
        SELECT MAX(version) AS version FROM schema_migrations
      `).get()).toEqual({ version: 15 });
    } finally {
      workspace.close();
    }
  });

  it('严格拒绝命令中的未知字段', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-fulfillment-input-'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeRecognition('XY-FULFILLMENT-INPUT-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));

    expect(() => application.updateOrderStatusAndLogistics({
      targets: [],
      patch: {},
      unexpected: true,
    })).toThrow('订单状态与物流修改包含未知字段：unexpected');
  });

  it('每次命令至少包含一笔目标订单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-fulfillment-empty-'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeRecognition('XY-FULFILLMENT-EMPTY-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));

    expect(() => application.updateOrderStatusAndLogistics({
      targets: [],
      patch: { fulfillmentStatus: 'shipped' },
    })).toThrow('订单状态与物流修改至少需要一笔目标订单');
  });

  it('每批最多接受 200 笔目标订单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-fulfillment-limit-'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeRecognition('XY-FULFILLMENT-LIMIT-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));

    expect(() => application.updateOrderStatusAndLogistics({
      targets: Array.from({ length: 201 }, (_, index) => ({
        orderId: `order-${index}`,
        expectedRevision: 1,
      })),
      patch: { fulfillmentStatus: 'shipped' },
    })).toThrow('订单状态与物流修改每批最多处理 200 笔订单');
  });

  it('同一批命令中的目标订单必须唯一', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-fulfillment-unique-'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeRecognition('XY-FULFILLMENT-UNIQUE-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));

    expect(() => application.updateOrderStatusAndLogistics({
      targets: [
        { orderId: 'same-order', expectedRevision: 1 },
        { orderId: 'same-order', expectedRevision: 1 },
      ],
      patch: { fulfillmentStatus: 'shipped' },
    })).toThrow('订单状态与物流修改目标不能重复');
    expect(() => application.updateOrderStatusAndLogistics({
      targets: [{ orderId: 'order-1', expectedRevision: 1, extra: true }],
      patch: { fulfillmentStatus: 'shipped' },
    })).toThrow('目标订单 1 包含未知字段：extra');
    expect(() => application.updateOrderStatusAndLogistics({
      targets: [{ orderId: 'order-1', expectedRevision: 0 }],
      patch: { fulfillmentStatus: 'shipped' },
    })).toThrow('目标订单 1 的订单版本格式无效');
  });

  it('修改内容至少含一个受支持字段并严格校验字段值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-fulfillment-patch-'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeRecognition('XY-FULFILLMENT-PATCH-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const targets = [{ orderId: 'order-1', expectedRevision: 1 }];

    expect(() => application.updateOrderStatusAndLogistics({
      targets,
      patch: {},
    })).toThrow('订单状态与物流修改至少需要一个修改字段');
    expect(() => application.updateOrderStatusAndLogistics({
      targets,
      patch: { note: '不能从此入口修改' },
    })).toThrow('订单状态与物流修改内容包含未知字段：note');
    expect(() => application.updateOrderStatusAndLogistics({
      targets,
      patch: { platformTransactionStatus: 'settled' },
    })).toThrow('平台交易状态格式无效');
    expect(() => application.updateOrderStatusAndLogistics({
      targets,
      patch: { fulfillmentStatus: 'delivered' },
    })).toThrow('履约状态格式无效');
    expect(() => application.updateOrderStatusAndLogistics({
      targets,
      patch: { shippingCarrier: 123 },
    })).toThrow('快递公司格式无效');
  });

  it('只修改订单当前值并持久化最小人工修改记录，不改写来源快照', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-fulfillment-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '待发货订单.png');
    await writeFile(sourcePath, Buffer.from('order-fulfillment-source'));
    const recognizer = new ControlledRecognizer(completeRecognition('XY-FULFILLMENT-0001'));
    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(dataDirectory);
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);
    const before = application.getOrder(order.id);

    const [saved] = application.updateOrderStatusAndLogistics({
      targets: [{ orderId: order.id, expectedRevision: order.revision }],
      patch: {
        platformTransactionStatus: 'cancelled',
        fulfillmentStatus: 'shipped',
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1234567890',
      },
    });

    expect(saved.order).toMatchObject({
      id: order.id,
      revision: 2,
      platformTransactionStatus: 'cancelled',
      fulfillmentStatus: 'shipped',
      shippingCarrier: '顺丰速运',
      trackingNumber: 'SF1234567890',
    });
    expect(saved.changeEvents).toHaveLength(1);
    expect(saved.changeEvents[0]).toMatchObject({
      source: 'manual_edit',
      sourceSnapshotId: null,
      baseRevision: 1,
      resultRevision: 2,
      changes: expect.arrayContaining([
        { path: 'platformTransactionStatus', before: 'paid', after: 'cancelled' },
        { path: 'fulfillmentStatus', before: 'pending_shipment', after: 'shipped' },
        { path: 'shippingCarrier', before: '', after: '顺丰速运' },
        { path: 'trackingNumber', before: '', after: 'SF1234567890' },
      ]),
    });
    expect(saved.changeEvents[0].changes).toHaveLength(4);
    expect(saved.sourceSnapshot).toEqual(before.sourceSnapshot);
    expect(saved.sources).toEqual(before.sources);
    const [unchanged] = application.updateOrderStatusAndLogistics({
      targets: [{ orderId: order.id, expectedRevision: 2 }],
      patch: {
        platformTransactionStatus: 'cancelled',
        fulfillmentStatus: 'shipped',
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1234567890',
      },
    });
    expect(unchanged.order.revision).toBe(2);
    expect(unchanged.changeEvents).toHaveLength(1);

    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);
    const reopened = new LocalApplication(recognizer);
    openedApplications.push(reopened);
    reopened.openDataDirectory(dataDirectory);
    expect(reopened.getOrder(order.id)).toMatchObject({
      order: {
        revision: 2,
        platformTransactionStatus: 'cancelled',
        fulfillmentStatus: 'shipped',
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF1234567890',
      },
      sourceSnapshot: before.sourceSnapshot,
      changeEvents: [{ source: 'manual_edit' }],
    });
  });

  it('批量修改任一目标版本冲突时回滚整批订单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-fulfillment-atomic-'));
    const firstPath = join(root, '订单一.png');
    const secondPath = join(root, '订单二.png');
    await writeFile(firstPath, Buffer.from('fulfillment-atomic-first'));
    await writeFile(secondPath, Buffer.from('fulfillment-atomic-second'));
    const recognizer = queuedRecognizer([
      completeRecognition('XY-FULFILLMENT-ATOMIC-0001'),
      completeRecognition('XY-FULFILLMENT-ATOMIC-0002'),
    ]);
    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const drafts = (await application.submitRecognitionBatch([firstPath, secondPath])).drafts;
    const first = application.confirmDraft(drafts[0]);
    const second = application.confirmDraft(drafts[1]);
    const firstBefore = application.getOrder(first.id);
    const secondBefore = application.getOrder(second.id);

    expect(() => application.updateOrderStatusAndLogistics({
      targets: [
        { orderId: first.id, expectedRevision: first.revision },
        { orderId: second.id, expectedRevision: second.revision + 1 },
      ],
      patch: { fulfillmentStatus: 'shipped' },
    })).toThrow('订单已在其他操作中更新，请刷新后重试');

    expect(application.getOrder(first.id)).toEqual(firstBefore);
    expect(application.getOrder(second.id)).toEqual(secondBefore);
  });

  it('空字符串清除对应物流字段，未提供字段保持不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-logistics-clear-'));
    const sourcePath = join(root, '物流清除订单.png');
    await writeFile(sourcePath, Buffer.from('order-logistics-clear'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeRecognition('XY-LOGISTICS-CLEAR-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);
    const [withLogistics] = application.updateOrderStatusAndLogistics({
      targets: [{ orderId: order.id, expectedRevision: 1 }],
      patch: { shippingCarrier: '  中通快递  ', trackingNumber: 'ZT001' },
    });

    const [cleared] = application.updateOrderStatusAndLogistics({
      targets: [{ orderId: order.id, expectedRevision: withLogistics.order.revision }],
      patch: { shippingCarrier: '   ' },
    });

    expect(cleared.order).toMatchObject({
      revision: 3,
      shippingCarrier: '',
      trackingNumber: 'ZT001',
    });
    expect(cleared.changeEvents[0].changes).toEqual([
      { path: 'shippingCarrier', before: '中通快递', after: '' },
    ]);
  });

  it('待发货查询和首页计数排除平台已取消或已退款订单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-pending-shipment-query-'));
    const paths = ['正常订单.png', '取消订单.png', '退款订单.png']
      .map((name) => join(root, name));
    await Promise.all(paths.map((path, index) => (
      writeFile(path, Buffer.from(`pending-shipment-${index}`))
    )));
    const recognizer = queuedRecognizer([
      completeRecognition('XY-PENDING-0001'),
      completeRecognition('XY-PENDING-0002'),
      completeRecognition('XY-PENDING-0003'),
    ]);
    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const drafts = (await application.submitRecognitionBatch(paths)).drafts;
    const [paid, cancelled, refunded] = drafts.map((draft) => (
      application.confirmDraft(draft)
    ));
    application.updateOrderStatusAndLogistics({
      targets: [{ orderId: cancelled.id, expectedRevision: cancelled.revision }],
      patch: { platformTransactionStatus: 'cancelled' },
    });
    application.updateOrderStatusAndLogistics({
      targets: [{ orderId: refunded.id, expectedRevision: refunded.revision }],
      patch: { platformTransactionStatus: 'refunded' },
    });

    expect(application.queryOrders({ fulfillmentStatus: 'pending_shipment' }))
      .toMatchObject({
        orders: [{ id: paid.id }],
        pendingShipmentCount: 1,
      });
    expect(application.queryOrders({ platformTransactionStatus: 'cancelled' }).orders)
      .toEqual([expect.objectContaining({ id: cancelled.id })]);
    expect(application.queryOrders({ platformTransactionStatus: 'refunded' }).orders)
      .toEqual([expect.objectContaining({ id: refunded.id })]);
  });
});

function queuedRecognizer(results: RecognitionResult[]): Recognizer {
  return {
    recognize: async () => {
      const result = results.shift();
      if (!result) throw new Error('测试识别结果已用尽');
      return {
        result,
        evidences: [{
          provider: 'controlled',
          model: 'controlled',
          requestId: '',
          schemaVersion: 1,
          rawResponse: JSON.stringify(result),
        }],
      };
    },
  };
}

function completeRecognition(orderNumber: string): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '默认闲鱼账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '测试买家',
    recipient: '测试收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-03 08:00:00',
    orderedAtNormalized: '2026-08-03T08:00:00+08:00',
    paidAtOriginal: '2026-08-03 08:00:08',
    paidAtNormalized: '2026-08-03T08:00:08+08:00',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '测试商品',
      sourceSpec: '标准款',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: false,
    }],
  };
}
