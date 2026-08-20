import type { DatabaseSync } from 'node:sqlite';

// v60 建立订单生命周期事件；有事件时拒绝测试降级。
export function removeVersion60ExtensionArtifacts(database: DatabaseSync): void {
  const applied = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 60',
  ).get();
  if (!applied) return;
  const eventCount = database.prepare(
    'SELECT COUNT(*) AS count FROM order_lifecycle_events',
  ).get() as { count: number };
  if (eventCount.count > 0) {
    throw new Error('v60 测试降级前必须移除订单生命周期事件');
  }
  database.exec(`
    DROP TRIGGER IF EXISTS order_lifecycle_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS order_lifecycle_events_are_immutable_on_delete;
    DROP INDEX IF EXISTS order_lifecycle_events_by_order;
    DROP TABLE IF EXISTS order_lifecycle_events;
    DELETE FROM schema_migrations WHERE version = 60;
  `);
}

// v59 允许历史导入不依赖截图、识别批次和订单草稿；存在历史导入数据时拒绝测试降级。
export function removeVersion59ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion60ExtensionArtifacts(database);
  const applied = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 59',
  ).get();
  if (!applied) return;
  const historicalCount = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM original_orders WHERE draft_id IS NULL OR screenshot_id IS NULL)
      + (SELECT COUNT(*) FROM source_snapshots WHERE source_type = 'historical_import') AS count
  `).get() as { count: number };
  if (historicalCount.count > 0) {
    throw new Error('v59 测试降级前必须移除历史导入数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS source_snapshots_only_finalize_once;
    DROP TRIGGER IF EXISTS source_snapshots_are_immutable_on_delete;

    CREATE TABLE original_orders_v58_fixture (
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
        CHECK (fulfillment_status IN (
          'pending_shipment', 'partially_shipped', 'shipped', 'delivered', 'unknown'
        )),
      lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('active', 'trashed', 'deleted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      seller_account_normalized TEXT NOT NULL DEFAULT '',
      platform_order_number_normalized TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      shipping_carrier TEXT NOT NULL DEFAULT '',
      tracking_number TEXT NOT NULL DEFAULT '',
      system_order_number TEXT NOT NULL CHECK (
        system_order_number GLOB
          '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
        AND substr(system_order_number, 10, 6) <> '000000'
      ),
      UNIQUE (platform, seller_account, platform_order_number)
    ) STRICT;
    INSERT INTO original_orders_v58_fixture
    SELECT
      id, draft_id, screenshot_id, platform, seller_account, platform_order_number,
      alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
      address_original, address_normalized, province, city, district,
      ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
      product_total_cents, shipping_fee_cents, amount_cents,
      platform_transaction_status, fulfillment_status, lifecycle_status,
      created_at, updated_at, revision,
      seller_account_normalized, platform_order_number_normalized,
      note, shipping_carrier, tracking_number, system_order_number
    FROM original_orders;
    DROP TABLE original_orders;
    ALTER TABLE original_orders_v58_fixture RENAME TO original_orders;
    CREATE UNIQUE INDEX original_orders_by_normalized_identity
      ON original_orders (platform, seller_account_normalized, platform_order_number_normalized);
    CREATE UNIQUE INDEX original_orders_by_system_order_number
      ON original_orders (system_order_number);
    CREATE TRIGGER original_orders_require_system_order_number_on_insert
    BEFORE INSERT ON original_orders
    WHEN NEW.system_order_number IS NULL
      OR NEW.system_order_number NOT GLOB
        '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
      OR substr(NEW.system_order_number, 10, 6) = '000000'
    BEGIN SELECT RAISE(ABORT, 'system order number is required'); END;
    CREATE TRIGGER original_orders_system_order_number_is_immutable
    BEFORE UPDATE OF system_order_number ON original_orders
    WHEN NEW.system_order_number IS NOT OLD.system_order_number
    BEGIN SELECT RAISE(ABORT, 'system order number is immutable'); END;

    CREATE TABLE source_snapshots_v58_fixture (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL UNIQUE REFERENCES order_drafts(id) ON DELETE RESTRICT,
      order_id TEXT REFERENCES original_orders(id) ON DELETE RESTRICT,
      screenshot_id TEXT NOT NULL UNIQUE REFERENCES source_screenshots(id) ON DELETE RESTRICT,
      recognition_json TEXT NOT NULL CHECK (json_valid(recognition_json)),
      confirmed_json TEXT CHECK (confirmed_json IS NULL OR json_valid(confirmed_json)),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      CHECK (
        (order_id IS NULL AND confirmed_json IS NULL AND resolved_at IS NULL)
        OR (order_id IS NOT NULL AND confirmed_json IS NOT NULL AND resolved_at IS NOT NULL)
      )
    ) STRICT;
    INSERT INTO source_snapshots_v58_fixture
    SELECT id, draft_id, order_id, screenshot_id,
      recognition_json, confirmed_json, created_at, resolved_at
    FROM source_snapshots;
    DROP TABLE source_snapshots;
    ALTER TABLE source_snapshots_v58_fixture RENAME TO source_snapshots;
    CREATE TRIGGER source_snapshots_only_finalize_once
    BEFORE UPDATE ON source_snapshots
    WHEN
      OLD.order_id IS NOT NULL OR OLD.confirmed_json IS NOT NULL OR OLD.resolved_at IS NOT NULL
      OR NEW.id != OLD.id OR NEW.draft_id != OLD.draft_id
      OR NEW.screenshot_id != OLD.screenshot_id OR NEW.recognition_json != OLD.recognition_json
      OR NEW.created_at != OLD.created_at OR NEW.order_id IS NULL
      OR NEW.confirmed_json IS NULL OR NEW.resolved_at IS NULL
    BEGIN SELECT RAISE(ABORT, 'source snapshots are immutable after finalization'); END;
    CREATE TRIGGER source_snapshots_are_immutable_on_delete
    BEFORE DELETE ON source_snapshots
    BEGIN SELECT RAISE(ABORT, 'source snapshots are immutable'); END;
    DELETE FROM schema_migrations WHERE version = 59;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// 迁移旅程测试降级前的资金数据清理：业务钩子（#74）会在旅程中生成待确认资金事项，
// 降级守卫会拒绝带走资金数据；测试里显式清空两张资金表（先摘删除触发器再复原）。
export function clearVersion58FundsData(database: DatabaseSync): void {
  database.exec(`
    DROP TRIGGER IF EXISTS finance_records_are_immutable_on_delete;
    DROP TRIGGER IF EXISTS finance_pending_items_are_immutable_on_delete;
    DELETE FROM finance_records;
    DELETE FROM finance_pending_items;
    CREATE TRIGGER finance_records_are_immutable_on_delete
    BEFORE DELETE ON finance_records
    BEGIN
      SELECT RAISE(ABORT, 'finance records are immutable');
    END;
    CREATE TRIGGER finance_pending_items_are_immutable_on_delete
    BEFORE DELETE ON finance_pending_items
    BEGIN
      SELECT RAISE(ABORT, 'finance pending items cannot be deleted; cancel instead');
    END;
  `);
}

// v58 建立资金事实双表（待确认资金事项、资金记录）；存在资金数据时拒绝降级。
export function removeVersion58ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion59ExtensionArtifacts(database);
  const applied = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 58',
  ).get();
  if (!applied) return;
  const dataCount = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM finance_pending_items)
      + (SELECT COUNT(*) FROM finance_records)
      AS count
  `).get() as { count: number };
  if (dataCount.count > 0) {
    throw new Error('v58 测试降级前必须移除资金数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS finance_records_are_immutable_on_update;
    DROP TRIGGER IF EXISTS finance_records_are_immutable_on_delete;
    DROP INDEX IF EXISTS finance_records_by_type;
    DROP INDEX IF EXISTS finance_records_by_reverses;
    DROP INDEX IF EXISTS finance_records_by_pending_item;
    DROP TABLE IF EXISTS finance_records;
    DROP TRIGGER IF EXISTS finance_pending_items_facts_are_immutable_on_update;
    DROP TRIGGER IF EXISTS finance_pending_items_are_immutable_on_delete;
    DROP INDEX IF EXISTS finance_pending_items_by_status;
    DROP INDEX IF EXISTS finance_pending_items_by_source;
    DROP TABLE IF EXISTS finance_pending_items;
    DELETE FROM schema_migrations WHERE version = 58;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// v57 连接采购建议与采购订单（建议表 converted 态与订单引用、事件表 converted 类型、订单表计划归属）；
// 存在转入数据时拒绝降级。
export function removeVersion57ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion58ExtensionArtifacts(database);
  const applied = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 57',
  ).get();
  if (!applied) return;
  const suggestionColumns = database.prepare(
    'PRAGMA table_info(purchase_suggestions)',
  ).all() as Array<{ name: string }>;
  const hasOrderColumn = suggestionColumns.some(({ name }) => name === 'purchase_order_id');
  const orderColumns = database.prepare(
    'PRAGMA table_info(purchase_orders)',
  ).all() as Array<{ name: string }>;
  const hasPlanColumn = orderColumns.some(({ name }) => name === 'plan_id');
  if (!hasOrderColumn && !hasPlanColumn) return;
  const convertedCount = database.prepare(`
    SELECT COUNT(*) AS count FROM purchase_suggestions WHERE status = 'converted'
  `).get() as { count: number };
  const convertedEventCount = database.prepare(`
    SELECT COUNT(*) AS count FROM purchase_suggestion_events WHERE event_type = 'converted'
  `).get() as { count: number };
  const linkedOrderCount = database.prepare(`
    SELECT COUNT(*) AS count FROM purchase_orders WHERE plan_id IS NOT NULL
  `).get() as { count: number };
  if (convertedCount.count > 0 || convertedEventCount.count > 0 || linkedOrderCount.count > 0) {
    throw new Error('v57 测试降级前必须移除建议转入采购订单数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS purchase_suggestion_events_are_immutable_on_update;
    DROP TRIGGER IF EXISTS purchase_suggestion_events_are_immutable_on_delete;
    ALTER TABLE purchase_suggestion_events RENAME TO purchase_suggestion_events_v57;
    CREATE TABLE purchase_suggestion_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      suggestion_id TEXT NOT NULL REFERENCES purchase_suggestions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES fulfillment_plans(id) ON DELETE RESTRICT,
      event_type TEXT NOT NULL CHECK (
        event_type IN ('created', 'confirmed', 'cancelled', 'reduced')
      ),
      quantity INTEGER CHECK (quantity IS NULL OR quantity > 0),
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (event_type != 'reduced' OR quantity IS NOT NULL),
      CHECK (event_type = 'reduced' OR quantity IS NULL)
    ) STRICT;
    INSERT INTO purchase_suggestion_events (
      sequence, id, suggestion_id, plan_id, event_type, quantity, reason,
      occurred_at, created_at
    )
    SELECT sequence, id, suggestion_id, plan_id, event_type, quantity, reason,
      occurred_at, created_at
    FROM purchase_suggestion_events_v57
    ORDER BY sequence;
    DROP TABLE purchase_suggestion_events_v57;
    CREATE INDEX purchase_suggestion_events_by_plan
      ON purchase_suggestion_events (plan_id, sequence);
    CREATE INDEX purchase_suggestion_events_by_suggestion
      ON purchase_suggestion_events (suggestion_id, sequence);
    CREATE TRIGGER purchase_suggestion_events_are_immutable_on_update
    BEFORE UPDATE ON purchase_suggestion_events
    BEGIN
      SELECT RAISE(ABORT, 'purchase suggestion events are immutable');
    END;
    CREATE TRIGGER purchase_suggestion_events_are_immutable_on_delete
    BEFORE DELETE ON purchase_suggestion_events
    BEGIN
      SELECT RAISE(ABORT, 'purchase suggestion events are immutable');
    END;

    CREATE TABLE purchase_suggestions_v56 (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES fulfillment_plans(id) ON DELETE RESTRICT,
      standard_product_id TEXT NOT NULL REFERENCES standard_products(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'cancelled')),
      created_at TEXT NOT NULL,
      confirmed_at TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      risk_acknowledged_at TEXT,
      CHECK (status != 'draft' OR (confirmed_at IS NULL AND cancelled_at IS NULL)),
      CHECK (status != 'draft' OR cancel_reason IS NULL),
      CHECK (status != 'confirmed' OR confirmed_at IS NOT NULL),
      CHECK (status != 'confirmed' OR (cancelled_at IS NULL AND cancel_reason IS NULL)),
      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
      CHECK (cancelled_at IS NULL OR cancel_reason IS NOT NULL)
    ) STRICT;
    INSERT INTO purchase_suggestions_v56 (
      id, plan_id, standard_product_id, quantity, status, created_at, confirmed_at,
      cancelled_at, cancel_reason, risk_acknowledged_at
    )
    SELECT id, plan_id, standard_product_id, quantity, status, created_at, confirmed_at,
      cancelled_at, cancel_reason, risk_acknowledged_at
    FROM purchase_suggestions;
    DROP TABLE purchase_suggestions;
    ALTER TABLE purchase_suggestions_v56 RENAME TO purchase_suggestions;
    CREATE INDEX purchase_suggestions_by_plan
      ON purchase_suggestions (plan_id, created_at, id);
    CREATE INDEX purchase_suggestions_by_product
      ON purchase_suggestions (standard_product_id, status);

    DROP INDEX IF EXISTS purchase_orders_by_plan;
    ALTER TABLE purchase_orders DROP COLUMN plan_id;
    DELETE FROM schema_migrations WHERE version = 57;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// v56 建立采购管理九表（供应方、订单、商品行、事件、到货、到货行、退货、退货行、应付）；存在采购数据时拒绝降级。
export function removeVersion56ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion57ExtensionArtifacts(database);
  const applied = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 56',
  ).get();
  if (!applied) return;
  const dataCount = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM suppliers)
      + (SELECT COUNT(*) FROM purchase_orders)
      + (SELECT COUNT(*) FROM supplier_returns)
      + (SELECT COUNT(*) FROM purchase_payables)
      AS count
  `).get() as { count: number };
  if (dataCount.count > 0) {
    throw new Error('v56 测试降级前必须移除采购数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TABLE IF EXISTS purchase_payables;
    DROP TABLE IF EXISTS supplier_return_items;
    DROP TABLE IF EXISTS supplier_returns;
    DROP TABLE IF EXISTS purchase_arrival_items;
    DROP TABLE IF EXISTS purchase_arrivals;
    DROP TABLE IF EXISTS purchase_order_events;
    DROP TABLE IF EXISTS purchase_order_items;
    DROP TABLE IF EXISTS purchase_orders;
    DROP TABLE IF EXISTS suppliers;
    DELETE FROM schema_migrations WHERE version = 56;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// v54 建立不可变库存流水表；存在流水数据时拒绝降级。
export function removeVersion54ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion55ExtensionArtifacts(database);
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

// v55 重建库存流水表，把来源枚举扩充出未交寄撤销冲正；
// 存在流水数据时拒绝降级。
export function removeVersion55ExtensionArtifacts(database: DatabaseSync): void {
  removeVersion56ExtensionArtifacts(database);
  const applied = database.prepare(
    'SELECT 1 FROM schema_migrations WHERE version = 55',
  ).get();
  if (!applied) return;
  const movementCount = database.prepare(`
    SELECT COUNT(*) AS count FROM inventory_movements
  `).get() as { count: number };
  if (movementCount.count > 0) {
    throw new Error('v55 测试降级前必须移除库存流水数据');
  }
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP TRIGGER IF EXISTS inventory_movements_are_immutable_on_update;
    DROP TRIGGER IF EXISTS inventory_movements_are_immutable_on_delete;
    DROP TABLE inventory_movements;
    CREATE TABLE inventory_movements (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      standard_product_id TEXT NOT NULL
        REFERENCES standard_products(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      state TEXT NOT NULL CHECK (state IN (
        'sellable', 'awaiting_inspection', 'defective', 'scrapped'
      )),
      source_type TEXT NOT NULL CHECK (source_type IN (
        'manual_adjustment', 'inspection_result', 'shipment_dispatch',
        'replacement_dispatch', 'return_receipt', 'purchase_arrival', 'supplier_return'
      )),
      source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 100),
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (source_type, source_id, state, direction)
    ) STRICT;
    CREATE INDEX inventory_movements_by_product
    ON inventory_movements (standard_product_id, sequence);
    CREATE TRIGGER inventory_movements_are_immutable_on_update
    BEFORE UPDATE ON inventory_movements
    BEGIN
      SELECT RAISE(ABORT, 'inventory movements are immutable');
    END;
    CREATE TRIGGER inventory_movements_are_immutable_on_delete
    BEFORE DELETE ON inventory_movements
    BEGIN
      SELECT RAISE(ABORT, 'inventory movements are immutable');
    END;
    DELETE FROM schema_migrations WHERE version = 55;
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
