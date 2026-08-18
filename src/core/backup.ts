export interface BackupFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface BackupTotals {
  files: number;
  bytes: number;
}

export interface BackupVerificationReport {
  ok: boolean;
  problems: string[];
  checkedFiles: number;
  totalBytes: number;
  createdAt: string | null;
  appVersion: string | null;
}

export interface CreateBackupResult {
  backupDirectory: string;
  database: BackupFileEntry;
  files: BackupFileEntry[];
  totals: BackupTotals;
  verification: BackupVerificationReport;
}

export interface RestoreBackupResult {
  targetDirectory: string;
  restoredFiles: number;
  restoredBytes: number;
  verification: BackupVerificationReport;
}

export type BackupCreateOutcome =
  | { kind: 'canceled' }
  | { kind: 'created' } & CreateBackupResult;

export type BackupVerifyOutcome =
  | { kind: 'canceled' }
  | { kind: 'verified'; result: BackupVerificationReport };

export type BackupRestoreOutcome =
  | { kind: 'canceled' }
  | { kind: 'restored' } & RestoreBackupResult;

export interface BackupSettingsView {
  autoBackupEnabled: boolean;
  backupRootDirectory: string | null;
  maxVersions: number;
  capacityLimitBytes: number;
}

export interface SaveBackupSettingsInput extends BackupSettingsView {}

export interface BackupInventoryEntry {
  backupDirectory: string;
  createdAt: string | null;
  appVersion: string | null;
  bytes: number;
  files: number;
}

export type BackupEventKind = 'auto-created' | 'auto-failed' | 'deleted';

export interface BackupEventRecord {
  at: string;
  kind: BackupEventKind;
  backupDirectory?: string;
  bytes?: number;
  reason?: string;
  note?: string;
  verified?: boolean;
}

export interface BackupVerificationSummary {
  at: string;
  ok: boolean;
  note?: string;
}

export interface BackupStatusView {
  backups: BackupInventoryEntry[];
  totalBytes: number;
  capacityLimitBytes: number;
  overCapacity: boolean;
  lastAutoBackupAt: string | null;
  lastVerification: BackupVerificationSummary | null;
  events: BackupEventRecord[];
}

export type BackupSelectRootOutcome =
  | { kind: 'canceled' }
  | { kind: 'selected'; directory: string };
