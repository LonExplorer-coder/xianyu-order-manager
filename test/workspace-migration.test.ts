import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import type { Recognizer } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';

describe('数据库升级', () => {
  it('将带关联数据的 v1 数据库完整、幂等地升级到 v9 并保留来源、字段与模板约束', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v1-migration-'));
    createVersion1Database(dataDirectory);

    const first = Workspace.open(dataDirectory);
    expect(
      first.database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
    ]);
    expect(
      first.database
        .prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'custom_field_definitions',
              'custom_field_values',
              'table_templates',
              'table_template_custom_field_dependencies'
            )
          ORDER BY name
        `)
        .all(),
    ).toEqual([
      { name: 'custom_field_definitions' },
      { name: 'custom_field_values' },
      { name: 'table_template_custom_field_dependencies' },
      { name: 'table_templates' },
    ]);
    first.database.exec(`
      INSERT INTO custom_field_definitions (
        id, name, granularity, value_type, required,
        default_value_json, options_json, created_at, updated_at
      ) VALUES
        (
          'field-order-v8', '订单备注', 'order', 'text', 0,
          NULL, '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
        ),
        (
          'field-item-v8', '商品备注', 'order_item', 'text', 0,
          NULL, '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
        );
      INSERT INTO custom_field_values (
        id, definition_id, order_id, order_item_id,
        value_json, created_at, updated_at
      ) VALUES (
        'value-order-v8', 'field-order-v8', 'order-v1', NULL,
        '"有效订单值"', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
      );
    `);
    first.database.prepare(`
      INSERT INTO table_templates (
        id, name, name_key, granularity, configuration_version,
        configuration_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'template-order-v9',
      '订单跟单表',
      '订单跟单表',
      'order',
      1,
      '{"columns":[]}',
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:00:00.000Z',
    );
    first.database.prepare(`
      INSERT INTO table_template_custom_field_dependencies (
        template_id, definition_id, usage
      ) VALUES (?, ?, ?)
    `).run('template-order-v9', 'field-order-v8', 'column');
    expect(() => first.database.prepare(`
      INSERT INTO table_template_custom_field_dependencies (
        template_id, definition_id, usage
      ) VALUES ('template-order-v9', 'field-item-v8', 'filter')
    `).run()).toThrow('table template and custom field granularities do not match');
    expect(() => first.database.prepare(`
      UPDATE table_templates
      SET granularity = 'order_item'
      WHERE id = 'template-order-v9'
    `).run()).toThrow('cannot change table template granularity with custom field dependencies');
    expect(() => first.database.prepare(`
      UPDATE custom_field_definitions
      SET granularity = 'order_item'
      WHERE id = 'field-order-v8'
    `).run()).toThrow('table template and custom field granularities do not match');
    expect(() => first.database.prepare(`
      INSERT INTO table_templates (
        id, name, name_key, granularity, configuration_version,
        configuration_json, created_at, updated_at
      ) VALUES (
        'template-invalid-json-v9', '错误模板', '错误模板', 'order', 1,
        '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
      )
    `).run()).toThrow();
    expect(() => first.database.prepare(`
      INSERT INTO table_templates (
        id, name, name_key, granularity, configuration_version,
        configuration_json, created_at, updated_at
      ) VALUES (
        'template-duplicate-v9', '订单跟单表（重名）', '订单跟单表', 'order', 1,
        '{"columns":[]}', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
      )
    `).run()).toThrow();
    expect(() => first.database.prepare(`
      DELETE FROM custom_field_definitions WHERE id = 'field-order-v8'
    `).run()).toThrow();
    expect(() => first.database.prepare(`
      INSERT INTO custom_field_values (
        id, definition_id, order_id, order_item_id,
        value_json, created_at, updated_at
      ) VALUES (
        'invalid-order-owner-v8', 'field-order-v8', NULL, 'order-item-v1',
        '"错误归属"', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
      )
    `).run()).toThrow('custom field granularity does not match value owner');
    expect(() => first.database.prepare(`
      INSERT INTO custom_field_values (
        id, definition_id, order_id, order_item_id,
        value_json, created_at, updated_at
      ) VALUES (
        'invalid-item-owner-v8', 'field-item-v8', 'order-v1', NULL,
        '"错误归属"', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
      )
    `).run()).toThrow('custom field granularity does not match value owner');
    expect(() => first.database.prepare(`
      UPDATE custom_field_values
      SET order_id = NULL, order_item_id = 'order-item-v1'
      WHERE id = 'value-order-v8'
    `).run()).toThrow('custom field granularity does not match value owner');
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
    expect(
      (
        first.database.prepare('PRAGMA table_info(order_drafts)').all() as unknown as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }>
      ).filter((column) => column.name === 'review_issues_json'),
    ).toMatchObject([{
      name: 'review_issues_json',
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'[]'",
    }]);
    expect(
      first.database
        .prepare("SELECT review_issues_json FROM order_drafts WHERE id = 'draft-v1'")
        .get(),
    ).toEqual({ review_issues_json: '[]' });
    expect(
      first.database
        .prepare("SELECT intake_decision_pending FROM order_drafts WHERE id = 'draft-v1'")
        .get(),
    ).toEqual({ intake_decision_pending: 0 });
    expect(() => first.database
      .prepare("UPDATE order_drafts SET review_issues_json = '{}' WHERE id = 'draft-v1'")
      .run()).toThrow();
    expect(first.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      first.database
        .prepare(`
          SELECT batch_id, source_name, content_sha256, status, draft_id,
            queue_relative_path, retry_count, next_retry_at, resolution_kind
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
      queue_relative_path: null,
      retry_count: 0,
      next_retry_at: null,
      resolution_kind: 'new_order',
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
            seller_account_normalized, platform_order_number,
            platform_order_number_normalized, alipay_transaction_number,
            phone, phone_normalized, address_original, address_normalized,
            product_total_cents, shipping_fee_cents, amount_cents, revision,
            platform_transaction_status, fulfillment_status, lifecycle_status
          FROM original_orders
          WHERE id = 'order-v1'
        `)
        .get(),
    ).toEqual({
      seller_account_normalized: '旧账号',
      platform_order_number: 'XY-V1-001',
      platform_order_number_normalized: 'XY-V1-001',
      alipay_transaction_number: '',
      phone: '13800000000',
      phone_normalized: '13800000000',
      address_original: '广东省深圳市南山区旧数据1号',
      address_normalized: '广东省深圳市南山区旧数据1号',
      product_total_cents: null,
      shipping_fee_cents: null,
      amount_cents: 880,
      revision: 1,
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      lifecycle_status: 'active',
    });
    expect(
      first.database.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = 'order-v1'").get(),
    ).toEqual({ count: 1 });
    expect(
      first.database
        .prepare(`
          SELECT draft_id, order_id, confirmed_json IS NOT NULL AS confirmed,
            resolved_at IS NOT NULL AS resolved
          FROM source_snapshots
          WHERE order_id = 'order-v1'
        `)
        .get(),
    ).toEqual({
      draft_id: 'draft-v1',
      order_id: 'order-v1',
      confirmed: 1,
      resolved: 1,
    });
    expect(() => first.database.prepare(`
      UPDATE source_snapshots
      SET confirmed_json = recognition_json
      WHERE order_id = 'order-v1'
    `).run()).toThrow('source snapshots are immutable after finalization');
    expect(
      first.database
        .prepare("SELECT COUNT(*) AS count FROM order_change_events")
        .get(),
    ).toEqual({ count: 0 });

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
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
    ]);
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
    expect(
      reopened.database
        .prepare("SELECT review_issues_json FROM order_drafts WHERE id = 'draft-v1'")
        .get(),
    ).toEqual({ review_issues_json: '[]' });
    expect(
      reopened.database
        .prepare("SELECT intake_decision_pending FROM order_drafts WHERE id = 'draft-v1'")
        .get(),
    ).toEqual({ intake_decision_pending: 0 });
    expect(reopened.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(reopened.database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(
      reopened.database.prepare(`
        SELECT name, name_key, granularity, configuration_version, configuration_json
        FROM table_templates
        WHERE id = 'template-order-v9'
      `).get(),
    ).toEqual({
      name: '订单跟单表',
      name_key: '订单跟单表',
      granularity: 'order',
      configuration_version: 1,
      configuration_json: '{"columns":[]}',
    });
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
          resolution: 'new_order',
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
        revision: 1,
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
      sources: [{
        sourceSnapshot: {
          recognition: { orderNumber: 'XY-V1-001' },
          confirmed: { orderNumber: 'XY-V1-001' },
        },
      }],
      changeEvents: [],
    });
    application.close();
  });

  it('升级前发现全角半角归一化后的订单身份碰撞时拒绝部分升级', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-identity-collision-'));
    createVersion1Database(dataDirectory);
    addVersion1CollidingOrder(dataDirectory);

    expect(() => Workspace.open(dataDirectory)).toThrowError(/规范化后存在重复订单身份/);

    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
      enableForeignKeyConstraints: true,
    });
    try {
      expect(database.prepare(
        'SELECT version FROM schema_migrations ORDER BY version',
      ).all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
      ]);
      const columns = database.prepare('PRAGMA table_info(original_orders)').all() as unknown as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).not.toContain('seller_account_normalized');
      expect(columns.map((column) => column.name)).not.toContain(
        'platform_order_number_normalized',
      );
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('升级时为旧版待确认草稿补建未决来源快照并允许继续确认', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-pending-snapshot-'));
    createVersion1Database(dataDirectory);
    addVersion1PendingDraft(dataDirectory);

    const workspace = Workspace.open(dataDirectory);
    expect(workspace.database.prepare(`
      SELECT draft_id, order_id, confirmed_json, resolved_at
      FROM source_snapshots
      WHERE draft_id = 'draft-pending-v1'
    `).get()).toEqual({
      draft_id: 'draft-pending-v1',
      order_id: null,
      confirmed_json: null,
      resolved_at: null,
    });
    workspace.close();

    const application = new LocalApplication({
      recognize: async () => {
        throw new Error('该测试不应发起识别');
      },
    });
    application.openDataDirectory(dataDirectory);
    try {
      const order = application.confirmDraft({
        ...application.getDraft('draft-pending-v1'),
        productTotalCents: 660,
        shippingFeeCents: 0,
      });
      expect(order).toMatchObject({
        orderNumber: 'XY-PENDING-001',
        revision: 1,
      });
      expect(application.getOrder(order.id).sources).toHaveLength(1);
    } finally {
      application.close();
    }
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

function addVersion1CollidingOrder(dataDirectory: string): void {
  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
    enableForeignKeyConstraints: true,
  });
  const fullWidthOrderNumber = 'ＸＹ－Ｖ１－００１';
  const recognition = JSON.stringify({
    platform: 'xianyu',
    sellerAccount: '旧账号',
    orderNumber: fullWidthOrderNumber,
    buyerNickname: '碰撞买家',
    recipient: '碰撞收件人',
    phone: '13900000000',
    addressOriginal: '广东省深圳市南山区旧数据2号',
    amountCents: 990,
    items: [{
      sourceTitle: '碰撞商品',
      sourceSpec: '碰撞规格',
      unitPriceCents: 990,
      quantity: 1,
      quantityInferred: true,
    }],
  });
  try {
    database.exec(`
      INSERT INTO source_screenshots VALUES (
        'screenshot-collision-v1', 'batch-v1', '全角订单.png',
        'screenshots/collision.png', 'collision123', 'image/png',
        '2026-07-27T00:02:00.000Z'
      );
    `);
    database.prepare(`
      INSERT INTO order_drafts VALUES (
        'draft-collision-v1', 'batch-v1', 'screenshot-collision-v1',
        'xianyu', '旧账号', ?, '碰撞买家', '碰撞收件人', '13900000000',
        '广东省深圳市南山区旧数据2号', 990, 'confirmed', ?,
        '2026-07-27T00:02:00.000Z', '2026-07-27T00:03:00.000Z'
      )
    `).run(fullWidthOrderNumber, recognition);
    database.prepare(`
      INSERT INTO original_orders VALUES (
        'order-collision-v1', 'draft-collision-v1', 'screenshot-collision-v1',
        'xianyu', '旧账号', ?, '碰撞买家', '碰撞收件人', '13900000000',
        '广东省深圳市南山区旧数据2号', 990,
        'paid', 'pending_shipment', 'active',
        '2026-07-27T00:03:00.000Z', '2026-07-27T00:03:00.000Z'
      )
    `).run(fullWidthOrderNumber);
    database.exec(`
      INSERT INTO draft_items VALUES (
        'draft-item-collision-v1', 'draft-collision-v1', 0,
        '碰撞商品', '碰撞规格', 990, 1, 1
      );
      INSERT INTO order_items VALUES (
        'order-item-collision-v1', 'order-collision-v1', 0,
        '碰撞商品', '碰撞规格', 990, 1, 1, 990
      );
    `);
    database.prepare(`
      INSERT INTO source_snapshots VALUES (
        'snapshot-collision-v1', 'order-collision-v1', 'screenshot-collision-v1',
        ?, ?, '2026-07-27T00:03:00.000Z'
      )
    `).run(recognition, recognition);
  } finally {
    database.close();
  }
}

function addVersion1PendingDraft(dataDirectory: string): void {
  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
    enableForeignKeyConstraints: true,
  });
  const recognition = JSON.stringify({
    platform: 'xianyu',
    sellerAccount: '旧账号',
    orderNumber: 'XY-PENDING-001',
    buyerNickname: '待确认买家',
    recipient: '待确认收件人',
    phone: '13700000000',
    addressOriginal: '广东省深圳市南山区待确认路1号',
    amountCents: 660,
    items: [{
      sourceTitle: '待确认商品',
      sourceSpec: '待确认规格',
      unitPriceCents: 660,
      quantity: 1,
      quantityInferred: true,
    }],
  });
  try {
    database.exec(`
      INSERT INTO source_screenshots VALUES (
        'screenshot-pending-v1', 'batch-v1', '待确认订单.png',
        'screenshots/pending.png', 'pending123', 'image/png',
        '2026-07-27T00:04:00.000Z'
      );
    `);
    database.prepare(`
      INSERT INTO order_drafts VALUES (
        'draft-pending-v1', 'batch-v1', 'screenshot-pending-v1',
        'xianyu', '旧账号', 'XY-PENDING-001', '待确认买家', '待确认收件人',
        '13700000000', '广东省深圳市南山区待确认路1号', 660,
        'awaiting_review', ?, '2026-07-27T00:04:00.000Z', NULL
      )
    `).run(recognition);
    database.exec(`
      INSERT INTO draft_items VALUES (
        'draft-item-pending-v1', 'draft-pending-v1', 0,
        '待确认商品', '待确认规格', 660, 1, 1
      );
    `);
  } finally {
    database.close();
  }
}
