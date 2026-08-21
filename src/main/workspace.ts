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
import {
  SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES,
  isBoundAftersalesWorkflowStepKind,
} from '../core/aftersales-workflow-templates';

const DATABASE_FILENAME = 'xianyu-order-manager.sqlite3';
const LOCK_FILENAME = '.xianyu-order-manager-writer.sqlite3';
export const CURRENT_WORKSPACE_SCHEMA_VERSION = 64;

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
  if (!versions.has(36)) migrateToVersion36(database);
  if (!versions.has(37)) migrateToVersion37(database);
  if (!versions.has(38)) migrateToVersion38(database);
  if (!versions.has(39)) migrateToVersion39(database);
  if (!versions.has(40)) migrateToVersion40(database);
  if (!versions.has(41)) migrateToVersion41(database);
  if (!versions.has(42)) migrateToVersion42(database);
  if (!versions.has(43)) migrateToVersion43(database);
  if (!versions.has(44)) migrateToVersion44(database);
  if (!versions.has(45)) migrateToVersion45(database);
  if (!versions.has(46)) migrateToVersion46(database);
  if (!versions.has(47)) migrateToVersion47(database);
  if (!versions.has(48)) migrateToVersion48(database);
  if (!versions.has(49)) migrateToVersion49(database);
  if (!versions.has(50)) migrateToVersion50(database);
  if (!versions.has(51)) migrateToVersion51(database);
  if (!versions.has(52)) migrateToVersion52(database);
  if (!versions.has(53)) migrateToVersion53(database);
  if (!versions.has(54)) migrateToVersion54(database);
  if (!versions.has(55)) migrateToVersion55(database);
  if (!versions.has(56)) migrateToVersion56(database);
  if (!versions.has(57)) migrateToVersion57(database);
  if (!versions.has(58)) migrateToVersion58(database);
  if (!versions.has(59)) migrateToVersion59(database);
  if (!versions.has(60)) migrateToVersion60(database);
  if (!versions.has(61)) migrateToVersion61(database);
  if (!versions.has(62)) migrateToVersion62(database);
  if (!versions.has(63)) migrateToVersion63(database);
  if (!versions.has(CURRENT_WORKSPACE_SCHEMA_VERSION)) migrateToVersion64(database);
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
        occurred_at TEXT NOT NULL,
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
  aftersales_interception_packages: `
    CREATE TABLE aftersales_interception_packages (
      case_id TEXT PRIMARY KEY REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      shipment_package_id TEXT NOT NULL REFERENCES shipment_packages(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    ) STRICT`,
  aftersales_interception_package_identity_is_valid_on_insert: `
    CREATE TRIGGER aftersales_interception_package_identity_is_valid_on_insert
    BEFORE INSERT ON aftersales_interception_packages
    WHEN NOT EXISTS (
      SELECT 1
      FROM aftersales_case_items AS case_items
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      WHERE case_items.case_id = NEW.case_id
        AND shipment_items.package_id = NEW.shipment_package_id
    ) BEGIN
      SELECT RAISE(ABORT, 'interception package identity mismatch');
    END`,
  aftersales_interception_packages_are_immutable_on_update: `
    CREATE TRIGGER aftersales_interception_packages_are_immutable_on_update
    BEFORE UPDATE ON aftersales_interception_packages
    BEGIN SELECT RAISE(ABORT, 'interception packages are immutable'); END`,
  aftersales_interception_packages_are_immutable_on_delete: `
    CREATE TRIGGER aftersales_interception_packages_are_immutable_on_delete
    BEFORE DELETE ON aftersales_interception_packages
    BEGIN SELECT RAISE(ABORT, 'interception packages are immutable'); END`,
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
      affected_items_json TEXT NOT NULL CHECK (
        json_valid(affected_items_json)
        AND json_type(affected_items_json) = 'array'
        AND json_array_length(affected_items_json) > 0
      ),
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
          FROM shipment_package_items AS shipment_items
          WHERE shipment_items.package_id = NEW.shipment_package_id
            AND (
              EXISTS (
                SELECT 1 FROM aftersales_case_items AS case_items
                WHERE case_items.case_id = NEW.case_id
                  AND case_items.shipment_package_item_id = shipment_items.id
              )
              OR EXISTS (
                SELECT 1
                FROM aftersales_replacement_items AS replacement_items
                JOIN aftersales_replacement_shipments AS replacements
                  ON replacements.id = replacement_items.replacement_shipment_id
                JOIN aftersales_processing_rounds AS rounds ON rounds.id = replacements.round_id
                WHERE rounds.case_id = NEW.case_id
                  AND replacement_items.shipment_package_item_id = shipment_items.id
              )
            )
            AND (
              json_extract(exceptions.impact_json, '$.scope') = 'package'
              OR EXISTS (
                SELECT 1
                FROM json_each(exceptions.impact_json, '$.items') AS affected_item
                WHERE json_extract(affected_item.value, '$.sourceItemId')
                  = shipment_items.id
              )
            )
        )
        AND json_array_length(NEW.affected_items_json) = (
          SELECT COUNT(DISTINCT json_extract(item.value, '$.shipmentPackageItemId'))
          FROM json_each(NEW.affected_items_json) AS item
        )
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(NEW.affected_items_json) AS selected_item
          WHERE json_type(selected_item.value, '$.quantity') <> 'integer'
            OR json_extract(selected_item.value, '$.quantity') < 1
            OR NOT EXISTS (
              SELECT 1
              FROM shipment_package_items AS shipment_items
              WHERE shipment_items.id = json_extract(
                  selected_item.value, '$.shipmentPackageItemId'
                )
                AND shipment_items.package_id = NEW.shipment_package_id
                AND json_extract(selected_item.value, '$.quantity') = MIN(
                  COALESCE(
                    (
                      SELECT case_items.quantity
                      FROM aftersales_case_items AS case_items
                      WHERE case_items.case_id = NEW.case_id
                        AND case_items.shipment_package_item_id = shipment_items.id
                    ),
                    (
                      SELECT replacement_items.quantity
                      FROM aftersales_replacement_items AS replacement_items
                      JOIN aftersales_replacement_shipments AS replacements
                        ON replacements.id = replacement_items.replacement_shipment_id
                      JOIN aftersales_processing_rounds AS rounds
                        ON rounds.id = replacements.round_id
                      WHERE rounds.case_id = NEW.case_id
                        AND replacement_items.shipment_package_item_id = shipment_items.id
                    )
                  ),
                  CASE json_extract(exceptions.impact_json, '$.scope')
                    WHEN 'package' THEN COALESCE(
                      (
                        SELECT case_items.quantity
                        FROM aftersales_case_items AS case_items
                        WHERE case_items.case_id = NEW.case_id
                          AND case_items.shipment_package_item_id = shipment_items.id
                      ),
                      (
                        SELECT replacement_items.quantity
                        FROM aftersales_replacement_items AS replacement_items
                        JOIN aftersales_replacement_shipments AS replacements
                          ON replacements.id = replacement_items.replacement_shipment_id
                        JOIN aftersales_processing_rounds AS rounds
                          ON rounds.id = replacements.round_id
                        WHERE rounds.case_id = NEW.case_id
                          AND replacement_items.shipment_package_item_id = shipment_items.id
                      )
                    )
                    ELSE (
                      SELECT json_extract(affected_item.value, '$.quantity')
                      FROM json_each(exceptions.impact_json, '$.items') AS affected_item
                      WHERE json_extract(affected_item.value, '$.sourceItemId') = shipment_items.id
                    )
                  END
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
  aftersales_outbound_exception_refund_links: `
    CREATE TABLE aftersales_outbound_exception_refund_links (
      financial_record_id TEXT NOT NULL
        REFERENCES financial_records(id) ON DELETE RESTRICT,
      decision_event_id TEXT NOT NULL
        REFERENCES aftersales_outbound_exception_decision_events(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (financial_record_id, decision_event_id)
    ) STRICT`,
  aftersales_outbound_exception_refund_link_identity_is_valid_on_insert: `
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
    END`,
  aftersales_outbound_exception_refund_links_are_immutable_on_update: `
    CREATE TRIGGER aftersales_outbound_exception_refund_links_are_immutable_on_update
    BEFORE UPDATE ON aftersales_outbound_exception_refund_links
    BEGIN SELECT RAISE(ABORT, 'outbound exception refund links are immutable'); END`,
  aftersales_outbound_exception_refund_links_are_immutable_on_delete: `
    CREATE TRIGGER aftersales_outbound_exception_refund_links_are_immutable_on_delete
    BEFORE DELETE ON aftersales_outbound_exception_refund_links
    BEGIN SELECT RAISE(ABORT, 'outbound exception refund links are immutable'); END`,
  aftersales_outbound_exception_replacement_rounds: `
    CREATE TABLE aftersales_outbound_exception_replacement_rounds (
      exception_id TEXT NOT NULL
        REFERENCES logistics_exception_matters(id) ON DELETE RESTRICT,
      case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
      round_id TEXT NOT NULL UNIQUE
        REFERENCES aftersales_processing_rounds(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (exception_id, round_id)
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
        AND EXISTS (
          SELECT 1
          FROM aftersales_interception_packages AS interception_package
          WHERE interception_package.case_id = NEW.case_id
            AND interception_package.shipment_package_id = NEW.shipment_package_id
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
        AND json_array_length(NEW.items_json) = (
          SELECT COUNT(*)
          FROM aftersales_case_items AS case_items
          JOIN shipment_package_items AS shipment_items
            ON shipment_items.id = case_items.shipment_package_item_id
          WHERE case_items.case_id = NEW.case_id
            AND shipment_items.package_id = NEW.shipment_package_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM aftersales_case_items AS case_items
          JOIN shipment_package_items AS shipment_items
            ON shipment_items.id = case_items.shipment_package_item_id
          WHERE case_items.case_id = NEW.case_id
            AND shipment_items.package_id = NEW.shipment_package_id
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(NEW.items_json) AS selected_item
              WHERE json_extract(selected_item.value, '$.shipmentPackageItemId')
                  = case_items.shipment_package_item_id
                AND json_extract(selected_item.value, '$.quantity') = case_items.quantity
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

const VERSION_36_SCHEMA_STATEMENTS = {
  aftersales_refund_reopening_events: `
    CREATE TABLE aftersales_refund_reopening_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      pending_item_id TEXT NOT NULL
        REFERENCES pending_financial_items(id) ON DELETE RESTRICT,
      previous_requested_amount_cents INTEGER NOT NULL CHECK (previous_requested_amount_cents > 0),
      requested_amount_cents INTEGER NOT NULL CHECK (requested_amount_cents > 0),
      reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT`,
  aftersales_refund_reopening_events_are_immutable_on_update: `
    CREATE TRIGGER aftersales_refund_reopening_events_are_immutable_on_update
    BEFORE UPDATE ON aftersales_refund_reopening_events
    BEGIN SELECT RAISE(ABORT, 'refund reopening events are immutable'); END`,
  aftersales_refund_reopening_events_are_immutable_on_delete: `
    CREATE TRIGGER aftersales_refund_reopening_events_are_immutable_on_delete
    BEFORE DELETE ON aftersales_refund_reopening_events
    BEGIN SELECT RAISE(ABORT, 'refund reopening events are immutable'); END`,
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
      database.exec(`
        INSERT INTO aftersales_interception_packages (
          case_id, shipment_package_id, created_at
        )
        SELECT interception.case_id, MIN(shipment_items.package_id), MIN(interception.created_at)
        FROM aftersales_interception_events AS interception
        JOIN aftersales_case_items AS case_items ON case_items.case_id = interception.case_id
        JOIN shipment_package_items AS shipment_items
          ON shipment_items.id = case_items.shipment_package_item_id
        GROUP BY interception.case_id
        HAVING COUNT(DISTINCT shipment_items.package_id) = 1;
      `);
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

function migrateToVersion36(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
  try {
    const decisionColumns = database.prepare(`
      PRAGMA table_info(aftersales_outbound_exception_decision_events)
    `).all() as Array<{ name: string }>;
    const replacementRoundColumns = database.prepare(`
      PRAGMA table_info(aftersales_outbound_exception_replacement_rounds)
    `).all() as Array<{ name: string; pk: number }>;
    database.exec(`
      DROP TRIGGER IF EXISTS aftersales_outbound_exception_decision_identity_is_valid_on_insert;
      DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_update;
      DROP TRIGGER IF EXISTS aftersales_outbound_exception_decisions_are_immutable_on_delete;
      DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_round_identity_is_valid_on_insert;
      DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_update;
      DROP TRIGGER IF EXISTS aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete;
      DROP INDEX IF EXISTS aftersales_outbound_exception_decisions_by_case;
    `);
    if (replacementRoundColumns.find(({ name }) => name === 'round_id')?.pk !== 2) {
      const replacementRoundTableSql = VERSION_35_SCHEMA_STATEMENTS
        .aftersales_outbound_exception_replacement_rounds
        .replace(
          'CREATE TABLE aftersales_outbound_exception_replacement_rounds',
          'CREATE TABLE aftersales_outbound_exception_replacement_rounds_v36',
        );
      database.exec(replacementRoundTableSql);
      database.exec(`
        INSERT INTO aftersales_outbound_exception_replacement_rounds_v36 (
          exception_id, case_id, round_id, created_at
        )
        SELECT exception_id, case_id, round_id, created_at
        FROM aftersales_outbound_exception_replacement_rounds;
        DROP TABLE aftersales_outbound_exception_replacement_rounds;
        ALTER TABLE aftersales_outbound_exception_replacement_rounds_v36
          RENAME TO aftersales_outbound_exception_replacement_rounds;
      `);
    }
    if (!decisionColumns.some(({ name }) => name === 'affected_items_json')) {
      const legacyRows = database.prepare(`
        SELECT * FROM aftersales_outbound_exception_decision_events ORDER BY sequence
      `).all() as Array<Record<string, unknown>>;
      const replacementTableSql = VERSION_35_SCHEMA_STATEMENTS
        .aftersales_outbound_exception_decision_events
        .replace(
          'CREATE TABLE aftersales_outbound_exception_decision_events',
          'CREATE TABLE aftersales_outbound_exception_decision_events_v36',
        );
      database.exec(replacementTableSql);
      const insertDecision = database.prepare(`
        INSERT INTO aftersales_outbound_exception_decision_events_v36 (
          sequence, id, case_id, exception_id, shipment_package_id, kind,
          before_decision, after_decision, affected_items_json,
          occurred_at, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of legacyRows) {
        const caseId = String(row.case_id);
        const packageId = String(row.shipment_package_id);
        const exceptionRow = database.prepare(`
          SELECT impact_json FROM logistics_exception_matters WHERE id = ?
        `).get(String(row.exception_id)) as { impact_json: string } | undefined;
        const impact = exceptionRow
          ? JSON.parse(exceptionRow.impact_json) as {
            scope: 'package' | 'items';
            items?: Array<{ sourceItemId: string; quantity: number }>;
          }
          : null;
        const caseItems = database.prepare(`
          SELECT case_items.shipment_package_item_id, case_items.quantity,
                 shipment_items.source_title, shipment_items.source_spec
          FROM aftersales_case_items AS case_items
          JOIN shipment_package_items AS shipment_items
            ON shipment_items.id = case_items.shipment_package_item_id
          WHERE case_items.case_id = ? AND shipment_items.package_id = ?
          ORDER BY case_items.shipment_package_item_id
        `).all(caseId, packageId) as Array<{
          shipment_package_item_id: string;
          quantity: number;
          source_title: string;
          source_spec: string;
        }>;
        const affectedItems = caseItems.flatMap((item) => {
          const affectedQuantity = impact?.scope === 'package'
            ? item.quantity
            : Math.min(
              item.quantity,
              impact?.items?.find(({ sourceItemId }) => (
                sourceItemId === item.shipment_package_item_id
              ))?.quantity ?? 0,
            );
          return affectedQuantity > 0 ? [{
            shipmentPackageItemId: item.shipment_package_item_id,
            sourceTitle: item.source_title,
            sourceSpec: item.source_spec,
            quantity: affectedQuantity,
          }] : [];
        });
        if (affectedItems.length === 0) {
          throw new Error('旧 v35 正向异常选择无法回填受影响商品');
        }
        insertDecision.run(
          Number(row.sequence), String(row.id), caseId, String(row.exception_id), packageId,
          String(row.kind), row.before_decision as string | null, String(row.after_decision),
          JSON.stringify(affectedItems), String(row.occurred_at), String(row.reason),
          String(row.created_at),
        );
      }
      database.exec(`
        DROP TABLE aftersales_outbound_exception_decision_events;
        ALTER TABLE aftersales_outbound_exception_decision_events_v36
          RENAME TO aftersales_outbound_exception_decision_events;
      `);
    }

    database.exec([
      VERSION_35_SCHEMA_STATEMENTS.aftersales_outbound_exception_decisions_by_case,
      VERSION_35_SCHEMA_STATEMENTS
        .aftersales_outbound_exception_decision_identity_is_valid_on_insert,
      VERSION_35_SCHEMA_STATEMENTS.aftersales_outbound_exception_decisions_are_immutable_on_update,
      VERSION_35_SCHEMA_STATEMENTS.aftersales_outbound_exception_decisions_are_immutable_on_delete,
      VERSION_35_SCHEMA_STATEMENTS
        .aftersales_outbound_exception_replacement_round_identity_is_valid_on_insert,
      VERSION_35_SCHEMA_STATEMENTS
        .aftersales_outbound_exception_replacement_rounds_are_immutable_on_update,
      VERSION_35_SCHEMA_STATEMENTS
        .aftersales_outbound_exception_replacement_rounds_are_immutable_on_delete,
    ].join(';\n'));

    createMissingSchemaObject(
      database,
      'aftersales_interception_packages',
      VERSION_35_SCHEMA_STATEMENTS.aftersales_interception_packages,
    );
    database.exec(`
      INSERT OR IGNORE INTO aftersales_interception_packages (
        case_id, shipment_package_id, created_at
      )
      SELECT inspections.case_id, inspections.shipment_package_id, inspections.created_at
      FROM aftersales_intercepted_return_inspection_events AS inspections;

      INSERT OR IGNORE INTO aftersales_interception_packages (
        case_id, shipment_package_id, created_at
      )
      SELECT interception.case_id, MIN(shipment_items.package_id), MIN(interception.created_at)
      FROM aftersales_interception_events AS interception
      JOIN aftersales_case_items AS case_items ON case_items.case_id = interception.case_id
      JOIN shipment_package_items AS shipment_items
        ON shipment_items.id = case_items.shipment_package_item_id
      GROUP BY interception.case_id
      HAVING COUNT(DISTINCT shipment_items.package_id) = 1;
    `);
    for (const name of [
      'aftersales_interception_package_identity_is_valid_on_insert',
      'aftersales_interception_packages_are_immutable_on_update',
      'aftersales_interception_packages_are_immutable_on_delete',
    ] as const) {
      createMissingSchemaObject(database, name, VERSION_35_SCHEMA_STATEMENTS[name]);
    }

    for (const name of [
      'aftersales_outbound_exception_refund_links',
      'aftersales_outbound_exception_refund_link_identity_is_valid_on_insert',
      'aftersales_outbound_exception_refund_links_are_immutable_on_update',
      'aftersales_outbound_exception_refund_links_are_immutable_on_delete',
    ] as const) {
      createMissingSchemaObject(database, name, VERSION_35_SCHEMA_STATEMENTS[name]);
    }
    database.exec(`
      INSERT OR IGNORE INTO aftersales_outbound_exception_refund_links (
        financial_record_id, decision_event_id, created_at
      )
      SELECT financial.id, decisions.id, financial.created_at
      FROM financial_records AS financial
      JOIN aftersales_outbound_exception_decision_events AS decisions
        ON decisions.case_id = financial.aftersales_case_id
      WHERE financial.kind = 'aftersales_refund'
        AND decisions.after_decision IN ('refund_only', 'refund_and_replacement')
        AND decisions.sequence = (
          SELECT MAX(latest.sequence)
          FROM aftersales_outbound_exception_decision_events AS latest
          WHERE latest.case_id = decisions.case_id
            AND latest.exception_id = decisions.exception_id
            AND julianday(latest.occurred_at) <= julianday(financial.occurred_at)
        );
    `);
    for (const [name, sql] of Object.entries(VERSION_36_SCHEMA_STATEMENTS)) {
      createMissingSchemaObject(database, name, sql);
    }

    database.exec(`
      DROP TRIGGER IF EXISTS aftersales_intercepted_return_inspection_identity_is_valid_on_insert;
    `);
    database.exec(
      VERSION_35_SCHEMA_STATEMENTS.aftersales_intercepted_return_inspection_identity_is_valid_on_insert,
    );
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (36, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* Preserve migration failure. */ }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function migrateToVersion37(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS pending_financial_item_events_are_immutable_on_update;
      DROP TRIGGER IF EXISTS pending_financial_item_events_are_immutable_on_delete;
      DROP TRIGGER IF EXISTS pending_financial_item_events_require_occurred_at_on_insert;
      DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_are_immutable_on_update;
      DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_are_immutable_on_delete;
      DROP TRIGGER IF EXISTS aftersales_refund_reopening_events_require_occurred_at_on_insert;
    `);
    const columns = database.prepare(`
      SELECT name FROM pragma_table_info('pending_financial_item_events')
    `).all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === 'occurred_at')) {
      database.exec('ALTER TABLE pending_financial_item_events ADD COLUMN occurred_at TEXT;');
    }
    const reopeningColumns = database.prepare(`
      SELECT name FROM pragma_table_info('aftersales_refund_reopening_events')
    `).all() as Array<{ name: string }>;
    if (!reopeningColumns.some(({ name }) => name === 'occurred_at')) {
      database.exec('ALTER TABLE aftersales_refund_reopening_events ADD COLUMN occurred_at TEXT;');
    }
    database.exec(`
      UPDATE pending_financial_item_events
      SET occurred_at = created_at
      WHERE occurred_at IS NULL;

      UPDATE aftersales_refund_reopening_events AS reopen
      SET occurred_at = COALESCE((
        SELECT decisions.occurred_at
        FROM pending_financial_items AS pending
        JOIN aftersales_outbound_exception_decision_events AS decisions
          ON decisions.case_id = pending.aftersales_case_id
        WHERE pending.id = reopen.pending_item_id
          AND decisions.after_decision IN ('refund_only', 'refund_and_replacement')
          AND decisions.created_at <= reopen.created_at
        ORDER BY decisions.sequence DESC
        LIMIT 1
      ), reopen.created_at)
      WHERE occurred_at IS NULL;

      CREATE TRIGGER pending_financial_item_events_require_occurred_at_on_insert
      BEFORE INSERT ON pending_financial_item_events
      WHEN NEW.occurred_at IS NULL OR length(trim(NEW.occurred_at)) = 0
      BEGIN
        SELECT RAISE(ABORT, 'pending financial item event occurred_at is required');
      END;

      CREATE TRIGGER pending_financial_item_events_are_immutable_on_update
      BEFORE UPDATE ON pending_financial_item_events
      BEGIN
        SELECT RAISE(ABORT, 'pending financial item events are immutable');
      END;

      CREATE TRIGGER pending_financial_item_events_are_immutable_on_delete
      BEFORE DELETE ON pending_financial_item_events
      BEGIN
        SELECT RAISE(ABORT, 'pending financial item events are immutable');
      END;

      CREATE TRIGGER aftersales_refund_reopening_events_require_occurred_at_on_insert
      BEFORE INSERT ON aftersales_refund_reopening_events
      WHEN NEW.occurred_at IS NULL OR length(trim(NEW.occurred_at)) = 0
      BEGIN
        SELECT RAISE(ABORT, 'refund reopening event occurred_at is required');
      END;

      CREATE TRIGGER aftersales_refund_reopening_events_are_immutable_on_update
      BEFORE UPDATE ON aftersales_refund_reopening_events
      BEGIN SELECT RAISE(ABORT, 'refund reopening events are immutable'); END;

      CREATE TRIGGER aftersales_refund_reopening_events_are_immutable_on_delete
      BEFORE DELETE ON aftersales_refund_reopening_events
      BEGIN SELECT RAISE(ABORT, 'refund reopening events are immutable'); END;
    `);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (37, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* Preserve migration failure. */ }
    throw error;
  }
}

function migrateToVersion38(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      DROP TRIGGER aftersales_direction_events_are_immutable_on_update;
      DROP TRIGGER aftersales_direction_events_are_immutable_on_delete;

      CREATE TABLE aftersales_handling_direction_events_v38 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('selected', 'changed', 'cleared')),
        before_direction TEXT CHECK (
          before_direction IS NULL OR before_direction IN (
            'waiting', 'intercept', 'refuse', 'only_refund', 'replacement', 'buyer_return'
          )
        ),
        after_direction TEXT CHECK (
          after_direction IS NULL OR after_direction IN (
            'waiting', 'intercept', 'refuse', 'only_refund', 'replacement', 'buyer_return'
          )
        ),
        occurred_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL,
        CHECK (
          (kind = 'selected' AND before_direction IS NULL AND after_direction IS NOT NULL)
          OR (kind = 'changed' AND before_direction IS NOT NULL
            AND after_direction IS NOT NULL AND before_direction <> after_direction)
          OR (kind = 'cleared' AND before_direction IS NOT NULL AND after_direction IS NULL)
        )
      ) STRICT;

      INSERT INTO aftersales_handling_direction_events_v38 (
        sequence, id, case_id, kind, before_direction, after_direction,
        occurred_at, reason, created_at
      )
      SELECT sequence, id, case_id, kind, before_direction, after_direction,
        occurred_at, reason, created_at
      FROM aftersales_handling_direction_events;

      DROP TABLE aftersales_handling_direction_events;
      ALTER TABLE aftersales_handling_direction_events_v38
        RENAME TO aftersales_handling_direction_events;

      CREATE INDEX aftersales_direction_events_by_case
      ON aftersales_handling_direction_events (case_id, sequence);

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

      CREATE TABLE aftersales_workflow_templates (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL CHECK (origin IN ('system', 'custom')),
        system_key TEXT UNIQUE CHECK (
          (origin = 'system' AND system_key IN (
            'refund_only', 'return_refund', 'exchange', 'direct_replacement',
            'intercept_return', 'lost_handling', 'other'
          ))
          OR (origin = 'custom' AND system_key IS NULL)
        ),
        name_key TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        current_version INTEGER NOT NULL CHECK (current_version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (id, current_version)
      ) STRICT;

      CREATE TABLE aftersales_workflow_template_versions (
        template_id TEXT NOT NULL
          REFERENCES aftersales_workflow_templates(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL CHECK (version >= 1),
        definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (template_id, version)
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER aftersales_workflow_template_versions_are_immutable_on_update
      BEFORE UPDATE ON aftersales_workflow_template_versions
      BEGIN
        SELECT RAISE(ABORT, 'aftersales workflow template versions are immutable');
      END;

      CREATE TRIGGER aftersales_workflow_template_versions_are_immutable_on_delete
      BEFORE DELETE ON aftersales_workflow_template_versions
      BEGIN
        SELECT RAISE(ABORT, 'aftersales workflow template versions are immutable');
      END;

      CREATE TABLE aftersales_case_workflow_template_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('selected', 'changed')),
        before_template_id TEXT,
        before_template_version INTEGER,
        after_template_id TEXT NOT NULL,
        after_template_version INTEGER NOT NULL CHECK (after_template_version >= 1),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (before_template_id, before_template_version)
          REFERENCES aftersales_workflow_template_versions(template_id, version)
          ON DELETE RESTRICT,
        FOREIGN KEY (after_template_id, after_template_version)
          REFERENCES aftersales_workflow_template_versions(template_id, version)
          ON DELETE RESTRICT,
        CHECK (
          (kind = 'selected' AND before_template_id IS NULL AND before_template_version IS NULL)
          OR (kind = 'changed' AND before_template_id IS NOT NULL
            AND before_template_version IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX aftersales_case_workflow_template_events_by_case
      ON aftersales_case_workflow_template_events (case_id, sequence);

      CREATE TRIGGER aftersales_case_workflow_template_events_are_immutable_on_update
      BEFORE UPDATE ON aftersales_case_workflow_template_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales case workflow template events are immutable');
      END;

      CREATE TRIGGER aftersales_case_workflow_template_events_are_immutable_on_delete
      BEFORE DELETE ON aftersales_case_workflow_template_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales case workflow template events are immutable');
      END;
    `);
    const createdAt = new Date().toISOString();
    const insertTemplate = database.prepare(`
      INSERT INTO aftersales_workflow_templates (
        id, origin, system_key, name_key, enabled, current_version, created_at, updated_at
      ) VALUES (?, 'system', ?, ?, 1, 1, ?, ?)
    `);
    const insertVersion = database.prepare(`
      INSERT INTO aftersales_workflow_template_versions (
        template_id, version, definition_json, created_at
      ) VALUES (?, 1, ?, ?)
    `);
    for (const preset of SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES) {
      insertTemplate.run(
        preset.id,
        preset.systemKey,
        preset.definition.name.normalize('NFKC').toLocaleLowerCase('zh-CN'),
        createdAt,
        createdAt,
      );
      insertVersion.run(preset.id, JSON.stringify(preset.definition), createdAt);
    }
    database.prepare(`
      INSERT INTO aftersales_case_workflow_template_events (
        id, case_id, kind, before_template_id, before_template_version,
        after_template_id, after_template_version, reason, occurred_at, created_at
      )
      SELECT
        lower(hex(randomblob(16))),
        cases.id,
        'selected',
        NULL,
        NULL,
        CASE cases.workflow
          WHEN 'refund_only' THEN ?
          WHEN 'return_refund' THEN ?
          WHEN 'exchange' THEN ?
          WHEN 'direct_replacement' THEN ?
          ELSE ?
        END,
        1,
        '旧售后处理单按原处理方式关联预置流程',
        cases.occurred_at,
        ?
      FROM aftersales_cases AS cases
    `).run(
      SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES[0].id,
      SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES[1].id,
      SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES[2].id,
      SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES[3].id,
      SYSTEM_AFTERSALES_WORKFLOW_TEMPLATES[6].id,
      createdAt,
    );
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (38, ?)')
      .run(createdAt);
    database.exec('COMMIT;');
  } catch (error) {
    try { database.exec('ROLLBACK;'); } catch { /* Preserve migration failure. */ }
    throw error;
  }
}

function migrateToVersion39(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    database.exec(`
      DROP TRIGGER custom_field_definitions_keep_template_granularity_on_update;
      DROP TRIGGER table_templates_prevent_granularity_change_with_dependencies;
      DROP TRIGGER table_template_dependencies_match_granularity_on_insert;
      DROP TRIGGER table_template_dependencies_match_granularity_on_update;
      DROP TRIGGER custom_field_values_owner_matches_definition_on_insert;
      DROP TRIGGER custom_field_values_owner_matches_definition_on_update;

      CREATE TABLE custom_field_definitions_v39 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        granularity TEXT NOT NULL
          CHECK (granularity IN ('order', 'order_item', 'shipment_group')),
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

      INSERT INTO custom_field_definitions_v39 (
        id, name, granularity, value_type, required,
        default_value_json, options_json, created_at, updated_at
      )
      SELECT
        id, name, granularity, value_type, required,
        default_value_json, options_json, created_at, updated_at
      FROM custom_field_definitions;

      CREATE TABLE table_templates_v39 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        granularity TEXT NOT NULL
          CHECK (granularity IN ('order', 'order_item', 'shipment_group')),
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

      INSERT INTO table_templates_v39 (
        id, name, name_key, granularity, configuration_version,
        configuration_json, created_at, updated_at
      )
      SELECT
        id, name, name_key, granularity, configuration_version,
        configuration_json, created_at, updated_at
      FROM table_templates;

      DROP TABLE table_templates;
      ALTER TABLE table_templates_v39 RENAME TO table_templates;
      DROP TABLE custom_field_definitions;
      ALTER TABLE custom_field_definitions_v39 RENAME TO custom_field_definitions;

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

      CREATE TABLE shipment_group_custom_field_values (
        id TEXT PRIMARY KEY,
        definition_id TEXT NOT NULL
          REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
        shipment_group_id TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (definition_id, shipment_group_id)
      ) STRICT;

      CREATE INDEX shipment_group_custom_field_values_by_group
      ON shipment_group_custom_field_values (shipment_group_id, definition_id);

      CREATE TRIGGER shipment_group_custom_field_values_match_definition_on_insert
      BEFORE INSERT ON shipment_group_custom_field_values
      WHEN NOT EXISTS (
        SELECT 1
        FROM custom_field_definitions AS definitions
        WHERE definitions.id = NEW.definition_id
          AND definitions.granularity = 'shipment_group'
      )
      BEGIN
        SELECT RAISE(ABORT, 'shipment group custom field granularity does not match');
      END;

      CREATE TRIGGER shipment_group_custom_field_values_match_definition_on_update
      BEFORE UPDATE ON shipment_group_custom_field_values
      WHEN NOT EXISTS (
        SELECT 1
        FROM custom_field_definitions AS definitions
        WHERE definitions.id = NEW.definition_id
          AND definitions.granularity = 'shipment_group'
      )
      BEGIN
        SELECT RAISE(ABORT, 'shipment group custom field granularity does not match');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (39, ?)')
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

function migrateToVersion40(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE standard_products (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL CHECK (length(trim(sku)) BETWEEN 1 AND 100),
        sku_key TEXT NOT NULL UNIQUE CHECK (length(trim(sku_key)) BETWEEN 1 AND 100),
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 300),
        specification TEXT NOT NULL CHECK (length(trim(specification)) BETWEEN 1 AND 300),
        name_key TEXT NOT NULL CHECK (length(trim(name_key)) BETWEEN 1 AND 300),
        specification_key TEXT NOT NULL CHECK (length(trim(specification_key)) BETWEEN 1 AND 300),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE product_mappings (
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

      CREATE INDEX product_mappings_by_standard_product
      ON product_mappings (standard_product_id, source_title_key, source_spec_key);

      ALTER TABLE order_items
      ADD COLUMN standard_product_id TEXT
        REFERENCES standard_products(id) ON DELETE RESTRICT;

      ALTER TABLE order_items
      ADD COLUMN standardization_source TEXT
        CHECK (standardization_source IN ('exact', 'mapping', 'manual'));

      CREATE INDEX order_items_by_standard_product
      ON order_items (standard_product_id, order_id, position);

      CREATE TRIGGER order_items_standardization_is_consistent_on_insert
      BEFORE INSERT ON order_items
      WHEN (NEW.standard_product_id IS NULL) <> (NEW.standardization_source IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'order item standardization is inconsistent');
      END;

      CREATE TRIGGER order_items_standardization_is_consistent_on_update
      BEFORE UPDATE OF standard_product_id, standardization_source ON order_items
      WHEN (NEW.standard_product_id IS NULL) <> (NEW.standardization_source IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'order item standardization is inconsistent');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (40, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion41(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE fulfillment_plans (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('presale', 'group_buy')),
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'partially_released', 'released', 'delayed', 'closed'
        )),
        expected_ship_at TEXT,
        target_quantity INTEGER CHECK (target_quantity IS NULL OR target_quantity > 0),
        deadline_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        CHECK ((status = 'closed') = (closed_at IS NOT NULL))
      ) STRICT;

      CREATE TABLE fulfillment_plan_members (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES fulfillment_plans(id) ON DELETE RESTRICT,
        order_id TEXT NOT NULL REFERENCES original_orders(id) ON DELETE RESTRICT,
        joined_at TEXT NOT NULL,
        join_reason TEXT NOT NULL CHECK (length(trim(join_reason)) BETWEEN 1 AND 500),
        released_at TEXT,
        released_reason TEXT CHECK (
          released_reason IS NULL OR length(trim(released_reason)) BETWEEN 1 AND 500
        ),
        removed_at TEXT,
        removed_reason TEXT CHECK (
          removed_reason IS NULL OR length(trim(removed_reason)) BETWEEN 1 AND 500
        ),
        CHECK ((released_at IS NULL) = (released_reason IS NULL)),
        CHECK ((removed_at IS NULL) = (removed_reason IS NULL)),
        CHECK (released_at IS NULL OR removed_at IS NULL)
      ) STRICT;

      CREATE UNIQUE INDEX fulfillment_plan_members_one_active_per_order
      ON fulfillment_plan_members (order_id)
      WHERE released_at IS NULL AND removed_at IS NULL;

      CREATE INDEX fulfillment_plan_members_by_plan
      ON fulfillment_plan_members (plan_id, joined_at);

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
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (41, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion42(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE recipients (
        id TEXT PRIMARY KEY,
        recipient_number INTEGER NOT NULL UNIQUE CHECK (recipient_number > 0),
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        phone_normalized TEXT NOT NULL CHECK (length(phone_normalized) > 0),
        display_name TEXT,
        merged_into_recipient_id TEXT REFERENCES recipients(id),
        merged_reason TEXT CHECK (
          merged_reason IS NULL OR length(trim(merged_reason)) BETWEEN 1 AND 500
        ),
        merged_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (name, phone_normalized),
        CHECK (
          (merged_into_recipient_id IS NULL) = (merged_reason IS NULL)
          AND (merged_reason IS NULL) = (merged_at IS NULL)
        )
      ) STRICT;

      CREATE TRIGGER recipients_identity_is_immutable_on_update
      BEFORE UPDATE ON recipients
      WHEN OLD.name <> NEW.name
        OR OLD.phone_normalized <> NEW.phone_normalized
        OR OLD.recipient_number <> NEW.recipient_number
      BEGIN
        SELECT RAISE(ABORT, 'recipient identity is immutable');
      END;

      ALTER TABLE shipment_record_order_snapshots
        ADD COLUMN readable_order_number TEXT;
    `);
    database.prepare(`
      INSERT INTO recipients (id, recipient_number, name, phone_normalized, created_at)
      SELECT
        lower(hex(randomblob(16))),
        ROW_NUMBER() OVER (ORDER BY first_created_at, first_order_id),
        name,
        phone_normalized,
        ?
      FROM (
        SELECT
          recipient AS name,
          phone_normalized,
          MIN(created_at) AS first_created_at,
          MIN(id) AS first_order_id
        FROM original_orders
        WHERE trim(recipient) <> '' AND phone_normalized <> ''
        GROUP BY recipient, phone_normalized
      )
      ORDER BY first_created_at, first_order_id
    `).run(new Date().toISOString());
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (42, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion43(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE standard_products
      ADD COLUMN default_order_price_cents INTEGER
        CHECK (
          default_order_price_cents IS NULL OR default_order_price_cents >= 0
        );

      CREATE TABLE standard_product_price_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        standard_product_id TEXT NOT NULL
          REFERENCES standard_products(id) ON DELETE RESTRICT,
        previous_default_order_price_cents INTEGER
          CHECK (
            previous_default_order_price_cents IS NULL
            OR previous_default_order_price_cents >= 0
          ),
        default_order_price_cents INTEGER
          CHECK (
            default_order_price_cents IS NULL OR default_order_price_cents >= 0
          ),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX standard_product_price_events_by_product
      ON standard_product_price_events (standard_product_id, sequence);

      CREATE TRIGGER standard_product_price_events_are_immutable_on_update
      BEFORE UPDATE ON standard_product_price_events
      BEGIN SELECT RAISE(ABORT, 'standard product price events are immutable'); END;

      CREATE TRIGGER standard_product_price_events_are_immutable_on_delete
      BEFORE DELETE ON standard_product_price_events
      BEGIN SELECT RAISE(ABORT, 'standard product price events are immutable'); END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (43, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion44(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE order_items
      ADD COLUMN standard_display_preference TEXT
        CHECK (standard_display_preference IN ('prefer_standard', 'prefer_source'));

      UPDATE order_items
      SET standard_display_preference = 'prefer_standard'
      WHERE standard_product_id IS NOT NULL;

      CREATE TRIGGER order_items_standard_display_preference_is_consistent_on_insert
      BEFORE INSERT ON order_items
      WHEN (NEW.standard_product_id IS NULL) <> (NEW.standard_display_preference IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'order item standard display preference is inconsistent');
      END;

      CREATE TRIGGER order_items_standard_display_preference_is_consistent_on_update
      BEFORE UPDATE OF standard_product_id, standard_display_preference ON order_items
      WHEN (NEW.standard_product_id IS NULL) <> (NEW.standard_display_preference IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'order item standard display preference is inconsistent');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (44, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion45(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE order_item_standardization_batch_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        batch_id TEXT NOT NULL,
        order_id TEXT NOT NULL
          REFERENCES original_orders(id) ON DELETE RESTRICT,
        order_item_id TEXT NOT NULL
          REFERENCES order_items(id) ON DELETE RESTRICT,
        target_standard_product_id TEXT NOT NULL
          REFERENCES standard_products(id) ON DELETE RESTRICT,
        before_standard_product_id TEXT
          REFERENCES standard_products(id) ON DELETE RESTRICT,
        after_standard_product_id TEXT
          REFERENCES standard_products(id) ON DELETE RESTRICT,
        standard_display_preference TEXT NOT NULL
          CHECK (standard_display_preference IN ('prefer_standard', 'prefer_source')),
        use_default_order_price INTEGER NOT NULL
          CHECK (use_default_order_price IN (0, 1)),
        applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
        block_reason TEXT CHECK (
          block_reason IS NULL
          OR block_reason IN ('linked_other_product', 'amount_mismatch')
        ),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (
          (applied = 1 AND block_reason IS NULL)
          OR (applied = 0 AND block_reason IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX order_item_standardization_batch_events_by_batch
      ON order_item_standardization_batch_events (batch_id, sequence);

      CREATE TRIGGER order_item_standardization_batch_events_are_immutable_on_update
      BEFORE UPDATE ON order_item_standardization_batch_events
      BEGIN
        SELECT RAISE(ABORT, 'order item standardization batch events are immutable');
      END;

      CREATE TRIGGER order_item_standardization_batch_events_are_immutable_on_delete
      BEFORE DELETE ON order_item_standardization_batch_events
      BEGIN
        SELECT RAISE(ABORT, 'order item standardization batch events are immutable');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (45, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion46(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  try {
    database.exec('BEGIN IMMEDIATE;');
    database.exec(`
      CREATE TABLE product_mappings_v46 (
        id TEXT PRIMARY KEY,
        source_title TEXT NOT NULL CHECK (length(trim(source_title)) BETWEEN 1 AND 300),
        source_spec TEXT NOT NULL CHECK (length(source_spec) <= 300),
        source_title_key TEXT NOT NULL CHECK (length(trim(source_title_key)) BETWEEN 1 AND 300),
        source_spec_key TEXT NOT NULL CHECK (length(source_spec_key) <= 300),
        standard_product_id TEXT NOT NULL
          REFERENCES standard_products(id) ON DELETE RESTRICT,
        scope TEXT NOT NULL
          CHECK (scope IN ('current_account', 'current_platform', 'workspace')),
        platform TEXT CHECK (platform IS NULL OR length(trim(platform)) BETWEEN 1 AND 200),
        seller_account TEXT CHECK (
          seller_account IS NULL OR length(trim(seller_account)) BETWEEN 1 AND 200
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (scope = 'current_account' AND platform IS NOT NULL AND seller_account IS NOT NULL)
          OR (scope = 'current_platform' AND platform IS NOT NULL AND seller_account IS NULL)
          OR (scope = 'workspace' AND platform IS NULL AND seller_account IS NULL)
        )
      ) STRICT;

      INSERT INTO product_mappings_v46 (
        id, source_title, source_spec, source_title_key, source_spec_key,
        standard_product_id, scope, platform, seller_account, created_at, updated_at
      )
      SELECT
        id, source_title, source_spec, source_title_key, source_spec_key,
        standard_product_id, 'workspace', NULL, NULL, created_at, updated_at
      FROM product_mappings;

      DROP TABLE product_mappings;
      ALTER TABLE product_mappings_v46 RENAME TO product_mappings;

      CREATE UNIQUE INDEX product_mappings_one_per_account_source
      ON product_mappings (platform, seller_account, source_title_key, source_spec_key)
      WHERE scope = 'current_account';

      CREATE UNIQUE INDEX product_mappings_one_per_platform_source
      ON product_mappings (platform, source_title_key, source_spec_key)
      WHERE scope = 'current_platform';

      CREATE UNIQUE INDEX product_mappings_one_per_workspace_source
      ON product_mappings (source_title_key, source_spec_key)
      WHERE scope = 'workspace';

      CREATE INDEX product_mappings_by_standard_product
      ON product_mappings (standard_product_id, source_title_key, source_spec_key);
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (46, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function migrateToVersion47(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE product_mappings
      ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled'));

      ALTER TABLE product_mappings
      ADD COLUMN origin TEXT NOT NULL DEFAULT 'confirmation'
        CHECK (origin IN ('confirmation', 'manual'));

      ALTER TABLE product_mappings
      ADD COLUMN last_used_at TEXT;

      DROP INDEX product_mappings_one_per_account_source;
      DROP INDEX product_mappings_one_per_platform_source;
      DROP INDEX product_mappings_one_per_workspace_source;

      CREATE UNIQUE INDEX product_mappings_one_per_account_source
      ON product_mappings (platform, seller_account, source_title_key, source_spec_key)
      WHERE scope = 'current_account' AND status = 'active';

      CREATE UNIQUE INDEX product_mappings_one_per_platform_source
      ON product_mappings (platform, source_title_key, source_spec_key)
      WHERE scope = 'current_platform' AND status = 'active';

      CREATE UNIQUE INDEX product_mappings_one_per_workspace_source
      ON product_mappings (source_title_key, source_spec_key)
      WHERE scope = 'workspace' AND status = 'active';

      CREATE TABLE product_mapping_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        mapping_id TEXT NOT NULL,
        standard_product_id TEXT NOT NULL,
        event_type TEXT NOT NULL
          CHECK (event_type IN ('created', 'corrected', 'disabled', 'deleted')),
        before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
        after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
        origin TEXT NOT NULL CHECK (origin IN ('confirmation', 'manual')),
        reason TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (
          (event_type = 'created' AND before_json IS NULL AND after_json IS NOT NULL)
          OR (
            event_type = 'corrected'
            AND before_json IS NOT NULL AND after_json IS NOT NULL
            AND before_json <> after_json
            AND length(trim(reason)) BETWEEN 1 AND 500
          )
          OR (
            event_type = 'disabled'
            AND before_json IS NOT NULL AND after_json IS NOT NULL
            AND length(trim(reason)) BETWEEN 1 AND 500
          )
          OR (
            event_type = 'deleted'
            AND before_json IS NOT NULL AND after_json IS NULL
            AND length(trim(reason)) BETWEEN 1 AND 500
          )
        )
      ) STRICT;

      CREATE INDEX product_mapping_events_by_product
      ON product_mapping_events (standard_product_id, sequence);

      CREATE TRIGGER product_mapping_events_are_immutable_on_update
      BEFORE UPDATE ON product_mapping_events
      BEGIN SELECT RAISE(ABORT, 'product mapping events are immutable'); END;

      CREATE TRIGGER product_mapping_events_are_immutable_on_delete
      BEFORE DELETE ON product_mapping_events
      BEGIN SELECT RAISE(ABORT, 'product mapping events are immutable'); END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (47, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion48(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE product_identity_correction_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        correction_id TEXT NOT NULL,
        mapping_id TEXT NOT NULL,
        order_id TEXT NOT NULL
          REFERENCES original_orders(id) ON DELETE RESTRICT,
        order_item_id TEXT NOT NULL
          REFERENCES order_items(id) ON DELETE RESTRICT,
        before_standard_product_id TEXT NOT NULL
          REFERENCES standard_products(id) ON DELETE RESTRICT,
        after_standard_product_id TEXT NOT NULL
          REFERENCES standard_products(id) ON DELETE RESTRICT,
        before_standard_product_sku TEXT NOT NULL,
        after_standard_product_sku TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (before_standard_product_id <> after_standard_product_id)
      ) STRICT;

      CREATE INDEX product_identity_correction_events_by_correction
      ON product_identity_correction_events (correction_id, sequence);

      CREATE INDEX product_identity_correction_events_by_mapping
      ON product_identity_correction_events (mapping_id, sequence);

      CREATE TRIGGER product_identity_correction_events_are_immutable_on_update
      BEFORE UPDATE ON product_identity_correction_events
      BEGIN SELECT RAISE(ABORT, 'product identity correction events are immutable'); END;

      CREATE TRIGGER product_identity_correction_events_are_immutable_on_delete
      BEFORE DELETE ON product_identity_correction_events
      BEGIN SELECT RAISE(ABORT, 'product identity correction events are immutable'); END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (48, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion49(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE financial_records_v49 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind = 'aftersales_refund'),
        pending_item_id TEXT NOT NULL
          REFERENCES pending_financial_items(id) ON DELETE RESTRICT,
        aftersales_case_id TEXT NOT NULL
          REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        occurred_at TEXT NOT NULL,
        note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO financial_records_v49 (
        id, kind, pending_item_id, aftersales_case_id,
        amount_cents, occurred_at, note, created_at
      )
      SELECT
        id, kind, pending_item_id, aftersales_case_id,
        amount_cents, occurred_at, note, created_at
      FROM financial_records;

      DROP TRIGGER aftersales_outbound_exception_refund_link_identity_is_valid_on_insert;
      DROP TABLE financial_records;
      ALTER TABLE financial_records_v49 RENAME TO financial_records;

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

      CREATE INDEX financial_records_by_pending_item
      ON financial_records (pending_item_id, occurred_at, created_at);

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

      CREATE TABLE pending_financial_items_v49 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind = 'aftersales_refund'),
        aftersales_case_id TEXT NOT NULL UNIQUE
          REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
        requested_amount_cents INTEGER NOT NULL CHECK (requested_amount_cents > 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'ended')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK (
          (status = 'pending' AND resolved_at IS NULL)
          OR (status IN ('confirmed', 'cancelled', 'ended') AND resolved_at IS NOT NULL)
        )
      ) STRICT;

      INSERT INTO pending_financial_items_v49 (
        id, kind, aftersales_case_id, requested_amount_cents,
        status, created_at, resolved_at
      )
      SELECT
        id, kind, aftersales_case_id, requested_amount_cents,
        status, created_at, resolved_at
      FROM pending_financial_items;

      DROP TABLE pending_financial_items;
      ALTER TABLE pending_financial_items_v49 RENAME TO pending_financial_items;

      CREATE TABLE aftersales_refund_target_adjustment_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        pending_item_id TEXT NOT NULL
          REFERENCES pending_financial_items(id) ON DELETE RESTRICT,
        before_amount_cents INTEGER NOT NULL CHECK (before_amount_cents > 0),
        after_amount_cents INTEGER NOT NULL CHECK (after_amount_cents > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (before_amount_cents <> after_amount_cents)
      ) STRICT;

      CREATE INDEX aftersales_refund_target_adjustment_events_by_item
      ON aftersales_refund_target_adjustment_events (pending_item_id, sequence);

      CREATE TRIGGER aftersales_refund_target_adjustment_events_are_immutable_on_update
      BEFORE UPDATE ON aftersales_refund_target_adjustment_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales refund target adjustment events are immutable');
      END;

      CREATE TRIGGER aftersales_refund_target_adjustment_events_are_immutable_on_delete
      BEFORE DELETE ON aftersales_refund_target_adjustment_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales refund target adjustment events are immutable');
      END;

      CREATE TABLE aftersales_refund_ending_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        pending_item_id TEXT NOT NULL
          REFERENCES pending_financial_items(id) ON DELETE RESTRICT,
        requested_amount_cents INTEGER NOT NULL CHECK (requested_amount_cents > 0),
        refunded_amount_cents INTEGER NOT NULL CHECK (refunded_amount_cents > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (refunded_amount_cents < requested_amount_cents)
      ) STRICT;

      CREATE INDEX aftersales_refund_ending_events_by_item
      ON aftersales_refund_ending_events (pending_item_id, sequence);

      CREATE TRIGGER aftersales_refund_ending_events_are_immutable_on_update
      BEFORE UPDATE ON aftersales_refund_ending_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales refund ending events are immutable');
      END;

      CREATE TRIGGER aftersales_refund_ending_events_are_immutable_on_delete
      BEFORE DELETE ON aftersales_refund_ending_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales refund ending events are immutable');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (49, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
    database.exec('PRAGMA foreign_keys = ON;');
  } catch (error) {
    rollbackQuietly(database);
    database.exec('PRAGMA foreign_keys = ON;');
    throw error;
  }
}

// v50 一次性升级可执行售后流程模板：把存储步骤统一到「绑定已定义业务动作」的形态，
// 无法绑定的存量步骤改写为 kind = null（需要检查），仅可见、不可执行。
function migrateToVersion50(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec('DROP TRIGGER aftersales_workflow_template_versions_are_immutable_on_update;');
    const rows = database.prepare(`
      SELECT template_id, version, definition_json
      FROM aftersales_workflow_template_versions
    `).all() as Array<{ template_id: string; version: number; definition_json: string }>;
    const update = database.prepare(`
      UPDATE aftersales_workflow_template_versions
      SET definition_json = ?
      WHERE template_id = ? AND version = ?
    `);
    for (const row of rows) {
      const rewritten = canonicalizeTemplateDefinitionJsonForV50(row.definition_json);
      if (rewritten !== null) update.run(rewritten, row.template_id, row.version);
    }
    database.exec(`
      CREATE TRIGGER aftersales_workflow_template_versions_are_immutable_on_update
      BEFORE UPDATE ON aftersales_workflow_template_versions
      BEGIN
        SELECT RAISE(ABORT, 'aftersales workflow template versions are immutable');
      END;
    `);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (50, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function canonicalizeTemplateDefinitionJsonForV50(definitionJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(definitionJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const steps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;
  let changed = false;
  const canonicalSteps = steps.map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
    const record = step as { kind?: unknown };
    if (isBoundAftersalesWorkflowStepKind(record.kind)) return step;
    changed = true;
    return { ...record, kind: null };
  });
  if (!changed) return null;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), steps: canonicalSteps });
}

// v51 一次性升级可执行售后流程：为管理型步骤的人工完成或带原因跳过建立不可变事件表。
// 既有处理单没有这类事件，全部从空历史开始，业务事实不受影响。
function migrateToVersion51(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE aftersales_case_step_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        case_id TEXT NOT NULL REFERENCES aftersales_cases(id) ON DELETE RESTRICT,
        step_id TEXT NOT NULL CHECK (length(trim(step_id)) BETWEEN 1 AND 64),
        kind TEXT NOT NULL CHECK (kind IN ('completed', 'skipped')),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        remaining_risk TEXT CHECK (
          remaining_risk IS NULL OR length(trim(remaining_risk)) BETWEEN 1 AND 500
        ),
        workflow_template_id TEXT NOT NULL,
        workflow_template_version INTEGER NOT NULL CHECK (workflow_template_version >= 1),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (
          (kind = 'completed' AND remaining_risk IS NULL)
          OR (kind = 'skipped' AND remaining_risk IS NOT NULL)
        ),
        FOREIGN KEY (workflow_template_id, workflow_template_version)
          REFERENCES aftersales_workflow_template_versions(template_id, version)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX aftersales_case_step_events_by_case
      ON aftersales_case_step_events (case_id, sequence);

      CREATE TRIGGER aftersales_case_step_events_are_immutable_on_update
      BEFORE UPDATE ON aftersales_case_step_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales case step events are immutable');
      END;

      CREATE TRIGGER aftersales_case_step_events_are_immutable_on_delete
      BEFORE DELETE ON aftersales_case_step_events
      BEGIN
        SELECT RAISE(ABORT, 'aftersales case step events are immutable');
      END;
    `);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (51, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

// v52 交付预售需求域：履约计划增加需求提醒阈值；发货前退款事实与采购建议
// 各自拥有不可变事件表。既有工作区没有这类事实，全部从空历史开始。
function migrateToVersion52(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      ALTER TABLE fulfillment_plans
        ADD COLUMN demand_alert_threshold INTEGER
          CHECK (demand_alert_threshold IS NULL OR demand_alert_threshold > 0);

      CREATE TABLE fulfillment_refund_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        plan_id TEXT NOT NULL REFERENCES fulfillment_plans(id) ON DELETE RESTRICT,
        order_id TEXT NOT NULL REFERENCES original_orders(id) ON DELETE RESTRICT,
        order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX fulfillment_refund_events_by_plan
        ON fulfillment_refund_events (plan_id, sequence);

      CREATE TRIGGER fulfillment_refund_events_are_immutable_on_update
        BEFORE UPDATE ON fulfillment_refund_events
        BEGIN
          SELECT RAISE(ABORT, 'fulfillment refund events are immutable');
        END;

      CREATE TRIGGER fulfillment_refund_events_are_immutable_on_delete
        BEFORE DELETE ON fulfillment_refund_events
        BEGIN
          SELECT RAISE(ABORT, 'fulfillment refund events are immutable');
        END;

      CREATE TABLE purchase_suggestions (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES fulfillment_plans(id) ON DELETE RESTRICT,
        standard_product_id TEXT NOT NULL REFERENCES standard_products(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'cancelled')),
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        cancelled_at TEXT,
        cancel_reason TEXT,
        CHECK (status != 'draft' OR (confirmed_at IS NULL AND cancelled_at IS NULL)),
        CHECK (status != 'draft' OR cancel_reason IS NULL),
        CHECK (status != 'confirmed' OR confirmed_at IS NOT NULL),
        CHECK (status != 'confirmed' OR (cancelled_at IS NULL AND cancel_reason IS NULL)),
        CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
        CHECK (cancelled_at IS NULL OR cancel_reason IS NOT NULL)
      ) STRICT;

      CREATE INDEX purchase_suggestions_by_plan
        ON purchase_suggestions (plan_id, created_at, id);

      CREATE INDEX purchase_suggestions_by_product
        ON purchase_suggestions (standard_product_id, status);

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
    `);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (52, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion53(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      DROP TRIGGER fulfillment_plan_events_are_immutable_on_update;
      DROP TRIGGER fulfillment_plan_events_are_immutable_on_delete;

      ALTER TABLE fulfillment_plan_events RENAME TO fulfillment_plan_events_v52;

      CREATE TABLE fulfillment_plan_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        plan_id TEXT NOT NULL REFERENCES fulfillment_plans(id) ON DELETE RESTRICT,
        order_id TEXT REFERENCES original_orders(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'created', 'orders_added', 'order_removed', 'orders_released',
          'updated', 'delayed', 'formed', 'closed'
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
      FROM fulfillment_plan_events_v52;

      DROP TABLE fulfillment_plan_events_v52;

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

      ALTER TABLE fulfillment_plans ADD COLUMN formed_at TEXT;

      ALTER TABLE purchase_suggestions ADD COLUMN risk_acknowledged_at TEXT;
    `);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (53, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion54(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
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
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (54, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion55(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      DROP TRIGGER inventory_movements_are_immutable_on_update;
      DROP TRIGGER inventory_movements_are_immutable_on_delete;

      CREATE TABLE inventory_movements_v55 (
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
          'replacement_dispatch', 'return_receipt', 'purchase_arrival',
          'supplier_return', 'shipment_void'
        )),
        source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 100),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (source_type, source_id, standard_product_id, state, direction)
      ) STRICT;

      INSERT INTO inventory_movements_v55 (
        sequence, id, standard_product_id, quantity, direction, state,
        source_type, source_id, reason, occurred_at, created_at
      )
      SELECT sequence, id, standard_product_id, quantity, direction, state,
        source_type, source_id, reason, occurred_at, created_at
      FROM inventory_movements
      ORDER BY sequence;

      DROP TABLE inventory_movements;
      ALTER TABLE inventory_movements_v55 RENAME TO inventory_movements;

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
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (55, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion56(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE suppliers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 100),
        contact TEXT CHECK (contact IS NULL OR length(trim(contact)) BETWEEN 1 AND 100),
        note TEXT CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE purchase_orders (
        sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
        id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'cancelled')),
        expected_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        cancelled_at TEXT,
        cancel_reason TEXT,
        CHECK (status != 'draft'
          OR (confirmed_at IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL)),
        CHECK (status != 'confirmed'
          OR (confirmed_at IS NOT NULL AND cancelled_at IS NULL AND cancel_reason IS NULL)),
        CHECK (status != 'cancelled' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
      ) STRICT;

      CREATE INDEX purchase_orders_by_supplier
        ON purchase_orders (supplier_id, sequence);

      CREATE INDEX purchase_orders_by_status
        ON purchase_orders (status, sequence);

      CREATE TABLE purchase_order_items (
        id TEXT PRIMARY KEY,
        purchase_order_id TEXT NOT NULL
          REFERENCES purchase_orders(id) ON DELETE RESTRICT,
        standard_product_id TEXT NOT NULL
          REFERENCES standard_products(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
        created_at TEXT NOT NULL,
        UNIQUE (purchase_order_id, standard_product_id)
      ) STRICT;

      CREATE INDEX purchase_order_items_by_product
        ON purchase_order_items (standard_product_id);

      CREATE TABLE purchase_order_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        purchase_order_id TEXT NOT NULL
          REFERENCES purchase_orders(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'created', 'confirmed', 'quantity_changed', 'expected_date_changed', 'cancelled'
        )),
        item_id TEXT REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
        quantity INTEGER CHECK (quantity IS NULL OR quantity > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (event_type != 'quantity_changed'
          OR (item_id IS NOT NULL AND quantity IS NOT NULL)),
        CHECK (event_type = 'quantity_changed' OR (item_id IS NULL AND quantity IS NULL))
      ) STRICT;

      CREATE INDEX purchase_order_events_by_order
        ON purchase_order_events (purchase_order_id, sequence);

      CREATE TRIGGER purchase_order_events_are_immutable_on_update
      BEFORE UPDATE ON purchase_order_events
      BEGIN
        SELECT RAISE(ABORT, 'purchase order events are immutable');
      END;

      CREATE TRIGGER purchase_order_events_are_immutable_on_delete
      BEFORE DELETE ON purchase_order_events
      BEGIN
        SELECT RAISE(ABORT, 'purchase order events are immutable');
      END;

      CREATE TABLE purchase_arrivals (
        id TEXT PRIMARY KEY,
        purchase_order_id TEXT NOT NULL
          REFERENCES purchase_orders(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX purchase_arrivals_by_order
        ON purchase_arrivals (purchase_order_id, occurred_at);

      CREATE TRIGGER purchase_arrivals_are_immutable_on_update
      BEFORE UPDATE ON purchase_arrivals
      BEGIN
        SELECT RAISE(ABORT, 'purchase arrivals are immutable');
      END;

      CREATE TRIGGER purchase_arrivals_are_immutable_on_delete
      BEFORE DELETE ON purchase_arrivals
      BEGIN
        SELECT RAISE(ABORT, 'purchase arrivals are immutable');
      END;

      CREATE TABLE purchase_arrival_items (
        id TEXT PRIMARY KEY,
        arrival_id TEXT NOT NULL REFERENCES purchase_arrivals(id) ON DELETE RESTRICT,
        purchase_order_item_id TEXT NOT NULL
          REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
        received_quantity INTEGER NOT NULL CHECK (received_quantity > 0),
        resellable_quantity INTEGER NOT NULL CHECK (resellable_quantity >= 0),
        defective_quantity INTEGER NOT NULL CHECK (defective_quantity >= 0),
        scrapped_quantity INTEGER NOT NULL CHECK (scrapped_quantity >= 0),
        CHECK (
          resellable_quantity + defective_quantity + scrapped_quantity
          <= received_quantity
        ),
        UNIQUE (arrival_id, purchase_order_item_id)
      ) STRICT;

      CREATE INDEX purchase_arrival_items_by_order_item
        ON purchase_arrival_items (purchase_order_item_id);

      CREATE TRIGGER purchase_arrival_items_are_immutable_on_update
      BEFORE UPDATE ON purchase_arrival_items
      BEGIN
        SELECT RAISE(ABORT, 'purchase arrival items are immutable');
      END;

      CREATE TRIGGER purchase_arrival_items_are_immutable_on_delete
      BEFORE DELETE ON purchase_arrival_items
      BEGIN
        SELECT RAISE(ABORT, 'purchase arrival items are immutable');
      END;

      CREATE TABLE supplier_returns (
        id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
        purchase_order_id TEXT REFERENCES purchase_orders(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX supplier_returns_by_supplier
        ON supplier_returns (supplier_id, occurred_at);

      CREATE INDEX supplier_returns_by_order
        ON supplier_returns (purchase_order_id);

      CREATE TRIGGER supplier_returns_are_immutable_on_update
      BEFORE UPDATE ON supplier_returns
      BEGIN
        SELECT RAISE(ABORT, 'supplier returns are immutable');
      END;

      CREATE TRIGGER supplier_returns_are_immutable_on_delete
      BEFORE DELETE ON supplier_returns
      BEGIN
        SELECT RAISE(ABORT, 'supplier returns are immutable');
      END;

      CREATE TABLE supplier_return_items (
        id TEXT PRIMARY KEY,
        supplier_return_id TEXT NOT NULL
          REFERENCES supplier_returns(id) ON DELETE RESTRICT,
        standard_product_id TEXT NOT NULL
          REFERENCES standard_products(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        state TEXT NOT NULL CHECK (state IN (
          'sellable', 'awaiting_inspection', 'defective', 'scrapped'
        )),
        UNIQUE (supplier_return_id, standard_product_id, state)
      ) STRICT;

      CREATE INDEX supplier_return_items_by_product
        ON supplier_return_items (standard_product_id);

      CREATE TRIGGER supplier_return_items_are_immutable_on_update
      BEFORE UPDATE ON supplier_return_items
      BEGIN
        SELECT RAISE(ABORT, 'supplier return items are immutable');
      END;

      CREATE TRIGGER supplier_return_items_are_immutable_on_delete
      BEFORE DELETE ON supplier_return_items
      BEGIN
        SELECT RAISE(ABORT, 'supplier return items are immutable');
      END;

      CREATE TABLE purchase_payables (
        id TEXT PRIMARY KEY,
        purchase_order_id TEXT NOT NULL UNIQUE
          REFERENCES purchase_orders(id) ON DELETE RESTRICT,
        supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        status TEXT NOT NULL CHECK (status = 'pending'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX purchase_payables_by_supplier
        ON purchase_payables (supplier_id, status);
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (56, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

// v57 连接采购建议与采购订单：建议表加 converted 态与订单引用、事件表加 converted 类型、
// 订单表加计划归属列。重建建议表全程关闭外键并按「建新表→拷贝→删旧→改名」顺序，
// 使最终表名与事件表外键引用的表名保持一致（不受改名重写行为影响），结束时以外键检查收口。
function migrateToVersion57(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  try {
    database.exec('BEGIN IMMEDIATE;');
    database.exec(`
      ALTER TABLE purchase_orders
        ADD COLUMN plan_id TEXT REFERENCES fulfillment_plans(id) ON DELETE RESTRICT;

      CREATE INDEX purchase_orders_by_plan
        ON purchase_orders (plan_id);

      CREATE TABLE purchase_suggestions_v57 (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES fulfillment_plans(id) ON DELETE RESTRICT,
        standard_product_id TEXT NOT NULL REFERENCES standard_products(id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'cancelled', 'converted')),
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        cancelled_at TEXT,
        cancel_reason TEXT,
        risk_acknowledged_at TEXT,
        purchase_order_id TEXT REFERENCES purchase_orders(id) ON DELETE RESTRICT,
        CHECK (status != 'draft' OR (confirmed_at IS NULL AND cancelled_at IS NULL)),
        CHECK (status != 'draft' OR cancel_reason IS NULL),
        CHECK (status != 'draft' OR purchase_order_id IS NULL),
        CHECK (status != 'confirmed' OR confirmed_at IS NOT NULL),
        CHECK (status != 'confirmed' OR (cancelled_at IS NULL AND cancel_reason IS NULL)),
        CHECK (status != 'confirmed' OR purchase_order_id IS NULL),
        CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
        CHECK (cancelled_at IS NULL OR cancel_reason IS NOT NULL),
        CHECK (status != 'cancelled' OR purchase_order_id IS NULL),
        CHECK (status != 'converted'
          OR (confirmed_at IS NOT NULL AND cancelled_at IS NULL AND cancel_reason IS NULL)),
        CHECK (status != 'converted' OR purchase_order_id IS NOT NULL),
        CHECK (status = 'converted' OR purchase_order_id IS NULL)
      ) STRICT;

      INSERT INTO purchase_suggestions_v57 (
        id, plan_id, standard_product_id, quantity, status, created_at, confirmed_at,
        cancelled_at, cancel_reason, risk_acknowledged_at, purchase_order_id
      )
      SELECT id, plan_id, standard_product_id, quantity, status, created_at, confirmed_at,
        cancelled_at, cancel_reason, risk_acknowledged_at, NULL
      FROM purchase_suggestions;

      DROP TABLE purchase_suggestions;
      ALTER TABLE purchase_suggestions_v57 RENAME TO purchase_suggestions;

      CREATE INDEX purchase_suggestions_by_plan
        ON purchase_suggestions (plan_id, created_at, id);

      CREATE INDEX purchase_suggestions_by_product
        ON purchase_suggestions (standard_product_id, status);

      DROP TRIGGER purchase_suggestion_events_are_immutable_on_update;
      DROP TRIGGER purchase_suggestion_events_are_immutable_on_delete;

      ALTER TABLE purchase_suggestion_events RENAME TO purchase_suggestion_events_v56;

      CREATE TABLE purchase_suggestion_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        suggestion_id TEXT NOT NULL REFERENCES purchase_suggestions(id) ON DELETE RESTRICT,
        plan_id TEXT NOT NULL REFERENCES fulfillment_plans(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL CHECK (
          event_type IN ('created', 'confirmed', 'cancelled', 'reduced', 'converted')
        ),
        quantity INTEGER CHECK (quantity IS NULL OR quantity > 0),
        reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (event_type NOT IN ('reduced', 'converted') OR quantity IS NOT NULL),
        CHECK (event_type IN ('reduced', 'converted') OR quantity IS NULL)
      ) STRICT;

      INSERT INTO purchase_suggestion_events (
        sequence, id, suggestion_id, plan_id, event_type, quantity, reason,
        occurred_at, created_at
      )
      SELECT sequence, id, suggestion_id, plan_id, event_type, quantity, reason,
        occurred_at, created_at
      FROM purchase_suggestion_events_v56
      ORDER BY sequence;

      DROP TABLE purchase_suggestion_events_v56;

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
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (57, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

// v58 资金事实：待确认资金事项与资金记录分表保存；记录不可变，冲正靠反向记录不覆盖原记录；
// 事项金额等事实列不可改写，仅状态与取消留痕列允许更新（ADR 0042、#73）。
function migrateToVersion58(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE finance_pending_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN (
          'order_transaction', 'platform_settlement', 'platform_fee', 'initial_freight',
          'return_freight', 'replacement_freight', 'refund', 'interception_fee',
          'carrier_claim', 'purchase_cost'
        )),
        direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        currency TEXT NOT NULL CHECK (currency = 'CNY'),
        status TEXT NOT NULL CHECK (status IN ('pending', 'cancelled')),
        source_type TEXT NOT NULL CHECK (source_type IN (
          'order', 'shipment_record', 'aftersales_case',
          'purchase_order', 'supplier_return', 'logistics_exception'
        )),
        source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 200),
        note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 500),
        occurred_at TEXT NOT NULL,
        cancelled_at TEXT,
        cancel_reason TEXT CHECK (
          cancel_reason IS NULL OR length(trim(cancel_reason)) BETWEEN 1 AND 500
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
        CHECK (cancelled_at IS NULL OR cancel_reason IS NOT NULL),
        UNIQUE (source_type, source_id, type)
      ) STRICT;

      CREATE INDEX finance_pending_items_by_source
        ON finance_pending_items (source_type, source_id);

      CREATE INDEX finance_pending_items_by_status
        ON finance_pending_items (status);

      CREATE TRIGGER finance_pending_items_facts_are_immutable_on_update
      BEFORE UPDATE ON finance_pending_items
      WHEN OLD.id != NEW.id
        OR OLD.type != NEW.type
        OR OLD.direction != NEW.direction
        OR OLD.amount_cents != NEW.amount_cents
        OR OLD.currency != NEW.currency
        OR OLD.source_type != NEW.source_type
        OR OLD.source_id != NEW.source_id
        OR OLD.note != NEW.note
        OR OLD.occurred_at != NEW.occurred_at
        OR OLD.created_at != NEW.created_at
      BEGIN
        SELECT RAISE(ABORT, 'finance pending item facts are immutable');
      END;

      CREATE TRIGGER finance_pending_items_are_immutable_on_delete
      BEFORE DELETE ON finance_pending_items
      BEGIN
        SELECT RAISE(ABORT, 'finance pending items cannot be deleted; cancel instead');
      END;

      CREATE TABLE finance_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type IN (
          'order_transaction', 'platform_settlement', 'platform_fee', 'initial_freight',
          'return_freight', 'replacement_freight', 'refund', 'interception_fee',
          'carrier_claim', 'purchase_cost', 'misc_expense'
        )),
        direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        currency TEXT NOT NULL CHECK (currency = 'CNY'),
        confirmed_source TEXT NOT NULL CHECK (confirmed_source = 'manual_confirmation'),
        occurred_at TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        pending_item_id TEXT REFERENCES finance_pending_items(id) ON DELETE RESTRICT,
        source_type TEXT CHECK (source_type IS NULL OR source_type IN (
          'order', 'shipment_record', 'aftersales_case',
          'purchase_order', 'supplier_return', 'logistics_exception'
        )),
        source_id TEXT CHECK (
          source_id IS NULL OR (source_type IS NOT NULL AND length(trim(source_id)) BETWEEN 1 AND 200)
        ),
        reverses_record_id TEXT REFERENCES finance_records(id) ON DELETE RESTRICT,
        note TEXT NOT NULL CHECK (length(note) <= 500),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX finance_records_by_pending_item
        ON finance_records (pending_item_id);

      CREATE INDEX finance_records_by_reverses
        ON finance_records (reverses_record_id);

      CREATE INDEX finance_records_by_type
        ON finance_records (type);

      CREATE TRIGGER finance_records_are_immutable_on_update
      BEFORE UPDATE ON finance_records
      BEGIN
        SELECT RAISE(ABORT, 'finance records are immutable');
      END;

      CREATE TRIGGER finance_records_are_immutable_on_delete
      BEFORE DELETE ON finance_records
      BEGIN
        SELECT RAISE(ABORT, 'finance records are immutable');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (58, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

// v59 来源快照可由来源截图或历史导入建立；历史导入不伪造截图、识别批次或订单草稿。
function migrateToVersion59(database: DatabaseSync): void {
  const migratedAt = new Date().toISOString();
  database.exec('PRAGMA foreign_keys = OFF;');
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS source_snapshots_only_finalize_once;
      DROP TRIGGER IF EXISTS source_snapshots_are_immutable_on_delete;

      CREATE TABLE original_orders_v59 (
        id TEXT PRIMARY KEY,
        draft_id TEXT UNIQUE REFERENCES order_drafts(id) ON DELETE RESTRICT,
        screenshot_id TEXT REFERENCES source_screenshots(id) ON DELETE RESTRICT,
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
        system_order_number TEXT NOT NULL CHECK (
          system_order_number GLOB
            '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'
          AND substr(system_order_number, 10, 6) <> '000000'
        ),
        CHECK ((draft_id IS NULL) = (screenshot_id IS NULL)),
        UNIQUE (platform, seller_account, platform_order_number)
      ) STRICT;

      INSERT INTO original_orders_v59 (
        id, draft_id, screenshot_id, platform, seller_account, platform_order_number,
        alipay_transaction_number, buyer_nickname, recipient, phone, phone_normalized,
        address_original, address_normalized, province, city, district,
        ordered_at_original, ordered_at_normalized, paid_at_original, paid_at_normalized,
        product_total_cents, shipping_fee_cents, amount_cents,
        platform_transaction_status, fulfillment_status, lifecycle_status,
        created_at, updated_at, revision,
        seller_account_normalized, platform_order_number_normalized,
        note, shipping_carrier, tracking_number, system_order_number
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
        note, shipping_carrier, tracking_number, system_order_number
      FROM original_orders;

      DROP TABLE original_orders;
      ALTER TABLE original_orders_v59 RENAME TO original_orders;

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

      CREATE TABLE source_snapshots_v59 (
        id TEXT PRIMARY KEY,
        draft_id TEXT UNIQUE REFERENCES order_drafts(id) ON DELETE RESTRICT,
        order_id TEXT REFERENCES original_orders(id) ON DELETE RESTRICT,
        screenshot_id TEXT UNIQUE REFERENCES source_screenshots(id) ON DELETE RESTRICT,
        source_type TEXT NOT NULL CHECK (source_type IN ('screenshot', 'historical_import')),
        source_name TEXT CHECK (
          source_name IS NULL OR length(trim(source_name)) BETWEEN 1 AND 255
        ),
        source_row_numbers_json TEXT CHECK (
          source_row_numbers_json IS NULL OR (
            json_valid(source_row_numbers_json)
            AND json_type(source_row_numbers_json) = 'array'
          )
        ),
        recognition_json TEXT NOT NULL CHECK (json_valid(recognition_json)),
        confirmed_json TEXT CHECK (
          confirmed_json IS NULL OR json_valid(confirmed_json)
        ),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK (
          (
            source_type = 'screenshot'
            AND draft_id IS NOT NULL
            AND screenshot_id IS NOT NULL
            AND source_name IS NULL
            AND source_row_numbers_json IS NULL
          ) OR (
            source_type = 'historical_import'
            AND draft_id IS NULL
            AND screenshot_id IS NULL
            AND source_name IS NOT NULL
            AND source_row_numbers_json IS NOT NULL
            AND json_array_length(source_row_numbers_json) BETWEEN 1 AND 10000
          )
        ),
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

      INSERT INTO source_snapshots_v59 (
        id, draft_id, order_id, screenshot_id,
        source_type, source_name, source_row_numbers_json,
        recognition_json, confirmed_json, created_at, resolved_at
      )
      SELECT
        id, draft_id, order_id, screenshot_id,
        'screenshot', NULL, NULL,
        recognition_json, confirmed_json, created_at, resolved_at
      FROM source_snapshots;

      DROP TABLE source_snapshots;
      ALTER TABLE source_snapshots_v59 RENAME TO source_snapshots;

      CREATE TRIGGER source_snapshots_only_finalize_once
      BEFORE UPDATE ON source_snapshots
      WHEN
        OLD.source_type != 'screenshot'
        OR OLD.order_id IS NOT NULL
        OR OLD.confirmed_json IS NOT NULL
        OR OLD.resolved_at IS NOT NULL
        OR NEW.id != OLD.id
        OR NEW.draft_id != OLD.draft_id
        OR NEW.screenshot_id != OLD.screenshot_id
        OR NEW.source_type != OLD.source_type
        OR NEW.source_name IS NOT OLD.source_name
        OR NEW.source_row_numbers_json IS NOT OLD.source_row_numbers_json
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
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (59, ?)')
      .run(migratedAt);
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

// v60 以不可变事件记录订单移入回收站、恢复和永久删除。
function migrateToVersion60(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE order_lifecycle_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        order_id TEXT NOT NULL REFERENCES original_orders(id) ON DELETE RESTRICT,
        action TEXT NOT NULL CHECK (action IN (
          'moved_to_trash', 'restored', 'permanently_deleted', 'retention_expired'
        )),
        initiator TEXT NOT NULL CHECK (initiator IN ('user', 'system')),
        before_status TEXT NOT NULL
          CHECK (before_status IN ('active', 'trashed', 'deleted')),
        after_status TEXT NOT NULL
          CHECK (after_status IN ('active', 'trashed', 'deleted')),
        base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
        result_revision INTEGER NOT NULL CHECK (result_revision = base_revision + 1),
        created_at TEXT NOT NULL,
        CHECK (
          (action = 'moved_to_trash' AND initiator = 'user'
            AND before_status = 'active' AND after_status = 'trashed')
          OR (action = 'restored' AND initiator = 'user'
            AND before_status = 'trashed' AND after_status = 'active')
          OR (action = 'permanently_deleted' AND initiator = 'user'
            AND before_status = 'trashed' AND after_status = 'deleted')
          OR (action = 'retention_expired' AND initiator = 'system'
            AND before_status = 'trashed' AND after_status = 'deleted')
        )
      ) STRICT;

      CREATE INDEX order_lifecycle_events_by_order
      ON order_lifecycle_events (order_id, sequence DESC);

      CREATE TRIGGER order_lifecycle_events_are_immutable_on_update
      BEFORE UPDATE ON order_lifecycle_events
      BEGIN
        SELECT RAISE(ABORT, 'order lifecycle events are immutable');
      END;

      CREATE TRIGGER order_lifecycle_events_are_immutable_on_delete
      BEFORE DELETE ON order_lifecycle_events
      BEGIN
        SELECT RAISE(ABORT, 'order lifecycle events are immutable');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (60, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

// v61 将字段级模板脱敏规则写入每套表格模板，并安全升级存量模板。
function migrateToVersion61(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    database.exec(`
      DROP TRIGGER custom_field_definitions_keep_template_granularity_on_update;
      DROP TRIGGER table_templates_prevent_granularity_change_with_dependencies;
      DROP TRIGGER table_template_dependencies_match_granularity_on_insert;
      DROP TRIGGER table_template_dependencies_match_granularity_on_update;

      CREATE TABLE table_templates_v61 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        granularity TEXT NOT NULL
          CHECK (granularity IN ('order', 'order_item', 'shipment_group')),
        configuration_version INTEGER NOT NULL DEFAULT 3
          CHECK (configuration_version = 3),
        configuration_json TEXT NOT NULL CHECK (
          json_valid(configuration_json)
          AND json_type(configuration_json) = 'object'
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (granularity, name_key)
      ) STRICT;

      INSERT INTO table_templates_v61 (
        id, name, name_key, granularity, configuration_version,
        configuration_json, created_at, updated_at
      )
      SELECT
        id,
        name,
        name_key,
        granularity,
        3,
        json_set(
          configuration_json,
          '$.maskingRules',
          json_object(
            'buyer_nickname', 'keep_first_and_last',
            'recipient', 'keep_surname',
            'phone', 'keep_first_3_last_4',
            'address', 'keep_region'
          )
        ),
        created_at,
        updated_at
      FROM table_templates;

      DROP TABLE table_templates;
      ALTER TABLE table_templates_v61 RENAME TO table_templates;

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
          FROM table_template_custom_field_dependencies
          WHERE template_id = OLD.id
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
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (61, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) rollbackQuietly(database);
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function createMissingSchemaObject(database: DatabaseSync, name: string, sql: string): void {
  const exists = database.prepare(`
    SELECT 1 FROM sqlite_schema WHERE name = ?
  `).get(name);
  if (!exists) database.exec(sql);
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

function migrateToVersion62(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF;');
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    database.exec(`
      CREATE TABLE ocr_usage_events (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        call_kind TEXT NOT NULL
          CHECK (call_kind IN ('recognition', 'connection_test', 'candidate_adjudication')),
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_id TEXT NOT NULL DEFAULT '',
        estimated_cents INTEGER NOT NULL CHECK (estimated_cents >= 0)
      ) STRICT;

      CREATE INDEX ocr_usage_events_by_occurred_at
      ON ocr_usage_events (occurred_at DESC, id DESC);

      CREATE TRIGGER ocr_usage_events_are_immutable_on_update
      BEFORE UPDATE ON ocr_usage_events
      BEGIN
        SELECT RAISE(ABORT, 'ocr usage events are immutable');
      END;

      CREATE TRIGGER ocr_usage_events_are_immutable_on_delete
      BEFORE DELETE ON ocr_usage_events
      BEGIN
        SELECT RAISE(ABORT, 'ocr usage events are immutable');
      END;
    `);
    assertForeignKeyIntegrity(database);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (62, ?)')
      .run(new Date().toISOString());
    database.exec('COMMIT;');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) rollbackQuietly(database);
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON;');
  }
}

function migrateToVersion63(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE recognition_batch_item_failure_codes (
        item_id TEXT PRIMARY KEY
          REFERENCES recognition_batch_items(id) ON DELETE CASCADE,
        failure_code TEXT NOT NULL CHECK (failure_code = 'ocr_quota_paused')
      ) STRICT;

      CREATE TRIGGER recognition_batch_items_clear_failure_code
      AFTER UPDATE OF status ON recognition_batch_items
      WHEN NEW.status <> 'failed'
      BEGIN
        DELETE FROM recognition_batch_item_failure_codes WHERE item_id = NEW.id;
      END;

      INSERT INTO recognition_batch_item_failure_codes (item_id, failure_code)
      SELECT id, 'ocr_quota_paused'
      FROM recognition_batch_items
      WHERE status = 'failed'
        AND error_message = '本月 OCR 用量已达硬暂停额度，请在设置中调整额度或确认继续';
    `);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(63, new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateToVersion64(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const existingColumns = new Set((database.prepare(
      'PRAGMA table_info(source_screenshots)',
    ).all() as Array<{ name: string }>).map(({ name }) => name));
    const columns = [
      ['storage_state', "TEXT NOT NULL DEFAULT 'original' CHECK (storage_state IN ('original', 'compressed', 'deleted'))"],
      ['original_relative_path', 'TEXT'],
      ['delete_source_relative_path', 'TEXT'],
      ['original_bytes', 'INTEGER CHECK (original_bytes IS NULL OR original_bytes >= 0)'],
      ['current_bytes', 'INTEGER CHECK (current_bytes IS NULL OR current_bytes >= 0)'],
      ['compressed_at', 'TEXT'],
      ['deleted_at', 'TEXT'],
    ] as const;
    for (const [name, definition] of columns) {
      if (!existingColumns.has(name)) {
        database.exec(`ALTER TABLE source_screenshots ADD COLUMN ${name} ${definition};`);
      }
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS source_screenshot_lifecycle_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cleanup_after_days INTEGER
          CHECK (cleanup_after_days IS NULL OR cleanup_after_days IN (180, 365)),
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT OR IGNORE INTO source_screenshot_lifecycle_settings (
        id, cleanup_after_days, updated_at
      ) VALUES (1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

      CREATE INDEX IF NOT EXISTS source_screenshots_by_storage_state_and_created_at
      ON source_screenshots (storage_state, created_at, id);
    `);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(CURRENT_WORKSPACE_SCHEMA_VERSION, new Date().toISOString());
    database.exec('COMMIT;');
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}
