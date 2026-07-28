import { mkdirSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

  if (row.version >= 1) return;

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
