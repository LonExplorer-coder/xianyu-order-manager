import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createBackup,
  restoreBackup,
  verifyBackup,
} from '../src/main/backup-service';
import { Workspace } from '../src/main/workspace';

const DATABASE_FILENAME = 'xianyu-order-manager.sqlite3';
const LOCK_FILENAME = '.xianyu-order-manager-writer.sqlite3';

const applications: Workspace[] = [];

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      names.push(...await listFiles(join(directory, entry.name), relativePath));
    } else {
      names.push(relativePath);
    }
  }
  return names.sort();
}

async function seedWorkspace(): Promise<{
  workspace: Workspace;
  dataDirectory: string;
  root: string;
  screenshotBytes: Buffer;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-backup-service-'));
  const dataDirectory = join(root, '数据');
  const workspace = Workspace.open(dataDirectory);
  applications.push(workspace);
  workspace.database.exec(`
    INSERT INTO recognition_batches (id, platform, seller_account, status, created_at)
    VALUES ('batch-1', 'xianyu', '备份测试账号', 'completed', '2026-08-18T10:00:00Z');
  `);
  const screenshotBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  workspace.database.exec(`
    INSERT INTO source_screenshots (
      id, batch_id, original_name, relative_path, content_sha256, mime_type, created_at
    ) VALUES (
      'shot-1', 'batch-1', '验收截图.png', 'screenshots/shot-1.png',
      '${sha256(screenshotBytes)}', 'image/png', '2026-08-18T10:00:01Z'
    );
  `);
  await mkdir(join(dataDirectory, 'screenshots'), { recursive: true });
  await writeFile(join(dataDirectory, 'screenshots', 'shot-1.png'), screenshotBytes);
  return { workspace, dataDirectory, root, screenshotBytes };
}

afterEach(() => {
  while (applications.length > 0) {
    const workspace = applications.pop();
    try {
      workspace?.close();
    } catch {
      // 测试数据目录随 mkdtemp 根目录一并清理。
    }
  }
});

describe('完整备份', () => {
  it('备份数据库快照与来源截图并生成校验和清单，验证立即通过', async () => {
    const { workspace, dataDirectory, root, screenshotBytes } = await seedWorkspace();
    const backupRoot = join(root, '备份库');

    const result = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: backupRoot,
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });

    expect(result.verification.ok).toBe(true);
    expect(result.database.path).toBe(DATABASE_FILENAME);
    expect(result.files).toEqual([
      {
        path: 'screenshots/shot-1.png',
        sha256: sha256(screenshotBytes),
        bytes: screenshotBytes.byteLength,
      },
    ]);
    expect(result.totals).toEqual({ files: 1, bytes: screenshotBytes.byteLength });

    const backupDirectory = result.backupDirectory;
    const backupDirectoryName = backupDirectory.split(sep).pop() ?? backupDirectory;
    expect(backupDirectoryName).toMatch(/^xianyu-backup-\d{8}-\d{6}$/);
    expect(await listFiles(backupDirectory)).toEqual([
      'manifest.json',
      'screenshots/shot-1.png',
      DATABASE_FILENAME,
    ]);

    const manifest = JSON.parse(await readFile(join(backupDirectory, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('xianyu-order-backup');
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.appVersion).toBe('0.2.43');
    expect(manifest.database.path).toBe(DATABASE_FILENAME);
    expect(manifest.database.sha256).toBe(sha256(await readFile(join(backupDirectory, DATABASE_FILENAME))));
    // 清单只使用跨平台相对路径，Mac 备份可在 Windows 恢复。
    expect(manifest.database.path).not.toContain('\\');
    for (const entry of manifest.files) {
      expect(entry.path.startsWith('/')).toBe(false);
      expect(entry.path).not.toContain('..');
      expect(entry.path).not.toContain('\\');
    }

    // 活动数据库在备份后仍可继续写入。
    workspace.database.exec(`
      INSERT INTO recognition_batches (id, platform, seller_account, status, created_at)
      VALUES ('batch-2', 'xianyu', '备份测试账号', 'completed', '2026-08-18T11:00:00Z');
    `);
    const count = workspace.database.prepare(
      'SELECT COUNT(*) AS total FROM recognition_batches',
    ).get() as { total: number };
    expect(count.total).toBe(2);
  });

  it('备份排除写入锁与数据库边车文件，不包含任何密钥文件', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    // WAL 模式下 -wal/-shm 被活动连接持有，伪造会与 Windows 句柄冲突；
    // 用 -journal（WAL 模式不使用）验证边车排除，真实边车随后一并断言。
    await writeFile(join(dataDirectory, `${DATABASE_FILENAME}-journal`), Buffer.from('stale journal'));
    await mkdir(join(dataDirectory, '.recognition-queue', 'batch-9', 'item-1'), { recursive: true });
    await writeFile(
      join(dataDirectory, '.recognition-queue', 'batch-9', 'item-1', '排队中.png'),
      Buffer.from('识别中暂存'),
    );
    await mkdir(join(dataDirectory, '.mobile-upload-staging', 'upload-1'), { recursive: true });
    await writeFile(
      join(dataDirectory, '.mobile-upload-staging', 'upload-1', '手机上传中.png'),
      Buffer.from('手机上传暂存'),
    );
    await mkdir(join(dataDirectory, '.source-screenshot-trash'), { recursive: true });
    await writeFile(
      join(dataDirectory, '.source-screenshot-trash', '待清理.image'),
      Buffer.from('来源截图清理回滚副本'),
    );
    const backupRoot = join(root, '备份库');

    const result = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: backupRoot,
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });

    const backedUp = await listFiles(result.backupDirectory);
    expect(backedUp).toEqual(['manifest.json', 'screenshots/shot-1.png', DATABASE_FILENAME]);
    // 写入锁与真实 WAL 边车在数据目录中存在，但绝不能进入备份。
    const dataDirectoryEntries = await readdir(dataDirectory);
    expect(dataDirectoryEntries).toContain(LOCK_FILENAME);
    for (const name of dataDirectoryEntries) {
      if (name === `${DATABASE_FILENAME}-wal` || name === `${DATABASE_FILENAME}-shm`) {
        expect(backedUp).not.toContain(name);
      }
    }
    expect(backedUp).not.toContain(LOCK_FILENAME);
    expect(backedUp).not.toContain(`${DATABASE_FILENAME}-journal`);
  });

  it('同一秒内再次备份使用不冲突的目录名', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const backupRoot = join(root, '备份库');
    const input = {
      dataDirectory,
      database: workspace.database as DatabaseSync,
      backupRootDirectory: backupRoot,
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    };

    const first = await createBackup(input);
    const second = await createBackup(input);

    expect(first.backupDirectory).not.toBe(second.backupDirectory);
    expect((await readdir(backupRoot))).toHaveLength(2);
    expect((await verifyBackup(second.backupDirectory)).ok).toBe(true);
  });

  it('备份位置在当前数据目录内时拒绝执行', async () => {
    const { workspace, dataDirectory } = await seedWorkspace();

    await expect(createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(dataDirectory, '备份库'),
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    })).rejects.toThrow('数据目录内');
  });
});

describe('备份验证', () => {
  it('清单、校验和与数据库完整性全部通过时验证通过', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const result = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(root, '备份库'),
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });

    const verification = await verifyBackup(result.backupDirectory);
    expect(verification.ok).toBe(true);
    expect(verification.problems).toEqual([]);
    expect(verification.checkedFiles).toBe(2);
    expect(verification.appVersion).toBe('0.2.43');
  });

  it('截图被篡改或数据库缺失时验证失败并指明问题文件', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const result = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(root, '备份库'),
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });

    await writeFile(join(result.backupDirectory, 'screenshots', 'shot-1.png'), Buffer.from('被篡改'));
    const tampered = await verifyBackup(result.backupDirectory);
    expect(tampered.ok).toBe(false);
    expect(tampered.problems.join('\n')).toContain('screenshots/shot-1.png');

    await rm(join(result.backupDirectory, DATABASE_FILENAME));
    const missing = await verifyBackup(result.backupDirectory);
    expect(missing.ok).toBe(false);
    expect(missing.problems.join('\n')).toContain(DATABASE_FILENAME);
  });

  it('缺少清单或多出的未知文件都判定为不可恢复', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const result = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(root, '备份库'),
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });

    await writeFile(join(result.backupDirectory, '多余文件.txt'), Buffer.from('未知内容'));
    const withExtra = await verifyBackup(result.backupDirectory);
    expect(withExtra.ok).toBe(false);
    expect(withExtra.problems.join('\n')).toContain('多余文件.txt');

    await rm(join(result.backupDirectory, '多余文件.txt'));
    await rm(join(result.backupDirectory, 'manifest.json'));
    const withoutManifest = await verifyBackup(result.backupDirectory);
    expect(withoutManifest.ok).toBe(false);
    expect(withoutManifest.problems.join('\n')).toContain('manifest.json');
  });

  it('系统与同步盘标记文件不导致验证失败', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const result = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(root, '备份库'),
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });

    await writeFile(join(result.backupDirectory, '.DS_Store'), Buffer.from('Finder'));
    await writeFile(
      join(result.backupDirectory, 'screenshots', '._shot-1.png'),
      Buffer.from('AppleDouble'),
    );
    expect((await verifyBackup(result.backupDirectory)).ok).toBe(true);
  });
});

describe('备份恢复', () => {
  it('恢复到空目录后可用原数据目录方式打开且业务数据一致', async () => {
    const { workspace, dataDirectory, root, screenshotBytes } = await seedWorkspace();
    const backupRoot = join(root, '备份库');
    const backup = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: backupRoot,
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });
    workspace.close();
    applications.splice(applications.indexOf(workspace), 1);

    const targetDirectory = join(root, '恢复出的数据');
    const restored = await restoreBackup({
      backupDirectory: backup.backupDirectory,
      targetDirectory,
      currentDataDirectory: dataDirectory,
    });

    expect(restored.verification.ok).toBe(true);
    expect(restored.restoredFiles).toBe(2);
    expect(await readFile(join(targetDirectory, 'screenshots', 'shot-1.png'))).toEqual(screenshotBytes);
    expect(await listFiles(targetDirectory)).toEqual([
      'screenshots/shot-1.png',
      DATABASE_FILENAME,
    ]);

    const reopened = Workspace.open(targetDirectory);
    applications.push(reopened);
    const screenshot = reopened.database.prepare(
      'SELECT id, relative_path, content_sha256 FROM source_screenshots WHERE id = ?',
    ).get('shot-1') as { id: string; relative_path: string; content_sha256: string };
    expect(screenshot).toEqual({
      id: 'shot-1',
      relative_path: 'screenshots/shot-1.png',
      content_sha256: sha256(screenshotBytes),
    });
  });

  it('恢复可以落在已存在的空目录上', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const backup = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(root, '备份库'),
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });

    const emptyTarget = join(root, '已存在的空目录');
    await mkdir(emptyTarget);
    const restored = await restoreBackup({
      backupDirectory: backup.backupDirectory,
      targetDirectory: emptyTarget,
      currentDataDirectory: dataDirectory,
    });

    expect(restored.targetDirectory).toBe(emptyTarget);
    expect(await readFile(join(emptyTarget, DATABASE_FILENAME))).toEqual(
      await readFile(join(backup.backupDirectory, DATABASE_FILENAME)),
    );
  });

  it('恢复拒绝指向当前数据目录或非空目录，且不改动目标', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const backup = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(root, '备份库'),
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });

    await expect(restoreBackup({
      backupDirectory: backup.backupDirectory,
      targetDirectory: dataDirectory,
      currentDataDirectory: dataDirectory,
    })).rejects.toThrow('当前数据目录');

    const nonEmpty = join(root, '非空目录');
    await mkdir(nonEmpty);
    await writeFile(join(nonEmpty, '已有文件.txt'), Buffer.from('原有内容'));
    await expect(restoreBackup({
      backupDirectory: backup.backupDirectory,
      targetDirectory: nonEmpty,
      currentDataDirectory: dataDirectory,
    })).rejects.toThrow('非空');
    expect(await readFile(join(nonEmpty, '已有文件.txt'), 'utf8')).toBe('原有内容');

    const siblingFiles = await readdir(root);
    expect(siblingFiles.filter((name) => name.includes('restore-'))).toEqual([]);
  });

  it('备份未通过验证时恢复直接失败，不产生目标目录或残留', async () => {
    const { workspace, dataDirectory, root } = await seedWorkspace();
    const backup = await createBackup({
      dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(root, '备份库'),
      appVersion: '0.2.43',
      now: () => new Date('2026-08-18T10:30:00+08:00'),
    });
    await writeFile(join(backup.backupDirectory, 'screenshots', 'shot-1.png'), Buffer.from('被篡改'));

    const targetDirectory = join(root, '不应生成');
    await expect(restoreBackup({
      backupDirectory: backup.backupDirectory,
      targetDirectory,
      currentDataDirectory: dataDirectory,
    })).rejects.toThrow('验证');
    expect(await readdir(root)).not.toContain('不应生成');
    expect((await readdir(root)).filter((name) => name.includes('restore-'))).toEqual([]);
  });
});
