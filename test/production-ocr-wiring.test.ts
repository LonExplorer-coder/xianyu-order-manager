import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiKeyStore } from '../src/main/ocr-settings';
import { createConfiguredDesktopSession } from '../src/main/production-session';
import type { DesktopSession } from '../src/main/desktop-session';

class MemoryApiKeyStore implements ApiKeyStore {
  public apiKey: string | null = null;

  public async getApiKey(): Promise<string | null> {
    return this.apiKey;
  }

  public async setApiKey(apiKey: string): Promise<void> {
    this.apiKey = apiKey;
  }

  public async deleteApiKey(): Promise<void> {
    this.apiKey = null;
  }

  public getDisplayName(): string {
    return '测试系统凭据库';
  }
}

const sessions: DesktopSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
});

describe('正式 OCR 装配', () => {
  it('保存百炼配置后，上传截图使用真实识别适配器而不是演示订单', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-production-ocr-'));
    const uploadDirectory = join(testRoot, '待上传');
    await mkdir(uploadDirectory, { recursive: true });
    const sourcePath = join(uploadDirectory, '真实订单.png');
    await writeFile(
      sourcePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );

    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      return new Response(
        JSON.stringify({
          output: {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: [
                    {
                      ocr_result: {
                        kv_result: {
                          order_number: 'REAL-OCR-20260729-001',
                          alipay_transaction_number: '2026072900000000000001',
                          buyer_nickname: '真实买家',
                          recipient: '真实收件人',
                          phone: '13800000000',
                          address: '广东省深圳市南山区真实路1号',
                          province: '广东省',
                          city: '深圳市',
                          district: '南山区',
                          order_time: '2026-07-29 09:01:02',
                          payment_time: '2026-07-29 09:01:03',
                          product_total: '8.00',
                          shipping_fee: '0.00',
                          amount: '8.00',
                          platform_transaction_status: 'paid',
                          fulfillment_status: 'pending_shipment',
                          items: [
                            {
                              title: '真实识别商品',
                              spec: '白色',
                              unit_price: '8.00',
                              quantity: null,
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
          request_id: 'request-production-wiring',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const apiKeyStore = new MemoryApiKeyStore();
    const session = createConfiguredDesktopSession({
      configDirectory: join(testRoot, '应用配置'),
      apiKeyStore,
      request,
    });
    sessions.push(session);

    await session.saveOcrSettings({
      workspaceId: 'ws-production-test',
      region: 'cn-beijing',
      apiKey: 'sk-production-wiring-sentinel',
    });
    session.useDataDirectory(join(testRoot, '订单数据'));

    const batch = await session.submitSourceScreenshots([sourcePath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0].items[0].status)
        .toBe('awaiting_confirmation');
    });
    const item = session.listRecognitionBatches()[0].items[0];
    const draft = session.getDraft(item.draftId!);

    expect(draft).toMatchObject({
      orderNumber: 'REAL-OCR-20260729-001',
      alipayTransactionNumber: '2026072900000000000001',
      amountCents: 800,
      items: [
        expect.objectContaining({
          sourceTitle: '真实识别商品',
          quantity: 1,
          quantityInferred: true,
        }),
      ],
    });
    expect(draft.orderNumber).not.toContain('DEMO');
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toContain('ws-production-test.cn-beijing.maas.aliyuncs.com');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer sk-production-wiring-sentinel',
    );
  });

  it('没有保存 OCR 配置时在付费请求前明确阻止上传识别', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-production-ocr-missing-'));
    const sourcePath = join(testRoot, '订单.png');
    await writeFile(
      sourcePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      throw new Error('不应调用');
    });
    const session = createConfiguredDesktopSession({
      configDirectory: join(testRoot, '应用配置'),
      apiKeyStore: new MemoryApiKeyStore(),
      request,
    });
    sessions.push(session);
    session.useDataDirectory(join(testRoot, '订单数据'));

    await session.submitSourceScreenshots([sourcePath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0].items[0]).toMatchObject({
        status: 'failed',
        errorMessage: '请先在设置中保存百炼 OCR 配置和 API Key',
      });
    });
    expect(request).not.toHaveBeenCalled();
  });
});

async function eventually(assertion: () => void): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  assertion();
}
