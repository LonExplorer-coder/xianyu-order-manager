import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const electronBoundary = vi.hoisted(() => ({
  userData: '/tmp/xianyu-update-post-install-unset',
  version: '0.3.0',
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
    getVersion: () => electronBoundary.version,
    getPath: (name: string) => name === 'userData'
      ? electronBoundary.userData
      : name === 'exe' ? process.execPath : '/Users/test/Documents',
  },
  BrowserWindow: class MockBrowserWindow {
    public static getAllWindows(): unknown[] { return []; }
    public static fromWebContents(): unknown { return undefined; }
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  nativeImage: { createFromBitmap: vi.fn() },
}));

import { completePortableUpdateStartup } from '../src/main/electron-main';

const UPDATE_ENV_KEYS = [
  'XIANYU_UPDATE_POST_INSTALL_TOKEN',
  'XIANYU_UPDATE_POST_INSTALL_MARKER',
  'XIANYU_UPDATE_STATUS_FILE',
  'XIANYU_UPDATE_EXPECTED_VERSION',
] as const;

afterEach(() => {
  for (const key of UPDATE_ENV_KEYS) delete process.env[key];
});

describe('便携版更新后的真实数据启动确认', () => {
  it('新版本恢复并读取原数据目录后写入成功状态与一次性确认标记', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-update-post-install-'));
    electronBoundary.userData = root;
    configureUpdateEnvironment(root, 'post-install-token');

    const result = await completePortableUpdateStartup({
      kind: 'ready',
      dataDirectory: '/Users/test/订单数据',
      orders: [],
    });

    expect(result).toBe(true);
    expect(await readFile(processMarker(root), 'utf8')).toBe('post-install-token');
    expect(JSON.parse(await readFile(statusFile(root), 'utf8'))).toMatchObject({
      status: 'succeeded',
      version: '0.3.0',
      message: '新便携程序已启动并读取原订单数据目录',
    });
    for (const key of UPDATE_ENV_KEYS) expect(process.env[key]).toBeUndefined();
  });

  it('版本不符或原数据目录不可读时写入失败状态且不产生确认标记', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-update-post-install-failed-'));
    electronBoundary.userData = root;
    configureUpdateEnvironment(root, 'failed-token');

    const result = await completePortableUpdateStartup({
      kind: 'error',
      message: '无法打开原数据目录',
    });

    expect(result).toBe(false);
    expect(JSON.parse(await readFile(statusFile(root), 'utf8'))).toMatchObject({
      status: 'failed',
      version: '0.3.0',
    });
    await expect(access(processMarker(root))).rejects.toThrow();
  });
});

function configureUpdateEnvironment(root: string, token: string): void {
  process.env.XIANYU_UPDATE_POST_INSTALL_TOKEN = token;
  process.env.XIANYU_UPDATE_POST_INSTALL_MARKER = processMarker(root);
  process.env.XIANYU_UPDATE_STATUS_FILE = statusFile(root);
  process.env.XIANYU_UPDATE_EXPECTED_VERSION = '0.3.0';
}

function processMarker(root: string): string {
  return join(root, 'updates', 'apply-test', 'post-install.marker');
}

function statusFile(root: string): string {
  return join(root, 'updates', 'last-update-status.json');
}
