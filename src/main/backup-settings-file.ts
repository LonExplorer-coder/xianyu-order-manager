import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BackupSettingsRecord {
  autoBackupEnabled: boolean;
  backupRootDirectory: string | null;
  /** 手动「立即备份」的默认位置；配置后不再弹目录选择框。 */
  manualBackupRootDirectory: string | null;
  /** 「恢复备份」的默认父目录；每次恢复在其下建时间戳子目录。 */
  restoreTargetDirectory: string | null;
  maxVersions: number;
  capacityLimitBytes: number;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettingsRecord = {
  autoBackupEnabled: false,
  backupRootDirectory: null,
  manualBackupRootDirectory: null,
  restoreTargetDirectory: null,
  maxVersions: 30,
  capacityLimitBytes: 5 * 1024 * 1024 * 1024,
};

export const MIN_CAPACITY_LIMIT_BYTES = 100 * 1024 * 1024;
export const MAX_CAPACITY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024 * 1024;

export function isValidBackupSettings(record: BackupSettingsRecord): boolean {
  return Number.isInteger(record.maxVersions)
    && record.maxVersions >= 1
    && record.maxVersions <= 1_000
    && Number.isInteger(record.capacityLimitBytes)
    && record.capacityLimitBytes >= MIN_CAPACITY_LIMIT_BYTES
    && record.capacityLimitBytes <= MAX_CAPACITY_LIMIT_BYTES;
}

export class BackupSettingsFile {
  private readonly filePath: string;

  public constructor(private readonly configDirectory: string) {
    this.filePath = join(configDirectory, 'backup-settings.json');
  }

  public read(): BackupSettingsRecord {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ...DEFAULT_BACKUP_SETTINGS };
    }
    return {
      autoBackupEnabled:
        typeof parsed.autoBackupEnabled === 'boolean'
          ? parsed.autoBackupEnabled
          : DEFAULT_BACKUP_SETTINGS.autoBackupEnabled,
      backupRootDirectory:
        typeof parsed.backupRootDirectory === 'string' && parsed.backupRootDirectory.trim()
          ? parsed.backupRootDirectory
          : null,
      manualBackupRootDirectory:
        typeof parsed.manualBackupRootDirectory === 'string' && parsed.manualBackupRootDirectory.trim()
          ? parsed.manualBackupRootDirectory
          : null,
      restoreTargetDirectory:
        typeof parsed.restoreTargetDirectory === 'string' && parsed.restoreTargetDirectory.trim()
          ? parsed.restoreTargetDirectory
          : null,
      maxVersions: integerInRange(parsed.maxVersions, 1, 1_000)
        ?? DEFAULT_BACKUP_SETTINGS.maxVersions,
      capacityLimitBytes: integerInRange(
        parsed.capacityLimitBytes,
        MIN_CAPACITY_LIMIT_BYTES,
        MAX_CAPACITY_LIMIT_BYTES,
      ) ?? DEFAULT_BACKUP_SETTINGS.capacityLimitBytes,
    };
  }

  public write(record: BackupSettingsRecord): void {
    mkdirSync(this.configDirectory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(record, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    renameSync(temporaryPath, this.filePath);
  }
}

function integerInRange(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}
