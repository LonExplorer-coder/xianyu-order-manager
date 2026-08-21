import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildPortableUpdateInstallPlan,
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
      backupDirectory: '/Volumes/Backup/xianyu-backup-20260822-100000',
      workingDirectory: '/Users/test/Library/Application Support/updates/0.3.0/apply-abc',
      nonce: 'abc123',
    });

    expect(plan.programRoot).toBe('/Applications/XianyuOrderManager.app');
    expect(plan.rollbackRoot).toBe('/Applications/XianyuOrderManager.app.rollback-0.3.0-abc123');
    expect(plan.scriptFileName).toBe('apply-update.sh');
    expect(plan.environment.XIANYU_UPDATE_CANDIDATE_SMOKE).toBe('1');
    expect(plan.script).toContain('mv "$XIANYU_UPDATE_PROGRAM_ROOT" "$XIANYU_UPDATE_ROLLBACK_ROOT"');
    expect(plan.script).toContain('mv "$XIANYU_UPDATE_ROLLBACK_ROOT" "$XIANYU_UPDATE_PROGRAM_ROOT"');
    expect(plan.script).toContain('ditto -x -k');
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
      backupDirectory: 'E:\\Backup\\xianyu-backup-20260822-100000',
      workingDirectory: 'C:\\Users\\test\\AppData\\Local\\updates\\0.3.0\\apply-abc',
      nonce: 'abc123',
    });

    expect(plan.programRoot).toBe('D:\\Apps\\XianyuOrderManager');
    expect(plan.rollbackRoot).toBe('D:\\Apps\\XianyuOrderManager.rollback-0.3.0-abc123');
    expect(plan.scriptFileName).toBe('apply-update.ps1');
    expect(plan.script).toContain('Expand-Archive');
    expect(plan.script).toContain('XIANYU_UPDATE_CANDIDATE_SMOKE');
    expect(plan.script).toContain('Move-Item -LiteralPath $env:XIANYU_UPDATE_PROGRAM_ROOT');
    expect(plan.script).toContain('Move-Item -LiteralPath $env:XIANYU_UPDATE_ROLLBACK_ROOT');
  });

  it('启动辅助程序前把脚本写入更新暂存区并以分离进程运行', async () => {
    const versionDirectory = await mkdtemp(join(tmpdir(), 'xianyu-update-installer-'));
    const workingDirectory = join(versionDirectory, 'apply-launch123');
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));

    const outcome = await launchPortableUpdateInstaller({
      platform: 'darwin',
      version: '0.3.0',
      currentProcessId: 1234,
      currentExecutablePath: '/Applications/XianyuOrderManager.app/Contents/MacOS/XianyuOrderManager',
      archivePath: join(versionDirectory, 'update.zip'),
      backupDirectory: '/Volumes/Backup/xianyu-backup-20260822-100000',
      workingDirectory,
      nonce: 'launch123',
    }, { spawn });

    expect(await readFile(outcome.scriptPath, 'utf8')).toContain('#!/bin/sh');
    expect(spawn).toHaveBeenCalledWith(
      '/bin/sh',
      [outcome.scriptPath],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
