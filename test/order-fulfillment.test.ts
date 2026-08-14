import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult, Recognizer } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';
import { removeVersion31ExtensionArtifacts } from './version31-fixture';

const applications: LocalApplication[] = [];

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
});

describe('事实驱动的订单履约', () => {
  it('OCR 运行时结果只能提供未知、待发货或已发货三种基础状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-ocr-status-boundary-'));
    const sourcePath = join(root, 'OCR 越界履约状态.png');
    await writeFile(sourcePath, Buffer.from('ocr-status-boundary'));
    const invalidRecognition = {
      ...recognition('XY-OCR-STATUS-BOUNDARY-0001'),
      fulfillmentStatus: 'delivered',
    } as unknown as RecognitionResult;
    const application = new LocalApplication(new ControlledRecognizer(invalidRecognition));
    applications.push(application);
    application.openDataDirectory(join(root, '数据'));

    await expect(application.submitRecognitionBatch([sourcePath])).rejects.toThrow(
      'OCR 识别履约状态格式错误',
    );
    expect(application.listOrders()).toEqual([]);
  });

  it.each(['delivered', 'returned'] as const)(
    '真实 v25 的旧版整单 %s 值升级后回到来源基础状态并收窄表约束',
    async (legacyStatus) => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-returned-status-migration-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '待发货订单.png');
    await writeFile(sourcePath, Buffer.from('legacy-returned-status'));
    const application = new LocalApplication(
      new ControlledRecognizer(recognition('XY-RETURNED-MIGRATION-0001')),
    );
    application.openDataDirectory(dataDirectory);
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);
    application.close();

    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    removeVersion31ExtensionArtifacts(database);
    database.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
    database.prepare(`UPDATE original_orders SET fulfillment_status = ? WHERE id = ?`)
      .run(legacyStatus, order.id);
    database.prepare(`UPDATE order_drafts SET fulfillment_status = ? WHERE id = ?`)
      .run(legacyStatus, draft.id);
    database.exec(`
      DROP TRIGGER original_orders_system_order_number_is_immutable;
      DROP TRIGGER original_orders_require_system_order_number_on_insert;
      DROP INDEX original_orders_by_system_order_number;
      ALTER TABLE original_orders DROP COLUMN system_order_number;
      DELETE FROM schema_migrations WHERE version IN (26, 27, 28, 29, 30, 31);
    `);
    database.exec('PRAGMA ignore_check_constraints = OFF;');
    database.close();

    const upgraded = Workspace.open(dataDirectory);
    try {
      expect(upgraded.database.prepare(`
        SELECT fulfillment_status FROM original_orders WHERE id = ?
      `).get(order.id)).toEqual({ fulfillment_status: 'pending_shipment' });
      expect(upgraded.database.prepare(`
        SELECT fulfillment_status FROM order_drafts WHERE id = ?
      `).get(draft.id)).toEqual({ fulfillment_status: 'pending_shipment' });
      expect(upgraded.database.prepare(`
        SELECT MAX(version) AS version FROM schema_migrations
      `).get()).toEqual({ version: 38 });
      expect(() => upgraded.database.prepare(`
        UPDATE original_orders SET fulfillment_status = 'returned' WHERE id = ?
      `).run(order.id)).toThrow();
      expect(() => upgraded.database.prepare(`
        UPDATE order_drafts SET fulfillment_status = 'delivered' WHERE id = ?
      `).run(draft.id)).toThrow();
    } finally {
      upgraded.close();
    }
    },
  );

  it('平台取消或退款只影响待发货查询资格，不改写履约状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-pending-shipment-query-'));
    const paths = ['正常订单.png', '取消订单.png', '退款订单.png']
      .map((name) => join(root, name));
    await Promise.all(paths.map((path, index) => writeFile(path, `pending-${index}`)));
    const application = new LocalApplication(queuedRecognizer([
      recognition('XY-PENDING-0001'),
      recognition('XY-PENDING-0002'),
      recognition('XY-PENDING-0003'),
    ]));
    applications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const drafts = (await application.submitRecognitionBatch(paths)).drafts;
    const [paid, cancelled, refunded] = drafts.map((draft) => application.confirmDraft(draft));
    application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: cancelled.id, expectedRevision: cancelled.revision }],
      patch: { platformTransactionStatus: 'cancelled' },
    });
    application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: refunded.id, expectedRevision: refunded.revision }],
      patch: { platformTransactionStatus: 'refunded' },
    });

    expect(application.getOrder(cancelled.id).order.fulfillmentStatus).toBe('pending_shipment');
    expect(application.getOrder(refunded.id).order.fulfillmentStatus).toBe('pending_shipment');
    expect(application.queryOrders({ fulfillmentStatus: 'pending_shipment' })).toMatchObject({
      orders: [{ id: paid.id }],
      pendingShipmentCount: 1,
    });
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

function recognition(orderNumber: string): RecognitionResult {
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
