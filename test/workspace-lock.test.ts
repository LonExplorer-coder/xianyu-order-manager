import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { RecognitionResult } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';
import { WorkspaceInUseError } from '../src/main/workspace';

const applications: LocalApplication[] = [];
const unusedRecognition: RecognitionResult = {
  platform: 'xianyu',
  sellerAccount: '默认闲鱼账号',
  orderNumber: 'unused',
  alipayTransactionNumber: '',
  buyerNickname: '',
  recipient: 'unused',
  phone: 'unused',
  phoneNormalized: '',
  addressOriginal: 'unused',
  addressNormalized: 'unused',
  province: '',
  city: '',
  district: '',
  orderedAtOriginal: '',
  orderedAtNormalized: '',
  paidAtOriginal: '',
  paidAtNormalized: '',
  productTotalCents: 0,
  shippingFeeCents: 0,
  amountCents: 0,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  items: [],
};

afterEach(() => {
  for (const application of applications.splice(0)) {
    application.close();
  }
});

describe('数据目录单写实例', () => {
  it('阻止第二个实例写入同一目录，并在首个实例退出后允许重新打开', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-writer-lock-'));
    const recognizer = new ControlledRecognizer(unusedRecognition);
    const first = new LocalApplication(recognizer);
    const second = new LocalApplication(recognizer);
    applications.push(first, second);

    first.openDataDirectory(dataDirectory);
    expect(() => second.openDataDirectory(dataDirectory)).toThrowError(WorkspaceInUseError);

    first.close();
    expect(() => second.openDataDirectory(dataDirectory)).not.toThrow();
  });
});
