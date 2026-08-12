import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';

const applications: LocalApplication[] = [];

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
});

describe('订单平台交易状态', () => {
  it('入口只接受平台交易状态，拒绝夹带履约与订单级物流', async () => {
    const { application, order } = await createConfirmedOrder('XY-PLATFORM-BOUNDARY-0001');
    const target = { orderId: order.id, expectedRevision: order.revision };

    expect(() => application.updateOrderPlatformTransactionStatus({
      targets: [target],
      patch: { fulfillmentStatus: 'delivered' },
    })).toThrow('订单交易状态修改内容包含未知字段：fulfillmentStatus');
    expect(() => application.updateOrderPlatformTransactionStatus({
      targets: [target],
      patch: { trackingNumber: 'FAKE-001' },
    })).toThrow('订单交易状态修改内容包含未知字段：trackingNumber');
  });

  it('批量修改只改变平台交易状态并记录最小差异', async () => {
    const { application, order } = await createConfirmedOrder('XY-PLATFORM-SAVE-0001');

    const [saved] = application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: order.id, expectedRevision: order.revision }],
      patch: { platformTransactionStatus: 'cancelled' },
    });

    expect(saved.order).toMatchObject({
      platformTransactionStatus: 'cancelled',
      fulfillmentStatus: 'pending_shipment',
      shippingCarrier: '',
      trackingNumber: '',
      revision: 2,
    });
    expect(saved.changeEvents[0]).toMatchObject({
      source: 'manual_edit',
      baseRevision: 1,
      resultRevision: 2,
      changes: [{
        path: 'platformTransactionStatus',
        before: 'paid',
        after: 'cancelled',
      }],
    });
  });
});

async function createConfirmedOrder(orderNumber: string) {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-platform-status-'));
  const sourcePath = join(root, '订单.png');
  await writeFile(sourcePath, Buffer.from(orderNumber));
  const application = new LocalApplication(
    new ControlledRecognizer(completeRecognition(orderNumber)),
  );
  applications.push(application);
  application.openDataDirectory(join(root, '数据'));
  const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
  return { application, order: application.confirmDraft(draft) };
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
