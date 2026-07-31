import { describe, expect, it, vi } from 'vitest';

import { BailianOcrClient } from '../src/adapters/recognition/bailian-ocr-client';

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

function advancedRecognitionResponse(wordsInfo: LocatedWord[]): Response {
  return successfulOcrResponse({ words_info: wordsInfo }, 'request-six-region-layout');
}

function keyInformationResponse(
  kvResult: Record<string, unknown>,
  processedText?: string,
): Response {
  return successfulOcrResponse({
    kv_result: kvResult,
    ...(processedText === undefined ? {} : { processed_text: processedText }),
  }, 'request-six-region-kie');
}

function successfulOcrResponse(
  ocrResult: Record<string, unknown>,
  requestId: string,
): Response {
  return new Response(JSON.stringify({
    output: {
      choices: [{
        finish_reason: 'stop',
        message: {
          content: [{ ocr_result: ocrResult }],
        },
      }],
    },
    request_id: requestId,
  }), { status: 200 });
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
      bytes: Uint8Array.from([137, 80, 78, 71]),
    },
  };
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

function completeSixRegionResult(): Record<string, unknown> {
  return {
    platform_status: {
      top_status_text: '买家已付款，请尽快发货',
    },
    shipping_information: {
      recipient: '合成收件人',
      recipient_phone_line_text: '合成收件人 13900000001',
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      controls: ['复制'],
    },
    purchased_items: {
      items: [{
        title: '合成真实商品',
        spec: '白色',
        unit_price: '6.00',
        quantity: 2,
        quantity_text: '×2',
      }],
      controls: [],
    },
    amount_summary: {
      product_total: '12.00',
      shipping_fee: '0.00',
      amount: '12.00',
    },
    order_details: {
      detail_state: 'expanded',
      order_number: 'XY-SYNTH-SIX-0001',
      alipay_transaction_number: 'ALI-SYNTH-SIX-0001',
      buyer_nickname_label: '买家昵称',
      buyer_nickname: '合***家',
      order_time: '2026-07-31 13:02:00',
      payment_time: '2026-07-31 13:02:08',
      controls: ['复制', '交易快照'],
    },
    fulfillment_signals: {
      global_controls: ['联系买家', '取消订单', '去发货'],
    },
  };
}

describe('闲鱼订单六区识别', () => {
  it('启用六区后百炼连接测试仍只调用一次固定测试图片', async () => {
    const request = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'OK' },
      }],
    }), { status: 200 }));
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

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

  it('只保留商品区的已购商品并排除订单详情后的推广', async () => {
    const words = completeLocatedWords();

    const sixRegionResult = {
      ...completeSixRegionResult(),
      purchased_items: {
        items: [
          {
            title: '合成真实商品',
            spec: '白色',
            unit_price: '6.00',
            quantity: 2,
            quantity_text: '×2',
          },
          {
            title: '推广商品',
            spec: '还能卖',
            unit_price: '265.67',
            quantity: 1,
          },
        ],
        controls: [],
      },
    };

    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(words)
        : keyInformationResponse(sixRegionResult);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-SIX-0001',
      alipayTransactionNumber: 'ALI-SYNTH-SIX-0001',
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
    expect(attempt.evidences).toHaveLength(2);
    expect(attempt.reviewIssues).toContain('targeted_review_conflict');
    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1]?.[1]?.body)) as {
      input?: { messages?: Array<{ content?: Array<{ text?: string }> }> };
      parameters?: {
        ocr_options?: {
          task_config?: { result_schema?: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters?.ocr_options?.task_config?.result_schema ?? {},
    )).toEqual([
      'platform_status',
      'shipping_information',
      'purchased_items',
      'amount_summary',
      'order_details',
      'fulfillment_signals',
    ]);
    expect(secondBody.input?.messages?.[0]?.content?.[1]?.text)
      .toContain('排除区（订单详情之后、底部履约按钮之前）: y=');
  });

  it('用各区域的定位文字补回 KIE 漏掉的关键字段', async () => {
    const sparseResult = {
      platform_status: { top_status_text: null },
      shipping_information: {
        recipient: null,
        recipient_phone_line_text: null,
        phone: null,
        address: null,
        province: null,
        city: null,
        district: null,
        controls: [],
      },
      purchased_items: {
        items: [{
          title: '合成真实商品',
          spec: null,
          unit_price: null,
          quantity: null,
          quantity_text: null,
        }],
        controls: [],
      },
      amount_summary: {
        product_total: null,
        shipping_fee: null,
        amount: null,
      },
      order_details: {
        detail_state: 'expanded',
        order_number: null,
        alipay_transaction_number: null,
        buyer_nickname_label: null,
        buyer_nickname: null,
        order_time: null,
        payment_time: null,
        controls: [],
      },
      fulfillment_signals: { global_controls: [] },
    };
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(completeLocatedWords())
        : keyInformationResponse(sparseResult);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-SIX-0001',
      alipayTransactionNumber: 'ALI-SYNTH-SIX-0001',
      buyerNickname: '合***家',
      recipient: '合成收件人',
      phone: '13900000001',
      addressOriginal: '测试省测试市示例区安全路1号',
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
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('折叠详情只保留订单号，不从后续推广伪造买家昵称或商品', async () => {
    const foldedResult = {
      platform_status: { top_status_text: '买家已付款，请尽快发货' },
      shipping_information: {
        recipient: '折叠收件人13800000000复制去发货',
        recipient_phone_line_text: null,
        phone: null,
        address: '广东省深圳市南山区安全路2号',
        controls: ['复制', '去发货'],
      },
      purchased_items: {
        items: [
          { title: '折叠真实商品', spec: '黑色', unit_price: '8.00', quantity: null },
          { title: '推广商品', spec: '还能卖', unit_price: '199.00', quantity: 1 },
        ],
        controls: [],
      },
      amount_summary: { product_total: '8.00', shipping_fee: '0.00', amount: '8.00' },
      order_details: {
        detail_state: 'collapsed',
        order_number: 'XY-COLLAPSED-0001',
        alipay_transaction_number: null,
        buyer_nickname_label: '买家昵称',
        buyer_nickname: '推***广',
        order_time: null,
        payment_time: null,
        controls: ['复制'],
      },
      fulfillment_signals: { global_controls: ['联系买家', '取消订单', '去发货'] },
    };
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(collapsedLocatedWords())
        : keyInformationResponse(foldedResult);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

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
    expect(attempt.reviewIssues).toContain('targeted_review_conflict');
  });

  it('收货区出现多个不同手机号时不猜测联系人或手机号', async () => {
    const words = [
      ...completeLocatedWords(),
      locatedWord('备用联系人 13700000002', 50, 350, 620, 375),
    ];
    const selectedPhoneResult = {
      ...completeSixRegionResult(),
      shipping_information: {
        recipient: '合成收件人',
        recipient_phone_line_text: '合成收件人 13900000001',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        controls: ['复制'],
      },
    };
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(words)
        : keyInformationResponse(selectedPhoneResult);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result.recipient).toBe('');
    expect(attempt.result.phone).toBe('');
    expect(attempt.reviewIssues).toContain('targeted_review_conflict');
    expect(attempt.reviewIssues).toContain('screenshot_content_incomplete');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('定位证据与关键结构化值冲突时采用区内证据并阻止静默入库', async () => {
    const conflictingResult = {
      platform_status: { top_status_text: '买家已付款，请尽快发货' },
      shipping_information: {
        recipient: '合成收件人',
        recipient_phone_line_text: '合成收件人 13800000009',
        phone: '13800000009',
        address: '测试省测试市示例区安全路1号',
        controls: ['复制'],
      },
      purchased_items: {
        items: [{ title: '合成真实商品', spec: '白色', unit_price: '6.00', quantity: 2 }],
        controls: [],
      },
      amount_summary: { product_total: '12.00', shipping_fee: '0.00', amount: '99.00' },
      order_details: {
        detail_state: 'expanded',
        order_number: 'XY-CONFLICT-9999',
        alipay_transaction_number: 'ALI-SYNTH-SIX-0001',
        buyer_nickname_label: '买家昵称',
        buyer_nickname: '合***家',
        order_time: '2026-07-31 13:02:00',
        payment_time: '2026-07-31 13:02:08',
        controls: ['复制', '交易快照'],
      },
      fulfillment_signals: { global_controls: ['联系买家', '取消订单', '去发货'] },
    };
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(completeLocatedWords())
        : keyInformationResponse(conflictingResult);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-SIX-0001',
      phone: '13900000001',
      amountCents: 1_200,
    });
    expect(attempt.reviewIssues).toContain('targeted_review_conflict');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('订单号与支付宝交易号被 KIE 对调时按各自标签纠正并待确认', async () => {
    const result = completeSixRegionResult();
    result.order_details = {
      ...(result.order_details as Record<string, unknown>),
      order_number: 'ALI-SYNTH-SIX-0001',
      alipay_transaction_number: 'XY-SYNTH-SIX-0001',
    };
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(completeLocatedWords())
        : keyInformationResponse(result);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result.orderNumber).toBe('XY-SYNTH-SIX-0001');
    expect(attempt.result.alipayTransactionNumber).toBe('ALI-SYNTH-SIX-0001');
    expect(attempt.reviewIssues).toContain('targeted_review_conflict');
  });

  it('区域金额被 KIE 对调时按成交价、商品总价和运费标签纠正并待确认', async () => {
    const words = completeLocatedWords().map((word) => {
      if (word.text === '合成真实商品 ¥6.00') {
        return { ...word, text: '合成真实商品 ¥5.00' };
      }
      if (word.text === '成交价 ¥12.00') return word;
      if (word.text === '商品总价 ¥12.00') {
        return { ...word, text: '商品总价 ¥10.00' };
      }
      if (word.text === '运费 ¥0.00') return { ...word, text: '运费 ¥2.00' };
      return word;
    });
    const result = completeSixRegionResult();
    result.purchased_items = {
      items: [{
        title: '合成真实商品',
        spec: '白色',
        unit_price: '5.00',
        quantity: 2,
        quantity_text: '×2',
      }],
      controls: [],
    };
    result.amount_summary = {
      product_total: '10.00',
      shipping_fee: '12.00',
      amount: '2.00',
    };
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(words)
        : keyInformationResponse(result);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result.productTotalCents).toBe(1_000);
    expect(attempt.result.shippingFeeCents).toBe(200);
    expect(attempt.result.amountCents).toBe(1_200);
    expect(attempt.reviewIssues).toContain('targeted_review_conflict');
  });

  it('缺少区域锚点时第二次回退整图提取并强制人工确认', async () => {
    const incompleteWords = completeLocatedWords().filter((word) =>
      !['联系买家', '取消订单', '去发货'].includes(word.text)
    );
    const legacyResult = {
      order_number: 'XY-SYNTH-SIX-0001',
      alipay_transaction_number: 'ALI-SYNTH-SIX-0001',
      buyer_nickname_label: '买家昵称',
      buyer_nickname: '合***家',
      recipient: '合成收件人',
      recipient_phone_line_text: '合成收件人 13900000001',
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      order_time: '2026-07-31 13:02:00',
      payment_time: '2026-07-31 13:02:08',
      product_total: '12.00',
      shipping_fee: '0.00',
      amount: '12.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{
        title: '合成真实商品',
        spec: '白色',
        unit_price: '6.00',
        quantity: 2,
      }],
    };
    const requestedSchemas: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: {
          ocr_options?: {
            task?: string;
            task_config?: { result_schema?: Record<string, unknown> };
          };
        };
      };
      const task = body.parameters?.ocr_options?.task;
      if (task === 'advanced_recognition') {
        return advancedRecognitionResponse(incompleteWords);
      }
      requestedSchemas.push(
        body.parameters?.ocr_options?.task_config?.result_schema ?? {},
      );
      return keyInformationResponse(legacyResult);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result.orderNumber).toBe('XY-SYNTH-SIX-0001');
    expect(attempt.reviewIssues).toContain('screenshot_content_incomplete');
    expect(request).toHaveBeenCalledTimes(2);
    expect(requestedSchemas[0]).toHaveProperty('transaction_information');
    expect(requestedSchemas[0]).not.toHaveProperty('amount_summary');
  });

  it('六区 KIE 正文字段漏单号时可从同模块 processed_text 补回', async () => {
    const words = completeLocatedWords().map((word) =>
      word.text.startsWith('订单编号')
        ? locatedWord('订单编号 复制', 50, 950, 740, 990)
        : word
    );
    const sparseResult = {
      platform_status: { top_status_text: null },
      shipping_information: {
        recipient: null,
        recipient_phone_line_text: null,
        phone: null,
        address: null,
        controls: [],
      },
      purchased_items: {
        items: [{ title: '合成真实商品', spec: null, unit_price: null, quantity: null }],
        controls: [],
      },
      amount_summary: { product_total: null, shipping_fee: null, amount: null },
      order_details: {
        detail_state: 'expanded',
        order_number: null,
        alipay_transaction_number: null,
        buyer_nickname_label: null,
        buyer_nickname: null,
        order_time: null,
        payment_time: null,
        controls: [],
      },
      fulfillment_signals: { global_controls: [] },
    };
    const processedText = '```json\n' + JSON.stringify({
      order_details: { order_number: 'XY-PROCESSED-0001' },
    }) + '\n```';
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(words)
        : keyInformationResponse(sparseResult, processedText);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result.orderNumber).toBe('XY-PROCESSED-0001');
    expect(attempt.reviewIssues).toContain('targeted_review_conflict');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('六区 KIE 请求失败时保留定位结果供人工校对且不发起第三次请求', async () => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(completeLocatedWords())
        : new Response('upstream unavailable', { status: 503 });
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-SIX-0001',
      recipient: '合成收件人',
      phone: '13900000001',
      amountCents: 1_200,
      items: [{
        sourceTitle: '合成真实商品',
        sourceSpec: '白色',
        unitPriceCents: 600,
        quantity: 2,
        quantityInferred: false,
      }],
    });
    expect(attempt.evidences).toHaveLength(1);
    expect(attempt.reviewIssues).toContain('targeted_review_failed');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('坐标定位请求失败时只回退一次整图提取并强制人工确认', async () => {
    const fallbackResult = {
      purchased_items: {
        items: [{
          title: '合成真实商品',
          spec: '白色',
          unit_price: '6.00',
          quantity: 2,
        }],
        controls: [],
      },
      shipping_information: {
        recipient: '合成收件人',
        recipient_phone_line_text: '合成收件人 13900000001',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        controls: ['复制'],
      },
      transaction_information: {
        detail_state: 'expanded',
        order_number: 'XY-SYNTH-SIX-0001',
        alipay_transaction_number: 'ALI-SYNTH-SIX-0001',
        product_total: '12.00',
        shipping_fee: '0.00',
        amount: '12.00',
        buyer_nickname_label: '买家昵称',
        buyer_nickname: '合***家',
        order_time: '2026-07-31 13:02:00',
        payment_time: '2026-07-31 13:02:08',
        controls: ['复制', '交易快照'],
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家', '取消订单', '去发货'],
        excluded_regions: [],
      },
    };
    let call = 0;
    const request = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('synthetic layout failure');
      return keyInformationResponse(fallbackResult);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-SIX-0001',
      recipient: '合成收件人',
      phone: '13900000001',
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
    });
    expect(attempt.evidences).toHaveLength(1);
    expect(attempt.reviewIssues).toContain('targeted_review_failed');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('多商品按商品区顺序分别补回款式、单价和显式数量', async () => {
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
    const sparseResult = {
      platform_status: { top_status_text: null },
      shipping_information: {
        recipient: null,
        recipient_phone_line_text: null,
        phone: null,
        address: null,
        controls: [],
      },
      purchased_items: {
        items: [
          { title: '商品甲', spec: null, unit_price: null, quantity: 4 },
          { title: '商品乙', spec: null, unit_price: null, quantity: null },
        ],
        controls: [],
      },
      amount_summary: { product_total: null, shipping_fee: null, amount: null },
      order_details: {
        detail_state: 'collapsed',
        order_number: null,
        alipay_transaction_number: null,
        buyer_nickname_label: null,
        buyer_nickname: null,
        order_time: null,
        payment_time: null,
        controls: [],
      },
      fulfillment_signals: { global_controls: [] },
    };
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(words)
        : keyInformationResponse(sparseResult);
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

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
    expect(attempt.reviewIssues).toContain('targeted_review_conflict');
  });

  it('平台状态证据冲突时不根据去发货反推已付款', async () => {
    const words = [
      ...completeLocatedWords(),
      locatedWord('交易已取消', 40, 245, 300, 280),
    ];
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: { ocr_options?: { task?: string } };
      };
      return body.parameters?.ocr_options?.task === 'advanced_recognition'
        ? advancedRecognitionResponse(words)
        : keyInformationResponse(completeSixRegionResult());
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(attempt.result.platformTransactionStatus).toBe('unknown');
    expect(attempt.result.fulfillmentStatus).toBe('pending_shipment');
    expect(attempt.reviewIssues).toContain('targeted_review_conflict');
    expect(attempt.reviewIssues).toContain('screenshot_content_incomplete');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('定位文字被拆成同一行多个词块时仍能划分六区', async () => {
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
    const requestedSchemas: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        parameters?: {
          ocr_options?: {
            task?: string;
            task_config?: { result_schema?: Record<string, unknown> };
          };
        };
      };
      if (body.parameters?.ocr_options?.task === 'advanced_recognition') {
        return advancedRecognitionResponse(words);
      }
      requestedSchemas.push(
        body.parameters?.ocr_options?.task_config?.result_schema ?? {},
      );
      return keyInformationResponse({});
    });
    const client = new BailianOcrClient(request, { semanticRegionsEnabled: true });

    const attempt = await client.recognizeOrder(recognitionInput());

    expect(requestedSchemas[0]).toHaveProperty('amount_summary');
    expect(requestedSchemas[0]).toHaveProperty('fulfillment_signals');
    expect(requestedSchemas[0]).not.toHaveProperty('transaction_information');
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
  });
});
