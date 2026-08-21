import { restoreBackup, verifyBackup } from './backup-service';
import { Workspace } from './workspace';

export async function runUpdateCandidateSmoke(input: {
  backupDirectory: string;
  healthDataDirectory: string;
}): Promise<{
  restoredFiles: number;
  schemaVersion: number;
  databaseCheck: string;
}> {
  const verification = await verifyBackup(input.backupDirectory);
  if (!verification.ok) {
    throw new Error(`备份验证未通过：${verification.problems.join('；')}`);
  }
  const restored = await restoreBackup({
    backupDirectory: input.backupDirectory,
    targetDirectory: input.healthDataDirectory,
  });
  const workspace = Workspace.open(input.healthDataDirectory);
  try {
    const databaseCheck = workspace.database.prepare('PRAGMA quick_check').get() as {
      quick_check?: string;
    };
    const schema = workspace.database.prepare(
      'SELECT MAX(version) AS version FROM schema_migrations',
    ).get() as { version?: number };
    if (databaseCheck.quick_check !== 'ok' || !Number.isSafeInteger(schema.version)) {
      throw new Error('更新候选无法完整读取隔离恢复数据');
    }
    return {
      restoredFiles: restored.restoredFiles,
      schemaVersion: schema.version!,
      databaseCheck: databaseCheck.quick_check,
    };
  } finally {
    workspace.close();
  }
}
