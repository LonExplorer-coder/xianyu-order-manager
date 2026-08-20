import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { OrderEditInput, OrderSummary, OriginalOrder } from '../src/core/contracts';
import type { ProductCatalogColumnMapping } from '../src/core/product-catalog';
import { createBackup, restoreBackup } from '../src/main/backup-service';
import { LocalApplication } from '../src/main/local-application';
import { Workspace } from '../src/main/workspace';

const HISTORY_HEADERS = [
  '交易平台',
  '业务账号',
  '平台单号',
  '收件姓名',
  '联系电话',
  '完整地址',
  '实付金额',
  '商品标题',
  '商品规格',
  '商品单价',
  '购买数量',
  '商品总价',
  '运费',
  '交易状态',
  '发货状态',
  '下单时间',
  '付款时间',
] as const;

// 商品总价与实付金额是订单级列：同一订单的多行重复同样数值，逐行只有商品差异。
interface HistoryRow {
  orderNumber: string;
  recipient: string;
  phone: string;
  address: string;
  amountYuan: number;
  productTotalYuan: number;
  title: string;
  spec: string;
  unitPriceYuan: number;
  quantity: number;
  orderedAt: string;
  paidAt: string;
}

function historyWorkbook(rows: readonly HistoryRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('旧订单');
  worksheet.addRow([...HISTORY_HEADERS]);
  for (const row of rows) {
    worksheet.addRow([
      '闲鱼',
      '娃物账号',
      row.orderNumber,
      row.recipient,
      row.phone,
      row.address,
      row.amountYuan,
      row.title,
      row.spec,
      row.unitPriceYuan,
      row.quantity,
      row.productTotalYuan,
      0,
      '已付款',
      '待发货',
      row.orderedAt,
      row.paidAt,
    ]);
  }
  return workbook.xlsx.writeBuffer().then((buffer) => Buffer.from(buffer));
}

function historyRow(overrides: Partial<HistoryRow> & Pick<HistoryRow, 'orderNumber'>): HistoryRow {
  return {
    recipient: '林岚',
    phone: '13800001001',
    address: '广东省深圳市南山区验收路1号',
    amountYuan: 10,
    productTotalYuan: 10,
    title: '亚麻收纳袋',
    spec: '米白 大号',
    unitPriceYuan: 10,
    quantity: 1,
    orderedAt: '2026-08-20 10:00:00',
    paidAt: '2026-08-20 10:00:30',
    ...overrides,
  };
}

// 缺手机号是边缘态：历史导入与草稿确认都强制手机号，照合并发货组测试先例用 SQL 构造。
function clearOrderPhone(dataDirectory: string, orderNumber: string): void {
  const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
  try {
    database.prepare(`
      UPDATE original_orders SET phone = '', phone_normalized = ''
      WHERE platform_order_number = ?
    `).run(orderNumber);
  } finally {
    database.close();
  }
}

const applications: LocalApplication[] = [];
const state: {
  application: LocalApplication | null;
  testRoot: string;
  dataDirectory: string;
  orders: Map<string, OrderSummary>;
  specialShoeProductId: string | null;
} = {
  application: null,
  testRoot: '',
  dataDirectory: '',
  orders: new Map(),
  specialShoeProductId: null,
};

async function ensureApplication(): Promise<LocalApplication> {
  if (state.application) return state.application;
  const root = await mkdtemp(join(tmpdir(), 'xianyu-stage-two-acceptance-'));
  const application = new LocalApplication(new ControlledRecognizer({} as never));
  applications.push(application);
  application.openDataDirectory(join(root, '数据'));
  state.testRoot = root;
  state.dataDirectory = join(root, '数据');
  state.application = application;
  return application;
}

// 规格条款 8 的「重复 SKU」指目录导入入口：预览标记重复、不解决就拒绝写入。
async function duplicateSkuCatalogWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const products = workbook.addWorksheet('我的商品');
  products.addRow(['商品编码', '名称列', '规格列']);
  products.addRow(['SKU-STAGE2-DUP', '验收重复商品甲', '甲规格']);
  products.addRow(['sku-stage2-dup', '验收重复商品乙', '乙规格']);
  const mappings = workbook.addWorksheet('我的映射');
  mappings.addRow(['关联SKU', '别名标题', '别名规格', '范围', '平台列', '账号列']);
  return workbook.xlsx.writeBuffer().then((buffer) => Buffer.from(buffer));
}

const STAGE_TWO_CATALOG_MAPPING: ProductCatalogColumnMapping = {
  productWorksheet: '我的商品',
  productColumns: { sku: 1, name: 2, specification: 3 },
  mappingWorksheet: '我的映射',
  mappingColumns: {
    sku: 1,
    sourceTitle: 2,
    sourceSpec: 3,
    scope: 4,
    platform: 5,
    sellerAccount: 6,
  },
};

function orderEditInput(order: OriginalOrder): OrderEditInput {
  return {
    orderId: order.id,
    expectedRevision: order.revision,
    identityCorrection: null,
    alipayTransactionNumber: order.alipayTransactionNumber,
    buyerNickname: order.buyerNickname,
    recipient: order.recipient,
    phone: order.phone,
    addressOriginal: order.addressOriginal,
    province: order.province,
    city: order.city,
    district: order.district,
    orderedAtOriginal: order.orderedAtOriginal,
    paidAtOriginal: order.paidAtOriginal,
    productTotalCents: order.productTotalCents ?? 0,
    shippingFeeCents: order.shippingFeeCents ?? 0,
    amountCents: order.amountCents,
    note: order.note ?? '',
    items: order.items.map((item) => ({
      id: item.id,
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
    })),
  };
}

function requireStoryApplication(): LocalApplication {
  if (!state.application) throw new Error('验收故事未初始化：前置用例可能已失败');
  return state.application;
}

function requireStoryOrder(key: string): OrderSummary {
  const order = state.orders.get(key);
  if (!order) throw new Error(`验收故事缺少订单 ${key}：前置用例可能已失败`);
  return order;
}

function requireOrder(application: LocalApplication, orderNumber: string): OrderSummary {
  const summary = application.listOrders().find((order) => order.orderNumber === orderNumber);
  if (!summary) throw new Error(`缺少订单：${orderNumber}`);
  return summary;
}

function sheetTexts(worksheet: ExcelJS.Worksheet): string[][] {
  const texts: string[][] = [];
  worksheet.eachRow((row) => {
    const values = row.values;
    if (!Array.isArray(values)) throw new Error('导出行格式无效');
    texts.push(values.slice(1).map((value: unknown) => {
      if (value === null || value === undefined) return '';
      if (value instanceof Date) return value.toISOString();
      if (typeof value === 'object') {
        const rich = value as { text?: unknown; result?: unknown };
        return String(rich.text ?? rich.result ?? '');
      }
      return String(value);
    }));
  });
  return texts;
}

function sheetHasCell(worksheet: ExcelJS.Worksheet, cellText: string): boolean {
  return sheetTexts(worksheet).some((row) => row.some((text) => text === cellText));
}

afterAll(() => {
  for (const application of applications.splice(0)) application.close();
  state.application = null;
  state.orders.clear();
});

describe('第二阶段业务闭环验收', () => {
  it('历史工作簿预览导入并落地四种商品场景', async () => {
    const application = await ensureApplication();

    const whiteShoe = application.createStandardProduct({
      sku: 'SKU-STAGE2-A',
      name: '十二分娃鞋白胚',
      specification: '小号',
    });
    // 无映射的精确同名规格商品：导入命中 exact 路径（映射优先于精确一致）。
    const linenBag = application.createStandardProduct({
      sku: 'SKU-STAGE2-C',
      name: '亚麻收纳袋',
      specification: '米白 大号',
    });

    application.createProductMapping(whiteShoe.id, {
      sourceTitle: '十二分娃鞋白胚',
      sourceSpec: '小号',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '娃物账号',
    });

    const workbook = await historyWorkbook([
      historyRow({
        orderNumber: '202608200000000001',
        amountYuan: 24.5,
        productTotalYuan: 24.5,
        title: '十二分娃鞋白胚',
        spec: '小号',
        unitPriceYuan: 8,
        quantity: 2,
      }),
      historyRow({
        orderNumber: '202608200000000001',
        amountYuan: 24.5,
        productTotalYuan: 24.5,
        title: '十二分娃鞋白胚闲鱼专拍',
        spec: '小号',
        unitPriceYuan: 8.5,
        quantity: 1,
      }),
      historyRow({
        orderNumber: '202608200000000002',
        recipient: '林岚（公司）',
        orderedAt: '2026-08-20 10:05:00',
        paidAt: '2026-08-20 10:05:30',
      }),
      historyRow({
        orderNumber: '202608200000000003',
        address: '广东省深圳市福田区验收路9号',
        title: '标签贴',
        spec: '透明',
        unitPriceYuan: 5,
        quantity: 2,
        orderedAt: '2026-08-20 10:10:00',
        paidAt: '2026-08-20 10:10:30',
      }),
      historyRow({
        orderNumber: '202608200000000004',
        recipient: '陈默',
        phone: '13800001003',
        address: '广东省深圳市南山区验收路5号',
        title: '玻璃罐',
        spec: '透明',
        unitPriceYuan: 6,
        quantity: 1,
        amountYuan: 6,
        productTotalYuan: 6,
        orderedAt: '2026-08-20 10:15:00',
        paidAt: '2026-08-20 10:15:30',
      }),
      historyRow({
        orderNumber: '202608200000000005',
        recipient: '苏叶',
        phone: '13800001002',
        address: '广东省深圳市南山区验收路2号',
        orderedAt: '2026-08-20 10:20:00',
        paidAt: '2026-08-20 10:20:30',
      }),
    ]);

    const inspection = await application.inspectHistoricalOrderWorkbook(workbook);
    const preview = await application.previewHistoricalOrderImport(workbook, {
      columnMapping: inspection.suggestedColumnMapping,
    });
    expect(preview.summary).toEqual({
      createOrderCount: 5,
      updateOrderCount: 0,
      duplicateOrderCount: 0,
      errorRowCount: 0,
    });

    const result = await application.confirmHistoricalOrderImport(workbook, '旧订单.xlsx', {
      columnMapping: inspection.suggestedColumnMapping,
      previewToken: preview.previewToken,
    });
    expect(result).toEqual({
      createdOrderCount: 5,
      updatedOrderCount: 0,
      skippedDuplicateOrderCount: 0,
      skippedErrorRowCount: 0,
    });

    const first = requireOrder(application, '202608200000000001');
    const details = application.getOrder(first.id).order;
    expect(details.items).toHaveLength(2);
    expect(details.items[0]).toMatchObject({
      sourceTitle: '十二分娃鞋白胚',
      standardProduct: expect.objectContaining({ id: whiteShoe.id }),
      standardizationSource: 'mapping',
    });
    expect(details.items[1]).toMatchObject({
      sourceTitle: '十二分娃鞋白胚闲鱼专拍',
      standardProduct: null,
    });

    const secondOrder = requireOrder(application, '202608200000000002');
    expect(application.getOrder(secondOrder.id).order.items[0]).toMatchObject({
      sourceTitle: '亚麻收纳袋',
      standardProduct: expect.objectContaining({ id: linenBag.id }),
      standardizationSource: 'exact',
    });

    const similar = application.queryOrderItems({ similarText: '十二分娃鞋白胚' }).items
      .map((item) => item.sourceTitle).sort();
    expect(similar).toEqual(['十二分娃鞋白胚', '十二分娃鞋白胚闲鱼专拍']);

    const catalogBuffer = await duplicateSkuCatalogWorkbook();
    const catalogPreview = await application.previewProductCatalogImport(catalogBuffer, {
      columnMapping: STAGE_TWO_CATALOG_MAPPING,
      duplicateSkuResolutions: [],
    });
    expect(catalogPreview.duplicateSkus).toEqual([{
      skuKey: 'SKU-STAGE2-DUP',
      rowNumbers: [2, 3],
      selectedRowNumber: null,
    }]);
    await expect(application.confirmProductCatalogImport(catalogBuffer, {
      columnMapping: STAGE_TWO_CATALOG_MAPPING,
      duplicateSkuResolutions: [],
      previewToken: catalogPreview.previewToken,
      mappingUpdateReason: '',
    })).rejects.toThrow('重复 SKU 必须全部明确选择保留行');
    const resolvedPreview = await application.previewProductCatalogImport(catalogBuffer, {
      columnMapping: STAGE_TWO_CATALOG_MAPPING,
      duplicateSkuResolutions: [{ skuKey: 'SKU-STAGE2-DUP', selectedRowNumber: 3 }],
    });
    await application.confirmProductCatalogImport(catalogBuffer, {
      columnMapping: STAGE_TWO_CATALOG_MAPPING,
      duplicateSkuResolutions: [{ skuKey: 'SKU-STAGE2-DUP', selectedRowNumber: 3 }],
      previewToken: resolvedPreview.previewToken,
      mappingUpdateReason: '',
    });

    const specialShoe = application.createStandardProduct({
      sku: 'SKU-STAGE2-B',
      name: '十二分娃鞋白胚闲鱼专拍',
      specification: '小号',
    });
    const batchOptions = {
      standardDisplayPreference: 'prefer_standard' as const,
      useDefaultOrderPrice: false,
      updateProductTotal: false,
      createMappings: true,
    };
    const batchPreview = application.previewOrderItemStandardizationBatch({
      itemIds: [details.items[1].id],
      standardProductId: specialShoe.id,
      options: batchOptions,
    });
    expect(batchPreview.createMappingsRequested).toBe(true);
    expect(batchPreview.plannedMappingCreationCount).toBe(1);
    expect(batchPreview.mappingConflictCount).toBe(0);

    application.applyOrderItemStandardizationBatch({
      itemIds: [details.items[1].id],
      standardProductId: specialShoe.id,
      options: batchOptions,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [],
      confirmedMappingConflictItemIds: [],
      expectedOrderRevisions: batchPreview.orders.map((order) => ({
        orderId: order.orderId,
        revision: order.revision,
      })),
    });
    expect(application.getOrder(first.id).order.items[1]).toMatchObject({
      standardProduct: expect.objectContaining({ id: specialShoe.id }),
    });
    state.specialShoeProductId = specialShoe.id;

    clearOrderPhone(state.dataDirectory, '202608200000000004');
    state.orders.set('H1', first);
    state.orders.set('H2', requireOrder(application, '202608200000000002'));
    state.orders.set('H3', requireOrder(application, '202608200000000003'));
    state.orders.set('H4', requireOrder(application, '202608200000000004'));
    state.orders.set('H5', requireOrder(application, '202608200000000005'));
  });

  it('合并发货覆盖六种场景并在取消退款后重算', () => {
    const application = requireStoryApplication();
    const H1 = requireStoryOrder('H1');
    const H2 = requireStoryOrder('H2');
    const H3 = requireStoryOrder('H3');

    const initial = application.queryShipmentGroups();
    expect(initial.groups.map((group) => group.orderCount).sort()).toEqual([1, 1, 2]);
    const merged = initial.groups.find((group) => group.orderCount === 2);
    expect(merged).toMatchObject({
      phoneNormalized: '13800001001',
      addressNormalized: '广东省深圳市南山区验收路1号',
      orderCount: 2,
      totalAmountCents: 3_450,
    });
    expect(merged?.orders.map((order) => order.orderNumber)).toEqual(
      ['202608200000000001', '202608200000000002'],
    );
    expect(initial.groups.filter((group) => group.addressNormalized.includes('福田区')))
      .toHaveLength(1);
    expect(initial.attentionOrders).toEqual([
      expect.objectContaining({
        id: state.orders.get('H4')!.id,
        reasons: expect.arrayContaining(['missing_phone']),
      }),
    ]);

    const split = application.splitShipmentGroup({
      groupId: merged!.id,
      expectedMemberOrderIds: merged!.orders.map(({ id }) => id),
      splitOrderIds: [H2.id],
      reason: '公司单需要单独包装',
    });
    expect(split.projection.groups.map((group) => group.orderCount).sort())
      .toEqual([1, 1, 1, 1]);

    const recombined = application.mergeShipmentGroups({
      groupIds: split.projection.groups
        .filter((group) => group.addressNormalized === '广东省深圳市南山区验收路1号')
        .map(({ id }) => id),
      expectedMemberOrderIds: [H1.id, H2.id],
      selectedRecipientOrderId: H1.id,
      reason: '买家要求一起发货',
    });
    const recombinedGroup = recombined.projection.groups
      .find((group) => group.orders.length === 2);
    expect(recombinedGroup?.orders.map((order) => order.orderNumber).sort())
      .toEqual(['202608200000000001', '202608200000000002'].sort());
    expect(application.listShipmentGroupAdjustmentEvents()).toEqual([
      expect.objectContaining({ operation: 'split' }),
      expect.objectContaining({ operation: 'merge' }),
    ]);

    application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: H2.id, expectedRevision: application.getOrder(H2.id).order.revision }],
      patch: { platformTransactionStatus: 'cancelled' },
    });
    const afterCancel = application.queryShipmentGroups();
    expect(afterCancel.groups.find((group) => group.orders.some(({ id }) => id === H1.id)))
      .toMatchObject({ orderCount: 1 });

    application.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: H3.id, expectedRevision: application.getOrder(H3.id).order.revision }],
      patch: { platformTransactionStatus: 'refunded' },
    });
    const afterRefund = application.queryShipmentGroups();
    expect(afterRefund.groups.some((group) => group.orders.some(({ id }) => id === H3.id)))
      .toBe(false);
    expect(afterRefund.groups.map((group) => group.orderCount).sort()).toEqual([1, 1]);
  });

  it('发货快照冻结且同买家后续新订单进入新组', async () => {
    const application = requireStoryApplication();
    const H1 = requireStoryOrder('H1');

    const group = application.queryShipmentGroups().groups
      .find((candidate) => candidate.orders.some(({ id }) => id === H1.id))!;
    const remainingItems = group.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    const result = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: remainingItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-STAGE2-0001',
        items: remainingItems,
      }],
    });
    expect(result.record.packages[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderNumber: '202608200000000001',
        sourceTitle: '十二分娃鞋白胚',
        sourceSpec: '小号',
      }),
      expect.objectContaining({
        orderNumber: '202608200000000001',
        sourceTitle: '十二分娃鞋白胚闲鱼专拍',
        sourceSpec: '小号',
      }),
    ]));
    const frozen = result.record;

    // 发货后变化：修改已发货订单的收货地址，快照字段保持冻结，只在记录与档案留下差异提醒。
    const shippedOrder = application.getOrder(H1.id).order;
    application.confirmOrderEdit({
      ...orderEditInput(shippedOrder),
      addressOriginal: '广东省深圳市南山区验收路1号东侧',
    });
    const changedRecords = application.queryShipmentRecords();
    expect(changedRecords).toHaveLength(1);
    expect(changedRecords[0]).toMatchObject({
      recipient: frozen.recipient,
      phone: frozen.phone,
      addressOriginal: frozen.addressOriginal,
      packages: frozen.packages,
    });
    expect(changedRecords[0]?.sourceDifferences).toEqual([
      expect.objectContaining({
        orderId: H1.id,
        field: 'addressOriginal',
        snapshotValue: '广东省深圳市南山区验收路1号',
        currentValue: '广东省深圳市南山区验收路1号东侧',
      }),
    ]);
    const afterChange = application.queryShipmentGroupArchives();
    expect(afterChange[0]?.recipientDifferences).toEqual([
      expect.objectContaining({
        orderId: H1.id,
        fields: expect.arrayContaining(['address']),
      }),
    ]);

    const followUp = await historyWorkbook([
      historyRow({
        orderNumber: '202608200000000006',
        title: '十二分娃鞋白胚',
        spec: '小号',
        unitPriceYuan: 8,
        quantity: 1,
        amountYuan: 8,
        productTotalYuan: 8,
        orderedAt: '2026-08-20 11:00:00',
        paidAt: '2026-08-20 11:00:30',
      }),
      historyRow({
        orderNumber: '202608200000000007',
        title: '十二分娃鞋白胚闲鱼专拍',
        spec: '小号',
        unitPriceYuan: 8.5,
        quantity: 1,
        amountYuan: 8.5,
        productTotalYuan: 8.5,
        orderedAt: '2026-08-20 11:05:00',
        paidAt: '2026-08-20 11:05:30',
      }),
    ]);
    const inspection = await application.inspectHistoricalOrderWorkbook(followUp);
    const preview = await application.previewHistoricalOrderImport(followUp, {
      columnMapping: inspection.suggestedColumnMapping,
    });
    const imported = await application.confirmHistoricalOrderImport(followUp, '后续订单.xlsx', {
      columnMapping: inspection.suggestedColumnMapping,
      previewToken: preview.previewToken,
    });
    expect(imported.createdOrderCount).toBe(2);

    const H6 = requireOrder(application, '202608200000000006');
    const H7 = requireOrder(application, '202608200000000007');
    expect(application.getOrder(H7.id).order.items[0]).toMatchObject({
      sourceTitle: '十二分娃鞋白胚闲鱼专拍',
      standardProduct: expect.objectContaining({ id: state.specialShoeProductId }),
      standardizationSource: 'mapping',
    });

    const projection = application.queryShipmentGroups();
    const newGroup = projection.groups
      .find((candidate) => candidate.orders.some(({ id }) => id === H6.id));
    expect(newGroup).toMatchObject({
      phoneNormalized: '13800001001',
      orderCount: 2,
    });
    expect(newGroup?.orders.map((order) => order.orderNumber).sort())
      .toEqual(['202608200000000006', '202608200000000007'].sort());

    // 档案只含实际发出时的成员：发货前已取消的 H2 不进档案，同买家新订单也不得混入。
    const archives = application.queryShipmentGroupArchives();
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatchObject({
      orderIds: [H1.id],
      status: 'fully_shipped',
    });

    const finalRecords = application.queryShipmentRecords();
    expect(finalRecords).toHaveLength(1);
    expect(finalRecords[0]).toMatchObject({
      recipient: frozen.recipient,
      addressOriginal: frozen.addressOriginal,
      packages: frozen.packages,
    });
    state.orders.set('H6', H6);
    state.orders.set('H7', H7);
  });

  it('三表导出由重新读取的实际工作簿验证', async () => {
    const application = requireStoryApplication();
    const H6 = requireStoryOrder('H6');

    const group = application.queryShipmentGroups().groups
      .find((candidate) => candidate.orders.some(({ id }) => id === H6.id))!;
    const baseExport = {
      shipmentGroups: [{
        id: group.id,
        expectedMemberOrderIds: group.orders.map(({ id }) => id),
      }],
      orderTemplateId: null,
      orderItemTemplateId: null,
      shipmentGroupTemplateId: null,
    };

    const maskedPath = join(state.testRoot, '三表导出-默认脱敏.xlsx');
    await application.exportShipmentGroupsToWorkbook(
      baseExport,
      maskedPath,
    );
    const maskedWorkbook = new ExcelJS.Workbook();
    await maskedWorkbook.xlsx.readFile(maskedPath);
    const maskedGroupSheet = maskedWorkbook.getWorksheet('合并发货表');
    if (!maskedGroupSheet) throw new Error('缺少合并发货表');
    expect(sheetHasCell(maskedGroupSheet, '13800001001')).toBe(false);

    const originalRules = {
      buyer_nickname: 'original' as const,
      recipient: 'original' as const,
      phone: 'original' as const,
      address: 'original' as const,
    };
    const orderTemplate = application.createTableTemplate({
      name: '验收内部订单表',
      granularity: 'order',
      columns: [
        { field: { kind: 'builtin', key: 'system_order_number' }, displayName: '系统订单编号' },
      ],
      query: {},
      maskingRules: originalRules,
    });
    const groupTemplate = application.createTableTemplate({
      name: '验收内部发货表',
      granularity: 'shipment_group',
      columns: [
        { field: { kind: 'builtin', key: 'phone' }, displayName: '手机号' },
        { field: { kind: 'builtin', key: 'address' }, displayName: '最终收货地址' },
      ],
      query: {},
      maskingRules: originalRules,
    });
    const plainPath = join(state.testRoot, '三表导出-模板完整显示.xlsx');
    await application.exportShipmentGroupsToWorkbook(
      {
        ...baseExport,
        orderTemplateId: orderTemplate.id,
        shipmentGroupTemplateId: groupTemplate.id,
      },
      plainPath,
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(plainPath);
    const ordersSheet = workbook.getWorksheet('订单总表');
    const itemsSheet = workbook.getWorksheet('订单商品明细表');
    const groupSheet = workbook.getWorksheet('合并发货表');
    if (!ordersSheet || !itemsSheet || !groupSheet) throw new Error('三表导出缺少工作表');

    const H6System = requireOrder(application, '202608200000000006').systemOrderNumber;
    const H7System = requireOrder(application, '202608200000000007').systemOrderNumber;
    expect(sheetHasCell(ordersSheet, H6System)).toBe(true);
    expect(sheetHasCell(ordersSheet, H7System)).toBe(true);
    expect(sheetHasCell(itemsSheet, '十二分娃鞋白胚')).toBe(true);
    expect(sheetHasCell(itemsSheet, '十二分娃鞋白胚闲鱼专拍')).toBe(true);
    expect(sheetHasCell(groupSheet, '13800001001')).toBe(true);
    expect(sheetHasCell(groupSheet, '广东省深圳市南山区验收路1号')).toBe(true);
  });

  it('关闭重开与备份恢复后业务闭环状态一致', async () => {
    const application = requireStoryApplication();
    const H6 = requireStoryOrder('H6');

    const captured = {
      groups: application.queryShipmentGroups(),
      records: application.queryShipmentRecords(),
      orders: application.listOrders(),
    };

    application.close();
    const reopened = new LocalApplication(new ControlledRecognizer({} as never));
    applications.push(reopened);
    reopened.openDataDirectory(state.dataDirectory);
    expect(reopened.queryShipmentGroups()).toEqual(captured.groups);
    expect(reopened.queryShipmentRecords()).toEqual(captured.records);
    expect(reopened.listOrders()).toEqual(captured.orders);
    reopened.close();
    applications.splice(applications.indexOf(reopened), 1);

    const workspace = Workspace.open(state.dataDirectory);
    const backup = await createBackup({
      dataDirectory: state.dataDirectory,
      database: workspace.database,
      backupRootDirectory: join(state.testRoot, '备份库'),
      appVersion: '0.2.65',
      now: () => new Date('2026-08-20T12:00:00+08:00'),
    });
    workspace.close();

    const mutated = new LocalApplication(new ControlledRecognizer({} as never));
    applications.push(mutated);
    mutated.openDataDirectory(state.dataDirectory);
    mutated.updateOrderPlatformTransactionStatus({
      targets: [{ orderId: H6.id, expectedRevision: mutated.getOrder(H6.id).order.revision }],
      patch: { platformTransactionStatus: 'cancelled' },
    });
    expect(
      mutated.queryShipmentGroups().groups
        .flatMap((group) => group.orders.map((order) => order.orderNumber))
        .sort(),
    ).toEqual(['202608200000000005', '202608200000000007']);
    mutated.close();
    applications.splice(applications.indexOf(mutated), 1);

    const restoredDirectory = join(state.testRoot, '恢复后的数据');
    const restoredBackup = await restoreBackup({
      backupDirectory: backup.backupDirectory,
      targetDirectory: restoredDirectory,
      currentDataDirectory: state.dataDirectory,
    });
    expect(restoredBackup.verification.ok).toBe(true);

    const restored = new LocalApplication(new ControlledRecognizer({} as never));
    applications.push(restored);
    restored.openDataDirectory(restoredDirectory);
    expect(restored.queryShipmentGroups()).toEqual(captured.groups);
    expect(restored.queryShipmentRecords()).toEqual(captured.records);
    expect(restored.listOrders()).toEqual(captured.orders);
  });
});
