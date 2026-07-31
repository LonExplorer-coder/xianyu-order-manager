import { describe, expect, it, vi } from 'vitest';

import { BailianOcrClient } from '../src/adapters/recognition/bailian-ocr-client';
import type { CandidateAdjudicator } from '../src/core/candidate-verification';

type LocatedWord = {
  text: string;
  location: [number, number, number, number, number, number, number, number];
  rotate_rect: [number, number, number, number, number];
};

function locatedWord(
  text: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
): LocatedWord {
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

function successfulOcrResponse(
  ocrResult: Record<string, unknown>,
  requestId = 'request-six-region-layout',
): Response {
  return new Response(JSON.stringify({
    output: {
      choices: [{
        finish_reason: 'stop',
        message: { content: [{ ocr_result: ocrResult }] },
      }],
    },
    request_id: requestId,
  }), { status: 200 });
}

function advancedRecognitionResponse(wordsInfo: LocatedWord[]): Response {
  return successfulOcrResponse({ words_info: wordsInfo });
}

function recognitionInput() {
  return {
    workspaceId: 'ws-test123',
    region: 'cn-beijing' as const,
    apiKey: 'sk-six-region-sentinel',
    sellerAccount: '默认闲鱼账号',
    source: {
      absolutePath: '/private/synthetic-six-region.png',
      originalName: '合成六区订单.png',
      mimeType: 'image/png',
      sha256: 'synthetic-six-region',
      bytes: Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAKUlEQVR4nO3OIQEAAAACIP+f1hkWWEB6FgEBAQEBAQEBAQEBAQEBgXdgl/rw4unIZ5cAAAAASUVORK5CYII=',
        'base64',
      )),
    },
  };
}

function semanticClient(
  request: ConstructorParameters<typeof BailianOcrClient>[0],
): BailianOcrClient {
  return new BailianOcrClient(request);
}

function ocrTask(init?: RequestInit): string | undefined {
  const body = JSON.parse(String(init?.body)) as {
    parameters?: { ocr_options?: { task?: string } };
  };
  return body.parameters?.ocr_options?.task;
}

function rawOnlyRequest(words: LocatedWord[]) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (ocrTask(init) !== 'advanced_recognition') {
      throw new Error('生产六区不得调用结构化 KIE');
    }
    return advancedRecognitionResponse(words);
  });
}

function completeLocatedWords(): LocatedWord[] {
  return [
    locatedWord('买家已付款，请尽快发货', 40, 180, 720, 235),
    locatedWord('合成收件人 13900000001 复制', 50, 330, 620, 365),
    locatedWord('测试省测试市示例区安全路1号', 50, 380, 720, 425),
    locatedWord('合成真实商品 ¥6.00', 250, 540, 740, 580),
    locatedWord('款式：白色 ×2', 250, 600, 650, 635),
    locatedWord('成交价 ¥12.00', 50, 740, 740, 780),
    locatedWord('商品总价 ¥12.00', 70, 800, 740, 835),
    locatedWord('运费 ¥0.00', 70, 850, 740, 885),
    locatedWord('订单编号 XY-SYNTH-SIX-0001 复制', 50, 950, 740, 990),
    locatedWord('交易快照', 50, 1_015, 220, 1_050),
    locatedWord('支付宝交易号 ALI-SYNTH-SIX-0001 复制', 50, 1_075, 740, 1_115),
    locatedWord('买家昵称 合***家', 50, 1_135, 740, 1_175),
    locatedWord('下单时间 2026-07-31 13:02:00', 50, 1_195, 740, 1_235),
    locatedWord('付款时间 2026-07-31 13:02:08', 50, 1_255, 740, 1_295),
    locatedWord('图书周边免费送', 50, 1_390, 740, 1_450),
    locatedWord('推广商品 还能卖 ¥265.67', 50, 1_520, 740, 1_575),
    locatedWord('联系买家', 40, 1_820, 210, 1_870),
    locatedWord('取消订单', 340, 1_820, 520, 1_870),
    locatedWord('去发货', 620, 1_820, 760, 1_870),
  ];
}

function collapsedLocatedWords(): LocatedWord[] {
  return [
    locatedWord('买家已付款，请尽快发货', 40, 180, 720, 235),
    locatedWord('折叠收件人13800000000复制去发货', 50, 330, 740, 365),
    locatedWord('广东省深圳市南山区安全路2号', 50, 380, 720, 425),
    locatedWord('折叠真实商品 ¥8.00', 250, 540, 740, 580),
    locatedWord('款式：黑色', 250, 600, 650, 635),
    locatedWord('成交价 ¥8.00', 50, 740, 740, 780),
    locatedWord('商品总价 ¥8.00', 70, 800, 740, 835),
    locatedWord('运费 ¥0.00', 70, 850, 740, 885),
    locatedWord('订单编号 XY-COLLAPSED-0001 复制', 50, 950, 740, 990),
    locatedWord('买家昵称 推***广', 50, 1_160, 740, 1_205),
    locatedWord('推广商品 还能卖 ¥199.00', 50, 1_260, 740, 1_310),
    locatedWord('联系买家', 40, 1_620, 210, 1_670),
    locatedWord('取消订单', 340, 1_620, 520, 1_670),
    locatedWord('去发货', 620, 1_620, 760, 1_670),
  ];
}

describe('闲鱼订单六区识别', () => {
  it('启用六区后百炼连接测试仍只调用一次固定测试图片', async () => {
    const request = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'OK' },
      }],
    }), { status: 200 }));
    const client = semanticClient(request);

    await expect(client.testConnection({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-six-region-sentinel',
    })).resolves.toEqual({ model: 'qwen3.5-ocr' });

    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as {
      messages?: Array<{ content?: Array<{ image_url?: { url?: string } }> }>;
      parameters?: unknown;
    };
    expect(body.messages?.[0]?.content?.[0]?.image_url?.url)
      .toMatch(/^data:image\/png;base64,/u);
    expect(body.parameters).toBeUndefined();
  });

  it('生产六区只用一次识别原文恢复完整订单', async () => {
    const input = recognitionInput();
    const request = rawOnlyRequest(completeLocatedWords());
    const client = semanticClient(request);

    const attempt = await client.recognizeOrder(input);

    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-SIX-0001',
      alipayTransactionNumber: 'ALI-SYNTH-SIX-0001',
      buyerNickname: '合***家',
      recipient: '合成收件人',
      phone: '13900000001',
      addressOriginal: '测试省测试市示例区安全路1号',
      amountCents: 1_200,
      productTotalCents: 1_200,
      shippingFeeCents: 0,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [{
        sourceTitle: '合成真实商品',
        sourceSpec: '白色',
        unitPriceCents: 600,
        quantity: 2,
        quantityInferred: false,
      }],
    });
    expect(attempt.evidences).toHaveLength(1);
    expect(attempt.evidences[0].rawResponse).toContain('words_info');
    expect(attempt.reviewIssues).toEqual([]);
    expect(attempt.recognitionConflicts).toEqual([]);
    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as {
      input?: { messages?: Array<{ content?: Array<{ image?: string }> }> };
      parameters?: { ocr_options?: { task?: string; task_config?: unknown } };
    };
    expect(body.input?.messages?.[0]?.content?.[0]?.image)
      .toBe(`data:image/png;base64,${Buffer.from(input.source.bytes).toString('base64')}`);
    expect(body.parameters?.ocr_options).toEqual({ task: 'advanced_recognition' });
  });

  it('行政区划只从识别原文中的完整地址拆分，不会生成楼盘名称中的江城区', async () => {
    const address = '四川省成都市锦江区狮子山街道安全路1号滨江樾城10栋';
    const words = completeLocatedWords().flatMap((word) =>
      word.text === '测试省测试市示例区安全路1号'
        ? [
            locatedWord('四川省成都市锦江区狮子山街道安全路1号滨', 50, 380, 720, 410),
            locatedWord('江樾城10栋', 50, 415, 320, 445),
          ]
        : [word]
    );
    const request = rawOnlyRequest(words);

    const attempt = await semanticClient(request).recognizeOrder(recognitionInput());

    expect(attempt.result).toMatchObject({
      addressOriginal: address,
      province: '四川省',
      city: '成都市',
      district: '锦江区',
    });
    expect(JSON.stringify(attempt.result)).not.toContain('江城区');
    expect(request).toHaveBeenCalledOnce();
  });

  it('地址省略省份时只保留识别原文可确定的市和区县', async () => {
    const address = '成都市锦江区狮子山街道安全路1号江城区广场';
    const words = completeLocatedWords().map((word) =>
      word.text === '测试省测试市示例区安全路1号'
        ? { ...word, text: address }
        : word
    );

    const attempt = await semanticClient(rawOnlyRequest(words))
      .recognizeOrder(recognitionInput());

    expect(attempt.result).toMatchObject({
      province: '',
      city: '成都市',
      district: '锦江区',
    });
  });

  it('折叠详情不把推广内容识别成买家昵称或商品', async () => {
    const request = rawOnlyRequest(collapsedLocatedWords());

    const attempt = await semanticClient(request).recognizeOrder(recognitionInput());

    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-COLLAPSED-0001',
      alipayTransactionNumber: '',
      buyerNickname: '',
      recipient: '折叠收件人',
      phone: '13800000000',
      addressOriginal: '广东省深圳市南山区安全路2号',
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [{
        sourceTitle: '折叠真实商品',
        sourceSpec: '黑色',
        unitPriceCents: 800,
        quantity: 1,
        quantityInferred: true,
      }],
    });
    expect(attempt.result.items).toHaveLength(1);
    expect(JSON.stringify(attempt.result)).not.toContain('推广');
    expect(request).toHaveBeenCalledOnce();
  });

  it('收货区出现多个不同手机号时不猜测联系人或手机号', async () => {
    const words = [
      ...completeLocatedWords().map((word) =>
        word.text === '测试省测试市示例区安全路1号'
          ? locatedWord(word.text, 50, 420, 720, 455)
          : word
      ),
      locatedWord('备用联系人 13700000002', 50, 370, 620, 405),
    ];

    const attempt = await semanticClient(rawOnlyRequest(words))
      .recognizeOrder(recognitionInput());

    expect(attempt.result.recipient).toBe('');
    expect(attempt.result.phone).toBe('');
    expect(attempt.reviewIssues).toEqual(['screenshot_content_incomplete']);
    expect(attempt.recognitionConflicts).toContainEqual(expect.objectContaining({
      region: 'shipping_information',
      field: 'phone',
      kind: 'multiple_candidates',
      locatedValues: expect.arrayContaining(['13900000001', '13700000002']),
      extractedValues: [],
      retainedValue: null,
    }));
  });

  it('启用候选裁决后一次文本调用只能选择本机预绑定的平台状态候选', async () => {
    const words = [
      ...completeLocatedWords(),
      locatedWord('交易已取消', 40, 245, 300, 280),
    ];
    const request = rawOnlyRequest(words);
    const adjudicate = vi.fn<CandidateAdjudicator['adjudicate']>(
      async (candidateSets) => {
        const platformStatus = candidateSets.find(
          ({ ambiguityId }) => ambiguityId === 'xianyu:platform_status:transaction_status',
        );
        const selected = platformStatus?.candidates.find(
          ({ displayText }) => displayText === '已取消',
        );
        return {
          status: 'completed',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          requestId: 'request-candidate-selection',
          decisions: [{
            ambiguityId: platformStatus?.ambiguityId ?? '',
            resolution: 'selected',
            candidateId: selected?.candidateId ?? '',
          }],
        };
      },
    );
    const adjudicator = {
      adjudicate,
      testConnection: vi.fn(),
    } as unknown as CandidateAdjudicator;

    const attempt = await semanticClient(request).recognizeOrder({
      ...recognitionInput(),
      candidateAdjudicator: adjudicator,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(adjudicate).toHaveBeenCalledOnce();
    expect(attempt.result.platformTransactionStatus).toBe('cancelled');
    expect(attempt.recognitionConflicts).not.toContainEqual(
      expect.objectContaining({
        region: 'platform_status',
        field: 'platform_status',
        kind: 'multiple_candidates',
      }),
    );
    expect(attempt.candidateAdjudication).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'succeeded',
      decisions: [{
        ambiguityId: 'xianyu:platform_status:transaction_status',
        selectedCandidateId: expect.stringContaining('cancelled'),
        outcome: 'selected',
      }],
    });
  });

  it('超出调用边界的歧义不发送模型但会与其他裁决一起留下逐项失败记录', async () => {
    const words = completeLocatedWords().flatMap((entry) => (
      entry.text === '合成真实商品 ¥6.00'
        ? [
            locatedWord(`未知标签：${'长'.repeat(2_001)}`, 250, 500, 740, 530),
            locatedWord('尾部商品 ¥6.00', 250, 540, 740, 580),
          ]
        : [entry]
    ));
    words.push(locatedWord('交易已取消', 40, 245, 300, 280));
    const request = rawOnlyRequest(words);
    const adjudicate = vi.fn<CandidateAdjudicator['adjudicate']>(async (candidateSets) => {
      expect(candidateSets).toHaveLength(1);
      expect(candidateSets[0]?.ambiguityId).toBe(
        'xianyu:platform_status:transaction_status',
      );
      return {
        status: 'completed',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        decisions: [{
          ambiguityId: candidateSets[0]!.ambiguityId,
          resolution: 'unresolved',
        }],
      };
    });
    const adjudicator = {
      provider: 'deepseek' as const,
      model: 'deepseek-v4-flash',
      adjudicate,
      testConnection: vi.fn(),
    } as unknown as CandidateAdjudicator;

    const attempt = await semanticClient(request).recognizeOrder({
      ...recognitionInput(),
      candidateAdjudicator: adjudicator,
    });

    expect(adjudicate).toHaveBeenCalledOnce();
    expect(attempt.candidateAdjudication).toMatchObject({
      status: 'partial',
      decisions: [{
        ambiguityId: 'xianyu:platform_status:transaction_status',
        outcome: 'unresolved',
      }, {
        ambiguityId: 'xianyu:purchased_items:item_title:0',
        outcome: 'invalid',
        failureCode: 'invalid_request',
      }],
    });
    expect(attempt.candidateAdjudication).not.toHaveProperty('rawResponse');
  });

  it('全部歧义都超出调用边界时不调用模型且 OCR 结果和拒绝审计仍可用', async () => {
    const words = completeLocatedWords().flatMap((entry) => (
      entry.text === '合成真实商品 ¥6.00'
        ? [
            locatedWord(`未知标签：${'长'.repeat(2_001)}`, 250, 500, 740, 530),
            locatedWord('尾部商品 ¥6.00', 250, 540, 740, 580),
          ]
        : [entry]
    ));
    const request = rawOnlyRequest(words);
    const adjudicate = vi.fn<CandidateAdjudicator['adjudicate']>();
    const adjudicator = {
      provider: 'deepseek' as const,
      model: 'deepseek-v4-flash',
      adjudicate,
      testConnection: vi.fn(),
    } as unknown as CandidateAdjudicator;

    const attempt = await semanticClient(request).recognizeOrder({
      ...recognitionInput(),
      candidateAdjudicator: adjudicator,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(adjudicate).not.toHaveBeenCalled();
    expect(attempt.result.items).not.toHaveLength(0);
    expect(attempt.candidateAdjudication).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'rejected',
      failureCode: 'invalid_request',
      decisions: [{
        ambiguityId: 'xianyu:purchased_items:item_title:0',
        outcome: 'invalid',
        failureCode: 'invalid_request',
      }],
    });
  });

  it('候选裁决超时时保留规则结果和失败审计而不让 OCR 任务失败', async () => {
    const request = rawOnlyRequest([
      ...completeLocatedWords(),
      locatedWord('交易已取消', 40, 245, 300, 280),
    ]);
    const adjudicator = {
      adjudicate: vi.fn(async () => ({
        status: 'failed' as const,
        provider: 'deepseek' as const,
        model: 'deepseek-v4-flash',
        failure: {
          code: 'timeout' as const,
          message: '候选裁决请求超时',
        },
      })),
      testConnection: vi.fn(),
    } as unknown as CandidateAdjudicator;

    const attempt = await semanticClient(request).recognizeOrder({
      ...recognitionInput(),
      candidateAdjudicator: adjudicator,
    });

    expect(attempt.result.platformTransactionStatus).toBe('unknown');
    expect(attempt.reviewIssues).toEqual(['screenshot_content_incomplete']);
    expect(attempt.candidateAdjudication).toMatchObject({
      status: 'failed',
      failureCode: 'timeout',
      failureMessage: '候选裁决请求超时',
      decisions: [{ outcome: 'invalid', failureCode: 'timeout' }],
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('候选裁决实现直接抛错时仍保留 OCR 规则结果和失败审计', async () => {
    const request = rawOnlyRequest([
      ...completeLocatedWords(),
      locatedWord('交易已取消', 40, 245, 300, 280),
    ]);
    const adjudicator = {
      provider: 'deepseek' as const,
      model: 'deepseek-v4-flash',
      adjudicate: vi.fn(async () => {
        throw new Error('候选服务适配器异常');
      }),
      testConnection: vi.fn(),
    } as unknown as CandidateAdjudicator;

    const recognition = semanticClient(request).recognizeOrder({
      ...recognitionInput(),
      candidateAdjudicator: adjudicator,
    });

    await expect(recognition).resolves.toMatchObject({
      result: { platformTransactionStatus: 'unknown' },
      reviewIssues: ['screenshot_content_incomplete'],
      candidateAdjudication: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        status: 'failed',
        failureCode: 'remote_error',
        decisions: [{ outcome: 'invalid', failureCode: 'remote_error' }],
      },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('缺少六区锚点时只保留识别原文并进入待确认', async () => {
    const words = completeLocatedWords().filter((word) =>
      !['联系买家', '取消订单', '去发货'].includes(word.text)
    );
    const request = rawOnlyRequest(words);

    const attempt = await semanticClient(request).recognizeOrder(recognitionInput());

    expect(attempt.result.orderNumber).toBe('');
    expect(attempt.result.items).toEqual([]);
    expect(attempt.reviewIssues).toEqual(['screenshot_content_incomplete']);
    expect(attempt.evidences).toHaveLength(1);
    expect(attempt.evidences[0].rawResponse).toContain('XY-SYNTH-SIX-0001');
    expect(request).toHaveBeenCalledOnce();
  });

  it('获取识别原文失败时不回退结构化 KIE', async () => {
    const request = vi.fn(async () => {
      throw new Error('synthetic advanced recognition failure');
    });

    await expect(
      semanticClient(request).recognizeOrder(recognitionInput()),
    ).rejects.toThrow('无法连接百炼服务，请检查网络后重试');
    expect(request).toHaveBeenCalledOnce();
  });

  it('多商品按商品区顺序恢复款式、单价和显式数量', async () => {
    const words = [
      locatedWord('买家已付款，请尽快发货', 40, 180, 720, 235),
      locatedWord('多品收件人 13600000003 复制', 50, 330, 620, 365),
      locatedWord('浙江省杭州市西湖区测试路3号', 50, 380, 720, 425),
      locatedWord('商品甲 ¥6.00', 250, 520, 740, 560),
      locatedWord('商品乙 ¥10.00', 250, 650, 740, 690),
      locatedWord('规格：大号 ×3', 250, 710, 650, 745),
      locatedWord('成交价 ¥36.00', 50, 830, 740, 870),
      locatedWord('商品总价 ¥36.00', 70, 890, 740, 925),
      locatedWord('运费 ¥0.00', 70, 940, 740, 975),
      locatedWord('订单编号 XY-MULTI-ITEM-0001 复制', 50, 1_040, 740, 1_080),
      locatedWord('联系买家', 40, 1_520, 210, 1_570),
      locatedWord('取消订单', 340, 1_520, 520, 1_570),
      locatedWord('去发货', 620, 1_520, 760, 1_570),
    ];
    const request = rawOnlyRequest(words);

    const attempt = await semanticClient(request).recognizeOrder(recognitionInput());

    expect(attempt.result.items).toEqual([
      {
        sourceTitle: '商品甲',
        sourceSpec: '',
        unitPriceCents: 600,
        quantity: 1,
        quantityInferred: true,
      },
      {
        sourceTitle: '商品乙',
        sourceSpec: '大号',
        unitPriceCents: 1_000,
        quantity: 3,
        quantityInferred: false,
      },
    ]);
    expect(attempt.result.productTotalCents).toBe(3_600);
    expect(attempt.reviewIssues).toEqual([]);
    expect(request).toHaveBeenCalledOnce();
  });

  it('商品标题换行且价格位于下一行时保留完整标题', async () => {
    const words = completeLocatedWords().flatMap((word) => {
      if (word.text === '合成真实商品 ¥6.00') {
        return [
          locatedWord('超长商品标题第一段', 250, 515, 650, 550),
          locatedWord('第二段 ¥6.00', 250, 555, 740, 590),
          locatedWord('颜色：红色', 250, 638, 500, 655),
          locatedWord('第二件商品 ¥10.00', 250, 660, 740, 700),
        ];
      }
      if (word.text === '成交价 ¥12.00') {
        return [{ ...word, text: '成交价 ¥22.00' }];
      }
      if (word.text === '商品总价 ¥12.00') {
        return [{ ...word, text: '商品总价 ¥22.00' }];
      }
      return [word];
    });

    const attempt = await semanticClient(rawOnlyRequest(words))
      .recognizeOrder(recognitionInput());

    expect(attempt.result.items).toEqual([
      {
        sourceTitle: '超长商品标题第一段第二段',
        sourceSpec: '白色',
        unitPriceCents: 600,
        quantity: 2,
        quantityInferred: false,
      },
      {
        sourceTitle: '第二件商品',
        sourceSpec: '',
        unitPriceCents: 1_000,
        quantity: 1,
        quantityInferred: true,
      },
    ]);
    expect(attempt.reviewIssues).toEqual([]);
  });

  it('未知键值式文字可能是跨行标题时不静默截断商品名', async () => {
    const words = completeLocatedWords().flatMap((word) => {
      if (word.text === '合成真实商品 ¥6.00') {
        return [
          locatedWord('商品甲 ¥6.00', 250, 520, 740, 560),
          locatedWord('苹果：iPhone 15', 250, 660, 650, 695),
          locatedWord('Pro ¥10.00', 250, 700, 740, 735),
        ];
      }
      if (word.text === '成交价 ¥12.00') {
        return [{ ...word, text: '成交价 ¥22.00' }];
      }
      if (word.text === '商品总价 ¥12.00') {
        return [{ ...word, text: '商品总价 ¥22.00' }];
      }
      return [word];
    });

    const attempt = await semanticClient(rawOnlyRequest(words))
      .recognizeOrder(recognitionInput());

    expect(attempt.result.items).toEqual([
      expect.objectContaining({ sourceTitle: '商品甲' }),
      expect.objectContaining({ sourceTitle: '' }),
    ]);
    expect(attempt.reviewIssues).toEqual(['screenshot_content_incomplete']);
  });

  it('识别原文中的已发货文字恢复平台已付款和履约已发货', async () => {
    const words = completeLocatedWords().map((word) => {
      if (word.text === '买家已付款，请尽快发货') {
        return { ...word, text: '卖家已发货，等待买家确认收货' };
      }
      if (word.text === '去发货') return { ...word, text: '查看物流' };
      return word;
    });

    const attempt = await semanticClient(rawOnlyRequest(words))
      .recognizeOrder(recognitionInput());

    expect(attempt.result.platformTransactionStatus).toBe('paid');
    expect(attempt.result.fulfillmentStatus).toBe('shipped');
    expect(attempt.reviewIssues).toEqual([]);
  });

  it('已付款但没有待发货或已发货依据时进入待确认', async () => {
    const words = completeLocatedWords().filter((word) => word.text !== '去发货');

    const attempt = await semanticClient(rawOnlyRequest(words))
      .recognizeOrder(recognitionInput());

    expect(attempt.result.platformTransactionStatus).toBe('paid');
    expect(attempt.result.fulfillmentStatus).toBe('unknown');
    expect(attempt.reviewIssues).toEqual(['screenshot_content_incomplete']);
  });

  it('退款订单没有履约依据时不因履约未知重复进入待确认', async () => {
    const words = completeLocatedWords()
      .filter((word) => word.text !== '去发货')
      .map((word) => word.text === '买家已付款，请尽快发货'
        ? { ...word, text: '退款成功' }
        : word);

    const attempt = await semanticClient(rawOnlyRequest(words))
      .recognizeOrder(recognitionInput());

    expect(attempt.result.platformTransactionStatus).toBe('refunded');
    expect(attempt.result.fulfillmentStatus).toBe('unknown');
    expect(attempt.reviewIssues).toEqual([]);
  });

  it('识别原文中的平台状态存在冲突时不根据去发货反推已付款', async () => {
    const words = [
      ...completeLocatedWords(),
      locatedWord('交易已取消', 40, 245, 300, 280),
    ];

    const attempt = await semanticClient(rawOnlyRequest(words))
      .recognizeOrder(recognitionInput());

    expect(attempt.result.platformTransactionStatus).toBe('unknown');
    expect(attempt.result.fulfillmentStatus).toBe('pending_shipment');
    expect(attempt.reviewIssues).toEqual(['screenshot_content_incomplete']);
    expect(attempt.recognitionConflicts).toContainEqual(expect.objectContaining({
      region: 'platform_status',
      field: 'platform_status',
      kind: 'multiple_candidates',
      locatedValues: expect.arrayContaining([
        '买家已付款，请尽快发货',
        '交易已取消',
      ]),
      extractedValues: [],
      retainedValue: null,
    }));
  });

  it('识别原文同一行被拆成多个词块时仍能划分六区', async () => {
    const words = [
      locatedWord('买家已', 40, 180, 190, 235),
      locatedWord('付款，请尽快发货', 200, 180, 720, 235),
      locatedWord('合成收件人', 50, 330, 230, 365),
      locatedWord('13900000001', 245, 330, 460, 365),
      locatedWord('复制', 480, 330, 550, 365),
      locatedWord('测试省测试市示例区安全路1号', 50, 380, 720, 425),
      locatedWord('合成真实商品', 250, 540, 560, 580),
      locatedWord('¥6.00', 650, 540, 740, 580),
      locatedWord('款式：', 250, 600, 360, 635),
      locatedWord('白色', 370, 600, 450, 635),
      locatedWord('×2', 560, 600, 650, 635),
      locatedWord('成交', 50, 740, 150, 780),
      locatedWord('价', 155, 740, 190, 780),
      locatedWord('¥12.00', 650, 740, 740, 780),
      locatedWord('商品', 70, 800, 150, 835),
      locatedWord('总价', 155, 800, 230, 835),
      locatedWord('¥12.00', 650, 800, 740, 835),
      locatedWord('运费', 70, 850, 150, 885),
      locatedWord('¥0.00', 650, 850, 740, 885),
      locatedWord('订单', 50, 950, 130, 990),
      locatedWord('编号', 135, 950, 215, 990),
      locatedWord('XY-SYNTH-SIX-0001', 300, 950, 680, 990),
      locatedWord('复制', 690, 950, 740, 990),
      locatedWord('交易快照', 50, 1_015, 220, 1_050),
      locatedWord('支付宝交易号', 50, 1_075, 260, 1_115),
      locatedWord('ALI-SYNTH-SIX-0001', 300, 1_075, 740, 1_115),
      locatedWord('买家昵称', 50, 1_135, 220, 1_175),
      locatedWord('合***家', 300, 1_135, 740, 1_175),
      locatedWord('下单时间', 50, 1_195, 220, 1_235),
      locatedWord('2026-07-31 13:02:00', 300, 1_195, 740, 1_235),
      locatedWord('付款时间', 50, 1_255, 220, 1_295),
      locatedWord('2026-07-31 13:02:08', 300, 1_255, 740, 1_295),
      locatedWord('推广商品 还能卖 ¥265.67', 50, 1_520, 740, 1_575),
      locatedWord('联系买家', 40, 1_820, 210, 1_870),
      locatedWord('取消订单', 340, 1_820, 520, 1_870),
      locatedWord('去发货', 620, 1_820, 760, 1_870),
    ];
    const request = rawOnlyRequest(words);

    const attempt = await semanticClient(request).recognizeOrder(recognitionInput());

    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-SIX-0001',
      alipayTransactionNumber: 'ALI-SYNTH-SIX-0001',
      buyerNickname: '合***家',
      recipient: '合成收件人',
      phone: '13900000001',
      productTotalCents: 1_200,
      shippingFeeCents: 0,
      amountCents: 1_200,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [{
        sourceTitle: '合成真实商品',
        sourceSpec: '白色',
        unitPriceCents: 600,
        quantity: 2,
        quantityInferred: false,
      }],
    });
    expect(attempt.reviewIssues).toEqual([]);
    expect(request).toHaveBeenCalledOnce();
  });
});
