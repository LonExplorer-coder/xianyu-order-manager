import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createBackup } from '../src/main/backup-service';
import { runUpdateCandidateSmoke } from '../src/main/update-candidate-smoke';
import { CURRENT_WORKSPACE_SCHEMA_VERSION, Workspace } from '../src/main/workspace';

describe('更新候选隔离健康检查', () => {
  it('只在已验证备份的隔离恢复副本上执行数据库升级与完整性检查', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-update-candidate-smoke-'));
    const dataDirectory = join(root, 'current-data');
    const workspace = Workspace.open(dataDirectory);
    const backup = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(root, 'backups'),
      appVersion: '0.2.68',
    });
    workspace.close();
    const healthDataDirectory = join(root, 'health-data');

    const result = await runUpdateCandidateSmoke({
      backupDirectory: backup.backupDirectory,
      healthDataDirectory,
    });

    expect(result).toEqual({
      restoredFiles: backup.files.length + 1,
      schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
      databaseCheck: 'ok',
    });
    const restored = Workspace.open(healthDataDirectory);
    expect(restored.database.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
    restored.close();
  });

  it('备份损坏时不建立健康检查数据目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-update-candidate-broken-'));
    const dataDirectory = join(root, 'current-data');
    const workspace = Workspace.open(dataDirectory);
    const backup = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(root, 'backups'),
      appVersion: '0.2.68',
    });
    workspace.close();
    await mkdir(join(backup.backupDirectory, 'unexpected'), { recursive: true });
    await writeFile(join(backup.backupDirectory, 'unexpected', 'file.txt'), 'tampered');

    await expect(runUpdateCandidateSmoke({
      backupDirectory: backup.backupDirectory,
      healthDataDirectory: join(root, 'health-data'),
    })).rejects.toThrow('备份验证未通过');
  });
});
