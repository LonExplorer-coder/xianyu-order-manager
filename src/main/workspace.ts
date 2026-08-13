import { mkdirSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizedOrderIdentityPart } from '../core/order-comparison';
import {
  parseStoredShipmentArchiveOrderIds,
  parseStoredShipmentArchiveRecipientSnapshots,
  type StoredShipmentArchiveRecipientSnapshot,
} from '../core/shipment-archive-storage';
import { OrderFulfillmentProjectionService } from './order-fulfillment-projection-service';
import {
  shanghaiDateKey,
  systemOrderNumberForSequence,
} from '../core/system-order-number';

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
    if (this.database.isTransaction) return operation();
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

  const versions = new Set((database.prepare(
    'SELECT version FROM schema_migrations',
  ).all() as Array<{ version: number }>).map(({ version }) => version));

  if (!versions.has(1)) migrateToVersion1(database);
  if (!versions.has(2)) migrateToVersion2(database);
  if (!versions.has(3)) migrateToVersion3(database);
  if (!versions.has(4)) migrateToVersion4(database);
  if (!versions.has(5)) migrateToVersion5(database);
  if (!versions.has(6)) migrateToVersion6(database);
  if (!versions.has(7)) migrateToVersion7(database);
  if (!versions.has(8)) migrateToVersion8(database);
  if (!versions.has(9)) migrateToVersion9(database);
  if (!versions.has(10)) migrateToVersion10(database);
  if (!versions.has(11)) migrateToVersion11(database);
  if (!versions.has(12)) migrateToVersion12(database);
  if (!versions.has(13)) migrateToVersion13(database);
  if (!versions.has(14)) migrateToVersion14(database);
  if (!versions.has(15)) migrateToVersion15(database);
  if (!versions.has(16)) migrateToVersion16(database);
  if (!versions.has(17)) migrateToVersion17(database);
  if (!versions.has(18)) migrateToVersion18(database);
  if (!versions.has(19)) migrateToVersion19(database);
  if (!versions.has(20)) migrateToVersion20(database);
  if (!versions.has(21)) migrateToVersion21(database);
  if (!versions.has(22)) migrateToVersion22(database);
  if (!versions.has(23)) migrateToVersion23(database);
  if (!versions.has(24)) migrateToVersion24(database);
  if (!versions.has(25)) migrateToVersion25(database);
  if (!versions.has(26)) migrateToVersion26(database);
  if (!versions.has(27)) migrateToVersion27(database);
  if (!versions.has(28)) migrateToVersion28(database);
  if (!versions.has(29)) migrateToVersion29(database);
  if (!versions.has(30)) migrateToVersion30(database);
  if (!versions.has(31)) migrateToVersion31(database);
  if (!versions.has(32)) migrateToVersion32(database);
  if (!versions.has(33)) migrateToVersion33(database);
  if (!versions.has(34)) migrateToVersion34(database);
  if (!versions.has(35)) migrateToVersion35(database);
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

function migrateToVersion18(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE shipment_records (
        id TEXT PRIMARY KEY,
        source_group_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        phone TEXT NOT NULL,
        phone_normalized TEXT NOT NULL,
        address_original TEXT NOT NULL,
        address_normalized TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX shipment_records_by_source_group
      ON shipment_records (source_group_id, created_at, id);

      CREATE TABLE shipment_packages (
        id TEXT PRIMARY KEY,
        shipment_record_id TEXT NOT NULL
          REFERENCES shipment_records(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position >= 0),
        shipping_carrier TEXT NOT NULL,
        tracking_number TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        UNIQUE (shipment_record_id, position)
      ) STRICT;

      CREATE TABLE shipment_record_order_snapshots (
        id TEXT PRIMARY KEY,
        shipment_record_id TEXT NOT NULL
          REFERENCES shipment_records(id) ON DELETE RESTRICT,
        order_id TEXT NOT NULL
          REFERENCES original_orders(id) ON DELETE RESTRICT,
        order_number TEXT NOT NULL,
        seller_account TEXT NOT NULL,
        buyer_nickname TEXT NOT NULL,
        recipient TEXT NOT NULL,
        phone TEXT NOT NULL,
        address_original TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        UNIQUE (shipment_record_id, order_id)
      ) STRICT;

      CREATE TABLE shipment_package_items (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL
          REFERENCES shipment_packages(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position >= 0),
        order_id TEXT NOT NULL
          REFERENCES original_orders(id) ON DELETE RESTRICT,
        source_order_item_id TEXT NOT NULL,
        order_number TEXT NOT NULL,
        seller_account TEXT NOT NULL,
        buyer_nickname TEXT NOT NULL,
        source_title TEXT NOT NULL,
        source_spec TEXT NOT NULL,
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
        source_item_quantity INTEGER NOT NULL CHECK (source_item_quantity > 0),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
        created_at TEXT NOT NULL,
        UNIQUE (package_id, position),
        UNIQUE (package_id, source_order_item_id)
      ) STRICT;

      CREATE INDEX shipment_package_items_by_order_item
      ON shipment_package_items (source_order_item_id, package_id);

      CREATE TABLE shipment_package_cancellation_events (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL UNIQUE
          REFERENCES shipment_packages(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE shipment_record_void_events (
        id TEXT PRIMARY KEY,
        shipment_record_id TEXT NOT NULL UNIQUE
          REFERENCES shipment_records(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE shipment_package_logistics_change_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        package_id TEXT NOT NULL
          REFERENCES shipment_packages(id) ON DELETE RESTRICT,
        base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        before_shipping_carrier TEXT NOT NULL,
        before_tracking_number TEXT NOT NULL,
        after_shipping_carrier TEXT NOT NULL,
        after_tracking_number TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (package_id, result_revision)
      ) STRICT;

      CREATE TRIGGER shipment_records_are_immutable_on_update
      BEFORE UPDATE ON shipment_records
      BEGIN
        SELECT RAISE(ABORT, 'shipment records are immutable');
      END;

      CREATE TRIGGER shipment_records_are_immutable_on_delete
      BEFORE DELETE ON shipment_records
      BEGIN
        SELECT RAISE(ABORT, 'shipment records are immutable');
      END;

      CREATE TRIGGER shipment_package_items_are_immutable_on_update
      BEFORE UPDATE ON shipment_package_items
      BEGIN
        SELECT RAISE(ABORT, 'shipment package items are immutable');
      END;

      CREATE TRIGGER shipment_order_snapshots_are_immutable_on_update
      BEFORE UPDATE ON shipment_record_order_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'shipment order snapshots are immutable');
      END;

      CREATE TRIGGER shipment_order_snapshots_are_immutable_on_delete
      BEFORE DELETE ON shipment_record_order_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'shipment order snapshots are immutable');
      END;

      CREATE TRIGGER shipment_package_items_are_immutable_on_delete
      BEFORE DELETE ON shipment_package_items
      BEGIN
        SELECT RAISE(ABORT, 'shipment package items are immutable');
      END;

      CREATE TRIGGER shipment_package_cancellations_are_immutable_on_update
      BEFORE UPDATE ON shipment_package_cancellation_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment package cancellations are immutable');
      END;

      CREATE TRIGGER shipment_package_cancellations_are_immutable_on_delete
      BEFORE DELETE ON shipment_package_cancellation_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment package cancellations are immutable');
      END;

      CREATE TRIGGER shipment_record_void_events_are_immutable_on_update
      BEFORE UPDATE ON shipment_record_void_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment record void events are immutable');
      END;

      CREATE TRIGGER shipment_record_void_events_are_immutable_on_delete
      BEFORE DELETE ON shipment_record_void_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment record void events are immutable');
      END;

      CREATE TRIGGER shipment_package_logistics_changes_are_immutable_on_update
      BEFORE UPDATE ON shipment_package_logistics_change_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment package logistics changes are immutable');
      END;

      CREATE TRIGGER shipment_package_logistics_changes_are_immutable_on_delete
      BEFORE DELETE ON shipment_package_logistics_change_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment package logistics changes are immutable');
      END;
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (18, ?)')
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

function migrateToVersion19(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE shipment_group_archives (
        id TEXT PRIMARY KEY,
        source_group_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
        recipient TEXT NOT NULL,
        phone TEXT NOT NULL,
        phone_normalized TEXT NOT NULL,
        address_original TEXT NOT NULL,
        address_normalized TEXT NOT NULL,
        member_order_ids_json TEXT NOT NULL CHECK (
          json_valid(member_order_ids_json)
          AND json_type(member_order_ids_json) = 'array'
          AND json_array_length(member_order_ids_json) > 0
        ),
        member_recipient_snapshots_json TEXT NOT NULL CHECK (
          json_valid(member_recipient_snapshots_json)
          AND json_type(member_recipient_snapshots_json) = 'array'
          AND json_array_length(member_recipient_snapshots_json) > 0
        ),
        created_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (
          (status = 'open' AND completed_at IS NULL)
          OR (status = 'completed' AND completed_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX shipment_group_archives_by_source_group
      ON shipment_group_archives (source_group_id, status, created_at, id);

      ALTER TABLE shipment_records
      ADD COLUMN shipment_group_archive_id TEXT
        REFERENCES shipment_group_archives(id) ON DELETE RESTRICT;

      INSERT INTO shipment_group_archives (
        id, source_group_id, status,
        recipient, phone, phone_normalized,
        address_original, address_normalized,
        member_order_ids_json, member_recipient_snapshots_json,
        created_at, completed_at, updated_at
      )
      SELECT
        'legacy-shipment-group-archive-' || records.id,
        records.source_group_id,
        'completed',
        records.recipient,
        records.phone,
        records.phone_normalized,
        records.address_original,
        records.address_normalized,
        (
          SELECT json_group_array(order_id)
          FROM (
            SELECT DISTINCT snapshots.order_id AS order_id
            FROM shipment_record_order_snapshots AS snapshots
            WHERE snapshots.shipment_record_id = records.id
            ORDER BY snapshots.order_id
          )
        ),
        (
          SELECT json_group_array(json_object(
            'orderId', order_id,
            'recipient', recipient,
            'phone', phone,
            'addressOriginal', address_original
          ))
          FROM (
            SELECT
              snapshots.order_id,
              snapshots.recipient,
              snapshots.phone,
              snapshots.address_original
            FROM shipment_record_order_snapshots AS snapshots
            WHERE snapshots.shipment_record_id = records.id
            ORDER BY snapshots.order_id
          )
        ),
        records.created_at,
        records.created_at,
        records.created_at
      FROM shipment_records AS records;

      DROP TRIGGER shipment_records_are_immutable_on_update;

      UPDATE shipment_records
      SET shipment_group_archive_id = 'legacy-shipment-group-archive-' || id;

      CREATE TRIGGER shipment_records_are_immutable_on_update
      BEFORE UPDATE ON shipment_records
      BEGIN
        SELECT RAISE(ABORT, 'shipment records are immutable');
      END;

      CREATE TRIGGER shipment_records_require_archive_on_insert
      BEFORE INSERT ON shipment_records
      WHEN NEW.shipment_group_archive_id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'shipment record archive is required');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (19, ?)')
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

function migrateToVersion20(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE shipment_group_archives_v20 (
        id TEXT PRIMARY KEY,
        source_group_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('partially_shipped', 'fully_shipped')
        ),
        recipient TEXT NOT NULL,
        phone TEXT NOT NULL,
        phone_normalized TEXT NOT NULL,
        address_original TEXT NOT NULL,
        address_normalized TEXT NOT NULL,
        member_order_ids_json TEXT NOT NULL CHECK (
          json_valid(member_order_ids_json)
          AND json_type(member_order_ids_json) = 'array'
          AND json_array_length(member_order_ids_json) > 0
        ),
        member_recipient_snapshots_json TEXT NOT NULL CHECK (
          json_valid(member_recipient_snapshots_json)
          AND json_type(member_recipient_snapshots_json) = 'array'
          AND json_array_length(member_recipient_snapshots_json) > 0
        ),
        total_quantity INTEGER NOT NULL CHECK (total_quantity > 0),
        created_at TEXT NOT NULL,
        fully_shipped_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (
          (status = 'partially_shipped' AND fully_shipped_at IS NULL)
          OR (status = 'fully_shipped' AND fully_shipped_at IS NOT NULL)
        )
      ) STRICT;

      WITH archive_quantities AS (
        SELECT
          archives.*,
          COALESCE((
            SELECT SUM(items.quantity)
            FROM order_items AS items
            JOIN json_each(archives.member_order_ids_json) AS members
              ON members.value = items.order_id
          ), 0) AS member_quantity,
          COALESCE((
            SELECT SUM(items.quantity)
            FROM shipment_package_items AS items
            JOIN shipment_packages AS packages ON packages.id = items.package_id
            JOIN shipment_records AS records ON records.id = packages.shipment_record_id
            WHERE records.shipment_group_archive_id = archives.id
          ), 0) AS recorded_quantity,
          COALESCE((
            SELECT SUM(items.quantity)
            FROM shipment_package_items AS items
            JOIN shipment_packages AS packages ON packages.id = items.package_id
            JOIN shipment_records AS records ON records.id = packages.shipment_record_id
            LEFT JOIN shipment_package_cancellation_events AS cancellations
              ON cancellations.package_id = packages.id
            WHERE records.shipment_group_archive_id = archives.id
              AND cancellations.id IS NULL
          ), 0) AS shipped_quantity
        FROM shipment_group_archives AS archives
      ), normalized_archives AS (
        SELECT
          archive_quantities.*,
          CASE
            WHEN id LIKE 'legacy-shipment-group-archive-%' THEN recorded_quantity
            ELSE MAX(member_quantity, recorded_quantity)
          END AS total_quantity
        FROM archive_quantities
      )
      INSERT INTO shipment_group_archives_v20 (
        id, source_group_id, status,
        recipient, phone, phone_normalized,
        address_original, address_normalized,
        member_order_ids_json, member_recipient_snapshots_json,
        total_quantity, created_at, fully_shipped_at, updated_at
      )
      SELECT
        id,
        source_group_id,
        CASE
          WHEN shipped_quantity >= total_quantity THEN 'fully_shipped'
          ELSE 'partially_shipped'
        END,
        recipient,
        phone,
        phone_normalized,
        address_original,
        address_normalized,
        member_order_ids_json,
        member_recipient_snapshots_json,
        total_quantity,
        created_at,
        CASE
          WHEN shipped_quantity >= total_quantity THEN COALESCE(completed_at, updated_at)
          ELSE NULL
        END,
        updated_at
      FROM normalized_archives;

      DROP TABLE shipment_group_archives;
      ALTER TABLE shipment_group_archives_v20 RENAME TO shipment_group_archives;

      CREATE INDEX shipment_group_archives_by_source_group
      ON shipment_group_archives (source_group_id, status, created_at, id);
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (20, ?)')
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

type ShipmentArchiveMergeMigrationRow = {
  id: string;
  recipient: string;
  phone: string;
  phone_normalized: string;
  address_original: string;
  address_normalized: string;
  member_order_ids_json: string;
  member_recipient_snapshots_json: string;
  total_quantity: number;
  created_at: string;
  fully_shipped_at: string | null;
  updated_at: string;
};

function migrateToVersion21(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const archiveRows = database.prepare(`
      SELECT
        id,
        recipient,
        phone,
        phone_normalized,
        address_original,
        address_normalized,
        member_order_ids_json,
        member_recipient_snapshots_json,
        total_quantity,
        created_at,
        fully_shipped_at,
        updated_at
      FROM shipment_group_archives
      ORDER BY created_at, id
    `).all() as unknown as ShipmentArchiveMergeMigrationRow[];
    const parentByArchiveId = new Map(archiveRows.map(({ id }) => [id, id]));

    function rootOf(archiveId: string): string {
      const parentId = parentByArchiveId.get(archiveId);
      if (!parentId) throw new Error('旧版发货组档案归并关系无效');
      if (parentId === archiveId) return archiveId;
      const rootId = rootOf(parentId);
      parentByArchiveId.set(archiveId, rootId);
      return rootId;
    }

    function joinArchives(leftId: string, rightId: string): void {
      const leftRoot = rootOf(leftId);
      const rightRoot = rootOf(rightId);
      if (leftRoot === rightRoot) return;
      parentByArchiveId.set(rightRoot, leftRoot);
    }

    const firstArchiveIdByOrderId = new Map<string, string>();
    const orderIdsByArchiveId = new Map<string, string[]>();
    const snapshotsByArchiveId = new Map<
      string,
      StoredShipmentArchiveRecipientSnapshot[]
    >();
    for (const archive of archiveRows) {
      const orderIds = parseStoredShipmentArchiveOrderIds(
        archive.member_order_ids_json,
        '旧版发货组档案成员订单格式错误',
      );
      const snapshots = parseStoredShipmentArchiveRecipientSnapshots(
        archive.member_recipient_snapshots_json,
        '旧版发货组档案成员收货快照格式错误',
      );
      const orderIdSet = new Set(orderIds);
      if (
        snapshots.length !== orderIds.length ||
        snapshots.some(({ orderId }) => !orderIdSet.has(orderId))
      ) {
        throw new Error('旧版发货组档案成员与收货快照不一致');
      }
      orderIdsByArchiveId.set(archive.id, orderIds);
      snapshotsByArchiveId.set(archive.id, snapshots);
      for (const orderId of orderIds) {
        const firstArchiveId = firstArchiveIdByOrderId.get(orderId);
        if (firstArchiveId) joinArchives(firstArchiveId, archive.id);
        else firstArchiveIdByOrderId.set(orderId, archive.id);
      }
    }

    const archivesByRootId = new Map<string, ShipmentArchiveMergeMigrationRow[]>();
    for (const archive of archiveRows) {
      const rootId = rootOf(archive.id);
      const component = archivesByRootId.get(rootId) ?? [];
      component.push(archive);
      archivesByRootId.set(rootId, component);
    }
    const legacyConnectedComponents = [...archivesByRootId.values()]
      .filter((component) => (
        component.some(({ id }) => (
          id.startsWith('legacy-shipment-group-archive-')
        ))
      ));

    if (legacyConnectedComponents.length > 0) {
      const reassignsRecords = legacyConnectedComponents.some(
        (component) => component.length > 1,
      );
      if (reassignsRecords) {
        database.exec('DROP TRIGGER shipment_records_are_immutable_on_update;');
      }
      const reassignRecord = database.prepare(`
        UPDATE shipment_records
        SET shipment_group_archive_id = ?
        WHERE shipment_group_archive_id = ?
      `);
      const updateCanonicalArchive = database.prepare(`
        UPDATE shipment_group_archives
        SET
          status = ?,
          recipient = ?,
          phone = ?,
          phone_normalized = ?,
          address_original = ?,
          address_normalized = ?,
          member_order_ids_json = ?,
          member_recipient_snapshots_json = ?,
          total_quantity = ?,
          created_at = ?,
          fully_shipped_at = ?,
          updated_at = ?
        WHERE id = ?
      `);
      const deleteArchive = database.prepare(`
        DELETE FROM shipment_group_archives
        WHERE id = ?
      `);
      const activeQuantityForArchive = database.prepare(`
        SELECT COALESCE(SUM(items.quantity), 0) AS quantity
        FROM shipment_package_items AS items
        JOIN shipment_packages AS packages ON packages.id = items.package_id
        JOIN shipment_records AS records ON records.id = packages.shipment_record_id
        LEFT JOIN shipment_package_cancellation_events AS cancellations
          ON cancellations.package_id = packages.id
        WHERE records.shipment_group_archive_id = ?
          AND cancellations.id IS NULL
      `);

      for (const component of legacyConnectedComponents) {
        component.sort((left, right) => (
          left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
        ));
        const [canonicalArchive, ...duplicateArchives] = component;
        for (const duplicateArchive of duplicateArchives) {
          reassignRecord.run(canonicalArchive.id, duplicateArchive.id);
        }

        const mergedOrderIds = [...new Set(component.flatMap((archive) => {
          const orderIds = orderIdsByArchiveId.get(archive.id);
          if (!orderIds) throw new Error('旧版发货组档案成员订单缺失');
          return orderIds;
        }))].sort();
        const preferredFinalArchive = component
          .filter(({ id }) => !id.startsWith('legacy-shipment-group-archive-'))
          .reduce<ShipmentArchiveMergeMigrationRow | null>((latest, archive) => {
            if (!latest) return archive;
            if (archive.created_at !== latest.created_at) {
              return archive.created_at > latest.created_at ? archive : latest;
            }
            return archive.id > latest.id ? archive : latest;
          }, null) ?? canonicalArchive;
        const snapshotByOrderId = new Map<
          string,
          StoredShipmentArchiveRecipientSnapshot
        >();
        for (const archive of [...component].reverse()) {
          const snapshots = snapshotsByArchiveId.get(archive.id);
          if (!snapshots) throw new Error('旧版发货组档案成员收货快照缺失');
          for (const snapshot of snapshots) {
            if (!snapshotByOrderId.has(snapshot.orderId)) {
              snapshotByOrderId.set(snapshot.orderId, snapshot);
            }
          }
        }
        if (mergedOrderIds.some((orderId) => !snapshotByOrderId.has(orderId))) {
          throw new Error('旧版发货组档案缺少成员收货快照');
        }
        const mergedTotalQuantity = deduplicatedShipmentArchiveQuantity(
          database,
          canonicalArchive.id,
          mergedOrderIds,
        );
        const preservedComponentQuantity = component.reduce(
          (largest, archive) => Math.max(largest, archive.total_quantity),
          0,
        );
        const finalMergedTotalQuantity = Math.max(
          mergedTotalQuantity,
          preservedComponentQuantity,
        );
        const activeQuantityRow = activeQuantityForArchive.get(
          canonicalArchive.id,
        ) as { quantity: number };
        const fullyShipped = activeQuantityRow.quantity >= finalMergedTotalQuantity;
        const updatedAt = component.reduce((latest, archive) => (
          archive.updated_at > latest ? archive.updated_at : latest
        ), canonicalArchive.updated_at);
        const fullyShippedAt = fullyShipped
          ? component.reduce<string | null>((latest, archive) => {
            const candidate = archive.fully_shipped_at;
            if (!candidate) return latest;
            return !latest || candidate > latest ? candidate : latest;
          }, null) ?? updatedAt
          : null;
        updateCanonicalArchive.run(
          fullyShipped ? 'fully_shipped' : 'partially_shipped',
          preferredFinalArchive.recipient,
          preferredFinalArchive.phone,
          preferredFinalArchive.phone_normalized,
          preferredFinalArchive.address_original,
          preferredFinalArchive.address_normalized,
          JSON.stringify(mergedOrderIds),
          JSON.stringify(mergedOrderIds.map((orderId) => snapshotByOrderId.get(orderId))),
          finalMergedTotalQuantity,
          canonicalArchive.created_at,
          fullyShippedAt,
          updatedAt,
          canonicalArchive.id,
        );
        for (const duplicateArchive of duplicateArchives) {
          deleteArchive.run(duplicateArchive.id);
        }
      }

      if (reassignsRecords) {
        database.exec(`
          CREATE TRIGGER shipment_records_are_immutable_on_update
          BEFORE UPDATE ON shipment_records
          BEGIN
            SELECT RAISE(ABORT, 'shipment records are immutable');
          END;
        `);
      }
    }

    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (21, ?)')
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

type ShipmentArchiveQuantityRepairRow = {
  id: string;
  member_order_ids_json: string;
  total_quantity: number;
  created_at: string;
  fully_shipped_at: string | null;
  updated_at: string;
};

function migrateToVersion22(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const version21Migration = database.prepare(`
      SELECT applied_at
      FROM schema_migrations
      WHERE version = 21
    `).get() as { applied_at: string } | undefined;
    const version21AppliedAt = version21Migration?.applied_at;
    if (!version21AppliedAt) {
      throw new Error('发货组档案去重升级记录缺失');
    }
    const archives = database.prepare(`
      SELECT
        id,
        member_order_ids_json,
        total_quantity,
        created_at,
        fully_shipped_at,
        updated_at
      FROM shipment_group_archives
      ORDER BY created_at, id
    `).all() as unknown as ShipmentArchiveQuantityRepairRow[];
    const activeQuantityForArchive = database.prepare(`
      SELECT COALESCE(SUM(items.quantity), 0) AS quantity
      FROM shipment_package_items AS items
      JOIN shipment_packages AS packages ON packages.id = items.package_id
      JOIN shipment_records AS records ON records.id = packages.shipment_record_id
      LEFT JOIN shipment_package_cancellation_events AS cancellations
        ON cancellations.package_id = packages.id
      WHERE records.shipment_group_archive_id = ?
        AND cancellations.id IS NULL
    `);
    const repairArchive = database.prepare(`
      UPDATE shipment_group_archives
      SET status = ?, total_quantity = ?, fully_shipped_at = ?
      WHERE id = ?
    `);
    const recordsAtVersion21 = database.prepare(`
      SELECT COUNT(*) AS count
      FROM shipment_records
      WHERE shipment_group_archive_id = ?
        AND created_at <= ?
    `);

    for (const archive of archives) {
      if (!archive.id.startsWith('legacy-shipment-group-archive-')) continue;
      const recordCountRow = recordsAtVersion21.get(
        archive.id,
        version21AppliedAt,
      ) as { count: number };
      if (recordCountRow.count < 2) continue;
      const orderIds = parseStoredShipmentArchiveOrderIds(
        archive.member_order_ids_json,
        '发货组档案成员订单格式错误',
      );
      if (shipmentItemIdentityChangedAfter(
        database,
        orderIds,
        archive.created_at,
      )) continue;
      const deduplicatedQuantity = deduplicatedShipmentArchiveQuantity(
        database,
        archive.id,
        orderIds,
        version21AppliedAt,
      );
      if (archive.total_quantity <= deduplicatedQuantity) continue;
      const activeQuantityRow = activeQuantityForArchive.get(
        archive.id,
      ) as { quantity: number };
      const fullyShipped = activeQuantityRow.quantity >= deduplicatedQuantity;
      repairArchive.run(
        fullyShipped ? 'fully_shipped' : 'partially_shipped',
        deduplicatedQuantity,
        fullyShipped ? archive.fully_shipped_at ?? archive.updated_at : null,
        archive.id,
      );
    }

    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (22, ?)')
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

function migrateToVersion23(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const packageColumns = database.prepare('PRAGMA table_info(shipment_packages)').all() as unknown as Array<{
      name: string;
    }>;
    if (!packageColumns.some(({ name }) => name === 'logistics_status')) {
      database.exec(`
        ALTER TABLE shipment_packages
        ADD COLUMN logistics_status TEXT NOT NULL DEFAULT 'in_transit'
          CHECK (logistics_status IN (
            'awaiting_carrier',
            'in_transit',
            'delivered',
            'intercepting',
            'intercepted_returned',
            'lost',
            'exception'
          ));
      `);
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS shipment_package_logistics_status_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        package_id TEXT NOT NULL
          REFERENCES shipment_packages(id) ON DELETE RESTRICT,
        base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        before_status TEXT NOT NULL CHECK (before_status IN (
          'awaiting_carrier', 'in_transit', 'delivered', 'intercepting',
          'intercepted_returned', 'lost', 'exception'
        )),
        after_status TEXT NOT NULL CHECK (after_status IN (
          'awaiting_carrier', 'in_transit', 'delivered', 'intercepting',
          'intercepted_returned', 'lost', 'exception'
        )),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL,
        UNIQUE (package_id, result_revision)
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS shipment_package_logistics_status_events_are_immutable_on_update
      BEFORE UPDATE ON shipment_package_logistics_status_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment package logistics status events are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS shipment_package_logistics_status_events_are_immutable_on_delete
      BEFORE DELETE ON shipment_package_logistics_status_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment package logistics status events are immutable');
      END;
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (23, ?)')
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

function migrateToVersion24(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS aftersales_cases (
        id TEXT PRIMARY KEY,
        shipment_record_id TEXT NOT NULL
          REFERENCES shipment_records(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN (
          'processing', 'waiting_return', 'waiting_inspection', 'waiting_refund',
          'waiting_replacement', 'partially_completed', 'completed'
        )),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS aftersales_cases_by_record_and_status
      ON aftersales_cases (shipment_record_id, status, occurred_at, id);

      CREATE TABLE IF NOT EXISTS aftersales_case_items (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL
          REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
        shipment_package_item_id TEXT NOT NULL
          REFERENCES shipment_package_items(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        UNIQUE (case_id, shipment_package_item_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS aftersales_case_items_by_shipment_item
      ON aftersales_case_items (shipment_package_item_id, case_id);

      CREATE TABLE IF NOT EXISTS aftersales_case_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        case_id TEXT NOT NULL
          REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('created', 'updated')),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        before_snapshot_json TEXT CHECK (
          before_snapshot_json IS NULL OR json_valid(before_snapshot_json)
        ),
        after_snapshot_json TEXT NOT NULL CHECK (json_valid(after_snapshot_json)),
        change_reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (case_id, result_revision),
        CHECK (
          (kind = 'created' AND base_revision = 0 AND before_snapshot_json IS NULL)
          OR (kind = 'updated' AND base_revision >= 1 AND before_snapshot_json IS NOT NULL)
        )
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS aftersales_case_events_are_immutable_on_update
      BEFORE UPDATE ON aftersales_case_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales case events are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS aftersales_case_events_are_immutable_on_delete
      BEFORE DELETE ON aftersales_case_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales case events are immutable');
      END;
    `);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (24, ?)')
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

function migrateToVersion25(database: DatabaseSync): void {
  const migratedAt = new Date().toISOString();
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE original_orders_v25 (
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
            'pending_shipment', 'partially_shipped', 'shipped',
            'delivered', 'unknown'
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

      INSERT INTO original_orders_v25 (
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
        platform_transaction_status,
        CASE fulfillment_status WHEN 'returned' THEN 'unknown' ELSE fulfillment_status END,
        lifecycle_status,
        created_at, updated_at, revision,
        seller_account_normalized, platform_order_number_normalized,
        note, shipping_carrier, tracking_number
      FROM original_orders;

      DROP TABLE original_orders;
      ALTER TABLE original_orders_v25 RENAME TO original_orders;

      CREATE UNIQUE INDEX original_orders_by_normalized_identity
      ON original_orders (
        platform,
        seller_account_normalized,
        platform_order_number_normalized
      );
    `);
    const orderChangeEventsTable = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'order_change_events'
    `).get();
    if (orderChangeEventsTable) database.exec(`
      CREATE TABLE order_change_events_v25 (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES original_orders(id) ON DELETE RESTRICT,
        source_snapshot_id TEXT UNIQUE
          REFERENCES source_snapshots(id) ON DELETE RESTRICT,
        source TEXT NOT NULL
          CHECK (source IN ('source_update', 'manual_edit', 'shipment_sync')),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        created_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO order_change_events_v25 (
        id, order_id, source_snapshot_id, source,
        base_revision, result_revision, created_at
      )
      SELECT
        id, order_id, source_snapshot_id, source,
        base_revision, result_revision, created_at
      FROM order_change_events;

      DROP TABLE order_change_events;
      ALTER TABLE order_change_events_v25 RENAME TO order_change_events;

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
    `);
    const shipmentItemsTable = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'shipment_package_items'
    `).get();
    if (orderChangeEventsTable && shipmentItemsTable) {
      new OrderFulfillmentProjectionService(database)
        .synchronizeExistingShipmentOrders(migratedAt);
    }
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (25, ?)')
      .run(migratedAt);
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

function migrateToVersion26(database: DatabaseSync): void {
  const migratedAt = new Date().toISOString();
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    rebuildFulfillmentStatusTablesForVersion26(database);
    database.exec(`
      UPDATE table_templates
      SET configuration_json = json_remove(
        configuration_json,
        '$.query.fulfillmentStatus'
      )
      WHERE granularity = 'order'
        AND json_extract(configuration_json, '$.query.fulfillmentStatus') = 'returned';
    `);
    new OrderFulfillmentProjectionService(database)
      .synchronizeExistingShipmentOrders(migratedAt);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (26, ?)')
      .run(migratedAt);
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

function migrateToVersion27(database: DatabaseSync): void {
  const migratedAt = new Date().toISOString();
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE original_orders ADD COLUMN system_order_number TEXT;
    `);
    const orders = database.prepare(`
      SELECT id, created_at
      FROM original_orders
      ORDER BY created_at, id
    `).all() as unknown as Array<{ id: string; created_at: string }>;
    const dailySequences = new Map<string, number>();
    const assignNumber = database.prepare(`
      UPDATE original_orders
      SET system_order_number = ?
      WHERE id = ? AND system_order_number IS NULL
    `);
    for (const order of orders) {
      const dateKey = shanghaiDateKey(order.created_at);
      const sequence = (dailySequences.get(dateKey) ?? 0) + 1;
      dailySequences.set(dateKey, sequence);
      assignNumber.run(systemOrderNumberForSequence(dateKey, sequence), order.id);
    }
    const orderCreateSql = storedCreateTableSql(database, 'original_orders');
    const renamedOrderCreateSql = orderCreateSql.replace(
      /CREATE TABLE "?original_orders"?/u,
      'CREATE TABLE original_orders_v27',
    );
    if (renamedOrderCreateSql === orderCreateSql) {
      throw new Error('无法重建原始订单表');
    }
    const orderV27Sql = renamedOrderCreateSql.replace(
      'system_order_number TEXT',
      `system_order_number TEXT NOT NULL CHECK (
        system_order_number GLOB
          '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
        AND substr(system_order_number, 10, 6) <> '000000'
      )`,
    );
    if (orderV27Sql === renamedOrderCreateSql) {
      throw new Error('无法为系统订单编号建立数据库约束');
    }
    database.exec(`${orderV27Sql};`);
    const orderColumns = storedTableColumnNames(database, 'original_orders');
    const orderColumnList = orderColumns.map((column) => `"${column}"`).join(', ');
    database.exec(`
      INSERT INTO original_orders_v27 (${orderColumnList})
      SELECT ${orderColumnList} FROM original_orders;

      DROP TABLE original_orders;
      ALTER TABLE original_orders_v27 RENAME TO original_orders;

      CREATE UNIQUE INDEX original_orders_by_normalized_identity
      ON original_orders (
        platform,
        seller_account_normalized,
        platform_order_number_normalized
      );

      CREATE UNIQUE INDEX original_orders_by_system_order_number
      ON original_orders (system_order_number);

      CREATE TRIGGER original_orders_require_system_order_number_on_insert
      BEFORE INSERT ON original_orders
      WHEN NEW.system_order_number IS NULL
        OR NEW.system_order_number NOT GLOB
          '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
        OR substr(NEW.system_order_number, 10, 6) = '000000'
      BEGIN
        SELECT RAISE(ABORT, 'system order number is required');
      END;

      CREATE TRIGGER original_orders_system_order_number_is_immutable
      BEFORE UPDATE OF system_order_number ON original_orders
      WHEN NEW.system_order_number IS NOT OLD.system_order_number
      BEGIN
        SELECT RAISE(ABORT, 'system order number is immutable');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (27, ?)')
      .run(migratedAt);
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

function migrateToVersion28(database: DatabaseSync): void {
  const caseColumns = storedTableColumnNames(database, 'aftersales_cases');
  const workflowProjection = caseColumns.includes('workflow') ? 'workflow' : "'general'";
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE aftersales_cases_v28 (
        id TEXT PRIMARY KEY,
        shipment_record_id TEXT NOT NULL
          REFERENCES shipment_records(id) ON DELETE RESTRICT,
        workflow TEXT NOT NULL
          CHECK (workflow IN ('general', 'refund_only', 'return_refund')),
        status TEXT NOT NULL CHECK (status IN (
          'processing', 'waiting_return', 'waiting_inspection', 'waiting_refund',
          'waiting_replacement', 'partially_completed', 'ready_to_complete',
          'completed', 'cancelled'
        )),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO aftersales_cases_v28 (
        id, shipment_record_id, workflow, status, revision, reason,
        occurred_at, created_at, updated_at
      )
      SELECT
        id, shipment_record_id, ${workflowProjection}, status, revision, reason,
        occurred_at, created_at, updated_at
      FROM aftersales_cases;

      DROP TABLE aftersales_cases;
      ALTER TABLE aftersales_cases_v28 RENAME TO aftersales_cases;

      CREATE INDEX aftersales_cases_by_record_and_status
      ON aftersales_cases (shipment_record_id, status, occurred_at, id);

      CREATE TABLE IF NOT EXISTS pending_financial_items (
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

      CREATE TABLE IF NOT EXISTS pending_financial_item_events (
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

      CREATE TABLE IF NOT EXISTS financial_records (
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

      CREATE TABLE IF NOT EXISTS aftersales_return_records (
        id TEXT PRIMARY KEY,
        aftersales_case_id TEXT NOT NULL
          REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('in_transit', 'received', 'inspected')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        shipping_carrier TEXT NOT NULL CHECK (length(trim(shipping_carrier)) BETWEEN 1 AND 100),
        tracking_number TEXT NOT NULL CHECK (length(trim(tracking_number)) BETWEEN 1 AND 200),
        occurred_at TEXT NOT NULL,
        received_at TEXT,
        inspection_result TEXT CHECK (
          inspection_result IS NULL
          OR inspection_result IN ('resellable', 'defective', 'scrapped', 'other')
        ),
        inspection_note TEXT,
        inspected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (
            status = 'in_transit' AND received_at IS NULL
            AND inspection_result IS NULL AND inspection_note IS NULL AND inspected_at IS NULL
          )
          OR (
            status = 'received' AND received_at IS NOT NULL
            AND inspection_result IS NULL AND inspection_note IS NULL AND inspected_at IS NULL
          )
          OR (
            status = 'inspected' AND received_at IS NOT NULL
            AND inspection_result IS NOT NULL AND inspection_note IS NOT NULL
            AND inspected_at IS NOT NULL
            AND length(trim(inspection_note)) BETWEEN 1 AND 500
          )
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS aftersales_return_record_items (
        id TEXT PRIMARY KEY,
        return_record_id TEXT NOT NULL
          REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
        shipment_package_item_id TEXT NOT NULL
          REFERENCES shipment_package_items(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        UNIQUE (return_record_id, shipment_package_item_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS aftersales_return_record_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        return_record_id TEXT NOT NULL
          REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('registered', 'received', 'inspected')),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        occurred_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        inspection_result TEXT CHECK (
          inspection_result IS NULL
          OR inspection_result IN ('resellable', 'defective', 'scrapped', 'other')
        ),
        created_at TEXT NOT NULL,
        UNIQUE (return_record_id, result_revision),
        CHECK (
          (kind = 'registered' AND base_revision = 0 AND inspection_result IS NULL)
          OR (kind = 'received' AND base_revision >= 1 AND inspection_result IS NULL)
          OR (kind = 'inspected' AND base_revision >= 1 AND inspection_result IS NOT NULL)
        )
      ) STRICT;

      CREATE TRIGGER IF NOT EXISTS pending_financial_item_events_are_immutable_on_update
      BEFORE UPDATE ON pending_financial_item_events
      BEGIN
        SELECT RAISE(ABORT, 'pending financial item events are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS pending_financial_item_events_are_immutable_on_delete
      BEFORE DELETE ON pending_financial_item_events
      BEGIN
        SELECT RAISE(ABORT, 'pending financial item events are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS financial_records_are_immutable_on_update
      BEFORE UPDATE ON financial_records
      BEGIN
        SELECT RAISE(ABORT, 'financial records are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS financial_records_are_immutable_on_delete
      BEFORE DELETE ON financial_records
      BEGIN
        SELECT RAISE(ABORT, 'financial records are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS aftersales_return_record_events_are_immutable_on_update
      BEFORE UPDATE ON aftersales_return_record_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales return record events are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS aftersales_return_record_events_are_immutable_on_delete
      BEFORE DELETE ON aftersales_return_record_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales return record events are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS aftersales_return_record_items_are_immutable_on_update
      BEFORE UPDATE ON aftersales_return_record_items
      BEGIN
        SELECT RAISE(ABORT, 'aftersales return record items are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS aftersales_return_record_items_are_immutable_on_delete
      BEFORE DELETE ON aftersales_return_record_items
      BEGIN
        SELECT RAISE(ABORT, 'aftersales return record items are immutable');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (28, ?)')
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

function migrateToVersion29(database: DatabaseSync): void {
  const recordColumns = storedTableColumnNames(database, 'aftersales_return_records');
  const itemColumns = storedTableColumnNames(database, 'aftersales_return_record_items');
  const eventColumns = storedTableColumnNames(database, 'aftersales_return_record_events');
  const carrierClaimTable = database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'carrier_claims'
  `).get();
  if (
    recordColumns.includes('logistics_status')
    && itemColumns.includes('aftersales_case_id')
    && eventColumns.includes('payload_json')
    && carrierClaimTable
  ) {
    database
      .prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (29, ?)')
      .run(new Date().toISOString());
    return;
  }
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE aftersales_return_records ADD COLUMN logistics_status TEXT NOT NULL
        DEFAULT 'in_transit' CHECK (logistics_status IN (
          'awaiting_carrier', 'in_transit', 'delivered', 'intercepting',
          'returned_to_buyer', 'lost', 'delivery_dispute', 'damaged',
          'misdelivered', 'exception'
        ));
      ALTER TABLE aftersales_return_records ADD COLUMN carrier_accepted_at TEXT;
      ALTER TABLE aftersales_return_records ADD COLUMN discrepancies_json TEXT NOT NULL
        DEFAULT '[]' CHECK (json_valid(discrepancies_json));

      UPDATE aftersales_return_records
      SET logistics_status = CASE
            WHEN status IN ('received', 'inspected') THEN 'delivered'
            ELSE 'in_transit'
          END,
          carrier_accepted_at = CASE
            WHEN status IN ('received', 'inspected') THEN received_at
            ELSE NULL
          END;

      DROP TRIGGER IF EXISTS aftersales_return_record_items_are_immutable_on_update;
      DROP TRIGGER IF EXISTS aftersales_return_record_items_are_immutable_on_delete;

      CREATE TABLE aftersales_return_record_items_v29 (
        id TEXT PRIMARY KEY,
        return_record_id TEXT NOT NULL
          REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
        aftersales_case_id TEXT NOT NULL
          REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
        shipment_package_item_id TEXT NOT NULL
          REFERENCES shipment_package_items(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        received_quantity INTEGER NOT NULL CHECK (received_quantity >= 0),
        accepted_quantity INTEGER NOT NULL CHECK (
          accepted_quantity >= 0 AND accepted_quantity <= received_quantity
        ),
        inspection_result TEXT CHECK (
          inspection_result IS NULL
          OR inspection_result IN ('resellable', 'defective', 'scrapped', 'other')
        ),
        inspection_note TEXT,
        UNIQUE (return_record_id, aftersales_case_id, shipment_package_item_id),
        CHECK (
          (inspection_result IS NULL AND inspection_note IS NULL AND accepted_quantity = 0)
          OR (
            inspection_result IS NOT NULL AND inspection_note IS NOT NULL
            AND length(trim(inspection_note)) BETWEEN 1 AND 500
          )
        )
      ) STRICT;

      INSERT INTO aftersales_return_record_items_v29 (
        id, return_record_id, aftersales_case_id, shipment_package_item_id,
        quantity, received_quantity, accepted_quantity,
        inspection_result, inspection_note
      )
      SELECT
        items.id,
        items.return_record_id,
        records.aftersales_case_id,
        items.shipment_package_item_id,
        items.quantity,
        CASE WHEN records.status IN ('received', 'inspected') THEN items.quantity ELSE 0 END,
        CASE WHEN records.status = 'inspected' THEN items.quantity ELSE 0 END,
        CASE WHEN records.status = 'inspected' THEN records.inspection_result ELSE NULL END,
        CASE WHEN records.status = 'inspected' THEN records.inspection_note ELSE NULL END
      FROM aftersales_return_record_items AS items
      JOIN aftersales_return_records AS records ON records.id = items.return_record_id;

      DROP TABLE aftersales_return_record_items;
      ALTER TABLE aftersales_return_record_items_v29
        RENAME TO aftersales_return_record_items;

      CREATE INDEX aftersales_return_items_by_case
      ON aftersales_return_record_items (aftersales_case_id, return_record_id, id);

      CREATE TRIGGER aftersales_return_record_item_identity_is_immutable
      BEFORE UPDATE OF return_record_id, aftersales_case_id, shipment_package_item_id, quantity
      ON aftersales_return_record_items
      BEGIN
        SELECT RAISE(ABORT, 'aftersales return record item identity is immutable');
      END;

      CREATE TRIGGER aftersales_return_record_items_are_immutable_on_delete
      BEFORE DELETE ON aftersales_return_record_items
      BEGIN
        SELECT RAISE(ABORT, 'aftersales return record items are immutable');
      END;

      DROP TRIGGER IF EXISTS aftersales_return_record_events_are_immutable_on_update;
      DROP TRIGGER IF EXISTS aftersales_return_record_events_are_immutable_on_delete;

      CREATE TABLE aftersales_return_record_events_v29 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        return_record_id TEXT NOT NULL
          REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN (
          'registered', 'items_combined', 'logistics_corrected',
          'logistics_status_updated', 'received', 'inspected'
        )),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        occurred_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        inspection_result TEXT CHECK (
          inspection_result IS NULL
          OR inspection_result IN ('resellable', 'defective', 'scrapped', 'other')
        ),
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        UNIQUE (return_record_id, result_revision),
        CHECK (
          (kind = 'registered' AND base_revision = 0 AND inspection_result IS NULL)
          OR (kind <> 'registered' AND base_revision >= 1)
        )
      ) STRICT;

      INSERT INTO aftersales_return_record_events_v29 (
        sequence, id, return_record_id, kind, base_revision, result_revision,
        occurred_at, reason, inspection_result, payload_json, created_at
      )
      SELECT
        sequence, id, return_record_id, kind, base_revision, result_revision,
        occurred_at, reason, inspection_result, '{}', created_at
      FROM aftersales_return_record_events;

      DROP TABLE aftersales_return_record_events;
      ALTER TABLE aftersales_return_record_events_v29
        RENAME TO aftersales_return_record_events;

      CREATE TRIGGER aftersales_return_record_events_are_immutable_on_update
      BEFORE UPDATE ON aftersales_return_record_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales return record events are immutable');
      END;

      CREATE TRIGGER aftersales_return_record_events_are_immutable_on_delete
      BEFORE DELETE ON aftersales_return_record_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales return record events are immutable');
      END;

      CREATE TABLE carrier_claims (
        id TEXT PRIMARY KEY,
        return_record_id TEXT NOT NULL UNIQUE
          REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        requested_amount_cents INTEGER NOT NULL CHECK (requested_amount_cents > 0),
        approved_amount_cents INTEGER CHECK (approved_amount_cents > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (status = 'pending' AND approved_amount_cents IS NULL)
          OR (status = 'rejected' AND approved_amount_cents IS NULL)
          OR (status IN ('approved', 'paid') AND approved_amount_cents IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE carrier_claim_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        claim_id TEXT NOT NULL REFERENCES carrier_claims(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN (
          'opened', 'approved', 'rejected', 'compensation_confirmed'
        )),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        occurred_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        amount_cents INTEGER CHECK (amount_cents > 0),
        created_at TEXT NOT NULL,
        UNIQUE (claim_id, result_revision),
        CHECK (
          (kind = 'opened' AND base_revision = 0 AND amount_cents IS NOT NULL)
          OR (kind = 'approved' AND base_revision >= 1 AND amount_cents IS NOT NULL)
          OR (kind = 'rejected' AND base_revision >= 1 AND amount_cents IS NULL)
          OR (kind = 'compensation_confirmed' AND base_revision >= 1 AND amount_cents IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE carrier_compensation_records (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL UNIQUE REFERENCES carrier_claims(id) ON DELETE RESTRICT,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        occurred_at TEXT NOT NULL,
        note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER carrier_claim_events_are_immutable_on_update
      BEFORE UPDATE ON carrier_claim_events
      BEGIN
        SELECT RAISE(ABORT, 'carrier claim events are immutable');
      END;

      CREATE TRIGGER carrier_claim_events_are_immutable_on_delete
      BEFORE DELETE ON carrier_claim_events
      BEGIN
        SELECT RAISE(ABORT, 'carrier claim events are immutable');
      END;

      CREATE TRIGGER carrier_compensation_records_are_immutable_on_update
      BEFORE UPDATE ON carrier_compensation_records
      BEGIN
        SELECT RAISE(ABORT, 'carrier compensation records are immutable');
      END;

      CREATE TRIGGER carrier_compensation_records_are_immutable_on_delete
      BEFORE DELETE ON carrier_compensation_records
      BEGIN
        SELECT RAISE(ABORT, 'carrier compensation records are immutable');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (29, ?)')
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

function migrateToVersion30(database: DatabaseSync): void {
  const logisticsChangeColumns = storedTableColumnNames(
    database,
    'shipment_package_logistics_change_events',
  );
  const addLogisticsChangeOccurredAt = logisticsChangeColumns.includes('occurred_at')
    ? ''
    : `ALTER TABLE shipment_package_logistics_change_events
         ADD COLUMN occurred_at TEXT NOT NULL DEFAULT '';`;
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE shipment_packages_v30 (
        id TEXT PRIMARY KEY,
        shipment_record_id TEXT NOT NULL
          REFERENCES shipment_records(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK (position >= 0),
        shipping_carrier TEXT NOT NULL,
        tracking_number TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        logistics_status TEXT NOT NULL DEFAULT 'in_transit'
          CHECK (logistics_status IN (
            'awaiting_carrier', 'in_transit', 'delivered', 'intercepting',
            'intercepted_returned', 'lost', 'delivery_dispute', 'damaged',
            'misdelivered', 'exception'
          )),
        carrier_accepted_at TEXT,
        UNIQUE (shipment_record_id, position),
        CHECK (logistics_status <> 'awaiting_carrier' OR carrier_accepted_at IS NULL)
      ) STRICT;

      INSERT INTO shipment_packages_v30 (
        id, shipment_record_id, position, shipping_carrier, tracking_number,
        revision, created_at, logistics_status, carrier_accepted_at
      )
      SELECT
        id, shipment_record_id, position, shipping_carrier, tracking_number,
        revision, created_at, logistics_status, NULL
      FROM shipment_packages;

      DROP TABLE shipment_packages;
      ALTER TABLE shipment_packages_v30 RENAME TO shipment_packages;

      DROP TRIGGER IF EXISTS shipment_package_logistics_status_events_are_immutable_on_update;
      DROP TRIGGER IF EXISTS shipment_package_logistics_status_events_are_immutable_on_delete;

      CREATE TABLE shipment_package_logistics_status_events_v30 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        package_id TEXT NOT NULL
          REFERENCES shipment_packages(id) ON DELETE RESTRICT,
        base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        before_status TEXT NOT NULL CHECK (before_status IN (
          'awaiting_carrier', 'in_transit', 'delivered', 'intercepting',
          'intercepted_returned', 'lost', 'delivery_dispute', 'damaged',
          'misdelivered', 'exception'
        )),
        after_status TEXT NOT NULL CHECK (after_status IN (
          'awaiting_carrier', 'in_transit', 'delivered', 'intercepting',
          'intercepted_returned', 'lost', 'delivery_dispute', 'damaged',
          'misdelivered', 'exception'
        )),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        UNIQUE (package_id, result_revision)
      ) STRICT;

      INSERT INTO shipment_package_logistics_status_events_v30 (
        sequence, id, package_id, base_revision, result_revision,
        before_status, after_status, reason, occurred_at, payload_json, created_at
      )
      SELECT
        sequence, id, package_id, base_revision, result_revision,
        before_status, after_status, reason, created_at, '{}', created_at
      FROM shipment_package_logistics_status_events;

      DROP TABLE shipment_package_logistics_status_events;
      ALTER TABLE shipment_package_logistics_status_events_v30
        RENAME TO shipment_package_logistics_status_events;

      CREATE TRIGGER shipment_package_logistics_status_events_are_immutable_on_update
      BEFORE UPDATE ON shipment_package_logistics_status_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment package logistics status events are immutable');
      END;

      CREATE TRIGGER shipment_package_logistics_status_events_are_immutable_on_delete
      BEFORE DELETE ON shipment_package_logistics_status_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment package logistics status events are immutable');
      END;

      DROP TRIGGER IF EXISTS shipment_package_logistics_changes_are_immutable_on_update;
      DROP TRIGGER IF EXISTS shipment_package_logistics_changes_are_immutable_on_delete;

      ${addLogisticsChangeOccurredAt}
      UPDATE shipment_package_logistics_change_events
      SET occurred_at = created_at
      WHERE occurred_at = '';

      CREATE TRIGGER shipment_package_logistics_changes_are_immutable_on_update
      BEFORE UPDATE ON shipment_package_logistics_change_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment package logistics changes are immutable');
      END;

      CREATE TRIGGER shipment_package_logistics_changes_are_immutable_on_delete
      BEFORE DELETE ON shipment_package_logistics_change_events
      BEGIN
        SELECT RAISE(ABORT, 'shipment package logistics changes are immutable');
      END;

      DROP TRIGGER IF EXISTS carrier_claim_events_are_immutable_on_update;
      DROP TRIGGER IF EXISTS carrier_claim_events_are_immutable_on_delete;
      DROP TRIGGER IF EXISTS carrier_compensation_records_are_immutable_on_update;
      DROP TRIGGER IF EXISTS carrier_compensation_records_are_immutable_on_delete;

      CREATE TABLE carrier_claim_events_v30 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        claim_id TEXT NOT NULL REFERENCES carrier_claims(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN (
          'opened', 'approved', 'rejected', 'compensation_confirmed'
        )),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        occurred_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        amount_cents INTEGER CHECK (amount_cents > 0),
        impact_json TEXT CHECK (impact_json IS NULL OR json_valid(impact_json)),
        created_at TEXT NOT NULL,
        UNIQUE (claim_id, result_revision),
        CHECK (
          (kind = 'opened' AND base_revision = 0 AND amount_cents IS NOT NULL
            AND impact_json IS NOT NULL)
          OR (kind = 'approved' AND base_revision >= 1 AND amount_cents IS NOT NULL
            AND impact_json IS NULL)
          OR (kind = 'rejected' AND base_revision >= 1 AND amount_cents IS NULL
            AND impact_json IS NULL)
          OR (kind = 'compensation_confirmed' AND base_revision >= 1
            AND amount_cents IS NOT NULL AND impact_json IS NULL)
        )
      ) STRICT;

      INSERT INTO carrier_claim_events_v30 (
        sequence, id, claim_id, kind, base_revision, result_revision,
        occurred_at, reason, amount_cents, impact_json, created_at
      )
      SELECT
        sequence, id, claim_id, kind, base_revision, result_revision,
        occurred_at, reason, amount_cents,
        CASE WHEN kind = 'opened' THEN '{"scope":"package"}' ELSE NULL END,
        created_at
      FROM carrier_claim_events;

      DROP TABLE carrier_claim_events;
      ALTER TABLE carrier_claim_events_v30 RENAME TO carrier_claim_events;

      CREATE TABLE carrier_claims_v30 (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('outbound', 'return')),
        shipment_package_id TEXT UNIQUE
          REFERENCES shipment_packages(id) ON DELETE RESTRICT,
        return_record_id TEXT UNIQUE
          REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        requested_amount_cents INTEGER NOT NULL CHECK (requested_amount_cents > 0),
        approved_amount_cents INTEGER CHECK (approved_amount_cents > 0),
        impact_json TEXT NOT NULL CHECK (json_valid(impact_json)),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (direction = 'outbound' AND shipment_package_id IS NOT NULL AND return_record_id IS NULL)
          OR (direction = 'return' AND shipment_package_id IS NULL AND return_record_id IS NOT NULL)
        ),
        CHECK (
          (status = 'pending' AND approved_amount_cents IS NULL)
          OR (status = 'rejected' AND approved_amount_cents IS NULL)
          OR (status IN ('approved', 'paid') AND approved_amount_cents IS NOT NULL)
        )
      ) STRICT;

      INSERT INTO carrier_claims_v30 (
        id, direction, shipment_package_id, return_record_id, status, revision,
        requested_amount_cents, approved_amount_cents, impact_json,
        reason, created_at, updated_at
      )
      SELECT
        id, 'return', NULL, return_record_id, status, revision,
        requested_amount_cents, approved_amount_cents, '{"scope":"package"}',
        reason, created_at, updated_at
      FROM carrier_claims;

      DROP TABLE carrier_claims;
      ALTER TABLE carrier_claims_v30 RENAME TO carrier_claims;

      CREATE TRIGGER carrier_claim_identity_is_immutable_on_update
      BEFORE UPDATE OF
        id, direction, shipment_package_id, return_record_id,
        requested_amount_cents, impact_json, created_at
      ON carrier_claims
      BEGIN
        SELECT RAISE(ABORT, 'carrier claim identity is immutable');
      END;

      CREATE TRIGGER carrier_claim_events_are_immutable_on_update
      BEFORE UPDATE ON carrier_claim_events
      BEGIN
        SELECT RAISE(ABORT, 'carrier claim events are immutable');
      END;

      CREATE TRIGGER carrier_claim_events_are_immutable_on_delete
      BEFORE DELETE ON carrier_claim_events
      BEGIN
        SELECT RAISE(ABORT, 'carrier claim events are immutable');
      END;

      CREATE TRIGGER carrier_compensation_records_are_immutable_on_update
      BEFORE UPDATE ON carrier_compensation_records
      BEGIN
        SELECT RAISE(ABORT, 'carrier compensation records are immutable');
      END;

      CREATE TRIGGER carrier_compensation_records_are_immutable_on_delete
      BEFORE DELETE ON carrier_compensation_records
      BEGIN
        SELECT RAISE(ABORT, 'carrier compensation records are immutable');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (30, ?)')
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

function migrateToVersion31(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    if (hasCompleteVersion31Schema(database)) {
      assertForeignKeyIntegrity(database);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (31, ?)')
        .run(new Date().toISOString());
      database.exec('COMMIT;');
      return;
    }
    database.exec(`
      CREATE TABLE logistics_exception_matters (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('outbound', 'return')),
        shipment_package_id TEXT
          REFERENCES shipment_packages(id) ON DELETE RESTRICT,
        return_record_id TEXT
          REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
        exception_type TEXT NOT NULL CHECK (exception_type IN (
          'lost', 'delivery_dispute', 'damaged', 'misdelivered', 'other'
        )),
        stage TEXT NOT NULL CHECK (stage IN (
          'pending_verification', 'investigating', 'confirmed', 'recovered', 'resolved'
        )),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        impact_json TEXT NOT NULL CHECK (json_valid(impact_json)),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (direction = 'outbound' AND shipment_package_id IS NOT NULL AND return_record_id IS NULL)
          OR (direction = 'return' AND shipment_package_id IS NULL AND return_record_id IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX logistics_exceptions_by_shipment_package
      ON logistics_exception_matters (shipment_package_id, occurred_at, id)
      WHERE shipment_package_id IS NOT NULL;

      CREATE INDEX logistics_exceptions_by_return_record
      ON logistics_exception_matters (return_record_id, occurred_at, id)
      WHERE return_record_id IS NOT NULL;

      CREATE TABLE logistics_exception_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        exception_id TEXT NOT NULL
          REFERENCES logistics_exception_matters(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('opened', 'stage_changed')),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        before_stage TEXT CHECK (before_stage IS NULL OR before_stage IN (
          'pending_verification', 'investigating', 'confirmed', 'recovered', 'resolved'
        )),
        after_stage TEXT NOT NULL CHECK (after_stage IN (
          'pending_verification', 'investigating', 'confirmed', 'recovered', 'resolved'
        )),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        impact_json TEXT CHECK (impact_json IS NULL OR json_valid(impact_json)),
        created_at TEXT NOT NULL,
        UNIQUE (exception_id, result_revision),
        CHECK (
          (kind = 'opened' AND base_revision = 0 AND before_stage IS NULL
            AND result_revision = 1 AND impact_json IS NOT NULL)
          OR (kind = 'stage_changed' AND base_revision >= 1
            AND before_stage IS NOT NULL AND impact_json IS NULL)
        )
      ) STRICT;

      CREATE TRIGGER logistics_exception_identity_is_immutable_on_update
      BEFORE UPDATE OF
        id, direction, shipment_package_id, return_record_id,
        exception_type, impact_json, occurred_at, created_at
      ON logistics_exception_matters
      BEGIN
        SELECT RAISE(ABORT, 'logistics exception identity is immutable');
      END;

      CREATE TRIGGER logistics_exception_matters_are_immutable_on_delete
      BEFORE DELETE ON logistics_exception_matters
      BEGIN
        SELECT RAISE(ABORT, 'logistics exception matters are immutable');
      END;

      CREATE TRIGGER logistics_exception_events_are_immutable_on_update
      BEFORE UPDATE ON logistics_exception_events
      BEGIN
        SELECT RAISE(ABORT, 'logistics exception events are immutable');
      END;

      CREATE TRIGGER logistics_exception_events_are_immutable_on_delete
      BEFORE DELETE ON logistics_exception_events
      BEGIN
        SELECT RAISE(ABORT, 'logistics exception events are immutable');
      END;
    `);
    migrateLegacyMixedLogisticsFacts(database);
    contractMixedLogisticsStatusTables(database);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (31, ?)')
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

function migrateToVersion32(database: DatabaseSync): void {
  const schemaState = version32SchemaState(database);
  if (schemaState === 'partial') {
    throw new Error('检测到不完整的 v32 在途售后协调结构');
  }
  database.exec('BEGIN IMMEDIATE;');
  try {
    if (schemaState === 'complete') {
      assertForeignKeyIntegrity(database);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (32, ?)')
        .run(new Date().toISOString());
      database.exec('COMMIT;');
      return;
    }
    database.exec(`
      ALTER TABLE aftersales_cases ADD COLUMN handling_direction TEXT CHECK (
        handling_direction IS NULL OR handling_direction IN (
          'waiting', 'intercept', 'refuse', 'only_refund', 'replacement', 'buyer_return'
        )
      );

      UPDATE aftersales_cases
      SET handling_direction = CASE
        WHEN workflow = 'refund_only' THEN NULL
        WHEN workflow = 'return_refund' AND status = 'waiting_replacement'
          THEN 'replacement'
        WHEN workflow = 'return_refund' AND (
          EXISTS (
            SELECT 1
            FROM aftersales_return_record_items AS return_items
            WHERE return_items.aftersales_case_id = aftersales_cases.id
          )
        )
          THEN 'buyer_return'
        WHEN workflow = 'return_refund' AND (
          status IN ('waiting_refund', 'ready_to_complete')
          OR EXISTS (
            SELECT 1
            FROM financial_records AS records
            WHERE records.aftersales_case_id = aftersales_cases.id
              AND records.kind = 'aftersales_refund'
          )
        )
          THEN 'only_refund'
        WHEN workflow = 'return_refund' THEN 'waiting'
        ELSE NULL
      END;

      UPDATE aftersales_cases
      SET status = 'processing'
      WHERE workflow = 'return_refund'
        AND handling_direction = 'waiting'
        AND status = 'waiting_return';

      CREATE TABLE aftersales_handling_direction_events (
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

      CREATE INDEX aftersales_direction_events_by_case
      ON aftersales_handling_direction_events (case_id, sequence);

      INSERT INTO aftersales_handling_direction_events (
        id, case_id, kind, before_direction, after_direction,
        occurred_at, reason, created_at
      )
      SELECT
        'v32-direction-' || id, id, 'selected', NULL, handling_direction,
        occurred_at, '数据库升级：按已有售后处理方式和状态保守保留处理方向', created_at
      FROM aftersales_cases
      WHERE handling_direction IS NOT NULL;

      CREATE TABLE aftersales_interception_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('requested', 'succeeded', 'failed')),
        occurred_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX aftersales_interception_events_by_case
      ON aftersales_interception_events (case_id, sequence);

      CREATE TRIGGER aftersales_direction_events_are_immutable_on_update
      BEFORE UPDATE ON aftersales_handling_direction_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales handling direction events are immutable');
      END;

      CREATE TRIGGER aftersales_direction_events_are_immutable_on_delete
      BEFORE DELETE ON aftersales_handling_direction_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales handling direction events are immutable');
      END;

      CREATE TRIGGER aftersales_interception_events_are_immutable_on_update
      BEFORE UPDATE ON aftersales_interception_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales interception events are immutable');
      END;

      CREATE TRIGGER aftersales_interception_events_are_immutable_on_delete
      BEFORE DELETE ON aftersales_interception_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales interception events are immutable');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (32, ?)')
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

function version32SchemaState(database: DatabaseSync): 'absent' | 'complete' | 'partial' {
  const hasHandlingDirection = (database.prepare('PRAGMA table_info(aftersales_cases)').all() as Array<{
    name: string;
  }>).some(({ name }) => name === 'handling_direction');
  const requiredObjects = new Map<string, 'table' | 'index' | 'trigger'>([
    ['aftersales_handling_direction_events', 'table'],
    ['aftersales_interception_events', 'table'],
    ['aftersales_direction_events_by_case', 'index'],
    ['aftersales_interception_events_by_case', 'index'],
    ['aftersales_direction_events_are_immutable_on_update', 'trigger'],
    ['aftersales_direction_events_are_immutable_on_delete', 'trigger'],
    ['aftersales_interception_events_are_immutable_on_update', 'trigger'],
    ['aftersales_interception_events_are_immutable_on_delete', 'trigger'],
  ]);
  const rows = database.prepare(`
    SELECT type, name
    FROM sqlite_schema
    WHERE name IN (${[...requiredObjects].map(() => '?').join(', ')})
  `).all(...requiredObjects.keys()) as Array<{ type: string; name: string }>;
  const matchingObjectCount = rows.filter((row) => (
    requiredObjects.get(row.name) === row.type
  )).length;
  if (!hasHandlingDirection && rows.length === 0) return 'absent';
  if (hasHandlingDirection
    && rows.length === requiredObjects.size
    && matchingObjectCount === requiredObjects.size) return 'complete';
  return 'partial';
}

const VERSION_33_SCHEMA_STATEMENTS = {
  aftersales_return_exception_decision_events: `
    CREATE TABLE aftersales_return_exception_decision_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
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
      after_decision TEXT NOT NULL CHECK (after_decision IN (
        'wait_investigation', 'refund_in_advance', 'partial_refund',
        'reject_refund', 'negotiate'
      )),
      occurred_at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL,
      CHECK (
        (kind = 'selected' AND before_decision IS NULL)
        OR (kind = 'changed' AND before_decision IS NOT NULL
          AND before_decision <> after_decision)
      )
    ) STRICT
  `,
  aftersales_return_exception_decisions_by_case: `
    CREATE INDEX aftersales_return_exception_decisions_by_case
    ON aftersales_return_exception_decision_events (case_id, exception_id, sequence)
  `,
  aftersales_return_exception_decision_identity_is_valid_on_insert: `
    CREATE TRIGGER aftersales_return_exception_decision_identity_is_valid_on_insert
    BEFORE INSERT ON aftersales_return_exception_decision_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM logistics_exception_matters AS exceptions
      WHERE exceptions.id = NEW.exception_id
        AND exceptions.direction = 'return'
        AND exceptions.return_record_id = NEW.return_record_id
        AND EXISTS (
          SELECT 1
          FROM aftersales_return_record_items AS case_items
          WHERE case_items.return_record_id = NEW.return_record_id
            AND case_items.aftersales_case_id = NEW.case_id
            AND (
              json_extract(exceptions.impact_json, '$.scope') = 'package'
              OR EXISTS (
                SELECT 1
                FROM json_each(exceptions.impact_json, '$.items') AS affected_item
                WHERE json_extract(affected_item.value, '$.sourceItemId') = case_items.id
              )
            )
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'return exception decision identity mismatch');
    END
  `,
  aftersales_return_exception_decisions_are_immutable_on_update: `
    CREATE TRIGGER aftersales_return_exception_decisions_are_immutable_on_update
    BEFORE UPDATE ON aftersales_return_exception_decision_events
    BEGIN
      SELECT RAISE(ABORT, 'return exception decision events are immutable');
    END
  `,
  aftersales_return_exception_decisions_are_immutable_on_delete: `
    CREATE TRIGGER aftersales_return_exception_decisions_are_immutable_on_delete
    BEFORE DELETE ON aftersales_return_exception_decision_events
    BEGIN
      SELECT RAISE(ABORT, 'return exception decision events are immutable');
    END
  `,
} as const;

function migrateToVersion33(database: DatabaseSync): void {
  const schemaState = version33SchemaState(database);
  if (schemaState === 'partial') {
    throw new Error('检测到不完整的 v33 退货异常协调结构');
  }
  database.exec('BEGIN IMMEDIATE;');
  try {
    if (schemaState === 'absent') {
      database.exec(Object.values(VERSION_33_SCHEMA_STATEMENTS).join(';\n'));
    }
    assertForeignKeyIntegrity(database);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (33, ?)')
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

const VERSION_34_SCHEMA_STATEMENTS = {
  aftersales_processing_rounds: `
    CREATE TABLE aftersales_processing_rounds (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      round_number INTEGER NOT NULL CHECK (round_number >= 1),
      workflow TEXT NOT NULL CHECK (workflow IN ('legacy', 'exchange', 'direct_replacement')),
      source_shipment_record_id TEXT NOT NULL REFERENCES shipment_records(id) ON DELETE RESTRICT,
      occurred_at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL,
      UNIQUE (case_id, round_number)
    ) STRICT`,
  aftersales_processing_round_items: `
    CREATE TABLE aftersales_processing_round_items (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES aftersales_processing_rounds(id) ON DELETE RESTRICT,
      source_shipment_package_item_id TEXT NOT NULL
        REFERENCES shipment_package_items(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      UNIQUE (round_id, source_shipment_package_item_id)
    ) STRICT`,
  aftersales_round_returns: `
    CREATE TABLE aftersales_round_returns (
      round_id TEXT NOT NULL REFERENCES aftersales_processing_rounds(id) ON DELETE RESTRICT,
      return_record_id TEXT NOT NULL
        REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
      PRIMARY KEY (round_id, return_record_id)
    ) STRICT`,
  aftersales_replacement_shipments: `
    CREATE TABLE aftersales_replacement_shipments (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL UNIQUE
        REFERENCES aftersales_processing_rounds(id) ON DELETE RESTRICT,
      shipment_record_id TEXT NOT NULL UNIQUE
        REFERENCES shipment_records(id) ON DELETE RESTRICT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT`,
  aftersales_replacement_items: `
    CREATE TABLE aftersales_replacement_items (
      id TEXT PRIMARY KEY,
      replacement_shipment_id TEXT NOT NULL
        REFERENCES aftersales_replacement_shipments(id) ON DELETE RESTRICT,
      round_item_id TEXT NOT NULL
        REFERENCES aftersales_processing_round_items(id) ON DELETE RESTRICT,
      shipment_package_item_id TEXT NOT NULL UNIQUE
        REFERENCES shipment_package_items(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      UNIQUE (replacement_shipment_id, round_item_id, shipment_package_item_id)
    ) STRICT`,
  aftersales_processing_round_item_source_is_valid_on_insert: `
    CREATE TRIGGER aftersales_processing_round_item_source_is_valid_on_insert
    BEFORE INSERT ON aftersales_processing_round_items
    WHEN NOT EXISTS (
      SELECT 1
      FROM aftersales_processing_rounds AS rounds
      JOIN shipment_package_items AS items
        ON items.id = NEW.source_shipment_package_item_id
      JOIN shipment_packages AS packages ON packages.id = items.package_id
      WHERE rounds.id = NEW.round_id
        AND packages.shipment_record_id = rounds.source_shipment_record_id
    )
    BEGIN SELECT RAISE(ABORT, 'aftersales round item source record mismatch'); END`,
  aftersales_replacement_item_identity_is_valid_on_insert: `
    CREATE TRIGGER aftersales_replacement_item_identity_is_valid_on_insert
    BEFORE INSERT ON aftersales_replacement_items
    WHEN NOT EXISTS (
      SELECT 1
      FROM aftersales_replacement_shipments AS replacements
      JOIN aftersales_processing_round_items AS round_items
        ON round_items.id = NEW.round_item_id
       AND round_items.round_id = replacements.round_id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = NEW.shipment_package_item_id
      JOIN shipment_packages AS packages ON packages.id = shipment_items.package_id
      JOIN shipment_package_items AS source_items
        ON source_items.id = round_items.source_shipment_package_item_id
      WHERE replacements.id = NEW.replacement_shipment_id
        AND packages.shipment_record_id = replacements.shipment_record_id
        AND shipment_items.order_id = source_items.order_id
        AND shipment_items.source_order_item_id = source_items.source_order_item_id
        AND shipment_items.quantity = NEW.quantity
        AND (
          SELECT COALESCE(SUM(existing.quantity), 0) + NEW.quantity
          FROM aftersales_replacement_items AS existing
          WHERE existing.replacement_shipment_id = NEW.replacement_shipment_id
            AND existing.round_item_id = NEW.round_item_id
        ) <= round_items.quantity
    )
    BEGIN SELECT RAISE(ABORT, 'aftersales replacement item identity mismatch'); END`,
  aftersales_processing_rounds_are_immutable_on_update: immutableUpdateTrigger(
    'aftersales_processing_rounds',
    'aftersales processing rounds are immutable',
  ),
  aftersales_processing_rounds_are_immutable_on_delete: immutableDeleteTrigger(
    'aftersales_processing_rounds',
    'aftersales processing rounds are immutable',
  ),
  aftersales_processing_round_items_are_immutable_on_update: immutableUpdateTrigger(
    'aftersales_processing_round_items',
    'aftersales processing round items are immutable',
  ),
  aftersales_processing_round_items_are_immutable_on_delete: immutableDeleteTrigger(
    'aftersales_processing_round_items',
    'aftersales processing round items are immutable',
  ),
  aftersales_round_returns_are_immutable_on_update: immutableUpdateTrigger(
    'aftersales_round_returns',
    'aftersales round returns are immutable',
  ),
  aftersales_round_returns_are_immutable_on_delete: immutableDeleteTrigger(
    'aftersales_round_returns',
    'aftersales round returns are immutable',
  ),
  aftersales_replacement_shipments_are_immutable_on_update: immutableUpdateTrigger(
    'aftersales_replacement_shipments',
    'aftersales replacement shipments are immutable',
  ),
  aftersales_replacement_shipments_are_immutable_on_delete: immutableDeleteTrigger(
    'aftersales_replacement_shipments',
    'aftersales replacement shipments are immutable',
  ),
  aftersales_replacement_items_are_immutable_on_update: immutableUpdateTrigger(
    'aftersales_replacement_items',
    'aftersales replacement items are immutable',
  ),
  aftersales_replacement_items_are_immutable_on_delete: immutableDeleteTrigger(
    'aftersales_replacement_items',
    'aftersales replacement items are immutable',
  ),
} as const;

function immutableUpdateTrigger(table: string, message: string): string {
  return `CREATE TRIGGER ${table}_are_immutable_on_update
    BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${message}'); END`;
}

function immutableDeleteTrigger(table: string, message: string): string {
  return `CREATE TRIGGER ${table}_are_immutable_on_delete
    BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${message}'); END`;
}

function migrateToVersion34(database: DatabaseSync): void {
  const existing = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE name IN (${Object.keys(VERSION_34_SCHEMA_STATEMENTS).map(() => '?').join(', ')})
  `).all(...Object.keys(VERSION_34_SCHEMA_STATEMENTS)) as Array<{ name: string }>;
  if (existing.length !== 0 && existing.length !== Object.keys(VERSION_34_SCHEMA_STATEMENTS).length) {
    throw new Error('检测到不完整的 v34 售后处理轮次结构');
  }
  if (existing.length > 0 && !hasCompleteVersion34Schema(database)) {
    throw new Error('检测到不完整的 v34 售后处理轮次结构');
  }
  const casesSql = (database.prepare(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'aftersales_cases'
  `).get() as { sql: string }).sql;
  const supportsReplacementWorkflows = casesSql.includes("'exchange'")
    && casesSql.includes("'direct_replacement'");
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    if (!supportsReplacementWorkflows) {
      database.exec(`
        CREATE TABLE aftersales_cases_v34 (
          id TEXT PRIMARY KEY,
          shipment_record_id TEXT NOT NULL
            REFERENCES shipment_records(id) ON DELETE RESTRICT,
          workflow TEXT NOT NULL CHECK (workflow IN (
            'general', 'refund_only', 'return_refund', 'exchange', 'direct_replacement'
          )),
          status TEXT NOT NULL CHECK (status IN (
            'processing', 'waiting_return', 'waiting_inspection', 'waiting_refund',
            'waiting_replacement', 'partially_completed', 'ready_to_complete',
            'completed', 'cancelled'
          )),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          handling_direction TEXT CHECK (
            handling_direction IS NULL OR handling_direction IN (
              'waiting', 'intercept', 'refuse', 'buyer_return', 'only_refund', 'replacement'
            )
          )
        ) STRICT;
        INSERT INTO aftersales_cases_v34
        SELECT id, shipment_record_id, workflow, status, revision, reason,
               occurred_at, created_at, updated_at, handling_direction
        FROM aftersales_cases;
        DROP TABLE aftersales_cases;
        ALTER TABLE aftersales_cases_v34 RENAME TO aftersales_cases;
        CREATE INDEX aftersales_cases_by_record_and_status
        ON aftersales_cases (shipment_record_id, status, occurred_at, id);
      `);
    }
    if (existing.length === 0) {
      database.exec(Object.values(VERSION_34_SCHEMA_STATEMENTS).join(';\n'));
      database.exec(`
        INSERT INTO aftersales_processing_rounds (
          id, case_id, round_number, workflow, source_shipment_record_id,
          occurred_at, reason, created_at
        )
        SELECT
          'legacy-round-' || id, id, 1,
          CASE WHEN workflow IN ('exchange', 'direct_replacement') THEN workflow ELSE 'legacy' END,
          shipment_record_id, occurred_at, reason, created_at
        FROM aftersales_cases;

        INSERT INTO aftersales_processing_round_items (
          id, round_id, source_shipment_package_item_id, quantity
        )
        SELECT
          'legacy-round-item-' || items.id,
          'legacy-round-' || items.case_id,
          items.shipment_package_item_id,
          items.quantity
        FROM aftersales_case_items AS items;

        INSERT INTO aftersales_round_returns (round_id, return_record_id)
        SELECT DISTINCT
          'legacy-round-' || return_items.aftersales_case_id,
          return_items.return_record_id
        FROM aftersales_return_record_items AS return_items;
      `);
    }
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (34, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* Preserve migration failure. */ }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function hasCompleteVersion34Schema(database: DatabaseSync): boolean {
  const rows = database.prepare(`
    SELECT name, sql FROM sqlite_schema
    WHERE name IN (${Object.keys(VERSION_34_SCHEMA_STATEMENTS).map(() => '?').join(', ')})
  `).all(...Object.keys(VERSION_34_SCHEMA_STATEMENTS)) as Array<{
    name: string;
    sql: string | null;
  }>;
  if (rows.length !== Object.keys(VERSION_34_SCHEMA_STATEMENTS).length) return false;
  const actual = new Map(rows.map((row) => [row.name, row.sql ?? '']));
  return Object.entries(VERSION_34_SCHEMA_STATEMENTS).every(([name, expected]) => (
    normalizeSchemaSql(actual.get(name) ?? '') === normalizeSchemaSql(expected)
  ));
}

const VERSION_35_SCHEMA_STATEMENTS = {
  aftersales_outbound_exception_decision_events: `
    CREATE TABLE aftersales_outbound_exception_decision_events (
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
    ) STRICT`,
  aftersales_outbound_exception_decisions_by_case: `
    CREATE INDEX aftersales_outbound_exception_decisions_by_case
    ON aftersales_outbound_exception_decision_events (case_id, exception_id, sequence)`,
  aftersales_outbound_exception_decision_identity_is_valid_on_insert: `
    CREATE TRIGGER aftersales_outbound_exception_decision_identity_is_valid_on_insert
    BEFORE INSERT ON aftersales_outbound_exception_decision_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM logistics_exception_matters AS exceptions
      WHERE exceptions.id = NEW.exception_id
        AND exceptions.direction = 'outbound'
        AND exceptions.shipment_package_id = NEW.shipment_package_id
        AND exceptions.return_record_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM aftersales_case_items AS case_items
          JOIN shipment_package_items AS shipment_items
            ON shipment_items.id = case_items.shipment_package_item_id
          WHERE case_items.case_id = NEW.case_id
            AND shipment_items.package_id = NEW.shipment_package_id
            AND (
              json_extract(exceptions.impact_json, '$.scope') = 'package'
              OR EXISTS (
                SELECT 1
                FROM json_each(exceptions.impact_json, '$.items') AS affected_item
                WHERE json_extract(affected_item.value, '$.sourceItemId')
                  = case_items.shipment_package_item_id
              )
            )
        )
    ) BEGIN
      SELECT RAISE(ABORT, 'outbound exception decision identity mismatch');
    END`,
  aftersales_outbound_exception_decisions_are_immutable_on_update: `
    CREATE TRIGGER aftersales_outbound_exception_decisions_are_immutable_on_update
    BEFORE UPDATE ON aftersales_outbound_exception_decision_events
    BEGIN SELECT RAISE(ABORT, 'outbound exception decision events are immutable'); END`,
  aftersales_outbound_exception_decisions_are_immutable_on_delete: `
    CREATE TRIGGER aftersales_outbound_exception_decisions_are_immutable_on_delete
    BEFORE DELETE ON aftersales_outbound_exception_decision_events
    BEGIN SELECT RAISE(ABORT, 'outbound exception decision events are immutable'); END`,
  aftersales_outbound_exception_replacement_rounds: `
    CREATE TABLE aftersales_outbound_exception_replacement_rounds (
      exception_id TEXT PRIMARY KEY
        REFERENCES logistics_exception_matters(id) ON DELETE RESTRICT,
      case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      round_id TEXT NOT NULL UNIQUE
        REFERENCES aftersales_processing_rounds(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    ) STRICT`,
  aftersales_outbound_exception_replacement_round_identity_is_valid_on_insert: `
    CREATE TRIGGER aftersales_outbound_exception_replacement_round_identity_is_valid_on_insert
    BEFORE INSERT ON aftersales_outbound_exception_replacement_rounds
    WHEN NOT EXISTS (
      SELECT 1
      FROM aftersales_processing_rounds AS rounds
      JOIN aftersales_outbound_exception_decision_events AS decisions
        ON decisions.exception_id = NEW.exception_id
       AND decisions.case_id = NEW.case_id
       AND decisions.after_decision IN ('replacement', 'refund_and_replacement')
      WHERE rounds.id = NEW.round_id
        AND rounds.case_id = NEW.case_id
        AND rounds.workflow = 'direct_replacement'
    ) BEGIN
      SELECT RAISE(ABORT, 'outbound exception replacement round identity mismatch');
    END`,
  aftersales_outbound_exception_replacement_rounds_are_immutable_on_update: `
    CREATE TRIGGER aftersales_outbound_exception_replacement_rounds_are_immutable_on_update
    BEFORE UPDATE ON aftersales_outbound_exception_replacement_rounds
    BEGIN SELECT RAISE(ABORT, 'outbound exception replacement rounds are immutable'); END`,
  aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete: `
    CREATE TRIGGER aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete
    BEFORE DELETE ON aftersales_outbound_exception_replacement_rounds
    BEGIN SELECT RAISE(ABORT, 'outbound exception replacement rounds are immutable'); END`,
  aftersales_intercepted_return_inspection_events: `
    CREATE TABLE aftersales_intercepted_return_inspection_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      shipment_package_id TEXT NOT NULL REFERENCES shipment_packages(id) ON DELETE RESTRICT,
      result TEXT NOT NULL CHECK (result IN ('resellable', 'defective', 'scrapped', 'other')),
      items_json TEXT NOT NULL CHECK (
        json_valid(items_json) AND json_type(items_json) = 'array'
        AND json_array_length(items_json) > 0
      ),
      occurred_at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      created_at TEXT NOT NULL,
      UNIQUE (case_id, shipment_package_id)
    ) STRICT`,
  aftersales_intercepted_return_inspections_by_case: `
    CREATE INDEX aftersales_intercepted_return_inspections_by_case
    ON aftersales_intercepted_return_inspection_events (case_id, sequence)`,
  aftersales_intercepted_return_inspection_identity_is_valid_on_insert: `
    CREATE TRIGGER aftersales_intercepted_return_inspection_identity_is_valid_on_insert
    BEFORE INSERT ON aftersales_intercepted_return_inspection_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM shipment_packages AS packages
      WHERE packages.id = NEW.shipment_package_id
        AND packages.logistics_status = 'returned'
        AND EXISTS (
          SELECT 1
          FROM aftersales_interception_events AS interception
          WHERE interception.case_id = NEW.case_id
            AND interception.kind = 'succeeded'
        )
        AND json_array_length(NEW.items_json) = (
          SELECT COUNT(DISTINCT json_extract(selected_item.value, '$.shipmentPackageItemId'))
          FROM json_each(NEW.items_json) AS selected_item
        )
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(NEW.items_json) AS selected_item
          WHERE NOT EXISTS (
            SELECT 1
            FROM aftersales_case_items AS case_items
            JOIN shipment_package_items AS shipment_items
              ON shipment_items.id = case_items.shipment_package_item_id
            WHERE case_items.case_id = NEW.case_id
              AND shipment_items.package_id = NEW.shipment_package_id
              AND case_items.shipment_package_item_id
                = json_extract(selected_item.value, '$.shipmentPackageItemId')
              AND json_type(selected_item.value, '$.quantity') = 'integer'
              AND json_extract(selected_item.value, '$.quantity') BETWEEN 1 AND case_items.quantity
          )
        )
    ) BEGIN
      SELECT RAISE(ABORT, 'intercepted return inspection identity mismatch');
    END`,
  aftersales_intercepted_return_inspections_are_immutable_on_update: `
    CREATE TRIGGER aftersales_intercepted_return_inspections_are_immutable_on_update
    BEFORE UPDATE ON aftersales_intercepted_return_inspection_events
    BEGIN SELECT RAISE(ABORT, 'intercepted return inspection events are immutable'); END`,
  aftersales_intercepted_return_inspections_are_immutable_on_delete: `
    CREATE TRIGGER aftersales_intercepted_return_inspections_are_immutable_on_delete
    BEFORE DELETE ON aftersales_intercepted_return_inspection_events
    BEGIN SELECT RAISE(ABORT, 'intercepted return inspection events are immutable'); END`,
} as const;

function migrateToVersion35(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT name, sql FROM sqlite_schema
    WHERE name IN (${Object.keys(VERSION_35_SCHEMA_STATEMENTS).map(() => '?').join(', ')})
  `).all(...Object.keys(VERSION_35_SCHEMA_STATEMENTS)) as Array<{
    name: string;
    sql: string | null;
  }>;
  if (rows.length !== 0) {
    const sqlByName = new Map(rows.map((row) => [row.name, row.sql ?? '']));
    const complete = rows.length === Object.keys(VERSION_35_SCHEMA_STATEMENTS).length
      && Object.entries(VERSION_35_SCHEMA_STATEMENTS).every(([name, expected]) => (
        normalizeSchemaSql(sqlByName.get(name) ?? '') === normalizeSchemaSql(expected)
      ));
    if (!complete) throw new Error('检测到不完整的 v35 正向异常协调结构');
  }
  database.exec('BEGIN IMMEDIATE;');
  try {
    if (rows.length === 0) {
      database.exec(Object.values(VERSION_35_SCHEMA_STATEMENTS).join(';\n'));
    }
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (35, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* Preserve migration failure. */ }
    throw error;
  }
}

function version33SchemaState(database: DatabaseSync): 'absent' | 'complete' | 'partial' {
  const requiredObjects = new Map<string, 'table' | 'index' | 'trigger'>([
    ['aftersales_return_exception_decision_events', 'table'],
    ['aftersales_return_exception_decisions_by_case', 'index'],
    ['aftersales_return_exception_decision_identity_is_valid_on_insert', 'trigger'],
    ['aftersales_return_exception_decisions_are_immutable_on_update', 'trigger'],
    ['aftersales_return_exception_decisions_are_immutable_on_delete', 'trigger'],
  ]);
  const rows = database.prepare(`
    SELECT type, name
    FROM sqlite_schema
    WHERE name IN (${[...requiredObjects].map(() => '?').join(', ')})
  `).all(...requiredObjects.keys()) as Array<{ type: string; name: string }>;
  if (rows.length === 0) return 'absent';
  if (rows.length === requiredObjects.size && rows.every((row) => (
    requiredObjects.get(row.name) === row.type
  )) && hasCompleteVersion33Schema(database)) return 'complete';
  return 'partial';
}

function hasCompleteVersion33Schema(database: DatabaseSync): boolean {
  const schemaRows = database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE name IN (${Object.keys(VERSION_33_SCHEMA_STATEMENTS).map(() => '?').join(', ')})
  `).all(...Object.keys(VERSION_33_SCHEMA_STATEMENTS)) as Array<{
    name: string;
    sql: string | null;
  }>;
  if (schemaRows.length !== Object.keys(VERSION_33_SCHEMA_STATEMENTS).length) return false;
  const sqlByName = new Map(schemaRows.map((row) => [row.name, row.sql ?? '']));
  return Object.entries(VERSION_33_SCHEMA_STATEMENTS).every(([name, expectedSql]) => (
    normalizeSchemaSql(sqlByName.get(name) ?? '') === normalizeSchemaSql(expectedSql)
  ));
}

function normalizeSchemaSql(sql: string): string {
  return sql.trim().replace(/;$/u, '').replace(/\s+/gu, ' ');
}

function hasCompleteVersion31Schema(database: DatabaseSync): boolean {
  const requiredObjects = new Map<string, 'table' | 'index' | 'trigger'>([
    ['logistics_exception_matters', 'table'],
    ['logistics_exception_events', 'table'],
    ['logistics_exceptions_by_shipment_package', 'index'],
    ['logistics_exceptions_by_return_record', 'index'],
    ['logistics_exception_identity_is_immutable_on_update', 'trigger'],
    ['logistics_exception_matters_are_immutable_on_delete', 'trigger'],
    ['logistics_exception_events_are_immutable_on_update', 'trigger'],
    ['logistics_exception_events_are_immutable_on_delete', 'trigger'],
    ['legacy_shipment_package_mixed_logistics_events', 'table'],
    ['legacy_return_mixed_logistics_events', 'table'],
    ['legacy_shipment_mixed_events_are_immutable_on_update', 'trigger'],
    ['legacy_shipment_mixed_events_are_immutable_on_delete', 'trigger'],
    ['legacy_return_mixed_events_are_immutable_on_update', 'trigger'],
    ['legacy_return_mixed_events_are_immutable_on_delete', 'trigger'],
  ]);
  const rows = database.prepare(`
    SELECT type, name, sql
    FROM sqlite_schema
    WHERE name IN (${[...requiredObjects].map(() => '?').join(', ')})
  `).all(...requiredObjects.keys()) as { type: string; name: string; sql: string | null }[];
  if (rows.length !== requiredObjects.size
    || rows.some((row) => requiredObjects.get(row.name) !== row.type)) return false;

  const tableSql = database.prepare(`
    SELECT name, sql FROM sqlite_schema
    WHERE type = 'table' AND name IN (
      'shipment_packages',
      'shipment_package_logistics_status_events',
      'aftersales_return_records',
      'logistics_exception_matters',
      'logistics_exception_events'
    )
  `).all() as { name: string; sql: string }[];
  const schemas = new Map(tableSql.map((row) => [row.name, row.sql]));
  const normalStatusTables = [
    schemas.get('shipment_packages'),
    schemas.get('shipment_package_logistics_status_events'),
    schemas.get('aftersales_return_records'),
  ];
  return normalStatusTables.every((sql) => sql?.includes("'awaiting_carrier'")
      && sql.includes("'in_transit'") && sql.includes("'delivered'")
      && sql.includes("'returned'")
      && !sql.includes("'intercepting'") && !sql.includes("'lost'")
      && !sql.includes("'delivery_dispute'") && !sql.includes("'damaged'")
      && !sql.includes("'misdelivered'") && !sql.includes("'exception'"))
    && schemas.get('logistics_exception_matters')?.includes("'pending_verification'") === true
    && schemas.get('logistics_exception_events')?.includes("'stage_changed'") === true;
}

function contractMixedLogisticsStatusTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE legacy_shipment_package_mixed_logistics_events (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      package_id TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      result_revision INTEGER NOT NULL,
      before_status TEXT NOT NULL,
      after_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    INSERT INTO legacy_shipment_package_mixed_logistics_events
    SELECT sequence, id, package_id, base_revision, result_revision,
           before_status, after_status, reason, occurred_at, payload_json, created_at
    FROM shipment_package_logistics_status_events
    WHERE after_status IN (
      'intercepting', 'lost', 'delivery_dispute', 'damaged', 'misdelivered', 'exception'
    );

    CREATE TRIGGER legacy_shipment_mixed_events_are_immutable_on_update
    BEFORE UPDATE ON legacy_shipment_package_mixed_logistics_events
    BEGIN
      SELECT RAISE(ABORT, 'legacy shipment mixed logistics events are immutable');
    END;

    CREATE TRIGGER legacy_shipment_mixed_events_are_immutable_on_delete
    BEFORE DELETE ON legacy_shipment_package_mixed_logistics_events
    BEGIN
      SELECT RAISE(ABORT, 'legacy shipment mixed logistics events are immutable');
    END;

    CREATE TABLE legacy_return_mixed_logistics_events (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      return_record_id TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      result_revision INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    INSERT INTO legacy_return_mixed_logistics_events
    SELECT sequence, id, return_record_id, base_revision, result_revision,
           occurred_at, reason, payload_json, created_at
    FROM aftersales_return_record_events
    WHERE kind = 'logistics_status_updated'
      AND json_extract(payload_json, '$.after') IN (
        'intercepting', 'lost', 'delivery_dispute', 'damaged', 'misdelivered', 'exception'
      );

    CREATE TRIGGER legacy_return_mixed_events_are_immutable_on_update
    BEFORE UPDATE ON legacy_return_mixed_logistics_events
    BEGIN
      SELECT RAISE(ABORT, 'legacy return mixed logistics events are immutable');
    END;

    CREATE TRIGGER legacy_return_mixed_events_are_immutable_on_delete
    BEFORE DELETE ON legacy_return_mixed_logistics_events
    BEGIN
      SELECT RAISE(ABORT, 'legacy return mixed logistics events are immutable');
    END;

    CREATE TABLE shipment_packages_v31 (
      id TEXT PRIMARY KEY,
      shipment_record_id TEXT NOT NULL
        REFERENCES shipment_records(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL CHECK (position >= 0),
      shipping_carrier TEXT NOT NULL,
      tracking_number TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      logistics_status TEXT NOT NULL DEFAULT 'in_transit'
        CHECK (logistics_status IN ('awaiting_carrier', 'in_transit', 'delivered', 'returned')),
      carrier_accepted_at TEXT,
      UNIQUE (shipment_record_id, position),
      CHECK (logistics_status <> 'awaiting_carrier' OR carrier_accepted_at IS NULL)
    ) STRICT;

    INSERT INTO shipment_packages_v31 (
      id, shipment_record_id, position, shipping_carrier, tracking_number,
      revision, created_at, logistics_status, carrier_accepted_at
    )
    SELECT
      id, shipment_record_id, position, shipping_carrier, tracking_number,
      revision, created_at,
      CASE WHEN logistics_status = 'intercepted_returned' THEN 'returned'
           ELSE logistics_status END,
      carrier_accepted_at
    FROM shipment_packages;

    DROP TABLE shipment_packages;
    ALTER TABLE shipment_packages_v31 RENAME TO shipment_packages;

    DROP TRIGGER shipment_package_logistics_status_events_are_immutable_on_update;
    DROP TRIGGER shipment_package_logistics_status_events_are_immutable_on_delete;

    CREATE TABLE shipment_package_logistics_status_events_v31 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      package_id TEXT NOT NULL REFERENCES shipment_packages(id) ON DELETE RESTRICT,
      base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
      result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
      before_status TEXT NOT NULL CHECK (before_status IN (
        'awaiting_carrier', 'in_transit', 'delivered', 'returned'
      )),
      after_status TEXT NOT NULL CHECK (after_status IN (
        'awaiting_carrier', 'in_transit', 'delivered', 'returned'
      )),
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL,
      UNIQUE (package_id, result_revision)
    ) STRICT;

    INSERT INTO shipment_package_logistics_status_events_v31 (
      sequence, id, package_id, base_revision, result_revision,
      before_status, after_status, reason, occurred_at, payload_json, created_at
    )
    SELECT
      events.sequence,
      events.id,
      events.package_id,
      events.base_revision,
      events.result_revision,
      COALESCE((
        SELECT CASE
          WHEN earlier.after_status = 'intercepted_returned' THEN 'returned'
          ELSE earlier.after_status
        END
        FROM shipment_package_logistics_status_events AS earlier
        WHERE earlier.package_id = events.package_id
          AND earlier.sequence < events.sequence
          AND earlier.after_status IN (
            'awaiting_carrier', 'in_transit', 'delivered', 'intercepted_returned'
          )
        ORDER BY earlier.sequence DESC
        LIMIT 1
      ), 'in_transit'),
      CASE WHEN events.after_status = 'intercepted_returned' THEN 'returned'
           ELSE events.after_status END,
      events.reason,
      events.occurred_at,
      json_object('carrierAcceptedAt', json_extract(events.payload_json, '$.carrierAcceptedAt')),
      events.created_at
    FROM shipment_package_logistics_status_events AS events
    WHERE events.after_status IN (
      'awaiting_carrier', 'in_transit', 'delivered', 'intercepted_returned'
    );

    DROP TABLE shipment_package_logistics_status_events;
    ALTER TABLE shipment_package_logistics_status_events_v31
      RENAME TO shipment_package_logistics_status_events;

    CREATE TRIGGER shipment_package_logistics_status_events_are_immutable_on_update
    BEFORE UPDATE ON shipment_package_logistics_status_events
    BEGIN
      SELECT RAISE(ABORT, 'shipment package logistics status events are immutable');
    END;

    CREATE TRIGGER shipment_package_logistics_status_events_are_immutable_on_delete
    BEFORE DELETE ON shipment_package_logistics_status_events
    BEGIN
      SELECT RAISE(ABORT, 'shipment package logistics status events are immutable');
    END;

    CREATE TABLE aftersales_return_records_v31 (
      id TEXT PRIMARY KEY,
      aftersales_case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK (status IN ('in_transit', 'received', 'inspected')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      shipping_carrier TEXT NOT NULL CHECK (length(trim(shipping_carrier)) BETWEEN 1 AND 100),
      tracking_number TEXT NOT NULL CHECK (length(trim(tracking_number)) BETWEEN 1 AND 200),
      occurred_at TEXT NOT NULL,
      received_at TEXT,
      inspection_result TEXT CHECK (
        inspection_result IS NULL OR inspection_result IN ('resellable', 'defective', 'scrapped', 'other')
      ),
      inspection_note TEXT,
      inspected_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      logistics_status TEXT NOT NULL CHECK (
        logistics_status IN ('awaiting_carrier', 'in_transit', 'delivered', 'returned')
      ),
      carrier_accepted_at TEXT,
      discrepancies_json TEXT NOT NULL CHECK (json_valid(discrepancies_json))
    ) STRICT;

    INSERT INTO aftersales_return_records_v31
    SELECT
      id, aftersales_case_id, status, revision, shipping_carrier, tracking_number,
      occurred_at, received_at, inspection_result, inspection_note, inspected_at,
      created_at, updated_at,
      CASE WHEN logistics_status = 'returned_to_buyer' THEN 'returned'
           ELSE logistics_status END,
      carrier_accepted_at, discrepancies_json
    FROM aftersales_return_records;

    DROP TABLE aftersales_return_records;
    ALTER TABLE aftersales_return_records_v31 RENAME TO aftersales_return_records;

    DROP TRIGGER aftersales_return_record_events_are_immutable_on_update;
    DROP TRIGGER aftersales_return_record_events_are_immutable_on_delete;

    CREATE TABLE aftersales_return_record_events_v31 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      return_record_id TEXT NOT NULL REFERENCES aftersales_return_records(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN (
        'registered', 'items_combined', 'logistics_corrected',
        'logistics_status_updated', 'received', 'inspected'
      )),
      base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
      result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
      occurred_at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      inspection_result TEXT CHECK (
        inspection_result IS NULL OR inspection_result IN ('resellable', 'defective', 'scrapped', 'other')
      ),
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL,
      UNIQUE (return_record_id, result_revision),
      CHECK (
        (kind = 'registered' AND base_revision = 0 AND inspection_result IS NULL)
        OR (kind <> 'registered' AND base_revision >= 1)
      )
    ) STRICT;

    INSERT INTO aftersales_return_record_events_v31
    SELECT
      sequence, id, return_record_id, kind, base_revision, result_revision,
      occurred_at, reason, inspection_result,
      CASE
        WHEN kind = 'logistics_status_updated' THEN json_set(
          payload_json,
          '$.before',
          COALESCE((
            SELECT CASE
              WHEN json_extract(earlier.payload_json, '$.after') = 'returned_to_buyer'
                THEN 'returned'
              ELSE json_extract(earlier.payload_json, '$.after')
            END
            FROM aftersales_return_record_events AS earlier
            WHERE earlier.return_record_id = aftersales_return_record_events.return_record_id
              AND earlier.sequence < aftersales_return_record_events.sequence
              AND earlier.kind = 'logistics_status_updated'
              AND json_extract(earlier.payload_json, '$.after') IN (
                'awaiting_carrier', 'in_transit', 'delivered', 'returned_to_buyer'
              )
            ORDER BY earlier.sequence DESC
            LIMIT 1
          ), CASE
            WHEN json_extract(payload_json, '$.before') = 'returned_to_buyer' THEN 'returned'
            WHEN json_extract(payload_json, '$.before') IN (
              'awaiting_carrier', 'in_transit', 'delivered'
            ) THEN json_extract(payload_json, '$.before')
            ELSE 'in_transit'
          END),
          '$.after',
          CASE WHEN json_extract(payload_json, '$.after') = 'returned_to_buyer'
            THEN 'returned'
            ELSE json_extract(payload_json, '$.after')
          END
        )
        ELSE payload_json
      END,
      created_at
    FROM aftersales_return_record_events
    WHERE kind <> 'logistics_status_updated'
      OR json_extract(payload_json, '$.after') IN (
        'awaiting_carrier', 'in_transit', 'delivered', 'returned_to_buyer'
      );

    DROP TABLE aftersales_return_record_events;
    ALTER TABLE aftersales_return_record_events_v31 RENAME TO aftersales_return_record_events;

    CREATE TRIGGER aftersales_return_record_events_are_immutable_on_update
    BEFORE UPDATE ON aftersales_return_record_events
    BEGIN
      SELECT RAISE(ABORT, 'aftersales return record events are immutable');
    END;

    CREATE TRIGGER aftersales_return_record_events_are_immutable_on_delete
    BEFORE DELETE ON aftersales_return_record_events
    BEGIN
      SELECT RAISE(ABORT, 'aftersales return record events are immutable');
    END;
  `);
}

type LegacyMixedLogisticsEvent = {
  id: string;
  packageId: string;
  exceptionType: 'lost' | 'delivery_dispute' | 'damaged' | 'misdelivered' | 'other';
  impactJson: string;
  reason: string;
  occurredAt: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedReason: string | null;
};

function migrateLegacyMixedLogisticsFacts(database: DatabaseSync): void {
  const outboundRows = database.prepare(`
    SELECT
      events.id,
      events.package_id,
      events.after_status,
      events.payload_json,
      events.reason,
      events.occurred_at,
      events.created_at,
      (
        SELECT later.occurred_at
        FROM shipment_package_logistics_status_events AS later
        WHERE later.package_id = events.package_id
          AND later.sequence > events.sequence
          AND later.after_status IN (
            'awaiting_carrier', 'in_transit', 'delivered', 'intercepted_returned'
          )
        ORDER BY later.sequence
        LIMIT 1
      ) AS resolved_at,
      (
        SELECT later.reason
        FROM shipment_package_logistics_status_events AS later
        WHERE later.package_id = events.package_id
          AND later.sequence > events.sequence
          AND later.after_status IN (
            'awaiting_carrier', 'in_transit', 'delivered', 'intercepted_returned'
          )
        ORDER BY later.sequence
        LIMIT 1
      ) AS resolved_reason
    FROM shipment_package_logistics_status_events AS events
    WHERE events.after_status IN (
      'lost', 'delivery_dispute', 'damaged', 'misdelivered', 'exception'
    )
    ORDER BY events.sequence
  `).all() as unknown as Array<Record<string, string | number | null>>;
  const outboundEvents = outboundRows.map((row): LegacyMixedLogisticsEvent => ({
    id: asStoredText(row.id, '旧版正向物流异常标识无效'),
    packageId: asStoredText(row.package_id, '旧版正向包裹标识无效'),
    exceptionType: legacyExceptionType(row.after_status),
    impactJson: legacyImpactJson(row.payload_json, '旧版正向物流异常影响范围无效'),
    reason: asStoredText(row.reason, '旧版正向物流异常说明无效'),
    occurredAt: asStoredText(row.occurred_at, '旧版正向物流异常时间无效'),
    createdAt: asStoredText(row.created_at, '旧版正向物流异常创建时间无效'),
    resolvedAt: row.resolved_at === null ? null : asStoredText(row.resolved_at, '旧版正向物流恢复时间无效'),
    resolvedReason: row.resolved_reason === null ? null : asStoredText(row.resolved_reason, '旧版正向物流恢复说明无效'),
  }));

  const returnRows = database.prepare(`
    SELECT
      events.id,
      events.return_record_id,
      events.payload_json,
      events.reason,
      events.occurred_at,
      events.created_at,
      events.sequence
    FROM aftersales_return_record_events AS events
    WHERE events.kind = 'logistics_status_updated'
    ORDER BY events.sequence
  `).all() as unknown as Array<Record<string, string | number | null>>;
  const parsedReturnRows = returnRows.map((row) => {
    const payload = parseStoredJsonRecord(
      row.payload_json,
      '旧版退货物流状态事件无效',
    );
    return { row, payload };
  });
  const returnEvents: LegacyMixedLogisticsEvent[] = [];
  for (const [index, { row, payload }] of parsedReturnRows.entries()) {
    if (!isLegacyExceptionStatus(payload.after)) continue;
    const returnRecordId = asStoredText(row.return_record_id, '旧版退货包裹标识无效');
    const laterNormal = parsedReturnRows.slice(index + 1).find((candidate) => (
      candidate.row.return_record_id === returnRecordId
      && isLegacyNormalReturnStatus(candidate.payload.after)
    ));
    returnEvents.push({
      id: asStoredText(row.id, '旧版退货物流异常标识无效'),
      packageId: returnRecordId,
      exceptionType: legacyExceptionType(payload.after),
      impactJson: legacyImpactFromParsedPayload(payload, '旧版退货物流异常影响范围无效'),
      reason: asStoredText(row.reason, '旧版退货物流异常说明无效'),
      occurredAt: asStoredText(row.occurred_at, '旧版退货物流异常时间无效'),
      createdAt: asStoredText(row.created_at, '旧版退货物流异常创建时间无效'),
      resolvedAt: laterNormal
        ? asStoredText(laterNormal.row.occurred_at, '旧版退货物流恢复时间无效')
        : null,
      resolvedReason: laterNormal
        ? asStoredText(laterNormal.row.reason, '旧版退货物流恢复说明无效')
        : null,
    });
  }

  insertLegacyLogisticsExceptions(database, 'outbound', outboundEvents);
  insertLegacyLogisticsExceptions(database, 'return', returnEvents);
  backfillCurrentMixedExceptionWithoutEvent(database, 'outbound', outboundEvents);
  backfillCurrentMixedExceptionWithoutEvent(database, 'return', returnEvents);

  database.exec(`
    UPDATE shipment_packages
    SET logistics_status = COALESCE((
      SELECT CASE
        WHEN events.after_status IN ('awaiting_carrier', 'in_transit', 'delivered')
          THEN events.after_status
        WHEN events.after_status = 'intercepted_returned' THEN 'intercepted_returned'
        ELSE NULL
      END
      FROM shipment_package_logistics_status_events AS events
      WHERE events.package_id = shipment_packages.id
        AND events.after_status IN (
          'awaiting_carrier', 'in_transit', 'delivered', 'intercepted_returned'
        )
      ORDER BY events.sequence DESC
      LIMIT 1
    ), 'in_transit')
    WHERE logistics_status IN (
      'intercepting', 'lost', 'delivery_dispute', 'damaged', 'misdelivered', 'exception'
    );

    UPDATE aftersales_return_records
    SET logistics_status = COALESCE((
      SELECT CASE
        WHEN json_extract(events.payload_json, '$.after') = 'returned_to_buyer'
          THEN 'returned_to_buyer'
        ELSE json_extract(events.payload_json, '$.after')
      END
      FROM aftersales_return_record_events AS events
      WHERE events.return_record_id = aftersales_return_records.id
        AND events.kind = 'logistics_status_updated'
        AND json_extract(events.payload_json, '$.after') IN (
          'awaiting_carrier', 'in_transit', 'delivered', 'returned_to_buyer'
        )
      ORDER BY events.sequence DESC
      LIMIT 1
    ), CASE
      WHEN status IN ('received', 'inspected') THEN 'delivered'
      ELSE 'in_transit'
    END)
    WHERE logistics_status IN (
      'intercepting', 'lost', 'delivery_dispute', 'damaged', 'misdelivered', 'exception'
    );
  `);
}

function insertLegacyLogisticsExceptions(
  database: DatabaseSync,
  direction: 'outbound' | 'return',
  events: readonly LegacyMixedLogisticsEvent[],
): void {
  const insertMatter = database.prepare(`
    INSERT INTO logistics_exception_matters (
      id, direction, shipment_package_id, return_record_id,
      exception_type, stage, revision, impact_json, reason,
      occurred_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = database.prepare(`
    INSERT INTO logistics_exception_events (
      id, exception_id, kind, base_revision, result_revision,
      before_stage, after_stage, reason, occurred_at, impact_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of events) {
    const matterId = `legacy-${direction}-${event.id}`;
    const initialStage = event.exceptionType === 'lost' ? 'confirmed' : 'pending_verification';
    const resolved = event.resolvedAt !== null;
    insertMatter.run(
      matterId,
      direction,
      direction === 'outbound' ? event.packageId : null,
      direction === 'return' ? event.packageId : null,
      event.exceptionType,
      resolved ? 'resolved' : initialStage,
      resolved ? 2 : 1,
      event.impactJson,
      resolved ? event.resolvedReason : event.reason,
      event.occurredAt,
      event.createdAt,
      resolved ? event.resolvedAt : event.createdAt,
    );
    insertEvent.run(
      `legacy-${direction}-opened-${event.id}`,
      matterId,
      'opened',
      0,
      1,
      null,
      initialStage,
      event.reason,
      event.occurredAt,
      event.impactJson,
      event.createdAt,
    );
    if (resolved && event.resolvedAt && event.resolvedReason) {
      insertEvent.run(
        `legacy-${direction}-resolved-${event.id}`,
        matterId,
        'stage_changed',
        1,
        2,
        initialStage,
        'resolved',
        event.resolvedReason,
        event.resolvedAt,
        null,
        event.resolvedAt,
      );
    }
  }
}

function backfillCurrentMixedExceptionWithoutEvent(
  database: DatabaseSync,
  direction: 'outbound' | 'return',
  migratedEvents: readonly LegacyMixedLogisticsEvent[],
): void {
  const table = direction === 'outbound' ? 'shipment_packages' : 'aftersales_return_records';
  const rows = database.prepare(`
    SELECT id, logistics_status, created_at
    FROM ${table}
    WHERE logistics_status IN (
      'lost', 'delivery_dispute', 'damaged', 'misdelivered', 'exception'
    )
  `).all() as unknown as Array<{ id: string; logistics_status: string; created_at: string }>;
  const packageIdsWithEvents = new Set(migratedEvents.map(({ packageId }) => packageId));
  const missing = rows.filter(({ id }) => !packageIdsWithEvents.has(id)).map((row) => ({
    id: `current-${row.id}`,
    packageId: row.id,
    exceptionType: legacyExceptionType(row.logistics_status),
    impactJson: '{"scope":"package"}',
    reason: '旧版物流异常状态保守升级',
    occurredAt: row.created_at,
    createdAt: row.created_at,
    resolvedAt: null,
    resolvedReason: null,
  } satisfies LegacyMixedLogisticsEvent));
  insertLegacyLogisticsExceptions(database, direction, missing);
}

function legacyImpactJson(value: unknown, message: string): string {
  const payload = parseStoredJsonRecord(value, message);
  return legacyImpactFromParsedPayload(payload, message);
}

function legacyImpactFromParsedPayload(
  payload: Record<string, unknown>,
  message: string,
): string {
  const impact = payload.impact ?? { scope: 'package' };
  if (!impact || typeof impact !== 'object' || Array.isArray(impact)) throw new Error(message);
  const record = impact as Record<string, unknown>;
  if (record.scope === 'package') return '{"scope":"package"}';
  if (record.scope !== 'items' || !Array.isArray(record.items) || record.items.length === 0) {
    throw new Error(message);
  }
  for (const item of record.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(message);
    const value = item as Record<string, unknown>;
    if (
      typeof value.sourceItemId !== 'string'
      || !Number.isSafeInteger(value.quantity)
      || Number(value.quantity) <= 0
    ) throw new Error(message);
  }
  return JSON.stringify(impact);
}

function parseStoredJsonRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error(message);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(message);
  return parsed as Record<string, unknown>;
}

function legacyExceptionType(value: unknown): LegacyMixedLogisticsEvent['exceptionType'] {
  if (
    value === 'lost'
    || value === 'delivery_dispute'
    || value === 'damaged'
    || value === 'misdelivered'
  ) return value;
  if (value === 'exception') return 'other';
  throw new Error('旧版物流异常类型无效');
}

function isLegacyExceptionStatus(value: unknown): boolean {
  return value === 'lost' || value === 'delivery_dispute' || value === 'damaged'
    || value === 'misdelivered' || value === 'exception';
}

function isLegacyNormalReturnStatus(value: unknown): boolean {
  return value === 'awaiting_carrier' || value === 'in_transit' || value === 'delivered'
    || value === 'returned_to_buyer';
}

function asStoredText(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value) throw new Error(message);
  return value;
}

function rebuildFulfillmentStatusTablesForVersion26(database: DatabaseSync): void {
  const draftCreateSql = storedCreateTableSql(database, 'order_drafts');
  const orderCreateSql = storedCreateTableSql(database, 'original_orders');
  const draftV26Sql = replaceFulfillmentStatusConstraint(
    draftCreateSql,
    'order_drafts',
    'order_drafts_v26',
    ['pending_shipment', 'shipped', 'unknown'],
  );
  const orderV26Sql = replaceFulfillmentStatusConstraint(
    orderCreateSql,
    'original_orders',
    'original_orders_v26',
    ['pending_shipment', 'partially_shipped', 'shipped', 'delivered', 'unknown'],
  );
  database.exec(`${draftV26Sql}; ${orderV26Sql};`);

  const draftColumns = storedTableColumnNames(database, 'order_drafts');
  const orderColumns = storedTableColumnNames(database, 'original_orders');
  const draftProjection = draftColumns.map((column) => column === 'fulfillment_status'
    ? `CASE
        WHEN fulfillment_status IN ('pending_shipment', 'shipped', 'unknown')
          THEN fulfillment_status
        WHEN json_extract(recognition_json, '$.fulfillmentStatus')
          IN ('pending_shipment', 'shipped', 'unknown')
          THEN json_extract(recognition_json, '$.fulfillmentStatus')
        ELSE 'unknown'
      END`
    : `"${column}"`);
  const orderProjection = orderColumns.map((column) => column === 'fulfillment_status'
    ? `CASE
        WHEN fulfillment_status NOT IN ('delivered', 'returned') THEN fulfillment_status
        ELSE COALESCE((
          SELECT CASE
            WHEN json_extract(snapshots.confirmed_json, '$.fulfillmentStatus')
              IN ('pending_shipment', 'shipped', 'unknown')
              THEN json_extract(snapshots.confirmed_json, '$.fulfillmentStatus')
            WHEN json_extract(snapshots.recognition_json, '$.fulfillmentStatus')
              IN ('pending_shipment', 'shipped', 'unknown')
              THEN json_extract(snapshots.recognition_json, '$.fulfillmentStatus')
            ELSE 'unknown'
          END
          FROM source_snapshots AS snapshots
          WHERE snapshots.order_id = original_orders.id
          ORDER BY snapshots.created_at DESC, snapshots.id DESC
          LIMIT 1
        ), 'unknown')
      END`
    : `"${column}"`);
  const draftColumnList = draftColumns.map((column) => `"${column}"`).join(', ');
  const orderColumnList = orderColumns.map((column) => `"${column}"`).join(', ');
  database.exec(`
    INSERT INTO order_drafts_v26 (${draftColumnList})
    SELECT ${draftProjection.join(', ')} FROM order_drafts;

    INSERT INTO original_orders_v26 (${orderColumnList})
    SELECT ${orderProjection.join(', ')} FROM original_orders;

    DROP TABLE original_orders;
    DROP TABLE order_drafts;
    ALTER TABLE order_drafts_v26 RENAME TO order_drafts;
    ALTER TABLE original_orders_v26 RENAME TO original_orders;

    CREATE UNIQUE INDEX original_orders_by_normalized_identity
    ON original_orders (
      platform,
      seller_account_normalized,
      platform_order_number_normalized
    );
  `);
}

function storedCreateTableSql(database: DatabaseSync, tableName: string): string {
  const row = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName) as { sql: string } | undefined;
  if (!row?.sql) throw new Error(`数据库缺少表：${tableName}`);
  return row.sql;
}

function storedTableColumnNames(database: DatabaseSync, tableName: string): string[] {
  return (database.prepare(`PRAGMA table_info("${tableName}")`).all() as unknown as Array<{
    name: string;
  }>).map(({ name }) => name);
}

function replaceFulfillmentStatusConstraint(
  createSql: string,
  currentTableName: string,
  nextTableName: string,
  statuses: readonly string[],
): string {
  const renamed = createSql.replace(
    new RegExp(`^CREATE TABLE\\s+"?${currentTableName}"?`, 'u'),
    `CREATE TABLE ${nextTableName}`,
  );
  const constraintPattern = /CHECK\s*\(\s*fulfillment_status\s+IN\s*\([^)]*\)\s*\)/u;
  if (!constraintPattern.test(renamed)) {
    throw new Error(`数据库表 ${currentTableName} 缺少履约状态约束`);
  }
  return renamed.replace(
    constraintPattern,
    `CHECK (fulfillment_status IN (${statuses.map((status) => `'${status}'`).join(', ')}))`,
  );
}

function deduplicatedShipmentArchiveQuantity(
  database: DatabaseSync,
  archiveId: string,
  memberOrderIds: string[],
  asOf?: string,
): number {
  const placeholders = memberOrderIds.map(() => '?').join(', ');
  const memberItems = database.prepare(`
    SELECT id, order_id, position, quantity
    FROM order_items
    WHERE order_id IN (${placeholders})
    ORDER BY order_id, position
  `).all(...memberOrderIds) as unknown as Array<{
    id: string;
    order_id: string;
    position: number;
    quantity: number;
  }>;
  const quantityByItemId = new Map(memberItems.map((item) => (
    [item.id, item.quantity] as const
  )));
  if (asOf) {
    const quantityChanges = database.prepare(`
      SELECT events.order_id, changes.field_path, changes.before_json
      FROM order_change_events AS events
      JOIN order_field_changes AS changes ON changes.event_id = events.id
      WHERE events.order_id IN (${placeholders})
        AND events.created_at > ?
        AND changes.field_path GLOB 'items[[]*[]].quantity'
      ORDER BY events.result_revision DESC, changes.id DESC
    `).all(...memberOrderIds, asOf) as unknown as Array<{
      order_id: string;
      field_path: string;
      before_json: string;
    }>;
    const itemIdByOrderPosition = new Map(memberItems.map((item) => (
      [`${item.order_id}\0${item.position}`, item.id] as const
    )));
    for (const change of quantityChanges) {
      const match = /^items\[(\d+)\]\.quantity$/u.exec(change.field_path);
      if (!match) continue;
      const itemId = itemIdByOrderPosition.get(`${change.order_id}\0${Number(match[1])}`);
      const before: unknown = JSON.parse(change.before_json);
      if (!itemId || !Number.isSafeInteger(before) || (before as number) <= 0) {
        throw new Error('发货组档案商品数量变更记录无效');
      }
      quantityByItemId.set(itemId, before as number);
    }
  }
  const shipmentItems = database.prepare(`
    SELECT
      items.source_order_item_id AS order_item_id,
      MAX(items.source_item_quantity) AS quantity
    FROM shipment_package_items AS items
    JOIN shipment_packages AS packages ON packages.id = items.package_id
    JOIN shipment_records AS records ON records.id = packages.shipment_record_id
    WHERE records.shipment_group_archive_id = ?
      AND items.order_id IN (${placeholders})
    GROUP BY items.source_order_item_id
  `).all(archiveId, ...memberOrderIds) as unknown as Array<{
    order_item_id: string;
    quantity: number;
  }>;
  for (const item of shipmentItems) {
    quantityByItemId.set(
      item.order_item_id,
      Math.max(quantityByItemId.get(item.order_item_id) ?? 0, item.quantity),
    );
  }
  const deduplicatedQuantity = [...quantityByItemId.values()].reduce(
    (total, quantity) => total + quantity,
    0,
  );
  if (deduplicatedQuantity <= 0) {
    throw new Error('发货组档案没有可恢复的商品数量');
  }
  return deduplicatedQuantity;
}

function shipmentItemIdentityChangedAfter(
  database: DatabaseSync,
  memberOrderIds: string[],
  cutoff: string,
): boolean {
  const placeholders = memberOrderIds.map(() => '?').join(', ');
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM order_change_events AS events
    JOIN order_field_changes AS changes ON changes.event_id = events.id
    WHERE events.order_id IN (${placeholders})
      AND events.created_at > ?
      AND (
        changes.field_path GLOB 'items[[]*[]]'
        OR changes.field_path GLOB 'items.removed[[]*[]]'
      )
  `).get(...memberOrderIds, cutoff) as { count: number };
  return row.count > 0;
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
