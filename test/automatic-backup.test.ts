import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyBackupRetention,
  buildBackupStatus,
  runAutomaticBackupCycle,
} from '../src/main/automatic-backup';
import {
  BackupSettingsFile,
  DEFAULT_BACKUP_SETTINGS,
  type BackupSettingsRecord,
} from '../src/main/backup-settings-file';
import { createBackup } from '../src/main/backup-service';
import { Workspace } from '../src/main/workspace';

const applications: Workspace[] = [];

async function seedWorkspace(): Promise<{
  workspace: Workspace;
  dataDirectory: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-auto-backup-'));
  const dataDirectory = join(root, '数据');
  const workspace = Workspace.open(dataDirectory);
  applications.push(workspace);
  const screenshotBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  workspace.database.exec(`
    INSERT INTO recognition_batches (id, platform, seller_account, status, created_at)
    VALUES ('batch-1', 'xianyu', '自动备份测试账号', 'completed', '2026-08-18T10:00:00Z');
    INSERT INTO source_screenshots (
      id, batch_id, original_name, relative_path, content_sha256, mime_type, created_at
    ) VALUES (
      'shot-1', 'batch-1', '自动备份截图.png', 'screenshots/shot-1.png',
      'auto', 'image/png', '2026-08-18T10:00:01Z'
    );
  `);
  await mkdir(join(dataDirectory, 'screenshots'), { recursive: true });
  await writeFile(join(dataDirectory, 'screenshots', 'shot-1.png'), screenshotBytes);
  return { workspace, dataDirectory, root };
}

afterEach(() => {
  while (applications.length > 0) {
    const workspace = applications.pop();
    try {
      workspace?.close();
    } catch {
      // 临时目录随根一并清理。
    }
  }
});

function settingsWith(overrides: Partial<BackupSettingsRecord> = {}) {
  return { ...DEFAULT_BACKUP_SETTINGS, ...overrides };
}

describe('自动备份设置', () => {
  it('默认保留 30 个版本、上限 5 GB，且可持久化往返', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-backup-settings-'));
    const file = new BackupSettingsFile(root);

    expect(DEFAULT_BACKUP_SETTINGS).toEqual({
      autoBackupEnabled: false,
      backupRootDirectory: null,
      maxVersions: 30,
      capacityLimitBytes: 5 * 1024 * 1024 * 1024,
    });
    expect(file.read()).toEqual(DEFAULT_BACKUP_SETTINGS);

    file.write({
      autoBackupEnabled: true,
      backupRootDirectory: '/Volumes/Backup/闲鱼订单备份',
      maxVersions: 10,
      capacityLimitBytes: 2 * 1024 * 1024 * 1024,
    });
    expect(file.read()).toEqual({
      autoBackupEnabled: true,
      backupRootDirectory: '/Volumes/Backup/闲鱼订单备份',
      maxVersions: 10,
      capacityLimitBytes: 2 * 1024 * 1024 * 1024,
    });
  });

  it('损坏或非法的设置字段回退默认值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-backup-settings-'));
    const file = new BackupSettingsFile(root);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(root, 'backup-settings.json'),
      JSON.stringify({ autoBackupEnabled: 'yes', maxVersions: -3, capacityLimitBytes: 12 }),
      'utf8',
    );
    expect(file.read()).toEqual(DEFAULT_BACKUP_SETTINGS);
  });
});

describe('每日自动备份', () => {
  it('未开启或未配置目录时不产生备份', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const backupRoot = join(root, '备份库');

    const disabled = await runAutomaticBackupCycle({
      dataDirectory,
      database: workspace.database,
      settings: settingsWith({ backupRootDirectory: backupRoot }),
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });
    expect(disabled).toMatchObject({ ran: false, reason: 'disabled' });

    const withoutRoot = await runAutomaticBackupCycle({
      dataDirectory,
      database: workspace.database,
      settings: settingsWith({ autoBackupEnabled: true }),
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });
    expect(withoutRoot).toMatchObject({ ran: false, reason: 'no-root' });
    expect(await readdir(root)).not.toContain('备份库');
  });

  it('每天只建一份备份并记录事件，次日再建且未变截图按硬链接去重', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const backupRoot = join(root, '备份库');
    const settings = settingsWith({ autoBackupEnabled: true, backupRootDirectory: backupRoot });
    let clock = new Date('2026-08-18T10:30:00+08:00');

    const first = await runAutomaticBackupCycle({
      dataDirectory, database: workspace.database, settings, appVersion: '0.2.43',
      now: () => clock,
    });
    expect(first.ran).toBe(true);
    const firstBackups = (await readdir(backupRoot)).filter((name) => name.startsWith('xianyu-backup-'));
    expect(firstBackups).toHaveLength(1);

    const sameDay = await runAutomaticBackupCycle({
      dataDirectory, database: workspace.database, settings, appVersion: '0.2.43',
      now: () => new Date('2026-08-18T22:30:00+08:00'),
    });
    expect(sameDay).toMatchObject({ ran: false, reason: 'already-today' });

    clock = new Date('2026-08-19T10:30:00+08:00');
    const second = await runAutomaticBackupCycle({
      dataDirectory, database: workspace.database, settings, appVersion: '0.2.43',
      now: () => clock,
    });
    expect(second.ran).toBe(true);
    const backups = (await readdir(backupRoot)).filter((name) => name.startsWith('xianyu-backup-'));
    expect(backups).toHaveLength(2);

    // 未变化的截图在两份备份间共享同一存储（硬链接去重）。
    const firstShot = join(backupRoot, firstBackups[0], 'screenshots', 'shot-1.png');
    const secondShot = join(
      backupRoot, backups.find((name) => name !== firstBackups[0])!, 'screenshots', 'shot-1.png',
    );
    expect(await readFile(firstShot)).toEqual(await readFile(secondShot));
    expect((await stat(secondShot)).nlink).toBe(2);

    const status = await buildBackupStatus(backupRoot);
    expect(status.backups).toHaveLength(2);
    expect(status.events.map((event) => event.kind)).toEqual(['auto-created', 'auto-created']);
    expect(status.events.every((event) => event.verified === true)).toBe(true);
    // 去重感知占用：两份数据库快照各计一次，共享的截图只计一次。
    const logicalSum = status.backups.reduce((sum, entry) => sum + entry.bytes, 0);
    expect(status.totalBytes).toBeLessThan(logicalSum);
    expect(status.totalBytes).toBe(
      status.backups.reduce((sum, entry) => sum + entry.bytes, 0)
        - (await stat(secondShot)).size,
    );
  });
});

describe('恢复点清理策略', () => {
  async function backupAt(
    workspace: Workspace,
    dataDirectory: string,
    backupRoot: string,
    stamp: string,
  ): Promise<string> {
    return (await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: backupRoot,
      appVersion: '0.2.43',
      now: () => new Date(stamp),
    })).backupDirectory;
  }

  it('超过保留版本数时从最旧开始清理，保留最新', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const backupRoot = join(root, '备份库');
    const oldest = await backupAt(workspace, dataDirectory, backupRoot, '2026-08-16T10:30:00+08:00');
    await backupAt(workspace, dataDirectory, backupRoot, '2026-08-17T10:30:00+08:00');
    await backupAt(workspace, dataDirectory, backupRoot, '2026-08-18T10:30:00+08:00');

    const outcome = await applyBackupRetention({
      backupRootDirectory: backupRoot,
      maxVersions: 2,
      capacityLimitBytes: 5 * 1024 * 1024 * 1024,
      now: () => new Date('2026-08-18T11:00:00+08:00'),
    });

    expect((await readdir(backupRoot)).filter((n) => n.startsWith('xianyu-backup-'))).toHaveLength(2);
    expect(await readdir(backupRoot).then((names) => names.includes(oldest.split('/').pop()!))).toBe(false);
    expect(outcome.deleted.map((event) => event.reason)).toEqual(['版本数超限']);
    expect(outcome.overCapacity).toBe(false);
  });

  it('容量上限优先于版本数，唯一备份超限时保留并标记临时超额', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const backupRoot = join(root, '备份库');
    await backupAt(workspace, dataDirectory, backupRoot, '2026-08-17T10:30:00+08:00');
    const newest = await backupAt(workspace, dataDirectory, backupRoot, '2026-08-18T10:30:00+08:00');

    const status = await buildBackupStatus(backupRoot);
    const totalBytes = status.totalBytes;

    const outcome = await applyBackupRetention({
      backupRootDirectory: backupRoot,
      maxVersions: 30,
      capacityLimitBytes: Math.floor(totalBytes / 2) - 1,
      now: () => new Date('2026-08-18T11:00:00+08:00'),
    });

    const remaining = (await readdir(backupRoot)).filter((n) => n.startsWith('xianyu-backup-'));
    expect(remaining).toHaveLength(1);
    expect(newest).toContain(remaining[0]);
    expect(outcome.deleted.map((event) => event.reason)).toEqual(['容量超限']);
    expect(outcome.overCapacity).toBe(true);
  });
});

describe('备份状态视图', () => {
  it('汇总各备份的创建时间、占用与最近事件', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const backupRoot = join(root, '备份库');
    const settings = settingsWith({ autoBackupEnabled: true, backupRootDirectory: backupRoot });
    await runAutomaticBackupCycle({
      dataDirectory, database: workspace.database, settings, appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });

    const status = await buildBackupStatus(backupRoot);
    expect(status.backups).toHaveLength(1);
    expect(status.backups[0]).toMatchObject({
      appVersion: '0.2.43',
      createdAt: '2026-08-18T02:30:00.000Z',
    });
    expect(status.backups[0].bytes).toBeGreaterThan(0);
    expect(status.backups[0].files).toBe(1);
    expect(status.totalBytes).toBe(status.backups[0].bytes);
    expect(status.capacityLimitBytes).toBe(5 * 1024 * 1024 * 1024);
    expect(status.overCapacity).toBe(false);
    expect(status.events[0]).toMatchObject({ kind: 'auto-created' });
    expect(status.lastVerification).toMatchObject({ ok: true });
    expect(status.lastVerification?.at).toBe('2026-08-18T02:30:00.000Z');
  });
});

