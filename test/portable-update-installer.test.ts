import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildPortableUpdateInstallPlan,
  assertWindowsPortableProgramRoot,
  launchPortableUpdateInstaller,
} from '../src/main/portable-update-installer';

describe('便携版更新辅助程序', () => {
  it('macOS 计划在退出后先验证候选，再保留旧 app 完成替换并在失败时回滚', () => {
    const plan = buildPortableUpdateInstallPlan({
      platform: 'darwin',
      version: '0.3.0',
      currentProcessId: 1234,
      currentExecutablePath: '/Applications/XianyuOrderManager.app/Contents/MacOS/XianyuOrderManager',
      archivePath: '/Users/test/Library/Application Support/updates/0.3.0/update.zip',
      archiveSha256: 'a'.repeat(64),
      backupDirectory: '/Volumes/Backup/xianyu-backup-20260822-100000',
      workingDirectory: '/Users/test/Library/Application Support/updates/0.3.0/apply-abc',
      statusFilePath: '/Users/test/Library/Application Support/updates/last-update-status.json',
      nonce: 'abc123',
    });

    expect(plan.programRoot).toBe('/Applications/XianyuOrderManager.app');
    expect(plan.rollbackRoot).toBe('/Applications/XianyuOrderManager.app.rollback-0.3.0-abc123');
    expect(plan.scriptFileName).toBe('apply-update.sh');
    expect(plan.environment.XIANYU_UPDATE_CANDIDATE_SMOKE).toBe('1');
    expect(plan.script).toContain('mv "$XIANYU_UPDATE_PROGRAM_ROOT" "$XIANYU_UPDATE_ROLLBACK_ROOT"');
    expect(plan.script).toContain('mv "$XIANYU_UPDATE_ROLLBACK_ROOT" "$XIANYU_UPDATE_PROGRAM_ROOT"');
    expect(plan.script).toContain('ditto -x -k');
    expect(plan.script).toContain('shasum -a 256');
    expect(plan.script).toContain('XIANYU_UPDATE_POST_INSTALL_MARKER');
    expect(plan.environment.XIANYU_UPDATE_BACKUP_DIRECTORY).toContain('xianyu-backup');
    expect(JSON.stringify(plan)).not.toContain('订单数据');
  });

  it('Windows 计划用 PowerShell 等待当前进程、隔离验证、替换目录并回滚', () => {
    const plan = buildPortableUpdateInstallPlan({
      platform: 'win32',
      version: '0.3.0',
      currentProcessId: 5678,
      currentExecutablePath: 'D:\\Apps\\XianyuOrderManager\\XianyuOrderManager.exe',
      archivePath: 'C:\\Users\\test\\AppData\\Local\\updates\\0.3.0\\update.zip',
      archiveSha256: 'a'.repeat(64),
      backupDirectory: 'E:\\Backup\\xianyu-backup-20260822-100000',
      workingDirectory: 'C:\\Users\\test\\AppData\\Local\\updates\\0.3.0\\apply-abc',
      statusFilePath: 'C:\\Users\\test\\AppData\\Local\\updates\\last-update-status.json',
      nonce: 'abc123',
    });

    expect(plan.programRoot).toBe('D:\\Apps\\XianyuOrderManager');
    expect(plan.rollbackRoot).toBe('D:\\Apps\\XianyuOrderManager.rollback-0.3.0-abc123');
    expect(plan.scriptFileName).toBe('apply-update.ps1');
    expect(plan.script).toContain('Expand-Archive');
    expect(plan.script).toContain('Get-FileHash');
    expect(plan.script).toContain('XIANYU_UPDATE_CANDIDATE_SMOKE');
    expect(plan.script).toContain('Move-Item -LiteralPath $env:XIANYU_UPDATE_PROGRAM_ROOT');
    expect(plan.script).toContain('Move-Item -LiteralPath $env:XIANYU_UPDATE_ROLLBACK_ROOT');
  });

  it('启动辅助程序前把脚本写入更新暂存区并以分离进程运行', async () => {
    const versionDirectory = await mkdtemp(join(tmpdir(), 'xianyu-update-installer-'));
    const workingDirectory = join(versionDirectory, 'apply-launch123');
    const unref = vi.fn();
    const spawnOptions: SpawnOptions[] = [];
    const spawn = vi.fn((
      _command: string,
      _args: readonly string[],
      options: SpawnOptions,
    ) => {
      spawnOptions.push(options);
      return { unref };
    });

    const outcome = await launchPortableUpdateInstaller({
      platform: 'darwin',
      version: '0.3.0',
      currentProcessId: 1234,
      currentExecutablePath: '/Applications/XianyuOrderManager.app/Contents/MacOS/XianyuOrderManager',
      archivePath: join(versionDirectory, 'update.zip'),
      archiveSha256: 'a'.repeat(64),
      backupDirectory: '/Volumes/Backup/xianyu-backup-20260822-100000',
      workingDirectory,
      statusFilePath: join(versionDirectory, '..', 'last-update-status.json'),
      nonce: 'launch123',
    }, {
      spawn,
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/test',
        XIANYU_TEST_SECRET: '不得继承',
      },
    });

    expect(await readFile(outcome.scriptPath, 'utf8')).toContain('#!/bin/sh');
    expect(spawn).toHaveBeenCalledWith(
      '/bin/sh',
      [outcome.scriptPath],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(unref).toHaveBeenCalledTimes(1);
    const spawnEnvironment = spawnOptions[0].env;
    expect(spawnEnvironment).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/test',
      XIANYU_UPDATE_CANDIDATE_SMOKE: '1',
    });
    expect(spawnEnvironment).not.toHaveProperty('XIANYU_TEST_SECRET');
  });

  it('Windows 只有目录内容与便携版边界标记完全一致时才允许整目录替换', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-windows-portable-root-'));
    await mkdir(join(root, 'resources'));
    await writeFile(join(root, 'XianyuOrderManager.exe'), 'exe');
    await writeFile(join(root, '.xianyu-portable-program.json'), JSON.stringify({
      schemaVersion: 1,
      product: 'xianyu-order-manager',
      topLevelEntries: [
        '.xianyu-portable-program.json',
        'XianyuOrderManager.exe',
        'resources',
      ],
    }));

    await expect(assertWindowsPortableProgramRoot(root)).resolves.toBeUndefined();

    await writeFile(join(root, '用户放在下载目录的其他文件.txt'), 'unrelated');
    await expect(assertWindowsPortableProgramRoot(root))
      .rejects.toThrow('包含便携版之外的文件');
  });
});
