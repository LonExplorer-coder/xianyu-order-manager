import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import type { Recognizer } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';

describe('数据库升级', () => {
  it('将带关联数据的 v1 数据库完整、幂等地升级到 v4 并回填识别批次记录', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v1-migration-'));
    createVersion1Database(dataDirectory);

    const first = Workspace.open(dataDirectory);
    expect(
      first.database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    expect(
      (
        first.database.prepare('PRAGMA table_info(order_drafts)').all() as unknown as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).filter((column) => column.name === 'review_cancelled_at'),
    ).toMatchObject([
      {
        name: 'review_cancelled_at',
        type: 'TEXT',
        notnull: 0,
        dflt_value: null,
      },
    ]);
    expect(
      first.database
        .prepare("SELECT review_cancelled_at FROM order_drafts WHERE id = 'draft-v1'")
        .get(),
    ).toEqual({ review_cancelled_at: null });
    expect(first.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      first.database
        .prepare(`
          SELECT batch_id, source_name, content_sha256, status, draft_id
          FROM recognition_batch_items
          WHERE draft_id = 'draft-v1'
        `)
        .get(),
    ).toEqual({
      batch_id: 'batch-v1',
      source_name: '旧订单.png',
      content_sha256: 'abc123',
      status: 'imported',
      draft_id: 'draft-v1',
    });
    expect(
      first.database
        .prepare(`
          SELECT batch_id, source_name, content_sha256, status, draft_id, error_message
          FROM recognition_batch_items
          WHERE id = 'screenshot-orphan-v1'
        `)
        .get(),
    ).toEqual({
      batch_id: 'batch-v1',
      source_name: '旧版残缺记录.png',
      content_sha256: 'orphan123',
      status: 'failed',
      draft_id: null,
      error_message: '旧版来源截图未关联订单草稿，无法恢复',
    });
    expect(first.database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(
      first.database
        .prepare(`
          SELECT
            platform_order_number, alipay_transaction_number,
            phone, phone_normalized, address_original, address_normalized,
            product_total_cents, shipping_fee_cents, amount_cents,
            platform_transaction_status, fulfillment_status, lifecycle_status
          FROM original_orders
          WHERE id = 'order-v1'
        `)
        .get(),
    ).toEqual({
      platform_order_number: 'XY-V1-001',
      alipay_transaction_number: '',
      phone: '13800000000',
      phone_normalized: '13800000000',
      address_original: '广东省深圳市南山区旧数据1号',
      address_normalized: '广东省深圳市南山区旧数据1号',
      product_total_cents: null,
      shipping_fee_cents: null,
      amount_cents: 880,
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      lifecycle_status: 'active',
    });
    expect(
      first.database.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = 'order-v1'").get(),
    ).toEqual({ count: 1 });
    expect(
      first.database
        .prepare("SELECT COUNT(*) AS count FROM source_snapshots WHERE order_id = 'order-v1'")
        .get(),
    ).toEqual({ count: 1 });

    const updatePlatformStatus = first.database.prepare(
      "UPDATE original_orders SET platform_transaction_status = ? WHERE id = 'order-v1'",
    );
    for (const status of ['paid', 'cancelled', 'refunded', 'unknown']) {
      expect(updatePlatformStatus.run(status).changes).toBe(1);
    }
    expect(() => updatePlatformStatus.run('invalid')).toThrow();

    const updateFulfillmentStatus = first.database.prepare(
      "UPDATE original_orders SET fulfillment_status = ? WHERE id = 'order-v1'",
    );
    for (const status of ['pending_shipment', 'shipped', 'unknown']) {
      expect(updateFulfillmentStatus.run(status).changes).toBe(1);
    }
    expect(() => updateFulfillmentStatus.run('invalid')).toThrow();

    const updateLifecycleStatus = first.database.prepare(
      "UPDATE original_orders SET lifecycle_status = ? WHERE id = 'order-v1'",
    );
    for (const status of ['active', 'trashed', 'deleted']) {
      expect(updateLifecycleStatus.run(status).changes).toBe(1);
    }
    expect(() => updateLifecycleStatus.run('invalid')).toThrow();
    first.database.prepare(`
      INSERT INTO recognition_attempts (
        id, screenshot_id, draft_id, provider, model, request_id,
        schema_version, raw_response, created_at
      ) VALUES (
        'attempt-v2', 'screenshot-v1', 'draft-v1', 'controlled', 'controlled', '',
        1, '{"synthetic":true}', '2026-07-27T00:00:00.000Z'
      )
    `).run();
    expect(() => first.database.prepare(
      "UPDATE recognition_attempts SET raw_response = '{}' WHERE id = 'attempt-v2'",
    ).run()).toThrow('recognition attempts are immutable');
    expect(() => first.database.prepare(
      "DELETE FROM recognition_attempts WHERE id = 'attempt-v2'",
    ).run()).toThrow('recognition attempts are immutable');
    expect(first.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    first.close();

    const reopened = Workspace.open(dataDirectory);
    expect(
      reopened.database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    expect(
      (
        reopened.database.prepare('PRAGMA table_info(order_drafts)').all() as unknown as Array<{
          name: string;
        }>
      ).filter((column) => column.name === 'review_cancelled_at'),
    ).toHaveLength(1);
    expect(
      reopened.database
        .prepare("SELECT review_cancelled_at FROM order_drafts WHERE id = 'draft-v1'")
        .get(),
    ).toEqual({ review_cancelled_at: null });
    expect(reopened.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(reopened.database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    reopened.close();

    const unusedRecognizer: Recognizer = {
      recognize: async () => {
        throw new Error('该测试不应发起识别');
      },
    };
    const application = new LocalApplication(unusedRecognizer);
    application.openDataDirectory(dataDirectory);
    expect(application.listRecognitionBatches()).toMatchObject([{
      id: 'batch-v1',
      totalCount: 2,
      processedCount: 2,
      counts: { imported: 1, failed: 1 },
      items: [
        {
          sourceName: '旧订单.png',
          status: 'imported',
          draftId: 'draft-v1',
        },
        {
          sourceName: '旧版残缺记录.png',
          status: 'failed',
          errorMessage: '旧版来源截图未关联订单草稿，无法恢复',
        },
      ],
    }]);
    expect(application.getOrder('order-v1')).toMatchObject({
      order: {
        orderNumber: 'XY-V1-001',
        alipayTransactionNumber: '',
        phoneNormalized: '13800000000',
        addressNormalized: '广东省深圳市南山区旧数据1号',
        productTotalCents: null,
        shippingFeeCents: null,
        amountCents: 880,
        platformTransactionStatus: 'unknown',
        fulfillmentStatus: 'unknown',
        lifecycleStatus: 'deleted',
      },
      sourceSnapshot: {
        recognition: {
          orderNumber: 'XY-V1-001',
          productTotalCents: null,
          shippingFeeCents: null,
          amountCents: 880,
          platformTransactionStatus: 'paid',
          fulfillmentStatus: 'pending_shipment',
        },
        confirmed: {
          orderNumber: 'XY-V1-001',
          productTotalCents: null,
          shippingFeeCents: null,
          amountCents: 880,
          platformTransactionStatus: 'paid',
          fulfillmentStatus: 'pending_shipment',
        },
      },
    });
    application.close();
  });
});

function createVersion1Database(dataDirectory: string): void {
  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
    enableForeignKeyConstraints: true,
  });
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE recognition_batches (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      seller_account TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('awaiting_review', 'completed')),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE source_screenshots (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES recognition_batches(id) ON DELETE RESTRICT,
      original_name TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      content_sha256 TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

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
      confirmed_at TEXT
    ) STRICT;

    CREATE TABLE draft_items (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL REFERENCES order_drafts(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      source_title TEXT NOT NULL,
      source_spec TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      quantity_inferred INTEGER NOT NULL CHECK (quantity_inferred IN (0, 1)),
      UNIQUE (draft_id, position)
    ) STRICT;

    CREATE TABLE original_orders (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE REFERENCES order_drafts(id) ON DELETE RESTRICT,
      screenshot_id TEXT NOT NULL REFERENCES source_screenshots(id) ON DELETE RESTRICT,
      platform TEXT NOT NULL,
      seller_account TEXT NOT NULL,
      platform_order_number TEXT NOT NULL,
      buyer_nickname TEXT NOT NULL,
      recipient TEXT NOT NULL,
      phone TEXT NOT NULL,
      address_original TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      platform_transaction_status TEXT NOT NULL CHECK (platform_transaction_status IN ('paid')),
      fulfillment_status TEXT NOT NULL CHECK (fulfillment_status IN ('pending_shipment')),
      lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('active')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (platform, seller_account, platform_order_number)
    ) STRICT;

    CREATE TABLE order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES original_orders(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      source_title TEXT NOT NULL,
      source_spec TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      quantity_inferred INTEGER NOT NULL CHECK (quantity_inferred IN (0, 1)),
      subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
      UNIQUE (order_id, position)
    ) STRICT;

    CREATE TABLE source_snapshots (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES original_orders(id) ON DELETE RESTRICT,
      screenshot_id TEXT NOT NULL REFERENCES source_screenshots(id) ON DELETE RESTRICT,
      recognition_json TEXT NOT NULL,
      confirmed_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    INSERT INTO schema_migrations VALUES (1, '2026-07-27T00:00:00.000Z');
    INSERT INTO recognition_batches VALUES (
      'batch-v1', 'xianyu', '旧账号', 'completed', '2026-07-27T00:00:00.000Z'
    );
    INSERT INTO source_screenshots VALUES (
      'screenshot-v1', 'batch-v1', '旧订单.png', 'screenshots/old.png', 'abc123',
      'image/png', '2026-07-27T00:00:00.000Z'
    );
    INSERT INTO source_screenshots VALUES (
      'screenshot-orphan-v1', 'batch-v1', '旧版残缺记录.png',
      'screenshots/orphan.png', 'orphan123', 'image/png', '2026-07-27T00:00:02.000Z'
    );
  `);

  const legacyRecognition = JSON.stringify({
    platform: 'xianyu',
    sellerAccount: '旧账号',
    orderNumber: 'XY-V1-001',
    buyerNickname: '旧买家',
    recipient: '旧收件人',
    phone: '13800000000',
    addressOriginal: '广东省深圳市南山区旧数据1号',
    amountCents: 880,
    items: [
      {
        sourceTitle: '旧商品',
        sourceSpec: '旧规格',
        unitPriceCents: 880,
        quantity: 1,
        quantityInferred: true,
      },
    ],
  });
  database
    .prepare(`
      INSERT INTO order_drafts VALUES (
        'draft-v1', 'batch-v1', 'screenshot-v1', 'xianyu', '旧账号', 'XY-V1-001',
        '旧买家', '旧收件人', '13800000000', '广东省深圳市南山区旧数据1号',
        880, 'confirmed', ?, '2026-07-27T00:00:00.000Z', '2026-07-27T00:01:00.000Z'
      )
    `)
    .run(legacyRecognition);
  database.exec(`
    INSERT INTO draft_items VALUES (
      'draft-item-v1', 'draft-v1', 0, '旧商品', '旧规格', 880, 1, 1
    );
    INSERT INTO original_orders VALUES (
      'order-v1', 'draft-v1', 'screenshot-v1', 'xianyu', '旧账号', 'XY-V1-001',
      '旧买家', '旧收件人', '13800000000', '广东省深圳市南山区旧数据1号', 880,
      'paid', 'pending_shipment', 'active',
      '2026-07-27T00:01:00.000Z', '2026-07-27T00:01:00.000Z'
    );
    INSERT INTO order_items VALUES (
      'order-item-v1', 'order-v1', 0, '旧商品', '旧规格', 880, 1, 1, 880
    );
  `);
  database
    .prepare(`
      INSERT INTO source_snapshots VALUES (
        'snapshot-v1', 'order-v1', 'screenshot-v1', ?, ?, '2026-07-27T00:01:00.000Z'
      )
    `)
    .run(legacyRecognition, legacyRecognition);
  database.close();
}
