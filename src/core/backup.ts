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
