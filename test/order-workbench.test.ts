import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';

const openedApplications: LocalApplication[] = [];

class SequenceRecognizer implements Recognizer {
  public constructor(private readonly results: RecognitionResult[]) {}

  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result = this.results.shift();
    if (!result) throw new Error('测试识别结果已用尽');
    return {
      result: structuredClone(result),
      evidences: [{
        provider: 'controlled',
        model: 'controlled',
        requestId: '',
        schemaVersion: 1,
        rawResponse: JSON.stringify(result),
      }],
    };
  }
}

function recognition(
  overrides: Partial<RecognitionResult> & Pick<RecognitionResult, 'orderNumber'>,
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '华东闲鱼店',
    alipayTransactionNumber: `ALI-${overrides.orderNumber}`,
    buyerNickname: '海棠买家',
    recipient: '陈海棠',
    phone: '13800000001',
    phoneNormalized: '13800000001',
    addressOriginal: '上海市浦东新区海棠路1号',
    addressNormalized: '上海市浦东新区海棠路1号',
    province: '上海市',
    city: '上海市',
    district: '浦东新区',
    orderedAtOriginal: '2026-07-28 09:30:00',
    orderedAtNormalized: '2026-07-28T09:30:00+08:00',
    paidAtOriginal: '2026-07-28 09:31:00',
    paidAtNormalized: '2026-07-28T09:31:00+08:00',
    productTotalCents: 3_600,
    shippingFeeCents: 0,
    amountCents: 3_600,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '夏日海棠杯',
      sourceSpec: '红色 450ml',
      unitPriceCents: 1_800,
      quantity: 2,
      quantityInferred: false,
    }],
    ...overrides,
  };
}

async function createApplicationWithOrders(
  results: RecognitionResult[],
): Promise<{ application: LocalApplication; dataDirectory: string }> {
  const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-order-workbench-'));
  const dataDirectory = join(testRoot, '数据');
  const uploadDirectory = join(testRoot, '上传');
  await mkdir(uploadDirectory, { recursive: true });
  const application = new LocalApplication(new SequenceRecognizer([...results]));
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);

  for (const [index] of results.entries()) {
    const sourcePath = join(uploadDirectory, `订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`synthetic-order-${index}`));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    application.confirmDraft(batch.drafts[0]);
  }
  return { application, dataDirectory };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('订单工作台查询', () => {
  it('默认返回 active 订单的完整工作台摘要和统计', async () => {
    const { application } = await createApplicationWithOrders([
      recognition({ orderNumber: 'XY-20260728-001' }),
    ]);

    expect(application.queryOrders({})).toEqual({
      orders: [expect.objectContaining({
        orderNumber: 'XY-20260728-001',
        platform: 'xianyu',
        sellerAccount: '华东闲鱼店',
        initialSourceRecognitionStatus: 'imported',
        lifecycleStatus: 'active',
        phone: '13800000001',
        addressOriginal: '上海市浦东新区海棠路1号',
        orderedAtNormalized: '2026-07-28T09:30:00+08:00',
        paidAtNormalized: '2026-07-28T09:31:00+08:00',
        items: [{ sourceTitle: '夏日海棠杯', sourceSpec: '红色 450ml', quantity: 2 }],
      })],
      customFieldValues: [],
      allLifecycleOrderCount: 1,
      activeOrderCount: 1,
      pendingShipmentCount: 1,
      platforms: ['xianyu'],
      sellerAccounts: ['华东闲鱼店'],
    });
  });

  it('全局搜索命中商品标题或规格且不重复订单行', async () => {
    const { application } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-SEARCH-001',
        items: [
          {
            sourceTitle: '海棠杯',
            sourceSpec: '红色',
            unitPriceCents: 1_800,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '备用杯盖',
            sourceSpec: '星空蓝限定',
            unitPriceCents: 1_800,
            quantity: 1,
            quantityInferred: false,
          },
        ],
      }),
      recognition({
        orderNumber: 'XY-SEARCH-002',
        items: [{
          sourceTitle: '普通玻璃杯',
          sourceSpec: '透明',
          unitPriceCents: 3_600,
          quantity: 1,
          quantityInferred: false,
        }],
      }),
    ]);

    const result = application.queryOrders({ text: '星空蓝' });

    expect(result.orders.map((order) => order.orderNumber)).toEqual(['XY-SEARCH-001']);
  });

  it('日期、正交状态、平台账号、买家和商品筛选可以组合', async () => {
    const { application } = await createApplicationWithOrders([
      recognition({ orderNumber: 'XY-FILTER-001' }),
      recognition({
        orderNumber: 'XY-FILTER-002',
        sellerAccount: '华西闲鱼店',
        buyerNickname: '松果买家',
        recipient: '林松',
        orderedAtOriginal: '2026-07-30 23:59:59',
        orderedAtNormalized: '2026-07-30T23:59:59+08:00',
        paidAtOriginal: '2026-07-30 23:59:59',
        paidAtNormalized: '2026-07-30T23:59:59+08:00',
        platformTransactionStatus: 'refunded',
        fulfillmentStatus: 'shipped',
        items: [{
          sourceTitle: '月光浅盘',
          sourceSpec: '松果绿',
          unitPriceCents: 3_600,
          quantity: 1,
          quantityInferred: false,
        }],
      }),
    ]);

    const result = application.queryOrders({
      buyerText: '松',
      productText: '月光',
      dateField: 'ordered_at',
      dateFrom: '2026-07-30',
      dateTo: '2026-07-30',
      platform: 'xianyu',
      sellerAccount: '华西闲鱼店',
      initialSourceRecognitionStatus: 'imported',
      platformTransactionStatus: 'refunded',
      fulfillmentStatus: 'shipped',
      lifecycleStatus: 'active',
    });

    expect(result.orders.map((order) => order.orderNumber)).toEqual(['XY-FILTER-002']);
  });

  it('商品排序使用每笔订单的第一个商品标题', async () => {
    const { application } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-SORT-001',
        items: [{
          sourceTitle: 'Z 棕色杯',
          sourceSpec: '大号',
          unitPriceCents: 3_600,
          quantity: 1,
          quantityInferred: false,
        }],
      }),
      recognition({
        orderNumber: 'XY-SORT-002',
        items: [{
          sourceTitle: 'A 白色杯',
          sourceSpec: '小号',
          unitPriceCents: 3_600,
          quantity: 1,
          quantityInferred: false,
        }],
      }),
    ]);

    const result = application.queryOrders({ sortField: 'product', sortDirection: 'desc' });

    expect(result.orders.map((order) => order.orderNumber)).toEqual([
      'XY-SORT-001',
      'XY-SORT-002',
    ]);
  });

  it('生命周期筛选和工作台统计始终以 active 正式订单为边界', async () => {
    const { application, dataDirectory } = await createApplicationWithOrders([
      recognition({ orderNumber: 'XY-LIFE-ACTIVE-PAID' }),
      recognition({
        orderNumber: 'XY-LIFE-ACTIVE-CANCELLED',
        platformTransactionStatus: 'cancelled',
      }),
      recognition({
        orderNumber: 'XY-LIFE-ACTIVE-REFUNDED',
        platformTransactionStatus: 'refunded',
      }),
      recognition({ orderNumber: 'XY-LIFE-TRASHED', sellerAccount: '回收站闲鱼店' }),
      recognition({ orderNumber: 'XY-LIFE-DELETED', sellerAccount: '归档闲鱼店' }),
    ]);
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      database.prepare(`
        UPDATE original_orders
        SET lifecycle_status = 'trashed'
        WHERE platform_order_number = 'XY-LIFE-TRASHED'
      `).run();
      database.prepare(`
        UPDATE original_orders
        SET lifecycle_status = 'deleted'
        WHERE platform_order_number = 'XY-LIFE-DELETED'
      `).run();
    } finally {
      database.close();
    }

    const active = application.queryOrders({});
    expect(active.orders.map((order) => order.orderNumber).sort()).toEqual([
      'XY-LIFE-ACTIVE-CANCELLED',
      'XY-LIFE-ACTIVE-PAID',
      'XY-LIFE-ACTIVE-REFUNDED',
    ]);
    expect(active.activeOrderCount).toBe(3);
    expect(active.allLifecycleOrderCount).toBe(5);
    expect(active.pendingShipmentCount).toBe(1);
    expect(active.platforms).toEqual(['xianyu']);
    expect(active.sellerAccounts.sort()).toEqual([
      '华东闲鱼店',
      '回收站闲鱼店',
      '归档闲鱼店',
    ].sort());
    expect(application.listOrders()).toHaveLength(3);

    const trashed = application.queryOrders({ lifecycleStatus: 'trashed' });
    expect(trashed.orders.map((order) => order.orderNumber)).toEqual(['XY-LIFE-TRASHED']);
    expect(trashed.activeOrderCount).toBe(3);
    expect(trashed.allLifecycleOrderCount).toBe(5);
    expect(trashed.pendingShipmentCount).toBe(1);

    const all = application.queryOrders({ lifecycleStatus: 'all' });
    expect(all.orders).toHaveLength(5);
    expect(all.activeOrderCount).toBe(3);
    expect(all.allLifecycleOrderCount).toBe(5);
    expect(all.pendingShipmentCount).toBe(1);
  });

  it('来源识别状态来自订单关联草稿而不是固定订单字段', async () => {
    const { application, dataDirectory } = await createApplicationWithOrders([
      recognition({ orderNumber: 'XY-SOURCE-STATUS-001' }),
    ]);
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      database.prepare(`
        UPDATE recognition_batch_items
        SET status = 'duplicate_skipped'
        WHERE draft_id = (
          SELECT draft_id
          FROM original_orders
          WHERE platform_order_number = 'XY-SOURCE-STATUS-001'
        )
      `).run();
    } finally {
      database.close();
    }

    const matched = application.queryOrders({
      initialSourceRecognitionStatus: 'duplicate_skipped',
    });

    expect(matched.orders).toEqual([
      expect.objectContaining({
        orderNumber: 'XY-SOURCE-STATUS-001',
        initialSourceRecognitionStatus: 'duplicate_skipped',
      }),
    ]);
    expect(application.queryOrders({ initialSourceRecognitionStatus: 'imported' }).orders)
      .toEqual([]);
    expect(application.getOrder(matched.orders[0].id).sources[0].recognitionStatus)
      .toBe('duplicate_skipped');
  });
});

describe('商品明细工作台查询', () => {
  it('组合原始标题、原始款式或规格、单价、数量和数量来源精确筛选', async () => {
    const { application } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-ITEM-FILTER-001',
        items: [{
          sourceTitle: '海棠杯',
          sourceSpec: '红色 450ml',
          unitPriceCents: 1_800,
          quantity: 2,
          quantityInferred: false,
        }, {
          sourceTitle: '海棠杯',
          sourceSpec: '蓝色 300ml',
          unitPriceCents: 1_200,
          quantity: 1,
          quantityInferred: true,
        }],
      }),
      recognition({
        orderNumber: 'XY-ITEM-FILTER-002',
        items: [{
          sourceTitle: '海棠杯垫',
          sourceSpec: '蓝色 300ml',
          unitPriceCents: 1_200,
          quantity: 1,
          quantityInferred: false,
        }],
      }),
    ]);

    const result = application.queryOrderItems({
      sourceTitle: '海棠杯',
      sourceSpec: '蓝色 300ml',
      unitPriceCents: 1_200,
      quantity: 1,
      quantitySource: 'system_default_1',
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        orderNumber: 'XY-ITEM-FILTER-001',
        sourceTitle: '海棠杯',
        sourceSpec: '蓝色 300ml',
        unitPriceCents: 1_200,
        quantity: 1,
        quantitySource: 'system_default_1',
        quantityInferred: true,
      }),
    ]);
  });

  it('按原始商品标题排序并保持同一订单的商品为独立明细行', async () => {
    const { application } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-ITEM-SORT-001',
        items: [{
          sourceTitle: 'B 海棠杯',
          sourceSpec: '红色',
          unitPriceCents: 1_800,
          quantity: 2,
          quantityInferred: false,
        }, {
          sourceTitle: 'A 备用杯盖',
          sourceSpec: '透明',
          unitPriceCents: 600,
          quantity: 1,
          quantityInferred: true,
        }],
      }),
    ]);

    const result = application.queryOrderItems({
      sortField: 'source_title',
      sortDirection: 'asc',
    });

    expect(result.items.map((item) => [item.orderNumber, item.sourceTitle])).toEqual([
      ['XY-ITEM-SORT-001', 'A 备用杯盖'],
      ['XY-ITEM-SORT-001', 'B 海棠杯'],
    ]);
  });

  it('按原始款式或规格、单价、数量和数量来源排序', async () => {
    const { application } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-ITEM-SORT-FACTS',
        items: [{
          sourceTitle: '甲',
          sourceSpec: 'C 规格',
          unitPriceCents: 3_000,
          quantity: 1,
          quantityInferred: true,
        }, {
          sourceTitle: '乙',
          sourceSpec: 'B 规格',
          unitPriceCents: 2_000,
          quantity: 3,
          quantityInferred: false,
        }, {
          sourceTitle: '丙',
          sourceSpec: 'A 规格',
          unitPriceCents: 1_000,
          quantity: 2,
          quantityInferred: false,
        }],
      }),
    ]);

    expect(application.queryOrderItems({
      sortField: 'source_spec',
      sortDirection: 'asc',
    }).items.map((item) => item.sourceTitle)).toEqual(['丙', '乙', '甲']);
    expect(application.queryOrderItems({
      sortField: 'unit_price',
      sortDirection: 'desc',
    }).items.map((item) => item.sourceTitle)).toEqual(['甲', '乙', '丙']);
    expect(application.queryOrderItems({
      sortField: 'quantity',
      sortDirection: 'asc',
    }).items.map((item) => item.sourceTitle)).toEqual(['甲', '丙', '乙']);
    expect(application.queryOrderItems({
      sortField: 'quantity_source',
      sortDirection: 'asc',
    }).items.map((item) => item.quantitySource)).toEqual([
      'system_default_1',
      'ocr_explicit',
      'ocr_explicit',
    ]);
  });
});
