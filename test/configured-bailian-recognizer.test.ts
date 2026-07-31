import { describe, expect, it, vi } from 'vitest';

import type { BailianOcrClient } from '../src/adapters/recognition/bailian-ocr-client';
import { ConfiguredBailianRecognizer } from '../src/adapters/recognition/configured-bailian-recognizer';
import type { RecognitionAttempt, RecognizerSource } from '../src/core/contracts';

const source: RecognizerSource = {
  absolutePath: '/private/synthetic-order.png',
  originalName: 'synthetic-order.png',
  mimeType: 'image/png',
  sha256: 'synthetic-source',
  bytes: Uint8Array.of(1, 2, 3),
};

const attempt: RecognitionAttempt = {
  result: {
    platform: 'xianyu',
    sellerAccount: '默认闲鱼账号',
    orderNumber: 'XY-CONFIG-FALLBACK-1',
    alipayTransactionNumber: '',
    buyerNickname: '',
    recipient: '测试收件人',
    phone: '13800000000',
    phoneNormalized: '13800000000',
    addressOriginal: '广东省深圳市南山区测试路1号',
    addressNormalized: '广东省深圳市南山区测试路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '',
    orderedAtNormalized: '',
    paidAtOriginal: '',
    paidAtNormalized: '',
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '测试商品',
      sourceSpec: '',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: true,
    }],
  },
  evidences: [{
    provider: 'aliyun-bailian',
    model: 'qwen3.5-ocr',
    requestId: 'ocr-request',
    schemaVersion: 1,
    rawResponse: '{}',
  }],
};

function client() {
  return {
    recognizeOrder: vi.fn(async () => attempt),
  } as unknown as BailianOcrClient;
}

const credentials = {
  workspaceId: 'workspace-test',
  region: 'cn-beijing' as const,
  apiKey: 'sk-ocr-only',
};

describe('可选候选裁决失败隔离', () => {
  it('候选配置或凭据读取失败时仍继续主 OCR', async () => {
    const ocrClient = client();
    const recognizer = new ConfiguredBailianRecognizer(
      { getRecognitionCredentials: async () => credentials },
      ocrClient,
      '默认闲鱼账号',
      { getRuntimeConfig: async () => { throw new Error('凭据库不可用'); } },
      vi.fn(),
    );

    await expect(recognizer.recognize(source)).resolves.toEqual(attempt);
    expect(ocrClient.recognizeOrder).toHaveBeenCalledWith({
      ...credentials,
      sellerAccount: '默认闲鱼账号',
      source,
    });
  });

  it('候选客户端构造失败时仍继续主 OCR', async () => {
    const ocrClient = client();
    const recognizer = new ConfiguredBailianRecognizer(
      { getRecognitionCredentials: async () => credentials },
      ocrClient,
      '默认闲鱼账号',
      {
        getRuntimeConfig: async () => ({
          provider: 'openai-compatible',
          baseUrl: 'https://models.example.com/v1',
          model: 'verifier',
          apiKey: 'sk-verifier',
        }),
      },
      () => { throw new Error('构造失败'); },
    );

    await expect(recognizer.recognize(source)).resolves.toEqual(attempt);
    expect(ocrClient.recognizeOrder).toHaveBeenCalledWith({
      ...credentials,
      sellerAccount: '默认闲鱼账号',
      source,
    });
  });
});
