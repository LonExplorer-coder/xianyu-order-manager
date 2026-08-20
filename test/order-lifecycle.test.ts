import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PERMANENT_DELETE_CONFIRMATION,
  orderTrashExpiresAt,
} from '../src/core/order-lifecycle';
import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';

const openedApplications: LocalApplication[] = [];

class SequenceRecognizer implements Recognizer {
  public constructor(private readonly results: RecognitionResult[]) {}

  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result = this.results.shift();
    if (!result) throw new Error('测试识别结果已用尽');
    return {
      result: structuredClone(result),
      evidences: [{
        provider: 'controlled',
        model: 'controlled',
        requestId: result.orderNumber,
        schemaVersion: 1,
        rawResponse: JSON.stringify(result),
      }],
    };
  }
}

function recognition(orderNumber: string, phone = '13800000001'): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '回收站测试账号',
    orderNumber,
    alipayTransactionNumber: `ALI-${orderNumber}`,
    buyerNickname: '海棠买家',
    recipient: '陈海棠',
    phone,
    phoneNormalized: phone,
    addressOriginal: '上海市浦东新区海棠路 1 号',
    addressNormalized: '上海市浦东新区海棠路1号',
    province: '上海市',
    city: '上海市',
    district: '浦东新区',
    orderedAtOriginal: '2026-08-20 09:30:00',
    orderedAtNormalized: '2026-08-20T09:30:00+08:00',
    paidAtOriginal: '2026-08-20 09:31:00',
    paidAtNormalized: '2026-08-20T09:31:00+08:00',
    productTotalCents: 3_600,
    shippingFeeCents: 0,
    amountCents: 3_600,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '夏日海棠杯',
      sourceSpec: '红色 450ml',
      unitPriceCents: 1_800,
      quantity: 2,
      quantityInferred: false,
    }],
  };
}

async function createApplication(results: RecognitionResult[]) {
  const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-order-lifecycle-'));
  const dataDirectory = join(testRoot, '数据');
  const uploadDirectory = join(testRoot, '上传');
  await mkdir(uploadDirectory, { recursive: true });
  const application = new LocalApplication(new SequenceRecognizer([...results]));
  application.openDataDirectory(dataDirectory);
  openedApplications.push(application);
  const orders = [];
  for (const [index, result] of results.entries()) {
    const sourcePath = join(uploadDirectory, `订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`synthetic-lifecycle-order-${index}`));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    orders.push(application.confirmDraft(batch.drafts[0]));
  }
  return { application, dataDirectory, orders };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('订单生命周期操作', () => {
  it('订单详情汇总相关的发货组调整记录和订单生命周期操作', async () => {
    const { application, orders } = await createApplication([
      recognition('XY-HISTORY-001'),
      recognition('XY-HISTORY-002'),
    ]);
    const initialGroup = application.queryShipmentGroups().groups[0];
    const adjustment = application.splitShipmentGroup({
      groupId: initialGroup.id,
      expectedMemberOrderIds: initialGroup.orders.map(({ id }) => id),
      splitOrderIds: [orders[0].id],
      reason: '订单历史时间线验证拆分原因',
    });
    const trashed = application.moveOrderToTrash({
      orderId: orders[0].id,
      expectedRevision: orders[0].revision,
    }, '2026-08-21T00:00:00.000Z');
    application.restoreOrderFromTrash({
      orderId: orders[0].id,
      expectedRevision: trashed.order.revision,
    }, '2026-08-21T01:00:00.000Z');

    const details = application.getOrder(orders[0].id);
    expect(details.shipmentGroupAdjustmentEvents).toEqual([adjustment.event]);
    expect(details.lifecycleEvents.map(({ action }) => action)).toEqual([
      'restored',
      'moved_to_trash',
    ]);
    expect(application.getOrder(orders[1].id).shipmentGroupAdjustmentEvents)
      .toEqual([adjustment.event]);
    expect(application.getOrder(orders[1].id).lifecycleEvents).toEqual([]);
  });

  it('移入回收站后排除正常工作流，恢复时保留商品、来源和合并关系', async () => {
    const { application, orders } = await createApplication([
      recognition('XY-TRASH-001'),
      recognition('XY-TRASH-002'),
    ]);
    const initialGroup = application.queryShipmentGroups().groups[0];
    expect(initialGroup.orders.map(({ id }) => id).sort()).toEqual(
      orders.map(({ id }) => id).sort(),
    );
    const split = application.splitShipmentGroup({
      groupId: initialGroup.id,
      expectedMemberOrderIds: orders.map(({ id }) => id),
      splitOrderIds: [orders[0].id],
      reason: '验证回收站前的手工分组关系',
    });
    const merged = application.mergeShipmentGroups({
      groupIds: split.projection.groups.map(({ id }) => id),
      expectedMemberOrderIds: orders.map(({ id }) => id),
      selectedRecipientOrderId: null,
      reason: '验证恢复后重放原手工组',
    });
    const manualGroupId = merged.event.targetGroupId;
    expect(merged.projection.groups).toEqual([
      expect.objectContaining({
        id: manualGroupId,
        orders: expect.arrayContaining(orders.map(({ id }) => expect.objectContaining({ id }))),
      }),
    ]);
    const before = application.getOrder(orders[0].id);
    const sourceId = before.sourceScreenshot?.id;

    const trashed = application.moveOrderToTrash({
      orderId: orders[0].id,
      expectedRevision: orders[0].revision,
    }, '2026-08-21T00:00:00.000Z');

    expect(trashed.order).toMatchObject({
      id: orders[0].id,
      lifecycleStatus: 'trashed',
      revision: orders[0].revision + 1,
      updatedAt: '2026-08-21T00:00:00.000Z',
    });
    expect(trashed.order.items).toEqual(before.order.items);
    expect(trashed.sourceScreenshot?.id).toBe(sourceId);
    expect(application.listOrders().map(({ id }) => id)).toEqual([orders[1].id]);
    expect(application.queryOrders({ lifecycleStatus: 'trashed' }).orders)
      .toEqual([expect.objectContaining({ id: orders[0].id })]);
    expect(application.queryShipmentGroups().groups).toEqual([
      expect.objectContaining({
        id: manualGroupId,
        orders: [expect.objectContaining({ id: orders[1].id })],
      }),
    ]);
    expect(application.listOrderLifecycleEvents(orders[0].id)).toEqual([
      expect.objectContaining({
        action: 'moved_to_trash',
        initiator: 'user',
        beforeStatus: 'active',
        afterStatus: 'trashed',
      }),
    ]);

    const restored = application.restoreOrderFromTrash({
      orderId: orders[0].id,
      expectedRevision: trashed.order.revision,
    }, '2026-08-21T01:00:00.000Z');

    expect(restored.order).toMatchObject({
      lifecycleStatus: 'active',
      revision: orders[0].revision + 2,
    });
    expect(restored.order.items).toEqual(before.order.items);
    expect(restored.sourceScreenshot?.id).toBe(sourceId);
    expect(application.queryShipmentGroups().groups).toEqual([
      expect.objectContaining({
        id: manualGroupId,
        orders: expect.arrayContaining(orders.map(({ id }) => expect.objectContaining({ id }))),
      }),
    ]);
    expect(application.listOrderLifecycleEvents(orders[0].id).map(({ action }) => action))
      .toEqual(['restored', 'moved_to_trash']);
    expect(() => application.restoreOrderFromTrash({
      orderId: orders[0].id,
      expectedRevision: restored.order.revision,
    })).toThrow('只有回收站订单');
  });

  it('永久删除需要显式确认且不能恢复，审计证据仍保留', async () => {
    const { application, orders } = await createApplication([
      recognition('XY-DELETE-001'),
    ]);
    const before = application.getOrder(orders[0].id);
    const trashed = application.moveOrderToTrash({
      orderId: orders[0].id,
      expectedRevision: orders[0].revision,
    }, '2026-06-01T00:00:00.000Z');

    expect(() => application.permanentlyDeleteOrder({
      orderId: orders[0].id,
      expectedRevision: trashed.order.revision,
      confirmation: '删除',
    })).toThrow('请确认输入“永久删除”');

    const deleted = application.permanentlyDeleteOrder({
      orderId: orders[0].id,
      expectedRevision: trashed.order.revision,
      confirmation: PERMANENT_DELETE_CONFIRMATION,
    }, '2026-06-02T00:00:00.000Z');

    expect(deleted.order.lifecycleStatus).toBe('deleted');
    expect(deleted.order.items).toEqual(before.order.items);
    expect(deleted.sources).toEqual(before.sources);
    expect(application.queryOrders({ lifecycleStatus: 'deleted' }).orders)
      .toEqual([expect.objectContaining({ id: orders[0].id })]);
    expect(() => application.restoreOrderFromTrash({
      orderId: orders[0].id,
      expectedRevision: deleted.order.revision,
    })).toThrow('永久删除的订单不能恢复');
    expect(application.listOrderLifecycleEvents(orders[0].id).map((event) => ({
      action: event.action,
      initiator: event.initiator,
    }))).toEqual([
      { action: 'permanently_deleted', initiator: 'user' },
      { action: 'moved_to_trash', initiator: 'user' },
    ]);
    const lifecycleEventId = application.listOrderLifecycleEvents(orders[0].id)[0].id;
    expect(() => application.database.prepare(
      'UPDATE order_lifecycle_events SET created_at = ? WHERE id = ?',
    ).run('2026-06-03T00:00:00.000Z', lifecycleEventId)).toThrow(
      /order lifecycle events are immutable/,
    );
  });

  it('30 天保留期结束后由系统永久删除，普通软删除不改写发货档案与快照', async () => {
    const { application, dataDirectory, orders } = await createApplication([
      recognition('XY-EXPIRE-001', '13800000002'),
    ]);
    const group = application.queryShipmentGroups().groups[0];
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-LIFECYCLE-001',
        items: remainingItems,
      }],
    });
    const archiveBefore = structuredClone(application.queryShipmentGroupArchives());
    const shipped = application.getOrder(orders[0].id).order;
    application.moveOrderToTrash({
      orderId: shipped.id,
      expectedRevision: shipped.revision,
    }, '2026-06-01T00:00:00.000Z');

    expect(application.queryShipmentGroupArchives()).toEqual(archiveBefore);
    expect(application.database.prepare(
      'SELECT COUNT(*) AS count FROM shipment_records WHERE id = ?',
    ).get(shipment.record.id)).toEqual({ count: 1 });
    expect(orderTrashExpiresAt('2026-06-01T00:00:00.000Z'))
      .toBe('2026-07-01T00:00:00.000Z');
    expect(application.expireTrashedOrders('2026-06-30T23:59:59.999Z')).toBe(0);
    application.close();
    const reopened = new LocalApplication({
      recognize: async () => { throw new Error('重启清理不应调用 OCR'); },
    });
    reopened.openDataDirectory(dataDirectory);
    openedApplications.push(reopened);
    expect(reopened.getOrder(orders[0].id).order.lifecycleStatus).toBe('deleted');
    expect(reopened.queryShipmentGroupArchives()).toEqual(archiveBefore);
    expect(reopened.listOrderLifecycleEvents(orders[0].id)[0]).toMatchObject({
      action: 'retention_expired',
      initiator: 'system',
      beforeStatus: 'trashed',
      afterStatus: 'deleted',
    });
  });
});
