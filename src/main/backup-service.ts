import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  BackupFileEntry,
  BackupTotals,
  BackupVerificationReport,
  CreateBackupResult,
  RestoreBackupResult,
} from '../core/backup';

const DATABASE_FILENAME = 'xianyu-order-manager.sqlite3';
const LOCK_FILENAME = '.xianyu-order-manager-writer.sqlite3';
const MANIFEST_FILENAME = 'manifest.json';
export const BACKUP_FORMAT = 'xianyu-order-backup';
export const BACKUP_FORMAT_VERSION = 1;

const EXCLUDED_TOP_LEVEL_ENTRIES = new Set([
  DATABASE_FILENAME,
  LOCK_FILENAME,
  `${DATABASE_FILENAME}-wal`,
  `${DATABASE_FILENAME}-shm`,
  `${DATABASE_FILENAME}-journal`,
  '.recognition-queue',
  '.mobile-upload-staging',
  '.source-screenshot-trash',
]);

// 操作系统与同步盘会自行落下的标记文件，不算备份损坏。
const TOLERATED_EXTRA_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function isToleratedExtraFile(relativePath: string): boolean {
  const name = relativePath.split('/').pop() ?? relativePath;
  return TOLERATED_EXTRA_FILE_NAMES.has(name) || name.startsWith('._');
}

interface BackupManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  platform: string;
  createdAt: string;
  database: BackupFileEntry;
  files: BackupFileEntry[];
  totals: BackupTotals;
}

export async function readBackupManifest(
  backupDirectory: string,
): Promise<BackupManifest | null> {
  try {
    const manifest = JSON.parse(
      await readFile(join(backupDirectory, MANIFEST_FILENAME), 'utf8'),
    ) as BackupManifest;
    if (manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

export interface CreateBackupInput {
  dataDirectory: string;
  database: DatabaseSync;
  backupRootDirectory: string;
  appVersion: string;
  /** 指向上一份备份时，校验和一致的文件用硬链接复用存储，失败回退完整拷贝。 */
  reuseFilesFrom?: string;
  now?: () => Date;
}

export interface RestoreBackupInput {
  backupDirectory: string;
  targetDirectory: string;
  currentDataDirectory?: string;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function formatBackupStamp(instant: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    String(instant.getFullYear()),
    pad(instant.getMonth() + 1),
    pad(instant.getDate()),
  ].join('') + '-' + [
    pad(instant.getHours()),
    pad(instant.getMinutes()),
    pad(instant.getSeconds()),
  ].join('');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listRelativeFiles(
  directory: string,
  prefix = '',
  skipTopLevel?: (name: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && skipTopLevel?.(entry.name)) continue;
    if (entry.isDirectory()) {
      names.push(...await listRelativeFiles(join(directory, entry.name), relativePath));
    } else if (entry.isFile()) {
      names.push(relativePath);
    }
  }
  return names.sort();
}

function assertSafeManifestPath(entryPath: string): string | null {
  if (entryPath.startsWith('/') || entryPath.includes('\\') || entryPath.includes('..')) {
    return `清单路径不合法：${entryPath}`;
  }
  return null;
}

interface FileHash {
  sha256: string;
  bytes: number;
}

async function hashFile(path: string): Promise<FileHash> {
  const content = await readFile(path);
  return { sha256: sha256(content), bytes: content.byteLength };
}

async function uniqueBackupDirectory(
  backupRootDirectory: string,
  stamp: string,
): Promise<string> {
  let candidate = join(backupRootDirectory, `xianyu-backup-${stamp}`);
  let suffix = 2;
  while (await exists(candidate)) {
    candidate = join(backupRootDirectory, `xianyu-backup-${stamp}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

async function readReusableEntries(previousBackupDirectory: string): Promise<Map<string, string>> {
  const manifest = await readBackupManifest(previousBackupDirectory);
  if (!manifest) return new Map();
  return new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
}

export async function createBackup(input: CreateBackupInput): Promise<CreateBackupResult> {
  const dataDirectory = resolve(input.dataDirectory);
  const backupRootDirectory = resolve(input.backupRootDirectory);
  if (
    backupRootDirectory === dataDirectory
    || isInside(dataDirectory, backupRootDirectory)
  ) {
    throw new Error('备份位置不能在当前数据目录内，请选择数据目录以外的位置');
  }
  const now = input.now ?? (() => new Date());
  const backupDirectory = await uniqueBackupDirectory(
    backupRootDirectory,
    formatBackupStamp(now()),
  );
  await mkdir(backupDirectory, { recursive: true });

  const databasePath = join(backupDirectory, DATABASE_FILENAME);
  input.database.exec(`VACUUM INTO ${sqlStringLiteral(databasePath)}`);
  const databaseEntry: BackupFileEntry = {
    path: DATABASE_FILENAME,
    ...(await hashFile(databasePath)),
  };

  const reusable = input.reuseFilesFrom
    ? await readReusableEntries(resolve(input.reuseFilesFrom))
    : new Map<string, string>();
  const reuseSource = input.reuseFilesFrom ? resolve(input.reuseFilesFrom) : null;
  const files: BackupFileEntry[] = [];
  for (const relativePath of await listRelativeFiles(
    dataDirectory,
    '',
    (name) => EXCLUDED_TOP_LEVEL_ENTRIES.has(name),
  )) {
    const sourcePath = join(dataDirectory, ...relativePath.split('/'));
    const destinationPath = join(backupDirectory, ...relativePath.split('/'));
    await mkdir(dirname(destinationPath), { recursive: true });
    const content = await readFile(sourcePath);
    const contentSha256 = sha256(content);
    if (reuseSource && reusable.get(relativePath) === contentSha256) {
      const previousPath = join(reuseSource, ...relativePath.split('/'));
      try {
        // 先核对上一份文件本体未损坏，再复用，避免位腐随硬链接传播。
        if (sha256(await readFile(previousPath)) === contentSha256) {
          await link(previousPath, destinationPath);
          files.push({ path: relativePath, sha256: contentSha256, bytes: content.byteLength });
          continue;
        }
      } catch {
        // 文件系统不支持硬链接（如部分外接盘）时回退完整拷贝。
      }
    }
    await writeFile(destinationPath, content);
    files.push({ path: relativePath, sha256: contentSha256, bytes: content.byteLength });
  }

  const totals: BackupTotals = {
    files: files.length,
    bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
  };
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: input.appVersion,
    platform: process.platform,
    createdAt: now().toISOString(),
    database: databaseEntry,
    files,
    totals,
  };
  await writeFile(
    join(backupDirectory, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  return {
    backupDirectory,
    database: databaseEntry,
    files,
    totals,
    verification: await verifyBackup(backupDirectory),
  };
}

export async function verifyBackup(backupDirectory: string): Promise<BackupVerificationReport> {
  const directory = resolve(backupDirectory);
  const problems: string[] = [];
  let createdAt: string | null = null;
  let appVersion: string | null = null;

  const manifestPath = join(directory, MANIFEST_FILENAME);
  let manifest: BackupManifest | undefined;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
  } catch {
    problems.push(`无法读取 ${MANIFEST_FILENAME}，备份不完整`);
  }

  let entries: BackupFileEntry[] = [];
  if (manifest) {
    createdAt = manifest.createdAt ?? null;
    appVersion = manifest.appVersion ?? null;
    if (manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
      problems.push(`备份格式不受支持：${String(manifest.format)} v${String(manifest.formatVersion)}`);
    } else {
      entries = [manifest.database, ...manifest.files];
    }
  }

  let checkedFiles = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const problem = assertSafeManifestPath(entry.path);
    if (problem) {
      problems.push(problem);
      continue;
    }
    const entryPath = join(directory, ...entry.path.split('/'));
    try {
      const content = await readFile(entryPath);
      checkedFiles += 1;
      totalBytes += content.byteLength;
      if (content.byteLength !== entry.bytes) {
        problems.push(`${entry.path} 大小与清单不一致`);
      }
      if (sha256(content) !== entry.sha256) {
        problems.push(`${entry.path} 校验和不一致，内容已损坏或被篡改`);
      }
    } catch {
      problems.push(`${entry.path} 缺失，无法读取`);
    }
  }

  if (manifest && problems.length === 0) {
    const databasePath = join(directory, manifest.database.path);
    try {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = database.prepare('PRAGMA quick_check').get() as { quick_check?: string };
        if (row?.quick_check !== 'ok') {
          problems.push(`数据库完整性检查未通过：${row?.quick_check ?? '无结果'}`);
        }
      } finally {
        database.close();
      }
    } catch (error) {
      problems.push(`数据库无法打开：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (manifest && problems.length === 0) {
    const expected = new Set([MANIFEST_FILENAME, ...entries.map((entry) => entry.path)]);
    const actual = await listRelativeFiles(directory);
    for (const name of actual) {
      if (!expected.has(name) && !isToleratedExtraFile(name)) {
        problems.push(`备份目录存在清单外的未知文件：${name}`);
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    checkedFiles,
    totalBytes,
    createdAt,
    appVersion,
  };
}

function isInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath !== '' && !relativePath.startsWith('..') && !relativePath.startsWith(sep);
}

export async function restoreBackup(input: RestoreBackupInput): Promise<RestoreBackupResult> {
  const backupDirectory = resolve(input.backupDirectory);
  const targetDirectory = resolve(input.targetDirectory);

  const verification = await verifyBackup(backupDirectory);
  if (!verification.ok) {
    throw new Error(`备份未通过验证，已停止恢复：${verification.problems.join('；')}`);
  }

  if (input.currentDataDirectory) {
    const currentDataDirectory = resolve(input.currentDataDirectory);
    if (
      targetDirectory === currentDataDirectory
      || isInside(currentDataDirectory, targetDirectory)
      || isInside(targetDirectory, currentDataDirectory)
    ) {
      throw new Error('恢复目标不能是当前数据目录或与其互相包含，请选择新的空目录');
    }
  }

  if (await exists(targetDirectory)) {
    const existing = await readdir(targetDirectory);
    if (existing.length > 0) {
      throw new Error('恢复目标目录非空；为保护现有数据，请选择新的空目录');
    }
  }

  const manifest = JSON.parse(
    await readFile(join(backupDirectory, MANIFEST_FILENAME), 'utf8'),
  ) as BackupManifest;
  const entries: BackupFileEntry[] = [manifest.database, ...manifest.files];

  const stagingDirectory = join(
    dirname(targetDirectory),
    `.${basename(targetDirectory)}.restore-${process.pid}-${Date.now()}`,
  );
  await mkdir(stagingDirectory, { recursive: true });
  let restoredBytes = 0;
  try {
    for (const entry of entries) {
      const sourcePath = join(backupDirectory, ...entry.path.split('/'));
      const destinationPath = join(stagingDirectory, ...entry.path.split('/'));
      await mkdir(dirname(destinationPath), { recursive: true });
      const content = await readFile(sourcePath);
      await writeFile(destinationPath, content);
      restoredBytes += content.byteLength;
    }
    if (await exists(targetDirectory)) {
      // Windows 上 rename 不能落在已存在目录上；目标已验证为空目录，先移除再改名。
      await rmdir(targetDirectory);
    }
    await rename(stagingDirectory, targetDirectory);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    targetDirectory,
    restoredFiles: entries.length,
    restoredBytes,
    verification,
  };
}
