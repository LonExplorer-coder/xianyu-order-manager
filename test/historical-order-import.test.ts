import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';

import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import type { OrderEditInput, OriginalOrder } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';

const openedApplications: LocalApplication[] = [];

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

async function openApplication(prefix: string): Promise<LocalApplication> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const application = new LocalApplication(new ControlledRecognizer({} as never));
  openedApplications.push(application);
  application.openDataDirectory(join(root, '数据'));
  return application;
}

async function previewWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('旧订单');
  worksheet.addRow([
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
  ]);
  worksheet.addRow([
    '闲鱼',
    '娃物账号',
    '202608200000000001',
    '张三',
    '13800138000',
    '广东省深圳市南山区科技园 1 号',
    108.5,
    '海棠杯',
    '红色 450ml',
    100,
    1,
    100,
    8.5,
    '已付款',
    '待发货',
    '2026-08-19 10:00:00',
    '2026-08-19 10:01:00',
  ]);
  worksheet.addRow([
    '闲鱼',
    '娃物账号',
    '',
    '李四',
    '13900139000',
    '广东省深圳市福田区深南大道 2 号',
    20,
    '错误行商品',
    '',
    20,
    1,
    20,
    0,
    '已付款',
    '待发货',
    '',
    '',
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function updatedWorkbook(itemPrice = 50): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('旧订单');
  worksheet.addRow([
    '交易平台', '业务账号', '平台单号', '收件姓名', '联系电话', '完整地址',
    '实付金额', '商品标题', '商品规格', '商品单价', '购买数量', '商品总价', '运费',
    '交易状态', '发货状态', '下单时间', '付款时间',
  ]);
  const orderValues = [
    '闲鱼', '娃物账号', '202608200000000001', '张三（更新）', '13800138000',
    '广东省深圳市南山区科技园 1 号', 158.5,
  ];
  worksheet.addRow([
    ...orderValues, '海棠杯', '红色 450ml', 100, 1, 150, 8.5,
    '已付款', '待发货', '2026-08-19 10:00:00', '2026-08-19 10:01:00',
  ]);
  worksheet.addRow([
    ...orderValues, '杯垫', '红色', itemPrice, 1, 150, 8.5,
    '已付款', '待发货', '2026-08-19 10:00:00', '2026-08-19 10:01:00',
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const fullHistoricalHeaders = [
  '交易平台', '业务账号', '平台单号', '支付宝交易号', '买家昵称', '收件姓名', '联系电话', '完整地址',
  '下单时间', '付款时间', '商品总价', '运费', '实付金额', '交易状态', '发货状态', '商品标题', '商品规格', '商品单价', '购买数量',
] as const;

async function historicalWorkbook(
  rows: readonly (readonly unknown[])[],
  headers: readonly string[] = fullHistoricalHeaders,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('旧订单');
  worksheet.addRow([...headers]);
  for (const row of rows) worksheet.addRow([...row]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function fullHistoricalRow(overrides: {
  recipient?: string;
  itemTitle?: string;
  itemSpec?: string;
  quantity?: number;
  orderNumber?: string;
} = {}): unknown[] {
  return [
    '闲鱼', '娃物账号', overrides.orderNumber ?? '202608200000000099',
    'ALI-20260820-0099', '原买家', overrides.recipient ?? '张三', '13800138000',
    '广东省深圳市南山区科技园 1 号', '2026-08-19 10:00:00', '2026-08-19 10:01:00',
    100, 8.5, 108.5, '已付款', '待发货', overrides.itemTitle ?? '海棠杯',
    overrides.itemSpec ?? '红色 450ml', 100, overrides.quantity ?? 1,
  ];
}

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
    productTotalCents: order.productTotalCents,
    shippingFeeCents: order.shippingFeeCents,
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

describe('历史订单工作簿', () => {
  it('先预览合法订单与缺少身份的错误行，且确认前不写入', async () => {
    const application = await openApplication('xianyu-historical-order-preview-');
    const standardProduct = application.createStandardProduct({
      sku: 'SKU-HAITANG-450',
      name: '海棠杯',
      specification: '红色 450ml',
    });
    const orderField = application.createCustomFieldDefinition({
      name: '历史批次',
      granularity: 'order',
      type: 'text',
      required: true,
      defaultValue: '待复核',
      options: [],
    });
    const itemField = application.createCustomFieldDefinition({
      name: '拣货区',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: 'A 区',
      options: [],
    });
    const buffer = await previewWorkbook();

    const inspection = await application.inspectHistoricalOrderWorkbook(buffer);
    expect(inspection.worksheets).toEqual([
      expect.objectContaining({
        name: '旧订单',
        headers: expect.arrayContaining(['交易平台', '业务账号', '平台单号', '商品标题']),
      }),
    ]);
    expect(inspection.suggestedColumnMapping).toEqual({
      worksheet: '旧订单',
      columns: {
        platform: 1,
        sellerAccount: 2,
        orderNumber: 3,
        recipient: 4,
        phone: 5,
        address: 6,
        amount: 7,
        itemTitle: 8,
        itemSpec: 9,
        unitPrice: 10,
        quantity: 11,
        productTotal: 12,
        shippingFee: 13,
        platformTransactionStatus: 14,
        fulfillmentStatus: 15,
        orderedAt: 16,
        paidAt: 17,
        alipayTransactionNumber: null,
        buyerNickname: null,
      },
    });

    const preview = await application.previewHistoricalOrderImport(buffer, {
      columnMapping: inspection.suggestedColumnMapping,
    });

    expect(application.listOrders()).toHaveLength(0);
    expect(preview.summary).toEqual({
      createOrderCount: 1,
      updateOrderCount: 0,
      duplicateOrderCount: 0,
      errorRowCount: 1,
    });
    expect(preview.orders).toEqual([
      expect.objectContaining({
        rowNumbers: [2],
        platform: 'xianyu',
        sellerAccount: '娃物账号',
        orderNumber: '202608200000000001',
        action: 'create',
        itemCount: 1,
        amountCents: 10_850,
        errors: [],
      }),
    ]);
    expect(preview.errorRows).toEqual([
      expect.objectContaining({
        rowNumber: 3,
        orderNumber: '',
        errors: ['平台订单编号不能为空'],
      }),
    ]);
    expect(preview.errorRows[0]?.orderNumber).not.toMatch(/^IMPORT-/u);
    const errorWorkbookBuffer = await application.createHistoricalOrderErrorRowsWorkbook(
      buffer,
      {
        columnMapping: inspection.suggestedColumnMapping,
        previewToken: preview.previewToken,
      },
    );
    const errorWorkbook = new ExcelJS.Workbook();
    await errorWorkbook.xlsx.load(errorWorkbookBuffer as never);
    const errorWorksheet = errorWorkbook.getWorksheet('错误行');
    expect(errorWorksheet?.getRow(1).values).toEqual([
      undefined,
      '原工作表行号',
      ...inspection.worksheets[0].headers,
      '错误原因',
    ]);
    expect(errorWorksheet?.getRow(2).getCell(1).value).toBe(3);
    expect(errorWorksheet?.getRow(2).getCell(4).text).toBe('');
    expect(errorWorksheet?.getRow(2).getCell(errorWorksheet.columnCount).text)
      .toBe('平台订单编号不能为空');

    const result = await application.confirmHistoricalOrderImport(buffer, '旧订单.xlsx', {
      columnMapping: inspection.suggestedColumnMapping,
      previewToken: preview.previewToken,
    });
    expect(result).toEqual({
      createdOrderCount: 1,
      updatedOrderCount: 0,
      skippedDuplicateOrderCount: 0,
      skippedErrorRowCount: 1,
    });
    const [saved] = application.listOrders();
    expect(saved).toMatchObject({
      orderNumber: '202608200000000001',
      sellerAccount: '娃物账号',
      amountCents: 10_850,
      itemCount: 1,
    });
    const details = application.getOrder(saved.id);
    expect(details.order.items[0]).toMatchObject({
      sourceTitle: '海棠杯',
      standardProduct: { id: standardProduct.id, sku: 'SKU-HAITANG-450' },
      standardizationSource: 'exact',
    });
    expect(details.customFieldValues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        definitionId: orderField.id,
        orderId: saved.id,
        value: '待复核',
      }),
      expect.objectContaining({
        definitionId: itemField.id,
        orderItemId: details.order.items[0].id,
        value: 'A 区',
      }),
    ]));
    expect(details.sourceScreenshot).toBeNull();
    expect(details.sourceSnapshot).toMatchObject({
      sourceType: 'historical_import',
      sourceName: '旧订单.xlsx',
      sourceRowNumbers: [2],
      recognition: {
        platform: 'xianyu',
        sellerAccount: '娃物账号',
        orderNumber: '202608200000000001',
      },
      confirmed: {
        platform: 'xianyu',
        sellerAccount: '娃物账号',
        orderNumber: '202608200000000001',
      },
    });

    const duplicatePreview = await application.previewHistoricalOrderImport(buffer, {
      columnMapping: inspection.suggestedColumnMapping,
    });
    expect(duplicatePreview.summary).toMatchObject({
      createOrderCount: 0,
      duplicateOrderCount: 1,
    });
    expect(duplicatePreview.orders[0]).toMatchObject({
      action: 'duplicate',
      existingOrderId: saved.id,
    });
  });

  it('把同一身份的多行合成一笔订单，预览差异后按版本保护更新', async () => {
    const application = await openApplication('xianyu-historical-order-update-');
    const baselineBuffer = await previewWorkbook();
    const baselineInspection = await application.inspectHistoricalOrderWorkbook(baselineBuffer);
    const baselinePreview = await application.previewHistoricalOrderImport(baselineBuffer, {
      columnMapping: baselineInspection.suggestedColumnMapping,
    });
    await application.confirmHistoricalOrderImport(baselineBuffer, '旧订单.xlsx', {
      columnMapping: baselineInspection.suggestedColumnMapping,
      previewToken: baselinePreview.previewToken,
    });

    const updateBuffer = await updatedWorkbook();
    const updateInspection = await application.inspectHistoricalOrderWorkbook(updateBuffer);
    const updatePreview = await application.previewHistoricalOrderImport(updateBuffer, {
      columnMapping: updateInspection.suggestedColumnMapping,
    });
    expect(updatePreview.orders).toEqual([
      expect.objectContaining({
        rowNumbers: [2, 3],
        orderNumber: '202608200000000001',
        action: 'update',
        expectedRevision: 1,
        itemCount: 2,
        errors: [],
        changes: expect.arrayContaining([
          expect.objectContaining({ path: 'recipient', after: '张三(更新)' }),
          expect.objectContaining({ path: 'items[1]' }),
        ]),
      }),
    ]);
    expect(updatePreview.summary).toMatchObject({
      createOrderCount: 0,
      updateOrderCount: 1,
      duplicateOrderCount: 0,
      errorRowCount: 0,
    });

    const result = await application.confirmHistoricalOrderImport(updateBuffer, '更新订单.xlsx', {
      columnMapping: updateInspection.suggestedColumnMapping,
      previewToken: updatePreview.previewToken,
    });
    expect(result).toEqual({
      createdOrderCount: 0,
      updatedOrderCount: 1,
      skippedDuplicateOrderCount: 0,
      skippedErrorRowCount: 0,
    });
    const [order] = application.listOrders();
    const details = application.getOrder(order.id);
    expect(details.order).toMatchObject({
      revision: 2,
      recipient: '张三(更新)',
      amountCents: 15_850,
      items: [
        expect.objectContaining({ sourceTitle: '海棠杯', quantitySource: 'legacy_explicit_or_manual' }),
        expect.objectContaining({ sourceTitle: '杯垫', quantitySource: 'legacy_explicit_or_manual' }),
      ],
    });
    expect(details.sources).toHaveLength(2);
    expect(details.sourceSnapshot).toMatchObject({
      sourceType: 'historical_import',
      sourceName: '更新订单.xlsx',
      sourceRowNumbers: [2, 3],
    });
    expect(details.changeEvents).toEqual([
      expect.objectContaining({
        source: 'source_update',
        baseRevision: 1,
        resultRevision: 2,
        sourceSnapshotId: details.sourceSnapshot.id,
      }),
    ]);
  });

  it('重复确认只跳过不新增来源，且订单变化后拒绝陈旧预览', async () => {
    const application = await openApplication('xianyu-historical-order-stale-');
    const baselineBuffer = await previewWorkbook();
    const baselineInspection = await application.inspectHistoricalOrderWorkbook(baselineBuffer);
    const baselineInput = { columnMapping: baselineInspection.suggestedColumnMapping };
    const baselinePreview = await application.previewHistoricalOrderImport(
      baselineBuffer,
      baselineInput,
    );
    await application.confirmHistoricalOrderImport(baselineBuffer, '旧订单.xlsx', {
      ...baselineInput,
      previewToken: baselinePreview.previewToken,
    });

    const duplicatePreview = await application.previewHistoricalOrderImport(
      baselineBuffer,
      baselineInput,
    );
    await expect(application.confirmHistoricalOrderImport(baselineBuffer, '重复订单.xlsx', {
      ...baselineInput,
      previewToken: duplicatePreview.previewToken,
    })).resolves.toEqual({
      createdOrderCount: 0,
      updatedOrderCount: 0,
      skippedDuplicateOrderCount: 1,
      skippedErrorRowCount: 1,
    });
    const [saved] = application.listOrders();
    expect(application.getOrder(saved.id).sources).toHaveLength(1);

    const staleBuffer = await updatedWorkbook(50);
    const staleInspection = await application.inspectHistoricalOrderWorkbook(staleBuffer);
    const staleInput = { columnMapping: staleInspection.suggestedColumnMapping };
    const stalePreview = await application.previewHistoricalOrderImport(staleBuffer, staleInput);

    const interveningBuffer = await updatedWorkbook(60);
    const interveningPreview = await application.previewHistoricalOrderImport(
      interveningBuffer,
      staleInput,
    );
    await application.confirmHistoricalOrderImport(interveningBuffer, '先一步更新.xlsx', {
      ...staleInput,
      previewToken: interveningPreview.previewToken,
    });

    await expect(application.confirmHistoricalOrderImport(staleBuffer, '陈旧更新.xlsx', {
      ...staleInput,
      previewToken: stalePreview.previewToken,
    })).rejects.toThrow('历史订单预览已过期，请重新预览');
    expect(application.getOrder(saved.id)).toMatchObject({
      order: { revision: 2 },
      sources: [
        { sourceSnapshot: { sourceName: '先一步更新.xlsx' } },
        { sourceSnapshot: { sourceName: '旧订单.xlsx' } },
      ],
    });
  });

  it('更新时保留未映射的可选字段', async () => {
    const application = await openApplication('xianyu-historical-order-optional-columns-');
    const baselineBuffer = await historicalWorkbook([fullHistoricalRow()]);
    const baselineInspection = await application.inspectHistoricalOrderWorkbook(baselineBuffer);
    const baselinePreview = await application.previewHistoricalOrderImport(baselineBuffer, {
      columnMapping: baselineInspection.suggestedColumnMapping,
    });
    await application.confirmHistoricalOrderImport(baselineBuffer, '完整历史订单.xlsx', {
      columnMapping: baselineInspection.suggestedColumnMapping,
      previewToken: baselinePreview.previewToken,
    });

    const minimalHeaders = [
      '交易平台', '业务账号', '平台单号', '收件姓名', '联系电话', '完整地址',
      '实付金额', '商品标题', '商品单价', '购买数量',
    ];
    const minimalBuffer = await historicalWorkbook([[
      '闲鱼', '娃物账号', '202608200000000099', '张三（更新）', '13800138000',
      '广东省深圳市南山区科技园 1 号', 108.5, '海棠杯', 100, 1,
    ]], minimalHeaders);
    const minimalInspection = await application.inspectHistoricalOrderWorkbook(minimalBuffer);
    const preview = await application.previewHistoricalOrderImport(minimalBuffer, {
      columnMapping: minimalInspection.suggestedColumnMapping,
    });
    expect(preview.orders[0]).toMatchObject({ action: 'update' });
    await application.confirmHistoricalOrderImport(minimalBuffer, '最小必填历史订单.xlsx', {
      columnMapping: minimalInspection.suggestedColumnMapping,
      previewToken: preview.previewToken,
    });

    const [saved] = application.listOrders();
    expect(application.getOrder(saved.id).order).toMatchObject({
      recipient: '张三(更新)',
      alipayTransactionNumber: 'ALI-20260820-0099',
      buyerNickname: '原买家',
      orderedAtOriginal: '2026-08-19 10:00:00',
      paidAtOriginal: '2026-08-19 10:01:00',
      productTotalCents: 10_000,
      shippingFeeCents: 850,
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      items: [expect.objectContaining({ sourceSpec: '红色 450ml' })],
    });
  });

  it('更新完全相同的多个商品时保留商品标识和自定义字段', async () => {
    const application = await openApplication('xianyu-historical-order-stable-items-');
    const baselineBuffer = await historicalWorkbook([fullHistoricalRow(), fullHistoricalRow()]);
    const inspection = await application.inspectHistoricalOrderWorkbook(baselineBuffer);
    const baselinePreview = await application.previewHistoricalOrderImport(baselineBuffer, {
      columnMapping: inspection.suggestedColumnMapping,
    });
    await application.confirmHistoricalOrderImport(baselineBuffer, '重复商品订单.xlsx', {
      columnMapping: inspection.suggestedColumnMapping,
      previewToken: baselinePreview.previewToken,
    });
    const [saved] = application.listOrders();
    const before = application.getOrder(saved.id);
    const location = application.createCustomFieldDefinition({
      name: '库位', granularity: 'order_item', type: 'text', required: false,
      defaultValue: null, options: [],
    });
    application.saveCustomFieldValues({
      orderId: saved.id,
      orderValues: [],
      itemValues: before.order.items.map((item, index) => ({
        definitionId: location.id,
        orderItemId: item.id,
        value: `${String.fromCharCode(65 + index)} 区`,
      })),
    });

    const updateBuffer = await historicalWorkbook([
      fullHistoricalRow({ recipient: '张三（更新）' }),
      fullHistoricalRow({ recipient: '张三（更新）' }),
    ]);
    const updatePreview = await application.previewHistoricalOrderImport(updateBuffer, {
      columnMapping: inspection.suggestedColumnMapping,
    });
    await application.confirmHistoricalOrderImport(updateBuffer, '重复商品更新.xlsx', {
      columnMapping: inspection.suggestedColumnMapping,
      previewToken: updatePreview.previewToken,
    });
    const after = application.getOrder(saved.id);
    expect(after.order.items.map(({ id }) => id)).toEqual(before.order.items.map(({ id }) => id));
    expect(after.customFieldValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderItemId: before.order.items[0].id, value: 'A 区' }),
      expect.objectContaining({ orderItemId: before.order.items[1].id, value: 'B 区' }),
    ]));
  });

  it('预览时就应用人工数量保护，保护后相同则直接标记重复', async () => {
    const application = await openApplication('xianyu-historical-order-manual-quantity-');
    const buffer = await historicalWorkbook([fullHistoricalRow()]);
    const inspection = await application.inspectHistoricalOrderWorkbook(buffer);
    const firstPreview = await application.previewHistoricalOrderImport(buffer, {
      columnMapping: inspection.suggestedColumnMapping,
    });
    await application.confirmHistoricalOrderImport(buffer, '人工数量订单.xlsx', {
      columnMapping: inspection.suggestedColumnMapping,
      previewToken: firstPreview.previewToken,
    });
    const [saved] = application.listOrders();
    const current = application.getOrder(saved.id).order;
    const edit = orderEditInput(current);
    edit.items[0].quantity = 2;
    application.confirmOrderEdit(edit);

    const preview = await application.previewHistoricalOrderImport(buffer, {
      columnMapping: inspection.suggestedColumnMapping,
    });
    expect(preview.orders[0]).toMatchObject({ action: 'duplicate', changes: [] });
    expect(preview.summary).toMatchObject({ updateOrderCount: 0, duplicateOrderCount: 1 });
  });

  it('拒绝将超过上限的商品行聚合为单笔订单', async () => {
    const application = await openApplication('xianyu-historical-order-item-limit-');
    const buffer = await historicalWorkbook(Array.from(
      { length: 101 },
      () => fullHistoricalRow({ orderNumber: '202608200000000100' }),
    ));
    const inspection = await application.inspectHistoricalOrderWorkbook(buffer);
    const preview = await application.previewHistoricalOrderImport(buffer, {
      columnMapping: inspection.suggestedColumnMapping,
    });
    expect(preview.orders).toEqual([]);
    expect(preview.summary.errorRowCount).toBe(101);
    expect(preview.errorRows[0]?.errors).toContain('同一原始订单的商品行不能超过 100 行');
  });

  it('预览时隔离商品小计超出安全范围的行', async () => {
    const application = await openApplication('xianyu-historical-order-subtotal-limit-');
    const row = fullHistoricalRow({ orderNumber: '202608200000000101', quantity: 2 });
    row[17] = 50_000_000_000_000;
    const buffer = await historicalWorkbook([row]);
    const inspection = await application.inspectHistoricalOrderWorkbook(buffer);
    const preview = await application.previewHistoricalOrderImport(buffer, {
      columnMapping: inspection.suggestedColumnMapping,
    });
    expect(preview.orders).toEqual([]);
    expect(preview.errorRows).toEqual([
      expect.objectContaining({ rowNumber: 2, errors: ['商品小计超出安全范围'] }),
    ]);
  });
});
