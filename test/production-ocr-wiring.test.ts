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
  it('把生产目录安全校验接入新选目录和恢复流程', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-production-directory-policy-'));
    const dataDirectory = join(testRoot, '订单数据');
    const validateDataDirectory = vi.fn((selectedDirectory: string) => {
      if (selectedDirectory === dataDirectory) {
        throw new Error('数据目录安全校验拒绝');
      }
    });
    const session = createConfiguredDesktopSession({
      configDirectory: join(testRoot, '应用配置'),
      apiKeyStore: new MemoryApiKeyStore(),
      validateDataDirectory,
    });
    sessions.push(session);

    expect(session.useDataDirectory(dataDirectory)).toEqual({
      kind: 'error',
      message: '数据目录安全校验拒绝',
    });
    expect(validateDataDirectory).toHaveBeenCalledWith(dataDirectory);
  });

  it('保存百炼配置后，上传截图使用真实识别适配器而不是演示订单', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-production-ocr-'));
    const uploadDirectory = join(testRoot, '待上传');
    await mkdir(uploadDirectory, { recursive: true });
    const sourcePath = join(uploadDirectory, '真实订单.png');
    await writeFile(
      sourcePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAKUlEQVR4nO3OIQEAAAACIP+f1hkWWEB6FgEBAQEBAQEBAQEBAQEBgXdgl/rw4unIZ5cAAAAASUVORK5CYII=',
        'base64',
      ),
    );

    const request = vi.fn(async (_input: string, init?: RequestInit): Promise<Response> => {
      const requestBody = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      const advancedRecognition =
        requestBody.parameters?.ocr_options?.task === 'advanced_recognition';
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
                        ...(advancedRecognition
                          ? {
                              words_info: productionLocatedWords(),
                            }
                          : {
                              kv_result: {
                                platform_status: {
                                  top_status_text: '买家已付款，请尽快发货',
                                },
                                shipping_information: {
                                  recipient: '真实收件人',
                                  recipient_phone_line_text: '真实收件人 13800000000',
                                  phone: '13800000000',
                                  address: '广东省深圳市南山区真实路1号',
                                  province: '广东省',
                                  city: '深圳市',
                                  district: '南山区',
                                  controls: ['复制'],
                                },
                                purchased_items: {
                                  items: [{
                                    title: '真实识别商品',
                                    spec: '白色',
                                    unit_price: '8.00',
                                    quantity: null,
                                  }],
                                  controls: [],
                                },
                                amount_summary: {
                                  product_total: '8.00',
                                  shipping_fee: '0.00',
                                  amount: '8.00',
                                },
                                order_details: {
                                  detail_state: 'expanded',
                                  order_number: 'REAL-OCR-20260729-001',
                                  alipay_transaction_number: '2026072900000000000001',
                                  buyer_nickname_label: '买家昵称',
                                  buyer_nickname: '真实买家',
                                  order_time: '2026-07-29 09:01:02',
                                  payment_time: '2026-07-29 09:01:03',
                                  controls: ['复制', '交易快照'],
                                },
                              },
                            }),
                      },
                    },
                  ],
                },
              },
            ],
          },
          request_id: advancedRecognition
            ? 'request-production-layout'
            : 'request-production-wiring',
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
      fulfillmentStatus: 'pending_shipment',
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
    const [url, firstInit] = request.mock.calls[0];
    expect(url).toContain('ws-production-test.cn-beijing.maas.aliyuncs.com');
    expect(new Headers(firstInit?.headers).get('authorization')).toBe(
      'Bearer sk-production-wiring-sentinel',
    );
    const tasks = request.mock.calls.map(([, requestInit]) => {
      const body = JSON.parse(String(requestInit?.body)) as {
        input?: {
          messages?: Array<{ content?: Array<{ image?: string }> }>;
        };
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task;
    });
    expect(tasks).toEqual(['advanced_recognition']);
    const images = request.mock.calls.map(([, requestInit]) => {
      const body = JSON.parse(String(requestInit?.body)) as {
        input?: {
          messages?: Array<{ content?: Array<{ image?: string }> }>;
        };
      };
      return body.input?.messages?.[0]?.content?.[0]?.image;
    });
    expect(images[0]).toMatch(/^data:image\/png;base64,/u);
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

  it('独立保存 DeepSeek 候选裁决配置且不会串用 OCR 凭据', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-candidate-settings-wiring-'));
    const ocrApiKeyStore = new MemoryApiKeyStore();
    ocrApiKeyStore.apiKey = 'sk-ocr-only';
    const deepseekStore = new MemoryApiKeyStore();
    const bailianVerifierStore = new MemoryApiKeyStore();
    const compatibleStore = new MemoryApiKeyStore();
    const session = createConfiguredDesktopSession({
      configDirectory: join(testRoot, '应用配置'),
      apiKeyStore: ocrApiKeyStore,
      candidateVerificationApiKeyStores: {
        deepseek: deepseekStore,
        'aliyun-bailian': bailianVerifierStore,
        'openai-compatible': compatibleStore,
      },
    });
    sessions.push(session);

    await expect(session.getCandidateVerificationSettings()).resolves.toMatchObject({
      enabled: false,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKeyConfigured: false,
    });

    const saved = await session.saveCandidateVerificationSettings({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-deepseek-only',
    });

    expect(saved).toMatchObject({ enabled: true, apiKeyConfigured: true });
    expect(deepseekStore.apiKey).toBe('sk-deepseek-only');
    expect(ocrApiKeyStore.apiKey).toBe('sk-ocr-only');
    expect(bailianVerifierStore.apiKey).toBeNull();
    expect(compatibleStore.apiKey).toBeNull();
  });

  it('有有限歧义时使用已启用的 DeepSeek 一次裁决并保存审计', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-production-adjudication-'));
    const sourcePath = join(testRoot, '状态冲突订单.png');
    await writeFile(
      sourcePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAKUlEQVR4nO3OIQEAAAACIP+f1hkWWEB6FgEBAQEBAQEBAQEBAQEBgXdgl/rw4unIZ5cAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const request = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.startsWith('https://api.deepseek.com/')) {
        const body = JSON.parse(String(init?.body)) as {
          messages?: Array<{ role?: string; content?: string }>;
        };
        const user = body.messages?.find(({ role }) => role === 'user');
        const payload = JSON.parse(user?.content ?? '{}') as {
          candidateSets?: Array<{
            ambiguityId: string;
            candidates: Array<{ candidateId: string; displayText: string }>;
          }>;
        };
        const decisions = (payload.candidateSets ?? []).map((candidateSet) => ({
          ambiguityId: candidateSet.ambiguityId,
          resolution: 'selected',
          candidateId: candidateSet.candidates.find(
            ({ displayText }) => displayText === '已取消',
          )?.candidateId,
        }));
        return new Response(JSON.stringify({
          id: 'deepseek-adjudication-request',
          choices: [{
            message: { content: JSON.stringify({ decisions }) },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        output: {
          choices: [{
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: [{
                ocr_result: {
                  words_info: [
                    ...productionLocatedWords(),
                    productionWord('交易已取消', 40, 245, 300, 280),
                  ],
                },
              }],
            },
          }],
        },
        request_id: 'request-production-adjudication-ocr',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const deepseekStore = new MemoryApiKeyStore();
    const session = createConfiguredDesktopSession({
      configDirectory: join(testRoot, '应用配置'),
      apiKeyStore: new MemoryApiKeyStore(),
      candidateVerificationApiKeyStores: {
        deepseek: deepseekStore,
        'aliyun-bailian': new MemoryApiKeyStore(),
        'openai-compatible': new MemoryApiKeyStore(),
      },
      request,
    });
    sessions.push(session);
    await session.saveOcrSettings({
      workspaceId: 'ws-production-adjudication',
      region: 'cn-beijing',
      apiKey: 'sk-production-ocr',
    });
    await session.saveCandidateVerificationSettings({
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-production-deepseek',
    });
    session.useDataDirectory(join(testRoot, '订单数据'));

    await session.submitSourceScreenshots([sourcePath]);
    await eventually(() => {
      expect(session.listRecognitionBatches()[0].items[0].status)
        .toBe('awaiting_confirmation');
    });
    const item = session.listRecognitionBatches()[0].items[0];
    const draft = session.getDraft(item.draftId!);

    expect(draft.platformTransactionStatus).toBe('cancelled');
    const audits = session.getCandidateAdjudicationAudit(draft.id);
    expect(audits).toMatchObject([{
      id: expect.any(String),
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'succeeded',
    }]);
    expect(audits[0]).not.toHaveProperty('requestId');
    expect(request).toHaveBeenCalledTimes(2);
    const verifierCall = request.mock.calls.find(([url]) =>
      url.startsWith('https://api.deepseek.com/')
    );
    expect(String(verifierCall?.[1]?.body)).not.toContain('data:image');
    expect(new Headers(verifierCall?.[1]?.headers).get('authorization'))
      .toBe('Bearer sk-production-deepseek');
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

function productionWord(
  text: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
) {
  return {
    text,
    location: [left, top, right, top, right, bottom, left, bottom],
    rotate_rect: [
      Math.round((left + right) / 2),
      Math.round((top + bottom) / 2),
      right - left,
      bottom - top,
      0,
    ],
  };
}

function productionLocatedWords() {
  const word = (
    text: string,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ) => productionWord(text, left, top, right, bottom);
  return [
    word('买家已付款，请尽快发货', 40, 180, 720, 235),
    word('真实收件人 13800000000 复制', 50, 330, 620, 365),
    word('广东省深圳市南山区真实路1号', 50, 380, 720, 425),
    word('真实识别商品 ¥8.00', 250, 540, 740, 580),
    word('款式：白色', 250, 600, 650, 635),
    word('成交价 ¥8.00', 50, 740, 740, 780),
    word('商品总价 ¥8.00', 70, 800, 740, 835),
    word('运费 ¥0.00', 70, 850, 740, 885),
    word('订单编号 REAL-OCR-20260729-001 复制', 50, 950, 740, 990),
    word('交易快照', 50, 1_015, 220, 1_050),
    word('支付宝交易号 2026072900000000000001 复制', 50, 1_075, 740, 1_115),
    word('买家昵称 真实买家', 50, 1_135, 740, 1_175),
    word('下单时间 2026-07-29 09:01:02', 50, 1_195, 740, 1_235),
    word('付款时间 2026-07-29 09:01:03', 50, 1_255, 740, 1_295),
    word('联系买家', 40, 1_620, 210, 1_670),
    word('取消订单', 340, 1_620, 520, 1_670),
    word('去发货', 620, 1_620, 760, 1_670),
  ];
}
