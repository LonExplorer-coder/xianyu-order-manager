import type { DatabaseSync } from 'node:sqlite';

// v54 建立不可变库存流水表；存在流水数据时拒绝降级。
export function removeVersion54ExtensionArtifacts(database: DatabaseSync): void {
  const applied = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 54',
  ).get();
  if (!applied) return;
  const movementCount = database.prepare(`
    SELECT COUNT(*) AS count FROM inventory_movements
  `).get() as { count: number };
  if (movementCount.count > 0) {
    throw new Error('v54 测试降级前必须移除库存流水数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS inventory_movements_are_immutable_on_update;
    DROP TRIGGER IF EXISTS inventory_movements_are_immutable_on_delete;
    DROP TABLE inventory_movements;
    DELETE FROM schema_migrations WHERE version = 54;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// v53 增加团购成团事实与采购建议风险确认列，并重建事件表加入 formed 类型；
// 存在成团数据时拒绝降级。
export function removeVersion53ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion54ExtensionArtifacts(database);
  const planColumns = database.prepare(
    'PRAGMA table_info(fulfillment_plans)',
  ).all() as Array<{ name: string }>;
  const hasFormedAt = planColumns.some(({ name }) => name === 'formed_at');
  const suggestionColumns = database.prepare(
    'PRAGMA table_info(purchase_suggestions)',
  ).all() as Array<{ name: string }>;
  const hasRiskColumn = suggestionColumns.some(({ name }) => name === 'risk_acknowledged_at');
  const eventTypeRows = database.prepare(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'fulfillment_plan_events'
  `).all() as Array<{ sql: string | null }>;
  const eventsHaveFormed = eventTypeRows.length > 0
    && eventTypeRows[0].sql !== null
    && eventTypeRows[0].sql!.includes("'formed'");
  if (!hasFormedAt && !hasRiskColumn && !eventsHaveFormed) return;
  const formedPlans = database.prepare(`
    SELECT COUNT(*) AS count FROM fulfillment_plans WHERE formed_at IS NOT NULL
  `).get() as { count: number };
  const formedEvents = database.prepare(`
    SELECT COUNT(*) AS count FROM fulfillment_plan_events WHERE event_type = 'formed'
  `).get() as { count: number };
  if (formedPlans.count > 0 || formedEvents.count > 0) {
    throw new Error('v53 测试降级前必须移除团购成团数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS fulfillment_plan_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS fulfillment_plan_events_are_immutable_on_delete;
    ALTER TABLE fulfillment_plan_events RENAME TO fulfillment_plan_events_v53;
    CREATE TABLE fulfillment_plan_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      plan_id TEXT NOT NULL REFERENCES fulfillment_plans(id) ON DELETE RESTRICT,
      order_id TEXT REFERENCES original_orders(id) ON DELETE RESTRICT,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'created', 'orders_added', 'order_removed', 'orders_released',
        'updated', 'delayed', 'closed'
      )),
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
      ),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO fulfillment_plan_events (
      sequence, id, plan_id, order_id, event_type, reason, payload_json,
      occurred_at, created_at
    )
    SELECT sequence, id, plan_id, order_id, event_type, reason, payload_json,
      occurred_at, created_at
    FROM fulfillment_plan_events_v53;
    DROP TABLE fulfillment_plan_events_v53;
    CREATE INDEX fulfillment_plan_events_by_plan
    ON fulfillment_plan_events (plan_id, sequence);
    CREATE TRIGGER fulfillment_plan_events_are_immutable_on_update
    BEFORE UPDATE ON fulfillment_plan_events
    BEGIN
      SELECT RAISE(ABORT, 'fulfillment plan events are immutable');
    END;
    CREATE TRIGGER fulfillment_plan_events_are_immutable_on_delete
    BEFORE DELETE ON fulfillment_plan_events
    BEGIN
      SELECT RAISE(ABORT, 'fulfillment plan events are immutable');
    END;
    ALTER TABLE fulfillment_plans DROP COLUMN formed_at;
    ALTER TABLE purchase_suggestions DROP COLUMN risk_acknowledged_at;
    DELETE FROM schema_migrations WHERE version = 53;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// v51 建立流程步骤事件表；存在事件数据时拒绝降级。
export function removeVersion51ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion52ExtensionArtifacts(database);
  const applied = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 51',
  ).get();
  if (!applied) return;
  const hasTable = database.prepare(`
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'aftersales_case_step_events'
  `).get();
  if (hasTable) {
    const eventCount = database.prepare(
      'SELECT COUNT(*) AS count FROM aftersales_case_step_events',
    ).get() as { count: number };
    if (eventCount.count > 0) {
      throw new Error('v51 测试降级前必须移除流程步骤事件数据');
    }
  }
  database.exec(`
    BEGIN IMMEDIATE;
    DROP TABLE IF EXISTS aftersales_case_step_events;
    DELETE FROM schema_migrations WHERE version = 51;
    COMMIT;
  `);
}

// v50 只规范化模板版本数据，没有结构产物；存在「需要检查」步骤时拒绝降级。
export function removeVersion50ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion51ExtensionArtifacts(database);
  const applied = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 50',
  ).get();
  if (!applied) return;
  const rows = database.prepare(`
    SELECT template_id, version, definition_json
    FROM aftersales_workflow_template_versions
  `).all() as Array<{ template_id: string; version: number; definition_json: string }>;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.definition_json);
    } catch {
      continue;
    }
    const steps = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { steps?: unknown }).steps
      : null;
    if (!Array.isArray(steps)) continue;
    if (steps.some((step) => (
      step
      && typeof step === 'object'
      && !Array.isArray(step)
      && (step as { kind?: unknown }).kind === null
    ))) {
      throw new Error('v50 测试降级前必须先移除需要检查的流程步骤');
    }
  }
  database.exec(`
    BEGIN IMMEDIATE;
    DELETE FROM schema_migrations WHERE version = 50;
    COMMIT;
  `);
}

export function removeVersion49ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion50ExtensionArtifacts(database);
  const hasAdjustmentTable = database.prepare(`
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'aftersales_refund_target_adjustment_events'
  `).get();
  if (!hasAdjustmentTable) return;
  for (const [table, label] of [
    ['aftersales_refund_target_adjustment_events', '退款目标调整'],
    ['aftersales_refund_ending_events', '结束退款'],
  ] as const) {
    const eventCount = database.prepare(
      `SELECT COUNT(*) AS count FROM ${table}`,
    ).get() as { count: number };
    if (eventCount.count > 0) {
      throw new Error(`v49 测试降级前必须移除${label}事件数据`);
    }
  }
  const endedCount = database.prepare(`
    SELECT COUNT(*) AS count FROM pending_financial_items WHERE status = 'ended'
  `).get() as { count: number };
  if (endedCount.count > 0) {
    throw new Error('v49 测试降级前必须移除已结束的退款事项');
  }
  const multiRecordCount = database.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT pending_item_id
      FROM financial_records
      GROUP BY pending_item_id
      HAVING COUNT(*) > 1
    )
  `).get() as { count: number };
  if (multiRecordCount.count > 0) {
    throw new Error('v49 测试降级前必须移除多笔实际退款数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS aftersales_refund_target_adjustment_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_refund_target_adjustment_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS aftersales_refund_target_adjustment_events_by_item;
    DROP TABLE aftersales_refund_target_adjustment_events;
    DROP TRIGGER IF EXISTS aftersales_refund_ending_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_refund_ending_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS aftersales_refund_ending_events_by_item;
    DROP TABLE aftersales_refund_ending_events;

    CREATE TABLE pending_financial_items_v48 (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind = 'aftersales_refund'),
      aftersales_case_id TEXT NOT NULL UNIQUE
        REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      requested_amount_cents INTEGER NOT NULL CHECK (requested_amount_cents > 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      CHECK (
        (status = 'pending' AND resolved_at IS NULL)
        OR (status IN ('confirmed', 'cancelled') AND resolved_at IS NOT NULL)
      )
    ) STRICT;
    INSERT INTO pending_financial_items_v48 (
      id, kind, aftersales_case_id, requested_amount_cents, status, created_at, resolved_at
    )
    SELECT id, kind, aftersales_case_id, requested_amount_cents, status, created_at, resolved_at
    FROM pending_financial_items;
    DROP TABLE pending_financial_items;
    ALTER TABLE pending_financial_items_v48 RENAME TO pending_financial_items;

    DROP TRIGGER aftersales_outbound_exception_refund_link_identity_is_valid_on_insert;
    DROP TRIGGER financial_records_are_immutable_on_update;
    DROP TRIGGER financial_records_are_immutable_on_delete;
    DROP INDEX financial_records_by_pending_item;
    CREATE TABLE financial_records_v48 (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind = 'aftersales_refund'),
      pending_item_id TEXT NOT NULL UNIQUE
        REFERENCES pending_financial_items(id) ON DELETE RESTRICT,
      aftersales_case_id TEXT NOT NULL
        REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      occurred_at TEXT NOT NULL,
      note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO financial_records_v48 (
      id, kind, pending_item_id, aftersales_case_id, amount_cents, occurred_at, note, created_at
    )
    SELECT id, kind, pending_item_id, aftersales_case_id, amount_cents, occurred_at, note, created_at
    FROM financial_records;
    DROP TABLE financial_records;
    ALTER TABLE financial_records_v48 RENAME TO financial_records;
    CREATE TRIGGER financial_records_are_immutable_on_update
    BEFORE UPDATE ON financial_records
    BEGIN
      SELECT RAISE(ABORT, 'financial records are immutable');
    END;
    CREATE TRIGGER financial_records_are_immutable_on_delete
    BEFORE DELETE ON financial_records
    BEGIN
      SELECT RAISE(ABORT, 'financial records are immutable');
    END;
    CREATE TRIGGER aftersales_outbound_exception_refund_link_identity_is_valid_on_insert
    BEFORE INSERT ON aftersales_outbound_exception_refund_links
    WHEN NOT EXISTS (
      SELECT 1
      FROM financial_records AS financial
      JOIN aftersales_outbound_exception_decision_events AS decision
        ON decision.id = NEW.decision_event_id
      WHERE financial.id = NEW.financial_record_id
        AND financial.aftersales_case_id = decision.case_id
        AND decision.after_decision IN ('refund_only', 'refund_and_replacement')
    ) BEGIN
      SELECT RAISE(ABORT, 'outbound exception refund link identity mismatch');
    END;
    DELETE FROM schema_migrations WHERE version = 49;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion48ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion49ExtensionArtifacts(database);
  const hasTable = database.prepare(`
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'product_identity_correction_events'
  `).get();
  if (!hasTable) return;
  const eventCount = database.prepare(
    'SELECT COUNT(*) AS count FROM product_identity_correction_events',
  ).get() as { count: number };
  if (eventCount.count > 0) {
    throw new Error('v48 测试降级前必须移除商品身份更正事件数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS product_identity_correction_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS product_identity_correction_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS product_identity_correction_events_by_correction;
    DROP INDEX IF EXISTS product_identity_correction_events_by_mapping;
    DROP TABLE product_identity_correction_events;
    DELETE FROM schema_migrations WHERE version = 48;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion47ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion48ExtensionArtifacts(database);
  const hasStatusColumn = database.prepare(`
    SELECT 1 FROM pragma_table_info('product_mappings') WHERE name = 'status'
  `).get();
  if (!hasStatusColumn) return;
  const eventCount = database.prepare(
    'SELECT COUNT(*) AS count FROM product_mapping_events',
  ).get() as { count: number };
  if (eventCount.count > 0) {
    throw new Error('v47 测试降级前必须移除映射变更留痕数据');
  }
  const trackedCount = database.prepare(`
    SELECT COUNT(*) AS count FROM product_mappings
    WHERE status <> 'active' OR origin <> 'confirmation' OR last_used_at IS NOT NULL
  `).get() as { count: number };
  if (trackedCount.count > 0) {
    throw new Error('v47 测试降级前必须移除映射状态与使用追踪数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS product_mapping_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS product_mapping_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS product_mapping_events_by_mapping;
    DROP TABLE product_mapping_events;
    DROP INDEX product_mappings_one_per_account_source;
    DROP INDEX product_mappings_one_per_platform_source;
    DROP INDEX product_mappings_one_per_workspace_source;
    ALTER TABLE product_mappings DROP COLUMN status;
    ALTER TABLE product_mappings DROP COLUMN origin;
    ALTER TABLE product_mappings DROP COLUMN last_used_at;
    CREATE UNIQUE INDEX product_mappings_one_per_account_source
    ON product_mappings (platform, seller_account, source_title_key, source_spec_key)
    WHERE scope = 'current_account';
    CREATE UNIQUE INDEX product_mappings_one_per_platform_source
    ON product_mappings (platform, source_title_key, source_spec_key)
    WHERE scope = 'current_platform';
    CREATE UNIQUE INDEX product_mappings_one_per_workspace_source
    ON product_mappings (source_title_key, source_spec_key)
    WHERE scope = 'workspace';
    DELETE FROM schema_migrations WHERE version = 47;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion46ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion47ExtensionArtifacts(database);
  const hasScopeColumn = database.prepare(`
    SELECT 1 FROM pragma_table_info('product_mappings') WHERE name = 'scope'
  `).get();
  if (!hasScopeColumn) return;
  const narrowedCount = database.prepare(`
    SELECT COUNT(*) AS count FROM product_mappings WHERE scope <> 'workspace'
  `).get() as { count: number };
  if (narrowedCount.count > 0) {
    throw new Error('v46 测试降级前必须移除非工作区级映射数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP INDEX IF EXISTS product_mappings_one_per_account_source;
    DROP INDEX IF EXISTS product_mappings_one_per_platform_source;
    DROP INDEX IF EXISTS product_mappings_one_per_workspace_source;
    CREATE TABLE product_mappings_v45_fixture (
      id TEXT PRIMARY KEY,
      source_title TEXT NOT NULL CHECK (length(trim(source_title)) BETWEEN 1 AND 300),
      source_spec TEXT NOT NULL CHECK (length(source_spec) <= 300),
      source_title_key TEXT NOT NULL CHECK (length(trim(source_title_key)) BETWEEN 1 AND 300),
      source_spec_key TEXT NOT NULL CHECK (length(source_spec_key) <= 300),
      standard_product_id TEXT NOT NULL
        REFERENCES standard_products(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (source_title_key, source_spec_key)
    ) STRICT;
    INSERT INTO product_mappings_v45_fixture (
      id, source_title, source_spec, source_title_key, source_spec_key,
      standard_product_id, created_at, updated_at
    )
    SELECT
      id, source_title, source_spec, source_title_key, source_spec_key,
      standard_product_id, created_at, updated_at
    FROM product_mappings;
    DROP TABLE product_mappings;
    ALTER TABLE product_mappings_v45_fixture RENAME TO product_mappings;
    CREATE INDEX product_mappings_by_standard_product
    ON product_mappings (standard_product_id, source_title_key, source_spec_key);
    DELETE FROM schema_migrations WHERE version = 46;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion45ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion46ExtensionArtifacts(database);
  const hasEventsTable = database.prepare(`
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'order_item_standardization_batch_events'
  `).get();
  if (!hasEventsTable) return;
  const eventCount = database.prepare(
    'SELECT COUNT(*) AS count FROM order_item_standardization_batch_events',
  ).get() as { count: number };
  if (eventCount.count > 0) {
    throw new Error('v45 测试降级前必须移除批量关联留痕数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS order_item_standardization_batch_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS order_item_standardization_batch_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS order_item_standardization_batch_events_by_batch;
    DROP TABLE order_item_standardization_batch_events;
    DELETE FROM schema_migrations WHERE version = 45;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion44ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion45ExtensionArtifacts(database);
  const hasPreferenceColumn = database.prepare(`
    SELECT 1 FROM pragma_table_info('order_items') WHERE name = 'standard_display_preference'
  `).get();
  if (!hasPreferenceColumn) return;
  const preferenceCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM order_items
    WHERE standard_display_preference IS NOT NULL
  `).get() as { count: number };
  if (preferenceCount.count > 0) {
    throw new Error('v44 测试降级前必须移除标准商品显示偏好数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS order_items_standard_display_preference_is_consistent_on_insert;
    DROP TRIGGER IF EXISTS order_items_standard_display_preference_is_consistent_on_update;
    ALTER TABLE order_items DROP COLUMN standard_display_preference;
    DELETE FROM schema_migrations WHERE version = 44;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion43ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion44ExtensionArtifacts(database);
  const hasEventsTable = database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'standard_product_price_events'
  `).get();
  if (!hasEventsTable) return;
  const eventCount = database.prepare(
    'SELECT COUNT(*) AS count FROM standard_product_price_events',
  ).get() as { count: number };
  const pricedCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM standard_products
    WHERE default_order_price_cents IS NOT NULL
  `).get() as { count: number };
  if (eventCount.count > 0 || pricedCount.count > 0) {
    throw new Error('v43 测试降级前必须移除默认订单单价数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS standard_product_price_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS standard_product_price_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS standard_product_price_events_by_product;
    DROP TABLE standard_product_price_events;
    ALTER TABLE standard_products DROP COLUMN default_order_price_cents;
    DELETE FROM schema_migrations WHERE version = 43;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion42ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion43ExtensionArtifacts(database);
  const hasRecipientsTable = database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'recipients'
  `).get();
  if (!hasRecipientsTable) return;
  const mergedCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM recipients
    WHERE merged_into_recipient_id IS NOT NULL OR display_name IS NOT NULL
  `).get() as { count: number };
  if (mergedCount.count > 0) {
    throw new Error('v42 测试降级前必须移除收件人合并数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS recipients_identity_is_immutable_on_update;
    DELETE FROM recipients;
    DROP TABLE recipients;
    ALTER TABLE shipment_record_order_snapshots DROP COLUMN readable_order_number;
    DELETE FROM schema_migrations WHERE version = 42;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion52ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion53ExtensionArtifacts(database);
  const hasDemandTables = database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'purchase_suggestions'
  `).get();
  const planColumns = database.prepare(
    'PRAGMA table_info(fulfillment_plans)',
  ).all() as Array<{ name: string }>;
  const hasThresholdColumn = planColumns.some(({ name }) => name === 'demand_alert_threshold');
  if (!hasDemandTables && !hasThresholdColumn) return;
  const refundCount = database.prepare(`
    SELECT COUNT(*) AS count FROM fulfillment_refund_events
  `).get() as { count: number };
  const suggestionCount = database.prepare(`
    SELECT COUNT(*) AS count FROM purchase_suggestions
  `).get() as { count: number };
  if (refundCount.count > 0 || suggestionCount.count > 0) {
    throw new Error('v52 测试降级前必须移除发货前退款与采购建议数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS purchase_suggestion_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS purchase_suggestion_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS fulfillment_refund_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS fulfillment_refund_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS purchase_suggestion_events_by_plan;
    DROP INDEX IF EXISTS purchase_suggestion_events_by_suggestion;
    DROP INDEX IF EXISTS purchase_suggestions_by_plan;
    DROP INDEX IF EXISTS purchase_suggestions_by_product;
    DROP INDEX IF EXISTS fulfillment_refund_events_by_plan;
    DROP TABLE purchase_suggestion_events;
    DROP TABLE purchase_suggestions;
    DROP TABLE fulfillment_refund_events;
    ALTER TABLE fulfillment_plans DROP COLUMN demand_alert_threshold;
    DELETE FROM schema_migrations WHERE version = 52;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion41ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion42ExtensionArtifacts(database);
  const hasPlansTable = database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'fulfillment_plans'
  `).get();
  if (!hasPlansTable) return;
  const planCount = database.prepare('SELECT COUNT(*) AS count FROM fulfillment_plans')
    .get() as { count: number };
  const memberCount = database.prepare('SELECT COUNT(*) AS count FROM fulfillment_plan_members')
    .get() as { count: number };
  const eventCount = database.prepare('SELECT COUNT(*) AS count FROM fulfillment_plan_events')
    .get() as { count: number };
  if (planCount.count > 0 || memberCount.count > 0 || eventCount.count > 0) {
    throw new Error('v41 测试降级前必须移除履约计划数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS fulfillment_plan_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS fulfillment_plan_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS fulfillment_plan_events_by_plan;
    DROP INDEX IF EXISTS fulfillment_plan_members_by_plan;
    DROP INDEX IF EXISTS fulfillment_plan_members_one_active_per_order;
    DROP TABLE fulfillment_plan_events;
    DROP TABLE fulfillment_plan_members;
    DROP TABLE fulfillment_plans;
    DELETE FROM schema_migrations WHERE version = 41;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion40ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion41ExtensionArtifacts(database);
  const productCount = database.prepare('SELECT COUNT(*) AS count FROM standard_products')
    .get() as { count: number };
  const mappingCount = database.prepare('SELECT COUNT(*) AS count FROM product_mappings')
    .get() as { count: number };
  const standardizedItemCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM order_items
    WHERE standard_product_id IS NOT NULL OR standardization_source IS NOT NULL
  `).get() as { count: number };
  if (productCount.count > 0 || mappingCount.count > 0 || standardizedItemCount.count > 0) {
    throw new Error('v40 测试降级前必须移除标准商品与映射数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS order_items_standardization_is_consistent_on_insert;
    DROP TRIGGER IF EXISTS order_items_standardization_is_consistent_on_update;
    DROP INDEX IF EXISTS order_items_by_standard_product;
    ALTER TABLE order_items DROP COLUMN standardization_source;
    ALTER TABLE order_items DROP COLUMN standard_product_id;
    DROP INDEX IF EXISTS product_mappings_by_standard_product;
    DROP TABLE product_mappings;
    DROP TABLE standard_products;
    DELETE FROM schema_migrations WHERE version = 40;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion39ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion40ExtensionArtifacts(database);
  const groupDefinitionCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM custom_field_definitions
    WHERE granularity = 'shipment_group'
  `).get() as { count: number };
  const groupTemplateCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM table_templates
    WHERE granularity = 'shipment_group'
  `).get() as { count: number };
  if (groupDefinitionCount.count > 0 || groupTemplateCount.count > 0) {
    throw new Error('v39 测试降级前必须移除发货组字段与模板数据');
  }

  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS shipment_group_custom_field_values_match_definition_on_insert;
    DROP TRIGGER IF EXISTS shipment_group_custom_field_values_match_definition_on_update;
    DROP INDEX IF EXISTS shipment_group_custom_field_values_by_group;
    DROP TABLE IF EXISTS shipment_group_custom_field_values;

    DROP TRIGGER IF EXISTS custom_field_definitions_keep_template_granularity_on_update;
    DROP TRIGGER IF EXISTS table_templates_prevent_granularity_change_with_dependencies;
    DROP TRIGGER IF EXISTS table_template_dependencies_match_granularity_on_insert;
    DROP TRIGGER IF EXISTS table_template_dependencies_match_granularity_on_update;
    DROP TRIGGER IF EXISTS custom_field_values_owner_matches_definition_on_insert;
    DROP TRIGGER IF EXISTS custom_field_values_owner_matches_definition_on_update;

    CREATE TABLE custom_field_definitions_v38_fixture (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      granularity TEXT NOT NULL CHECK (granularity IN ('order', 'order_item')),
      value_type TEXT NOT NULL CHECK (value_type IN (
        'text', 'number', 'money', 'datetime',
        'single_select', 'multi_select', 'checkbox'
      )),
      required INTEGER NOT NULL CHECK (required IN (0, 1)),
      default_value_json TEXT CHECK (
        default_value_json IS NULL OR json_valid(default_value_json)
      ),
      options_json TEXT NOT NULL CHECK (
        json_valid(options_json) AND json_type(options_json) = 'array'
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (granularity, name)
    ) STRICT;
    INSERT INTO custom_field_definitions_v38_fixture
    SELECT * FROM custom_field_definitions;

    CREATE TABLE table_templates_v38_fixture (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      granularity TEXT NOT NULL CHECK (granularity IN ('order', 'order_item')),
      configuration_version INTEGER NOT NULL DEFAULT 2
        CHECK (configuration_version = 2),
      configuration_json TEXT NOT NULL CHECK (
        json_valid(configuration_json) AND json_type(configuration_json) = 'object'
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (granularity, name_key)
    ) STRICT;
    INSERT INTO table_templates_v38_fixture
    SELECT * FROM table_templates;

    DROP TABLE table_templates;
    ALTER TABLE table_templates_v38_fixture RENAME TO table_templates;
    DROP TABLE custom_field_definitions;
    ALTER TABLE custom_field_definitions_v38_fixture RENAME TO custom_field_definitions;

    CREATE TRIGGER custom_field_values_owner_matches_definition_on_insert
    BEFORE INSERT ON custom_field_values
    WHEN EXISTS (
      SELECT 1 FROM custom_field_definitions AS definitions
      WHERE definitions.id = NEW.definition_id
        AND NOT (
          (definitions.granularity = 'order'
            AND NEW.order_id IS NOT NULL AND NEW.order_item_id IS NULL)
          OR
          (definitions.granularity = 'order_item'
            AND NEW.order_id IS NULL AND NEW.order_item_id IS NOT NULL)
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'custom field granularity does not match value owner');
    END;
    CREATE TRIGGER custom_field_values_owner_matches_definition_on_update
    BEFORE UPDATE ON custom_field_values
    WHEN EXISTS (
      SELECT 1 FROM custom_field_definitions AS definitions
      WHERE definitions.id = NEW.definition_id
        AND NOT (
          (definitions.granularity = 'order'
            AND NEW.order_id IS NOT NULL AND NEW.order_item_id IS NULL)
          OR
          (definitions.granularity = 'order_item'
            AND NEW.order_id IS NULL AND NEW.order_item_id IS NOT NULL)
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'custom field granularity does not match value owner');
    END;
    CREATE TRIGGER table_template_dependencies_match_granularity_on_insert
    BEFORE INSERT ON table_template_custom_field_dependencies
    WHEN EXISTS (
      SELECT 1 FROM table_templates AS templates
      JOIN custom_field_definitions AS definitions
        ON definitions.id = NEW.definition_id
      WHERE templates.id = NEW.template_id
        AND templates.granularity <> definitions.granularity
    )
    BEGIN
      SELECT RAISE(ABORT, 'table template and custom field granularities do not match');
    END;
    CREATE TRIGGER table_template_dependencies_match_granularity_on_update
    BEFORE UPDATE ON table_template_custom_field_dependencies
    WHEN EXISTS (
      SELECT 1 FROM table_templates AS templates
      JOIN custom_field_definitions AS definitions
        ON definitions.id = NEW.definition_id
      WHERE templates.id = NEW.template_id
        AND templates.granularity <> definitions.granularity
    )
    BEGIN
      SELECT RAISE(ABORT, 'table template and custom field granularities do not match');
    END;
    CREATE TRIGGER table_templates_prevent_granularity_change_with_dependencies
    BEFORE UPDATE OF granularity ON table_templates
    WHEN OLD.granularity <> NEW.granularity
      AND EXISTS (
        SELECT 1 FROM table_template_custom_field_dependencies AS dependencies
        WHERE dependencies.template_id = OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'cannot change table template granularity with custom field dependencies');
    END;
    CREATE TRIGGER custom_field_definitions_keep_template_granularity_on_update
    BEFORE UPDATE OF granularity ON custom_field_definitions
    WHEN OLD.granularity <> NEW.granularity
      AND EXISTS (
        SELECT 1 FROM table_template_custom_field_dependencies AS dependencies
        JOIN table_templates AS templates ON templates.id = dependencies.template_id
        WHERE dependencies.definition_id = OLD.id
          AND templates.granularity <> NEW.granularity
      )
    BEGIN
      SELECT RAISE(ABORT, 'table template and custom field granularities do not match');
    END;

    DELETE FROM schema_migrations WHERE version = 39;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion31ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion32ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_interception_package_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_interception_packages_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_interception_packages_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspection_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS logistics_exception_identity_is_immutable_on_update;
    DROP TRIGGER IF EXISTS logistics_exception_matters_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS logistics_exception_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS logistics_exception_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS legacy_shipment_mixed_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS legacy_shipment_mixed_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS legacy_return_mixed_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS legacy_return_mixed_events_are_immutable_on_delete;
    DROP TABLE IF EXISTS logistics_exception_events;
    DROP TABLE IF EXISTS logistics_exception_matters;
    DROP TABLE IF EXISTS legacy_shipment_package_mixed_logistics_events;
    DROP TABLE IF EXISTS legacy_return_mixed_logistics_events;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion32ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion33ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_direction_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_direction_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_interception_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_interception_events_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_handling_direction_events;
    DROP TABLE IF EXISTS aftersales_interception_events;
    DELETE FROM schema_migrations WHERE version = 32;
    PRAGMA foreign_keys = ON;
  `);
  const hasHandlingDirection = (database.prepare('PRAGMA table_info(aftersales_cases)').all() as Array<{
    name: string;
  }>).some(({ name }) => name === 'handling_direction');
  if (hasHandlingDirection) {
    database.exec('ALTER TABLE aftersales_cases DROP COLUMN handling_direction;');
  }
}

export function removeVersion33ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion34ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_return_exception_decision_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_return_exception_decisions_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_return_exception_decisions_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_return_exception_decision_events;
    DELETE FROM schema_migrations WHERE version = 33;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion34ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion35ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_processing_rounds_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_processing_rounds_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_processing_round_items_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_processing_round_items_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_round_returns_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_round_returns_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_replacement_shipments_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_replacement_shipments_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_replacement_items_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_replacement_items_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_processing_round_item_source_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_replacement_item_identity_is_valid_on_insert;
    DROP TABLE IF EXISTS aftersales_replacement_items;
    DROP TABLE IF EXISTS aftersales_replacement_shipments;
    DROP TABLE IF EXISTS aftersales_round_returns;
    DROP TABLE IF EXISTS aftersales_processing_round_items;
    DROP TABLE IF EXISTS aftersales_processing_rounds;
    DELETE FROM schema_migrations WHERE version = 34;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion35ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion36ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decision_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_round_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_link_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_links_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_links_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspection_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspections_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspections_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_outbound_exception_refund_links;
    DROP TABLE IF EXISTS aftersales_outbound_exception_decision_events;
    DROP TABLE IF EXISTS aftersales_outbound_exception_replacement_rounds;
    DROP TABLE IF EXISTS aftersales_intercepted_return_inspection_events;
    DROP TABLE IF EXISTS aftersales_interception_packages;
    DELETE FROM schema_migrations WHERE version = 35;
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion36ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion38ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_refund_reopening_events;
    DELETE FROM schema_migrations WHERE version IN (36, 37);
    PRAGMA foreign_keys = ON;
  `);
}

export function removeVersion38ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion39ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_case_workflow_template_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_case_workflow_template_events_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_workflow_template_versions_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_workflow_template_versions_are_immutable_on_delete;
    DROP INDEX IF EXISTS aftersales_case_workflow_template_events_by_case;
    DROP TABLE IF EXISTS aftersales_case_workflow_template_events;
    DROP TABLE IF EXISTS aftersales_workflow_template_versions;
    DROP TABLE IF EXISTS aftersales_workflow_templates;

    DROP TRIGGER IF EXISTS aftersales_direction_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_direction_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS aftersales_direction_events_by_case;
    CREATE TABLE aftersales_handling_direction_events_v37 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('selected', 'changed')),
      before_direction TEXT CHECK (
        before_direction IS NULL OR before_direction IN (
          'waiting', 'intercept', 'refuse', 'only_refund', 'replacement', 'buyer_return'
        )
      ),
      after_direction TEXT NOT NULL CHECK (after_direction IN (
        'waiting', 'intercept', 'refuse', 'only_refund', 'replacement', 'buyer_return'
      )),
      occurred_at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL,
      CHECK (
        (kind = 'selected' AND before_direction IS NULL)
        OR (kind = 'changed' AND before_direction IS NOT NULL
          AND before_direction <> after_direction)
      )
    ) STRICT;
    INSERT INTO aftersales_handling_direction_events_v37 (
      sequence, id, case_id, kind, before_direction, after_direction,
      occurred_at, reason, created_at
    )
    SELECT sequence, id, case_id, kind, before_direction, after_direction,
      occurred_at, reason, created_at
    FROM aftersales_handling_direction_events
    WHERE kind <> 'cleared';
    DROP TABLE aftersales_handling_direction_events;
    ALTER TABLE aftersales_handling_direction_events_v37
      RENAME TO aftersales_handling_direction_events;
    CREATE INDEX aftersales_direction_events_by_case
      ON aftersales_handling_direction_events (case_id, sequence);
    CREATE TRIGGER aftersales_direction_events_are_immutable_on_update
    BEFORE UPDATE ON aftersales_handling_direction_events
    BEGIN SELECT RAISE(ABORT, 'aftersales handling direction events are immutable'); END;
    CREATE TRIGGER aftersales_direction_events_are_immutable_on_delete
    BEFORE DELETE ON aftersales_handling_direction_events
    BEGIN SELECT RAISE(ABORT, 'aftersales handling direction events are immutable'); END;
    DELETE FROM schema_migrations WHERE version = 38;
    PRAGMA foreign_keys = ON;
  `);
}

export function downgradeVersion35ToOriginalSchema(database: DatabaseSync): void {
  removeVersion36ExtensionArtifacts(database);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspection_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_interception_package_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_interception_packages_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_interception_packages_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_link_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_links_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_refund_links_are_immutable_on_delete;
    DROP TABLE IF EXISTS aftersales_outbound_exception_refund_links;
    DROP TABLE IF EXISTS aftersales_interception_packages;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decision_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_round_identity_is_valid_on_insert;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_update;
    DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete;
    DROP INDEX IF EXISTS aftersales_outbound_exception_decisions_by_case;

    CREATE TABLE aftersales_outbound_exception_decision_events_original_v35 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      exception_id TEXT NOT NULL REFERENCES logistics_exception_matters(id) ON DELETE RESTRICT,
      shipment_package_id TEXT NOT NULL REFERENCES shipment_packages(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('selected', 'changed')),
      before_decision TEXT CHECK (
        before_decision IS NULL OR before_decision IN (
          'wait_investigation', 'recover_or_redeliver', 'refund_only',
          'replacement', 'refund_and_replacement'
        )
      ),
      after_decision TEXT NOT NULL CHECK (after_decision IN (
        'wait_investigation', 'recover_or_redeliver', 'refund_only',
        'replacement', 'refund_and_replacement'
      )),
      occurred_at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL,
      CHECK (
        (kind = 'selected' AND before_decision IS NULL)
        OR (kind = 'changed' AND before_decision IS NOT NULL
          AND before_decision <> after_decision)
      )
    ) STRICT;
    INSERT INTO aftersales_outbound_exception_decision_events_original_v35 (
      sequence, id, case_id, exception_id, shipment_package_id, kind,
      before_decision, after_decision, occurred_at, reason, created_at
    )
    SELECT sequence, id, case_id, exception_id, shipment_package_id, kind,
      before_decision, after_decision, occurred_at, reason, created_at
    FROM aftersales_outbound_exception_decision_events;
    DROP TABLE aftersales_outbound_exception_decision_events;
    ALTER TABLE aftersales_outbound_exception_decision_events_original_v35
      RENAME TO aftersales_outbound_exception_decision_events;
    CREATE INDEX aftersales_outbound_exception_decisions_by_case
      ON aftersales_outbound_exception_decision_events (case_id, exception_id, sequence);
    CREATE TRIGGER aftersales_outbound_exception_decisions_are_immutable_on_update
      BEFORE UPDATE ON aftersales_outbound_exception_decision_events
      BEGIN SELECT RAISE(ABORT, 'outbound exception decision events are immutable'); END;
    CREATE TRIGGER aftersales_outbound_exception_decisions_are_immutable_on_delete
      BEFORE DELETE ON aftersales_outbound_exception_decision_events
      BEGIN SELECT RAISE(ABORT, 'outbound exception decision events are immutable'); END;

    CREATE TABLE aftersales_outbound_exception_replacement_rounds_original_v35 (
      exception_id TEXT PRIMARY KEY
        REFERENCES logistics_exception_matters(id) ON DELETE RESTRICT,
      case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      round_id TEXT NOT NULL UNIQUE
        REFERENCES aftersales_processing_rounds(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO aftersales_outbound_exception_replacement_rounds_original_v35 (
      exception_id, case_id, round_id, created_at
    )
    SELECT exception_id, case_id, round_id, created_at
    FROM aftersales_outbound_exception_replacement_rounds;
    DROP TABLE aftersales_outbound_exception_replacement_rounds;
    ALTER TABLE aftersales_outbound_exception_replacement_rounds_original_v35
      RENAME TO aftersales_outbound_exception_replacement_rounds;
    CREATE TRIGGER aftersales_outbound_exception_replacement_rounds_are_immutable_on_update
      BEFORE UPDATE ON aftersales_outbound_exception_replacement_rounds
      BEGIN SELECT RAISE(ABORT, 'outbound exception replacement rounds are immutable'); END;
    CREATE TRIGGER aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete
      BEFORE DELETE ON aftersales_outbound_exception_replacement_rounds
      BEGIN SELECT RAISE(ABORT, 'outbound exception replacement rounds are immutable'); END;
    PRAGMA foreign_keys = ON;
  `);
}
