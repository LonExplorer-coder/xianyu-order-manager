import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PORTABLE_SMOKE_ORDER_NUMBER,
  runPortableReleaseDataSmoke,
} from '../src/main/portable-release-smoke';

const testRoots: string[] = [];

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe('便携版数据目录冒烟', () => {
  it('首次选择独立目录并导入一单，退出重启后从原目录读回', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-portable-data-smoke-'));
    testRoots.push(root);
    const configDirectory = join(root, '系统启动配置');
    const dataDirectory = join(root, '用户选择的订单数据');

    await expect(runPortableReleaseDataSmoke({
      phase: 'write',
      configDirectory,
      dataDirectory,
    })).resolves.toEqual({
      phase: 'write',
      dataDirectory,
      orderNumber: PORTABLE_SMOKE_ORDER_NUMBER,
      orderCount: 1,
    });

    await access(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    const bootstrap = JSON.parse(
      await readFile(join(configDirectory, 'bootstrap.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(bootstrap.lastDataDirectory).toBe(dataDirectory);

    await expect(runPortableReleaseDataSmoke({
      phase: 'read',
      configDirectory,
      dataDirectory,
    })).resolves.toEqual({
      phase: 'read',
      dataDirectory,
      orderNumber: PORTABLE_SMOKE_ORDER_NUMBER,
      orderCount: 1,
    });
  });

  it('读回阶段拒绝空目录，避免把未执行验收误报为通过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-portable-empty-smoke-'));
    testRoots.push(root);

    await expect(runPortableReleaseDataSmoke({
      phase: 'read',
      configDirectory: join(root, '系统启动配置'),
      dataDirectory: join(root, '用户选择的订单数据'),
    })).rejects.toThrow('便携版重启后未能自动打开原订单数据目录');
  });

  it('已有同名文件时拒绝覆盖或删除，避免误用冒烟入口破坏文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-portable-safe-smoke-'));
    testRoots.push(root);
    const configDirectory = join(root, '系统启动配置');
    const sourcePath = join(configDirectory, 'portable-release-smoke.png');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(sourcePath, 'do-not-overwrite');

    await expect(runPortableReleaseDataSmoke({
      phase: 'write',
      configDirectory,
      dataDirectory: join(root, '用户选择的订单数据'),
    })).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('do-not-overwrite');
  });
});
