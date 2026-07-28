import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import { LocalApplication } from '../src/main/local-application';
import { WorkspaceInUseError } from '../src/main/workspace';

const applications: LocalApplication[] = [];

afterEach(() => {
  for (const application of applications.splice(0)) {
    application.close();
  }
});

describe('数据目录单写实例', () => {
  it('阻止第二个实例写入同一目录，并在首个实例退出后允许重新打开', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-writer-lock-'));
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
    const first = new LocalApplication(recognizer);
    const second = new LocalApplication(recognizer);
    applications.push(first, second);

    first.openDataDirectory(dataDirectory);
    expect(() => second.openDataDirectory(dataDirectory)).toThrowError(WorkspaceInUseError);

    first.close();
    expect(() => second.openDataDirectory(dataDirectory)).not.toThrow();
  });
});
