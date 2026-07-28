import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import { LocalApplication } from '../src/main/local-application';

const openedApplications: LocalApplication[] = [];

afterEach(() => {
  for (const application of openedApplications.splice(0)) {
    application.close();
  }
});

describe('完整订单工作流', () => {
  it('从一张来源截图形成可校对且重启后仍可查看的原始订单', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-order-workflow-'));
    const dataDirectory = join(testRoot, '独立数据目录');
    const uploadDirectory = join(testRoot, '待上传');
    await mkdir(uploadDirectory, { recursive: true });

    const sourcePath = join(uploadDirectory, '脱敏测试订单.png');
    const sourceBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(sourcePath, sourceBytes);

    const recognizer = new ControlledRecognizer({
      platform: 'xianyu',
      sellerAccount: '默认闲鱼账号',
      orderNumber: 'XY-20260727-0001',
      buyerNickname: '测***户',
      recipient: '识别原值',
      phone: '13800000000',
      addressOriginal: '广东省深圳市南山区测试路1号',
      amountCents: 2_600,
      items: [
        {
          sourceTitle: '测试商品 A',
          sourceSpec: '白色',
          unitPriceCents: 800,
          quantity: 2,
          quantityInferred: false,
        },
        {
          sourceTitle: '测试商品 B',
          sourceSpec: '标准款',
          unitPriceCents: 1_000,
          quantity: 1,
          quantityInferred: true,
        },
      ],
    });

    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(dataDirectory);

    const batch = await application.submitRecognitionBatch([sourcePath]);
    const [draft] = batch.drafts;
    expect(batch.id).toBe(draft.batchId);
    expect(draft.status).toBe('awaiting_review');
    expect(draft.items).toHaveLength(2);

    const confirmed = application.confirmDraft({
      ...draft,
      recipient: '人工修正值',
    });
    expect(confirmed.recipient).toBe('人工修正值');
    expect(confirmed.items).toHaveLength(2);

    const beforeRestart = application.getOrder(confirmed.id);
    expect(beforeRestart.sourceSnapshot.recognition.recipient).toBe('识别原值');
    expect(beforeRestart.order.recipient).toBe('人工修正值');
    expect(beforeRestart.sourceScreenshot.originalName).toBe('脱敏测试订单.png');
    expect(
      Buffer.from(
        (await application.readSourceScreenshot(beforeRestart.sourceScreenshot.id)).bytes,
      ),
    ).toEqual(sourceBytes);

    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const reopened = new LocalApplication(recognizer);
    openedApplications.push(reopened);
    reopened.openDataDirectory(dataDirectory);

    const orders = reopened.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      orderNumber: 'XY-20260727-0001',
      recipient: '人工修正值',
      amountCents: 2_600,
      itemCount: 2,
    });
    expect(reopened.getOrder(orders[0].id).sourceSnapshot.recognition.recipient).toBe(
      '识别原值',
    );
    expect(recognizer.networkRequestCount).toBe(0);
  });
});
