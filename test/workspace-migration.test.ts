import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import type { RecognitionResult, Recognizer } from '../src/core/contracts';
import { createOrderTableProjectionPlan } from '../src/core/table-templates';
import { LocalApplication } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';
import {
  downgradeVersion35ToOriginalSchema,
  removeVersion31ExtensionArtifacts,
  removeVersion33ExtensionArtifacts,
  removeVersion35ExtensionArtifacts,
  removeVersion38ExtensionArtifacts,
  removeVersion39ExtensionArtifacts,
  removeVersion40ExtensionArtifacts,
  removeVersion41ExtensionArtifacts,
  removeVersion42ExtensionArtifacts,
} from './version31-fixture';

function productMigrationRecognition(): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '迁移测试账号',
    orderNumber: 'XY-V39-PRODUCT',
    alipayTransactionNumber: 'ALI-V39-PRODUCT',
    buyerNickname: '迁***户',
    recipient: '迁移收件人',
    phone: '13900000040',
    phoneNormalized: '13900000040',
    addressOriginal: '广东省深圳市南山区迁移路40号',
    addressNormalized: '广东省深圳市南山区迁移路40号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-14 10:00:00',
    orderedAtNormalized: '2026-08-14T10:00:00+08:00',
    paidAtOriginal: '2026-08-14 10:00:08',
    paidAtNormalized: '2026-08-14T10:00:08+08:00',
    productTotalCents: 1000,
    shippingFeeCents: 0,
    amountCents: 1000,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '迁移标准商品',
      sourceSpec: '标准规格',
      unitPriceCents: 1000,
      quantity: 1,
      quantityInferred: false,
    }],
  };
}

function fulfillmentPlanMigrationRecognition(): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '迁移测试账号',
    orderNumber: 'XY-V41-PLAN',
    alipayTransactionNumber: 'ALI-V41-PLAN',
    buyerNickname: '迁***户',
    recipient: '迁移收件人',
    phone: '13900000041',
    phoneNormalized: '13900000041',
    addressOriginal: '广东省深圳市南山区迁移路41号',
    addressNormalized: '广东省深圳市南山区迁移路41号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-14 10:00:00',
    orderedAtNormalized: '2026-08-14T10:00:00+08:00',
    paidAtOriginal: '2026-08-14 10:00:08',
    paidAtNormalized: '2026-08-14T10:00:08+08:00',
    productTotalCents: 1000,
    shippingFeeCents: 0,
    amountCents: 1000,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '迁移预售商品',
      sourceSpec: '标准规格',
      unitPriceCents: 1000,
      quantity: 2,
      quantityInferred: false,
    }],
  };
}

function recipientMigrationRecognition(
  orderNumber: string,
  recipient: string,
  phone: string,
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '迁移测试账号',
    orderNumber,
    alipayTransactionNumber: '',
    buyerNickname: '迁***户',
    recipient,
    phone,
    phoneNormalized: phone,
    addressOriginal: '广东省深圳市南山区迁移路42号',
    addressNormalized: '广东省深圳市南山区迁移路42号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-14 10:00:00',
    orderedAtNormalized: '2026-08-14T10:00:00+08:00',
    paidAtOriginal: '2026-08-14 10:00:08',
    paidAtNormalized: '2026-08-14T10:00:08+08:00',
    productTotalCents: 1000,
    shippingFeeCents: 0,
    amountCents: 1000,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '迁移商品',
      sourceSpec: '标准规格',
      unitPriceCents: 1000,
      quantity: 1,
      quantityInferred: false,
    }],
  };
}

describe('数据库升级', () => {
  it('将真实 v39 工作区升级为标准商品与映射并在重启后保持关联', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v39-product-standardization-'));
    const current = Workspace.open(dataDirectory);
    current.close();
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      removeVersion40ExtensionArtifacts(legacy);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 39 });
      expect((legacy.prepare('PRAGMA table_info(order_items)').all() as Array<{ name: string }>)
        .map(({ name }) => name)).not.toContain('standard_product_id');
    } finally {
      legacy.close();
    }

    const sourcePath = join(dataDirectory, '标准商品迁移订单.png');
    const application = new LocalApplication({
      recognize: async () => ({
        result: productMigrationRecognition(),
        evidences: [{
          provider: 'controlled',
          model: 'controlled',
          requestId: 'v39-product-standardization',
          schemaVersion: 1,
          rawResponse: '{}',
        }],
      }),
    });
    application.openDataDirectory(dataDirectory);
    const product = application.createStandardProduct({
      sku: 'SKU-V39-MIGRATED',
      name: '迁移标准商品',
      specification: '标准规格',
    });
    await writeFile(sourcePath, Buffer.from('v39-product-standardization'));
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);
    application.close();

    const reopened = new LocalApplication({
      recognize: async () => { throw new Error('重启读取不应调用 OCR'); },
    });
    reopened.openDataDirectory(dataDirectory);
    try {
      expect(reopened.listStandardProducts()).toEqual([
        expect.objectContaining({ id: product.id, sku: 'SKU-V39-MIGRATED' }),
      ]);
      expect(reopened.getOrder(order.id).order.items[0]).toMatchObject({
        sourceTitle: '迁移标准商品',
        sourceSpec: '标准规格',
        standardProduct: { id: product.id, sku: 'SKU-V39-MIGRATED' },
        standardizationSource: 'exact',
      });
    } finally {
      reopened.close();
    }

    const verified = Workspace.open(dataDirectory);
    try {
      expect(verified.database.prepare(
        'SELECT MAX(version) AS version FROM schema_migrations',
      ).get()).toEqual({ version: 50 });
      expect(() => verified.database.prepare(`
        UPDATE order_items
        SET standardization_source = NULL
        WHERE id = ?
      `).run(order.items[0].id)).toThrow(/standardization is inconsistent/);
      expect(verified.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      verified.close();
    }
  });

  it('标准商品迁移失败时回滚全部结构，修复后可重新升级', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v40-product-rollback-'));
    Workspace.open(dataDirectory).close();
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      removeVersion40ExtensionArtifacts(legacy);
      legacy.exec(`
        CREATE TRIGGER fail_product_standardization_migration
        BEFORE INSERT ON schema_migrations
        WHEN NEW.version = 40
        BEGIN
          SELECT RAISE(ABORT, 'injected product standardization migration failure');
        END;
      `);
    } finally {
      legacy.close();
    }

    expect(() => Workspace.open(dataDirectory)).toThrow(
      /injected product standardization migration failure/u,
    );
    const rolledBack = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      expect(rolledBack.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 39 });
      expect(rolledBack.prepare(`
        SELECT name FROM sqlite_schema
        WHERE name IN ('standard_products', 'product_mappings')
      `).all()).toEqual([]);
      expect((rolledBack.prepare('PRAGMA table_info(order_items)').all() as Array<{
        name: string;
      }>).map(({ name }) => name)).not.toContain('standard_product_id');
      rolledBack.exec('DROP TRIGGER fail_product_standardization_migration;');
    } finally {
      rolledBack.close();
    }

    const repaired = Workspace.open(dataDirectory);
    try {
      expect(repaired.database.prepare(
        'SELECT MAX(version) AS version FROM schema_migrations',
      ).get()).toEqual({ version: 50 });
      expect(repaired.database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE name IN ('standard_products', 'product_mappings')
        ORDER BY name
      `).all()).toEqual([
        { name: 'product_mappings' },
        { name: 'standard_products' },
      ]);
    } finally {
      repaired.close();
    }
  });

  it('将真实 v40 工作区升级为履约计划并在重启后保持计划与归属', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v40-fulfillment-plans-'));
    const current = Workspace.open(dataDirectory);
    current.close();
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      removeVersion41ExtensionArtifacts(legacy);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 40 });
      expect(legacy.prepare(`
        SELECT name FROM sqlite_schema WHERE name IN (
          'fulfillment_plans', 'fulfillment_plan_members', 'fulfillment_plan_events'
        )
      `).all()).toEqual([]);
    } finally {
      legacy.close();
    }

    const sourcePath = join(dataDirectory, '预售迁移订单.png');
    await writeFile(sourcePath, Buffer.from('v40-fulfillment-plans'));
    const application = new LocalApplication({
      recognize: async () => ({
        result: fulfillmentPlanMigrationRecognition(),
        evidences: [{
          provider: 'controlled',
          model: 'controlled',
          requestId: 'v40-fulfillment-plans',
          schemaVersion: 1,
          rawResponse: '{}',
        }],
      }),
    });
    application.openDataDirectory(dataDirectory);
    const [draft] = (await application.submitRecognitionBatch([sourcePath])).drafts;
    const order = application.confirmDraft(draft);
    const plan = application.createFulfillmentPlan({
      type: 'presale',
      name: '迁移预售',
      expectedShipAt: '2026-09-01T00:00:00.000Z',
      reason: '预售开始备货',
    });
    const withMember = application.addFulfillmentPlanOrders({
      planId: plan.id,
      expectedRevision: plan.revision,
      orderIds: [order.id],
      reason: '加入预售',
    });
    expect(withMember).toMatchObject({ activeOrderCount: 1, status: 'pending' });
    application.close();

    const reopened = new LocalApplication({
      recognize: async () => { throw new Error('重启读取不应调用 OCR'); },
    });
    reopened.openDataDirectory(dataDirectory);
    try {
      expect(reopened.queryFulfillmentPlans()).toEqual([
        expect.objectContaining({
          id: plan.id,
          name: '迁移预售',
          status: 'pending',
          members: [expect.objectContaining({
            orderId: order.id,
            joinReason: '加入预售',
            releasedAt: null,
            removedAt: null,
          })],
          events: expect.arrayContaining([
            expect.objectContaining({ eventType: 'created', reason: '预售开始备货' }),
            expect.objectContaining({ eventType: 'orders_added', reason: '加入预售' }),
          ]),
        }),
      ]);
    } finally {
      reopened.close();
    }

    const verified = Workspace.open(dataDirectory);
    try {
      expect(verified.database.prepare(
        'SELECT MAX(version) AS version FROM schema_migrations',
      ).get()).toEqual({ version: 50 });
      expect(verified.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => verified.database.prepare(`
        INSERT INTO fulfillment_plan_members (
          id, plan_id, order_id, joined_at, join_reason
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        'member-duplicate-active',
        plan.id,
        order.id,
        '2026-08-14T11:00:00.000Z',
        '重复加入',
      )).toThrow();
      expect(() => verified.database.prepare(`
        UPDATE fulfillment_plan_events SET reason = '篡改' WHERE plan_id = ?
      `).run(plan.id)).toThrow(/fulfillment plan events are immutable/);
    } finally {
      verified.close();
    }
  });

  it('将真实 v41 工作区升级为收件人注册表并按首次入库回填编号', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v41-recipients-'));
    const sourceA1 = join(dataDirectory, '回填订单A1.png');
    const sourceA2 = join(dataDirectory, '回填订单A2.png');
    const sourceB1 = join(dataDirectory, '回填订单B1.png');
    const sourceC1 = join(dataDirectory, '回填订单C1.png');
    await writeFile(sourceA1, Buffer.from('v41-recipients-a1'));
    await writeFile(sourceA2, Buffer.from('v41-recipients-a2'));
    await writeFile(sourceB1, Buffer.from('v41-recipients-b1'));
    await writeFile(sourceC1, Buffer.from('v41-recipients-c1'));
    const recognitions = [
      recipientMigrationRecognition('XY-V42-A1', '迁移收件人甲', '13900000042'),
      recipientMigrationRecognition('XY-V42-A2', '迁移收件人甲', '13900000042'),
      recipientMigrationRecognition('XY-V42-B1', '迁移收件人乙', '13900000043'),
      recipientMigrationRecognition('XY-V42-C1', '迁移收件人丙', '13900000044'),
    ];
    const seeder = new LocalApplication({
      recognize: async () => {
        const result = recognitions.shift();
        if (!result) throw new Error('识别结果已用尽');
        return {
          result,
          evidences: [{
            provider: 'controlled',
            model: 'controlled',
            requestId: 'v41-recipients',
            schemaVersion: 1,
            rawResponse: '{}',
          }],
        };
      },
    });
    seeder.openDataDirectory(dataDirectory);
    const drafts = (await seeder.submitRecognitionBatch([
      sourceA1,
      sourceA2,
      sourceB1,
      sourceC1,
    ])).drafts;
    seeder.confirmDraft(drafts[0]);
    seeder.confirmDraft(drafts[1]);
    seeder.confirmDraft(drafts[2]);
    const orderC1 = seeder.confirmDraft(drafts[3]);
    seeder.close();

    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      // 丙订单缺少手机号，回填应跳过；自动建档派生行可随降级移除
      legacy.prepare(`
        UPDATE original_orders SET phone = '', phone_normalized = '' WHERE id = ?
      `).run(orderC1.id);
      removeVersion42ExtensionArtifacts(legacy);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 41 });
      expect(legacy.prepare(`
        SELECT name FROM sqlite_schema WHERE name = 'recipients'
      `).all()).toEqual([]);
    } finally {
      legacy.close();
    }

    const migrated = Workspace.open(dataDirectory);
    try {
      const recipients = migrated.database.prepare(`
        SELECT * FROM recipients ORDER BY recipient_number
      `).all() as Array<Record<string, string | number | null>>;
      expect(recipients).toHaveLength(2);
      expect(recipients[0]).toMatchObject({
        recipient_number: 1,
        name: '迁移收件人甲',
        phone_normalized: '13900000042',
        display_name: null,
        merged_into_recipient_id: null,
      });
      expect(recipients[1]).toMatchObject({
        recipient_number: 2,
        name: '迁移收件人乙',
        phone_normalized: '13900000043',
      });
      expect((migrated.database.prepare(
        'PRAGMA table_info(shipment_record_order_snapshots)',
      ).all() as Array<{ name: string }>).map(({ name }) => name))
        .toContain('readable_order_number');
      expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(() => migrated.database.prepare(`
        UPDATE recipients SET name = '篡改' WHERE id = ?
      `).run(recipients[0].id as string)).toThrow(/recipient identity is immutable/);
      expect(() => migrated.database.prepare(`
        UPDATE recipients SET recipient_number = 99 WHERE id = ?
      `).run(recipients[0].id as string)).toThrow(/recipient identity is immutable/);
      expect(migrated.database.prepare(
        'SELECT MAX(version) AS version FROM schema_migrations',
      ).get()).toEqual({ version: 50 });
    } finally {
      migrated.close();
    }
  });

  it('将真实 v38 字段与模板升级为支持发货组粒度并保持幂等', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v38-shipment-group-fields-'));
    const current = Workspace.open(dataDirectory);
    current.close();
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    try {
      removeVersion39ExtensionArtifacts(legacy);
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 38 });
      expect(() => legacy.prepare(`
        INSERT INTO custom_field_definitions (
          id, name, granularity, value_type, required,
          default_value_json, options_json, created_at, updated_at
        ) VALUES (
          'legacy-group-field', '旧发货组字段', 'shipment_group', 'text', 0,
          NULL, '[]', '2026-08-14T08:00:00.000Z', '2026-08-14T08:00:00.000Z'
        )
      `).run()).toThrow();
    } finally {
      legacy.close();
    }

    const application = new LocalApplication({
      recognize: async () => {
        throw new Error('迁移测试不应调用 OCR');
      },
    });
    application.openDataDirectory(dataDirectory);
    const definition = application.createCustomFieldDefinition({
      name: '拣货区域',
      granularity: 'shipment_group',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    const template = application.createTableTemplate({
      name: '迁移后的合并发货表',
      granularity: 'shipment_group',
      columns: [{
        field: { kind: 'custom', definitionId: definition.id },
        displayName: '拣货区',
      }],
      query: {},
    });
    application.close();

    const reopened = new LocalApplication({
      recognize: async () => {
        throw new Error('重启迁移测试不应调用 OCR');
      },
    });
    reopened.openDataDirectory(dataDirectory);
    try {
      expect(reopened.listCustomFieldDefinitions()
        .filter(({ granularity }) => granularity === 'shipment_group')).toEqual([definition]);
      expect(reopened.listTableTemplates('shipment_group')).toEqual([template]);
    } finally {
      reopened.close();
    }
    const verified = Workspace.open(dataDirectory);
    try {
      expect(verified.database.prepare(
        'SELECT MAX(version) AS version FROM schema_migrations',
      ).get()).toEqual({ version: 50 });
      expect(verified.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      verified.close();
    }
  });

  it('将 v36 退款事件升级为同时保留业务发生时间和录入时间', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v36-refund-occurred-at-'));
    const current = Workspace.open(dataDirectory);
    current.close();
    const databasePath = join(dataDirectory, 'xianyu-order-manager.sqlite3');
    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: false });
    try {
      removeVersion38ExtensionArtifacts(legacy);
      legacy.exec('PRAGMA foreign_keys = OFF;');
      legacy.exec(`
        DROP TRIGGER IF EXISTS pending_financial_item_events_require_occurred_at_on_insert;
        DROP TRIGGER IF EXISTS pending_financial_item_events_are_immutable_on_update;
        DROP TRIGGER IF EXISTS pending_financial_item_events_are_immutable_on_delete;
        DROP TABLE pending_financial_item_events;
        CREATE TABLE pending_financial_item_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          pending_item_id TEXT NOT NULL
            REFERENCES pending_financial_items(id) ON DELETE RESTRICT,
          kind TEXT NOT NULL CHECK (kind IN ('created', 'confirmed', 'cancelled')),
          requested_amount_cents INTEGER NOT NULL CHECK (requested_amount_cents > 0),
          actual_amount_cents INTEGER CHECK (actual_amount_cents > 0),
          reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
          created_at TEXT NOT NULL,
          CHECK (
            (kind = 'created' AND actual_amount_cents IS NULL)
            OR (kind = 'confirmed' AND actual_amount_cents IS NOT NULL)
            OR (kind = 'cancelled' AND actual_amount_cents IS NULL)
          )
        ) STRICT;
        INSERT INTO shipment_group_archives (
          id, source_group_id, status, recipient, phone, phone_normalized,
          address_original, address_normalized,
          member_order_ids_json, member_recipient_snapshots_json,
          total_quantity, created_at, fully_shipped_at, updated_at
        ) VALUES (
          'legacy-archive-v36', 'legacy-group-v36', 'fully_shipped', '迁移测试', '', '',
          '', '', '["legacy-order-v36"]',
          '[{"orderId":"legacy-order-v36","recipient":"迁移测试","phone":"","addressOriginal":""}]',
          1, '2026-08-13T02:00:00.000Z', '2026-08-13T02:00:00.000Z',
          '2026-08-13T02:00:00.000Z'
        );
        INSERT INTO shipment_records (
          id, source_group_id, recipient, phone, phone_normalized,
          address_original, address_normalized, created_at, shipment_group_archive_id
        ) VALUES (
          'legacy-shipment-v36', 'legacy-group-v36', '迁移测试', '', '',
          '', '', '2026-08-13T02:00:00.000Z', 'legacy-archive-v36'
        );
        INSERT INTO aftersales_cases (
          id, shipment_record_id, workflow, status, revision, reason,
          occurred_at, created_at, updated_at, handling_direction
        ) VALUES (
          'legacy-case-v36', 'legacy-shipment-v36', 'refund_only', 'cancelled', 1,
          '旧版退款测试', '2026-08-13T02:00:00.000Z',
          '2026-08-13T02:00:00.000Z', '2026-08-14T03:00:00.000Z', NULL
        );
        INSERT INTO pending_financial_items (
          id, kind, aftersales_case_id, requested_amount_cents,
          status, created_at, resolved_at
        ) VALUES (
          'pending-refund-v36', 'aftersales_refund', 'legacy-case-v36', 1000,
          'cancelled', '2026-08-13T02:00:00.000Z', '2026-08-14T03:00:00.000Z'
        );
        INSERT INTO pending_financial_item_events (
          id, pending_item_id, kind, requested_amount_cents,
          actual_amount_cents, reason, created_at
        ) VALUES (
          'refund-event-v36', 'pending-refund-v36', 'cancelled', 1000,
          NULL, '旧版仅保留录入时间', '2026-08-14T03:00:00.000Z'
        );
        DELETE FROM schema_migrations WHERE version = 37;
      `);
    } finally {
      legacy.close();
    }

    const migrated = Workspace.open(dataDirectory);
    try {
      expect(migrated.database.prepare(`
        SELECT occurred_at, created_at
        FROM pending_financial_item_events
        WHERE id = 'refund-event-v36'
      `).get()).toEqual({
        occurred_at: '2026-08-14T03:00:00.000Z',
        created_at: '2026-08-14T03:00:00.000Z',
      });
      expect(migrated.database.prepare(
        'SELECT MAX(version) AS version FROM schema_migrations',
      ).get()).toEqual({ version: 50 });
      expect(() => migrated.database.prepare(`
        INSERT INTO pending_financial_item_events (
          id, pending_item_id, kind, requested_amount_cents,
          actual_amount_cents, reason, occurred_at, created_at
        ) VALUES (
          'missing-occurred-at-v37', 'pending-refund-v36', 'cancelled', 1000,
          NULL, '不允许缺失业务时间', NULL, '2026-08-14T04:00:00.000Z'
        )
      `).run()).toThrow('pending financial item event occurred_at is required');
    } finally {
      migrated.close();
    }
  });

  it('将真实早期 v35 结构升级为完整正向异常协调事实', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v35-refund-reopening-'));
    const current = Workspace.open(dataDirectory);
    current.close();
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      downgradeVersion35ToOriginalSchema(database);
      expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 35 });
      expect(database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE name LIKE 'aftersales_refund_reopening_events%'
      `).all()).toEqual([]);
      expect(database.prepare(`
        SELECT name FROM pragma_table_info('aftersales_outbound_exception_decision_events')
        WHERE name = 'affected_items_json'
      `).get()).toBeUndefined();
      expect(database.prepare(`
        SELECT name FROM sqlite_schema WHERE name IN (
          'aftersales_interception_packages',
          'aftersales_outbound_exception_refund_links'
        )
      `).all()).toEqual([]);
    } finally {
      database.close();
    }

    const migrated = Workspace.open(dataDirectory);
    try {
      expect(migrated.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 50 });
      expect(migrated.database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE name IN (
          'aftersales_refund_reopening_events',
          'aftersales_refund_reopening_events_are_immutable_on_update',
          'aftersales_refund_reopening_events_are_immutable_on_delete'
        )
      `).all()).toHaveLength(3);
      expect(migrated.database.prepare(`
        SELECT name FROM pragma_table_info('aftersales_outbound_exception_decision_events')
        WHERE name = 'affected_items_json'
      `).get()).toEqual({ name: 'affected_items_json' });
      expect(migrated.database.prepare(`
        SELECT name FROM sqlite_schema WHERE name IN (
          'aftersales_interception_packages',
          'aftersales_outbound_exception_refund_links'
        )
      `).all()).toHaveLength(2);
      expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it('将真实 v34 数据库升级为不可变正向异常协调事实', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v34-outbound-coordination-'));
    const current = Workspace.open(dataDirectory);
    current.close();
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      removeVersion35ExtensionArtifacts(database);
      expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 34 });
    } finally {
      database.close();
    }

    const migrated = Workspace.open(dataDirectory);
    try {
      expect(migrated.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 50 });
      expect(migrated.database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE name IN (
          'aftersales_interception_packages',
          'aftersales_interception_package_identity_is_valid_on_insert',
          'aftersales_interception_packages_are_immutable_on_update',
          'aftersales_interception_packages_are_immutable_on_delete',
          'aftersales_refund_reopening_events',
          'aftersales_refund_reopening_events_are_immutable_on_update',
          'aftersales_refund_reopening_events_are_immutable_on_delete',
          'aftersales_outbound_exception_decision_events',
          'aftersales_outbound_exception_decisions_by_case',
          'aftersales_outbound_exception_decision_identity_is_valid_on_insert',
          'aftersales_outbound_exception_decisions_are_immutable_on_update',
          'aftersales_outbound_exception_decisions_are_immutable_on_delete',
          'aftersales_outbound_exception_refund_links',
          'aftersales_outbound_exception_refund_link_identity_is_valid_on_insert',
          'aftersales_outbound_exception_refund_links_are_immutable_on_update',
          'aftersales_outbound_exception_refund_links_are_immutable_on_delete',
          'aftersales_outbound_exception_replacement_rounds',
          'aftersales_outbound_exception_replacement_round_identity_is_valid_on_insert',
          'aftersales_outbound_exception_replacement_rounds_are_immutable_on_update',
          'aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete',
          'aftersales_intercepted_return_inspection_events',
          'aftersales_intercepted_return_inspections_by_case',
          'aftersales_intercepted_return_inspection_identity_is_valid_on_insert',
          'aftersales_intercepted_return_inspections_are_immutable_on_update',
          'aftersales_intercepted_return_inspections_are_immutable_on_delete'
        )
      `).all()).toHaveLength(25);
      expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it('将真实 v32 数据库升级为不可变退货异常选择事件', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v32-return-coordination-'));
    const current = Workspace.open(dataDirectory);
    current.close();
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      removeVersion33ExtensionArtifacts(database);
      expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 32 });
    } finally {
      database.close();
    }

    const migrated = Workspace.open(dataDirectory);
    try {
      expect(migrated.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 50 });
      expect(migrated.database.prepare(`
        SELECT name, type
        FROM sqlite_schema
        WHERE name IN (
          'aftersales_return_exception_decision_events',
          'aftersales_return_exception_decisions_by_case',
          'aftersales_return_exception_decision_identity_is_valid_on_insert',
          'aftersales_return_exception_decisions_are_immutable_on_update',
          'aftersales_return_exception_decisions_are_immutable_on_delete'
        )
        ORDER BY name
      `).all()).toHaveLength(5);
      expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      migrated.close();
    }

    const malformed = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      removeVersion33ExtensionArtifacts(malformed);
      malformed.exec(`
        CREATE TABLE aftersales_return_exception_decision_events (
          sequence INTEGER PRIMARY KEY,
          id TEXT NOT NULL,
          case_id TEXT NOT NULL,
          exception_id TEXT NOT NULL,
          return_record_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          before_decision TEXT,
          after_decision TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX aftersales_return_exception_decisions_by_case
        ON aftersales_return_exception_decision_events (case_id, exception_id, sequence);
        CREATE TRIGGER aftersales_return_exception_decision_identity_is_valid_on_insert
        BEFORE INSERT ON aftersales_return_exception_decision_events BEGIN SELECT 1; END;
        CREATE TRIGGER aftersales_return_exception_decisions_are_immutable_on_update
        BEFORE UPDATE ON aftersales_return_exception_decision_events BEGIN SELECT 1; END;
        CREATE TRIGGER aftersales_return_exception_decisions_are_immutable_on_delete
        BEFORE DELETE ON aftersales_return_exception_decision_events BEGIN SELECT 1; END;
      `);
    } finally {
      malformed.close();
    }
    expect(() => Workspace.open(dataDirectory))
      .toThrow('检测到不完整的 v33 退货异常协调结构');
  });

  it('拒绝对象齐全但关键约束和不可变触发器失效的伪 v33 结构', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v33-semantic-malformed-'));
    const current = Workspace.open(dataDirectory);
    current.close();
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      removeVersion33ExtensionArtifacts(database);
      database.exec(`
        CREATE TABLE aftersales_return_exception_decision_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL,
          case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
          exception_id TEXT NOT NULL REFERENCES logistics_exception_matters(id) ON DELETE RESTRICT,
          return_record_id TEXT NOT NULL REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
          kind TEXT NOT NULL CHECK (kind IN ('selected', 'changed')),
          before_decision TEXT CHECK (
            before_decision IS NULL OR before_decision IN (
              'wait_investigation', 'refund_in_advance', 'partial_refund',
              'reject_refund', 'negotiate'
            )
          ),
          after_decision TEXT NOT NULL CHECK (after_decision IN ('wait_investigation')),
          occurred_at TEXT NOT NULL,
          reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
          created_at TEXT NOT NULL,
          CHECK (
            (kind = 'selected' AND before_decision IS NULL)
            OR (kind = 'changed' AND before_decision IS NOT NULL
              AND before_decision <> after_decision)
          )
        ) STRICT;
        CREATE INDEX aftersales_return_exception_decisions_by_case
        ON aftersales_return_exception_decision_events (case_id, exception_id, sequence);
        CREATE TRIGGER aftersales_return_exception_decision_identity_is_valid_on_insert
        BEFORE INSERT ON aftersales_return_exception_decision_events
        WHEN 0 AND NOT EXISTS (
          SELECT 1 FROM logistics_exception_matters AS exceptions
          WHERE exceptions.id = NEW.exception_id
            AND json_extract(exceptions.impact_json, '$.scope') = 'package'
            AND EXISTS (
              SELECT 1 FROM aftersales_return_record_items AS case_items
              WHERE case_items.aftersales_case_id = NEW.case_id
                AND EXISTS (
                  SELECT 1 FROM json_each(exceptions.impact_json, '$.items')
                )
            )
        ) BEGIN
          SELECT RAISE(ABORT, 'return exception decision identity mismatch');
        END;
        CREATE TRIGGER aftersales_return_exception_decisions_are_immutable_on_update
        BEFORE UPDATE ON aftersales_return_exception_decision_events WHEN 0 BEGIN
          SELECT RAISE(ABORT, 'return exception decision events are immutable');
        END;
        CREATE TRIGGER aftersales_return_exception_decisions_are_immutable_on_delete
        BEFORE DELETE ON aftersales_return_exception_decision_events WHEN 0 BEGIN
          SELECT RAISE(ABORT, 'return exception decision events are immutable');
        END;
      `);
    } finally {
      database.close();
    }

    expect(() => Workspace.open(dataDirectory))
      .toThrow('检测到不完整的 v33 退货异常协调结构');
  });

  it('拒绝仅改变校验字符串大小写的伪 v33 结构', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v33-literal-case-'));
    const current = Workspace.open(dataDirectory);
    current.close();
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      const schema = database.prepare(`
        SELECT name, sql
        FROM sqlite_schema
        WHERE name IN (
          'aftersales_return_exception_decision_events',
          'aftersales_return_exception_decisions_by_case',
          'aftersales_return_exception_decision_identity_is_valid_on_insert',
          'aftersales_return_exception_decisions_are_immutable_on_update',
          'aftersales_return_exception_decisions_are_immutable_on_delete'
        )
        ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name
      `).all() as Array<{ name: string; sql: string }>;
      removeVersion33ExtensionArtifacts(database);
      database.exec(schema.map(({ name, sql }) => (
        name === 'aftersales_return_exception_decision_events'
          ? sql.replaceAll("'selected'", "'SELECTED'")
            .replaceAll("'changed'", "'CHANGED'")
          : sql
      )).join(';\n'));
    } finally {
      database.close();
    }

    expect(() => Workspace.open(dataDirectory))
      .toThrow('检测到不完整的 v33 退货异常协调结构');
  });

  it('将带关联数据的 v1 数据库完整、幂等地升级到 v33 并保留来源、字段与模板约束', async () => {
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
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 },
      { version: 21 },
      { version: 22 },
      { version: 23 },
      { version: 24 },
      { version: 25 },
      { version: 26 },
      { version: 27 },
      { version: 28 },
      { version: 29 },
      { version: 30 },
      { version: 31 },
      { version: 32 },
      { version: 33 },
      { version: 34 },
      { version: 35 },
      { version: 36 },
      { version: 37 },
      { version: 38 },
      { version: 39 },
      { version: 40 },
      { version: 41 },
      { version: 42 },
      { version: 43 },
      { version: 44 },
      { version: 45 },
      { version: 46 },
      { version: 47 },
      { version: 48 },
      { version: 49 },
      { version: 50 },
    ]);
    first.database.exec('SAVEPOINT verify_fulfillment_v25;');
    try {
      first.database.prepare(`
        UPDATE original_orders
        SET fulfillment_status = 'partially_shipped'
        WHERE id = 'order-v1'
      `).run();
      first.database.prepare(`
        INSERT INTO order_change_events (
          id, order_id, source_snapshot_id, source,
          base_revision, result_revision, created_at
        ) VALUES (
          'event-v25-shipment-sync', 'order-v1', NULL, 'shipment_sync',
          1, 2, '2026-08-13T00:00:00.000Z'
        )
      `).run();
      expect(first.database.prepare(`
        SELECT fulfillment_status
        FROM original_orders
        WHERE id = 'order-v1'
      `).get()).toEqual({ fulfillment_status: 'partially_shipped' });
      expect(first.database.prepare(`
        SELECT source
        FROM order_change_events
        WHERE id = 'event-v25-shipment-sync'
      `).get()).toEqual({ source: 'shipment_sync' });
    } finally {
      first.database.exec('ROLLBACK TO verify_fulfillment_v25; RELEASE verify_fulfillment_v25;');
    }
    expect(
      first.database
        .prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'custom_field_definitions',
              'custom_field_values',
              'aftersales_case_events',
              'aftersales_case_items',
              'aftersales_cases',
              'aftersales_return_record_events',
              'aftersales_return_record_items',
              'aftersales_return_records',
              'aftersales_return_exception_decision_events',
              'carrier_claim_events',
              'carrier_claims',
              'carrier_compensation_records',
              'table_templates',
              'table_template_custom_field_dependencies',
              'financial_records',
              'pending_financial_item_events',
              'pending_financial_items',
              'shipment_group_adjustment_events',
              'shipment_group_archives',
              'shipment_package_cancellation_events',
              'shipment_package_items',
              'shipment_package_logistics_change_events',
              'shipment_package_logistics_status_events',
              'shipment_packages',
              'shipment_record_order_snapshots',
              'shipment_record_void_events',
              'shipment_records'
            )
          ORDER BY name
        `)
        .all(),
    ).toEqual([
      { name: 'aftersales_case_events' },
      { name: 'aftersales_case_items' },
      { name: 'aftersales_cases' },
      { name: 'aftersales_return_exception_decision_events' },
      { name: 'aftersales_return_record_events' },
      { name: 'aftersales_return_record_items' },
      { name: 'aftersales_return_records' },
      { name: 'carrier_claim_events' },
      { name: 'carrier_claims' },
      { name: 'carrier_compensation_records' },
      { name: 'custom_field_definitions' },
      { name: 'custom_field_values' },
      { name: 'financial_records' },
      { name: 'pending_financial_item_events' },
      { name: 'pending_financial_items' },
      { name: 'shipment_group_adjustment_events' },
      { name: 'shipment_group_archives' },
      { name: 'shipment_package_cancellation_events' },
      { name: 'shipment_package_items' },
      { name: 'shipment_package_logistics_change_events' },
      { name: 'shipment_package_logistics_status_events' },
      { name: 'shipment_packages' },
      { name: 'shipment_record_order_snapshots' },
      { name: 'shipment_record_void_events' },
      { name: 'shipment_records' },
      { name: 'table_template_custom_field_dependencies' },
      { name: 'table_templates' },
    ]);
    first.database.prepare(`
      INSERT INTO shipment_group_adjustment_events (
        id, operation, reason,
        source_group_ids_json, source_order_ids_json,
        target_group_id, target_order_ids_json,
        selected_recipient_order_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'adjustment-v17',
      'split',
      '迁移不可变测试',
      '["group-v17"]',
      '["order-v1"]',
      'manual-group-v17',
      '["order-v1"]',
      null,
      '2026-08-11T00:00:00.000Z',
    );
    expect(() => first.database.prepare(`
      UPDATE shipment_group_adjustment_events
      SET reason = '被篡改'
      WHERE id = 'adjustment-v17'
    `).run()).toThrow(/immutable|不可变/u);
    expect(() => first.database.prepare(`
      DELETE FROM shipment_group_adjustment_events
      WHERE id = 'adjustment-v17'
    `).run()).toThrow(/immutable|不可变/u);
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
      2,
      '{"columns":[],"query":{}}',
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
        'template-invalid-json-v9', '错误模板', '错误模板', 'order', 2,
        '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
      )
    `).run()).toThrow();
    expect(() => first.database.prepare(`
      INSERT INTO table_templates (
        id, name, name_key, granularity, configuration_version,
        configuration_json, created_at, updated_at
      ) VALUES (
        'template-duplicate-v9', '订单跟单表（重名）', '订单跟单表', 'order', 2,
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
    expect(first.database.prepare(`
      SELECT quantity_source FROM draft_items WHERE id = 'draft-item-v1'
    `).get()).toEqual({ quantity_source: 'system_default_1' });
    expect(first.database.prepare(`
      SELECT quantity_source FROM order_items WHERE id = 'order-item-v1'
    `).get()).toEqual({ quantity_source: 'system_default_1' });
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
    for (const status of [
      'pending_shipment', 'partially_shipped', 'shipped', 'delivered', 'unknown',
    ]) {
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
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 },
      { version: 21 },
      { version: 22 },
      { version: 23 },
      { version: 24 },
      { version: 25 },
      { version: 26 },
      { version: 27 },
      { version: 28 },
      { version: 29 },
      { version: 30 },
      { version: 31 },
      { version: 32 },
      { version: 33 },
      { version: 34 },
      { version: 35 },
      { version: 36 },
      { version: 37 },
      { version: 38 },
      { version: 39 },
      { version: 40 },
      { version: 41 },
      { version: 42 },
      { version: 43 },
      { version: 44 },
      { version: 45 },
      { version: 46 },
      { version: 47 },
      { version: 48 },
      { version: 49 },
      { version: 50 },
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
    expect(reopened.database.prepare(`
      SELECT id, quantity_source FROM draft_items WHERE id = 'draft-item-v1'
    `).get()).toEqual({
      id: 'draft-item-v1',
      quantity_source: 'system_default_1',
    });
    expect(reopened.database.prepare(`
      SELECT id, quantity_source FROM order_items WHERE id = 'order-item-v1'
    `).get()).toEqual({
      id: 'order-item-v1',
      quantity_source: 'system_default_1',
    });
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
      configuration_version: 2,
      configuration_json: '{"columns":[],"query":{}}',
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

  it('将 v1 历史 inferred=false 幂等迁移为来源不明的已明确数量', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-quantity-source-migration-'));
    createVersion1Database(dataDirectory);
    const legacy = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      legacy.exec(`
        UPDATE draft_items SET quantity_inferred = 0 WHERE id = 'draft-item-v1';
        UPDATE order_items SET quantity_inferred = 0 WHERE id = 'order-item-v1';
      `);
      const snapshot = legacy.prepare(`
        SELECT recognition_json FROM order_drafts WHERE id = 'draft-v1'
      `).get() as { recognition_json: string };
      const recognition = JSON.parse(snapshot.recognition_json) as {
        items: Array<{ quantityInferred: boolean }>;
      };
      recognition.items[0].quantityInferred = false;
      const serialized = JSON.stringify(recognition);
      legacy.prepare(`
        UPDATE order_drafts SET recognition_json = ? WHERE id = 'draft-v1'
      `).run(serialized);
      legacy.prepare(`
        UPDATE source_snapshots
        SET recognition_json = ?, confirmed_json = ?
        WHERE id = 'snapshot-v1'
      `).run(serialized, serialized);
    } finally {
      legacy.close();
    }

    const workspace = Workspace.open(dataDirectory);
    expect(workspace.database.prepare(`
      SELECT quantity_source FROM draft_items WHERE id = 'draft-item-v1'
    `).get()).toEqual({ quantity_source: 'legacy_explicit_or_manual' });
    expect(workspace.database.prepare(`
      SELECT quantity_source FROM order_items WHERE id = 'order-item-v1'
    `).get()).toEqual({ quantity_source: 'legacy_explicit_or_manual' });
    expect(workspace.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    workspace.close();

    const reopened = Workspace.open(dataDirectory);
    expect(reopened.database.prepare(`
      SELECT id, quantity_source FROM draft_items WHERE id = 'draft-item-v1'
    `).get()).toEqual({
      id: 'draft-item-v1',
      quantity_source: 'legacy_explicit_or_manual',
    });
    expect(reopened.database.prepare(`
      SELECT id, quantity_source FROM order_items WHERE id = 'order-item-v1'
    `).get()).toEqual({
      id: 'order-item-v1',
      quantity_source: 'legacy_explicit_or_manual',
    });
    expect(reopened.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(reopened.database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    reopened.close();

    const application = new LocalApplication({
      recognize: async () => {
        throw new Error('该测试不应发起识别');
      },
    });
    application.openDataDirectory(dataDirectory);
    expect(application.getDraft('draft-v1').items[0]).toMatchObject({
      quantity: 1,
      quantitySource: 'legacy_explicit_or_manual',
    });
    const migratedOrder = application.getOrder('order-v1');
    expect(migratedOrder.order.items[0]).toMatchObject({
      quantity: 1,
      quantitySource: 'legacy_explicit_or_manual',
    });
    expect(migratedOrder.sourceSnapshot).toMatchObject({
      recognition: {
        items: [{ quantitySource: 'legacy_explicit_or_manual' }],
      },
      confirmed: {
        items: [{ quantitySource: 'legacy_explicit_or_manual' }],
      },
    });
    application.close();
  });

  it('将带商品自定义字段值的 v9 数据库升级到 v10 时保留数量来源、标识与外键', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v9-quantity-source-migration-'));
    createVersion9QuantitySourceDatabase(dataDirectory);

    const legacy = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
      enableForeignKeyConstraints: true,
    });
    try {
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 9 });
      expect(legacy.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      legacy.close();
    }

    const workspace = Workspace.open(dataDirectory);
    try {
      expect(
        workspace.database
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
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 },
        { version: 15 },
        { version: 16 },
        { version: 17 },
        { version: 18 },
        { version: 19 },
        { version: 20 },
        { version: 21 },
        { version: 22 },
        { version: 23 },
        { version: 24 },
        { version: 25 },
        { version: 26 },
        { version: 27 },
        { version: 28 },
        { version: 29 },
        { version: 30 },
        { version: 31 },
        { version: 32 },
        { version: 33 },
        { version: 34 },
        { version: 35 },
        { version: 36 },
        { version: 37 },
        { version: 38 },
        { version: 39 },
        { version: 40 },
        { version: 41 },
        { version: 42 },
        { version: 43 },
        { version: 44 },
        { version: 45 },
        { version: 46 },
        { version: 47 },
        { version: 48 },
        { version: 49 },
        { version: 50 },
      ]);
      expect(workspace.database.prepare(`
        SELECT id, draft_id, position, quantity, unit_price_present, quantity_source
        FROM draft_items
        WHERE id IN ('draft-item-v1', 'draft-item-explicit-v9')
        ORDER BY position
      `).all()).toEqual([
        {
          id: 'draft-item-v1',
          draft_id: 'draft-v1',
          position: 0,
          quantity: 1,
          unit_price_present: 1,
          quantity_source: 'system_default_1',
        },
        {
          id: 'draft-item-explicit-v9',
          draft_id: 'draft-v1',
          position: 1,
          quantity: 3,
          unit_price_present: 1,
          quantity_source: 'legacy_explicit_or_manual',
        },
      ]);
      expect(workspace.database.prepare(`
        SELECT id, order_id, position, quantity, quantity_source, subtotal_cents
        FROM order_items
        WHERE id IN ('order-item-v1', 'order-item-explicit-v9')
        ORDER BY position
      `).all()).toEqual([
        {
          id: 'order-item-v1',
          order_id: 'order-v1',
          position: 0,
          quantity: 1,
          quantity_source: 'system_default_1',
          subtotal_cents: 880,
        },
        {
          id: 'order-item-explicit-v9',
          order_id: 'order-v1',
          position: 1,
          quantity: 3,
          quantity_source: 'legacy_explicit_or_manual',
          subtotal_cents: 1980,
        },
      ]);
      expect(workspace.database.prepare(`
        SELECT id, definition_id, order_id, order_item_id, value_json, created_at, updated_at
        FROM custom_field_values
        WHERE id = 'value-item-v9'
      `).get()).toEqual({
        id: 'value-item-v9',
        definition_id: 'field-item-v9',
        order_id: null,
        order_item_id: 'order-item-explicit-v9',
        value_json: '"易碎品"',
        created_at: '2026-07-30T00:00:00.000Z',
        updated_at: '2026-07-30T00:00:00.000Z',
      });
      expect(
        (
          workspace.database.prepare('PRAGMA foreign_key_list(custom_field_values)').all() as unknown as Array<{
            table: string;
            from: string;
            to: string;
            on_delete: string;
          }>
        ).filter((foreignKey) => foreignKey.from === 'order_item_id'),
      ).toMatchObject([{
        table: 'order_items',
        from: 'order_item_id',
        to: 'id',
        on_delete: 'CASCADE',
      }]);
      expect(workspace.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(workspace.database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(() => workspace.database.prepare(`
        UPDATE draft_items
        SET quantity_source = 'unknown'
        WHERE id = 'draft-item-v1'
      `).run()).toThrow();
      expect(() => workspace.database.prepare(`
        UPDATE order_items
        SET quantity_source = 'unknown'
        WHERE id = 'order-item-v1'
      `).run()).toThrow();
    } finally {
      workspace.close();
    }
  });

  it('将 v10 旧商品摘要原位迁移为动态列组并在重启后保持幂等', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v10-product-group-'));
    createVersion1Database(dataDirectory);
    const prepared = Workspace.open(dataDirectory);
    prepared.close();
    downgradeTableTemplatesToVersion10(dataDirectory);
    seedVersion10ProductSummaryTemplates(dataDirectory);

    let recognitionCalls = 0;
    const application = new LocalApplication({
      recognize: async () => {
        recognitionCalls += 1;
        throw new Error('表格模板升级不应调用 OCR');
      },
    });
    application.openDataDirectory(dataDirectory);
    const migrated = application.listTableTemplates();

    expect(migrated).toMatchObject([
      {
        id: 'template-summary-v10',
        name: '历史拣货表',
        granularity: 'order',
        columns: [
          { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
          {
            kind: 'dynamic_product_group',
            labels: { product: '货品', specification: '款式或规格', quantity: '数量' },
          },
          { field: { kind: 'custom', definitionId: 'field-order-v10' }, displayName: '跟单备注' },
        ],
        query: {
          productText: '旧商品第二款',
          sortField: 'product',
          sortDirection: 'asc',
          customFieldFilter: { definitionId: 'field-order-v10', value: '加急' },
          customFieldSort: { definitionId: 'field-order-v10', direction: 'desc' },
        },
        createdAt: '2026-07-30T01:00:00.000Z',
        updatedAt: '2026-07-30T02:00:00.000Z',
      },
      {
        id: 'template-no-summary-v10',
        columns: [
          { field: { kind: 'builtin', key: 'order_number' }, displayName: '平台单号' },
        ],
      },
      {
        id: 'template-item-v10',
        granularity: 'order_item',
        columns: [
          { field: { kind: 'builtin', key: 'product_title' }, displayName: '我的原始商品' },
        ],
      },
      {
        id: 'template-default-summary-v10',
        granularity: 'order',
        columns: [{
          kind: 'dynamic_product_group',
          labels: { product: '商品', specification: '款式或规格', quantity: '数量' },
        }],
      },
      {
        id: 'template-conflicting-summary-v10',
        granularity: 'order',
        columns: [{
          kind: 'dynamic_product_group',
          labels: { product: '数量', specification: '款式或规格', quantity: '数量' },
        }],
      },
    ]);
    const filteredOrders = application.queryOrders({ productText: '旧商品第二款' }).orders;
    expect(filteredOrders[0]?.items)
      .toEqual([
        {
          sourceTitle: '旧商品', sourceSpec: '旧规格', quantity: 1, standardProduct: null,
          standardDisplayPreference: null,
        },
        {
          sourceTitle: '旧商品第二款', sourceSpec: '蓝色', quantity: 2,
          standardProduct: null,
          standardDisplayPreference: null,
        },
      ]);
    const conflictingTemplate = migrated.find(({ id }) => (
      id === 'template-conflicting-summary-v10'
    ));
    if (!conflictingTemplate || conflictingTemplate.granularity !== 'order') {
      throw new Error('缺少已迁移的冲突模板');
    }
    expect(() => createOrderTableProjectionPlan(
      conflictingTemplate.columns,
      filteredOrders,
    )).toThrow(/表头“数量1”.*冲突.*请修改/u);
    expect(recognitionCalls).toBe(0);
    application.close();

    const reopened = new LocalApplication({
      recognize: async () => {
        recognitionCalls += 1;
        throw new Error('重启读取模板不应调用 OCR');
      },
    });
    reopened.openDataDirectory(dataDirectory);
    expect(reopened.listTableTemplates()).toEqual(migrated);
    expect(recognitionCalls).toBe(0);
    reopened.close();

    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
      enableForeignKeyConstraints: true,
    });
    try {
      expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 50 });
      expect(database.prepare(`
        SELECT configuration_version, created_at, updated_at
        FROM table_templates
        WHERE id = 'template-summary-v10'
      `).get()).toEqual({
        configuration_version: 2,
        created_at: '2026-07-30T01:00:00.000Z',
        updated_at: '2026-07-30T02:00:00.000Z',
      });
      expect(database.prepare(`
        SELECT definition_id, usage
        FROM table_template_custom_field_dependencies
        WHERE template_id = 'template-summary-v10'
        ORDER BY usage
      `).all()).toEqual([
        { definition_id: 'field-order-v10', usage: 'column' },
        { definition_id: 'field-order-v10', usage: 'filter' },
        { definition_id: 'field-order-v10', usage: 'sort' },
      ]);
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('v11 迁移在重建表后发现外键损坏时整体回滚', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v11-template-rollback-'));
    createVersion1Database(dataDirectory);
    const prepared = Workspace.open(dataDirectory);
    prepared.close();
    downgradeTableTemplatesToVersion10(dataDirectory);

    const corrupted = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      corrupted.exec('PRAGMA foreign_keys = OFF;');
      corrupted.prepare(`
        INSERT INTO table_template_custom_field_dependencies (
          template_id, definition_id, usage
        ) VALUES (?, ?, ?)
      `).run('missing-template', 'missing-definition', 'column');
    } finally {
      corrupted.close();
    }

    expect(() => Workspace.open(dataDirectory)).toThrow(/外键完整性检查失败/u);

    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      expect(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 10 });
      const table = database.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'table_templates'
      `).get() as { sql: string };
      expect(table.sql).toMatch(/configuration_version = 1/u);
      expect(database.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger'
          AND name IN (
            'table_template_dependencies_match_granularity_on_insert',
            'table_template_dependencies_match_granularity_on_update',
            'table_templates_prevent_granularity_change_with_dependencies',
            'custom_field_definitions_keep_template_granularity_on_update'
          )
        ORDER BY name
      `).all()).toEqual([
        { name: 'custom_field_definitions_keep_template_granularity_on_update' },
        { name: 'table_template_dependencies_match_granularity_on_insert' },
        { name: 'table_template_dependencies_match_granularity_on_update' },
        { name: 'table_templates_prevent_granularity_change_with_dependencies' },
      ]);
      expect(database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'table_templates_v11'
      `).get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('将 v11 既有订单升级到 v12 时补充空备注、保留订单数据并在重启后保持幂等', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v11-note-migration-'));
    createVersion1Database(dataDirectory);
    const prepared = Workspace.open(dataDirectory);
    prepared.close();
    downgradeOriginalOrdersToVersion11(dataDirectory);

    const legacy = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
      enableForeignKeyConstraints: true,
    });
    try {
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 11 });
      const columns = legacy.prepare('PRAGMA table_info(original_orders)').all() as unknown as Array<{
        name: string;
      }>;
      expect(columns.map(({ name }) => name)).not.toContain('note');
      expect(legacy.prepare(`
        SELECT id, platform_order_number, recipient, amount_cents
        FROM original_orders
        WHERE id = 'order-v1'
      `).get()).toEqual({
        id: 'order-v1',
        platform_order_number: 'XY-V1-001',
        recipient: '旧收件人',
        amount_cents: 880,
      });
    } finally {
      legacy.close();
    }

    const migrated = Workspace.open(dataDirectory);
    try {
      expect(migrated.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 50 });
      expect(migrated.database.prepare(`
        SELECT id, platform_order_number, recipient, amount_cents, note
        FROM original_orders
        WHERE id = 'order-v1'
      `).get()).toEqual({
        id: 'order-v1',
        platform_order_number: 'XY-V1-001',
        recipient: '旧收件人',
        amount_cents: 880,
        note: '',
      });
      expect(migrated.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      migrated.close();
    }

    const reopened = Workspace.open(dataDirectory);
    try {
      expect(reopened.database.prepare(
        'SELECT version FROM schema_migrations WHERE version IN (12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40) ORDER BY version',
      ).all()).toEqual([
        { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 },
        { version: 17 }, { version: 18 }, { version: 19 }, { version: 20 }, { version: 21 },
        { version: 22 }, { version: 23 }, { version: 24 }, { version: 25 }, { version: 26 },
        { version: 27 }, { version: 28 }, { version: 29 }, { version: 30 }, { version: 31 },
        { version: 32 },
        { version: 33 },
        { version: 34 },
        { version: 35 },
        { version: 36 },
        { version: 37 },
        { version: 38 },
        { version: 39 },
        { version: 40 },
      ]);
      expect(reopened.database.prepare(
        "SELECT note FROM original_orders WHERE id = 'order-v1'",
      ).get()).toEqual({ note: '' });
    } finally {
      reopened.close();
    }
  });

  it('将 v12 订单草稿升级到 v13 时补充空识别冲突并约束为 JSON 数组', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v12-conflicts-migration-'));
    createVersion1Database(dataDirectory);
    const prepared = Workspace.open(dataDirectory);
    prepared.close();
    downgradeOrderDraftsToVersion12(dataDirectory);

    const legacy = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
      enableForeignKeyConstraints: true,
    });
    try {
      expect(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 12 });
      const columns = legacy.prepare('PRAGMA table_info(order_drafts)').all() as unknown as Array<{
        name: string;
      }>;
      expect(columns.map(({ name }) => name)).not.toContain('recognition_conflicts_json');
    } finally {
      legacy.close();
    }

    const migrated = Workspace.open(dataDirectory);
    try {
      expect(migrated.database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 50 });
      const columns = migrated.database
        .prepare('PRAGMA table_info(order_drafts)')
        .all() as unknown as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }>;
      expect(columns.filter(({ name }) => name === 'recognition_conflicts_json')).toMatchObject([{
        name: 'recognition_conflicts_json',
        type: 'TEXT',
        notnull: 1,
        dflt_value: "'[]'",
      }]);
      expect(migrated.database.prepare(`
        SELECT recognition_conflicts_json
        FROM order_drafts
        WHERE id = 'draft-v1'
      `).get()).toEqual({ recognition_conflicts_json: '[]' });
      expect(() => migrated.database.prepare(`
        UPDATE order_drafts
        SET recognition_conflicts_json = '{}'
        WHERE id = 'draft-v1'
      `).run()).toThrow();
      expect(() => migrated.database.prepare(`
        UPDATE order_drafts
        SET recognition_conflicts_json = 'not-json'
        WHERE id = 'draft-v1'
      `).run()).toThrow();
    } finally {
      migrated.close();
    }

    const reopened = Workspace.open(dataDirectory);
    try {
      expect(reopened.database.prepare(
        'SELECT version FROM schema_migrations WHERE version = 13',
      ).all()).toEqual([{ version: 13 }]);
      expect(reopened.database.prepare(`
        SELECT recognition_conflicts_json
        FROM order_drafts
        WHERE id = 'draft-v1'
      `).get()).toEqual({ recognition_conflicts_json: '[]' });
    } finally {
      reopened.close();
    }
  });

  it('新工作区建立不可变的候选裁决运行与逐项记录', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-v14-adjudication-audit-'));
    const workspace = Workspace.open(dataDirectory);
    try {
      expect(workspace.database.prepare(
        'SELECT version FROM schema_migrations WHERE version = 14',
      ).get()).toEqual({ version: 14 });
      const tables = workspace.database.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'candidate_adjudication_runs',
          'candidate_adjudication_decisions'
        )
        ORDER BY name
      `).all();
      expect(tables).toEqual([
        { name: 'candidate_adjudication_decisions' },
        { name: 'candidate_adjudication_runs' },
      ]);
      const runColumns = workspace.database
        .prepare('PRAGMA table_info(candidate_adjudication_runs)')
        .all() as unknown as Array<{ name: string }>;
      expect(runColumns.map(({ name }) => name)).not.toContain('raw_response');
      expect(runColumns.map(({ name }) => name)).not.toContain('request_id');

      workspace.database.prepare(`
        INSERT INTO recognition_batches (
          id, platform, seller_account, status, created_at
        ) VALUES (
          'batch-v14', 'xianyu', '默认闲鱼账号', 'awaiting_review',
          '2026-08-01T00:00:00.000Z'
        )
      `).run();
      workspace.database.prepare(`
        INSERT INTO source_screenshots (
          id, batch_id, original_name, relative_path,
          content_sha256, mime_type, created_at
        ) VALUES (
          'screenshot-v14', 'batch-v14', '候选裁决.png', 'screenshots/v14.png',
          'sha-v14', 'image/png', '2026-08-01T00:00:00.000Z'
        )
      `).run();
      workspace.database.prepare(`
        INSERT INTO order_drafts (
          id, batch_id, screenshot_id, platform, seller_account,
          order_number, buyer_nickname, recipient, phone,
          address_original, amount_cents, platform_transaction_status,
          fulfillment_status, status, recognition_json, created_at
        ) VALUES (
          'draft-v14', 'batch-v14', 'screenshot-v14', 'xianyu',
          '默认闲鱼账号', 'XY-V14-0001', '', '', '', '', 0,
          'unknown', 'unknown', 'awaiting_review', '{}',
          '2026-08-01T00:00:00.000Z'
        )
      `).run();
      workspace.database.prepare(`
        INSERT INTO candidate_adjudication_runs (
          id, screenshot_id, draft_id, provider, model,
          status, failure_code, failure_message, created_at
        ) VALUES (
          'run-v14', 'screenshot-v14', 'draft-v14', 'deepseek',
          'deepseek-v4-flash', 'succeeded', NULL, NULL,
          '2026-08-01T00:00:00.001Z'
        )
      `).run();
      workspace.database.prepare(`
        INSERT INTO candidate_adjudication_decisions (
          run_id, position, ambiguity_id, region, field, item_index,
          candidates_json, selected_candidate_id, context_lines_json,
          outcome, failure_code
        ) VALUES (
          'run-v14', 0, 'ambiguity-1', 'shipping_information', 'phone', NULL,
          '[{"candidateId":"candidate-1","displayText":"候选一"}]',
          'candidate-1', '[{"lineId":"line-1","text":"候选一","left":0,"top":0,"right":10,"bottom":10}]', 'selected', NULL
        )
      `).run();

      expect(() => workspace.database.prepare(`
        UPDATE candidate_adjudication_runs
        SET model = 'changed'
        WHERE id = 'run-v14'
      `).run()).toThrow(/immutable|不可变/u);
      expect(() => workspace.database.prepare(`
        DELETE FROM candidate_adjudication_decisions
        WHERE run_id = 'run-v14'
      `).run()).toThrow(/immutable|不可变/u);
    } finally {
      workspace.close();
    }
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

function downgradeTableTemplatesToVersion10(dataDirectory: string): void {
  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
    enableForeignKeyConstraints: true,
  });
  try {
    const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number };
    if (version.version < 11) return;
    removeVersion31ExtensionArtifacts(database);
    const triggerRows = database.prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'table_template_dependencies_match_granularity_on_insert',
          'table_template_dependencies_match_granularity_on_update',
          'table_templates_prevent_granularity_change_with_dependencies',
          'custom_field_definitions_keep_template_granularity_on_update'
        )
      ORDER BY name
    `).all() as unknown as Array<{ name: string; sql: string }>;
    database.exec('PRAGMA foreign_keys = OFF;');
    database.exec('BEGIN IMMEDIATE;');
    try {
      for (const trigger of triggerRows) {
        database.exec(`DROP TRIGGER ${trigger.name};`);
      }
      database.exec(`
        CREATE TABLE table_templates_v10_fixture (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          granularity TEXT NOT NULL CHECK (granularity IN ('order', 'order_item')),
          configuration_version INTEGER NOT NULL DEFAULT 1
            CHECK (configuration_version = 1),
          configuration_json TEXT NOT NULL CHECK (
            json_valid(configuration_json)
            AND json_type(configuration_json) = 'object'
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (granularity, name_key)
        ) STRICT;
        DROP TABLE table_templates;
        ALTER TABLE table_templates_v10_fixture RENAME TO table_templates;
        ALTER TABLE original_orders DROP COLUMN note;
        ALTER TABLE original_orders DROP COLUMN shipping_carrier;
        ALTER TABLE original_orders DROP COLUMN tracking_number;
        ALTER TABLE order_drafts DROP COLUMN recognition_conflicts_json;
        DROP TABLE IF EXISTS candidate_adjudication_decisions;
        DROP TABLE IF EXISTS candidate_adjudication_runs;
        DROP TABLE IF EXISTS aftersales_case_events;
        DROP TABLE IF EXISTS aftersales_case_items;
        DROP TABLE IF EXISTS aftersales_cases;
        DROP TABLE IF EXISTS shipment_package_logistics_change_events;
        DROP TABLE IF EXISTS shipment_record_void_events;
        DROP TABLE IF EXISTS shipment_package_cancellation_events;
        DROP TABLE IF EXISTS shipment_package_items;
        DROP TABLE IF EXISTS shipment_record_order_snapshots;
        DROP TABLE IF EXISTS shipment_packages;
        DROP TABLE IF EXISTS shipment_records;
        DROP TABLE IF EXISTS shipment_group_archives;
        DROP TABLE IF EXISTS shipment_group_adjustment_events;
        DELETE FROM schema_migrations WHERE version IN (11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
      `);
      for (const trigger of triggerRows) database.exec(trigger.sql);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    } finally {
      database.exec('PRAGMA foreign_keys = ON;');
    }
  } finally {
    database.close();
  }
}

function downgradeOriginalOrdersToVersion11(dataDirectory: string): void {
  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
    enableForeignKeyConstraints: true,
  });
  try {
    removeVersion31ExtensionArtifacts(database);
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE original_orders DROP COLUMN note;
      ALTER TABLE original_orders DROP COLUMN shipping_carrier;
      ALTER TABLE original_orders DROP COLUMN tracking_number;
      ALTER TABLE order_drafts DROP COLUMN recognition_conflicts_json;
      DROP TABLE IF EXISTS candidate_adjudication_decisions;
      DROP TABLE IF EXISTS candidate_adjudication_runs;
      DROP TABLE IF EXISTS aftersales_case_events;
      DROP TABLE IF EXISTS aftersales_case_items;
      DROP TABLE IF EXISTS aftersales_cases;
      DROP TABLE IF EXISTS shipment_package_logistics_change_events;
      DROP TABLE IF EXISTS shipment_record_void_events;
      DROP TABLE IF EXISTS shipment_package_cancellation_events;
      DROP TABLE IF EXISTS shipment_package_items;
      DROP TABLE IF EXISTS shipment_record_order_snapshots;
      DROP TABLE IF EXISTS shipment_packages;
      DROP TABLE IF EXISTS shipment_records;
      DROP TABLE IF EXISTS shipment_group_archives;
      DROP TABLE IF EXISTS shipment_group_adjustment_events;
      DELETE FROM schema_migrations WHERE version IN (12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
      COMMIT;
    `);
  } finally {
    database.close();
  }
}

function downgradeOrderDraftsToVersion12(dataDirectory: string): void {
  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
    enableForeignKeyConstraints: true,
  });
  try {
    removeVersion31ExtensionArtifacts(database);
    const columns = database.prepare('PRAGMA table_info(order_drafts)').all() as unknown as Array<{
      name: string;
    }>;
    database.exec('BEGIN IMMEDIATE;');
    if (columns.some(({ name }) => name === 'recognition_conflicts_json')) {
      database.exec('ALTER TABLE order_drafts DROP COLUMN recognition_conflicts_json;');
    }
    database.exec(`
      ALTER TABLE original_orders DROP COLUMN shipping_carrier;
      ALTER TABLE original_orders DROP COLUMN tracking_number;
      DROP TABLE IF EXISTS candidate_adjudication_decisions;
      DROP TABLE IF EXISTS candidate_adjudication_runs;
      DROP TABLE IF EXISTS aftersales_case_events;
      DROP TABLE IF EXISTS aftersales_case_items;
      DROP TABLE IF EXISTS aftersales_cases;
      DROP TABLE IF EXISTS shipment_package_logistics_change_events;
      DROP TABLE IF EXISTS shipment_record_void_events;
      DROP TABLE IF EXISTS shipment_package_cancellation_events;
      DROP TABLE IF EXISTS shipment_package_items;
      DROP TABLE IF EXISTS shipment_record_order_snapshots;
      DROP TABLE IF EXISTS shipment_packages;
      DROP TABLE IF EXISTS shipment_records;
      DROP TABLE IF EXISTS shipment_group_archives;
      DROP TABLE IF EXISTS shipment_group_adjustment_events;
      DELETE FROM schema_migrations WHERE version IN (13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
      COMMIT;
    `);
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

function seedVersion10ProductSummaryTemplates(dataDirectory: string): void {
  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
    enableForeignKeyConstraints: true,
  });
  try {
    database.exec(`
      INSERT INTO order_items (
        id, order_id, position, source_title, source_spec,
        unit_price_cents, quantity, quantity_source, subtotal_cents
      ) VALUES (
        'order-item-second-v10', 'order-v1', 1, '旧商品第二款', '蓝色',
        440, 2, 'legacy_explicit_or_manual', 880
      );

      INSERT INTO custom_field_definitions (
        id, name, granularity, value_type, required,
        default_value_json, options_json, created_at, updated_at
      ) VALUES (
        'field-order-v10', '跟单备注', 'order', 'text', 0,
        NULL, '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
      );
    `);
    const insertTemplate = database.prepare(`
      INSERT INTO table_templates (
        id, name, name_key, granularity, configuration_version,
        configuration_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `);
    insertTemplate.run(
      'template-summary-v10',
      '历史拣货表',
      '历史拣货表',
      'order',
      JSON.stringify({
        columns: [
          { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
          { field: { kind: 'builtin', key: 'product_summary' }, displayName: '货品' },
          { field: { kind: 'custom', definitionId: 'field-order-v10' }, displayName: '跟单备注' },
        ],
        query: {
          productText: '旧商品第二款',
          sortField: 'product',
          sortDirection: 'asc',
          customFieldFilter: { definitionId: 'field-order-v10', value: '加急' },
          customFieldSort: { definitionId: 'field-order-v10', direction: 'desc' },
        },
      }),
      '2026-07-30T01:00:00.000Z',
      '2026-07-30T02:00:00.000Z',
    );
    insertTemplate.run(
      'template-no-summary-v10',
      '无商品列',
      '无商品列',
      'order',
      JSON.stringify({
        columns: [
          { field: { kind: 'builtin', key: 'order_number' }, displayName: '平台单号' },
        ],
        query: {},
      }),
      '2026-07-30T03:00:00.000Z',
      '2026-07-30T03:00:00.000Z',
    );
    insertTemplate.run(
      'template-item-v10',
      '商品明细',
      '商品明细',
      'order_item',
      JSON.stringify({
        columns: [
          { field: { kind: 'builtin', key: 'product_title' }, displayName: '我的原始商品' },
        ],
        query: {},
      }),
      '2026-07-30T04:00:00.000Z',
      '2026-07-30T04:00:00.000Z',
    );
    insertTemplate.run(
      'template-default-summary-v10',
      '旧默认商品列',
      '旧默认商品列',
      'order',
      JSON.stringify({
        columns: [
          { field: { kind: 'builtin', key: 'product_summary' }, displayName: '商品摘要' },
        ],
        query: {},
      }),
      '2026-07-30T05:00:00.000Z',
      '2026-07-30T05:00:00.000Z',
    );
    insertTemplate.run(
      'template-conflicting-summary-v10',
      '旧冲突商品列',
      '旧冲突商品列',
      'order',
      JSON.stringify({
        columns: [
          { field: { kind: 'builtin', key: 'product_summary' }, displayName: '数量' },
        ],
        query: {},
      }),
      '2026-07-30T06:00:00.000Z',
      '2026-07-30T06:00:00.000Z',
    );
    const insertDependency = database.prepare(`
      INSERT INTO table_template_custom_field_dependencies (
        template_id, definition_id, usage
      ) VALUES (?, ?, ?)
    `);
    insertDependency.run('template-summary-v10', 'field-order-v10', 'column');
    insertDependency.run('template-summary-v10', 'field-order-v10', 'filter');
    insertDependency.run('template-summary-v10', 'field-order-v10', 'sort');
  } finally {
    database.close();
  }
}

function createVersion9QuantitySourceDatabase(dataDirectory: string): void {
  createVersion1Database(dataDirectory);
  const current = Workspace.open(dataDirectory);
  current.close();

  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'), {
    enableForeignKeyConstraints: true,
  });
  try {
    removeVersion31ExtensionArtifacts(database);
    database.exec('PRAGMA foreign_keys = OFF;');
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.exec(`
        CREATE TABLE draft_items_v9_fixture (
          id TEXT PRIMARY KEY,
          draft_id TEXT NOT NULL REFERENCES order_drafts(id) ON DELETE CASCADE,
          position INTEGER NOT NULL CHECK (position >= 0),
          source_title TEXT NOT NULL,
          source_spec TEXT NOT NULL,
          unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          quantity_inferred INTEGER NOT NULL CHECK (quantity_inferred IN (0, 1)),
          unit_price_present INTEGER NOT NULL DEFAULT 1
            CHECK (unit_price_present IN (0, 1)),
          UNIQUE (draft_id, position)
        ) STRICT;

        INSERT INTO draft_items_v9_fixture (
          id, draft_id, position, source_title, source_spec,
          unit_price_cents, quantity, quantity_inferred, unit_price_present
        )
        SELECT
          id, draft_id, position, source_title, source_spec,
          unit_price_cents, quantity,
          CASE quantity_source WHEN 'system_default_1' THEN 1 ELSE 0 END,
          unit_price_present
        FROM draft_items;

        CREATE TABLE order_items_v9_fixture (
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

        INSERT INTO order_items_v9_fixture (
          id, order_id, position, source_title, source_spec,
          unit_price_cents, quantity, quantity_inferred, subtotal_cents
        )
        SELECT
          id, order_id, position, source_title, source_spec,
          unit_price_cents, quantity,
          CASE quantity_source WHEN 'system_default_1' THEN 1 ELSE 0 END,
          subtotal_cents
        FROM order_items;

        DROP TABLE draft_items;
        ALTER TABLE draft_items_v9_fixture RENAME TO draft_items;
        DROP TABLE order_items;
        ALTER TABLE order_items_v9_fixture RENAME TO order_items;
        ALTER TABLE original_orders DROP COLUMN note;
        ALTER TABLE original_orders DROP COLUMN shipping_carrier;
        ALTER TABLE original_orders DROP COLUMN tracking_number;
        ALTER TABLE order_drafts DROP COLUMN recognition_conflicts_json;
        DROP TABLE IF EXISTS candidate_adjudication_decisions;
        DROP TABLE IF EXISTS candidate_adjudication_runs;
        DROP TABLE IF EXISTS aftersales_case_events;
        DROP TABLE IF EXISTS aftersales_case_items;
        DROP TABLE IF EXISTS aftersales_cases;
        DROP TABLE IF EXISTS shipment_package_logistics_change_events;
        DROP TABLE IF EXISTS shipment_record_void_events;
        DROP TABLE IF EXISTS shipment_package_cancellation_events;
        DROP TABLE IF EXISTS shipment_package_items;
        DROP TABLE IF EXISTS shipment_record_order_snapshots;
        DROP TABLE IF EXISTS shipment_packages;
        DROP TABLE IF EXISTS shipment_records;
        DROP TABLE IF EXISTS shipment_group_archives;
        DROP TABLE IF EXISTS shipment_group_adjustment_events;
        DELETE FROM schema_migrations WHERE version IN (10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31);
      `);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    } finally {
      database.exec('PRAGMA foreign_keys = ON;');
    }

    database.exec(`
      INSERT INTO draft_items (
        id, draft_id, position, source_title, source_spec,
        unit_price_cents, quantity, quantity_inferred, unit_price_present
      ) VALUES (
        'draft-item-explicit-v9', 'draft-v1', 1, '旧版明确数量商品', '旧版规格',
        660, 3, 0, 1
      );

      INSERT INTO order_items (
        id, order_id, position, source_title, source_spec,
        unit_price_cents, quantity, quantity_inferred, subtotal_cents
      ) VALUES (
        'order-item-explicit-v9', 'order-v1', 1, '旧版明确数量商品', '旧版规格',
        660, 3, 0, 1980
      );

      INSERT INTO custom_field_definitions (
        id, name, granularity, value_type, required,
        default_value_json, options_json, created_at, updated_at
      ) VALUES (
        'field-item-v9', '商品备注', 'order_item', 'text', 0,
        NULL, '[]', '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z'
      );
    `);
    database.prepare(`
      INSERT INTO custom_field_values (
        id, definition_id, order_id, order_item_id,
        value_json, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'value-item-v9',
      'field-item-v9',
      'order-item-explicit-v9',
      JSON.stringify('易碎品'),
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:00:00.000Z',
    );
  } finally {
    database.close();
  }
}

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
