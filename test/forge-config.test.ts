import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import forgeConfig from '../forge.config';

describe('Forge 打包配置', () => {
  it('Windows 便携版完成打包后记录全部顶层文件', async () => {
    const programDirectory = await mkdtemp(join(tmpdir(), 'xianyu-forge-complete-'));
    await writeFile(join(programDirectory, 'XianyuOrderManager.exe'), 'exe');
    await writeFile(join(programDirectory, 'LICENSE'), 'license');

    const hooks = forgeConfig.packagerConfig?.afterComplete;
    expect(hooks).toHaveLength(1);
    await new Promise<void>((resolve, reject) => {
      hooks?.[0](
        programDirectory,
        '43.2.0',
        'win32',
        'x64',
        (error) => error ? reject(error) : resolve(),
      );
    });

    const marker = JSON.parse(await readFile(
      join(programDirectory, '.xianyu-portable-program.json'),
      'utf8',
    ));
    expect(marker).toEqual({
      schemaVersion: 1,
      product: 'xianyu-order-manager',
      topLevelEntries: [
        '.xianyu-portable-program.json',
        'LICENSE',
        'XianyuOrderManager.exe',
      ],
    });
  });
});
