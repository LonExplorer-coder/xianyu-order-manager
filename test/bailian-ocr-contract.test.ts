import { describe, expect, it, vi } from 'vitest';

import { BailianOcrClient } from '../src/adapters/recognition/bailian-ocr-client';

function successfulKieResponse(
  kvResult: Record<string, unknown>,
  requestId: string,
  processedText?: string,
): Response {
  return new Response(JSON.stringify({
    output: {
      choices: [{
        finish_reason: 'stop',
        message: {
          content: [{
            ocr_result: {
              kv_result: kvResult,
              ...(processedText === undefined ? {} : { processed_text: processedText }),
            },
          }],
        },
      }],
    },
    request_id: requestId,
  }), { status: 200 });
}

function fencedProcessedJson(value: Record<string, unknown>): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

type SyntheticStatusControl = string | { text?: string; label?: string };

function syntheticModularStatusExtraction(input: {
  pageHeaderStatusText?: string | null;
  shippingControls?: SyntheticStatusControl[];
  globalControls?: SyntheticStatusControl[];
  purchasedItemControls?: SyntheticStatusControl[];
  transactionControls?: SyntheticStatusControl[];
  alipayTransactionNumber?: string | null;
  platformTransactionStatus?: string | null;
  fulfillmentStatus?: string | null;
}): Record<string, unknown> {
  return {
    purchased_items: {
      items: [{
        title: '合成状态证据商品',
        spec: '规格S',
        unit_price: '31.00',
        quantity: '1',
        quantity_text: '×1',
      }],
      controls: input.purchasedItemControls ?? [],
    },
    shipping_information: {
      recipient: '合成收件人S',
      recipient_phone_line_text: '合成收件人S 13900000031',
      phone: '13900000031',
      address: '测试省测试市示例区安全路31号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      controls: input.shippingControls ?? [],
    },
    transaction_information: {
      detail_state: 'expanded',
      order_number: 'XY-SYNTH-STATUS-0001',
      alipay_transaction_number:
        input.alipayTransactionNumber === undefined
          ? 'ALI-SYNTH-STATUS-0001'
          : input.alipayTransactionNumber,
      buyer_nickname_label: '买家昵称',
      buyer_nickname: '合成买家S',
      order_time: '2026-07-30 08:31:00',
      payment_time: '2026-07-30 08:31:08',
      product_total: '31.00',
      shipping_fee: '0.00',
      amount: '31.00',
      platform_transaction_status:
        input.platformTransactionStatus === undefined
          ? null
          : input.platformTransactionStatus,
      fulfillment_status:
        input.fulfillmentStatus === undefined ? null : input.fulfillmentStatus,
      controls: input.transactionControls ?? [],
    },
    page_context: {
      ...(input.pageHeaderStatusText === undefined
        ? {}
        : { top_status_text: input.pageHeaderStatusText }),
      global_controls: input.globalControls ?? [],
      excluded_regions: [],
    },
  };
}

function syntheticModularPhoneFallbackExtraction(input: {
  kvPhone?: string;
} = {}): Record<string, unknown> {
  return {
    purchased_items: {
      items: [{
        title: '合成真实形态商品',
        spec: '规格R',
        unit_price: '39.00',
        quantity: '1',
        quantity_text: '×1',
      }],
      controls: [],
    },
    shipping_information: {
      recipient: '合成收件人R',
      ...(input.kvPhone === undefined ? {} : { phone: input.kvPhone }),
      address: '测试省测试市示例区安全路39号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      controls: ['复制', '去发货'],
    },
    transaction_information: {
      detail_state: 'expanded',
      order_number: 'XY-SYNTH-PROCESSED-PHONE-0001',
      alipay_transaction_number: 'ALI-SYNTH-PROCESSED-PHONE-0001',
      buyer_nickname_label: '买家昵称',
      buyer_nickname: '合成买家R',
      order_time: '2026-07-30 09:39:00',
      payment_time: '2026-07-30 09:39:08',
      product_total: '39.00',
      shipping_fee: '0.00',
      amount: '39.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      controls: [],
    },
    page_context: {
      top_status_text: '买家已付款，请尽快发货',
      global_controls: ['联系买家'],
      excluded_regions: [],
    },
  };
}

function syntheticStatusRecognitionInput(suffix: string) {
  return {
    workspaceId: 'ws-test123',
    region: 'cn-beijing' as const,
    apiKey: `sk-synthetic-status-${suffix}`,
    sellerAccount: '默认闲鱼账号',
    source: {
      absolutePath: `/private/synthetic-status-${suffix}.png`,
      originalName: `合成状态证据-${suffix}.png`,
      mimeType: 'image/png',
      sha256: `synthetic-status-${suffix}`,
      bytes: Uint8Array.from([1]),
    },
  };
}

describe('阿里云百炼 OCR 请求契约', () => {
  it('把真实闲鱼截图识别为可校对的多商品订单，并保留原始响应', async () => {
    const sentinelApiKey = 'sk-real-order-contract-sentinel';
    const sourceBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const rawResponse = JSON.stringify({
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
  "order_number": "XY-SYNTH-20260729-0001",
  "alipay_transaction_number": "ALI-SYNTH-20260729-0001",
  "buyer_nickname_label": "买家昵称",
  "buyer_nickname": "合成买家",
  "recipient": "合成收件人",
  "phone": "139 0000 0001",
  "address": "测试省 测试市 示例区 安全路1号",
  "province": "测试省",
  "city": "测试市",
  "district": "示例区",
  "order_time": "2026-07-27 11:21:46",
  "payment_time": "2026-07-27 11:21:54",
  "product_total": "18.00",
  "shipping_fee": "0.00",
  "amount": "18.00",
  "platform_transaction_status": "paid",
  "fulfillment_status": "pending_shipment",
  "items": [
    {
      "title": "合成测试商品甲",
      "spec": "规格A",
      "unit_price": "8.00",
      "quantity": null
    },
    {
      "title": "合成测试商品乙",
      "spec": "规格B",
      "unit_price": "10.00",
      "quantity": "1"
    }
  ]
                    }
                  }
                }
              ],
            },
          },
        ],
      },
      usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
      request_id: 'request-xianyu-order-1',
    });
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      return new Response(rawResponse, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: sentinelApiKey,
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/order.png',
        originalName: '订单.png',
        mimeType: 'image/png',
        sha256: 'fixed-sha256',
        bytes: sourceBytes,
      },
    });

    expect(attempt.result).toEqual({
      platform: 'xianyu',
      sellerAccount: '默认闲鱼账号',
      orderNumber: 'XY-SYNTH-20260729-0001',
      alipayTransactionNumber: 'ALI-SYNTH-20260729-0001',
      buyerNickname: '合成买家',
      recipient: '合成收件人',
      phone: '139 0000 0001',
      phoneNormalized: '13900000001',
      addressOriginal: '测试省 测试市 示例区 安全路1号',
      addressNormalized: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      orderedAtOriginal: '2026-07-27 11:21:46',
      orderedAtNormalized: '2026-07-27T11:21:46+08:00',
      paidAtOriginal: '2026-07-27 11:21:54',
      paidAtNormalized: '2026-07-27T11:21:54+08:00',
      productTotalCents: 1_800,
      shippingFeeCents: 0,
      amountCents: 1_800,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [
        {
          sourceTitle: '合成测试商品甲',
          sourceSpec: '规格A',
          unitPriceCents: 800,
          quantity: 1,
          quantityInferred: true,
        },
        {
          sourceTitle: '合成测试商品乙',
          sourceSpec: '规格B',
          unitPriceCents: 1_000,
          quantity: 1,
          quantityInferred: false,
        },
      ],
    });
    expect(attempt.evidences).toHaveLength(1);
    expect(attempt.evidences[0]).toEqual({
      provider: 'aliyun-bailian',
      model: 'qwen3.5-ocr',
      requestId: 'request-xianyu-order-1',
      schemaVersion: 1,
      rawResponse,
    });

    const [url, init] = request.mock.calls[0];
    expect(url).toBe(
      'https://ws-test123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input: {
        messages: Array<{
          content: Array<{
            image?: string;
            text?: string;
            min_pixels?: number;
            max_pixels?: number;
            enable_rotate?: boolean;
          }>;
        }>;
      };
      parameters: {
        ocr_options: {
          task: string;
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(body.model).toBe('qwen3.5-ocr');
    expect(body.input.messages[0].content[0].image).toBe(
      `data:image/png;base64,${Buffer.from(sourceBytes).toString('base64')}`,
    );
    expect(body.input.messages[0].content[0]).toMatchObject({
      min_pixels: 32 * 32 * 3,
      max_pixels: 32 * 32 * 8192,
      enable_rotate: false,
    });
    expect(body.input.messages[0].content[1]?.text).toContain(
      'recipient 只能填写收件人姓名',
    );
    expect(body.input.messages[0].content[1]?.text).toContain(
      '必须把手机号单独填写到 phone',
    );
    expect(body.input.messages[0].content[1]?.text).toContain(
      'controls 中的每一项只能是截图上可见的按钮文字字符串',
    );
    expect(body.input.messages[0].content[1]?.text).toContain(
      'recipient 不含手机号或按钮',
    );
    expect(body.input.messages[0].content[1]?.text).toContain('输出前自检');
    expect(init?.redirect).toBe('error');
    expect(body.parameters.ocr_options.task).toBe('key_information_extraction');
    expect(body.parameters.ocr_options.task_config.result_schema).toHaveProperty(
      'purchased_items.items',
    );
    expect(body.parameters.ocr_options.task_config.result_schema).toHaveProperty(
      'shipping_information.recipient',
    );
    expect(body.parameters.ocr_options.task_config.result_schema).toHaveProperty(
      'shipping_information.recipient_phone_line_text',
    );
    expect(body.parameters.ocr_options.task_config.result_schema).toHaveProperty(
      'transaction_information.buyer_nickname',
    );
    expect(body.parameters.ocr_options.task_config.result_schema).toHaveProperty(
      'page_context.global_controls',
    );
    expect(Object.keys(
      body.parameters.ocr_options.task_config.result_schema,
    )[0]).toBe('purchased_items');
    expect(body.parameters.ocr_options.task_config.result_schema).not.toHaveProperty(
      'page_header_status_text',
    );
    expect(body.parameters.ocr_options.task_config.result_schema).toHaveProperty(
      'page_context.top_status_text',
    );
    expect(body.parameters.ocr_options.task_config.result_schema).toHaveProperty(
      'transaction_information.platform_transaction_status',
    );
    expect(JSON.stringify(body.parameters.ocr_options.task_config.result_schema)).toContain(
      '绝不是收货联系人',
    );
    expect(JSON.stringify(body)).not.toContain(sentinelApiKey);
    expect(attempt.evidences[0].rawResponse).not.toContain(sentinelApiKey);
    expect(request).toHaveBeenCalledOnce();
  });

  it('把页面已付款待发货提示规范为待发货状态', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      order_number: 'XY-SYNTH-PENDING-SHIPMENT-0001',
      alipay_transaction_number: 'ALI-SYNTH-PENDING-SHIPMENT-0001',
      buyer_nickname_label: '买家昵称',
      buyer_nickname: '合成买家',
      recipient: '合成收件人',
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      order_time: '2026-07-30 00:01:00',
      payment_time: '2026-07-30 00:01:08',
      product_total: '8.00',
      shipping_fee: '0.00',
      amount: '8.00',
      platform_transaction_status: 'paid',
      fulfillment_status: '买家已付款，请尽快发货',
      items: [{
        title: '合成商品',
        spec: '规格A',
        unit_price: '8.00',
        quantity: '1',
      }],
    }, 'request-pending-shipment-text'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-pending-shipment',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-pending-shipment.png',
        originalName: '合成待发货订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-pending-shipment',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result.fulfillmentStatus).toBe('pending_shipment');
    expect(request).toHaveBeenCalledOnce();
  });

  it('扁平格式的完整收货信息不消耗额外复核调用', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      order_number: 'XY-SYNTH-FLAT-COMPLETE-SHIPPING-0001',
      alipay_transaction_number: 'ALI-SYNTH-FLAT-COMPLETE-SHIPPING-0001',
      buyer_nickname_label: '买家昵称',
      buyer_nickname: '合成买家平',
      recipient: '合成收件人平',
      phone: '13900000041',
      address: '测试省测试市示例区安全路41号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      order_time: '2026-07-30 10:41:00',
      payment_time: '2026-07-30 10:41:08',
      product_total: '41.00',
      shipping_fee: '0.00',
      amount: '41.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{
        title: '合成扁平完整订单商品',
        spec: '规格平',
        unit_price: '41.00',
        quantity: '1',
      }],
    }, 'request-flat-complete-shipping'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-flat-complete-shipping',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-flat-complete-shipping.png',
        originalName: '合成扁平完整收货订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-flat-complete-shipping',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(attempt.evidences).toHaveLength(1);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人平',
      phone: '13900000041',
      phoneNormalized: '13900000041',
    });
  });

  it('扁平业务完整但履约状态为空时只复核页面上下文并从底部按钮得到待发货', async () => {
    const primary = {
      order_number: 'XY-SYNTH-FLAT-FULFILLMENT-STATUS-0001',
      alipay_transaction_number: 'ALI-SYNTH-FLAT-FULFILLMENT-STATUS-0001',
      buyer_nickname_label: '买家昵称',
      buyer_nickname: '合成买家态',
      recipient: '合成收件人态',
      phone: '13900000044',
      address: '测试省测试市示例区安全路44号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      order_time: '2026-07-30 10:44:00',
      payment_time: '2026-07-30 10:44:08',
      product_total: '44.00',
      shipping_fee: '0.00',
      amount: '44.00',
      platform_transaction_status: 'paid',
      fulfillment_status: null,
      items: [{
        title: '合成扁平状态订单商品',
        spec: '规格态',
        unit_price: '44.00',
        quantity: '1',
      }],
    };
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse(
      request.mock.calls.length === 1
        ? primary
        : {
            page_context: {
              top_status_text: null,
              global_controls: ['去发货'],
              excluded_regions: [],
            },
          },
      'request-flat-fulfillment-status-' + request.mock.calls.length,
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('flat-fulfillment-status-only'),
    );

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['page_context']);
    expect(attempt.result).toMatchObject({
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
    });
  });

  it('扁平业务完整但平台与履约状态均空时只复核页面上下文并恢复已付款待发货', async () => {
    const primary = {
      order_number: 'XY-SYNTH-FLAT-BOTH-STATUSES-0001',
      alipay_transaction_number: 'ALI-SYNTH-FLAT-BOTH-STATUSES-0001',
      buyer_nickname_label: '买家昵称',
      buyer_nickname: '合成买家态',
      recipient: '合成收件人态',
      phone: '13900000045',
      address: '测试省测试市示例区安全路45号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      order_time: '2026-07-30 10:45:00',
      payment_time: '2026-07-30 10:45:08',
      product_total: '45.00',
      shipping_fee: '0.00',
      amount: '45.00',
      platform_transaction_status: null,
      fulfillment_status: null,
      items: [{
        title: '合成扁平双状态订单商品',
        spec: '规格双态',
        unit_price: '45.00',
        quantity: '1',
      }],
    };
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse(
      request.mock.calls.length === 1
        ? primary
        : {
            page_context: {
              top_status_text: '买家已付款，请尽快发货',
              global_controls: ['去发货'],
              excluded_regions: [],
            },
          },
      'request-flat-both-statuses-' + request.mock.calls.length,
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('flat-both-statuses-only'),
    );

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['page_context']);
    expect(attempt.result).toMatchObject({
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
    });
  });

  it('顶部已付款原文与收货卡发货按钮在复核仍为空时仍推定已付款待发货', async () => {
    const primaryExtraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: '买家已付款，请尽快发货',
      shippingControls: [{ text: '去发货' }],
      globalControls: ['联系买家'],
      alipayTransactionNumber: null,
    });
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse(
          primaryExtraction,
          'request-status-shipping-control-primary',
        );
      }

      return successfulKieResponse({
        transaction_information: {
          detail_state: 'expanded',
          order_number: 'XY-SYNTH-STATUS-0001',
          alipay_transaction_number: 'ALI-SYNTH-STATUS-0001',
          buyer_nickname_label: '买家昵称',
          buyer_nickname: '合成买家S',
          order_time: '2026-07-30 08:31:00',
          payment_time: '2026-07-30 08:31:08',
          product_total: '31.00',
          shipping_fee: '0.00',
          amount: '31.00',
          platform_transaction_status: null,
          fulfillment_status: null,
          controls: [],
        },
      }, 'request-status-shipping-control-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('shipping-control-review-null'),
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.evidences).toHaveLength(2);
    expect(attempt.result).toMatchObject({
      alipayTransactionNumber: 'ALI-SYNTH-STATUS-0001',
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
    });
  });

  it.each([
    { reviewedStatus: 'cancelled' },
    { reviewedStatus: 'refunded' },
  ] as const)('复核交易模块的 $reviewedStatus 不能覆盖首轮页头已付款证据', async ({
    reviewedStatus,
  }) => {
    const primaryExtraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: '买家已付款，请尽快发货',
      shippingControls: [{ text: '去发货' }],
      alipayTransactionNumber: null,
    });
    const request = vi.fn(async (): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse(
          primaryExtraction,
          `request-explicit-${reviewedStatus}-primary`,
        );
      }
      return successfulKieResponse({
        transaction_information: {
          detail_state: 'expanded',
          order_number: 'XY-SYNTH-STATUS-0001',
          alipay_transaction_number: 'ALI-SYNTH-STATUS-0001',
          buyer_nickname_label: '买家昵称',
          buyer_nickname: '合成买家S',
          order_time: '2026-07-30 08:31:00',
          payment_time: '2026-07-30 08:31:08',
          product_total: '31.00',
          shipping_fee: '0.00',
          amount: '31.00',
          platform_transaction_status: reviewedStatus,
          fulfillment_status: null,
          controls: [],
        },
      }, `request-explicit-${reviewedStatus}-review`);
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput(`explicit-${reviewedStatus}-review`),
    );

    expect(attempt.result.platformTransactionStatus).toBe('paid');
  });

  it('独立页头复核用清晰状态覆盖首轮冲突页头文字', async () => {
    const primaryExtraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: '买家已付款\n交易已取消',
      shippingControls: ['复制'],
      globalControls: ['联系买家'],
      fulfillmentStatus: 'pending_shipment',
    });
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse(
      request.mock.calls.length === 1
        ? primaryExtraction
        : { page_header_status_text: '退款成功' },
      `request-conflicting-top-status-${request.mock.calls.length}`,
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('conflicting-top-status'),
    );

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['page_header_status_text']);
    expect(attempt.result.platformTransactionStatus).toBe('refunded');
  });

  it('复核明确已发货覆盖首轮发货按钮的待发货推定', async () => {
    const primaryExtraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: '买家已付款',
      shippingControls: [{ text: '去发货' }],
      globalControls: [{ label: '去发货' }],
      alipayTransactionNumber: null,
    });
    const request = vi.fn(async (): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse(
          primaryExtraction,
          'request-explicit-shipped-review-primary',
        );
      }
      return successfulKieResponse({
        transaction_information: {
          detail_state: 'expanded',
          order_number: 'XY-SYNTH-STATUS-0001',
          alipay_transaction_number: 'ALI-SYNTH-STATUS-0001',
          buyer_nickname_label: '买家昵称',
          buyer_nickname: '合成买家S',
          order_time: '2026-07-30 08:31:00',
          payment_time: '2026-07-30 08:31:08',
          product_total: '31.00',
          shipping_fee: '0.00',
          amount: '31.00',
          platform_transaction_status: 'paid',
          fulfillment_status: 'shipped',
          controls: [],
        },
      }, 'request-explicit-shipped-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('explicit-shipped-review'),
    );

    expect(attempt.result.fulfillmentStatus).toBe('shipped');
  });

  it('底部全局发货按钮不在收货卡内时仍推定待发货', async () => {
    const extraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: '买家已付款',
      shippingControls: ['复制'],
      globalControls: [{ label: '去发货' }],
    });
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      `request-status-global-control-${request.mock.calls.length}`,
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('global-label-control'),
    );

    expect(attempt.result).toMatchObject({
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
    });
  });

  it('模块化订单同时缺手机号和状态证据时在唯一复核中请求收货与页面上下文', async () => {
    const primaryExtraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: null,
      shippingControls: ['复制'],
      globalControls: ['联系买家'],
      platformTransactionStatus: null,
      fulfillmentStatus: null,
    });
    const primaryShipping = primaryExtraction.shipping_information as
      Record<string, unknown>;
    primaryShipping.phone = null;
    primaryShipping.recipient_phone_line_text = null;

    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse(
          primaryExtraction,
          'request-shipping-page-context-primary',
        );
      }
      return successfulKieResponse({
        shipping_information: {
          ...primaryShipping,
          recipient_phone_line_text: '合成收件人S 13900000031',
          phone: '13900000031',
        },
        page_context: {
          top_status_text: null,
          global_controls: ['去发货'],
          excluded_regions: [],
        },
      }, 'request-shipping-page-context-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('shipping-page-context-review'),
    );

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['shipping_information', 'page_context']);
    expect(attempt.result).toMatchObject({
      phoneNormalized: '13900000031',
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
    });
  });

  it.each([
    {
      topStatusText: '交易已取消',
      expectedStatus: 'cancelled',
    },
    {
      topStatusText: '退款成功',
      expectedStatus: 'refunded',
    },
  ] as const)(
    '缺手机号和状态证据时复核页头“$topStatusText”得到终态且不推定待发货',
    async ({ topStatusText, expectedStatus }) => {
      const primaryExtraction = syntheticModularStatusExtraction({
        pageHeaderStatusText: null,
        shippingControls: ['复制'],
        globalControls: ['联系买家'],
        platformTransactionStatus: null,
        fulfillmentStatus: null,
      });
      const primaryShipping = primaryExtraction.shipping_information as
        Record<string, unknown>;
      primaryShipping.phone = null;
      primaryShipping.recipient_phone_line_text = null;

      const request = vi.fn(async (
        _input: string,
        _init?: RequestInit,
      ): Promise<Response> => {
        if (request.mock.calls.length === 1) {
          return successfulKieResponse(
            primaryExtraction,
            'request-terminal-page-context-' + expectedStatus + '-primary',
          );
        }
        return successfulKieResponse({
          shipping_information: {
            ...primaryShipping,
            recipient_phone_line_text: '合成收件人S 13900000031',
            phone: '13900000031',
          },
          page_context: {
            top_status_text: topStatusText,
            global_controls: ['联系买家'],
            excluded_regions: [],
          },
        }, 'request-terminal-page-context-' + expectedStatus + '-review');
      });
      const client = new BailianOcrClient(request);

      const attempt = await client.recognizeOrder(
        syntheticStatusRecognitionInput(
          'terminal-page-context-' + expectedStatus,
        ),
      );

      expect(request).toHaveBeenCalledTimes(2);
      const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
        parameters: {
          ocr_options: {
            task_config: { result_schema: Record<string, unknown> };
          };
        };
      };
      expect(Object.keys(
        secondBody.parameters.ocr_options.task_config.result_schema,
      )).toEqual(['shipping_information', 'page_context']);
      expect(attempt.result).toMatchObject({
        phoneNormalized: '13900000031',
        platformTransactionStatus: expectedStatus,
        fulfillmentStatus: 'unknown',
      });
    },
  );

  it.each([
    {
      topStatusText: '交易已取消',
      expectedStatus: 'cancelled',
    },
    {
      topStatusText: '退款成功',
      expectedStatus: 'refunded',
    },
  ] as const)(
    '终态页头“$topStatusText”优先于误识别的全局去发货按钮',
    async ({ topStatusText, expectedStatus }) => {
      const extraction = syntheticModularStatusExtraction({
        pageHeaderStatusText: topStatusText,
        shippingControls: ['复制'],
        globalControls: ['去发货'],
        platformTransactionStatus: null,
        fulfillmentStatus: null,
      });
      const request = vi.fn(async (): Promise<Response> =>
        successfulKieResponse(
          extraction,
          'request-terminal-go-ship-' + expectedStatus + '-' +
            request.mock.calls.length,
        )
      );
      const client = new BailianOcrClient(request);

      const attempt = await client.recognizeOrder(
        syntheticStatusRecognitionInput('terminal-go-ship-' + expectedStatus),
      );

      expect(attempt.result).toMatchObject({
        platformTransactionStatus: expectedStatus,
        fulfillmentStatus: 'unknown',
      });
    },
  );

  it('仅平台状态未知时用根级页头字段窄复核，不重复复核交易信息', async () => {
    const primaryExtraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: null,
      shippingControls: ['复制'],
      globalControls: ['联系买家'],
      platformTransactionStatus: null,
      fulfillmentStatus: 'pending_shipment',
    });
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse(
      request.mock.calls.length === 1
        ? primaryExtraction
        : { page_header_status_text: '买家已付款，请尽快发货' },
      `request-page-header-status-review-${request.mock.calls.length}`,
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('page-header-status-review'),
    );

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    const reviewSchema = secondBody.parameters.ocr_options.task_config.result_schema;
    expect(Object.keys(reviewSchema)[0]).toBe('page_header_status_text');
    expect(reviewSchema).not.toHaveProperty('transaction_information');
    expect(attempt.result.platformTransactionStatus).toBe('paid');
  });

  it.each([
    {
      topStatusCase: '缺失',
      pageHeaderStatusText: undefined,
      shippingControls: [{ text: '去发货' }],
      globalControls: ['联系买家'],
    },
    {
      topStatusCase: '为空',
      pageHeaderStatusText: null,
      shippingControls: ['复制'],
      globalControls: [{ label: '去发货' }],
    },
  ])('OCR 页头状态字段$topStatusCase时不把 fenced JSON 当作页面全文', async ({
    topStatusCase,
    pageHeaderStatusText,
    shippingControls,
    globalControls,
  }) => {
    const extraction = syntheticModularStatusExtraction({
      pageHeaderStatusText,
      shippingControls,
      globalControls,
    });
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      `request-processed-status-fallback-${topStatusCase}-${request.mock.calls.length}`,
      fencedProcessedJson({
        shipping_information: {
          recipient: '合成收件人S',
          address: '测试省测试市示例区安全路31号',
          recognition_note: '买家已付款，请尽快发货',
        },
      }),
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput(`processed-fallback-${topStatusCase}`),
    );

    expect(attempt.result).toMatchObject({
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
    });
  });

  it('fenced JSON 中的冲突状态文字不参与平台状态推定', async () => {
    const extraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: null,
      shippingControls: ['复制'],
      globalControls: ['联系买家'],
    });
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      `request-conflicting-processed-status-${request.mock.calls.length}`,
      fencedProcessedJson({
        generated_summary: '买家已付款，请尽快发货',
        advertisement_text: '退款成功',
      }),
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('conflicting-processed-status'),
    );

    expect(attempt.result.platformTransactionStatus).toBe('unknown');
  });

  it('fenced JSON 中非页头字段的状态词不作为平台状态兜底', async () => {
    const extraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: null,
      shippingControls: ['复制'],
      globalControls: ['联系买家'],
    });
    const processedText = fencedProcessedJson({
      shipping_information: {
        recipient: '合成收件人S',
        recognition_note: '退款成功',
      },
    });
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      `request-lower-processed-status-${request.mock.calls.length}`,
      processedText,
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('lower-processed-status'),
    );

    expect(attempt.result.platformTransactionStatus).toBe('unknown');
  });

  it('显式已发货状态不被收货卡或全局发货按钮覆盖', async () => {
    const extraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: '买家已付款',
      shippingControls: [{ text: '去发货' }],
      globalControls: [{ label: '去发货' }],
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'shipped',
    });
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      'request-explicit-shipped-precedence',
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('explicit-shipped-precedence'),
    );

    expect(attempt.result).toMatchObject({
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'shipped',
    });
  });

  it.each([
    {
      controlArea: '交易信息模块',
      purchasedItemControls: [],
      transactionControls: [{ text: '去发货' }],
    },
    {
      controlArea: '已购商品模块',
      purchasedItemControls: [{ label: '去发货' }],
      transactionControls: [],
    },
  ])('只出现在$controlArea的发货按钮不参与待发货推定', async ({
    controlArea,
    purchasedItemControls,
    transactionControls,
  }) => {
    const extraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: '买家已付款',
      shippingControls: ['复制'],
      globalControls: ['联系买家'],
      purchasedItemControls,
      transactionControls,
    });
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      `request-status-unrelated-control-${controlArea}-${request.mock.calls.length}`,
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput(`unrelated-control-${controlArea}`),
    );

    expect(attempt.result.platformTransactionStatus).toBe('paid');
    expect(attempt.result.fulfillmentStatus).toBe('unknown');
  });

  it.each([
    { visibleStatus: '交易已取消', expectedStatus: 'cancelled' },
    { visibleStatus: '退款成功', expectedStatus: 'refunded' },
  ] as const)('顶部明确的“$visibleStatus”原文保守映射平台交易状态', async ({
    visibleStatus,
    expectedStatus,
  }) => {
    const extraction = syntheticModularStatusExtraction({
      pageHeaderStatusText: visibleStatus,
      shippingControls: ['复制'],
      globalControls: ['联系买家'],
    });
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      `request-top-platform-status-${expectedStatus}-${request.mock.calls.length}`,
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput(`top-platform-${expectedStatus}`),
    );

    expect(attempt.result.platformTransactionStatus).toBe(expectedStatus);
    expect(attempt.result.fulfillmentStatus).toBe('unknown');
  });

  it('kv 缺少手机号时从双重匹配的 fenced JSON recipient_phone 恢复唯一合法号码', async () => {
    const extraction = syntheticModularPhoneFallbackExtraction();
    const processedText = fencedProcessedJson({
      shipping_information: {
        recipient: '合成收件人R',
        recipient_phone: '13900000039',
        address: '测试省测试市示例区安全路39号',
      },
    });
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      `request-processed-phone-positive-${request.mock.calls.length}`,
      processedText,
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('processed-phone-positive'),
    );

    expect(attempt.result.phoneNormalized).toBe('13900000039');
    expect(attempt.result.recipient).toBe('合成收件人R');
    expect(attempt.result.addressNormalized).toBe(
      '测试省测试市示例区安全路39号',
    );
  });

  it.each([
    {
      mismatch: '收件人不一致',
      processedRecipient: '另一个收件人',
      processedAddress: '测试省测试市示例区安全路39号',
    },
    {
      mismatch: '地址不一致',
      processedRecipient: '合成收件人R',
      processedAddress: '测试省测试市示例区其他路88号',
    },
  ])('processed_text 与 kv 的$mismatch时不恢复 recipient_phone', async ({
    mismatch,
    processedRecipient,
    processedAddress,
  }) => {
    const extraction = syntheticModularPhoneFallbackExtraction();
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      `request-processed-phone-mismatch-${mismatch}-${request.mock.calls.length}`,
      fencedProcessedJson({
        shipping_information: {
          recipient: processedRecipient,
          recipient_phone: '13900000039',
          address: processedAddress,
        },
      }),
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput(`processed-phone-mismatch-${mismatch}`),
    );

    expect(attempt.result.phoneNormalized).toBe('');
  });

  it('processed_text 的 phone 与 recipient_phone 冲突时不猜测手机号', async () => {
    const extraction = syntheticModularPhoneFallbackExtraction();
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      `request-processed-phone-conflict-${request.mock.calls.length}`,
      fencedProcessedJson({
        shipping_information: {
          recipient: '合成收件人R',
          phone: '13800000039',
          recipient_phone: '13900000039',
          address: '测试省测试市示例区安全路39号',
        },
      }),
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('processed-phone-conflict'),
    );

    expect(attempt.result.phoneNormalized).toBe('');
  });

  it('kv 已有合法手机号时不被 processed_text 的 recipient_phone 覆盖', async () => {
    const extraction = syntheticModularPhoneFallbackExtraction({
      kvPhone: '13700000039',
    });
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse(
      extraction,
      'request-processed-phone-preserve-kv',
      fencedProcessedJson({
        shipping_information: {
          recipient: '合成收件人R',
          recipient_phone: '13900000039',
          address: '测试省测试市示例区安全路39号',
        },
      }),
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('processed-phone-preserve-kv'),
    );

    expect(attempt.result.phoneNormalized).toBe('13700000039');
  });

  it('首轮按商品、收货和交易三个模块识别折叠订单并排除控件与广告', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse({
      purchased_items: {
        controls: ['查看商品'],
        items: [{
          title: '合成已购商品甲',
          spec: '商务蓝·标准款',
          unit_price: '12.00',
          price_tag_text: '¥12.00',
          quantity: '2',
          quantity_text: '×2',
        }],
      },
      shipping_information: {
        controls: ['复制', '去发货'],
        recipient: '合成收件人乙',
        recipient_phone_line_text: '合成收件人乙 13900000002',
        phone: '13900000002',
        address: '测试省测试市示例区安全路2号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
      },
      transaction_information: {
        controls: ['交易快照', '复制', '展开'],
        detail_state: 'collapsed',
        order_number: 'XY-SYNTH-MODULED-0001',
        alipay_transaction_number: null,
        buyer_nickname_label: null,
        buyer_nickname: null,
        order_time: null,
        payment_time: null,
        product_total: '24.00',
        shipping_fee: '0.00',
        amount: '24.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家', '取消订单', '去发货'],
        excluded_regions: ['合成广告横幅', '合成推荐商品'],
      },
    }, 'request-moduled-collapsed-primary'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-moduled-collapsed',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-moduled-collapsed.png',
        originalName: '合成三模块折叠订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-moduled-collapsed',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-MODULED-0001',
      buyerNickname: '',
      recipient: '合成收件人乙',
      phoneNormalized: '13900000002',
      addressOriginal: '测试省测试市示例区安全路2号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      productTotalCents: 2_400,
      shippingFeeCents: 0,
      amountCents: 2_400,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [{
        sourceTitle: '合成已购商品甲',
        sourceSpec: '商务蓝·标准款',
        unitPriceCents: 1_200,
        quantity: 2,
        quantityInferred: false,
      }],
    });
    const serializedResult = JSON.stringify(attempt.result);
    for (const excludedText of [
      '查看商品',
      '复制',
      '去发货',
      '交易快照',
      '展开',
      '联系买家',
      '取消订单',
      '合成广告横幅',
      '合成推荐商品',
    ]) {
      expect(serializedResult).not.toContain(excludedText);
    }
    expect(request).toHaveBeenCalledOnce();

    const firstBody = JSON.parse(String(request.mock.calls[0][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    const firstPassSchema = firstBody.parameters.ocr_options.task_config.result_schema;
    expect(Object.keys(firstPassSchema)[0]).toBe('purchased_items');
    expect(firstPassSchema).not.toHaveProperty('page_header_status_text');
    expect(firstPassSchema).toHaveProperty('purchased_items');
    expect(firstPassSchema).toHaveProperty('shipping_information');
    expect(firstPassSchema).toHaveProperty('transaction_information');
    expect(firstPassSchema).toHaveProperty(
      'transaction_information.platform_transaction_status',
    );
    expect(firstPassSchema).toHaveProperty('page_context');
    expect(firstPassSchema).toHaveProperty('page_context.top_status_text');
  });

  it('模块化收件人字段粘连同一手机号时只保留姓名', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse({
      purchased_items: {
        controls: [],
        items: [{
          title: '合成完整商品甲',
          spec: '规格A',
          unit_price: '8.00',
          price_tag_text: '¥8.00',
          quantity: '1',
          quantity_text: '×1',
        }],
      },
      shipping_information: {
        controls: ['复制'],
        recipient: '合成收件人甲13900000001',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
      },
      transaction_information: {
        controls: [],
        detail_state: 'expanded',
        order_number: 'XY-SYNTH-RECIPIENT-PHONE-0001',
        alipay_transaction_number: 'ALI-SYNTH-RECIPIENT-PHONE-0001',
        buyer_nickname_label: '买家昵称',
        buyer_nickname: '合成买家甲',
        order_time: '2026-07-29 10:00:00',
        payment_time: '2026-07-29 10:00:08',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家', '去发货'],
        excluded_regions: [],
      },
    }, 'request-recipient-phone-primary'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-phone',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-phone.png',
        originalName: '合成收件人手机号粘连订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-phone',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result.recipient).toBe('合成收件人甲');
    expect(attempt.result.phoneNormalized).toBe('13900000001');
    expect(request).toHaveBeenCalledOnce();
  });

  it('模块化收件人字段粘连带国家码的同一手机号时只保留姓名', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse({
      purchased_items: {
        controls: [],
        items: [{
          title: '合成完整商品乙',
          spec: '规格B',
          unit_price: '9.00',
          price_tag_text: '¥9.00',
          quantity: '1',
          quantity_text: '×1',
        }],
      },
      shipping_information: {
        controls: ['复制'],
        recipient: '合成收件人乙 +86 139-0000-0002',
        phone: '13900000002',
        address: '测试省测试市示例区安全路2号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
      },
      transaction_information: {
        controls: [],
        detail_state: 'expanded',
        order_number: 'XY-SYNTH-RECIPIENT-PHONE-0002',
        alipay_transaction_number: 'ALI-SYNTH-RECIPIENT-PHONE-0002',
        buyer_nickname_label: '买家昵称',
        buyer_nickname: '合成买家乙',
        order_time: '2026-07-29 10:01:00',
        payment_time: '2026-07-29 10:01:08',
        product_total: '9.00',
        shipping_fee: '0.00',
        amount: '9.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家', '去发货'],
        excluded_regions: [],
      },
    }, 'request-recipient-country-code-phone-primary'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-country-code-phone',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-country-code-phone.png',
        originalName: '合成收件人国家码手机号粘连订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-country-code-phone',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result.recipient).toBe('合成收件人乙');
    expect(attempt.result.phoneNormalized).toBe('13900000002');
    expect(request).toHaveBeenCalledOnce();
  });

  it('模块化收件人字段粘连 Unicode 短横线手机号时只保留姓名', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse({
      purchased_items: {
        controls: [],
        items: [{
          title: '合成完整商品丁',
          spec: '规格D',
          unit_price: '11.00',
          price_tag_text: '¥11.00',
          quantity: '1',
          quantity_text: '×1',
        }],
      },
      shipping_information: {
        controls: ['复制'],
        recipient: '合成收件人丁 +86 139–0000–0005',
        phone: '13900000005',
        address: '测试省测试市示例区安全路4号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
      },
      transaction_information: {
        controls: [],
        detail_state: 'expanded',
        order_number: 'XY-SYNTH-RECIPIENT-PHONE-0004',
        alipay_transaction_number: 'ALI-SYNTH-RECIPIENT-PHONE-0004',
        buyer_nickname_label: '买家昵称',
        buyer_nickname: '合成买家丁',
        order_time: '2026-07-29 10:03:00',
        payment_time: '2026-07-29 10:03:08',
        product_total: '11.00',
        shipping_fee: '0.00',
        amount: '11.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家', '去发货'],
        excluded_regions: [],
      },
    }, 'request-recipient-unicode-dash-phone-primary'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-unicode-dash-phone',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-unicode-dash-phone.png',
        originalName: '合成收件人 Unicode 短横线手机号粘连订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-unicode-dash-phone',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result.recipient).toBe('合成收件人丁');
    expect(attempt.result.phoneNormalized).toBe('13900000005');
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { phoneCase: '独立手机号已识别', extractedPhone: '13900000008', calls: 1 },
    { phoneCase: '独立手机号缺失', extractedPhone: null, calls: 2 },
  ])('模块化联系人行在$phoneCase时可证明误列为按钮的真实收件人姓名', async ({
    extractedPhone,
    calls,
  }) => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse({
      purchased_items: {
        controls: [],
        items: [{
          title: '合成完整商品戊',
          spec: '规格E',
          unit_price: '12.00',
          price_tag_text: '¥12.00',
          quantity: '1',
          quantity_text: '×1',
        }],
      },
      shipping_information: {
        controls: ['复制', '合成真实姓名戊'],
        recipient: '合成真实姓名戊',
        phone: extractedPhone,
        recipient_phone_line_text: '合成真实姓名戊 (+86) 139–0000–0008',
        address: '测试省测试市示例区安全路5号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
      },
      transaction_information: {
        controls: [],
        detail_state: 'expanded',
        order_number: 'XY-SYNTH-RECIPIENT-CONTACT-LINE-0001',
        alipay_transaction_number: 'ALI-SYNTH-RECIPIENT-CONTACT-LINE-0001',
        buyer_nickname_label: '买家昵称',
        buyer_nickname: '合成买家戊',
        order_time: '2026-07-29 10:04:00',
        payment_time: '2026-07-29 10:04:08',
        product_total: '12.00',
        shipping_fee: '0.00',
        amount: '12.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家', '去发货'],
        excluded_regions: [],
      },
    }, 'request-recipient-contact-line-primary'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-contact-line',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-contact-line.png',
        originalName: '合成联系人行收件人订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-contact-line',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result.recipient).toBe('合成真实姓名戊');
    expect(attempt.result.phoneNormalized).toBe('13900000008');
    expect(request).toHaveBeenCalledTimes(calls);
  });

  it('模块化联系人行的手机号缺少末端边界时不能恢复模型按钮', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            controls: [],
            items: [{
              title: '合成完整商品辛',
              spec: '规格H',
              unit_price: '15.00',
              price_tag_text: '¥15.00',
              quantity: '1',
              quantity_text: '×1',
            }],
          },
          shipping_information: {
            controls: ['处理发运'],
            recipient: '处理发运',
            recipient_phone_line_text: '处理发运 139000000019',
            phone: '13900000001',
            address: '测试省测试市示例区安全路8号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
          },
          transaction_information: {
            controls: [],
            detail_state: 'expanded',
            order_number: 'XY-SYNTH-RECIPIENT-PHONE-BOUNDARY-0001',
            alipay_transaction_number: 'ALI-SYNTH-RECIPIENT-PHONE-BOUNDARY-0001',
            buyer_nickname_label: '买家昵称',
            buyer_nickname: '合成买家辛',
            order_time: '2026-07-29 10:07:00',
            payment_time: '2026-07-29 10:07:08',
            product_total: '15.00',
            shipping_fee: '0.00',
            amount: '15.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家', '去发货'],
            excluded_regions: [],
          },
        }, 'request-recipient-phone-boundary-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          controls: ['复制'],
          recipient: '合成收件人辛',
          phone: '13900000001',
          address: '测试省测试市示例区安全路8号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
        },
      }, 'request-recipient-phone-boundary-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-phone-boundary',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-phone-boundary.png',
        originalName: '合成联系人行手机号边界订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-phone-boundary',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      input: {
        messages: Array<{
          content: Array<{ text?: string }>;
        }>;
      };
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['shipping_information']);
    expect(secondBody.input.messages[0].content[1]?.text).toContain(
      '只提取页面顶部收货信息卡',
    );
    expect(secondBody.input.messages[0].content[1]?.text).toContain(
      'recipient 只填联系人姓名',
    );
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人辛',
      phone: '13900000001',
      phoneNormalized: '13900000001',
    });
  });

  it('显式手机号与联系人行手机号冲突时复核后仍不猜测手机号', async () => {
    const primary = {
      purchased_items: {
        items: [{
          title: '合成手机号冲突商品',
          spec: '规格冲突',
          unit_price: '42.00',
          price_tag_text: '¥42.00',
          quantity: '1',
          quantity_text: '×1',
        }],
        controls: [],
      },
      shipping_information: {
        recipient: '合成收件人冲',
        recipient_phone_line_text: '合成收件人冲 13800000042',
        phone: '13900000042',
        address: '测试省测试市示例区安全路42号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        controls: ['复制'],
      },
      transaction_information: {
        detail_state: 'collapsed',
        order_number: 'XY-SYNTH-PHONE-CONFLICT-0001',
        alipay_transaction_number: null,
        product_total: '42.00',
        shipping_fee: '0.00',
        amount: '42.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        buyer_nickname_label: null,
        buyer_nickname: null,
        order_time: null,
        payment_time: null,
        controls: ['展开'],
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家'],
        excluded_regions: [],
      },
    };
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse(primary, 'request-phone-conflict-primary');
      }
      return successfulKieResponse({
        shipping_information: primary.shipping_information,
      }, 'request-phone-conflict-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-phone-conflict',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-phone-conflict.png',
        originalName: '合成手机号冲突订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-phone-conflict',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['shipping_information']);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人冲',
      phone: '',
      phoneNormalized: '',
    });
  });

  it('首轮姓名字段粘连的号码与独立手机号冲突时复核后保留姓名', async () => {
    const primary = {
      purchased_items: {
        items: [{
          title: '合成首轮联系人冲突商品',
          spec: '规格首轮冲突',
          unit_price: '43.00',
          price_tag_text: '¥43.00',
          quantity: '1',
          quantity_text: '×1',
        }],
        controls: [],
      },
      shipping_information: {
        recipient: '张三 13800000000',
        recipient_phone_line_text: null,
        phone: '13900000000',
        address: '测试省测试市示例区安全路43号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        controls: ['复制'],
      },
      transaction_information: {
        detail_state: 'collapsed',
        order_number: 'XY-SYNTH-PRIMARY-CONTACT-CONFLICT-0001',
        alipay_transaction_number: null,
        product_total: '43.00',
        shipping_fee: '0.00',
        amount: '43.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        buyer_nickname_label: null,
        buyer_nickname: null,
        order_time: null,
        payment_time: null,
        controls: ['展开'],
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家'],
        excluded_regions: [],
      },
    };
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse(
          primary,
          'request-primary-contact-conflict-primary',
        );
      }
      return successfulKieResponse({
        shipping_information: primary.shipping_information,
      }, 'request-primary-contact-conflict-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput('primary-contact-conflict-review'),
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      recipient: '张三',
      phone: '',
      phoneNormalized: '',
    });
  });

  it.each([
    {
      name: '首轮联系人全缺失且复核手机号冲突时保留一致姓名',
      caseId: 'same-name-explicit-phone-conflict',
      recipient: '张三 13800000000',
      recipientPhoneLineText: '张三 13800000000',
      phone: '13900000000',
      expectedRecipient: '张三',
      addressNumber: 31,
    },
    {
      name: '首轮联系人全缺失且复核姓名与手机号都冲突时拒绝整组联系人',
      caseId: 'different-name-explicit-phone-conflict',
      recipient: '张三 13800000000',
      recipientPhoneLineText: '李四 13800000000',
      phone: '13900000000',
      expectedRecipient: '',
      addressNumber: 32,
    },
    {
      name: '首轮联系人全缺失且复核两路手机号冲突时保留一致姓名',
      caseId: 'same-name-two-source-phone-conflict',
      recipient: '张三 13800000000',
      recipientPhoneLineText: '张三 13900000000',
      phone: null,
      expectedRecipient: '张三',
      addressNumber: 33,
    },
    {
      name: '首轮联系人全缺失且复核干净姓名与联系人行姓名冲突时拒绝整组联系人',
      caseId: 'clean-name-different-line-name-conflict',
      recipient: '李四',
      recipientPhoneLineText: '张三 13800000000',
      phone: '13900000000',
      expectedRecipient: '',
      addressNumber: 34,
    },
    {
      name: '首轮联系人全缺失且复核冲突号码中的一致姓名粘连按钮时拒绝整组联系人',
      caseId: 'button-contaminated-name-conflict',
      recipient: '张三复制 13800000000',
      recipientPhoneLineText: '张三复制 13800000000',
      phone: '13900000000',
      expectedRecipient: '',
      addressNumber: 35,
    },
    {
      name: '首轮联系人全缺失且复核独立手机号字段含两个号码时不选择其中一个',
      caseId: 'multiple-phones-in-explicit-phone-field',
      recipient: '张三 13800000000',
      recipientPhoneLineText: '张三 13800000000',
      phone: '13800000000 13900000000',
      expectedRecipient: '张三',
      addressNumber: 36,
    },
    {
      name: '首轮联系人全缺失且复核冲突号码中的一致文本是业务标签时拒绝整组联系人',
      caseId: 'business-label-name-conflict',
      recipient: '商品总价 13800000000',
      recipientPhoneLineText: '商品总价 13800000000',
      phone: '13900000000',
      expectedRecipient: '',
      addressNumber: 37,
    },
  ])('$name', async ({
    caseId,
    recipient,
    recipientPhoneLineText,
    phone,
    expectedRecipient,
    addressNumber,
  }) => {
    const primary = syntheticModularStatusExtraction({
      pageHeaderStatusText: '买家已付款，请尽快发货',
      shippingControls: ['复制'],
      globalControls: ['联系买家'],
      platformTransactionStatus: null,
      fulfillmentStatus: 'pending_shipment',
    });
    const primaryShipping = primary.shipping_information as
      Record<string, unknown>;
    primaryShipping.recipient = null;
    primaryShipping.recipient_phone_line_text = null;
    primaryShipping.phone = null;

    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse(
          primary,
          `request-missing-contact-${caseId}-primary`,
        );
      }
      return successfulKieResponse({
        shipping_information: {
          recipient,
          recipient_phone_line_text: recipientPhoneLineText,
          phone,
          address: `测试省测试市示例区安全路${addressNumber}号`,
          province: '测试省',
          city: '测试市',
          district: '示例区',
          controls: ['复制'],
        },
      }, `request-missing-contact-${caseId}-review`);
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder(
      syntheticStatusRecognitionInput(`missing-contact-${caseId}-review`),
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      recipient: expectedRecipient,
      phone: '',
      phoneNormalized: '',
    });
    expect(attempt.result.recipient + attempt.result.phone).not.toMatch(
      /(?:138|139)00000000/u,
    );
  });

  it('模块化收件人字段与独立手机号冲突时只复核收货模块', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            controls: [],
            items: [{
              title: '合成完整商品丙',
              spec: '规格C',
              unit_price: '10.00',
              price_tag_text: '¥10.00',
              quantity: '1',
              quantity_text: '×1',
            }],
          },
          shipping_information: {
            controls: ['复制'],
            recipient: '合成收件人丙13900000003',
            phone: '13900000004',
            address: '测试省测试市示例区安全路3号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
          },
          transaction_information: {
            controls: [],
            detail_state: 'expanded',
            order_number: 'XY-SYNTH-RECIPIENT-PHONE-CONFLICT-0001',
            alipay_transaction_number: 'ALI-SYNTH-RECIPIENT-PHONE-CONFLICT-0001',
            buyer_nickname_label: '买家昵称',
            buyer_nickname: '合成买家丙',
            order_time: '2026-07-29 10:02:00',
            payment_time: '2026-07-29 10:02:08',
            product_total: '10.00',
            shipping_fee: '0.00',
            amount: '10.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家', '去发货'],
            excluded_regions: [],
          },
        }, 'request-recipient-phone-conflict-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          controls: ['复制'],
          recipient: '合成收件人丙',
          phone: '13900000004',
          address: '测试省测试市示例区安全路3号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
        },
      }, 'request-recipient-phone-conflict-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-phone-conflict',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-phone-conflict.png',
        originalName: '合成收件人手机号冲突订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-phone-conflict',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['shipping_information']);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人丙',
      phone: '13900000004',
      phoneNormalized: '13900000004',
    });
  });

  it('模块化收件人仅有同一手机号时只复核收货模块', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            controls: [],
            items: [{
              title: '合成完整商品戊',
              spec: '规格E',
              unit_price: '12.00',
              price_tag_text: '¥12.00',
              quantity: '1',
              quantity_text: '×1',
            }],
          },
          shipping_information: {
            controls: ['复制'],
            recipient: '13900000008',
            phone: '13900000008',
            address: '测试省测试市示例区安全路5号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
          },
          transaction_information: {
            controls: [],
            detail_state: 'expanded',
            order_number: 'XY-SYNTH-RECIPIENT-PHONE-ONLY-0001',
            alipay_transaction_number: 'ALI-SYNTH-RECIPIENT-PHONE-ONLY-0001',
            buyer_nickname_label: '买家昵称',
            buyer_nickname: '合成买家戊',
            order_time: '2026-07-29 10:04:00',
            payment_time: '2026-07-29 10:04:08',
            product_total: '12.00',
            shipping_fee: '0.00',
            amount: '12.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家', '去发货'],
            excluded_regions: [],
          },
        }, 'request-recipient-phone-only-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          controls: ['复制'],
          recipient: '合成收件人戊',
          phone: '13900000008',
          address: '测试省测试市示例区安全路5号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
        },
      }, 'request-recipient-phone-only-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-phone-only',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-phone-only.png',
        originalName: '合成收件人仅手机号订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-phone-only',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['shipping_information']);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人戊',
      phone: '13900000008',
      phoneNormalized: '13900000008',
    });
  });

  it('模块化收件人姓名内部数字在剥离手机号时保留', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse({
      purchased_items: {
        controls: [],
        items: [{
          title: '合成完整商品己',
          spec: '规格F',
          unit_price: '13.00',
          price_tag_text: '¥13.00',
          quantity: '1',
          quantity_text: '×1',
        }],
      },
      shipping_information: {
        controls: ['复制'],
        recipient: '测试2号13900000006',
        phone: '13900000006',
        address: '测试省测试市示例区安全路6号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
      },
      transaction_information: {
        controls: [],
        detail_state: 'expanded',
        order_number: 'XY-SYNTH-RECIPIENT-NAME-DIGIT-0001',
        alipay_transaction_number: 'ALI-SYNTH-RECIPIENT-NAME-DIGIT-0001',
        buyer_nickname_label: '买家昵称',
        buyer_nickname: '合成买家己',
        order_time: '2026-07-29 10:05:00',
        payment_time: '2026-07-29 10:05:08',
        product_total: '13.00',
        shipping_fee: '0.00',
        amount: '13.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家', '去发货'],
        excluded_regions: [],
      },
    }, 'request-recipient-name-digit-primary'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-name-digit',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-name-digit.png',
        originalName: '合成姓名内部数字订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-name-digit',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result.recipient).toBe('测试2号');
    expect(attempt.result.phoneNormalized).toBe('13900000006');
    expect(request).toHaveBeenCalledOnce();
  });

  it('模块化收件人剥离手机号后为功能按钮时只复核收货模块', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            controls: [],
            items: [{
              title: '合成完整商品庚',
              spec: '规格G',
              unit_price: '14.00',
              price_tag_text: '¥14.00',
              quantity: '1',
              quantity_text: '×1',
            }],
          },
          shipping_information: {
            controls: ['复制', '去发货'],
            recipient: '去发货13900000007',
            recipient_phone_line_text: '去发货 13900000007',
            phone: '13900000007',
            address: '测试省测试市示例区安全路7号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
          },
          transaction_information: {
            controls: [],
            detail_state: 'expanded',
            order_number: 'XY-SYNTH-RECIPIENT-CONTROL-0001',
            alipay_transaction_number: 'ALI-SYNTH-RECIPIENT-CONTROL-0001',
            buyer_nickname_label: '买家昵称',
            buyer_nickname: '合成买家庚',
            order_time: '2026-07-29 10:06:00',
            payment_time: '2026-07-29 10:06:08',
            product_total: '14.00',
            shipping_fee: '0.00',
            amount: '14.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家', '去发货'],
            excluded_regions: [],
          },
        }, 'request-recipient-control-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          controls: ['复制'],
          recipient: '合成收件人庚',
          phone: '13900000007',
          address: '测试省测试市示例区安全路7号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
        },
      }, 'request-recipient-control-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-control',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-control.png',
        originalName: '合成收件人按钮粘连订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-control',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['shipping_information']);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人庚',
      phone: '13900000007',
      phoneNormalized: '13900000007',
    });
  });

  it('首轮收件人粘连手机号和按钮时接受手机号单独复核出的姓名', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成完整商品癸',
              spec: '规格J',
              unit_price: '16.00',
              price_tag_text: '¥16.00',
              quantity: '1',
              quantity_text: '×1',
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '合成收件人癸 13900000010 | 复制',
            recipient_phone_line_text: null,
            phone: null,
            address: '测试省测试市示例区安全路10号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: ['复制', '去发货'],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-RECIPIENT-CONTAMINATED-0001',
            alipay_transaction_number: null,
            product_total: '16.00',
            shipping_fee: '0.00',
            amount: '16.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: ['展开'],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家', '取消订单', '去发货'],
            excluded_regions: [],
          },
        }, 'request-recipient-contaminated-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          recipient: '合成收件人癸',
          recipient_phone_line_text: '13900000010',
          phone: '13900000010',
          address: '测试省测试市示例区安全路10号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          controls: ['复制', '去发货'],
        },
      }, 'request-recipient-contaminated-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-contaminated',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-contaminated.png',
        originalName: '合成收件人姓名手机号按钮粘连订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-contaminated',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人癸',
      phone: '13900000010',
      phoneNormalized: '13900000010',
    });
  });

  it('模块化首轮和复核都给出可信姓名及仅手机号同行文本时保留姓名和恢复手机号', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成可信收件人商品',
              spec: '规格可信',
              unit_price: '17.00',
              price_tag_text: '¥17.00',
              quantity: '1',
              quantity_text: '×1',
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '合成收件人甲',
            recipient_phone_line_text: '13900000021',
            phone: null,
            address: '测试省测试市示例区安全路21号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: [
              { text: '复制', action: 'copy' },
              { text: '去发货', action: 'ship' },
            ],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-TRUSTED-RECIPIENT-0001',
            alipay_transaction_number: null,
            product_total: '17.00',
            shipping_fee: '0.00',
            amount: '17.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: [{ text: '展开', action: 'expand' }],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: [{ text: '联系买家', action: 'contact' }],
            excluded_regions: [],
          },
        }, 'request-trusted-recipient-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          recipient: '合成收件人甲',
          recipient_phone_line_text: '13900000021',
          phone: null,
          address: '测试省测试市示例区安全路21号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          controls: [
            { text: '复制', action: 'copy' },
            { text: '去发货', action: 'ship' },
          ],
        },
      }, 'request-trusted-recipient-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-trusted-recipient',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-trusted-recipient.png',
        originalName: '合成可信收件人订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-trusted-recipient',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人甲',
      phone: '13900000021',
      phoneNormalized: '13900000021',
    });
  });

  it('模块化复核给出更完整相关姓名和纯手机号行时安全替换并恢复手机号', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成完整收件人商品',
              spec: '规格完整',
              unit_price: '19.00',
              price_tag_text: '¥19.00',
              quantity: '1',
              quantity_text: '×1',
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '收件人甲',
            recipient_phone_line_text: '13900000022',
            phone: null,
            address: '测试省测试市示例区安全路22号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: [
              { text: '复制', action: 'copy' },
              { text: '去发货', action: 'ship' },
            ],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-FULLER-RECIPIENT-0001',
            alipay_transaction_number: null,
            product_total: '19.00',
            shipping_fee: '0.00',
            amount: '19.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: [{ text: '展开', action: 'expand' }],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: [{ text: '联系买家', action: 'contact' }],
            excluded_regions: [],
          },
        }, 'request-fuller-recipient-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          recipient: '合成收件人甲',
          recipient_phone_line_text: '13900000022',
          phone: null,
          address: '测试省测试市示例区安全路22号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          controls: [
            { text: '复制', action: 'copy' },
            { text: '去发货', action: 'ship' },
          ],
        },
      }, 'request-fuller-recipient-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-fuller-recipient',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-fuller-recipient.png',
        originalName: '合成完整收件人订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-fuller-recipient',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人甲',
      phone: '13900000022',
      phoneNormalized: '13900000022',
    });
  });

  it.each([
    {
      reviewCase: '姓名尾部粘连了已声明按钮',
      reviewedRecipient: '收件人甲复制',
      reviewedPhone: null,
      reviewedContactLine: '13900000023',
      reviewedControls: [{ text: '复制', action: 'copy' }],
    },
    {
      reviewCase: '显式手机号与同行文本中的手机号冲突',
      reviewedRecipient: '合成收件人甲',
      reviewedPhone: '13900000023',
      reviewedContactLine: '13800000023',
      reviewedControls: [{ text: '复制', action: 'copy' }],
    },
    {
      reviewCase: '同行文本同时含冲突手机号和显式手机号',
      reviewedRecipient: '合成收件人甲',
      reviewedPhone: '13900000023',
      reviewedContactLine: '13800000023 13900000023',
      reviewedControls: [{ text: '复制', action: 'copy' }],
    },
  ])('模块化$reviewCase时拒绝不安全复核值并保留首轮可信联系人', async ({
    reviewedRecipient,
    reviewedPhone,
    reviewedContactLine,
    reviewedControls,
  }) => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成安全复核商品',
              spec: '规格安全',
              unit_price: '21.00',
              price_tag_text: '¥21.00',
              quantity: '1',
              quantity_text: '×1',
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '收件人甲',
            recipient_phone_line_text: '13900000023',
            phone: null,
            address: '测试省测试市示例区安全路23号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: [
              { text: '复制', action: 'copy' },
              { text: '去发货', action: 'ship' },
            ],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-SAFE-RECIPIENT-0001',
            alipay_transaction_number: null,
            product_total: '21.00',
            shipping_fee: '0.00',
            amount: '21.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: [{ text: '展开', action: 'expand' }],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: [{ text: '联系买家', action: 'contact' }],
            excluded_regions: [],
          },
        }, 'request-safe-recipient-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          recipient: reviewedRecipient,
          recipient_phone_line_text: reviewedContactLine,
          phone: reviewedPhone,
          address: '测试省测试市示例区安全路23号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          controls: reviewedControls,
        },
      }, 'request-safe-recipient-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-safe-recipient',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-safe-recipient.png',
        originalName: '合成安全复核订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-safe-recipient',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      recipient: '收件人甲',
      phone: '13900000023',
      phoneNormalized: '13900000023',
    });
  });

  it.each([
    { reviewCase: '手机号为空', reviewedPhone: '' },
    { reviewCase: '手机号与首轮冲突', reviewedPhone: '13800000011' },
  ])('复核误把发货按钮当收件人且$reviewCase时仍从首轮确定性拆出姓名和手机号', async ({
    reviewedPhone,
  }) => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成完整商品子',
              spec: '规格K',
              unit_price: '18.00',
              price_tag_text: '¥18.00',
              quantity: '1',
              quantity_text: '×1',
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '合成收件人子 13900000011 | 复制',
            recipient_phone_line_text: '',
            address: '测试省测试市示例区安全路11号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: [
              { text: '复制', action: 'copy' },
              { text: '去发货', action: 'ship' },
            ],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-RECIPIENT-LOCAL-RECOVERY-0001',
            alipay_transaction_number: null,
            product_total: '18.00',
            shipping_fee: '0.00',
            amount: '18.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: [{ text: '展开', action: 'expand' }],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: [
              { text: '联系买家', action: 'contact' },
              { text: '取消订单', action: 'cancel' },
              { text: '去发货', action: 'ship' },
            ],
            excluded_regions: [],
          },
        }, 'request-recipient-local-recovery-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          recipient: '去发货',
          recipient_phone_line_text: '',
          phone: reviewedPhone,
          address: '',
          province: null,
          city: null,
          district: null,
          controls: [{ text: '去发货', action: 'ship' }],
        },
      }, 'request-recipient-local-recovery-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-recipient-local-recovery',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-recipient-local-recovery.png',
        originalName: '合成收件人本地恢复订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-recipient-local-recovery',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['shipping_information']);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人子',
      phone: '13900000011',
      phoneNormalized: '13900000011',
      addressOriginal: '测试省测试市示例区安全路11号',
    });
  });

  it('模型以对象返回未知功能控件时仍不会把控件文字保存为收件人', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      purchased_items: {
        items: [{
          title: '合成完整商品丑',
          spec: '规格L',
          unit_price: '20.00',
          price_tag_text: '¥20.00',
          quantity: '1',
          quantity_text: '×1',
        }],
        controls: [],
      },
      shipping_information: {
        recipient: '处理发运',
        recipient_phone_line_text: '',
        phone: '13900000012',
        address: '测试省测试市示例区安全路12号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        controls: [{ text: '处理发运', action: 'ship' }],
      },
      transaction_information: {
        detail_state: 'collapsed',
        order_number: 'XY-SYNTH-OBJECT-CONTROL-0001',
        alipay_transaction_number: null,
        product_total: '20.00',
        shipping_fee: '0.00',
        amount: '20.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        buyer_nickname_label: null,
        buyer_nickname: null,
        order_time: null,
        payment_time: null,
        controls: [],
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: [],
        excluded_regions: [],
      },
    }, `request-object-control-${request.mock.calls.length}`));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-object-control',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-object-control.png',
        originalName: '合成对象功能控件订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-object-control',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      recipient: '',
      phone: '13900000012',
      phoneNormalized: '13900000012',
    });
  });

  it('收件人字段含多个手机号且复核无效时不猜测姓名或手机号', async () => {
    const request = vi.fn(async (): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成完整商品卯',
              spec: '规格M',
              unit_price: '22.00',
              price_tag_text: '¥22.00',
              quantity: '1',
              quantity_text: '×1',
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '合成收件人卯 13900000014 13800000014 | 复制',
            recipient_phone_line_text: '',
            phone: null,
            address: '测试省测试市示例区安全路14号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: ['复制', '去发货'],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-AMBIGUOUS-CONTACT-0001',
            alipay_transaction_number: null,
            product_total: '22.00',
            shipping_fee: '0.00',
            amount: '22.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: [],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家', '取消订单', '去发货'],
            excluded_regions: [],
          },
        }, 'request-ambiguous-contact-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          recipient: '去发货',
          recipient_phone_line_text: '',
          phone: null,
          address: null,
          province: null,
          city: null,
          district: null,
          controls: ['去发货'],
        },
      }, 'request-ambiguous-contact-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-ambiguous-contact',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-ambiguous-contact.png',
        originalName: '合成多手机号收件人订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-ambiguous-contact',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      recipient: '',
      phone: '',
      phoneNormalized: '',
    });
  });

  it('首轮同时缺失商品与收货信息时在唯一复核中合并修复两个模块', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          shipping_information: {
            controls: ['复制', '去发货'],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-PRODUCT-ONLY-REPAIR-0001',
            alipay_transaction_number: null,
            product_total: '30.00',
            shipping_fee: '0.00',
            amount: '30.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: ['展开'],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家', '取消订单', '去发货'],
            excluded_regions: ['合成广告横幅'],
          },
        }, 'request-product-only-repair-primary');
      }

      return successfulKieResponse({
        purchased_items: {
          items: [{
            title: '合成定向修复商品',
            spec: '规格C',
            unit_price: '15.00',
            price_tag_text: '¥15.00',
            quantity: '2',
            quantity_text: '×2',
          }],
          controls: [],
        },
        shipping_information: {
          recipient: '合成收件人寅',
          recipient_phone_line_text: '合成收件人寅 13900000013',
          phone: '13900000013',
          address: '测试省测试市示例区安全路13号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          controls: ['复制', '去发货'],
        },
      }, 'request-product-only-repair-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-product-only-repair',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-product-only-repair.png',
        originalName: '合成商品定向修复订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-product-only-repair',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    const secondSchema = secondBody.parameters.ocr_options.task_config.result_schema;
    expect(Object.keys(secondSchema)).toEqual([
      'purchased_items',
      'shipping_information',
    ]);
    expect(secondSchema).not.toHaveProperty('transaction_information');
    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-PRODUCT-ONLY-REPAIR-0001',
      recipient: '合成收件人寅',
      phone: '13900000013',
      phoneNormalized: '13900000013',
      addressOriginal: '测试省测试市示例区安全路13号',
      productTotalCents: 3_000,
      amountCents: 3_000,
      items: [{
        sourceTitle: '合成定向修复商品',
        sourceSpec: '规格C',
        unitPriceCents: 1_500,
        quantity: 2,
        quantityInferred: false,
      }],
    });
  });

  it('模块化商品数量属性整体缺失时定向复核并恢复明确数量', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成数量待复核商品',
              spec: '规格D',
              unit_price: '9.00',
              price_tag_text: '¥9.00',
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '合成收件人丙',
            recipient_phone_line_text: '合成收件人丙 13900000003',
            phone: '13900000003',
            address: '测试省测试市示例区安全路3号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: ['复制'],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-MISSING-QUANTITY-0001',
            alipay_transaction_number: null,
            product_total: '18.00',
            shipping_fee: '0.00',
            amount: '18.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: ['展开'],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家'],
            excluded_regions: [],
          },
        }, 'request-missing-quantity-primary');
      }

      return successfulKieResponse({
        purchased_items: {
          items: [{
            title: '合成数量待复核商品',
            spec: '规格D',
            unit_price: '9.00',
            price_tag_text: '¥9.00',
            quantity: null,
            quantity_text: '×2',
          }],
          controls: [],
        },
      }, 'request-missing-quantity-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-missing-quantity',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-missing-quantity.png',
        originalName: '合成数量属性缺失订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-missing-quantity',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['purchased_items']);
    expect(attempt.result.items).toEqual([{
      sourceTitle: '合成数量待复核商品',
      sourceSpec: '规格D',
      unitPriceCents: 900,
      quantity: 2,
      quantityInferred: false,
    }]);
  });

  it('模块化商品数量明确为空时不复核并默认数量为一', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse({
      purchased_items: {
        items: [{
          title: '合成未显示数量商品',
          spec: '规格E',
          unit_price: '11.00',
          price_tag_text: '¥11.00',
          quantity: null,
          quantity_text: null,
        }],
        controls: [],
      },
      shipping_information: {
        recipient: '合成收件人丁',
        recipient_phone_line_text: '合成收件人丁 13900000004',
        phone: '13900000004',
        address: '测试省测试市示例区安全路4号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        controls: ['复制'],
      },
      transaction_information: {
        detail_state: 'collapsed',
        order_number: 'XY-SYNTH-NULL-QUANTITY-0001',
        alipay_transaction_number: null,
        product_total: '11.00',
        shipping_fee: '0.00',
        amount: '11.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        buyer_nickname_label: null,
        buyer_nickname: null,
        order_time: null,
        payment_time: null,
        controls: ['展开'],
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家'],
        excluded_regions: [],
      },
    }, 'request-null-quantity-primary'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-null-quantity',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-null-quantity.png',
        originalName: '合成明确无数量订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-null-quantity',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(attempt.result.items).toEqual([{
      sourceTitle: '合成未显示数量商品',
      sourceSpec: '规格E',
      unitPriceCents: 1_100,
      quantity: 1,
      quantityInferred: true,
    }]);
  });

  it('模块化收货信息缺失时唯一一次复核只恢复收货模块', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成收货复核商品',
              spec: '规格F',
              unit_price: '13.00',
              quantity: null,
              quantity_text: null,
            }],
            controls: [],
          },
          shipping_information: {
            controls: ['复制', '去发货'],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-SHIPPING-REPAIR-0001',
            alipay_transaction_number: null,
            product_total: '13.00',
            shipping_fee: '0.00',
            amount: '13.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: ['展开'],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家'],
            excluded_regions: [],
          },
        }, 'request-modular-shipping-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          recipient: '合成收件人戊',
          recipient_phone_line_text: '合成收件人戊 13900000005',
          phone: '13900000005',
          address: '测试省测试市示例区安全路5号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          controls: ['复制', '去发货'],
        },
      }, 'request-modular-shipping-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-modular-shipping-review',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-modular-shipping-review.png',
        originalName: '合成收货模块复核订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-modular-shipping-review',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['shipping_information']);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人戊',
      phone: '13900000005',
      phoneNormalized: '13900000005',
      addressOriginal: '测试省测试市示例区安全路5号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
    });
  });

  it('独立收货复核只返回姓名、纯手机号同行文本、地址和按钮时保留完整结果', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成独立收货复核商品',
              spec: '规格独',
              unit_price: '18.00',
              quantity: null,
              quantity_text: null,
            }],
            controls: [],
          },
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
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-ISOLATED-SHIPPING-0001',
            alipay_transaction_number: null,
            product_total: '18.00',
            shipping_fee: '0.00',
            amount: '18.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: ['展开'],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['去发货'],
            excluded_regions: [],
          },
        }, 'request-isolated-shipping-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          recipient: '合成收件人独',
          recipient_phone_line_text: '13900000018',
          address: '测试省测试市示例区安全路18号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          controls: ['复制', '去发货'],
        },
      }, 'request-isolated-shipping-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-isolated-shipping',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-isolated-shipping.png',
        originalName: '合成独立收货复核.png',
        mimeType: 'image/png',
        sha256: 'synthetic-isolated-shipping',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['shipping_information']);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人独',
      phone: '13900000018',
      phoneNormalized: '13900000018',
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
    });
  });

  it('收货信息和折叠订单号同时缺失时在唯一复核中请求两个模块', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成双模块复核商品',
              spec: '规格L',
              unit_price: '18.00',
              quantity: null,
              quantity_text: null,
            }],
            controls: [],
          },
          shipping_information: {
            recipient: null,
            recipient_phone_line_text: null,
            phone: null,
            address: null,
            province: null,
            city: null,
            district: null,
            controls: ['复制', '去发货'],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: null,
            alipay_transaction_number: null,
            product_total: '18.00',
            shipping_fee: '0.00',
            amount: '18.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: ['展开'],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家'],
            excluded_regions: [],
          },
        }, 'request-shipping-transaction-primary');
      }

      return successfulKieResponse({
        shipping_information: {
          recipient: '合成收件人双',
          recipient_phone_line_text: '合成收件人双 13900000011',
          phone: '13900000011',
          address: '测试省测试市示例区安全路11号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          controls: ['复制', '去发货'],
        },
        transaction_information: {
          detail_state: 'collapsed',
          order_number: 'XY-SYNTH-SHIPPING-TRANSACTION-0001',
          alipay_transaction_number: null,
          product_total: '18.00',
          shipping_fee: '0.00',
          amount: '18.00',
          platform_transaction_status: 'paid',
          fulfillment_status: 'pending_shipment',
          buyer_nickname_label: null,
          buyer_nickname: null,
          order_time: null,
          payment_time: null,
          controls: ['展开'],
        },
      }, 'request-shipping-transaction-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-shipping-transaction-review',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-shipping-transaction-review.png',
        originalName: '合成收货与交易双模块复核.png',
        mimeType: 'image/png',
        sha256: 'synthetic-shipping-transaction-review',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['shipping_information', 'transaction_information']);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人双',
      phoneNormalized: '13900000011',
      orderNumber: 'XY-SYNTH-SHIPPING-TRANSACTION-0001',
    });
  });

  it('交易与页头证据缺失时优先模块复核且不混入根级页头字段', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成交易复核商品',
              spec: '规格G',
              unit_price: '21.00',
              quantity: null,
              quantity_text: null,
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '合成收件人己',
            recipient_phone_line_text: '合成收件人己 13900000006',
            phone: '13900000006',
            address: '测试省测试市示例区安全路6号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: ['复制'],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: 'XY-SYNTH-TRANSACTION-REPAIR-0001',
            controls: ['展开'],
          },
          page_context: {
            global_controls: ['联系买家', '去发货'],
            excluded_regions: [],
          },
        }, 'request-modular-transaction-primary');
      }

      return successfulKieResponse({
        transaction_information: {
          detail_state: 'collapsed',
          order_number: 'XY-SYNTH-TRANSACTION-REPAIR-0001',
          alipay_transaction_number: 'ALI-SYNTH-TRANSACTION-REPAIR-0001',
          product_total: '21.00',
          shipping_fee: '2.00',
          amount: '23.00',
          platform_transaction_status: 'paid',
          fulfillment_status: 'pending_shipment',
          buyer_nickname_label: null,
          buyer_nickname: null,
          order_time: null,
          payment_time: null,
          controls: ['展开'],
        },
      }, 'request-modular-transaction-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-modular-transaction-review',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-modular-transaction-review.png',
        originalName: '合成交易模块复核订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-modular-transaction-review',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['transaction_information']);
    expect(
      secondBody.parameters.ocr_options.task_config.result_schema,
    ).not.toHaveProperty('page_header_status_text');
    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-TRANSACTION-REPAIR-0001',
      alipayTransactionNumber: 'ALI-SYNTH-TRANSACTION-REPAIR-0001',
      productTotalCents: 2_100,
      shippingFeeCents: 200,
      amountCents: 2_300,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
    });
  });

  it('模块化交易详情展开时空订单号只复核交易模块', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成展开交易商品',
              spec: '规格H',
              unit_price: '25.00',
              quantity: null,
              quantity_text: null,
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '合成收件人庚',
            recipient_phone_line_text: '合成收件人庚 13900000007',
            phone: '13900000007',
            address: '测试省测试市示例区安全路7号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: ['复制'],
          },
          transaction_information: {
            detail_state: 'expanded',
            order_number: null,
            alipay_transaction_number: 'ALI-SYNTH-EXPANDED-IDENTITY-0001',
            product_total: '25.00',
            shipping_fee: '0.00',
            amount: '25.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: '买家昵称',
            buyer_nickname: 's***7',
            order_time: '2026-07-29 09:10:11',
            payment_time: '2026-07-29 09:10:21',
            controls: ['交易快照', '复制', '收起'],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家'],
            excluded_regions: [],
          },
        }, 'request-expanded-null-order-number-primary');
      }

      return successfulKieResponse({
        transaction_information: {
          detail_state: 'expanded',
          order_number: 'XY-SYNTH-EXPANDED-IDENTITY-0001',
          alipay_transaction_number: 'ALI-SYNTH-EXPANDED-IDENTITY-0001',
          product_total: '25.00',
          shipping_fee: '0.00',
          amount: '25.00',
          platform_transaction_status: 'paid',
          fulfillment_status: 'pending_shipment',
          buyer_nickname_label: '买家昵称',
          buyer_nickname: 's***7',
          order_time: '2026-07-29 09:10:11',
          payment_time: '2026-07-29 09:10:21',
          controls: ['交易快照', '复制', '收起'],
        },
      }, 'request-expanded-null-order-number-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-expanded-null-order-number',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-expanded-null-order-number.png',
        originalName: '合成展开交易缺订单号.png',
        mimeType: 'image/png',
        sha256: 'synthetic-expanded-null-order-number',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['transaction_information']);
    expect(attempt.result.orderNumber).toBe('XY-SYNTH-EXPANDED-IDENTITY-0001');
  });

  it('模块化交易详情展开时昵称属性缺失只复核交易模块', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成展开昵称复核商品',
              spec: '规格J',
              unit_price: '28.00',
              quantity: null,
              quantity_text: null,
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '合成收件人壬',
            recipient_phone_line_text: '合成收件人壬 13900000009',
            phone: '13900000009',
            address: '测试省测试市示例区安全路9号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: ['复制'],
          },
          transaction_information: {
            detail_state: 'expanded',
            order_number: 'XY-SYNTH-EXPANDED-BUYER-0001',
            alipay_transaction_number: 'ALI-SYNTH-EXPANDED-BUYER-0001',
            product_total: '28.00',
            shipping_fee: '0.00',
            amount: '28.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            order_time: '2026-07-29 10:20:31',
            payment_time: '2026-07-29 10:20:41',
            controls: ['交易快照', '复制', '收起'],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家'],
            excluded_regions: [],
          },
        }, 'request-expanded-missing-buyer-primary');
      }

      return successfulKieResponse({
        transaction_information: {
          detail_state: 'expanded',
          order_number: 'XY-SYNTH-EXPANDED-BUYER-0001',
          alipay_transaction_number: 'ALI-SYNTH-EXPANDED-BUYER-0001',
          product_total: '28.00',
          shipping_fee: '0.00',
          amount: '28.00',
          platform_transaction_status: 'paid',
          fulfillment_status: 'pending_shipment',
          buyer_nickname_label: '买家昵称',
          buyer_nickname: 'm***9',
          order_time: '2026-07-29 10:20:31',
          payment_time: '2026-07-29 10:20:41',
          controls: ['交易快照', '复制', '收起'],
        },
      }, 'request-expanded-missing-buyer-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-expanded-missing-buyer',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-expanded-missing-buyer.png',
        originalName: '合成展开交易缺昵称属性.png',
        mimeType: 'image/png',
        sha256: 'synthetic-expanded-missing-buyer',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['transaction_information']);
    expect(attempt.result.buyerNickname).toBe('m***9');
  });

  it('模块化交易详情折叠时订单号为空仍复核交易模块而允许隐藏字段为空', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          purchased_items: {
            items: [{
              title: '合成折叠交易商品',
              spec: '规格I',
              unit_price: '26.00',
              quantity: null,
              quantity_text: null,
            }],
            controls: [],
          },
          shipping_information: {
            recipient: '合成收件人辛',
            recipient_phone_line_text: '合成收件人辛 13900000008',
            phone: '13900000008',
            address: '测试省测试市示例区安全路8号',
            province: '测试省',
            city: '测试市',
            district: '示例区',
            controls: ['复制'],
          },
          transaction_information: {
            detail_state: 'collapsed',
            order_number: null,
            alipay_transaction_number: null,
            product_total: '26.00',
            shipping_fee: '0.00',
            amount: '26.00',
            platform_transaction_status: 'paid',
            fulfillment_status: 'pending_shipment',
            buyer_nickname_label: null,
            buyer_nickname: null,
            order_time: null,
            payment_time: null,
            controls: ['展开'],
          },
          page_context: {
            top_status_text: '买家已付款，请尽快发货',
            global_controls: ['联系买家'],
            excluded_regions: [],
          },
        }, 'request-collapsed-null-order-number-primary');
      }

      return successfulKieResponse({
        transaction_information: {
          detail_state: 'collapsed',
          order_number: 'XY-SYNTH-COLLAPSED-IDENTITY-0001',
          alipay_transaction_number: null,
          product_total: '26.00',
          shipping_fee: '0.00',
          amount: '26.00',
          platform_transaction_status: 'paid',
          fulfillment_status: 'pending_shipment',
          buyer_nickname_label: null,
          buyer_nickname: null,
          order_time: null,
          payment_time: null,
          controls: ['展开'],
        },
      }, 'request-collapsed-null-order-number-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-collapsed-null-hidden-fields',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-collapsed-null-hidden-fields.png',
        originalName: '合成折叠交易隐藏字段.png',
        mimeType: 'image/png',
        sha256: 'synthetic-collapsed-null-hidden-fields',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual(['transaction_information']);
    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-COLLAPSED-IDENTITY-0001',
      alipayTransactionNumber: '',
      buyerNickname: '',
      orderedAtOriginal: '',
      paidAtOriginal: '',
      productTotalCents: 2_600,
      shippingFeeCents: 0,
      amountCents: 2_600,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
    });
  });

  it('结构化订单号漏识别时从 fenced JSON 的同名字段安全恢复', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      purchased_items: {
        items: [{
          title: '合成订单号兜底商品',
          spec: '规格K',
          unit_price: '27.00',
          quantity: null,
          quantity_text: null,
        }],
        controls: [],
      },
      shipping_information: {
        recipient: '合成收件人壬',
        recipient_phone_line_text: '合成收件人壬 13900000009',
        phone: '13900000009',
        address: '测试省测试市示例区安全路9号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        controls: ['复制'],
      },
      transaction_information: {
        detail_state: 'collapsed',
        order_number: 1234567890,
        alipay_transaction_number: null,
        product_total: '27.00',
        shipping_fee: '0.00',
        amount: '27.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        buyer_nickname_label: null,
        buyer_nickname: null,
        order_time: null,
        payment_time: null,
        controls: ['展开'],
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家'],
        excluded_regions: [],
      },
    }, 'request-processed-text-order-number', fencedProcessedJson({
      transaction_information: {
        order_number: '8800123456789012345',
      },
    })));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-processed-text-order-number',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-processed-text-order-number.png',
        originalName: '合成订单号原文兜底.png',
        mimeType: 'image/png',
        sha256: 'synthetic-processed-text-order-number',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(attempt.result.orderNumber).toBe('8800123456789012345');
  });

  it('展开详情同时漏掉收货信息和单价时在唯一复核中保留两个异常模块', async () => {
    const responses = [
      {
        output: {
          choices: [{
            finish_reason: 'stop',
            message: {
              content: [{
                ocr_result: {
                  kv_result: {
                    order_number: 'XY-SYNTH-EXPANDED-0001',
                    alipay_transaction_number: 'ALI-SYNTH-EXPANDED-0001',
                    buyer_nickname_label: '买家昵称',
                    buyer_nickname: 'x***4',
                    recipient: 'null',
                    phone: 'null',
                    address: 'null',
                    province: 'null',
                    city: 'null',
                    district: 'null',
                    order_time: '2026-07-27 11:21:46',
                    payment_time: '2026-07-27 11:21:54',
                    product_total: '8.00',
                    shipping_fee: '0.00',
                    amount: '8.00',
                    platform_transaction_status: 'paid',
                    fulfillment_status: 'pending_shipment',
                    items: [{
                      title: '合成测试商品甲',
                      spec: '规格A',
                      unit_price: 'null',
                      quantity: 'null',
                    }],
                  },
                },
              }],
            },
          }],
        },
        request_id: 'request-expanded-primary',
      },
      {
        output: {
          choices: [{
            finish_reason: 'stop',
            message: {
              content: [{
                ocr_result: {
                  kv_result: {
                    order_product_section: {
                      items: [{
                        title: '合成测试商品甲',
                        spec: '规格A',
                        unit_price: '8.00',
                        price_tag_text: '¥8.00',
                        quantity: null,
                        quantity_text: null,
                      }],
                    },
                    shipping_contact: {
                      recipient: '合成收件人甲',
                      phone: '13900000001',
                      address: '测试省测试市示例区安全路1号',
                      province: '测试省',
                      city: '测试市',
                      district: '示例区',
                      contact_line_text: '合成收件人甲 13900000001',
                    },
                    buyer_section: {
                      label_text: '买家昵称',
                      buyer_nickname: 'x***4',
                    },
                    page_controls: {
                      labels: ['复制'],
                    },
                  },
                },
              }],
            },
          }],
        },
        request_id: 'request-expanded-review',
      },
    ];
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => new Response(
      JSON.stringify(responses.shift()),
      { status: 200 },
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-expanded',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-expanded.png',
        originalName: '合成展开订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-expanded',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.evidences.map(({ requestId }) => requestId)).toEqual([
      'request-expanded-primary',
      'request-expanded-review',
    ]);
    expect(attempt.result).toMatchObject({
      buyerNickname: 'x***4',
      recipient: '合成收件人甲',
      phoneNormalized: '13900000001',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      amountCents: 800,
      items: [expect.objectContaining({
        unitPriceCents: 800,
        quantity: 1,
        quantityInferred: true,
      })],
    });

    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: { ocr_options: { task_config: { result_schema: object } } };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual([
      'order_product_section',
      'shipping_contact',
      'buyer_section',
      'page_controls',
    ]);
  });

  it('折叠订单首轮同时缺少收货人、商品和金额时保留全部异常模块', async () => {
    const primaryResult = {
      order_number: 'XY-SYNTH-FOLDED-0001',
      alipay_transaction_number: 'ALI-SYNTH-FOLDED-0001',
      buyer_nickname_label: null,
      buyer_nickname: null,
      recipient: null,
      recipient_phone_line_text: null,
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      order_time: '2026-07-27 11:21:46',
      payment_time: '2026-07-27 11:21:54',
    };
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse(
          primaryResult,
          'request-folded-primary-stopped-after-payment-time',
        );
      }

      return successfulKieResponse({
        order_product_section: {
          items: [{
            title: '合成折叠订单商品',
            spec: '商务蓝·标准款',
            unit_price: '12.00',
            price_tag_text: '¥12.00',
            quantity: '2',
            quantity_text: '×2',
          }],
        },
        shipping_contact: {
          recipient: '合成收件人甲',
          phone: '13900000001',
          address: '测试省测试市示例区安全路1号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          contact_line_text: '合成收件人甲 13900000001',
        },
        buyer_section: {
          label_text: null,
          buyer_nickname: null,
        },
        page_controls: {
          labels: ['复制'],
        },
        amounts: {
          product_total: '24.00',
          shipping_fee: '0.00',
          amount: '24.00',
        },
        order_identity: {
          order_number: 'XY-SYNTH-FOLDED-0001',
          alipay_transaction_number: 'ALI-SYNTH-FOLDED-0001',
        },
        page_context: {
          top_status_text: '买家已付款，请尽快发货',
          global_controls: ['去发货'],
          excluded_regions: [],
        },
      }, 'request-folded-targeted-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-folded-order',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-folded-order.png',
        originalName: '合成折叠订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-folded-order',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual([
      'order_product_section',
      'shipping_contact',
      'buyer_section',
      'page_controls',
      'amounts',
      'order_identity',
      'page_context',
    ]);
    expect(attempt.result).toMatchObject({
      recipient: '合成收件人甲',
      phoneNormalized: '13900000001',
      productTotalCents: 2_400,
      amountCents: 2_400,
      items: [{
        sourceTitle: '合成折叠订单商品',
        sourceSpec: '商务蓝·标准款',
        unitPriceCents: 1_200,
        quantity: 2,
        quantityInferred: false,
      }],
    });
  });

  it('扁平首轮同时缺联系人、商品、订单号和金额时唯一复核保留全部异常模块', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse({
          order_number: null,
          alipay_transaction_number: null,
          buyer_nickname_label: null,
          buyer_nickname: null,
          recipient: null,
          recipient_phone_line_text: null,
          phone: null,
          address: null,
          province: null,
          city: null,
          district: null,
          order_time: null,
          payment_time: null,
          product_total: null,
          shipping_fee: null,
          amount: null,
          platform_transaction_status: null,
          fulfillment_status: null,
          items: [],
        }, 'request-flat-all-modules-primary');
      }

      return successfulKieResponse({
        order_product_section: {
          items: [{
            title: '合成扁平全模块商品',
            spec: '规格全',
            unit_price: '23.00',
            price_tag_text: '¥23.00',
            quantity: '1',
            quantity_text: '×1',
          }],
        },
        shipping_contact: {
          recipient: '合成收件人全',
          phone: '13900000043',
          address: '测试省测试市示例区安全路43号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          contact_line_text: '合成收件人全 13900000043',
        },
        buyer_section: {
          label_text: null,
          buyer_nickname: null,
        },
        page_controls: {
          labels: ['复制', '去发货'],
        },
        amounts: {
          product_total: '23.00',
          shipping_fee: '0.00',
          amount: '23.00',
        },
        order_identity: {
          order_number: 'XY-SYNTH-FLAT-ALL-MODULES-0001',
          alipay_transaction_number: null,
        },
        page_context: {
          top_status_text: '买家已付款，请尽快发货',
          global_controls: ['去发货'],
          excluded_regions: [],
        },
      }, 'request-flat-all-modules-review');
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-flat-all-modules',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-flat-all-modules.png',
        originalName: '合成扁平全模块缺失订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-flat-all-modules',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: {
          task_config: { result_schema: Record<string, unknown> };
        };
      };
    };
    expect(Object.keys(
      secondBody.parameters.ocr_options.task_config.result_schema,
    )).toEqual([
      'order_product_section',
      'shipping_contact',
      'buyer_section',
      'page_controls',
      'amounts',
      'order_identity',
      'page_context',
    ]);
    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-FLAT-ALL-MODULES-0001',
      recipient: '合成收件人全',
      phoneNormalized: '13900000043',
      productTotalCents: 2_300,
      amountCents: 2_300,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [{
        sourceTitle: '合成扁平全模块商品',
        sourceSpec: '规格全',
        unitPriceCents: 2_300,
        quantity: 1,
        quantityInferred: false,
      }],
    });
  });

  it('复核明确看到买家昵称标签时纠正身份错位和金额漏识别', async () => {
    const responses = [
      {
        output: {
          choices: [{
            finish_reason: 'stop',
            message: {
              content: [{
                ocr_result: {
                  kv_result: {
                    order_number: 'XY-SYNTH-COLLAPSED-0001',
                    buyer_nickname: '陈测试',
                    recipient: null,
                    phone: '13900000001',
                    address: '测试省测试市示例区安全路1号',
                    province: '测试省',
                    city: '测试市',
                    district: '示例区',
                    product_total: '16.00',
                    shipping_fee: '0.00',
                    amount: null,
                    platform_transaction_status: 'paid',
                    fulfillment_status: 'pending_shipment',
                    items: [{
                      title: '合成测试商品乙',
                      spec: '规格B',
                      unit_price: null,
                      quantity: '×2',
                    }],
                  },
                },
              }],
            },
          }],
        },
        request_id: 'request-collapsed-primary',
      },
      {
        output: {
          choices: [{
            finish_reason: 'stop',
            message: {
              content: [{
                ocr_result: {
                  kv_result: {
                    shipping_contact: {
                      recipient: '陈测试',
                      phone: '13900000001',
                      address: '测试省测试市示例区安全路1号',
                    },
                    buyer_section: {
                      label_text: '买家昵称',
                      buyer_nickname: 'x***4',
                    },
                    amounts: {
                      product_total: '16.00',
                      shipping_fee: '0.00',
                      amount: '16.00',
                    },
                    items: [{
                      title: '合成测试商品乙',
                      spec: '规格B',
                      unit_price: '8.00',
                      quantity: '×2',
                    }],
                  },
                },
              }],
            },
          }],
        },
        request_id: 'request-collapsed-review',
      },
    ];
    const request = vi.fn(async (): Promise<Response> => new Response(
      JSON.stringify(responses.shift()),
      { status: 200 },
    ));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-collapsed',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-collapsed.png',
        originalName: '合成未展开订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-collapsed',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      buyerNickname: 'x***4',
      recipient: '陈测试',
      amountCents: 1_600,
      items: [expect.objectContaining({
        unitPriceCents: 800,
        quantity: 2,
        quantityInferred: false,
      })],
    });
  });

  it('折叠详情没有买家昵称标签时把首轮错位姓名归回收件人并清空昵称', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-COLLAPSED-NO-BUYER-0001',
        buyer_nickname_label: null,
        buyer_nickname: '合成收件人甲',
        recipient: null,
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{
          title: '合成订单商品',
          spec: '规格A',
          unit_price: '8.00',
          quantity: null,
        }],
      }, 'request-collapsed-no-buyer-primary'),
      successfulKieResponse({
        shipping_contact: {
          recipient: null,
          phone: null,
          address: null,
          contact_line_text: '合成收件人甲 13900000001 复制',
        },
        buyer_section: {
          label_text: null,
          buyer_nickname: null,
        },
      }, 'request-collapsed-no-buyer-review'),
    ];
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-collapsed-no-buyer',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-collapsed-no-buyer.png',
        originalName: '合成折叠订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-collapsed-no-buyer',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      buyerNickname: '',
      recipient: '合成收件人甲',
      phoneNormalized: '13900000001',
    });
  });

  it('折叠详情复核只返回手机号行时不接受无法交叉验证的姓名', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-COLLAPSED-UNVERIFIED-CONTACT-0001',
        buyer_nickname_label: null,
        buyer_nickname: '合成候选姓名',
        recipient: null,
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{
          title: '合成订单商品',
          spec: null,
          unit_price: '8.00',
          quantity: null,
        }],
      }, 'request-unverified-contact-primary'),
      successfulKieResponse({
        shipping_contact: {
          recipient: '合成未验证姓名',
          phone: '13900000001',
          address: null,
          contact_line_text: '13900000001',
        },
        buyer_section: {
          label_text: null,
          buyer_nickname: null,
        },
      }, 'request-unverified-contact-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-unverified-contact',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-unverified-contact.png',
        originalName: '合成缺少联系信息行.png',
        mimeType: 'image/png',
        sha256: 'synthetic-unverified-contact',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      buyerNickname: '',
      recipient: '',
    });
  });

  it('没有买家昵称标签时不接受任何昵称候选', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      order_number: 'XY-SYNTH-NO-BUYER-LABEL-0001',
      buyer_nickname_label: null,
      buyer_nickname: 'x***4',
      recipient: '合成收件人甲',
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      product_total: '8.00',
      shipping_fee: '0.00',
      amount: '8.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{
        title: '合成订单商品',
        spec: null,
        unit_price: '8.00',
        quantity: null,
      }],
    }, 'request-no-buyer-label'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-no-buyer-label',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-no-buyer-label.png',
        originalName: '合成无买家标签订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-no-buyer-label',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(attempt.result).toMatchObject({
      buyerNickname: '',
      recipient: '合成收件人甲',
    });
  });

  it('页面功能按钮不能作为收件人进入订单结果', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      order_number: 'XY-SYNTH-UI-CONTROL-RECIPIENT-0001',
      buyer_nickname_label: null,
      buyer_nickname: null,
      recipient: '去发货',
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      product_total: '8.00',
      shipping_fee: '0.00',
      amount: '8.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{
        title: '合成订单商品',
        spec: null,
        unit_price: '8.00',
        quantity: null,
      }],
    }, 'request-ui-control-recipient'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-ui-control-recipient',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-ui-control-recipient.png',
        originalName: '合成功能按钮收件人.png',
        mimeType: 'image/png',
        sha256: 'synthetic-ui-control-recipient',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result).toMatchObject({
      buyerNickname: '',
      recipient: '',
    });
  });

  it('模型归类为页面控件的未知文字也不能作为收件人', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      order_number: 'XY-SYNTH-CLASSIFIED-UI-CONTROL-0001',
      buyer_nickname_label: null,
      buyer_nickname: null,
      recipient: '开始配送',
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      page_controls: { labels: ['开始配送'] },
      province: '测试省',
      city: '测试市',
      district: '示例区',
      product_total: '8.00',
      shipping_fee: '0.00',
      amount: '8.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{
        title: '合成订单商品',
        spec: null,
        unit_price: '8.00',
        quantity: null,
      }],
    }, 'request-classified-ui-control'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-classified-ui-control',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-classified-ui-control.png',
        originalName: '合成未知功能按钮.png',
        mimeType: 'image/png',
        sha256: 'synthetic-classified-ui-control',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result.recipient).toBe('');
  });

  it('联系人行证据可以纠正模型把真实姓名误列为页面控件', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-FALSE-CONTROL-RECIPIENT-0001',
        buyer_nickname_label: null,
        buyer_nickname: null,
        recipient: '合成收件人甲',
        recipient_phone_line_text: '复制',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        page_controls: { labels: ['合成收件人甲'] },
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{
          title: '合成订单商品',
          spec: null,
          unit_price: '8.00',
          quantity: null,
        }],
      }, 'request-false-control-primary'),
      successfulKieResponse({
        shipping_contact: {
          recipient: '合成收件人甲',
          phone: '13900000001',
          address: '测试省测试市示例区安全路1号',
          contact_line_text: '合成收件人甲 13900000001 复制',
        },
        buyer_section: {
          label_text: null,
          buyer_nickname: null,
        },
        page_controls: { labels: ['合成收件人甲', '复制'] },
      }, 'request-false-control-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-false-control-recipient',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-false-control-recipient.png',
        originalName: '合成姓名误列控件.png',
        mimeType: 'image/png',
        sha256: 'synthetic-false-control-recipient',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result.recipient).toBe('合成收件人甲');
  });

  it('首轮收件人被按钮污染时采用复核确认的真实联系人', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-UI-CONTROL-REVIEW-0001',
        buyer_nickname_label: '复制',
        buyer_nickname: '取消订单',
        recipient: '去发货',
        phone: null,
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{
          title: '合成订单商品',
          spec: null,
          unit_price: '8.00',
          quantity: null,
        }],
      }, 'request-ui-control-review-primary'),
      successfulKieResponse({
        shipping_contact: {
          recipient: '合成收件人甲',
          phone: '13900000001',
          address: '测试省测试市示例区安全路1号',
          contact_line_text: '复制',
        },
        buyer_section: {
          label_text: '去发货',
          buyer_nickname: null,
        },
      }, 'request-ui-control-review-confirmation'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-ui-control-review',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-ui-control-review.png',
        originalName: '合成按钮污染复核.png',
        mimeType: 'image/png',
        sha256: 'synthetic-ui-control-review',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      buyerNickname: '',
      recipient: '合成收件人甲',
      phoneNormalized: '13900000001',
    });
  });

  it('手机号后方的未知操作文字不能成为复核收件人', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-UNKNOWN-ACTION-POSITION-0001',
        buyer_nickname_label: null,
        buyer_nickname: null,
        recipient: null,
        phone: null,
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{
          title: '合成订单商品',
          spec: null,
          unit_price: '8.00',
          quantity: null,
        }],
      }, 'request-unknown-action-primary'),
      successfulKieResponse({
        shipping_contact: {
          recipient: '处理发运',
          phone: '13900000001',
          address: '测试省测试市示例区安全路1号',
          contact_line_text: '合成收件人甲 13900000001 处理发运',
        },
        buyer_section: {
          label_text: null,
          buyer_nickname: null,
        },
      }, 'request-unknown-action-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-unknown-action-position',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-unknown-action-position.png',
        originalName: '合成未知操作位置.png',
        mimeType: 'image/png',
        sha256: 'synthetic-unknown-action-position',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result.recipient).toBe('');
  });

  it('带国家码的手机号后方未知操作文字也不能成为收件人', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-COUNTRY-CODE-ACTION-0001',
        recipient: null,
        phone: null,
        address: '测试省测试市示例区安全路1号',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{ title: '合成订单商品', unit_price: '8.00', quantity: null }],
      }, 'request-country-code-action-primary'),
      successfulKieResponse({
        shipping_contact: {
          recipient: '处理发运',
          phone: '+86 139 0000 0001',
          address: '测试省测试市示例区安全路1号',
          contact_line_text: '合成收件人甲 +86 139 0000 0001 处理发运',
        },
      }, 'request-country-code-action-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-country-code-action',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-country-code-action.png',
        originalName: '合成国家码按钮位置.png',
        mimeType: 'image/png',
        sha256: 'synthetic-country-code-action',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result.recipient).toBe('');
  });

  it('联系人位于手机号前方时允许合法单字姓名', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      order_number: 'XY-SYNTH-SINGLE-CHAR-RECIPIENT-0001',
      buyer_nickname_label: null,
      buyer_nickname: null,
      recipient: '王',
      recipient_phone_line_text: '王 13900000001',
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      product_total: '8.00',
      shipping_fee: '0.00',
      amount: '8.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{ title: '合成订单商品', unit_price: '8.00', quantity: null }],
    }, 'request-single-char-recipient'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-single-char-recipient',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-single-char-recipient.png',
        originalName: '合成单字收件人.png',
        mimeType: 'image/png',
        sha256: 'synthetic-single-char-recipient',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result.recipient).toBe('王');
  });

  it('只从订单商品区复核与首轮标题一致的右侧价签原文', async () => {
    const responses = [
      successfulKieResponse({
        purchased_items: {
          items: [{
            title: '合成订单商品甲',
            spec: '规格A',
            unit_price: null,
            price_tag_text: null,
            quantity: null,
            quantity_text: null,
          }],
          controls: [],
        },
        shipping_information: {
          recipient: '合成收件人甲',
          recipient_phone_line_text: '合成收件人甲 13900000001',
          phone: '13900000001',
          address: '测试省测试市示例区安全路1号',
          province: '测试省',
          city: '测试市',
          district: '示例区',
          controls: ['复制'],
        },
        transaction_information: {
          detail_state: 'collapsed',
          order_number: 'XY-SYNTH-ORDER-PRICE-0001',
          alipay_transaction_number: null,
          product_total: '8.00',
          shipping_fee: '0.00',
          amount: '8.00',
          platform_transaction_status: 'paid',
          fulfillment_status: 'pending_shipment',
          buyer_nickname_label: null,
          buyer_nickname: null,
          order_time: null,
          payment_time: null,
          controls: ['展开'],
        },
        page_context: {
          top_status_text: '买家已付款，请尽快发货',
          global_controls: ['联系买家'],
          excluded_regions: [],
        },
      }, 'request-order-price-primary'),
      successfulKieResponse({
        purchased_items: {
          items: [{
            title: '合成订单商品甲',
            spec: '规格A',
            unit_price: null,
            price_tag_text: '¥8.00',
            quantity: null,
            quantity_text: null,
          }],
          controls: [],
        },
      }, 'request-order-price-review'),
    ];
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-order-price',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-order-price.png',
        originalName: '合成订单商品单价.png',
        mimeType: 'image/png',
        sha256: 'synthetic-order-price',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result.items).toEqual([
      expect.objectContaining({ unitPriceCents: 800 }),
    ]);

    const secondBody = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      parameters: {
        ocr_options: { task_config: { result_schema: Record<string, unknown> } };
      };
    };
    const reviewSchema = secondBody.parameters.ocr_options.task_config.result_schema;
    expect(Object.keys(reviewSchema)).toEqual(['purchased_items']);
    expect(JSON.stringify(reviewSchema)).toContain('合成订单商品甲');
    expect(JSON.stringify(reviewSchema)).toContain('成交价');
    expect(JSON.stringify(reviewSchema)).toContain('推荐');
  });

  it('单商品复核价签缺少标题证据时拒绝合并价格', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-MISSING-REVIEW-TITLE-0001',
        buyer_nickname_label: '买家昵称',
        buyer_nickname: 'x***4',
        recipient: '合成收件人甲',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{
          title: '合成订单商品甲',
          spec: '规格A',
          unit_price: null,
          quantity: null,
        }],
      }, 'request-missing-review-title-primary'),
      successfulKieResponse({
        order_product_section: {
          items: [{
            title: null,
            spec: null,
            unit_price: null,
            price_tag_text: '¥99.00',
            quantity: null,
          }],
        },
      }, 'request-missing-review-title-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-missing-review-title',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-missing-review-title.png',
        originalName: '合成缺标题价签.png',
        mimeType: 'image/png',
        sha256: 'synthetic-missing-review-title',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result.items).toEqual([
      expect.objectContaining({
        sourceTitle: '合成订单商品甲',
        unitPriceCents: null,
      }),
    ]);
  });

  it('首轮返回有效商品价签时直接解析单价且不触发商品复核', async () => {
    const request = vi.fn(async (
      _input: string,
      _init?: RequestInit,
    ): Promise<Response> => successfulKieResponse({
      order_number: 'XY-SYNTH-PRIMARY-PRICE-TAG-0001',
      buyer_nickname_label: '买家昵称',
      buyer_nickname: 'x***4',
      recipient: '合成收件人甲',
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      product_total: '8.00',
      shipping_fee: '0.00',
      amount: '8.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{
        title: '合成订单商品甲',
        spec: '规格A',
        unit_price: null,
        price_tag_text: '￥8.00',
        quantity: null,
        quantity_text: null,
      }],
    }, 'request-primary-price-tag'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-primary-price-tag',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-primary-price-tag.png',
        originalName: '合成首轮价签.png',
        mimeType: 'image/png',
        sha256: 'synthetic-primary-price-tag',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(attempt.result.items).toEqual([
      expect.objectContaining({ unitPriceCents: 800 }),
    ]);

    const firstBody = JSON.parse(String(request.mock.calls[0][1]?.body)) as {
      parameters: {
        ocr_options: { task_config: { result_schema: Record<string, unknown> } };
      };
    };
    expect(JSON.stringify(
      firstBody.parameters.ocr_options.task_config.result_schema,
    )).toContain('price_tag_text');
  });

  it('首轮规范字段格式异常时采用有效原文且不触发商品复核', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      order_number: 'XY-SYNTH-RAW-ITEM-FALLBACK-0001',
      buyer_nickname_label: '买家昵称',
      buyer_nickname: 'x***4',
      recipient: '合成收件人甲',
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      product_total: '16.00',
      shipping_fee: '0.00',
      amount: '16.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{
        title: '合成订单商品甲',
        spec: '规格A',
        unit_price: '8元',
        price_tag_text: '¥8.00',
        quantity: '2.0',
        quantity_text: '×2',
      }],
    }, 'request-raw-item-fallback'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-raw-item-fallback',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-raw-item-fallback.png',
        originalName: '合成商品原文兜底.png',
        mimeType: 'image/png',
        sha256: 'synthetic-raw-item-fallback',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(attempt.result.items).toEqual([
      expect.objectContaining({
        unitPriceCents: 800,
        quantity: 2,
        quantityInferred: false,
      }),
    ]);
  });

  it('不把疑似买家昵称猜成收件人，并补拆地址、区分明确数量与默认数量', async () => {
    const request = vi.fn(async (): Promise<Response> => new Response(JSON.stringify({
      output: {
        choices: [{
          finish_reason: 'stop',
          message: {
            content: [{
              ocr_result: {
                kv_result: {
                  order_number: 'XY-SYNTH-REPAIR-0001',
                  alipay_transaction_number: 'ALI-SYNTH-REPAIR-0001',
                  buyer_nickname_label: '买家昵称',
                  buyer_nickname: '陈测试',
                  recipient: null,
                  phone: '13900000001',
                  address: '测试省测试市示例区安全路1号',
                  province: '测试',
                  city: '测试',
                  district: '示例',
                  order_time: null,
                  payment_time: null,
                  product_total: '3.00',
                  shipping_fee: '0.00',
                  amount: '3.00',
                  platform_transaction_status: 'paid',
                  fulfillment_status: 'pending_shipment',
                  items: [
                    {
                      title: '合成测试商品甲',
                      spec: null,
                      unit_price: '1.00',
                      quantity: '未显示',
                    },
                    {
                      title: '合成测试商品乙',
                      spec: null,
                      unit_price: '1.00',
                      quantity: '×2',
                    },
                  ],
                },
              },
            }],
          },
        }],
      },
      request_id: 'request-synthetic-repair',
    }), { status: 200 }));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-repair',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-order.png',
        originalName: '合成订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-sha256',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result).toMatchObject({
      buyerNickname: '陈测试',
      recipient: '',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      items: [
        expect.objectContaining({ quantity: 1, quantityInferred: true }),
        expect.objectContaining({ quantity: 2, quantityInferred: false }),
      ],
    });
  });

  it('收件人栏出现明显脱敏昵称时触发身份复核并纠正', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-MASKED-RECIPIENT-0001',
        buyer_nickname: null,
        recipient: 'x***4',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{
          title: '合成测试商品',
          spec: null,
          unit_price: '8.00',
          quantity: null,
        }],
      }, 'request-masked-recipient-primary'),
      successfulKieResponse({
        shipping_contact: {
          recipient: '陈测试',
          phone: '13900000001',
          address: '测试省测试市示例区安全路1号',
        },
        buyer_section: {
          label_text: '买家昵称',
          buyer_nickname: 'x***4',
        },
      }, 'request-masked-recipient-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-masked-recipient',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-masked-recipient.png',
        originalName: '合成身份错位订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-masked-recipient',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      buyerNickname: 'x***4',
      recipient: '陈测试',
    });
  });

  it('买家与收件人仅有全半角或空白差异时仍视为身份冲突', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-NORMALIZED-IDENTITY-0001',
        buyer_nickname_label: '买家昵称',
        buyer_nickname: '陈测试',
        recipient: ' 陈　测试 ',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{ title: '合成测试商品', spec: null, unit_price: '8.00', quantity: null }],
      }, 'request-normalized-identity-primary'),
      successfulKieResponse({
        shipping_contact: {
          recipient: '陈测试',
          phone: '13900000001',
          address: '测试省测试市示例区安全路1号',
        },
        buyer_section: {
          label_text: '买家昵称',
          buyer_nickname: 'x***4',
        },
      }, 'request-normalized-identity-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-normalized-identity',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-normalized-identity.png',
        originalName: '合成规范化身份订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-normalized-identity',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({ buyerNickname: 'x***4', recipient: '陈测试' });
  });

  it('独立收货复核没有买家字段时不把缺失当作否定证据', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-UNVERIFIED-BUYER-REVIEW-0001',
        buyer_nickname_label: '买家昵称',
        buyer_nickname: '合成同名姓名',
        recipient: '合成同名姓名',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{
          title: '合成订单商品',
          spec: null,
          unit_price: '8.00',
          quantity: null,
        }],
      }, 'request-unverified-buyer-primary'),
      successfulKieResponse({
        shipping_contact: {
          recipient: '合成同名姓名',
          phone: '13900000001',
          address: '测试省测试市示例区安全路1号',
        },
        buyer_section: {
          label_text: null,
          buyer_nickname: '合成同名姓名',
        },
      }, 'request-unverified-buyer-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-unverified-buyer-review',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-unverified-buyer-review.png',
        originalName: '合成未验证买家复核.png',
        mimeType: 'image/png',
        sha256: 'synthetic-unverified-buyer-review',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result).toMatchObject({
      buyerNickname: '合成同名姓名',
      recipient: '合成同名姓名',
    });
  });

  it('多商品复核缺少可核对标题时不按数组位置填入价格', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-MULTI-MERGE-0001',
        buyer_nickname: 'x***4',
        recipient: '合成收件人',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [
          { title: '合成商品甲', spec: null, unit_price: null, quantity: null },
          { title: '合成商品乙', spec: null, unit_price: null, quantity: null },
        ],
      }, 'request-multi-merge-primary'),
      successfulKieResponse({
        amounts: { product_total: '8.00', shipping_fee: '0.00', amount: '8.00' },
        items: [
          { title: null, spec: null, unit_price: '3.00', quantity: '1' },
          { title: '合成商品甲', spec: null, unit_price: '5.00', quantity: '1' },
        ],
      }, 'request-multi-merge-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-multi-merge',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-multi-merge.png',
        originalName: '合成多商品订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-multi-merge',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result.items.map(({ unitPriceCents }) => unitPriceCents)).toEqual([
      null,
      null,
    ]);
  });

  it('同标题不同规格的多商品在复核顺序变化时不合并价格', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-DUPLICATE-TITLE-0001',
        buyer_nickname: 'x***4',
        recipient: '合成收件人',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [
          { title: '同款合成商品', spec: '规格A', unit_price: null, quantity: null },
          { title: '同款合成商品', spec: '规格B', unit_price: null, quantity: null },
        ],
      }, 'request-duplicate-title-primary'),
      successfulKieResponse({
        amounts: { product_total: '8.00', shipping_fee: '0.00', amount: '8.00' },
        items: [
          { title: '同款合成商品', spec: '规格B', unit_price: '5.00', quantity: '1' },
          { title: '同款合成商品', spec: '规格A', unit_price: '3.00', quantity: '1' },
        ],
      }, 'request-duplicate-title-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-duplicate-title',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-duplicate-title.png',
        originalName: '合成同标题多商品订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-duplicate-title',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.result.items.map(({ unitPriceCents }) => unitPriceCents)).toEqual([
      null,
      null,
    ]);
  });

  it('首次商品字段违反数组格式时仍可通过一次定向复核恢复', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-MALFORMED-ITEMS-0001',
        buyer_nickname: 'x***4',
        recipient: '合成收件人',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: { title: '错误的非数组商品结构' },
      }, 'request-malformed-items-primary'),
      successfulKieResponse({
        amounts: { product_total: '8.00', shipping_fee: '0.00', amount: '8.00' },
        items: [{
          title: '合成测试商品',
          spec: null,
          unit_price: '8.00',
          quantity: null,
        }],
      }, 'request-malformed-items-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-malformed-items',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-malformed-items.png',
        originalName: '合成商品格式异常订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-malformed-items',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.evidences).toHaveLength(2);
    expect(attempt.result.items).toEqual([
      expect.objectContaining({
        sourceTitle: '合成测试商品',
        unitPriceCents: 800,
        quantity: 1,
        quantityInferred: true,
      }),
    ]);
  });

  it('首次金额格式异常时把该字段视为缺失并通过定向复核恢复', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-MALFORMED-AMOUNT-0001',
        buyer_nickname: 'x***4',
        recipient: '合成收件人',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '￥??',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{
          title: '合成测试商品',
          spec: null,
          unit_price: '8.00',
          quantity: null,
        }],
      }, 'request-malformed-amount-primary'),
      successfulKieResponse({
        amounts: { product_total: '8.00', shipping_fee: '0.00', amount: '8.00' },
        items: [{
          title: '合成测试商品',
          spec: null,
          unit_price: '8.00',
          quantity: null,
        }],
      }, 'request-malformed-amount-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-malformed-amount',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-malformed-amount.png',
        originalName: '合成金额格式异常订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-malformed-amount',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.evidences).toHaveLength(2);
    expect(attempt.result.amountCents).toBe(800);
  });

  it('定向复核失败时保留首次结果且不会继续第三次调用', async () => {
    const primaryResult = {
      order_number: 'XY-SYNTH-REVIEW-FALLBACK-0001',
      buyer_nickname: 'x***4',
      recipient: null,
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      product_total: '8.00',
      shipping_fee: '0.00',
      amount: '8.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{
        title: '合成测试商品',
        spec: null,
        unit_price: null,
        quantity: null,
      }],
    };
    const request = vi.fn(async (): Promise<Response> => {
      if (request.mock.calls.length === 1) {
        return successfulKieResponse(primaryResult, 'request-review-fallback-primary');
      }
      return new Response('{}', { status: 429 });
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-review-fallback',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-review-fallback.png',
        originalName: '合成复核失败订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-review-fallback',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.evidences).toHaveLength(1);
    expect(attempt.result).toMatchObject({
      orderNumber: 'XY-SYNTH-REVIEW-FALLBACK-0001',
      recipient: '',
      amountCents: 800,
      items: [expect.objectContaining({ unitPriceCents: null })],
    });
  });

  it('定向复核不覆盖首次有效金额，也不把价格合并到规格冲突的单商品', async () => {
    const responses = [
      successfulKieResponse({
        order_number: 'XY-SYNTH-CONSERVATIVE-MERGE-0001',
        buyer_nickname: 'x***4',
        recipient: '合成收件人',
        phone: '13900000001',
        address: '测试省测试市示例区安全路1号',
        province: '测试省',
        city: '测试市',
        district: '示例区',
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        items: [{
          title: '合成测试商品甲',
          spec: '规格A',
          unit_price: null,
          quantity: null,
        }],
      }, 'request-conservative-primary'),
      successfulKieResponse({
        amounts: {
          product_total: '99.00',
          shipping_fee: '9.00',
          amount: '108.00',
        },
        order_product_section: {
          items: [{
            title: '合成测试商品甲',
            spec: '规格B',
            unit_price: '99.00',
            quantity: '2',
          }],
        },
      }, 'request-conservative-review'),
    ];
    const request = vi.fn(async (): Promise<Response> => responses.shift()!);
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-conservative',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-conservative.png',
        originalName: '合成保守合并订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-conservative',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.evidences).toHaveLength(2);
    expect(attempt.result).toMatchObject({
      productTotalCents: 800,
      shippingFeeCents: 0,
      amountCents: 800,
      items: [expect.objectContaining({
        sourceTitle: '合成测试商品甲',
        unitPriceCents: null,
        quantity: 1,
        quantityInferred: true,
      })],
    });
  });

  it('地址补拆跳过直辖市和省直管县的占位层级', async () => {
    const samples = [
      {
        address: '上海市市辖区浦东新区安全路1号',
        expected: { province: '上海市', city: '上海市', district: '浦东新区' },
      },
      {
        address: '海南省省直辖县级行政区澄迈县安全路1号',
        expected: { province: '海南省', city: '', district: '澄迈县' },
      },
    ];

    for (const [index, sample] of samples.entries()) {
      const request = vi.fn(async (): Promise<Response> => new Response(JSON.stringify({
        output: {
          choices: [{
            finish_reason: 'stop',
            message: {
              content: [{
                ocr_result: {
                  kv_result: {
                    address: sample.address,
                    province: null,
                    city: null,
                    district: null,
                    items: [],
                  },
                },
              }],
            },
          }],
        },
        request_id: `request-address-${index}`,
      }), { status: 200 }));
      const client = new BailianOcrClient(request);

      const attempt = await client.recognizeOrder({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: 'sk-synthetic-address',
        sellerAccount: '默认闲鱼账号',
        source: {
          absolutePath: '/private/synthetic-address.png',
          originalName: '合成地址.png',
          mimeType: 'image/png',
          sha256: `synthetic-address-${index}`,
          bytes: Uint8Array.from([1]),
        },
      });

      expect(attempt.result).toMatchObject(sample.expected);
    }
  });

  it('完整地址可拆分时纠正模型粘连了城市的省字段', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      purchased_items: {
        items: [{
          title: '合成地址校验商品',
          spec: '规格A',
          unit_price: '8.00',
          price_tag_text: '¥8.00',
          quantity: '1',
          quantity_text: '×1',
        }],
        controls: [],
      },
      shipping_information: {
        recipient: '合成收件人甲',
        recipient_phone_line_text: '合成收件人甲 13900000001',
        phone: '13900000001',
        address: '广东省深圳市南山区安全路1号',
        province: '广东省深圳市',
        city: '深圳市',
        district: '南山区',
        controls: ['复制'],
      },
      transaction_information: {
        detail_state: 'collapsed',
        order_number: 'XY-SYNTH-ADDRESS-HIERARCHY-0001',
        alipay_transaction_number: null,
        product_total: '8.00',
        shipping_fee: '0.00',
        amount: '8.00',
        platform_transaction_status: 'paid',
        fulfillment_status: 'pending_shipment',
        buyer_nickname_label: null,
        buyer_nickname: null,
        order_time: null,
        payment_time: null,
        controls: ['展开'],
      },
      page_context: {
        top_status_text: '买家已付款，请尽快发货',
        global_controls: ['联系买家'],
        excluded_regions: [],
      },
    }, 'request-address-overfilled-province'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-address-overfilled-province',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-address-overfilled-province.png',
        originalName: '合成省市粘连地址.png',
        mimeType: 'image/png',
        sha256: 'synthetic-address-overfilled-province',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(attempt.result).toMatchObject({
      province: '广东省',
      city: '深圳市',
      district: '南山区',
    });
  });

  it('地址省略省级前缀时也能用独立城市字段清理省市粘连', async () => {
    const request = vi.fn(async (): Promise<Response> => successfulKieResponse({
      order_number: 'XY-SYNTH-ADDRESS-PARTIAL-HIERARCHY-0001',
      buyer_nickname_label: null,
      buyer_nickname: null,
      recipient: '合成收件人乙',
      recipient_phone_line_text: '合成收件人乙 13900000002',
      phone: '13900000002',
      address: '深圳市南山区安全路2号',
      province: '广东省深圳市',
      city: '深圳市',
      district: '南山区',
      product_total: '9.00',
      shipping_fee: '0.00',
      amount: '9.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{
        title: '合成部分地址商品',
        spec: '规格B',
        unit_price: '9.00',
        quantity: null,
      }],
    }, 'request-address-partial-hierarchy'));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-address-partial-hierarchy',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-address-partial-hierarchy.png',
        originalName: '合成省级前缀缺失地址.png',
        mimeType: 'image/png',
        sha256: 'synthetic-address-partial-hierarchy',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(attempt.result).toMatchObject({
      province: '广东省',
      city: '深圳市',
      district: '南山区',
    });
  });

  it('只把明确且安全的商品数量标记为非推定值', async () => {
    const quantities: unknown[] = [2, '数量：3', '共4件', 0, 'null', '999999999999999999999'];
    const request = vi.fn(async (): Promise<Response> => new Response(JSON.stringify({
      output: {
        choices: [{
          finish_reason: 'stop',
          message: {
            content: [{
              ocr_result: {
                kv_result: {
                  items: quantities.map((quantity, index) => ({
                    title: `合成商品${index + 1}`,
                    spec: null,
                    unit_price: '1.00',
                    quantity,
                  })),
                },
              },
            }],
          },
        }],
      },
      request_id: 'request-quantity-boundaries',
    }), { status: 200 }));
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-synthetic-quantities',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-quantities.png',
        originalName: '合成数量.png',
        mimeType: 'image/png',
        sha256: 'synthetic-quantities',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result.items.map(({ quantity, quantityInferred }) => ({
      quantity,
      quantityInferred,
    }))).toEqual([
      { quantity: 2, quantityInferred: false },
      { quantity: 3, quantityInferred: false },
      { quantity: 4, quantityInferred: false },
      { quantity: 1, quantityInferred: true },
      { quantity: 1, quantityInferred: true },
      { quantity: 1, quantityInferred: true },
    ]);
  });

  it('把模型用于表示未显示字段的 null 文本规范为空值', async () => {
    const request = vi.fn(async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          output: {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: [
                    {
                      ocr_result: {
                        kv_result: {
                          order_number: 'ORDER-AS-TEXT',
                          alipay_transaction_number: 'null',
                          buyer_nickname: 'null',
                          recipient: '待补录',
                          phone: '13800000000',
                          address: '待补录地址',
                          province: 'null',
                          city: null,
                          district: '',
                          order_time: 'null',
                          payment_time: null,
                          product_total: 'null',
                          shipping_fee: null,
                          amount: '8.00',
                          platform_transaction_status: 'paid',
                          fulfillment_status: null,
                          items: [
                            {
                              title: '未显示数量的商品',
                              spec: 'null',
                              unit_price: null,
                              quantity: 'null',
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
          request_id: 'request-null-normalization',
        }),
        { status: 200 },
      );
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-null-normalization',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/order.png',
        originalName: '订单.png',
        mimeType: 'image/png',
        sha256: 'fixed-sha256',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(attempt.result).toMatchObject({
      alipayTransactionNumber: '',
      buyerNickname: '',
      province: '',
      city: '',
      orderedAtOriginal: '',
      paidAtOriginal: '',
      productTotalCents: null,
      shippingFeeCents: null,
      fulfillmentStatus: 'unknown',
      items: [
        expect.objectContaining({
          sourceSpec: '',
          unitPriceCents: null,
          quantity: 1,
          quantityInferred: true,
        }),
      ],
    });
  });

  it('拒绝保存异常回显实际 API Key 的成功响应', async () => {
    const sentinelApiKey = 'sk-secret-success-echo-sentinel';
    const request = vi.fn(async (): Promise<Response> => {
      return new Response(JSON.stringify({
        output: {
          choices: [{
            finish_reason: 'stop',
            message: {
              content: [{
                ocr_result: {
                  kv_result: {
                    order_number: 'XY-SYNTH-ECHO-0001',
                    alipay_transaction_number: null,
                    buyer_nickname: null,
                    recipient: '合成收件人',
                    phone: '13900000001',
                    address: '测试省测试市示例区安全路1号',
                    province: '测试省',
                    city: '测试市',
                    district: '示例区',
                    order_time: null,
                    payment_time: null,
                    product_total: '1.00',
                    shipping_fee: '0.00',
                    amount: '1.00',
                    platform_transaction_status: 'paid',
                    fulfillment_status: 'pending_shipment',
                    items: [{
                      title: '合成测试商品',
                      spec: null,
                      unit_price: '1.00',
                      quantity: '1',
                    }],
                  },
                },
              }],
            },
          }],
        },
        unexpected_echo: sentinelApiKey,
      }), { status: 200 });
    });
    const client = new BailianOcrClient(request);

    let failure: unknown;
    try {
      await client.recognizeOrder({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: sentinelApiKey,
        sellerAccount: '默认闲鱼账号',
        source: {
          absolutePath: '/private/order.png',
          originalName: '合成订单.png',
          mimeType: 'image/png',
          sha256: 'fixed-sha256',
          bytes: Uint8Array.from([1]),
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('百炼 OCR 返回了无法安全保存的订单结果');
    expect(JSON.stringify(failure)).not.toContain(sentinelApiKey);
  });

  it('定向复核异常回显 API Key 时丢弃该响应并保留安全的首次结果', async () => {
    const sentinelApiKey = 'sk-secret-review-echo-sentinel';
    const primary = successfulKieResponse({
      order_number: 'XY-SYNTH-REVIEW-ECHO-0001',
      buyer_nickname: 'x***4',
      recipient: null,
      phone: '13900000001',
      address: '测试省测试市示例区安全路1号',
      province: '测试省',
      city: '测试市',
      district: '示例区',
      product_total: '8.00',
      shipping_fee: '0.00',
      amount: '8.00',
      platform_transaction_status: 'paid',
      fulfillment_status: 'pending_shipment',
      items: [{ title: '合成测试商品', spec: null, unit_price: '8.00', quantity: null }],
    }, 'request-review-echo-primary');
    const request = vi.fn(async (): Promise<Response> => {
      if (request.mock.calls.length === 1) return primary;
      return new Response(JSON.stringify({
        output: {
          choices: [{
            finish_reason: 'stop',
            message: {
              content: [{
                ocr_result: {
                  kv_result: {
                    shipping_contact: {
                      recipient: '合成收件人',
                      phone: '13900000001',
                      address: '测试省测试市示例区安全路1号',
                    },
                    buyer_section: { buyer_nickname: 'x***4' },
                  },
                },
              }],
            },
          }],
        },
        request_id: 'request-review-echo-unsafe',
        unexpected_echo: sentinelApiKey,
      }), { status: 200 });
    });
    const client = new BailianOcrClient(request);

    const attempt = await client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: sentinelApiKey,
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-review-echo.png',
        originalName: '合成复核回显订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-review-echo',
        bytes: Uint8Array.from([1]),
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(attempt.evidences).toHaveLength(1);
    expect(attempt.result.recipient).toBe('');
    expect(JSON.stringify(attempt)).not.toContain(sentinelApiKey);
  });

  it('订单识别拒绝超过安全上限的响应正文', async () => {
    const request = vi.fn(async (): Promise<Response> => new Response(
      JSON.stringify({ output: { choices: [] }, padding: 'x'.repeat(2_048) }),
      { status: 200 },
    ));
    const client = new BailianOcrClient(request, { maxResponseBytes: 1_024 });

    await expect(client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-fixed-order-large-response',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-large-response.png',
        originalName: '合成超大响应订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-large-response',
        bytes: Uint8Array.from([1]),
      },
    })).rejects.toThrow('百炼 OCR 返回了无法识别的订单结果');
  });

  it('订单识别到达请求时限后主动中止', async () => {
    const request = vi.fn((_input: string, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const client = new BailianOcrClient(request, { timeoutMilliseconds: 5 });

    await expect(client.recognizeOrder({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: 'sk-fixed-order-timeout',
      sellerAccount: '默认闲鱼账号',
      source: {
        absolutePath: '/private/synthetic-timeout.png',
        originalName: '合成超时订单.png',
        mimeType: 'image/png',
        sha256: 'synthetic-timeout',
        bytes: Uint8Array.from([1]),
      },
    })).rejects.toThrow('无法连接百炼服务，请检查网络后重试');
  });

  it('用固定北京端点和本机图片 Data URL 显式测试 qwen3.5-ocr 连接', async () => {
    const sentinelApiKey = 'sk-fixed-contract-sentinel';
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-fixed',
          model: 'qwen3.5-ocr',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'OK',
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const client = new BailianOcrClient(request);

    const result = await client.testConnection({
      workspaceId: 'ws-test123',
      region: 'cn-beijing',
      apiKey: sentinelApiKey,
    });

    expect(result).toEqual({ model: 'qwen3.5-ocr' });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0];
    expect(url).toBe(
      'https://ws-test123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    );
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${sentinelApiKey}`,
    );
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{
        role: string;
        content: Array<{
          type: string;
          image_url?: { url: string };
          text?: string;
        }>;
      }>;
    };
    expect(body.model).toBe('qwen3.5-ocr');
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0].image_url?.url).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(body.messages[0].content[0].image_url?.url).not.toContain('http');
    expect(JSON.stringify(body)).not.toContain(sentinelApiKey);
    expect(JSON.stringify(result)).not.toContain(sentinelApiKey);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe('error');
  });

  it('在发起网络请求前拒绝可能改变目标主机的 Workspace ID', async () => {
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      throw new Error('request must not be called');
    });
    const client = new BailianOcrClient(request);

    await expect(
      client.testConnection({
        workspaceId: 'evil.example.com/path',
        region: 'cn-beijing',
        apiKey: 'sk-fixed-invalid-host',
      }),
    ).rejects.toThrow('Workspace ID 格式无效');
    expect(request).not.toHaveBeenCalled();
  });

  it('认证失败时不把服务端响应或 API Key 带入错误信息', async () => {
    const sentinelApiKey = 'sk-secret-in-remote-error';
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      return new Response(
        JSON.stringify({
          message: `invalid bearer ${sentinelApiKey}`,
          request: 'data:image/png;base64,private-image-content',
        }),
        { status: 401 },
      );
    });
    const client = new BailianOcrClient(request);

    let failure: unknown;
    try {
      await client.testConnection({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: sentinelApiKey,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      '连接未通过，请检查 API Key、Workspace ID 和地域',
    );
    expect(JSON.stringify(failure)).not.toContain(sentinelApiKey);
    expect((failure as Error).message).not.toContain('private-image-content');
  });

  it('网络异常时不透传可能含敏感数据的底层错误', async () => {
    const sentinelApiKey = 'sk-secret-in-network-error';
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      throw new Error(`request failed with ${sentinelApiKey}`);
    });
    const client = new BailianOcrClient(request);

    await expect(
      client.testConnection({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: sentinelApiKey,
      }),
    ).rejects.toThrow('无法连接百炼服务，请检查网络后重试');
  });

  it('响应格式异常时不透传服务端内容或解析错误', async () => {
    const sentinelApiKey = 'sk-secret-in-invalid-json';
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      return new Response(`not-json-${sentinelApiKey}`, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new BailianOcrClient(request);

    await expect(
      client.testConnection({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: sentinelApiKey,
      }),
    ).rejects.toThrow('百炼 OCR 返回了无法识别的响应');
  });

  it('拒绝超过安全上限的响应正文', async () => {
    const request = vi.fn(async (_input: string, _init?: RequestInit): Promise<Response> => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'x'.repeat(2_048) } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const client = new BailianOcrClient(request, { maxResponseBytes: 1_024 });

    await expect(
      client.testConnection({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: 'sk-fixed-large-response',
      }),
    ).rejects.toThrow('百炼 OCR 返回了无法识别的响应');
  });

  it('到达请求时限后主动中止连接测试', async () => {
    const request = vi.fn((_input: string, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const client = new BailianOcrClient(request, { timeoutMilliseconds: 5 });

    await expect(
      client.testConnection({
        workspaceId: 'ws-test123',
        region: 'cn-beijing',
        apiKey: 'sk-fixed-timeout',
      }),
    ).rejects.toThrow('无法连接百炼服务，请检查网络后重试');
  });
});
