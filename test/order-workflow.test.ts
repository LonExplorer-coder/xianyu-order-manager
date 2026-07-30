import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult, Recognizer } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';

const openedApplications: LocalApplication[] = [];

function completeSyntheticRecognition(orderNumber: string): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '合成测试账号',
    orderNumber,
    alipayTransactionNumber: 'ALI-SYNTH-EVIDENCE-0001',
    buyerNickname: '测***户',
    recipient: '合成收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '测试省测试市示例区安全路1号',
    addressNormalized: '测试省测试市示例区安全路1号',
    province: '测试省',
    city: '测试市',
    district: '示例区',
    orderedAtOriginal: '2026-07-29 10:00:00',
    orderedAtNormalized: '2026-07-29T10:00:00+08:00',
    paidAtOriginal: '2026-07-29 10:00:08',
    paidAtNormalized: '2026-07-29T10:00:08+08:00',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '合成测试商品',
      sourceSpec: '标准款',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: true,
    }],
  };
}

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
      alipayTransactionNumber: 'ALI-SYNTH-WORKFLOW-0001',
      buyerNickname: '测***户',
      recipient: '识别原值',
      phone: '13800000000',
      phoneNormalized: '13800000000',
      addressOriginal: '广东省深圳市南山区测试路1号',
      addressNormalized: '广东省深圳市南山区测试路1号',
      province: '广东省',
      city: '深圳市',
      district: '南山区',
      orderedAtOriginal: '2026-07-27 11:21:46',
      orderedAtNormalized: '2026-07-27T11:21:46+08:00',
      paidAtOriginal: '2026-07-27 11:21:54',
      paidAtNormalized: '2026-07-27T11:21:54+08:00',
      productTotalCents: 2_500,
      shippingFeeCents: 100,
      amountCents: 2_600,
      platformTransactionStatus: 'refunded',
      fulfillmentStatus: 'shipped',
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
    expect(draft).toMatchObject({
      alipayTransactionNumber: 'ALI-SYNTH-WORKFLOW-0001',
      phoneNormalized: '13800000000',
      addressNormalized: '广东省深圳市南山区测试路1号',
      province: '广东省',
      city: '深圳市',
      district: '南山区',
      orderedAtOriginal: '2026-07-27 11:21:46',
      orderedAtNormalized: '2026-07-27T11:21:46+08:00',
      paidAtOriginal: '2026-07-27 11:21:54',
      paidAtNormalized: '2026-07-27T11:21:54+08:00',
      productTotalCents: 2_500,
      shippingFeeCents: 100,
      amountCents: 2_600,
      platformTransactionStatus: 'refunded',
      fulfillmentStatus: 'shipped',
    });

    expect(() => application.confirmDraft({
      ...draft,
      phone: '13900000002',
    })).toThrowError('手机号格式无效，请根据截图完整修正');
    expect(() => application.confirmDraft({
      ...draft,
      addressOriginal: '测试省测试市示例区安全路2号',
    })).toThrowError('规范化地址与完整收货地址不一致');

    const confirmed = application.confirmDraft({
      ...draft,
      recipient: '人工修正值',
    });
    expect(confirmed.recipient).toBe('人工修正值');
    expect(confirmed.items).toHaveLength(2);
    expect(confirmed).toMatchObject({
      alipayTransactionNumber: 'ALI-SYNTH-WORKFLOW-0001',
      productTotalCents: 2_500,
      shippingFeeCents: 100,
      platformTransactionStatus: 'refunded',
      fulfillmentStatus: 'shipped',
      lifecycleStatus: 'active',
    });

    const beforeRestart = application.getOrder(confirmed.id);
    expect(beforeRestart.sourceSnapshot.recognition.recipient).toBe('识别原值');
    expect(beforeRestart.order.recipient).toBe('人工修正值');
    expect(beforeRestart.sourceScreenshot.originalName).toBe('脱敏测试订单.png');
    expect(JSON.stringify(beforeRestart)).not.toContain('rawResponse');
    expect(
      application.getRecognitionEvidence(beforeRestart.sourceScreenshot.id),
    ).toMatchObject({
      provider: 'controlled',
      model: 'controlled',
      schemaVersion: 1,
    });
    expect(
      application.getRecognitionEvidence(beforeRestart.sourceScreenshot.id).rawResponse,
    ).toContain('ALI-SYNTH-WORKFLOW-0001');
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
      itemCount: 3,
      platformTransactionStatus: 'refunded',
      fulfillmentStatus: 'shipped',
    });
    expect(reopened.getOrder(orders[0].id).sourceSnapshot.recognition.recipient).toBe(
      '识别原值',
    );
    expect(reopened.getOrder(orders[0].id).order).toMatchObject({
      alipayTransactionNumber: 'ALI-SYNTH-WORKFLOW-0001',
      phoneNormalized: '13800000000',
      addressNormalized: '广东省深圳市南山区测试路1号',
      province: '广东省',
      city: '深圳市',
      district: '南山区',
      orderedAtOriginal: '2026-07-27 11:21:46',
      orderedAtNormalized: '2026-07-27T11:21:46+08:00',
      paidAtOriginal: '2026-07-27 11:21:54',
      paidAtNormalized: '2026-07-27T11:21:54+08:00',
      productTotalCents: 2_500,
      shippingFeeCents: 100,
      amountCents: 2_600,
      platformTransactionStatus: 'refunded',
      fulfillmentStatus: 'shipped',
      lifecycleStatus: 'active',
    });
    expect(
      reopened.getRecognitionEvidence(
        reopened.getOrder(orders[0].id).sourceScreenshot.id,
      ).rawResponse,
    ).toContain('ALI-SYNTH-WORKFLOW-0001');
    expect(recognizer.networkRequestCount).toBe(0);
  });

  it('持久化 OCR 明确数量、系统默认 1 与人工修改的精确来源', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-quantity-source-'));
    const sourcePath = join(testRoot, '数量来源订单.png');
    await writeFile(sourcePath, Buffer.from('synthetic-quantity-source'));
    const recognition = {
      ...completeSyntheticRecognition('XY-SYNTH-QUANTITY-SOURCE-0001'),
      productTotalCents: 2_400,
      amountCents: 2_400,
      items: [
        {
          sourceTitle: 'OCR 明确商品',
          sourceSpec: '标准款',
          unitPriceCents: 800,
          quantity: 2,
          quantityInferred: false,
        },
        {
          sourceTitle: '默认数量商品',
          sourceSpec: '单件',
          unitPriceCents: 800,
          quantity: 1,
          quantityInferred: true,
        },
      ],
    };
    const application = new LocalApplication(new ControlledRecognizer(recognition));
    openedApplications.push(application);
    application.openDataDirectory(join(testRoot, '数据'));

    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    expect(draft.items.map((item) => item.quantitySource)).toEqual([
      'ocr_explicit',
      'system_default_1',
    ]);

    const order = application.confirmDraft({
      ...draft,
      items: [
        { ...draft.items[0], quantity: 3 },
        draft.items[1],
        {
          id: 'manual-added-item',
          position: 2,
          sourceTitle: '人工新增商品',
          sourceSpec: '',
          unitPriceCents: 0,
          quantity: 4,
          quantityInferred: false,
        },
      ],
    });

    expect(order.items.map(({ quantity, quantitySource }) => ({ quantity, quantitySource })))
      .toEqual([
        { quantity: 3, quantitySource: 'manual' },
        { quantity: 1, quantitySource: 'system_default_1' },
        { quantity: 4, quantitySource: 'manual' },
      ]);
    expect(application.getOrder(order.id).sourceSnapshot).toMatchObject({
      recognition: {
        items: [
          { quantity: 2, quantitySource: 'ocr_explicit' },
          { quantity: 1, quantitySource: 'system_default_1' },
        ],
      },
      confirmed: {
        items: [
          { quantity: 3, quantitySource: 'manual' },
          { quantity: 1, quantitySource: 'system_default_1' },
          { quantity: 4, quantitySource: 'manual' },
        ],
      },
    });
  });

  it('后续来源更新时按 manual 高于 OCR 明确值高于系统默认的优先级保护数量', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-quantity-priority-'));
    const firstPath = join(testRoot, '首次数量.png');
    const secondPath = join(testRoot, '后续数量.png');
    await writeFile(firstPath, Buffer.from('synthetic-quantity-priority-first'));
    await writeFile(secondPath, Buffer.from('synthetic-quantity-priority-second'));
    const orderNumber = 'XY-SYNTH-QUANTITY-PRIORITY-0001';
    const results: RecognitionResult[] = [
      {
        ...completeSyntheticRecognition(orderNumber),
        productTotalCents: 2_600,
        amountCents: 2_600,
        items: [
          {
            sourceTitle: '人工优先级商品',
            sourceSpec: '标准款',
            unitPriceCents: 800,
            quantity: 2,
            quantityInferred: false,
          },
          {
            sourceTitle: 'OCR 优先级商品',
            sourceSpec: '标准款',
            unitPriceCents: 500,
            quantity: 2,
            quantityInferred: false,
          },
        ],
      },
      {
        ...completeSyntheticRecognition(orderNumber),
        productTotalCents: 3_700,
        amountCents: 3_700,
        items: [
          {
            sourceTitle: '人工优先级商品',
            sourceSpec: '标准款',
            unitPriceCents: 800,
            quantity: 4,
            quantityInferred: false,
          },
          {
            sourceTitle: 'OCR 优先级商品',
            sourceSpec: '标准款',
            unitPriceCents: 500,
            quantity: 1,
            quantityInferred: true,
          },
        ],
      },
    ];
    const recognizer: Recognizer = {
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
            rawResponse: '{}',
          }],
        };
      },
    };
    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(join(testRoot, '数据'));

    const [firstDraft] = (await application.submitRecognitionBatch([firstPath])).drafts;
    const existing = application.confirmDraft({
      ...firstDraft,
      items: [{ ...firstDraft.items[0], quantity: 3 }, firstDraft.items[1]],
    });
    expect(existing.items[0]).toMatchObject({ quantity: 3, quantitySource: 'manual' });
    expect(existing.items[1]).toMatchObject({ quantity: 2, quantitySource: 'ocr_explicit' });

    const [incoming] = (await application.submitRecognitionBatch([secondPath])).drafts;
    expect(incoming.items[0]).toMatchObject({ quantity: 4, quantitySource: 'ocr_explicit' });
    expect(incoming.items[1]).toMatchObject({ quantity: 1, quantitySource: 'system_default_1' });
    expect(() => application.confirmDraft(incoming)).toThrowError(/已转为订单更新/);
    const review = application.getDraftReview(incoming.id);
    expect(review.kind).toBe('order_update');
    expect(review.draft.items[0]).toMatchObject({
      quantity: 3,
      quantitySource: 'manual',
    });
    expect(review.draft.items[1]).toMatchObject({
      quantity: 2,
      quantitySource: 'ocr_explicit',
    });
    if (review.kind !== 'order_update') throw new Error('未转为订单更新');
    expect(review.sourceSnapshot.recognition.items[0]).toMatchObject({
      quantity: 4,
      quantitySource: 'ocr_explicit',
    });
    expect(review.sourceSnapshot.recognition.items[1]).toMatchObject({
      quantity: 1,
      quantitySource: 'system_default_1',
    });
  });

  it('把首次识别和定向复核作为两条不可变证据保存', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-review-evidence-'));
    const dataDirectory = join(testRoot, '数据');
    const sourcePath = join(testRoot, '合成复核订单.png');
    await writeFile(
      sourcePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const result = completeSyntheticRecognition('XY-SYNTH-EVIDENCE-0001');
    const recognizer: Recognizer = {
      recognize: async () => ({
        result,
        evidences: [
          {
            provider: 'controlled',
            model: 'controlled',
            requestId: 'synthetic-primary',
            schemaVersion: 1,
            rawResponse: '{"stage":"primary"}',
          },
          {
            provider: 'controlled',
            model: 'controlled',
            requestId: 'synthetic-review',
            schemaVersion: 1,
            rawResponse: '{"stage":"review"}',
          },
        ],
      }),
    };
    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(dataDirectory);

    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;

    const database = new DatabaseSync(
      join(dataDirectory, 'xianyu-order-manager.sqlite3'),
      { readOnly: true },
    );
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM recognition_attempts WHERE draft_id = ?')
        .get(draft.id),
    ).toEqual({ count: 2 });
    expect(
      database
        .prepare(`
          SELECT request_id
          FROM recognition_attempts
          WHERE draft_id = ?
          ORDER BY created_at, request_id
        `)
        .all(draft.id),
    ).toEqual([
      { request_id: 'synthetic-primary' },
      { request_id: 'synthetic-review' },
    ]);
    database.close();

    expect(application.getRecognitionEvidence(draft.screenshotId)).toMatchObject({
      requestId: 'synthetic-review',
      rawResponse: '{"stage":"review"}',
    });
  });

  it('保留字段缺失的识别结果供校对，但不允许直接确认入库', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-incomplete-draft-'));
    const sourcePath = join(testRoot, '待校对订单.png');
    await writeFile(
      sourcePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const recognizer = new ControlledRecognizer({
      platform: 'xianyu',
      sellerAccount: '默认闲鱼账号',
      orderNumber: '',
      alipayTransactionNumber: '',
      buyerNickname: '',
      recipient: '',
      phone: '',
      phoneNormalized: '',
      addressOriginal: '',
      addressNormalized: '',
      province: '',
      city: '',
      district: '',
      orderedAtOriginal: '',
      orderedAtNormalized: '',
      paidAtOriginal: '',
      paidAtNormalized: '',
      productTotalCents: null,
      shippingFeeCents: null,
      amountCents: null,
      platformTransactionStatus: 'unknown',
      fulfillmentStatus: 'pending_shipment',
      items: [],
    });
    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(join(testRoot, '数据'));

    const batch = await application.submitRecognitionBatch([sourcePath]);

    expect(batch.drafts[0]).toMatchObject({
      status: 'awaiting_review',
      orderNumber: '',
      recipient: '',
      items: [],
    });
    expect(() => application.confirmDraft(batch.drafts[0])).toThrowError(
      '订单草稿缺少必填信息',
    );
    const completedDraft = {
      ...batch.drafts[0],
      orderNumber: 'XY-SYNTH-INCOMPLETE-0001',
      recipient: '合成收件人',
      phone: '13900000001',
      phoneNormalized: '13900000001',
      addressOriginal: '测试省测试市示例区安全路1号',
      addressNormalized: '测试省测试市示例区安全路1号',
      productTotalCents: 0,
      shippingFeeCents: 0,
      items: [
        {
          id: 'manual-test-item',
          position: 0,
          sourceTitle: '合成测试商品',
          sourceSpec: '',
          unitPriceCents: 0,
          quantity: 1,
          quantityInferred: true,
        },
      ],
    };
    expect(() => application.confirmDraft(completedDraft)).toThrowError(
      '成交金额不能为空',
    );
    expect(application.confirmDraft({ ...completedDraft, amountCents: 0 }).amountCents).toBe(0);
  });

  it('拒绝原文与规范化交易时间不一致的订单草稿', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-time-consistency-'));
    const sourcePath = join(testRoot, '时间不一致订单.png');
    await writeFile(sourcePath, Buffer.from('synthetic-time-consistency'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeSyntheticRecognition('XY-SYNTH-TIME-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(testRoot, '数据'));
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;

    expect(() => application.confirmDraft({
      ...draft,
      orderedAtOriginal: '2026-07-30 08:09:10',
      orderedAtNormalized: '2026-07-29T10:00:00+08:00',
    })).toThrowError('规范化下单时间与原文不一致');
    expect(application.listOrders()).toEqual([]);
  });

  it('拒绝省市区与完整收货地址矛盾的订单草稿', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-address-parts-consistency-'));
    const sourcePath = join(testRoot, '地址层级不一致订单.png');
    await writeFile(sourcePath, Buffer.from('synthetic-address-parts-consistency'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeSyntheticRecognition('XY-SYNTH-ADDRESS-PARTS-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(testRoot, '数据'));
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;

    expect(() => application.confirmDraft({
      ...draft,
      addressOriginal: '浙江省杭州市西湖区安全路2号',
      addressNormalized: '浙江省杭州市西湖区安全路2号',
    })).toThrowError('省市区与完整收货地址不一致');
    expect(application.listOrders()).toEqual([]);
  });

  it('取消本次校对后保留截图与识别证据，且不能再确认为订单', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-cancel-review-'));
    const dataDirectory = join(testRoot, '数据');
    const sourcePath = join(testRoot, '待取消校对订单.png');
    const sourceBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(sourcePath, sourceBytes);

    const recognizer = new ControlledRecognizer({
      platform: 'xianyu',
      sellerAccount: '合成测试账号',
      orderNumber: 'XY-SYNTH-CANCEL-0001',
      alipayTransactionNumber: 'ALI-SYNTH-CANCEL-0001',
      buyerNickname: '测***户',
      recipient: '合成收件人',
      phone: '13900000001',
      phoneNormalized: '13900000001',
      addressOriginal: '测试省测试市示例区安全路1号',
      addressNormalized: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      orderedAtOriginal: '2026-07-29 10:00:00',
      orderedAtNormalized: '2026-07-29T10:00:00+08:00',
      paidAtOriginal: '2026-07-29 10:00:08',
      paidAtNormalized: '2026-07-29T10:00:08+08:00',
      productTotalCents: 1_200,
      shippingFeeCents: 0,
      amountCents: 1_200,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [
        {
          sourceTitle: '合成测试商品',
          sourceSpec: '标准款',
          unitPriceCents: 1_200,
          quantity: 1,
          quantityInferred: true,
        },
      ],
    });
    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(dataDirectory);

    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    application.cancelDraft(draft.id);

    expect(application.listOrders()).toEqual([]);
    expect(application.getDraft(draft.id).status).toBe('cancelled');
    expect(() => application.confirmDraft(draft)).toThrowError(/已取消/);
    expect(application.getRecognitionEvidence(draft.screenshotId)).toMatchObject({
      provider: 'controlled',
      model: 'controlled',
      schemaVersion: 1,
    });
    expect(
      Buffer.from((await application.readSourceScreenshot(draft.screenshotId)).bytes),
    ).toEqual(sourceBytes);

    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const database = new DatabaseSync(
      join(dataDirectory, 'xianyu-order-manager.sqlite3'),
      { readOnly: true },
    );
    expect(database.prepare('SELECT COUNT(*) AS count FROM original_orders').get()).toEqual({
      count: 0,
    });
    expect(
      database
        .prepare('SELECT review_cancelled_at FROM order_drafts WHERE id = ?')
        .get(draft.id),
    ).toMatchObject({ review_cancelled_at: expect.any(String) });
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM source_screenshots WHERE id = ?')
        .get(draft.screenshotId),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM recognition_attempts WHERE draft_id = ?')
        .get(draft.id),
    ).toEqual({ count: 1 });
    database.close();

    const reopened = new LocalApplication(recognizer);
    openedApplications.push(reopened);
    reopened.openDataDirectory(dataDirectory);

    expect(reopened.listOrders()).toEqual([]);
    expect(() => reopened.confirmDraft(draft)).toThrowError(/已取消/);
    expect(reopened.getRecognitionEvidence(draft.screenshotId).rawResponse).toContain(
      'XY-SYNTH-CANCEL-0001',
    );
    expect(
      Buffer.from((await reopened.readSourceScreenshot(draft.screenshotId)).bytes),
    ).toEqual(sourceBytes);
  });

  it('在读取和调用 OCR 前拒绝超过本机上限的截图', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-oversized-source-'));
    const sourcePath = join(testRoot, '过大截图.png');
    await writeFile(sourcePath, Buffer.alloc(7_500_001));
    let recognitionCalls = 0;
    const recognizer: Recognizer = {
      recognize: async () => {
        recognitionCalls += 1;
        throw new Error('不应调用识别器');
      },
    };
    const application = new LocalApplication(recognizer);
    openedApplications.push(application);
    application.openDataDirectory(join(testRoot, '数据'));

    await expect(application.submitRecognitionBatch([sourcePath])).rejects.toThrow(
      '来源截图不能超过 7.5 MB',
    );
    expect(recognitionCalls).toBe(0);
  });
});
