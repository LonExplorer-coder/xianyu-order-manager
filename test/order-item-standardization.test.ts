import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import {
  createOrderTableProjectionPlan,
  projectOrderTableCell,
  projectOrderTableProjectionRow,
} from '../src/core/table-templates';
import { LocalApplication } from '../src/main/local-application';
import { removeVersion45ExtensionArtifacts } from './version31-fixture';

const openedApplications: LocalApplication[] = [];

function recognition(orderNumber: string): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '单笔关联测试账号',
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
    orderedAtOriginal: '2026-08-16 09:00:00',
    orderedAtNormalized: '2026-08-16T09:00:00+08:00',
    paidAtOriginal: '2026-08-16 09:00:08',
    paidAtNormalized: '2026-08-16T09:00:08+08:00',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: false,
    }],
  };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

async function openSeededApplication(orderNumber: string) {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-item-standardization-'));
  const dataDirectory = join(root, '数据');
  const sourcePath = join(root, '订单截图.png');
  await writeFile(sourcePath, Buffer.from(`item-standardization-${orderNumber}`));
  const application = new LocalApplication(new ControlledRecognizer(recognition(orderNumber)));
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);
  const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
  const order = application.confirmDraft(draft);
  return { application, dataDirectory, order };
}

describe('订单商品单笔关联标准商品', () => {
  it('人工关联标准商品，默认优先展示标准商品信息并写入修改记录', async () => {
    const { application, order } = await openSeededApplication('XY-ITEM-LINK-0001');
    const product = application.createStandardProduct({
      sku: 'SKU-LINK-001',
      name: '十二分娃鞋',
      specification: '白色小号',
    });
    const item = order.items[0];

    const updated = application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: product.id,
      expectedRevision: order.revision,
    });

    expect(updated.order).toMatchObject({
      id: order.id,
      revision: order.revision + 1,
      items: [expect.objectContaining({
        id: item.id,
        sourceTitle: '十二分娃鞋白胚',
        sourceSpec: '小号',
        standardProduct: expect.objectContaining({ id: product.id, sku: 'SKU-LINK-001' }),
        standardizationSource: 'manual',
        standardDisplayPreference: 'prefer_standard',
      })],
    });
    expect(application.getOrder(order.id).changeEvents.at(0)).toMatchObject({
      source: 'manual_edit',
      baseRevision: order.revision,
      resultRevision: order.revision + 1,
      changes: [
        {
          path: 'items[0].standardDisplayPreference',
          before: null,
          after: 'prefer_standard',
        },
        { path: 'items[0].standardProductSku', before: null, after: 'SKU-LINK-001' },
        { path: 'items[0].standardizationSource', before: null, after: 'manual' },
      ],
    });
  });

  it('改关联更换标准商品，来源保持人工且偏好仍可单独修改', async () => {
    const { application, order } = await openSeededApplication('XY-ITEM-RELINK-0001');
    const first = application.createStandardProduct({
      sku: 'SKU-RELINK-A',
      name: '十二分娃鞋',
      specification: '白色小号',
    });
    const second = application.createStandardProduct({
      sku: 'SKU-RELINK-B',
      name: '十二分娃鞋',
      specification: '黑色小号',
    });
    const item = order.items[0];
    const linked = application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: first.id,
      expectedRevision: order.revision,
    });

    const relinked = application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: second.id,
      expectedRevision: linked.order.revision,
    });

    expect(relinked.order.items[0]).toMatchObject({
      standardProduct: expect.objectContaining({ id: second.id }),
      standardizationSource: 'manual',
      standardDisplayPreference: 'prefer_standard',
    });
    expect(application.getOrder(order.id).changeEvents.at(0)?.changes).toEqual([
      { path: 'items[0].standardProductSku', before: 'SKU-RELINK-A', after: 'SKU-RELINK-B' },
    ]);

    const preferenceOnly = application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: second.id,
      standardDisplayPreference: 'prefer_source',
      expectedRevision: relinked.order.revision,
    });
    expect(preferenceOnly.order.items[0]).toMatchObject({
      standardProduct: expect.objectContaining({ id: second.id }),
      standardizationSource: 'manual',
      standardDisplayPreference: 'prefer_source',
    });
    expect(application.getOrder(order.id).changeEvents.at(0)?.changes).toEqual([
      {
        path: 'items[0].standardDisplayPreference',
        before: 'prefer_standard',
        after: 'prefer_source',
      },
    ]);
  });

  it('解除关联时清空关联与偏好，且不允许携带显示偏好', async () => {
    const { application, order } = await openSeededApplication('XY-ITEM-UNLINK-0001');
    const product = application.createStandardProduct({
      sku: 'SKU-UNLINK-001',
      name: '十二分娃鞋',
      specification: '白色小号',
    });
    const item = order.items[0];
    const linked = application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: product.id,
      expectedRevision: order.revision,
    });

    expect(() => application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: null,
      standardDisplayPreference: 'prefer_standard',
      expectedRevision: linked.order.revision,
    })).toThrowError('解除商品标准化关联时不能设置标准商品显示偏好');

    const unlinked = application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: null,
      expectedRevision: linked.order.revision,
    });
    expect(unlinked.order.items[0]).toMatchObject({
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      standardProduct: null,
      standardizationSource: null,
      standardDisplayPreference: null,
    });
    expect(application.getOrder(order.id).changeEvents.at(0)?.changes).toEqual([
      {
        path: 'items[0].standardDisplayPreference',
        before: 'prefer_standard',
        after: null,
      },
      { path: 'items[0].standardProductSku', before: 'SKU-UNLINK-001', after: null },
      { path: 'items[0].standardizationSource', before: 'manual', after: null },
    ]);
  });

  it('拒绝过期版本、不存在的标准商品与不属该订单的商品明细', async () => {
    const { application, order } = await openSeededApplication('XY-ITEM-GUARD-0001');
    const other = await openSeededApplication('XY-ITEM-GUARD-0002');
    const product = application.createStandardProduct({
      sku: 'SKU-GUARD-001',
      name: '十二分娃鞋',
      specification: '白色小号',
    });
    const item = order.items[0];

    expect(() => application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: product.id,
      expectedRevision: order.revision + 1,
    })).toThrowError('订单已在其他操作中更新，请刷新后重试');
    expect(() => application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: 'missing-product-id',
      expectedRevision: order.revision,
    })).toThrowError('未找到标准商品');
    expect(() => application.updateOrderItemStandardization(order.id, other.order.items[0].id, {
      standardProductId: product.id,
      expectedRevision: order.revision,
    })).toThrowError('订单商品不属于该订单');
    expect(() => application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: product.id,
      expectedRevision: order.revision,
      unexpected: true,
    })).toThrowError('商品标准化修改包含未知字段');

    expect(application.getOrder(order.id)).toMatchObject({
      order: { revision: order.revision },
      changeEvents: [],
    });
  });

  it('订单更新校对改关联时偏好变化一并写入修改记录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-item-review-relink-'));
    const dataDirectory = join(root, '数据');
    const firstPath = join(root, '首次.png');
    const updatePath = join(root, '再次.png');
    await writeFile(firstPath, Buffer.from('review-relink-first'));
    await writeFile(updatePath, Buffer.from('review-relink-second'));
    const application = new LocalApplication(
      new ControlledRecognizer(recognition('XY-REVIEW-RELINK-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(dataDirectory);
    const first = application.createStandardProduct({
      sku: 'SKU-REVIEW-A',
      name: '十二分娃鞋',
      specification: '白色小号',
    });
    const second = application.createStandardProduct({
      sku: 'SKU-REVIEW-B',
      name: '十二分娃鞋',
      specification: '黑色小号',
    });
    const [firstDraft] = (await application.submitRecognitionBatch([firstPath])).drafts;
    const order = application.confirmDraft(firstDraft);
    const linked = application.updateOrderItemStandardization(order.id, order.items[0].id, {
      standardProductId: first.id,
      standardDisplayPreference: 'prefer_source',
      expectedRevision: order.revision,
    });

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
        standardProductId: second.id,
        createMapping: false,
      }],
    );

    expect(updated.order.revision).toBe(linked.order.revision + 1);
    expect(updated.order.items[0]).toMatchObject({
      standardProduct: expect.objectContaining({ id: second.id }),
      standardizationSource: 'manual',
      standardDisplayPreference: 'prefer_standard',
    });
    expect(application.getOrder(order.id).changeEvents.at(0)?.changes).toEqual(
      expect.arrayContaining([
        { path: 'items[0].standardProductSku', before: 'SKU-REVIEW-A', after: 'SKU-REVIEW-B' },
        {
          path: 'items[0].standardDisplayPreference',
          before: 'prefer_source',
          after: 'prefer_standard',
        },
      ]),
    );
  });

  it('关联与偏好均无变化时不产生修改记录', async () => {
    const { application, order } = await openSeededApplication('XY-ITEM-NOOP-0001');
    const product = application.createStandardProduct({
      sku: 'SKU-NOOP-001',
      name: '十二分娃鞋',
      specification: '白色小号',
    });
    const item = order.items[0];
    const linked = application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: product.id,
      expectedRevision: order.revision,
    });
    const eventCount = application.getOrder(order.id).changeEvents.length;

    const unchanged = application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: product.id,
      expectedRevision: linked.order.revision,
    });
    expect(unchanged.order.revision).toBe(linked.order.revision);
    expect(application.getOrder(order.id).changeEvents).toHaveLength(eventCount);
  });
});

describe('标准商品显示偏好在订单投影生效', () => {
  it('订单总表商品摘要与动态商品列组跟随每条明细的显示偏好', async () => {
    const { application, order } = await openSeededApplication('XY-ITEM-DISPLAY-0001');
    const product = application.createStandardProduct({
      sku: 'SKU-DISPLAY-001',
      name: '十二分娃鞋',
      specification: '白色小号',
    });
    const item = order.items[0];
    const linked = application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: product.id,
      expectedRevision: order.revision,
    });

    const preferStandardSummary = application.queryOrders({ buyerText: '测' }).orders
      .find(({ id }) => id === order.id);
    expect(preferStandardSummary?.items[0]).toMatchObject({
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      standardDisplayPreference: 'prefer_standard',
      standardProduct: expect.objectContaining({ sku: 'SKU-DISPLAY-001' }),
    });
    expect(projectOrderTableCell(
      preferStandardSummary!,
      { kind: 'builtin', key: 'product_summary' },
    )).toBe('十二分娃鞋 · 白色小号 ×1');

    application.updateOrderItemStandardization(order.id, item.id, {
      standardProductId: product.id,
      standardDisplayPreference: 'prefer_source',
      expectedRevision: linked.order.revision,
    });
    const preferSourceSummary = application.queryOrders({ buyerText: '测' }).orders
      .find(({ id }) => id === order.id);
    expect(preferSourceSummary?.items[0]).toMatchObject({
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      standardDisplayPreference: 'prefer_source',
      standardProduct: expect.objectContaining({ sku: 'SKU-DISPLAY-001' }),
    });
    expect(projectOrderTableCell(
      preferSourceSummary!,
      { kind: 'builtin', key: 'product_summary' },
    )).toBe('十二分娃鞋白胚 · 小号 ×1');

    const plan = createOrderTableProjectionPlan([
      { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
      {
        kind: 'dynamic_product_group',
        labels: { product: '商品', specification: '款式', quantity: '数量' },
      },
    ], [preferSourceSummary!]);
    expect(projectOrderTableProjectionRow(plan, preferSourceSummary!)).toEqual([
      'XY-ITEM-DISPLAY-0001',
      '十二分娃鞋白胚',
      '小号',
      1,
    ]);
  });
});

describe('标准商品显示偏好迁移', () => {
  it('从 v43 升级后已关联明细回填优先展示标准商品信息并受一致性约束', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-item-preference-migration-'));
    const dataDirectory = join(root, '数据');
    const linkedSource = join(root, '已关联订单.png');
    const unlinkedSource = join(root, '未关联订单.png');
    await writeFile(linkedSource, Buffer.from('preference-migration-linked'));
    await writeFile(unlinkedSource, Buffer.from('preference-migration-unlinked'));
    const application = new LocalApplication(
      new ControlledRecognizer(recognition('XY-PREFERENCE-LEGACY')),
    );
    openedApplications.push(application);
    application.openDataDirectory(dataDirectory);
    const product = application.createStandardProduct({
      sku: 'SKU-PREFERENCE-LEGACY',
      name: '十二分娃鞋',
      specification: '白色小号',
    });
    const [linkedDraft] = (await application.submitRecognitionBatch([linkedSource])).drafts;
    const linkedOrder = application.confirmDraft(linkedDraft, undefined, {}, [{
      draftItemId: linkedDraft.items[0].id,
      standardProductId: product.id,
      createMapping: false,
    }]);
    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);

    const unlinkedSeeder = new LocalApplication(
      new ControlledRecognizer(recognition('XY-PREFERENCE-PLAIN')),
    );
    openedApplications.push(unlinkedSeeder);
    unlinkedSeeder.openDataDirectory(dataDirectory);
    const [unlinkedDraft] = (await unlinkedSeeder.submitRecognitionBatch([unlinkedSource])).drafts;
    const unlinkedOrder = unlinkedSeeder.confirmDraft(unlinkedDraft);
    unlinkedSeeder.close();
    openedApplications.splice(openedApplications.indexOf(unlinkedSeeder), 1);

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    try {
      removeVersion45ExtensionArtifacts(legacy);
      legacy.exec(`
        DELETE FROM schema_migrations WHERE version = 44;
        DROP TRIGGER order_items_standard_display_preference_is_consistent_on_insert;
        DROP TRIGGER order_items_standard_display_preference_is_consistent_on_update;
        ALTER TABLE order_items DROP COLUMN standard_display_preference;
      `);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 43 });
    } finally {
      legacy.close();
    }

    const migrated = new LocalApplication(new ControlledRecognizer(recognition('unused')));
    openedApplications.push(migrated);
    migrated.openDataDirectory(dataDirectory);
    expect(migrated.getOrder(linkedOrder.id).order.items[0]).toMatchObject({
      standardProduct: expect.objectContaining({ id: product.id }),
      standardizationSource: 'manual',
      standardDisplayPreference: 'prefer_standard',
    });
    expect(migrated.getOrder(unlinkedOrder.id).order.items[0]).toMatchObject({
      standardProduct: null,
      standardizationSource: null,
      standardDisplayPreference: null,
    });
    migrated.close();
    openedApplications.splice(openedApplications.indexOf(migrated), 1);

    const verified = new DatabaseSync(databasePath);
    try {
      expect(verified.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 51 });
      expect(() => verified.prepare(`
        UPDATE order_items SET standard_display_preference = NULL WHERE id = ?
      `).run(linkedOrder.items[0].id)).toThrow(/inconsistent/u);
      expect(() => verified.prepare(`
        INSERT INTO order_items (
          id, order_id, position, source_title, source_spec,
          unit_price_cents, quantity, quantity_source, subtotal_cents,
          standard_product_id, standardization_source
        ) VALUES ('item-preference-inconsistent', ?, 9, '标题', '', 100, 1,
          'ocr_explicit', 100, ?, 'manual')
      `).run(unlinkedOrder.id, product.id)).toThrow(/inconsistent/u);
    } finally {
      verified.close();
    }
  });
});
