import { mkdirSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizedOrderIdentityPart } from '../core/order-comparison';

const DATABASE_FILENAME = 'xianyu-order-manager.sqlite3';
const LOCK_FILENAME = '.xianyu-order-manager-writer.sqlite3';

export class WorkspaceInUseError extends Error {
  public constructor(public readonly dataDirectory: string) {
    super('该数据目录正在被另一个应用实例使用');
    this.name = 'WorkspaceInUseError';
  }
}

export class Workspace {
  public readonly database: DatabaseSync;
  private readonly lockDatabase: DatabaseSync;
  private closed = false;

  private constructor(
    public readonly dataDirectory: string,
    database: DatabaseSync,
    lockDatabase: DatabaseSync,
  ) {
    this.database = database;
    this.lockDatabase = lockDatabase;
  }

  public static open(requestedDirectory: string): Workspace {
    const dataDirectory = resolve(requestedDirectory);
    mkdirSync(dataDirectory, { recursive: true });

    const lockDatabase = new DatabaseSync(join(dataDirectory, LOCK_FILENAME), {
      timeout: 0,
    });

    try {
      lockDatabase.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE IF NOT EXISTS writer_guard (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          note TEXT NOT NULL
        ) STRICT;
        INSERT OR IGNORE INTO writer_guard (id, note) VALUES (1, 'exclusive writer guard');
        BEGIN EXCLUSIVE;
      `);
    } catch (error) {
      lockDatabase.close();
      if (isDatabaseBusy(error)) {
        throw new WorkspaceInUseError(dataDirectory);
      }
      throw error;
    }

    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(join(dataDirectory, DATABASE_FILENAME), {
        timeout: 5_000,
        enableForeignKeyConstraints: true,
        defensive: true,
      });
      database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      migrate(database);
      return new Workspace(dataDirectory, database, lockDatabase);
    } catch (error) {
      database?.close();
      rollbackQuietly(lockDatabase);
      lockDatabase.close();
      throw error;
    }
  }

  public resolveStoredPath(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new Error('来源截图路径必须相对于数据目录');
    }

    const absolutePath = resolve(this.dataDirectory, ...relativePath.split('/'));
    const fromRoot = relative(this.dataDirectory, absolutePath);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      throw new Error('来源截图路径超出数据目录');
    }
    return absolutePath;
  }

  public toStoredPath(absolutePath: string): string {
    const fromRoot = relative(this.dataDirectory, normalize(absolutePath));
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('只能保存数据目录内的来源截图路径');
    }
    return fromRoot.split(sep).join('/');
  }

  public transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK;');
      } catch {
        // Preserve the domain error that caused the rollback.
      }
      throw error;
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
    rollbackQuietly(this.lockDatabase);
    this.lockDatabase.close();
  }
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK;');
  } catch {
    // Closing the connection is still safe when no transaction was active.
  }
}

function isDatabaseBusy(error: unknown): boolean {
  return error instanceof Error && /locked|busy/i.test(error.message);
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const row = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };

  if (row.version < 1) migrateToVersion1(database);
  if (row.version < 2) migrateToVersion2(database);
  if (row.version < 3) migrateToVersion3(database);
  if (row.version < 4) migrateToVersion4(database);
  if (row.version < 5) migrateToVersion5(database);
  if (row.version < 6) migrateToVersion6(database);
  if (row.version < 7) migrateToVersion7(database);
  if (row.version < 8) migrateToVersion8(database);
  if (row.version < 9) migrateToVersion9(database);
  if (row.version < 10) migrateToVersion10(database);
  if (row.version < 11) migrateToVersion11(database);
  if (row.version < 12) migrateToVersion12(database);
  if (row.version < 13) migrateToVersion13(database);
  if (row.version < 14) migrateToVersion14(database);
  if (row.version < 15) migrateToVersion15(database);
  if (row.version < 16) migrateToVersion16(database);
  if (row.version < 17) migrateToVersion17(database);
}

function migrateToVersion1(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
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

      CREATE TRIGGER source_snapshots_are_immutable
      BEFORE UPDATE ON source_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'source snapshots are immutable');
      END;

      INSERT INTO schema_migrations (version, applied_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion2(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE order_drafts ADD COLUMN alipay_transaction_number TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN phone_normalized TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN address_normalized TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN province TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN city TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN district TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN ordered_at_original TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN ordered_at_normalized TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN paid_at_original TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN paid_at_normalized TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN product_total_cents INTEGER NOT NULL DEFAULT 0
        CHECK (product_total_cents >= 0);
      ALTER TABLE order_drafts ADD COLUMN product_total_present INTEGER NOT NULL DEFAULT 0
        CHECK (product_total_present IN (0, 1));
      ALTER TABLE order_drafts ADD COLUMN shipping_fee_cents INTEGER NOT NULL DEFAULT 0
        CHECK (shipping_fee_cents >= 0);
      ALTER TABLE order_drafts ADD COLUMN shipping_fee_present INTEGER NOT NULL DEFAULT 0
        CHECK (shipping_fee_present IN (0, 1));
      ALTER TABLE order_drafts ADD COLUMN amount_present INTEGER NOT NULL DEFAULT 1
        CHECK (amount_present IN (0, 1));
      ALTER TABLE order_drafts ADD COLUMN platform_transaction_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (platform_transaction_status IN ('paid', 'cancelled', 'refunded', 'unknown'));
      ALTER TABLE order_drafts ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (fulfillment_status IN ('pending_shipment', 'shipped', 'unknown'));

      UPDATE order_drafts
      SET
        phone_normalized = phone,
        address_normalized = address_original;

      ALTER TABLE draft_items ADD COLUMN unit_price_present INTEGER NOT NULL DEFAULT 1
        CHECK (unit_price_present IN (0, 1));

      CREATE TABLE original_orders_v2 (
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
        UNIQUE (platform, seller_account, platform_order_number)
      ) STRICT;

      INSERT INTO original_orders_v2 (
        id, draft_id, screenshot_id, platform, seller_account, platform_order_number,
        alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
        address_original, address_normalized, province, city, district,
        ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
        product_total_cents, shipping_fee_cents, amount_cents,
        platform_transaction_status, fulfillment_status, lifecycle_status,
        created_at, updated_at
      )
      SELECT
        id, draft_id, screenshot_id, platform, seller_account, platform_order_number,
        '', buyer_nickname, recipient, phone, phone,
        address_original, address_original, '', '', '',
        '', '', '', '',
        NULL, NULL, amount_cents,
        platform_transaction_status, fulfillment_status, lifecycle_status,
        created_at, updated_at
      FROM original_orders;

      DROP TABLE original_orders;
      ALTER TABLE original_orders_v2 RENAME TO original_orders;

      CREATE TABLE recognition_attempts (
        id TEXT PRIMARY KEY,
        screenshot_id TEXT NOT NULL REFERENCES source_screenshots(id) ON DELETE RESTRICT,
        draft_id TEXT NOT NULL REFERENCES order_drafts(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        raw_response TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX recognition_attempts_by_screenshot
      ON recognition_attempts (screenshot_id, created_at DESC, id DESC);

      CREATE TRIGGER recognition_attempts_are_immutable_on_update
      BEFORE UPDATE ON recognition_attempts
      BEGIN
        SELECT RAISE(ABORT, 'recognition attempts are immutable');
      END;

      CREATE TRIGGER recognition_attempts_are_immutable_on_delete
      BEFORE DELETE ON recognition_attempts
      BEGIN
        SELECT RAISE(ABORT, 'recognition attempts are immutable');
      END;
    `);

    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function migrateToVersion3(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE order_drafts ADD COLUMN review_cancelled_at TEXT;
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion4(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE recognition_batch_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES recognition_batches(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 49),
        source_name TEXT NOT NULL,
        content_sha256 TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'waiting_recognition', 'recognizing', 'validating',
          'awaiting_confirmation', 'imported', 'waiting_retry', 'failed',
          'duplicate_skipped', 'cancelled'
        )),
        draft_id TEXT UNIQUE REFERENCES order_drafts(id) ON DELETE RESTRICT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (batch_id, position),
        CHECK (
          error_message IS NULL
          OR status IN ('waiting_retry', 'failed')
        )
      ) STRICT;

      INSERT INTO recognition_batch_items (
        id, batch_id, position, source_name, content_sha256, status,
        draft_id, error_message, created_at, updated_at
      )
      SELECT
        screenshot_id,
        batch_id,
        position,
        original_name,
        content_sha256,
        CASE
          WHEN draft_id IS NULL THEN 'failed'
          WHEN review_cancelled_at IS NOT NULL THEN 'cancelled'
          WHEN draft_status = 'confirmed' THEN 'imported'
          ELSE 'awaiting_confirmation'
        END,
        draft_id,
        CASE
          WHEN draft_id IS NULL THEN '旧版来源截图未关联订单草稿，无法恢复'
          ELSE NULL
        END,
        created_at,
        COALESCE(review_cancelled_at, confirmed_at, created_at)
      FROM (
        SELECT
          screenshots.id AS screenshot_id,
          screenshots.batch_id,
          ROW_NUMBER() OVER (
            PARTITION BY screenshots.batch_id
            ORDER BY screenshots.created_at, screenshots.id
          ) - 1 AS position,
          screenshots.original_name,
          screenshots.content_sha256,
          screenshots.created_at,
          drafts.id AS draft_id,
          drafts.status AS draft_status,
          drafts.confirmed_at,
          drafts.review_cancelled_at
        FROM source_screenshots AS screenshots
        LEFT JOIN order_drafts AS drafts
          ON drafts.screenshot_id = screenshots.id
          AND drafts.batch_id = screenshots.batch_id
      );
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion5(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE recognition_batch_items ADD COLUMN queue_relative_path TEXT;
      ALTER TABLE recognition_batch_items ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0
        CHECK (retry_count >= 0);
      ALTER TABLE recognition_batch_items ADD COLUMN next_retry_at TEXT;
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion6(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE order_drafts ADD COLUMN review_issues_json TEXT NOT NULL DEFAULT '[]'
        CHECK (
          json_valid(review_issues_json)
          AND json_type(review_issues_json) = 'array'
        );
      ALTER TABLE order_drafts ADD COLUMN intake_decision_pending INTEGER NOT NULL DEFAULT 0
        CHECK (intake_decision_pending IN (0, 1));
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion7(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE original_orders ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
        CHECK (revision >= 1);
      ALTER TABLE original_orders ADD COLUMN seller_account_normalized TEXT NOT NULL DEFAULT '';
      ALTER TABLE original_orders ADD COLUMN platform_order_number_normalized TEXT NOT NULL DEFAULT '';
      ALTER TABLE order_drafts ADD COLUMN matched_order_id TEXT
        REFERENCES original_orders(id) ON DELETE RESTRICT;

      ALTER TABLE recognition_batch_items ADD COLUMN resolution_kind TEXT
        CHECK (resolution_kind IS NULL OR resolution_kind IN (
          'new_order', 'identical_image', 'equivalent_order', 'order_updated'
        ));

      UPDATE recognition_batch_items
      SET resolution_kind = CASE
        WHEN status = 'imported' THEN 'new_order'
        WHEN status = 'duplicate_skipped' THEN 'identical_image'
        ELSE NULL
      END;

      CREATE INDEX source_screenshots_by_content_sha256
      ON source_screenshots (content_sha256);

      DROP TRIGGER IF EXISTS source_snapshots_are_immutable;
      ALTER TABLE source_snapshots RENAME TO source_snapshots_v6;

      CREATE TABLE source_snapshots (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL UNIQUE REFERENCES order_drafts(id) ON DELETE RESTRICT,
        order_id TEXT REFERENCES original_orders(id) ON DELETE RESTRICT,
        screenshot_id TEXT NOT NULL UNIQUE
          REFERENCES source_screenshots(id) ON DELETE RESTRICT,
        recognition_json TEXT NOT NULL CHECK (json_valid(recognition_json)),
        confirmed_json TEXT CHECK (
          confirmed_json IS NULL OR json_valid(confirmed_json)
        ),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK (
          (
            order_id IS NULL
            AND confirmed_json IS NULL
            AND resolved_at IS NULL
          ) OR (
            order_id IS NOT NULL
            AND confirmed_json IS NOT NULL
            AND resolved_at IS NOT NULL
          )
        )
      ) STRICT;

      INSERT INTO source_snapshots (
        id, draft_id, order_id, screenshot_id,
        recognition_json, confirmed_json, created_at, resolved_at
      )
      SELECT
        snapshots.id,
        orders.draft_id,
        snapshots.order_id,
        snapshots.screenshot_id,
        snapshots.recognition_json,
        snapshots.confirmed_json,
        snapshots.created_at,
        snapshots.created_at
      FROM source_snapshots_v6 AS snapshots
      JOIN original_orders AS orders ON orders.id = snapshots.order_id;

      INSERT INTO source_snapshots (
        id, draft_id, order_id, screenshot_id,
        recognition_json, confirmed_json, created_at, resolved_at
      )
      SELECT
        'migrated-pending:' || drafts.id,
        drafts.id,
        NULL,
        drafts.screenshot_id,
        drafts.recognition_json,
        NULL,
        drafts.created_at,
        NULL
      FROM order_drafts AS drafts
      LEFT JOIN source_snapshots_v6 AS snapshots
        ON snapshots.screenshot_id = drafts.screenshot_id
      WHERE drafts.status = 'awaiting_review'
        AND snapshots.id IS NULL;

      DROP TABLE source_snapshots_v6;

      CREATE TRIGGER source_snapshots_only_finalize_once
      BEFORE UPDATE ON source_snapshots
      WHEN
        OLD.order_id IS NOT NULL
        OR OLD.confirmed_json IS NOT NULL
        OR OLD.resolved_at IS NOT NULL
        OR NEW.id != OLD.id
        OR NEW.draft_id != OLD.draft_id
        OR NEW.screenshot_id != OLD.screenshot_id
        OR NEW.recognition_json != OLD.recognition_json
        OR NEW.created_at != OLD.created_at
        OR NEW.order_id IS NULL
        OR NEW.confirmed_json IS NULL
        OR NEW.resolved_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'source snapshots are immutable after finalization');
      END;

      CREATE TRIGGER source_snapshots_are_immutable_on_delete
      BEFORE DELETE ON source_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'source snapshots are immutable');
      END;

      CREATE TABLE order_change_events (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES original_orders(id) ON DELETE RESTRICT,
        source_snapshot_id TEXT UNIQUE
          REFERENCES source_snapshots(id) ON DELETE RESTRICT,
        source TEXT NOT NULL CHECK (source IN ('source_update', 'manual_edit')),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE order_field_changes (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES order_change_events(id) ON DELETE RESTRICT,
        field_path TEXT NOT NULL,
        before_json TEXT NOT NULL CHECK (json_valid(before_json)),
        after_json TEXT NOT NULL CHECK (json_valid(after_json)),
        UNIQUE (event_id, field_path)
      ) STRICT;

      CREATE INDEX order_change_events_by_order
      ON order_change_events (order_id, created_at DESC, id DESC);

      CREATE TRIGGER order_change_events_are_immutable_on_update
      BEFORE UPDATE ON order_change_events
      BEGIN
        SELECT RAISE(ABORT, 'order change events are immutable');
      END;

      CREATE TRIGGER order_change_events_are_immutable_on_delete
      BEFORE DELETE ON order_change_events
      BEGIN
        SELECT RAISE(ABORT, 'order change events are immutable');
      END;

      CREATE TRIGGER order_field_changes_are_immutable_on_update
      BEFORE UPDATE ON order_field_changes
      BEGIN
        SELECT RAISE(ABORT, 'order field changes are immutable');
      END;

      CREATE TRIGGER order_field_changes_are_immutable_on_delete
      BEFORE DELETE ON order_field_changes
      BEGIN
        SELECT RAISE(ABORT, 'order field changes are immutable');
      END;
    `);
    backfillNormalizedOrderIdentities(database);
    database.exec(`
      CREATE UNIQUE INDEX original_orders_by_normalized_identity
      ON original_orders (
        platform,
        seller_account_normalized,
        platform_order_number_normalized
      );
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion8(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE custom_field_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        granularity TEXT NOT NULL
          CHECK (granularity IN ('order', 'order_item')),
        value_type TEXT NOT NULL
          CHECK (value_type IN (
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

      CREATE TABLE custom_field_values (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL
          REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
        order_id TEXT REFERENCES original_orders(id) ON DELETE CASCADE,
        order_item_id TEXT REFERENCES order_items(id) ON DELETE CASCADE,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (order_id IS NOT NULL AND order_item_id IS NULL)
          OR (order_id IS NULL AND order_item_id IS NOT NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX custom_field_values_by_order
      ON custom_field_values (definition_id, order_id)
      WHERE order_id IS NOT NULL;

      CREATE UNIQUE INDEX custom_field_values_by_order_item
      ON custom_field_values (definition_id, order_item_id)
      WHERE order_item_id IS NOT NULL;

      CREATE INDEX custom_field_values_order_lookup
      ON custom_field_values (order_id, definition_id);

      CREATE INDEX custom_field_values_order_item_lookup
      ON custom_field_values (order_item_id, definition_id);

      CREATE TRIGGER custom_field_values_owner_matches_definition_on_insert
      BEFORE INSERT ON custom_field_values
      WHEN EXISTS (
        SELECT 1
        FROM custom_field_definitions AS definitions
        WHERE definitions.id = NEW.definition_id
          AND NOT (
            (definitions.granularity = 'order'
              AND NEW.order_id IS NOT NULL
              AND NEW.order_item_id IS NULL)
            OR
            (definitions.granularity = 'order_item'
              AND NEW.order_id IS NULL
              AND NEW.order_item_id IS NOT NULL)
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'custom field granularity does not match value owner');
      END;

      CREATE TRIGGER custom_field_values_owner_matches_definition_on_update
      BEFORE UPDATE ON custom_field_values
      WHEN EXISTS (
        SELECT 1
        FROM custom_field_definitions AS definitions
        WHERE definitions.id = NEW.definition_id
          AND NOT (
            (definitions.granularity = 'order'
              AND NEW.order_id IS NOT NULL
              AND NEW.order_item_id IS NULL)
            OR
            (definitions.granularity = 'order_item'
              AND NEW.order_id IS NULL
              AND NEW.order_item_id IS NOT NULL)
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'custom field granularity does not match value owner');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (8, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion9(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE table_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        granularity TEXT NOT NULL
          CHECK (granularity IN ('order', 'order_item')),
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

      CREATE TABLE table_template_custom_field_dependencies (
        template_id TEXT NOT NULL
          REFERENCES table_templates(id) ON DELETE CASCADE,
        definition_id TEXT NOT NULL
          REFERENCES custom_field_definitions(id) ON DELETE RESTRICT,
        usage TEXT NOT NULL CHECK (usage IN ('column', 'filter', 'sort')),
        PRIMARY KEY (template_id, definition_id, usage)
      ) STRICT;

      CREATE INDEX table_template_dependencies_by_definition
      ON table_template_custom_field_dependencies (definition_id, template_id);

      CREATE TRIGGER table_template_dependencies_match_granularity_on_insert
      BEFORE INSERT ON table_template_custom_field_dependencies
      WHEN EXISTS (
        SELECT 1
        FROM table_templates AS templates
        JOIN custom_field_definitions AS definitions
          ON definitions.id = NEW.definition_id
        WHERE templates.id = NEW.template_id
          AND templates.granularity <> definitions.granularity
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'table template and custom field granularities do not match'
        );
      END;

      CREATE TRIGGER table_template_dependencies_match_granularity_on_update
      BEFORE UPDATE ON table_template_custom_field_dependencies
      WHEN EXISTS (
        SELECT 1
        FROM table_templates AS templates
        JOIN custom_field_definitions AS definitions
          ON definitions.id = NEW.definition_id
        WHERE templates.id = NEW.template_id
          AND templates.granularity <> definitions.granularity
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'table template and custom field granularities do not match'
        );
      END;

      CREATE TRIGGER table_templates_prevent_granularity_change_with_dependencies
      BEFORE UPDATE OF granularity ON table_templates
      WHEN OLD.granularity <> NEW.granularity
        AND EXISTS (
          SELECT 1
          FROM table_template_custom_field_dependencies AS dependencies
          WHERE dependencies.template_id = OLD.id
        )
      BEGIN
        SELECT RAISE(
          ABORT,
          'cannot change table template granularity with custom field dependencies'
        );
      END;

      CREATE TRIGGER custom_field_definitions_keep_template_granularity_on_update
      BEFORE UPDATE OF granularity ON custom_field_definitions
      WHEN OLD.granularity <> NEW.granularity
        AND EXISTS (
          SELECT 1
          FROM table_template_custom_field_dependencies AS dependencies
          JOIN table_templates AS templates
            ON templates.id = dependencies.template_id
          WHERE dependencies.definition_id = OLD.id
            AND templates.granularity <> NEW.granularity
        )
      BEGIN
        SELECT RAISE(
          ABORT,
          'table template and custom field granularities do not match'
        );
      END;
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (9, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion10(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE draft_items_v10 (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES order_drafts(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        source_title TEXT NOT NULL,
        source_spec TEXT NOT NULL,
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price_present INTEGER NOT NULL DEFAULT 1
          CHECK (unit_price_present IN (0, 1)),
        quantity_source TEXT NOT NULL CHECK (quantity_source IN (
          'manual', 'ocr_explicit', 'system_default_1', 'legacy_explicit_or_manual'
        )),
        UNIQUE (draft_id, position)
      ) STRICT;

      INSERT INTO draft_items_v10 (
        id, draft_id, position, source_title, source_spec,
        unit_price_cents, quantity, unit_price_present, quantity_source
      )
      SELECT
        id, draft_id, position, source_title, source_spec,
        unit_price_cents, quantity, unit_price_present,
        CASE quantity_inferred
          WHEN 1 THEN 'system_default_1'
          ELSE 'legacy_explicit_or_manual'
        END
      FROM draft_items;

      CREATE TABLE order_items_v10 (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES original_orders(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        source_title TEXT NOT NULL,
        source_spec TEXT NOT NULL,
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        quantity_source TEXT NOT NULL CHECK (quantity_source IN (
          'manual', 'ocr_explicit', 'system_default_1', 'legacy_explicit_or_manual'
        )),
        subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
        UNIQUE (order_id, position)
      ) STRICT;

      INSERT INTO order_items_v10 (
        id, order_id, position, source_title, source_spec,
        unit_price_cents, quantity, quantity_source, subtotal_cents
      )
      SELECT
        id, order_id, position, source_title, source_spec,
        unit_price_cents, quantity,
        CASE quantity_inferred
          WHEN 1 THEN 'system_default_1'
          ELSE 'legacy_explicit_or_manual'
        END,
        subtotal_cents
      FROM order_items;

      DROP TABLE draft_items;
      ALTER TABLE draft_items_v10 RENAME TO draft_items;
      DROP TABLE order_items;
      ALTER TABLE order_items_v10 RENAME TO order_items;
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (10, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function migrateToVersion11(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    const rows = database.prepare(`
      SELECT
        id, name, name_key, granularity, configuration_version,
        configuration_json, created_at, updated_at
      FROM table_templates
      ORDER BY created_at, id
    `).all() as unknown as LegacyTableTemplateRow[];
    const migratedRows = rows.map(migrateTableTemplateConfigurationToVersion2);

    database.exec(`
      DROP TRIGGER table_template_dependencies_match_granularity_on_insert;
      DROP TRIGGER table_template_dependencies_match_granularity_on_update;
      DROP TRIGGER table_templates_prevent_granularity_change_with_dependencies;
      DROP TRIGGER custom_field_definitions_keep_template_granularity_on_update;

      CREATE TABLE table_templates_v11 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        granularity TEXT NOT NULL
          CHECK (granularity IN ('order', 'order_item')),
        configuration_version INTEGER NOT NULL DEFAULT 2
          CHECK (configuration_version = 2),
        configuration_json TEXT NOT NULL CHECK (
          json_valid(configuration_json)
          AND json_type(configuration_json) = 'object'
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (granularity, name_key)
      ) STRICT;
    `);
    const insert = database.prepare(`
      INSERT INTO table_templates_v11 (
        id, name, name_key, granularity, configuration_version,
        configuration_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 2, ?, ?, ?)
    `);
    for (const row of migratedRows) {
      insert.run(
        row.id,
        row.name,
        row.nameKey,
        row.granularity,
        row.configurationJson,
        row.createdAt,
        row.updatedAt,
      );
    }
    database.exec(`
      DROP TABLE table_templates;
      ALTER TABLE table_templates_v11 RENAME TO table_templates;

      CREATE TRIGGER table_template_dependencies_match_granularity_on_insert
      BEFORE INSERT ON table_template_custom_field_dependencies
      WHEN EXISTS (
        SELECT 1
        FROM table_templates AS templates
        JOIN custom_field_definitions AS definitions
          ON definitions.id = NEW.definition_id
        WHERE templates.id = NEW.template_id
          AND templates.granularity <> definitions.granularity
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'table template and custom field granularities do not match'
        );
      END;

      CREATE TRIGGER table_template_dependencies_match_granularity_on_update
      BEFORE UPDATE ON table_template_custom_field_dependencies
      WHEN EXISTS (
        SELECT 1
        FROM table_templates AS templates
        JOIN custom_field_definitions AS definitions
          ON definitions.id = NEW.definition_id
        WHERE templates.id = NEW.template_id
          AND templates.granularity <> definitions.granularity
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'table template and custom field granularities do not match'
        );
      END;

      CREATE TRIGGER table_templates_prevent_granularity_change_with_dependencies
      BEFORE UPDATE OF granularity ON table_templates
      WHEN OLD.granularity <> NEW.granularity
        AND EXISTS (
          SELECT 1
          FROM table_template_custom_field_dependencies AS dependencies
          WHERE dependencies.template_id = OLD.id
        )
      BEGIN
        SELECT RAISE(
          ABORT,
          'cannot change table template granularity with custom field dependencies'
        );
      END;

      CREATE TRIGGER custom_field_definitions_keep_template_granularity_on_update
      BEFORE UPDATE OF granularity ON custom_field_definitions
      WHEN OLD.granularity <> NEW.granularity
        AND EXISTS (
          SELECT 1
          FROM table_template_custom_field_dependencies AS dependencies
          JOIN table_templates AS templates
            ON templates.id = dependencies.template_id
          WHERE dependencies.definition_id = OLD.id
            AND templates.granularity <> NEW.granularity
        )
      BEGIN
        SELECT RAISE(
          ABORT,
          'table template and custom field granularities do not match'
        );
      END;
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (11, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK;');
      } catch {
        // Preserve migration failure.
      }
    }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function migrateToVersion12(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE original_orders ADD COLUMN note TEXT NOT NULL DEFAULT '';
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (12, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion13(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE order_drafts
      ADD COLUMN recognition_conflicts_json TEXT NOT NULL DEFAULT '[]'
        CHECK (
          json_valid(recognition_conflicts_json)
          AND json_type(recognition_conflicts_json) = 'array'
        );
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (13, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion14(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE candidate_adjudication_runs (
        id TEXT PRIMARY KEY,
        screenshot_id TEXT NOT NULL
          REFERENCES source_screenshots(id) ON DELETE RESTRICT,
        draft_id TEXT NOT NULL
          REFERENCES order_drafts(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL CHECK (
          provider IN ('deepseek', 'aliyun-bailian', 'openai-compatible')
        ),
        model TEXT NOT NULL CHECK (length(trim(model)) > 0),
        status TEXT NOT NULL CHECK (
          status IN ('succeeded', 'partial', 'failed', 'rejected')
        ),
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        CHECK (
          (status = 'succeeded' AND failure_code IS NULL AND failure_message IS NULL)
          OR status <> 'succeeded'
        )
      ) STRICT;

      CREATE INDEX candidate_adjudication_runs_by_screenshot
        ON candidate_adjudication_runs(screenshot_id, created_at);
      CREATE INDEX candidate_adjudication_runs_by_draft
        ON candidate_adjudication_runs(draft_id, created_at);

      CREATE TABLE candidate_adjudication_decisions (
        run_id TEXT NOT NULL
          REFERENCES candidate_adjudication_runs(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position >= 0),
        ambiguity_id TEXT NOT NULL CHECK (length(trim(ambiguity_id)) > 0),
        region TEXT NOT NULL CHECK (
          region IN (
            'platform_status',
            'shipping_information',
            'purchased_items',
            'amount_summary',
            'order_details',
            'fulfillment_signals'
          )
        ),
        field TEXT NOT NULL CHECK (length(trim(field)) > 0),
        item_index INTEGER CHECK (item_index IS NULL OR item_index >= 0),
        candidates_json TEXT NOT NULL CHECK (
          json_valid(candidates_json)
          AND json_type(candidates_json) = 'array'
        ),
        selected_candidate_id TEXT,
        context_lines_json TEXT NOT NULL CHECK (
          json_valid(context_lines_json)
          AND json_type(context_lines_json) = 'array'
        ),
        outcome TEXT NOT NULL CHECK (
          outcome IN ('selected', 'unresolved', 'invalid')
        ),
        failure_code TEXT,
        PRIMARY KEY (run_id, position),
        UNIQUE (run_id, ambiguity_id),
        CHECK (
          (outcome = 'selected' AND selected_candidate_id IS NOT NULL)
          OR (outcome <> 'selected' AND selected_candidate_id IS NULL)
        )
      ) STRICT;

      CREATE TRIGGER candidate_adjudication_runs_are_immutable_on_update
      BEFORE UPDATE ON candidate_adjudication_runs
      BEGIN
        SELECT RAISE(ABORT, 'candidate adjudication runs are immutable');
      END;

      CREATE TRIGGER candidate_adjudication_runs_are_immutable_on_delete
      BEFORE DELETE ON candidate_adjudication_runs
      BEGIN
        SELECT RAISE(ABORT, 'candidate adjudication runs are immutable');
      END;

      CREATE TRIGGER candidate_adjudication_decisions_are_immutable_on_update
      BEFORE UPDATE ON candidate_adjudication_decisions
      BEGIN
        SELECT RAISE(ABORT, 'candidate adjudication decisions are immutable');
      END;

      CREATE TRIGGER candidate_adjudication_decisions_are_immutable_on_delete
      BEFORE DELETE ON candidate_adjudication_decisions
      BEGIN
        SELECT RAISE(ABORT, 'candidate adjudication decisions are immutable');
      END;
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (14, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion15(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE original_orders
      ADD COLUMN shipping_carrier TEXT NOT NULL DEFAULT '';
      ALTER TABLE original_orders
      ADD COLUMN tracking_number TEXT NOT NULL DEFAULT '';
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (15, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

function migrateToVersion16(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE order_drafts_v16 (
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
          CHECK (fulfillment_status IN (
            'pending_shipment', 'shipped', 'delivered', 'returned', 'unknown'
          )),
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

      INSERT INTO order_drafts_v16 (
        id, batch_id, screenshot_id, platform, seller_account, order_number,
        buyer_nickname, recipient, phone, address_original, amount_cents,
        status, recognition_json, created_at, confirmed_at,
        alipay_transaction_number, phone_normalized, address_normalized,
        province, city, district,
        ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
        product_total_cents, product_total_present,
        shipping_fee_cents, shipping_fee_present, amount_present,
        platform_transaction_status, fulfillment_status,
        review_cancelled_at, review_issues_json, intake_decision_pending,
        matched_order_id, recognition_conflicts_json
      )
      SELECT
        id, batch_id, screenshot_id, platform, seller_account, order_number,
        buyer_nickname, recipient, phone, address_original, amount_cents,
        status, recognition_json, created_at, confirmed_at,
        alipay_transaction_number, phone_normalized, address_normalized,
        province, city, district,
        ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
        product_total_cents, product_total_present,
        shipping_fee_cents, shipping_fee_present, amount_present,
        platform_transaction_status, fulfillment_status,
        review_cancelled_at, review_issues_json, intake_decision_pending,
        matched_order_id, recognition_conflicts_json
      FROM order_drafts;

      DROP TABLE order_drafts;
      ALTER TABLE order_drafts_v16 RENAME TO order_drafts;

      CREATE TABLE original_orders_v16 (
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
            'pending_shipment', 'shipped', 'delivered', 'returned', 'unknown'
          )),
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

      INSERT INTO original_orders_v16 (
        id, draft_id, screenshot_id, platform, seller_account, platform_order_number,
        alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
        address_original, address_normalized, province, city, district,
        ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
        product_total_cents, shipping_fee_cents, amount_cents,
        platform_transaction_status, fulfillment_status, lifecycle_status,
        created_at, updated_at, revision,
        seller_account_normalized, platform_order_number_normalized,
        note, shipping_carrier, tracking_number
      )
      SELECT
        id, draft_id, screenshot_id, platform, seller_account, platform_order_number,
        alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
        address_original, address_normalized, province, city, district,
        ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
        product_total_cents, shipping_fee_cents, amount_cents,
        platform_transaction_status, fulfillment_status, lifecycle_status,
        created_at, updated_at, revision,
        seller_account_normalized, platform_order_number_normalized,
        note, shipping_carrier, tracking_number
      FROM original_orders;

      DROP TABLE original_orders;
      ALTER TABLE original_orders_v16 RENAME TO original_orders;

      CREATE UNIQUE INDEX original_orders_by_normalized_identity
      ON original_orders (
        platform,
        seller_account_normalized,
        platform_order_number_normalized
      );
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (16, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function migrateToVersion17(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE shipment_group_adjustment_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        operation TEXT NOT NULL CHECK (operation IN ('split', 'merge')),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        source_group_ids_json TEXT NOT NULL CHECK (
          json_valid(source_group_ids_json)
          AND json_type(source_group_ids_json) = 'array'
        ),
        source_order_ids_json TEXT NOT NULL CHECK (
          json_valid(source_order_ids_json)
          AND json_type(source_order_ids_json) = 'array'
        ),
        target_group_id TEXT NOT NULL UNIQUE,
        target_order_ids_json TEXT NOT NULL CHECK (
          json_valid(target_order_ids_json)
          AND json_type(target_order_ids_json) = 'array'
        ),
        selected_recipient_order_id TEXT
          REFERENCES original_orders(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX shipment_group_adjustment_events_by_created_at
      ON shipment_group_adjustment_events (created_at, sequence);

      CREATE TRIGGER shipment_group_adjustment_events_are_immutable_on_update
      BEFORE UPDATE ON shipment_group_adjustment_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment group adjustment events are immutable');
      END;

      CREATE TRIGGER shipment_group_adjustment_events_are_immutable_on_delete
      BEFORE DELETE ON shipment_group_adjustment_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment group adjustment events are immutable');
      END;
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (17, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve migration failure.
    }
    throw error;
  }
}

type LegacyTableTemplateRow = {
  id: string;
  name: string;
  name_key: string;
  granularity: string;
  configuration_version: number;
  configuration_json: string;
  created_at: string;
  updated_at: string;
};

type MigratedTableTemplateRow = {
  id: string;
  name: string;
  nameKey: string;
  granularity: 'order' | 'order_item';
  configurationJson: string;
  createdAt: string;
  updatedAt: string;
};

function migrateTableTemplateConfigurationToVersion2(
  row: LegacyTableTemplateRow,
): MigratedTableTemplateRow {
  if (row.configuration_version !== 1) {
    throw new Error(`表格模板“${row.name}”的旧配置版本不受支持`);
  }
  if (row.granularity !== 'order' && row.granularity !== 'order_item') {
    throw new Error(`表格模板“${row.name}”的数据粒度无效`);
  }
  let configuration: unknown;
  try {
    configuration = JSON.parse(row.configuration_json);
  } catch (error) {
    throw new Error(`表格模板“${row.name}”的旧配置无法读取`, { cause: error });
  }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error(`表格模板“${row.name}”的旧配置必须是对象`);
  }
  const record = configuration as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== 'columns' && key !== 'query') ||
    !Array.isArray(record.columns) ||
    !record.query ||
    typeof record.query !== 'object' ||
    Array.isArray(record.query)
  ) {
    throw new Error(`表格模板“${row.name}”的旧配置结构无效`);
  }

  let summaryCount = 0;
  const columns = record.columns.map((column) => {
    if (!column || typeof column !== 'object' || Array.isArray(column)) {
      throw new Error(`表格模板“${row.name}”的旧列配置无效`);
    }
    const value = column as Record<string, unknown>;
    const field = value.field;
    const legacySummary = row.granularity === 'order' &&
      field !== null &&
      typeof field === 'object' &&
      !Array.isArray(field) &&
      (field as Record<string, unknown>).kind === 'builtin' &&
      (field as Record<string, unknown>).key === 'product_summary';
    if (!legacySummary) return column;
    summaryCount += 1;
    if (
      Object.keys(value).some((key) => key !== 'field' && key !== 'displayName') ||
      typeof value.displayName !== 'string' ||
      !value.displayName.trim()
    ) {
      throw new Error(`表格模板“${row.name}”的旧商品摘要配置无效`);
    }
    return {
      kind: 'dynamic_product_group',
      labels: {
        product: value.displayName === '商品摘要' ? '商品' : value.displayName,
        specification: '款式或规格',
        quantity: '数量',
      },
    };
  });
  if (summaryCount > 1) {
    throw new Error(`表格模板“${row.name}”包含重复的旧商品摘要`);
  }

  return {
    id: row.id,
    name: row.name,
    nameKey: row.name_key,
    granularity: row.granularity,
    configurationJson: summaryCount === 0
      ? row.configuration_json
      : JSON.stringify({ columns, query: record.query }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function backfillNormalizedOrderIdentities(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT id, platform, seller_account, platform_order_number
    FROM original_orders
    ORDER BY created_at, id
  `).all() as unknown as Array<{
    id: string;
    platform: string;
    seller_account: string;
    platform_order_number: string;
  }>;
  const seen = new Set<string>();
  const update = database.prepare(`
    UPDATE original_orders
    SET seller_account_normalized = ?, platform_order_number_normalized = ?
    WHERE id = ?
  `);
  for (const row of rows) {
    const sellerAccount = normalizedOrderIdentityPart(row.seller_account);
    const orderNumber = normalizedOrderIdentityPart(row.platform_order_number);
    const identityKey = JSON.stringify([row.platform, sellerAccount, orderNumber]);
    if (seen.has(identityKey)) {
      throw new Error(
        '数据库升级发现规范化后存在重复订单身份；请保留备份并先处理全角、半角或空格等价的重复订单',
      );
    }
    seen.add(identityKey);
    update.run(sellerAccount, orderNumber, row.id);
  }
}

function assertForeignKeyIntegrity(database: DatabaseSync): void {
  const violations = database.prepare('PRAGMA foreign_key_check;').all();
  if (violations.length > 0) {
    throw new Error('数据库升级后外键完整性检查失败');
  }
}
