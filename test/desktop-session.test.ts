import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import { DesktopSession } from '../src/main/desktop-session';
import { Preferences } from '../src/main/preferences';

const sessions: DesktopSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
});

describe('桌面启动状态', () => {
  it('首次要求选择数据目录，并在重启后自动打开最近目录', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-desktop-session-'));
    const preferences = new Preferences(join(testRoot, '启动配置'));
    const dataDirectory = join(testRoot, '订单数据');
    const recognizer = new ControlledRecognizer({
      platform: 'xianyu',
      sellerAccount: '默认闲鱼账号',
      orderNumber: 'unused',
      buyerNickname: '',
      recipient: 'unused',
      phone: 'unused',
      addressOriginal: 'unused',
      amountCents: 0,
      items: [],
    });

    const first = new DesktopSession(preferences, recognizer);
    sessions.push(first);
    expect(first.restore()).toEqual({ kind: 'needs_data_directory' });
    expect(first.useDataDirectory(dataDirectory)).toMatchObject({
      kind: 'ready',
      dataDirectory,
      orders: [],
    });
    first.close();
    sessions.splice(sessions.indexOf(first), 1);

    const reopened = new DesktopSession(preferences, recognizer);
    sessions.push(reopened);
    expect(reopened.restore()).toMatchObject({
      kind: 'ready',
      dataDirectory,
      orders: [],
    });
  });

  it('启动遇到短暂错误后可重新打开记住的数据目录', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-desktop-retry-'));
    const preferences = new Preferences(join(testRoot, '启动配置'));
    const dataDirectory = join(testRoot, '订单数据');
    const recognizer = new ControlledRecognizer({
      platform: 'xianyu',
      sellerAccount: '默认闲鱼账号',
      orderNumber: 'unused',
      buyerNickname: '',
      recipient: 'unused',
      phone: 'unused',
      addressOriginal: 'unused',
      amountCents: 0,
      items: [],
    });

    preferences.setLastDataDirectory(dataDirectory);
    await writeFile(dataDirectory, '暂时占位');

    const session = new DesktopSession(preferences, recognizer);
    sessions.push(session);
    expect(session.restore()).toMatchObject({ kind: 'error' });

    await unlink(dataDirectory);
    await mkdir(dataDirectory);
    expect(session.retryDataDirectory()).toMatchObject({
      kind: 'ready',
      dataDirectory,
      orders: [],
    });
  });
});
