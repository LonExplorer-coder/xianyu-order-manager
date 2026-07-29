import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { Preferences } from '../src/main/preferences';
import {
  selectedSourceScreenshotDirectory,
  sourceScreenshotDialogOptions,
} from '../src/main/source-screenshot-dialog';

describe('来源截图选择器目录记忆', () => {
  it('两个目录偏好可分别更新并在重启后保留，不会相互覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-source-directory-preferences-'));
    const configDirectory = join(root, '启动配置');
    const preferences = new Preferences(configDirectory);
    const dataDirectory = join(root, '订单数据');
    const sourceDirectory = join(root, '待上传截图');

    preferences.setLastDataDirectory(dataDirectory);
    preferences.setLastSourceScreenshotDirectory(sourceDirectory);

    const reopened = new Preferences(configDirectory);
    expect(reopened.getLastDataDirectory()).toBe(dataDirectory);
    expect(reopened.getLastSourceScreenshotDirectory()).toBe(sourceDirectory);

    reopened.setLastDataDirectory(join(root, '新订单数据'));
    expect(reopened.getLastSourceScreenshotDirectory()).toBe(sourceDirectory);
  });

  it('仅把仍然存在的目录作为下次打开位置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-source-dialog-options-'));
    const sourceDirectory = join(root, '待上传截图');
    const filePath = join(root, '不是目录.png');
    await mkdir(sourceDirectory);
    await writeFile(filePath, 'synthetic');

    expect(sourceScreenshotDialogOptions(sourceDirectory)).toMatchObject({
      defaultPath: sourceDirectory,
      properties: ['openFile'],
    });
    expect(sourceScreenshotDialogOptions(filePath)).not.toHaveProperty('defaultPath');
    expect(sourceScreenshotDialogOptions(join(root, '已不存在'))).not.toHaveProperty(
      'defaultPath',
    );
  });

  it('成功选图后记录父目录，取消时不产生新目录', () => {
    expect(selectedSourceScreenshotDirectory({
      canceled: false,
      filePaths: ['/safe/orders/order.png'],
    })).toBe('/safe/orders');
    expect(selectedSourceScreenshotDirectory({ canceled: true, filePaths: [] })).toBeUndefined();
  });
});
