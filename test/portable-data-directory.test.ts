import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assertDataDirectoryOutsideProgram } from '../src/main/portable-data-directory';

const testRoots: string[] = [];

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe('便携版数据目录边界', () => {
  it('Windows 拒绝程序目录及其子目录，允许独立的文档目录', () => {
    const executablePath = 'C:\\Users\\seller\\Downloads\\XianyuOrderManager\\XianyuOrderManager.exe';

    expect(() => assertDataDirectoryOutsideProgram({
      dataDirectory: 'C:\\Users\\seller\\Downloads\\XianyuOrderManager',
      executablePath,
      platform: 'win32',
      canonicalizePath: (path) => path,
    })).toThrow('不能放在程序目录内');
    expect(() => assertDataDirectoryOutsideProgram({
      dataDirectory: 'c:\\users\\seller\\downloads\\xianyuordermanager\\订单数据',
      executablePath,
      platform: 'win32',
      canonicalizePath: (path) => path,
    })).toThrow('不能放在程序目录内');
    expect(() => assertDataDirectoryOutsideProgram({
      dataDirectory: 'C:\\Users\\seller\\Documents\\闲鱼订单数据',
      executablePath,
      platform: 'win32',
      canonicalizePath: (path) => path,
    })).not.toThrow();
  });

  it('Windows 使用真实路径拒绝指向程序目录的 junction', () => {
    const executablePath = 'C:\\Users\\seller\\Downloads\\XianyuOrderManager\\XianyuOrderManager.exe';
    const junctionPath = 'C:\\Users\\seller\\Documents\\订单数据';

    expect(() => assertDataDirectoryOutsideProgram({
      dataDirectory: junctionPath,
      executablePath,
      platform: 'win32',
      canonicalizePath: (path) => (
        path.toLocaleLowerCase('en-US') === junctionPath.toLocaleLowerCase('en-US')
          ? 'C:\\Users\\seller\\Downloads\\XianyuOrderManager\\真实数据'
          : path
      ),
    })).toThrow('不能放在程序目录内');
  });

  it('macOS 拒绝应用包内部目录，允许应用包外的文档目录', () => {
    const executablePath = '/Applications/XianyuOrderManager.app/Contents/MacOS/XianyuOrderManager';

    expect(() => assertDataDirectoryOutsideProgram({
      dataDirectory: '/Applications/XianyuOrderManager.app/订单数据',
      executablePath,
      platform: 'darwin',
      canonicalizePath: (path) => path,
    })).toThrow('不能放在程序目录内');
    expect(() => assertDataDirectoryOutsideProgram({
      dataDirectory: '/Users/seller/Documents/闲鱼订单数据',
      executablePath,
      platform: 'darwin',
      canonicalizePath: (path) => path,
    })).not.toThrow();
  });

  it('解析符号链接后拒绝实际位于程序目录内的数据目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-portable-path-'));
    testRoots.push(root);
    const programDirectory = join(root, 'program');
    const programDataDirectory = join(programDirectory, '订单数据');
    const externalLink = join(root, 'documents-link');
    const executablePath = join(programDirectory, 'XianyuOrderManager');
    await mkdir(programDataDirectory, { recursive: true });
    await writeFile(executablePath, 'executable');
    await symlink(programDataDirectory, externalLink, 'dir');

    expect(() => assertDataDirectoryOutsideProgram({
      dataDirectory: externalLink,
      executablePath,
      platform: process.platform,
    })).toThrow('不能放在程序目录内');
  });
});
