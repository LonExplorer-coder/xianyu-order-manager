import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
  it('打开 v15 数据库时扩展履约状态约束并完整保留既有订单物流', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-logistics-migration-'));
    const dataDirectory = join(root, '数据');
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    await mkdir(dataDirectory);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('PRAGMA foreign_keys = OFF;');
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations (version, applied_at) VALUES (15, '2026-08-03T00:00:00.000Z');
      CREATE TABLE recognition_batches (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE source_screenshots (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE order_drafts (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES recognition_batches(id) ON DELETE RESTRICT,
        screenshot_id TEXT NOT NULL UNIQUE REFERENCES source_screenshots(id) ON DELETE RESTRICT,
        platform TEXT NOT NULL,
        seller_account TEXT NOT NULL,
        order_number TEXT NOT NULL,
        buyer_nickname TEXT NOT NULL,
        recipient TEXT NOT NULL,
        phone TEXT NOT NULL,
        address_original TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        status TEXT NOT NULL CHECK (status IN ('awaiting_review', 'confirmed')),
        recognition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        alipay_transaction_number TEXT NOT NULL DEFAULT '',
        phone_normalized TEXT NOT NULL DEFAULT '',
        address_normalized TEXT NOT NULL DEFAULT '',
        province TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        district TEXT NOT NULL DEFAULT '',
        ordered_at_original TEXT NOT NULL DEFAULT '',
        ordered_at_normalized TEXT NOT NULL DEFAULT '',
        paid_at_original TEXT NOT NULL DEFAULT '',
        paid_at_normalized TEXT NOT NULL DEFAULT '',
        product_total_cents INTEGER NOT NULL DEFAULT 0 CHECK (product_total_cents >= 0),
        product_total_present INTEGER NOT NULL DEFAULT 0
          CHECK (product_total_present IN (0, 1)),
        shipping_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (shipping_fee_cents >= 0),
        shipping_fee_present INTEGER NOT NULL DEFAULT 0
          CHECK (shipping_fee_present IN (0, 1)),
        amount_present INTEGER NOT NULL DEFAULT 1 CHECK (amount_present IN (0, 1)),
        platform_transaction_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (platform_transaction_status IN ('paid', 'cancelled', 'refunded', 'unknown')),
        fulfillment_status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (fulfillment_status IN ('pending_shipment', 'shipped', 'unknown')),
        review_cancelled_at TEXT,
        review_issues_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(review_issues_json) AND json_type(review_issues_json) = 'array'),
        intake_decision_pending INTEGER NOT NULL DEFAULT 0
          CHECK (intake_decision_pending IN (0, 1)),
        matched_order_id TEXT REFERENCES original_orders(id) ON DELETE RESTRICT,
        recognition_conflicts_json TEXT NOT NULL DEFAULT '[]'
          CHECK (
            json_valid(recognition_conflicts_json)
            AND json_type(recognition_conflicts_json) = 'array'
          )
      ) STRICT;
      INSERT INTO recognition_batches (id) VALUES ('legacy-batch');
      INSERT INTO source_screenshots (id) VALUES ('legacy-screenshot');
      INSERT INTO order_drafts (
        id, batch_id, screenshot_id, platform, seller_account, order_number,
        buyer_nickname, recipient, phone, address_original, amount_cents,
        status, recognition_json, created_at, confirmed_at,
        fulfillment_status
      ) VALUES (
        'legacy-draft', 'legacy-batch', 'legacy-screenshot',
        'xianyu', '旧账号', 'XY-LEGACY', '旧买家', '旧收件人',
        '13900000001', '广东省深圳市南山区旧址1号', 800,
        'confirmed', '{}', '2026-08-03T00:00:00.000Z',
        '2026-08-03T00:00:00.000Z', 'shipped'
      );
      CREATE TABLE original_orders (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE REFERENCES order_drafts(id) ON DELETE RESTRICT,
        screenshot_id TEXT NOT NULL REFERENCES source_screenshots(id) ON DELETE RESTRICT,
        platform TEXT NOT NULL,
        seller_account TEXT NOT NULL,
        platform_order_number TEXT NOT NULL,
        alipay_transaction_number TEXT NOT NULL,
        buyer_nickname TEXT NOT NULL,
        recipient TEXT NOT NULL,
        phone TEXT NOT NULL,
        phone_normalized TEXT NOT NULL,
        address_original TEXT NOT NULL,
        address_normalized TEXT NOT NULL,
        province TEXT NOT NULL,
        city TEXT NOT NULL,
        district TEXT NOT NULL,
        ordered_at_original TEXT NOT NULL,
        ordered_at_normalized TEXT NOT NULL,
        paid_at_original TEXT NOT NULL,
        paid_at_normalized TEXT NOT NULL,
        product_total_cents INTEGER CHECK (product_total_cents >= 0),
        shipping_fee_cents INTEGER CHECK (shipping_fee_cents >= 0),
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        platform_transaction_status TEXT NOT NULL
          CHECK (platform_transaction_status IN ('paid', 'cancelled', 'refunded', 'unknown')),
        fulfillment_status TEXT NOT NULL
          CHECK (fulfillment_status IN ('pending_shipment', 'shipped', 'unknown')),
        lifecycle_status TEXT NOT NULL
          CHECK (lifecycle_status IN ('active', 'trashed', 'deleted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        seller_account_normalized TEXT NOT NULL DEFAULT '',
        platform_order_number_normalized TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        shipping_carrier TEXT NOT NULL DEFAULT '',
        tracking_number TEXT NOT NULL DEFAULT '',
        UNIQUE (platform, seller_account, platform_order_number)
      ) STRICT;
      CREATE UNIQUE INDEX original_orders_by_normalized_identity
      ON original_orders (
        platform,
        seller_account_normalized,
        platform_order_number_normalized
      );
      INSERT INTO original_orders (
        id, draft_id, screenshot_id, platform, seller_account, platform_order_number,
        alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
        address_original, address_normalized, province, city, district,
        ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
        amount_cents, platform_transaction_status, fulfillment_status,
        lifecycle_status, created_at, updated_at,
        seller_account_normalized, platform_order_number_normalized,
        shipping_carrier, tracking_number
      ) VALUES (
        'legacy-order', 'legacy-draft', 'legacy-screenshot', 'xianyu', '旧账号', 'XY-LEGACY',
        '', '旧买家', '旧收件人', '13900000001', '13900000001',
        '广东省深圳市南山区旧址1号', '广东省深圳市南山区旧址1号',
        '广东省', '深圳市', '南山区',
        '2026-08-03 08:00:00', '2026-08-03T08:00:00+08:00',
        '2026-08-03 08:00:08', '2026-08-03T08:00:08+08:00',
        800, 'paid', 'shipped', 'active',
        '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z',
        '旧账号', 'XY-LEGACY', '顺丰速运', 'SF-LEGACY-001'
      );

      CREATE TABLE order_items (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES original_orders(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        source_title TEXT NOT NULL,
        source_spec TEXT NOT NULL,
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        quantity_source TEXT NOT NULL,
        subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
        UNIQUE (order_id, position)
      ) STRICT;
      INSERT INTO order_items (
        id, order_id, position, source_title, source_spec,
        unit_price_cents, quantity, quantity_source, subtotal_cents
      ) VALUES (
        'legacy-order-item', 'legacy-order', 0, '旧商品', '旧规格',
        800, 1, 'legacy_explicit_or_manual', 800
      );
    `);
    legacy.close();
    const corruptedDataDirectory = join(root, '损坏数据');
    const corruptedDatabasePath = join(corruptedDataDirectory, 'xianyu-order-manager.sqlite3');
    await mkdir(corruptedDataDirectory);
    await copyFile(databasePath, corruptedDatabasePath);

    const workspace = Workspace.open(dataDirectory);
    try {
      expect(workspace.database.prepare(`
        SELECT fulfillment_status, shipping_carrier, tracking_number, revision
        FROM original_orders
        WHERE id = 'legacy-order'
      `).get()).toEqual({
        fulfillment_status: 'shipped',
        shipping_carrier: '顺丰速运',
        tracking_number: 'SF-LEGACY-001',
        revision: 1,
      });
      const originalOrderColumns = workspace.database.prepare(
        'PRAGMA table_info(original_orders)',
      ).all() as unknown as Array<{ name: string; dflt_value: string | null }>;
      const columnsWithoutLegacyDefaults = new Set([
        'alipay_transaction_number',
        'phone_normalized',
        'address_normalized',
        'province',
        'city',
        'district',
        'ordered_at_original',
        'ordered_at_normalized',
        'paid_at_original',
        'paid_at_normalized',
      ]);
      expect(originalOrderColumns
        .filter(({ name }) => columnsWithoutLegacyDefaults.has(name))
        .map(({ name, dflt_value: defaultValue }) => ({ name, defaultValue })))
        .toEqual([...columnsWithoutLegacyDefaults].map((name) => ({
          name,
          defaultValue: null,
        })));
      workspace.database.prepare(`
        UPDATE original_orders SET fulfillment_status = 'delivered'
        WHERE id = 'legacy-order'
      `).run();
      workspace.database.prepare(`
        UPDATE original_orders SET fulfillment_status = 'returned'
        WHERE id = 'legacy-order'
      `).run();
      expect(workspace.database.prepare(`
        SELECT fulfillment_status FROM order_drafts WHERE id = 'legacy-draft'
      `).get()).toEqual({ fulfillment_status: 'shipped' });
      workspace.database.prepare(`
        UPDATE order_drafts SET fulfillment_status = 'delivered'
        WHERE id = 'legacy-draft'
      `).run();
      workspace.database.prepare(`
        UPDATE order_drafts SET fulfillment_status = 'returned'
        WHERE id = 'legacy-draft'
      `).run();
      expect(workspace.database.prepare(`
        SELECT MAX(version) AS version FROM schema_migrations
      `).get()).toEqual({ version: 22 });
      expect(workspace.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      workspace.close();
    }

    const corrupted = new DatabaseSync(corruptedDatabasePath);
    corrupted.exec('PRAGMA foreign_keys = OFF;');
    corrupted.prepare(`
      UPDATE order_drafts SET matched_order_id = 'missing-order'
      WHERE id = 'legacy-draft'
    `).run();
    corrupted.close();

    expect(() => Workspace.open(corruptedDataDirectory)).toThrow(
      '数据库升级后外键完整性检查失败',
    );
    const rolledBack = new DatabaseSync(corruptedDatabasePath);
    try {
      expect(rolledBack.prepare(`
        SELECT MAX(version) AS version FROM schema_migrations
      `).get()).toEqual({ version: 15 });
      expect(rolledBack.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('order_drafts_v16', 'original_orders_v16')
      `).all()).toEqual([]);
    } finally {
      rolledBack.close();
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
      patch: { fulfillmentStatus: 'in_transit' },
    })).toThrow('履约状态格式无效');
    expect(() => application.updateOrderStatusAndLogistics({
      targets,
      patch: { shippingCarrier: 123 },
    })).toThrow('快递公司格式无效');
  });

  it('OCR 运行时结果不允许伪造已收货或已退货人工结论', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-ocr-terminal-boundary-'));
    const sourcePath = join(root, 'OCR 越界履约状态.png');
    await writeFile(sourcePath, Buffer.from('ocr-terminal-boundary'));
    const invalidRecognition = {
      ...completeRecognition('XY-OCR-TERMINAL-BOUNDARY-0001'),
      fulfillmentStatus: 'delivered',
    } as unknown as RecognitionResult;
    const application = new LocalApplication(new ControlledRecognizer(invalidRecognition));
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));

    await expect(application.submitRecognitionBatch([sourcePath])).rejects.toThrow(
      'OCR 识别履约状态格式错误',
    );
    expect(application.listOrders()).toEqual([]);
    expect(application.listRecognitionBatches()[0]).toMatchObject({
      counts: { failed: 1, awaiting_confirmation: 0 },
      items: [{ status: 'failed' }],
    });
    expect(application.listRecognitionBatches()[0].items[0].draftId).toBeUndefined();
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
      patch: { trackingNumber: 'ROLLBACK-MUST-UNDO-001' },
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

  it('待发货订单登记有效运单号后在同一次修改中自动变为已发货', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-logistics-auto-ship-'));
    const sourcePath = join(root, '自动发货订单.png');
    await writeFile(sourcePath, Buffer.from('order-logistics-auto-ship'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeRecognition('XY-LOGISTICS-AUTO-SHIP-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);

    const [saved] = application.updateOrderStatusAndLogistics({
      targets: [{ orderId: order.id, expectedRevision: order.revision }],
      patch: {
        fulfillmentStatus: 'pending_shipment',
        trackingNumber: '  SF-AUTO-001  ',
      },
    });

    expect(saved.order).toMatchObject({
      revision: 2,
      fulfillmentStatus: 'shipped',
      shippingCarrier: '',
      trackingNumber: 'SF-AUTO-001',
    });
    expect(saved.changeEvents[0].changes).toEqual([
      { path: 'fulfillmentStatus', before: 'pending_shipment', after: 'shipped' },
      { path: 'trackingNumber', before: '', after: 'SF-AUTO-001' },
    ]);
  });

  it('已发货订单清空运单号后自动退回待发货，单独填写快递公司不触发联动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-logistics-auto-pending-'));
    const sourcePath = join(root, '自动待发货订单.png');
    await writeFile(sourcePath, Buffer.from('order-logistics-auto-pending'));
    const application = new LocalApplication(
      new ControlledRecognizer(completeRecognition('XY-LOGISTICS-AUTO-PENDING-0001')),
    );
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);
    const [carrierOnly] = application.updateOrderStatusAndLogistics({
      targets: [{ orderId: order.id, expectedRevision: order.revision }],
      patch: { shippingCarrier: '顺丰速运' },
    });
    expect(carrierOnly.order).toMatchObject({
      revision: 2,
      fulfillmentStatus: 'pending_shipment',
      shippingCarrier: '顺丰速运',
      trackingNumber: '',
    });
    const [shipped] = application.updateOrderStatusAndLogistics({
      targets: [{ orderId: order.id, expectedRevision: carrierOnly.order.revision }],
      patch: { trackingNumber: 'SF-AUTO-002' },
    });

    const [pending] = application.updateOrderStatusAndLogistics({
      targets: [{ orderId: order.id, expectedRevision: shipped.order.revision }],
      patch: { fulfillmentStatus: 'shipped', trackingNumber: '' },
    });

    expect(pending.order).toMatchObject({
      revision: 4,
      fulfillmentStatus: 'pending_shipment',
      shippingCarrier: '顺丰速运',
      trackingNumber: '',
    });
    expect(pending.changeEvents[0].changes).toEqual([
      { path: 'fulfillmentStatus', before: 'shipped', after: 'pending_shipment' },
      { path: 'trackingNumber', before: 'SF-AUTO-002', after: '' },
    ]);
  });

  it('清空物流不会静默覆盖已收货、已退货或未知状态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-logistics-terminal-'));
    const paths = ['已收货订单.png', '已退货订单.png', '未知订单.png']
      .map((name) => join(root, name));
    await Promise.all(paths.map((path, index) => (
      writeFile(path, Buffer.from(`terminal-logistics-${index}`))
    )));
    const application = new LocalApplication(queuedRecognizer([
      completeRecognition('XY-TERMINAL-DELIVERED-0001'),
      completeRecognition('XY-TERMINAL-RETURNED-0001'),
      completeRecognition('XY-TERMINAL-UNKNOWN-0001'),
    ]));
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const drafts = (await application.submitRecognitionBatch(paths)).drafts;
    const orders = drafts.map((draft) => application.confirmDraft(draft));
    const terminalStatuses = ['delivered', 'returned', 'unknown'] as const;

    for (const [index, status] of terminalStatuses.entries()) {
      const [withLogistics] = application.updateOrderStatusAndLogistics({
        targets: [{ orderId: orders[index].id, expectedRevision: orders[index].revision }],
        patch: { fulfillmentStatus: status, trackingNumber: `TRACK-${index}` },
      });
      const [cleared] = application.updateOrderStatusAndLogistics({
        targets: [{
          orderId: orders[index].id,
          expectedRevision: withLogistics.order.revision,
        }],
        patch: { trackingNumber: '' },
      });
      expect(cleared.order).toMatchObject({
        fulfillmentStatus: status,
        trackingNumber: '',
      });
      expect(cleared.changeEvents[0].changes).toEqual([
        { path: 'trackingNumber', before: `TRACK-${index}`, after: '' },
      ]);
    }
  });

  it('批量填写运单号时按每笔订单的当前状态独立归一', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-logistics-batch-normalize-'));
    const paths = ['待发货订单.png', '已退货订单.png'].map((name) => join(root, name));
    await Promise.all(paths.map((path, index) => (
      writeFile(path, Buffer.from(`batch-logistics-${index}`))
    )));
    const application = new LocalApplication(queuedRecognizer([
      completeRecognition('XY-BATCH-PENDING-0001'),
      completeRecognition('XY-BATCH-RETURNED-0001'),
    ]));
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const drafts = (await application.submitRecognitionBatch(paths)).drafts;
    const [pendingOrder, terminalOrder] = drafts.map((draft) => application.confirmDraft(draft));
    const [returned] = application.updateOrderStatusAndLogistics({
      targets: [{ orderId: terminalOrder.id, expectedRevision: terminalOrder.revision }],
      patch: { fulfillmentStatus: 'returned' },
    });

    const saved = application.updateOrderStatusAndLogistics({
      targets: [
        { orderId: pendingOrder.id, expectedRevision: pendingOrder.revision },
        { orderId: terminalOrder.id, expectedRevision: returned.order.revision },
      ],
      patch: { trackingNumber: 'BATCH-TRACK-001' },
    });

    expect(saved[0].order).toMatchObject({
      fulfillmentStatus: 'shipped',
      trackingNumber: 'BATCH-TRACK-001',
      revision: 2,
    });
    expect(saved[0].changeEvents[0].changes).toEqual([
      { path: 'fulfillmentStatus', before: 'pending_shipment', after: 'shipped' },
      { path: 'trackingNumber', before: '', after: 'BATCH-TRACK-001' },
    ]);
    expect(saved[1].order).toMatchObject({
      fulfillmentStatus: 'returned',
      trackingNumber: 'BATCH-TRACK-001',
      revision: 3,
    });
    expect(saved[1].changeEvents[0].changes).toEqual([
      { path: 'trackingNumber', before: '', after: 'BATCH-TRACK-001' },
    ]);
  });

  it('人工确认草稿时可直接保存已收货或已退货，识别快照仍保持基础三态', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-order-draft-terminal-'));
    const paths = ['人工已收货.png', '人工已退货.png'].map((name) => join(root, name));
    await Promise.all(paths.map((path, index) => (
      writeFile(path, Buffer.from(`draft-terminal-${index}`))
    )));
    const application = new LocalApplication(queuedRecognizer([
      completeRecognition('XY-DRAFT-DELIVERED-0001'),
      completeRecognition('XY-DRAFT-RETURNED-0001'),
    ]));
    openedApplications.push(application);
    application.openDataDirectory(join(root, '数据'));
    const drafts = (await application.submitRecognitionBatch(paths)).drafts;

    for (const [index, status] of (['delivered', 'returned'] as const).entries()) {
      const order = application.confirmDraft({ ...drafts[index], fulfillmentStatus: status });
      const details = application.getOrder(order.id);
      expect(details.order.fulfillmentStatus).toBe(status);
      expect(details.sourceSnapshot.recognition.fulfillmentStatus).toBe('pending_shipment');
      expect(details.sourceSnapshot.confirmed?.fulfillmentStatus).toBe(status);
    }
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
