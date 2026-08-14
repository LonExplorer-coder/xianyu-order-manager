import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';

const openedApplications: LocalApplication[] = [];

function recognition(orderNumber: string): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '商品标准化测试账号',
    orderNumber,
    alipayTransactionNumber: `ALI-${orderNumber}`,
    buyerNickname: '测***户',
    recipient: '测试收件人',
    phone: '13900000001',
    phoneNormalized: '13900000001',
    addressOriginal: '广东省深圳市南山区安全路1号',
    addressNormalized: '广东省深圳市南山区安全路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-14 09:00:00',
    orderedAtNormalized: '2026-08-14T09:00:00+08:00',
    paidAtOriginal: '2026-08-14 09:00:08',
    paidAtNormalized: '2026-08-14T09:00:08+08:00',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '古风娃鞋白模',
      sourceSpec: '05M',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: false,
    }],
  };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('标准商品与商品映射', () => {
  it('完全一致的标题和规格自动关联标准商品并保留订单原文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-product-standardization-'));
    const dataDirectory = join(root, '数据');
    const sourcePath = join(root, '订单截图.png');
    await writeFile(sourcePath, Buffer.from('synthetic-product-standardization'));

    const application = new LocalApplication(new ControlledRecognizer(recognition('XY-PRODUCT-0001')));
    openedApplications.push(application);
    application.openDataDirectory(dataDirectory);

    const product = application.createStandardProduct({
      sku: 'SKU-SHOE-05M',
      name: '古风娃鞋白模',
      specification: '05M',
    });
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const confirmed = application.confirmDraft(draft);

    expect(confirmed.items[0]).toMatchObject({
      sourceTitle: '古风娃鞋白模',
      sourceSpec: '05M',
      standardProduct: {
        id: product.id,
        sku: 'SKU-SHOE-05M',
        name: '古风娃鞋白模',
        specification: '05M',
      },
    });
    expect(application.listOrders()[0].items[0]).toMatchObject({
      sourceTitle: '古风娃鞋白模',
      standardProduct: { id: product.id, sku: 'SKU-SHOE-05M' },
    });
    expect(application.queryOrderItems({}).items[0]).toMatchObject({
      sourceTitle: '古风娃鞋白模',
      standardProduct: { id: product.id, sku: 'SKU-SHOE-05M' },
    });
    expect(application.queryOrders({ productText: 'SKU-SHOE-05M' }).orders)
      .toHaveLength(1);
    expect(application.queryOrders({ text: 'SKU-SHOE-05M' }).orders)
      .toHaveLength(1);

    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);
    const reopened = new LocalApplication(new ControlledRecognizer(recognition('unused')));
    openedApplications.push(reopened);
    reopened.openDataDirectory(dataDirectory);

    expect(reopened.listStandardProducts()).toEqual([
      expect.objectContaining({
        id: product.id,
        sku: 'SKU-SHOE-05M',
        name: '古风娃鞋白模',
        specification: '05M',
      }),
    ]);
    expect(reopened.getOrder(confirmed.id).order.items[0]).toMatchObject({
      sourceTitle: '古风娃鞋白模',
      sourceSpec: '05M',
      standardProduct: { id: product.id, sku: 'SKU-SHOE-05M' },
    });
  });

  it('模糊标题只给候选，人工确认映射后才自动用于后续订单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-product-mapping-'));
    const dataDirectory = join(root, '数据');
    const productRecognition = (orderNumber: string): RecognitionResult => ({
      ...recognition(orderNumber),
      items: [{
        ...recognition(orderNumber).items[0],
        sourceTitle: '古风娃鞋白模-闲鱼专拍',
        sourceSpec: '05M',
      }],
    });

    const firstSource = join(root, '订单1.png');
    await writeFile(firstSource, Buffer.from('fuzzy-candidate-first'));
    const first = new LocalApplication(new ControlledRecognizer(productRecognition('XY-MAPPING-0001')));
    openedApplications.push(first);
    first.openDataDirectory(dataDirectory);
    const product = first.createStandardProduct({
      sku: 'SKU-SHOE-MAPPED',
      name: '古风娃鞋白模',
      specification: '05M',
    });
    const [firstDraft] = (await first.submitRecognitionBatch([firstSource])).drafts;
    expect(first.previewDraftProductStandardizations(firstDraft)).toEqual([
      expect.objectContaining({
        automaticProduct: null,
        candidates: [expect.objectContaining({
          product: expect.objectContaining({ id: product.id }),
          reason: 'fuzzy',
          mappingSuggested: false,
        })],
      }),
    ]);
    const firstOrder = first.confirmDraft(firstDraft);
    expect(firstOrder.items[0].standardProduct).toBeNull();
    first.close();
    openedApplications.splice(openedApplications.indexOf(first), 1);

    const secondSource = join(root, '订单2.png');
    await writeFile(secondSource, Buffer.from('fuzzy-candidate-second'));
    const second = new LocalApplication(new ControlledRecognizer(productRecognition('XY-MAPPING-0002')));
    openedApplications.push(second);
    second.openDataDirectory(dataDirectory);
    const [secondDraft] = (await second.submitRecognitionBatch([secondSource])).drafts;
    const secondOrder = second.confirmDraft(secondDraft, undefined, {}, [{
      draftItemId: secondDraft.items[0].id,
      standardProductId: product.id,
      createMapping: true,
    }]);
    expect(secondOrder.items[0]).toMatchObject({
      standardProduct: { id: product.id },
      standardizationSource: 'manual',
    });
    second.close();
    openedApplications.splice(openedApplications.indexOf(second), 1);

    const thirdSource = join(root, '订单3.png');
    await writeFile(thirdSource, Buffer.from('mapped-third'));
    const third = new LocalApplication(new ControlledRecognizer(productRecognition('XY-MAPPING-0003')));
    openedApplications.push(third);
    third.openDataDirectory(dataDirectory);
    const [thirdDraft] = (await third.submitRecognitionBatch([thirdSource])).drafts;
    expect(third.previewDraftProductStandardizations(thirdDraft)[0]).toMatchObject({
      automaticProduct: { id: product.id },
      automaticSource: 'mapping',
      candidates: [],
    });
    expect(third.confirmDraft(thirdDraft).items[0]).toMatchObject({
      standardProduct: { id: product.id },
      standardizationSource: 'mapping',
      sourceTitle: '古风娃鞋白模-闲鱼专拍',
    });
    expect(third.getOrder(firstOrder.id).order.items[0].standardProduct).toBeNull();
  });

  it('重复人工关联同一原文时只提示建立映射，不自动修改或归并', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-product-repeat-hint-'));
    const dataDirectory = join(root, '数据');
    const aliasedRecognition = (orderNumber: string): RecognitionResult => ({
      ...recognition(orderNumber),
      items: [{
        ...recognition(orderNumber).items[0],
        sourceTitle: '十二分娃鞋白胚',
        sourceSpec: '小号',
      }],
    });
    const firstSource = join(root, '第一次.png');
    await writeFile(firstSource, Buffer.from('manual-standardization-first'));
    const first = new LocalApplication(new ControlledRecognizer(aliasedRecognition('XY-HINT-0001')));
    openedApplications.push(first);
    first.openDataDirectory(dataDirectory);
    const product = first.createStandardProduct({
      sku: 'SKU-SHOE-HINT',
      name: '十二分娃鞋',
      specification: '白色小号',
    });
    const [firstDraft] = (await first.submitRecognitionBatch([firstSource])).drafts;
    first.confirmDraft(firstDraft, undefined, {}, [{
      draftItemId: firstDraft.items[0].id,
      standardProductId: product.id,
      createMapping: false,
    }]);
    first.close();
    openedApplications.splice(openedApplications.indexOf(first), 1);

    const secondSource = join(root, '第二次.png');
    await writeFile(secondSource, Buffer.from('manual-standardization-second'));
    const second = new LocalApplication(new ControlledRecognizer(aliasedRecognition('XY-HINT-0002')));
    openedApplications.push(second);
    second.openDataDirectory(dataDirectory);
    const [secondDraft] = (await second.submitRecognitionBatch([secondSource])).drafts;
    const review = second.previewDraftProductStandardizations(secondDraft)[0];
    expect(review.automaticProduct).toBeNull();
    expect(review.candidates).toContainEqual(expect.objectContaining({
      product: expect.objectContaining({ id: product.id }),
      reason: 'previous_manual_choice',
      mappingSuggested: true,
    }));
    const unconfirmedOrder = second.confirmDraft(secondDraft);
    expect(unconfirmedOrder.items[0].standardProduct).toBeNull();
    expect(second.getOrder(unconfirmedOrder.id).sourceSnapshot.recognition.items[0]).toMatchObject({
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
    });
  });

  it('维护标准商品使用唯一 SKU 和版本检查，订单原文与关联身份各自保持清晰', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-product-maintenance-'));
    const sourcePath = join(root, '订单.png');
    await writeFile(sourcePath, Buffer.from('product-maintenance-order'));
    const application = new LocalApplication(new ControlledRecognizer(recognition('XY-PRODUCT-MAINTAIN')));
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const product = application.createStandardProduct({
      sku: 'shoe-05m',
      name: '古风娃鞋白模',
      specification: '05M',
    });
    expect(() => application.createStandardProduct({
      sku: 'ＳＨＯＥ－０５Ｍ',
      name: '重复商品',
      specification: '重复规格',
    })).toThrowError('SKU 已存在');
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);

    const updated = application.updateStandardProduct(product.id, {
      sku: 'SHOE-05M',
      name: '古风娃鞋',
      specification: '05M 白模',
      expectedRevision: product.revision,
    });
    expect(updated).toMatchObject({
      id: product.id,
      sku: 'SHOE-05M',
      name: '古风娃鞋',
      specification: '05M 白模',
      revision: 2,
    });
    expect(() => application.updateStandardProduct(product.id, {
      sku: 'SHOE-05M',
      name: '过期修改',
      specification: '05M',
      expectedRevision: 1,
    })).toThrowError('标准商品已在其他操作中更新');
    expect(application.getOrder(order.id).order.items[0]).toMatchObject({
      sourceTitle: '古风娃鞋白模',
      sourceSpec: '05M',
      standardProduct: {
        id: product.id,
        sku: 'SHOE-05M',
        name: '古风娃鞋',
        specification: '05M 白模',
      },
    });
  });

  it('已有订单再次校对时只按本次人工确认更新标准商品关联', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-product-update-review-'));
    const dataDirectory = join(root, '数据');
    const firstPath = join(root, '首次.png');
    const updatePath = join(root, '再次.png');
    await writeFile(firstPath, Buffer.from('product-update-first'));
    await writeFile(updatePath, Buffer.from('product-update-second'));
    const application = new LocalApplication(new ControlledRecognizer(recognition('XY-PRODUCT-UPDATE')));
    openedApplications.push(application);
    application.openDataDirectory(dataDirectory);
    const product = application.createStandardProduct({
      sku: 'SKU-UPDATE-05M',
      name: '古风娃鞋',
      specification: '05M 白模',
    });
    const [firstDraft] = (await application.submitRecognitionBatch([firstPath])).drafts;
    const original = application.confirmDraft(firstDraft);
    expect(original.items[0].standardProduct).toBeNull();

    const [updateDraft] = (await application.submitRecognitionBatch([updatePath])).drafts;
    expect(() => application.confirmDraft(updateDraft)).toThrowError(/已转为订单更新/);
    const review = application.getDraftReview(updateDraft.id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');
    const updated = application.confirmOrderUpdate(
      review.draft,
      review.expectedRevision,
      undefined,
      [{
        draftItemId: review.draft.items[0].id,
        standardProductId: product.id,
        createMapping: true,
      }],
    );

    expect(updated).toMatchObject({
      resolution: 'order_updated',
      order: {
        id: original.id,
        revision: original.revision + 1,
        items: [expect.objectContaining({
          sourceTitle: '古风娃鞋白模',
          sourceSpec: '05M',
          standardProduct: expect.objectContaining({ id: product.id }),
          standardizationSource: 'manual',
        })],
      },
    });
    expect(updated.order.items[0].id).toBe(original.items[0].id);
    expect(application.getOrder(original.id).changeEvents.at(-1)?.changes).toEqual(
      expect.arrayContaining([
        {
          path: 'items[0].standardProductSku',
          before: null,
          after: product.sku,
        },
        {
          path: 'items[0].standardizationSource',
          before: null,
          after: 'manual',
        },
      ]),
    );
  });
});
