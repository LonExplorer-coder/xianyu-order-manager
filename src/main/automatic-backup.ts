import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type {
  BackupEventRecord,
  BackupInventoryEntry,
  BackupStatusView,
  CreateBackupResult,
} from '../core/backup';
import type { BackupSettingsRecord } from './backup-settings-file';
import { DEFAULT_BACKUP_SETTINGS } from './backup-settings-file';
import { createBackup, readBackupManifest } from './backup-service';

const STATE_FILENAME = 'backup-state.json';
const BACKUP_DIRECTORY_PREFIX = 'xianyu-backup-';
const MAX_EVENTS = 100;

const EVENT_KINDS: ReadonlySet<string> = new Set(['auto-created', 'auto-failed', 'deleted']);

interface InventoryRecord {
  entry: BackupInventoryEntry;
  databaseBytes: number;
  /** key 为 `${path} ${sha256}`，值为该文件字节数；用于去重感知的占用估算。 */
  fileBytesByKey: Map<string, number>;
}

export async function readBackupInventory(
  backupRootDirectory: string,
): Promise<BackupInventoryEntry[]> {
  return (await readInventoryRecords(backupRootDirectory)).map((record) => record.entry);
}

async function readInventoryRecords(
  backupRootDirectory: string,
): Promise<InventoryRecord[]> {
  const rootDirectory = resolve(backupRootDirectory);
  const records: InventoryRecord[] = [];
  for (const backupDirectory of await listBackupDirectories(rootDirectory)) {
    const manifest = await readBackupManifest(backupDirectory);
    if (!manifest) continue;
    const fileBytesByKey = new Map<string, number>();
    for (const file of manifest.files) {
      fileBytesByKey.set(`${file.path} ${file.sha256}`, file.bytes);
    }
    const databaseBytes = manifest.database.bytes;
    records.push({
      entry: {
        backupDirectory,
        createdAt: manifest.createdAt,
        appVersion: manifest.appVersion,
        bytes: databaseBytes + manifest.files.reduce((sum, file) => sum + file.bytes, 0),
        files: manifest.files.length,
      },
      databaseBytes,
      fileBytesByKey,
    });
  }
  records.sort((a, b) => (a.entry.createdAt ?? '').localeCompare(b.entry.createdAt ?? '')
    || a.entry.backupDirectory.localeCompare(b.entry.backupDirectory));
  return records;
}

async function listBackupDirectories(backupRootDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(backupRootDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(BACKUP_DIRECTORY_PREFIX))
      .map((entry) => join(backupRootDirectory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function readEvents(backupRootDirectory: string): Promise<BackupEventRecord[]> {
  try {
    const parsed = JSON.parse(
      await readFile(join(backupRootDirectory, STATE_FILENAME), 'utf8'),
    ) as { events?: unknown };
    if (!Array.isArray(parsed.events)) return [];
    return parsed.events.filter((event): event is BackupEventRecord => {
      if (typeof event !== 'object' || event === null) return false;
      const candidate = event as Record<string, unknown>;
      return typeof candidate.at === 'string' && typeof candidate.kind === 'string'
        && EVENT_KINDS.has(candidate.kind);
    });
  } catch {
    return [];
  }
}

export async function recordBackupEvents(
  backupRootDirectory: string,
  events: BackupEventRecord[],
): Promise<BackupEventRecord[]> {
  const merged = [...await readEvents(backupRootDirectory), ...events].slice(-MAX_EVENTS);
  await mkdir(backupRootDirectory, { recursive: true });
  await writeFile(
    join(backupRootDirectory, STATE_FILENAME),
    `${JSON.stringify({ events: merged }, null, 2)}\n`,
    'utf8',
  );
  return merged;
}

/**
 * 去重感知的占用估算：未变化内容（相同路径与校验和的硬链接文件）只计一次，
 * 每份备份的数据库快照始终独立计费。
 */
function estimatePhysicalUsage(records: InventoryRecord[]): number {
  const seenFileKeys = new Set<string>();
  let total = 0;
  for (const record of records) {
    total += record.databaseBytes;
    for (const key of record.fileBytesByKey.keys()) {
      if (!seenFileKeys.has(key)) {
        seenFileKeys.add(key);
        total += record.fileBytesByKey.get(key) ?? 0;
      }
    }
  }
  return total;
}

/** 删除某份备份真正可释放的估算字节：独占的文件内容 + 自身数据库快照。 */
function estimateReleasableBytes(
  victim: InventoryRecord,
  survivors: InventoryRecord[],
): number {
  const sharedKeys = new Set<string>();
  for (const survivor of survivors) {
    for (const key of survivor.fileBytesByKey.keys()) sharedKeys.add(key);
  }
  let releasable = victim.databaseBytes;
  for (const [key, bytes] of victim.fileBytesByKey) {
    if (!sharedKeys.has(key)) releasable += bytes;
  }
  return releasable;
}

export interface RetentionOutcome {
  deleted: BackupEventRecord[];
  remaining: BackupInventoryEntry[];
  overCapacity: boolean;
  usageBytes: number;
}

export async function applyBackupRetention(input: {
  backupRootDirectory: string;
  maxVersions: number;
  capacityLimitBytes: number;
  now: () => Date;
}): Promise<RetentionOutcome> {
  const candidates = await readInventoryRecords(input.backupRootDirectory);
  const deleted: BackupEventRecord[] = [];
  let usage = estimatePhysicalUsage(candidates);
  while (candidates.length > 1) {
    let reason: string | null = null;
    if (usage > input.capacityLimitBytes) {
      reason = '容量超限';
    } else if (candidates.length > input.maxVersions) {
      reason = '版本数超限';
    }
    if (!reason) break;
    const victim = candidates.shift();
    if (!victim) break;
    usage -= estimateReleasableBytes(victim, candidates);
    await rm(victim.entry.backupDirectory, { recursive: true, force: true });
    deleted.push({
      at: input.now().toISOString(),
      kind: 'deleted',
      backupDirectory: victim.entry.backupDirectory,
      reason,
    });
  }
  if (deleted.length > 0) {
    await recordBackupEvents(input.backupRootDirectory, deleted);
  }
  return {
    deleted,
    remaining: candidates.map((record) => record.entry),
    overCapacity: usage > input.capacityLimitBytes,
    usageBytes: usage,
  };
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

export type AutomaticBackupResult =
  | { ran: false; reason: 'disabled' | 'no-root' | 'no-workspace' | 'already-today' }
  | {
      ran: true;
      created: CreateBackupResult;
      /** 新备份验证未通过时为 null：保留现状等待次日重试，不清理任何恢复点。 */
      retention: RetentionOutcome | null;
      events: BackupEventRecord[];
    };

export async function runAutomaticBackupCycle(input: {
  dataDirectory: string;
  database: DatabaseSync;
  settings: BackupSettingsRecord;
  appVersion: string;
  now?: () => Date;
}): Promise<AutomaticBackupResult> {
  const { settings } = input;
  if (!settings.autoBackupEnabled) return { ran: false, reason: 'disabled' };
  if (!settings.backupRootDirectory) return { ran: false, reason: 'no-root' };
  const backupRootDirectory = resolve(settings.backupRootDirectory);

  const now = input.now ?? (() => new Date());
  const nowInstant = now();
  const inventory = await readInventoryRecords(backupRootDirectory);
  const alreadyBackedUpToday = inventory.some((record) => record.entry.createdAt !== null
    && isSameLocalDay(new Date(record.entry.createdAt), nowInstant));
  if (alreadyBackedUpToday) {
    return { ran: false, reason: 'already-today' };
  }

  const newest = inventory.length > 0 ? inventory[inventory.length - 1] : undefined;
  const created = await createBackup({
    dataDirectory: input.dataDirectory,
    database: input.database,
    backupRootDirectory,
    appVersion: input.appVersion,
    reuseFilesFrom: newest?.entry.backupDirectory,
    now: () => nowInstant,
  });
  if (!created.verification.ok) {
    // 新备份验证未通过时不得把它当作可恢复点，也不清理旧恢复点。
    const events = await recordBackupEvents(backupRootDirectory, [
      {
        at: nowInstant.toISOString(),
        kind: 'auto-failed',
        backupDirectory: created.backupDirectory,
        note: `备份创建后验证未通过：${created.verification.problems.join('；')}`,
      },
    ]);
    return { ran: true, created, retention: null, events };
  }
  const retention = await applyBackupRetention({
    backupRootDirectory,
    maxVersions: settings.maxVersions,
    capacityLimitBytes: settings.capacityLimitBytes,
    now: () => nowInstant,
  });
  const events = await recordBackupEvents(backupRootDirectory, [
    {
      at: nowInstant.toISOString(),
      kind: 'auto-created',
      backupDirectory: created.backupDirectory,
      bytes: created.database.bytes + created.totals.bytes,
      verified: true,
    },
  ]);
  return { ran: true, created, retention, events };
}

export async function buildBackupStatus(
  backupRootDirectory: string,
  options: { capacityLimitBytes?: number } = {},
): Promise<BackupStatusView> {
  const capacityLimitBytes = options.capacityLimitBytes
    ?? DEFAULT_BACKUP_SETTINGS.capacityLimitBytes;
  const records = await readInventoryRecords(backupRootDirectory);
  const events = await readEvents(backupRootDirectory);
  const autoCreated = events.filter((event) => event.kind === 'auto-created');
  const lastAutoBackupAt = autoCreated.length > 0
    ? autoCreated[autoCreated.length - 1].at
    : null;
  const lastVerificationEvent = [...events]
    .reverse()
    .find((event) => event.kind === 'auto-created' || event.kind === 'auto-failed');
  const lastVerification = lastVerificationEvent
    ? {
        at: lastVerificationEvent.at,
        ok: lastVerificationEvent.kind === 'auto-created',
        note: lastVerificationEvent.note,
      }
    : null;
  return {
    backups: [...records].reverse().map((record) => record.entry),
    totalBytes: estimatePhysicalUsage(records),
    capacityLimitBytes,
    overCapacity: estimatePhysicalUsage(records) > capacityLimitBytes,
    lastAutoBackupAt,
    lastVerification,
    events,
  };
}
