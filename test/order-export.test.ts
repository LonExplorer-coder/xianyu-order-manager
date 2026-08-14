import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  OrderEditInput,
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import type { CustomFieldType } from '../src/core/custom-fields';
import { LocalApplication } from '../src/main/local-application';
import {
  orderExportBuiltinTextLabel,
} from '../src/core/order-export';
import {
  writeOrderExportWorkbook,
  type OrderExportWorkbookPlan,
} from '../src/main/order-export-workbook';

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
): Promise<{ application: LocalApplication; testRoot: string }> {
  const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-order-export-'));
  const dataDirectory = join(testRoot, '数据');
  const uploadDirectory = join(testRoot, '上传');
  await mkdir(uploadDirectory, { recursive: true });
  const application = new LocalApplication(new SequenceRecognizer([...results]));
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);

  for (const [index] of results.entries()) {
    const sourcePath = join(uploadDirectory, `订单-${index}.png`);
    await writeFile(sourcePath, Buffer.from(`synthetic-export-order-${index}`));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    application.confirmDraft(batch.drafts[0]);
  }
  return { application, testRoot };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('默认脱敏的订单工作簿导出', () => {
  it('导出将当前履约五态显示为中文标签', () => {
    expect([
      'pending_shipment',
      'partially_shipped',
      'shipped',
      'delivered',
      'unknown',
    ].map((status) => (
      orderExportBuiltinTextLabel('fulfillment_status', status)
    ))).toEqual(['待发货', '部分发货', '已发货', '已收货', '未知']);
  });

  it('本次关闭脱敏时让真实预览和最终工作簿一致输出完整隐私字段', async () => {
    const { application, testRoot } = await createApplicationWithOrders([
      recognition({ orderNumber: 'XY-ORIGINAL-PRIVACY-001' }),
    ]);
    const order = application.queryOrders({}).orders[0];
    const input = {
      scope: { kind: 'selected_orders' as const, orderIds: [order.id] },
      orderTemplateId: null,
      includeOrderItems: false,
      orderItemTemplateId: null,
      masking: 'original' as const,
    };

    const preview = application.previewOrderExport(input);
    const orderSheet = preview.sheets[0];
    const values = new Map(orderSheet.columns.map((column, index) => (
      [column.header, orderSheet.rows[0][index]] as const
    )));
    expect({
      buyer: values.get('买家'),
      recipient: values.get('收件人'),
      phone: values.get('手机号'),
      address: values.get('收货地址'),
    }).toEqual({
      buyer: '海棠买家',
      recipient: '陈海棠',
      phone: '13800000001',
      address: '上海市浦东新区海棠路1号',
    });

    const destinationPath = join(testRoot, '原始隐私字段.xlsx');
    await application.exportOrdersToWorkbook(input, destinationPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    const worksheet = workbook.getWorksheet('订单总表');
    if (!worksheet) throw new Error('缺少订单总表');
    expect({
      buyer: cellByHeader(worksheet, 2, '买家').value,
      recipient: cellByHeader(worksheet, 2, '收件人').value,
      phone: cellByHeader(worksheet, 2, '手机号').value,
      address: cellByHeader(worksheet, 2, '收货地址').value,
    }).toEqual({
      buyer: '海棠买家',
      recipient: '陈海棠',
      phone: '13800000001',
      address: '上海市浦东新区海棠路1号',
    });
  });

  it('默认只导出订单总表，不查询也不生成订单商品明细表', async () => {
    const { application, testRoot } = await createApplicationWithOrders([
      recognition({ orderNumber: 'XY-ORDER-ONLY-001' }),
    ]);
    const orderId = application.queryOrders({}).orders[0].id;
    const destinationPath = join(testRoot, '默认订单总表.xlsx');
    const queryOrderItems = vi.spyOn(application, 'queryOrderItems');

    const outcome = await application.exportOrdersToWorkbook({
      scope: { kind: 'selected_orders', orderIds: [orderId] },
      orderTemplateId: null,
      includeOrderItems: false,
      orderItemTemplateId: null,
      masking: 'masked',
    }, destinationPath);

    expect(outcome).toEqual({ orderCount: 1, orderItemCount: null });
    expect(queryOrderItems).not.toHaveBeenCalled();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    expect(workbook.worksheets.map(({ name }) => name)).toEqual(['订单总表']);
  });

  it('预览与真实导出复用同一双表投影，分别只返回前五行且关闭附表时不查询商品', async () => {
    const results = Array.from({ length: 6 }, (_, index) => recognition({
      orderNumber: `XY-PREVIEW-${index + 1}`,
      items: [
        {
          sourceTitle: `预览商品-${index + 1}-A`,
          sourceSpec: '红色',
          unitPriceCents: 1_000,
          quantity: 1,
          quantityInferred: false,
        },
        {
          sourceTitle: `预览商品-${index + 1}-B`,
          sourceSpec: '蓝色',
          unitPriceCents: 800,
          quantity: 2,
          quantityInferred: false,
        },
        ...(index === 5 ? [{
          sourceTitle: '仅最后订单存在的第三件商品',
          sourceSpec: '绿色',
          unitPriceCents: 600,
          quantity: 1,
          quantityInferred: false,
        }] : []),
      ],
    }));
    const { application, testRoot } = await createApplicationWithOrders(results);
    const orderIds = application.queryOrders({}).orders.map(({ id }) => id);
    const queryOrderItems = vi.spyOn(application, 'queryOrderItems');
    const baseInput = {
      scope: { kind: 'current_result' as const, orderIds },
      orderTemplateId: null,
      includeOrderItems: false,
      orderItemTemplateId: null,
      masking: 'masked' as const,
    };

    const orderOnly = application.previewOrderExport(baseInput);
    expect(queryOrderItems).not.toHaveBeenCalled();
    expect(orderOnly).toMatchObject({
      orderCount: 6,
      orderItemCount: null,
      sheets: [{ name: '订单总表', totalRowCount: 6 }],
    });
    expect(orderOnly.sheets[0].rows).toHaveLength(5);

    const withItemsInput = {
      ...baseInput,
      includeOrderItems: true,
      orderItemTemplateId: null,
    };
    const preview = application.previewOrderExport(withItemsInput);
    expect(queryOrderItems).toHaveBeenLastCalledWith(
      {},
      [],
      orderIds.slice(0, 5),
      true,
    );
    expect(preview).toMatchObject({
      orderCount: 6,
      orderItemCount: 13,
      sheets: [
        { name: '订单总表', totalRowCount: 6 },
        { name: '订单商品明细表', totalRowCount: 13 },
      ],
    });
    expect(preview.sheets[0].rows).toHaveLength(5);
    expect(preview.sheets[1].rows).toHaveLength(5);
    expect(preview.sheets[0].columns.map(({ header }) => header)).toContain('商品3');
    expect(preview.sheets[1].columns.slice(0, 3).map(({ header }) => header))
      .toEqual(['系统订单编号', '订单号', '商品序号']);

    const destinationPath = join(testRoot, '双表真实投影.xlsx');
    await application.exportOrdersToWorkbook(withItemsInput, destinationPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    for (const sheet of preview.sheets) {
      const worksheet = workbook.getWorksheet(sheet.name);
      if (!worksheet) throw new Error(`缺少工作表：${sheet.name}`);
      expect(rowValues(worksheet, 1)).toEqual(sheet.columns.map(({ header }) => header));
      for (const [rowIndex, previewRow] of sheet.rows.entries()) {
        expect(previewRow).toEqual(
          sheet.columns.map((column, columnIndex) => previewCellText(
            worksheet.getRow(rowIndex + 2).getCell(columnIndex + 1).value,
            column.valueType,
          )),
        );
      }
    }
  });

  it('把当前筛选订单导出为一单一行和一商品条目一行，并以正确类型保存默认脱敏值', async () => {
    const { application, testRoot } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-EXPORT-001',
        items: [
          {
            sourceTitle: '夏日海棠杯',
            sourceSpec: '红色 450ml',
            unitPriceCents: 1_800,
            quantity: 2,
            quantityInferred: false,
          },
          {
            sourceTitle: '备用杯盖',
            sourceSpec: '透明',
            unitPriceCents: 600,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '默认数量勺',
            sourceSpec: '标准款',
            unitPriceCents: 300,
            quantity: 1,
            quantityInferred: true,
          },
          {
            sourceTitle: '历史来源杯垫',
            sourceSpec: '棉麻',
            unitPriceCents: 400,
            quantity: 3,
            quantityInferred: false,
          },
        ],
      }),
      recognition({
        orderNumber: 'XY-EXPORT-002',
        buyerNickname: '松果买家',
        recipient: '林松果',
        phone: '13900000002',
        phoneNormalized: '13900000002',
        addressOriginal: '广东省深圳市南山区松果路2号',
        addressNormalized: '广东省深圳市南山区松果路2号',
        province: '广东省',
        city: '深圳市',
        district: '南山区',
      }),
    ]);
    const destinationPath = join(testRoot, '订单导出.xlsx');
    await writeFile(destinationPath, Buffer.from('existing-workbook-contents'));
    const currentResultIds = application.queryOrders({ buyerText: '海棠' })
      .orders.map(({ id }) => id);
    const standardProduct = application.createStandardProduct({
      sku: 'CUP-SUMMER-RED',
      name: '标准海棠杯',
      specification: '红色 450ml 标准款',
    });
    const database = new DatabaseSync(join(testRoot, '数据', 'xianyu-order-manager.sqlite3'));
    try {
      database.prepare(`
        UPDATE order_items
        SET quantity_source = CASE position
          WHEN 0 THEN 'manual'
          WHEN 3 THEN 'legacy_explicit_or_manual'
          ELSE quantity_source
        END
        WHERE order_id = ?
      `).run(currentResultIds[0]);
      database.prepare(`
        UPDATE order_items
        SET standard_product_id = ?, standardization_source = 'manual'
        WHERE order_id = ? AND position = 0
      `).run(standardProduct.id, currentResultIds[0]);
    } finally {
      database.close();
    }

    const outcome = await application.exportOrdersToWorkbook({
      scope: {
        kind: 'current_result',
        orderIds: currentResultIds,
      },
      orderTemplateId: null,
      includeOrderItems: true,
      orderItemTemplateId: null,
      masking: 'masked',
    }, destinationPath);

    expect(outcome).toEqual({ orderCount: 1, orderItemCount: 4 });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    expect(workbook.worksheets.map(({ name }) => name)).toEqual(['订单总表', '订单商品明细表']);

    const orders = workbook.getWorksheet('订单总表');
    const items = workbook.getWorksheet('订单商品明细表');
    expect(orders?.rowCount).toBe(2);
    expect(items?.rowCount).toBe(5);
    if (!orders || !items) throw new Error('缺少导出工作表');
    const systemOrderNumber = application.getOrder(currentResultIds[0]).order.systemOrderNumber;
    expect(rowValues(items, 1).slice(0, 3))
      .toEqual(['系统订单编号', '订单号', '商品序号']);
    expect(rowValues(items, 2).slice(0, 3))
      .toEqual([systemOrderNumber, 'XY-EXPORT-001', 1]);
    expect(rowValues(items, 3).slice(0, 3))
      .toEqual([systemOrderNumber, 'XY-EXPORT-001', 2]);

    const defaultOrderHeaders = rowValues(orders, 1);
    const firstProductColumnIndex = defaultOrderHeaders.indexOf('商品1');
    expect(firstProductColumnIndex).toBeGreaterThanOrEqual(0);
    expect(defaultOrderHeaders.slice(firstProductColumnIndex, firstProductColumnIndex + 12)).toEqual([
      '商品1', '款式或规格1', '数量1',
      '商品2', '款式或规格2', '数量2',
      '商品3', '款式或规格3', '数量3',
      '商品4', '款式或规格4', '数量4',
    ]);
    expect(defaultOrderHeaders).toEqual([
      '系统订单编号', '订单号', '平台', '卖家账号', '买家', '收件人', '手机号', '收货地址',
      '商品1', '款式或规格1', '数量1',
      '商品2', '款式或规格2', '数量2',
      '商品3', '款式或规格3', '数量3',
      '商品4', '款式或规格4', '数量4',
      '商品总数量', '成交金额', '初始来源识别状态', '平台交易状态',
      '履约状态', '生命周期状态', '下单时间',
    ]);
    expect(defaultOrderHeaders).not.toContain('商品');
    expect(defaultOrderHeaders).not.toContain('备注');
    expect(defaultOrderHeaders).not.toContain('支付宝交易号');
    expect(cellByHeader(orders, 2, '商品1')).toMatchObject({
      value: '标准海棠杯',
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(orders, 2, '款式或规格1')).toMatchObject({
      value: '红色 450ml 标准款',
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(orders, 2, '数量1')).toMatchObject({
      value: 2,
      type: ExcelJS.ValueType.Number,
    });
    expect(cellByHeader(orders, 2, '商品2').value).toBe('备用杯盖');
    expect(cellByHeader(orders, 2, '商品4').value).toBe('历史来源杯垫');

    expect(rowValues(items, 1)).toEqual([
      '系统订单编号',
      '订单号',
      '商品序号',
      '原始商品标题',
      '原始款式／规格',
      'SKU',
      '标准商品名',
      '标准规格',
      '商品单价',
      '数量',
      '数量来源',
      '商品小计',
    ]);
    expect(cellByHeader(items, 2, '原始商品标题').value).toBe('夏日海棠杯');
    expect(cellByHeader(items, 2, '原始款式／规格').value).toBe('红色 450ml');
    expect(cellByHeader(items, 2, 'SKU').value).toBe('CUP-SUMMER-RED');
    expect(cellByHeader(items, 2, '标准商品名').value).toBe('标准海棠杯');
    expect(cellByHeader(items, 2, '标准规格').value).toBe('红色 450ml 标准款');

    expect(cellByHeader(orders, 2, '买家')).toMatchObject({
      value: '海**家',
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(orders, 2, '收件人')).toMatchObject({
      value: '陈**',
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(orders, 2, '手机号')).toMatchObject({
      value: '138****0001',
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(orders, 2, '收货地址')).toMatchObject({
      value: '上海市浦东新区***',
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(orders, 2, '订单号')).toMatchObject({
      value: 'XY-EXPORT-001',
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(orders, 2, '系统订单编号')).toMatchObject({
      value: systemOrderNumber,
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(orders, 2, '成交金额')).toMatchObject({
      value: 36,
      type: ExcelJS.ValueType.Number,
    });
    expect(cellByHeader(orders, 2, '下单时间')).toMatchObject({
      value: expect.any(Date),
      type: ExcelJS.ValueType.Date,
    });
    expect((cellByHeader(orders, 2, '下单时间').value as Date).toISOString())
      .toBe('2026-07-28T09:30:00.000Z');
    expect(cellByHeader(items, 2, '订单号')).toMatchObject({
      value: 'XY-EXPORT-001',
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(items, 2, '系统订单编号').value).toBe(systemOrderNumber);
    expect(cellByHeader(items, 2, '原始商品标题')).toMatchObject({
      value: '夏日海棠杯',
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(items, 2, '原始款式／规格')).toMatchObject({
      value: '红色 450ml',
      type: ExcelJS.ValueType.String,
    });
    expect(cellByHeader(items, 2, '商品单价')).toMatchObject({
      value: 18,
      type: ExcelJS.ValueType.Number,
    });
    expect(cellByHeader(items, 2, '数量')).toMatchObject({
      value: 2,
      type: ExcelJS.ValueType.Number,
    });
    expect([2, 3, 4, 5].map((rowNumber) => (
      cellByHeader(items, rowNumber, '数量来源')
    ))).toEqual([
      expect.objectContaining({ value: '人工修改', type: ExcelJS.ValueType.String }),
      expect.objectContaining({ value: 'OCR 识别', type: ExcelJS.ValueType.String }),
      expect.objectContaining({ value: '系统默认 1', type: ExcelJS.ValueType.String }),
      expect.objectContaining({
        value: '已明确（历史来源不明）',
        type: ExcelJS.ValueType.String,
      }),
    ]);
    expect(cellByHeader(items, 2, '商品小计')).toMatchObject({
      value: 36,
      type: ExcelJS.ValueType.Number,
    });
    expect(cellByHeader(items, 3, '原始商品标题')).toMatchObject({
      value: '备用杯盖',
      type: ExcelJS.ValueType.String,
    });

    const allCellText = workbook.worksheets.flatMap((worksheet) => (
      worksheet.getSheetValues().flat(Infinity).map(String)
    )).join('\n');
    expect(allCellText).not.toContain('陈海棠');
    expect(allCellText).not.toContain('13800000001');
    expect(allCellText).not.toContain('上海市浦东新区海棠路1号');
    expect(allCellText).not.toContain('海棠买家');
    expect(allCellText).not.toContain('XY-EXPORT-002');

    const definedNames: string[] = [];
    workbook.definedNames.forEach((name) => definedNames.push(name));
    expect(definedNames).toEqual([]);
    for (const worksheet of workbook.worksheets) {
      expect(worksheet.state).toBe('visible');
      worksheet.eachRow({ includeEmpty: true }, (row) => {
        expect(row.hidden).not.toBe(true);
        row.eachCell({ includeEmpty: true }, (cell) => {
          expect(cell.formula).toBeUndefined();
          expect(cell.hyperlink).toBeUndefined();
          expect(cell.note).toBeUndefined();
        });
      });
      for (let column = 1; column <= worksheet.columnCount; column += 1) {
        expect(worksheet.getColumn(column).hidden).not.toBe(true);
      }
    }

    const archiveText = await readZipText(destinationPath);
    expect(archiveText).not.toContain('陈海棠');
    expect(archiveText).not.toContain('13800000001');
    expect(archiveText).not.toContain('上海市浦东新区海棠路1号');
    expect(archiveText).not.toContain('海棠买家');
    expect(archiveText).not.toMatch(/<f(?:>|\s)/u);
    expect(archiveText).not.toContain('/comments');
  });

  it('人工修改后默认导出跟随当前视图，自定义模板仍可导出备注', async () => {
    const { application, testRoot } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-MANUAL-EXPORT-001',
        productTotalCents: 4_000,
        amountCents: 4_000,
        items: [
          {
            sourceTitle: '来源商品一',
            sourceSpec: '来源规格一',
            unitPriceCents: 1_000,
            quantity: 2,
            quantityInferred: false,
          },
          {
            sourceTitle: '来源商品二',
            sourceSpec: '来源规格二',
            unitPriceCents: 2_000,
            quantity: 1,
            quantityInferred: false,
          },
        ],
      }),
    ]);
    const before = application.getOrder(application.queryOrders({}).orders[0].id).order;
    const input: OrderEditInput = {
      orderId: before.id,
      expectedRevision: before.revision,
      identityCorrection: null,
      alipayTransactionNumber: before.alipayTransactionNumber,
      buyerNickname: before.buyerNickname,
      recipient: before.recipient,
      phone: before.phone,
      addressOriginal: before.addressOriginal,
      province: before.province,
      city: before.city,
      district: before.district,
      orderedAtOriginal: before.orderedAtOriginal,
      paidAtOriginal: before.paidAtOriginal,
      productTotalCents: 5_500,
      shippingFeeCents: before.shippingFeeCents ?? 0,
      amountCents: 5_500,
      note: '人工修改后的导出备注',
      items: [
        {
          id: before.items[0].id,
          sourceTitle: '人工商品一',
          sourceSpec: '人工规格一',
          unitPriceCents: 1_500,
          quantity: 3,
        },
        {
          id: before.items[1].id,
          sourceTitle: '人工商品二',
          sourceSpec: '人工规格二',
          unitPriceCents: 1_000,
          quantity: 1,
        },
      ],
    };
    const saved = application.confirmOrderEdit(input);
    const currentSummary = application.queryOrders({ text: '人工修改后的导出备注' }).orders[0];
    expect(currentSummary).toMatchObject({
      id: before.id,
      note: '人工修改后的导出备注',
      revision: 2,
      updatedAt: saved.order.updatedAt,
      lastManualEditAt: saved.lastManualEditAt,
    });
    expect(application.queryOrders({ productText: '人工商品一' }).orders)
      .toHaveLength(1);
    expect(application.queryOrders({ productText: '人工规格二' }).orders)
      .toHaveLength(1);

    const defaultPath = join(testRoot, '人工修改默认导出.xlsx');
    await application.exportOrdersToWorkbook({
      scope: { kind: 'selected_orders', orderIds: [before.id] },
      orderTemplateId: null,
      includeOrderItems: true,
      orderItemTemplateId: null,
      masking: 'masked',
    }, defaultPath);
    const defaultWorkbook = new ExcelJS.Workbook();
    await defaultWorkbook.xlsx.readFile(defaultPath);
    const defaultOrders = defaultWorkbook.getWorksheet('订单总表');
    const defaultItems = defaultWorkbook.getWorksheet('订单商品明细表');
    if (!defaultOrders || !defaultItems) throw new Error('缺少默认导出工作表');
    expect(rowValues(defaultOrders, 1)).not.toContain('备注');
    expect(cellByHeader(defaultOrders, 2, '商品1').value).toBe('人工商品一');
    expect(cellByHeader(defaultOrders, 2, '款式或规格1').value).toBe('人工规格一');
    expect(cellByHeader(defaultOrders, 2, '数量1').value).toBe(3);
    expect(cellByHeader(defaultOrders, 2, '商品2').value).toBe('人工商品二');
    expect(cellByHeader(defaultItems, 2, '原始商品标题').value).toBe('人工商品一');
    expect(cellByHeader(defaultItems, 2, '原始款式／规格').value).toBe('人工规格一');
    expect(cellByHeader(defaultItems, 2, '数量').value).toBe(3);

    const orderTemplate = application.createTableTemplate({
      name: '人工当前值订单模板',
      granularity: 'order',
      columns: [
        { field: { kind: 'builtin', key: 'note' }, displayName: '当前备注' },
        {
          kind: 'dynamic_product_group',
          labels: { product: '当前商品', specification: '当前规格', quantity: '当前数量' },
        },
      ],
      query: {},
    });
    const itemTemplate = application.createTableTemplate({
      name: '人工当前值商品模板',
      granularity: 'order_item',
      columns: [
        { field: { kind: 'builtin', key: 'product_title' }, displayName: '当前商品标题' },
        { field: { kind: 'builtin', key: 'product_spec' }, displayName: '当前商品规格' },
        { field: { kind: 'builtin', key: 'quantity' }, displayName: '当前商品数量' },
      ],
      query: {},
    });
    const customPath = join(testRoot, '人工修改自定义导出.xlsx');
    await application.exportOrdersToWorkbook({
      scope: { kind: 'selected_orders', orderIds: [before.id] },
      orderTemplateId: orderTemplate.id,
      includeOrderItems: true,
      orderItemTemplateId: itemTemplate.id,
      masking: 'masked',
    }, customPath);
    const customWorkbook = new ExcelJS.Workbook();
    await customWorkbook.xlsx.readFile(customPath);
    const customOrders = customWorkbook.getWorksheet('订单总表');
    const customItems = customWorkbook.getWorksheet('订单商品明细表');
    if (!customOrders || !customItems) throw new Error('缺少自定义导出工作表');
    expect(rowValues(customOrders, 1)).toEqual([
      '当前备注',
      '当前商品1', '当前规格1', '当前数量1',
      '当前商品2', '当前规格2', '当前数量2',
    ]);
    expect(cellByHeader(customOrders, 2, '当前备注').value).toBe('人工修改后的导出备注');
    expect(cellByHeader(customOrders, 2, '当前商品1').value).toBe('人工商品一');
    expect(cellByHeader(customOrders, 2, '当前规格1').value).toBe('人工规格一');
    expect(cellByHeader(customOrders, 2, '当前数量1').value).toBe(3);
    expect(rowValues(customItems, 1)).toEqual([
      '当前商品标题', '当前商品规格', '当前商品数量',
    ]);
    expect(rowValues(customItems, 2)).toEqual(['人工商品一', '人工规格一', 3]);
    expect(rowValues(customItems, 3)).toEqual(['人工商品二', '人工规格二', 1]);
  });

  it('当前结果完整展开并留空短订单尾列，所选订单只按自身宽度导出', async () => {
    const { application, testRoot } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-SCOPE-WIDE-001',
        productTotalCents: 3_000,
        amountCents: 3_000,
        items: [
          {
            sourceTitle: '同款海棠杯',
            sourceSpec: '红色',
            unitPriceCents: 1_000,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '同款海棠杯',
            sourceSpec: '蓝色',
            unitPriceCents: 1_000,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '备用杯盖',
            sourceSpec: '透明',
            unitPriceCents: 1_000,
            quantity: 1,
            quantityInferred: false,
          },
        ],
      }),
      recognition({
        orderNumber: 'XY-SCOPE-NARROW-002',
        productTotalCents: 1_000,
        amountCents: 1_000,
        items: [{
          sourceTitle: '单件海棠碟',
          sourceSpec: '棉麻',
          unitPriceCents: 500,
          quantity: 2,
          quantityInferred: false,
        }],
      }),
    ]);
    const ordersByNumber = new Map(
      application.queryOrders({ lifecycleStatus: 'all' }).orders
        .map((order) => [order.orderNumber, order]),
    );
    const wide = ordersByNumber.get('XY-SCOPE-WIDE-001');
    const narrow = ordersByNumber.get('XY-SCOPE-NARROW-002');
    if (!wide || !narrow) throw new Error('测试订单未入库');

    const currentPath = join(testRoot, '当前结果.xlsx');
    await application.exportOrdersToWorkbook({
      scope: { kind: 'current_result', orderIds: [wide.id, narrow.id] },
      orderTemplateId: null,
      includeOrderItems: true,
      orderItemTemplateId: null,
      masking: 'masked',
    }, currentPath);
    const currentWorkbook = new ExcelJS.Workbook();
    await currentWorkbook.xlsx.readFile(currentPath);
    const currentOrders = currentWorkbook.getWorksheet('订单总表');
    const currentItems = currentWorkbook.getWorksheet('订单商品明细表');
    if (!currentOrders || !currentItems) throw new Error('缺少导出工作表');
    expect(cellByHeader(currentOrders, 2, '商品1').value).toBe('同款海棠杯');
    expect(cellByHeader(currentOrders, 2, '款式或规格1').value).toBe('红色');
    expect(cellByHeader(currentOrders, 2, '商品2').value).toBe('同款海棠杯');
    expect(cellByHeader(currentOrders, 2, '款式或规格2').value).toBe('蓝色');
    expect(cellByHeader(currentOrders, 3, '商品1').value).toBe('单件海棠碟');
    expect(cellByHeader(currentOrders, 3, '商品2').value).toBeNull();
    expect(cellByHeader(currentOrders, 3, '款式或规格3').value).toBeNull();
    expect(cellByHeader(currentOrders, 3, '数量3').value).toBeNull();
    expect(currentItems.rowCount).toBe(5);

    const selectedPath = join(testRoot, '所选结果.xlsx');
    await application.exportOrdersToWorkbook({
      scope: { kind: 'selected_orders', orderIds: [narrow.id] },
      orderTemplateId: null,
      includeOrderItems: true,
      orderItemTemplateId: null,
      masking: 'masked',
    }, selectedPath);
    const selectedWorkbook = new ExcelJS.Workbook();
    await selectedWorkbook.xlsx.readFile(selectedPath);
    const selectedOrders = selectedWorkbook.getWorksheet('订单总表');
    if (!selectedOrders) throw new Error('缺少订单总表');
    expect(rowValues(selectedOrders, 1)).toEqual(expect.arrayContaining([
      '商品1', '款式或规格1', '数量1',
    ]));
    expect(rowValues(selectedOrders, 1)).not.toContain('商品2');
    expect(selectedOrders.rowCount).toBe(2);
  });

  it('保存的两类模板只控制列、别名和顺序，且保留显式订单顺序与自定义字段类型', async () => {
    const { application, testRoot } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-TEMPLATE-001',
        buyerNickname: '甲买家',
        items: [{
          sourceTitle: '甲商品',
          sourceSpec: '红色',
          unitPriceCents: 1_200,
          quantity: 1,
          quantityInferred: false,
        }],
      }),
      recognition({
        orderNumber: 'XY-TEMPLATE-002',
        buyerNickname: '乙买家',
        productTotalCents: 2_800,
        amountCents: 2_800,
        items: [
          {
            sourceTitle: '乙商品',
            sourceSpec: '蓝色',
            unitPriceCents: 2_300,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '乙商品配件',
            sourceSpec: '小号',
            unitPriceCents: 500,
            quantity: 1,
            quantityInferred: false,
          },
        ],
      }),
    ]);
    const adjustment = application.createCustomFieldDefinition({
      name: '补差金额',
      granularity: 'order',
      type: 'money',
      required: false,
      defaultValue: null,
      options: [],
    });
    const reviewedAt = application.createCustomFieldDefinition({
      name: '复核时间',
      granularity: 'order',
      type: 'datetime',
      required: false,
      defaultValue: null,
      options: [],
    });
    const inspected = application.createCustomFieldDefinition({
      name: '验货标记',
      granularity: 'order_item',
      type: 'checkbox',
      required: false,
      defaultValue: null,
      options: [],
    });
    const ordersByNumber = new Map(
      application.queryOrders({ lifecycleStatus: 'all' }).orders
        .map((order) => [order.orderNumber, order]),
    );
    const first = ordersByNumber.get('XY-TEMPLATE-001');
    const second = ordersByNumber.get('XY-TEMPLATE-002');
    if (!first || !second) throw new Error('测试订单未入库');
    const itemsByOrderId = new Map<string, ReturnType<typeof application.queryOrderItems>['items'][number]>();
    for (const item of application.queryOrderItems({}).items) {
      if (!itemsByOrderId.has(item.orderId)) itemsByOrderId.set(item.orderId, item);
    }
    const firstItem = itemsByOrderId.get(first.id);
    const secondItem = itemsByOrderId.get(second.id);
    if (!firstItem || !secondItem) throw new Error('测试商品未入库');

    application.saveCustomFieldValues({
      orderId: first.id,
      orderValues: [
        { definitionId: adjustment.id, value: 1_234 },
        { definitionId: reviewedAt.id, value: '2026-07-29T10:00:00+08:00' },
      ],
      itemValues: [{
        definitionId: inspected.id,
        orderItemId: firstItem.id,
        value: true,
      }],
    });
    application.saveCustomFieldValues({
      orderId: second.id,
      orderValues: [
        { definitionId: adjustment.id, value: 5_678 },
        { definitionId: reviewedAt.id, value: '2026-07-30T11:30:00+08:00' },
      ],
      itemValues: [{
        definitionId: inspected.id,
        orderItemId: secondItem.id,
        value: true,
      }],
    });

    const orderTemplate = application.createTableTemplate({
      name: '导出订单模板',
      granularity: 'order',
      columns: [
        { field: { kind: 'custom', definitionId: adjustment.id }, displayName: '补差金额' },
        {
          kind: 'dynamic_product_group',
          labels: { product: '货品', specification: '款型', quantity: '件数' },
        },
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '指定单号' },
        { field: { kind: 'custom', definitionId: reviewedAt.id }, displayName: '复核时间' },
      ],
      query: {
        buyerText: '不可能匹配的模板筛选',
        lifecycleStatus: 'active',
        sortField: 'amount',
        sortDirection: 'asc',
      },
    });
    const itemTemplate = application.createTableTemplate({
      name: '导出商品模板',
      granularity: 'order_item',
      columns: [
        { field: { kind: 'custom', definitionId: inspected.id }, displayName: '验货标记' },
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '所属单号' },
        { field: { kind: 'builtin', key: 'product_title' }, displayName: '商品标题' },
      ],
      query: {
        customFieldFilter: { definitionId: inspected.id, value: false },
      },
    });
    const destinationPath = join(testRoot, '模板导出.xlsx');

    const exportInput = {
      scope: { kind: 'selected_orders' as const, orderIds: [second.id, first.id] },
      orderTemplateId: orderTemplate.id,
      includeOrderItems: true,
      orderItemTemplateId: itemTemplate.id,
      masking: 'masked' as const,
    };
    const preview = application.previewOrderExport(exportInput);
    await application.exportOrdersToWorkbook(exportInput, destinationPath);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    const orders = workbook.getWorksheet('订单总表');
    const items = workbook.getWorksheet('订单商品明细表');
    if (!orders || !items) throw new Error('缺少导出工作表');
    expect(rowValues(orders, 1)).toEqual([
      '补差金额',
      '货品1', '款型1', '件数1',
      '货品2', '款型2', '件数2',
      '指定单号', '复核时间',
    ]);
    expect(rowValues(items, 1)).toEqual(['验货标记', '所属单号', '商品标题']);
    expect(orders.getColumn(8).values.slice(2)).toEqual([
      'XY-TEMPLATE-002',
      'XY-TEMPLATE-001',
    ]);
    expect(items.getColumn(2).values.slice(2)).toEqual([
      'XY-TEMPLATE-002',
      'XY-TEMPLATE-002',
      'XY-TEMPLATE-001',
    ]);
    expect(cellByHeader(orders, 2, '货品1').value).toBe('乙商品');
    expect(cellByHeader(orders, 2, '货品2').value).toBe('乙商品配件');
    expect(cellByHeader(orders, 3, '货品2').value).toBeNull();
    expect(orders.getCell(2, 1)).toMatchObject({
      value: 56.78,
      type: ExcelJS.ValueType.Number,
    });
    expect(orders.getCell(2, 9)).toMatchObject({
      value: expect.any(Date),
      type: ExcelJS.ValueType.Date,
    });
    expect(items.getCell(2, 1)).toMatchObject({
      value: true,
      type: ExcelJS.ValueType.Boolean,
    });
    for (const sheet of preview.sheets) {
      const worksheet = workbook.getWorksheet(sheet.name);
      if (!worksheet) throw new Error(`缺少工作表：${sheet.name}`);
      expect(rowValues(worksheet, 1)).toEqual(sheet.columns.map(({ header }) => header));
      for (const [rowIndex, previewRow] of sheet.rows.entries()) {
        expect(previewRow).toEqual(
          sheet.columns.map((column, columnIndex) => previewCellText(
            worksheet.getRow(rowIndex + 2).getCell(columnIndex + 1).value,
            column.valueType,
          )),
        );
      }
    }
  });

  it('回收站订单仍导出全部商品，公式样式的用户文本保持为普通字符串', async () => {
    const formulaLikeTitle = '=HYPERLINK("https://example.invalid", "点击")';
    const { application, testRoot } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-TRASHED-EXPORT-001',
        items: [
          {
            sourceTitle: formulaLikeTitle,
            sourceSpec: '+SUM(1,2)',
            unitPriceCents: 1_000,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '回收站第二件商品',
            sourceSpec: '@A1',
            unitPriceCents: 2_000,
            quantity: 3,
            quantityInferred: false,
          },
        ],
      }),
    ]);
    const order = application.queryOrders({}).orders[0];
    const database = new DatabaseSync(join(
      testRoot,
      '数据',
      'xianyu-order-manager.sqlite3',
    ));
    try {
      database.prepare(`
        UPDATE original_orders
        SET lifecycle_status = 'trashed'
        WHERE id = ?
      `).run(order.id);
    } finally {
      database.close();
    }
    const destinationPath = join(testRoot, '回收站导出.xlsx');

    const outcome = await application.exportOrdersToWorkbook({
      scope: { kind: 'selected_orders', orderIds: [order.id] },
      orderTemplateId: null,
      includeOrderItems: true,
      orderItemTemplateId: null,
      masking: 'masked',
    }, destinationPath);

    expect(outcome).toEqual({ orderCount: 1, orderItemCount: 2 });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    const items = workbook.getWorksheet('订单商品明细表');
    const orders = workbook.getWorksheet('订单总表');
    if (!orders || !items) throw new Error('缺少导出工作表');
    expect(cellByHeader(orders, 2, '订单号').value).toBe('XY-TRASHED-EXPORT-001');
    expect(items.rowCount).toBe(3);
    expect(cellByHeader(items, 2, '原始商品标题')).toMatchObject({
      value: formulaLikeTitle,
      type: ExcelJS.ValueType.String,
      formula: undefined,
      hyperlink: undefined,
    });
    expect(await readZipText(destinationPath)).not.toMatch(/<f(?:>|\s)/u);
  });

  it('在写文件前拒绝空、重复和已过期的显式订单 ID', async () => {
    const { application, testRoot } = await createApplicationWithOrders([
      recognition({ orderNumber: 'XY-INVALID-SCOPE-001' }),
    ]);
    const orderId = application.queryOrders({}).orders[0].id;
    const baseInput = {
      orderTemplateId: null,
      includeOrderItems: true,
      orderItemTemplateId: null,
      masking: 'masked' as const,
    };

    await expect(application.exportOrdersToWorkbook({
      ...baseInput,
      scope: { kind: 'selected_orders', orderIds: [] },
    }, join(testRoot, '空范围.xlsx'))).rejects.toThrow();
    await expect(application.exportOrdersToWorkbook({
      ...baseInput,
      scope: { kind: 'selected_orders', orderIds: [orderId, orderId] },
    }, join(testRoot, '重复范围.xlsx'))).rejects.toThrow();
    await expect(application.exportOrdersToWorkbook({
      ...baseInput,
      scope: { kind: 'selected_orders', orderIds: [orderId, 'stale-order-id'] },
    }, join(testRoot, '过期范围.xlsx'))).rejects.toThrow('部分订单已变化');
  });

  it('自定义订单模板只导出所选运营概况且与订单列表投影一致', async () => {
    const { application, testRoot } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-OPERATIONS-EXPORT-001',
        productTotalCents: 3_000,
        amountCents: 3_000,
        items: [{
          sourceTitle: '运营概况商品',
          sourceSpec: '标准款',
          unitPriceCents: 1_000,
          quantity: 3,
          quantityInferred: false,
        }],
      }),
    ]);
    const order = application.queryOrders({}).orders[0];
    expect(order.operations).toEqual({
      shipmentSummary: '无发货',
      logisticsSummary: '无物流',
      aftersalesSummary: '无售后',
      currentTodo: '无需处理',
    });
    const group = application.queryShipmentGroups().groups[0];
    const item = group.orders[0].items[0];
    const shipment = application.confirmShipment({
      groupId: group.id,
      expectedRemainingItems: [{
        orderId: order.id,
        orderItemId: item.id,
        quantity: 3,
      }],
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-OPERATIONS-A',
        items: [{ orderId: order.id, orderItemId: item.id, quantity: 1 }],
      }, {
        shippingCarrier: '中通快递',
        trackingNumber: 'ZT-OPERATIONS-B',
        items: [{ orderId: order.id, orderItemId: item.id, quantity: 1 }],
      }],
    });
    application.updateShipmentPackageLogisticsStatus({
      recordId: shipment.record.id,
      packageId: shipment.record.packages[1].id,
      expectedRevision: shipment.record.packages[1].revision,
      logisticsStatus: 'delivered',
      reason: '第二个包裹已签收',
    });
    application.createAftersalesCase({
      shipmentRecordId: shipment.record.id,
      workflowTemplateId: 'system-aftersales-other',
      occurredAt: '2026-08-13T20:00:00+08:00',
      reason: '其中一件商品等待买家退回',
      items: [{
        shipmentPackageItemId: shipment.record.packages[0].items[0].id,
        quantity: 1,
      }],
    });
    const projected = application.queryOrders({}).orders[0];
    const template = application.createTableTemplate({
      name: '订单运营概况',
      granularity: 'order',
      columns: [
        { field: { kind: 'computed', key: 'shipment_summary' }, displayName: '发货概况' },
        { field: { kind: 'computed', key: 'logistics_summary' }, displayName: '物流概况' },
        { field: { kind: 'computed', key: 'aftersales_summary' }, displayName: '售后概况' },
        { field: { kind: 'computed', key: 'current_todo' }, displayName: '当前待办' },
      ],
      query: {},
    });
    const destinationPath = join(testRoot, '订单运营概况.xlsx');

    await application.exportOrdersToWorkbook({
      scope: { kind: 'selected_orders', orderIds: [order.id] },
      orderTemplateId: template.id,
      includeOrderItems: true,
      orderItemTemplateId: null,
      masking: 'masked',
    }, destinationPath);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    const orders = workbook.getWorksheet('订单总表');
    if (!orders) throw new Error('缺少订单总表');
    expect(rowValues(orders, 1)).toEqual([
      '发货概况', '物流概况', '售后概况', '当前待办',
    ]);
    expect(rowValues(orders, 2)).toEqual([
      projected.operations.shipmentSummary,
      projected.operations.logisticsSummary,
      projected.operations.aftersalesSummary,
      projected.operations.currentTodo,
    ]);
    expect(rowValues(orders, 2)).toEqual([
      '部分发货（已发 2 / 共 3 件）',
      '运输中 1、已签收 1',
      '处理中（1 件）',
      '处理售后问题',
    ]);
  });

  it('生成或复验失败时保留已有文件并清理同目录临时文件', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-order-export-atomic-'));
    const destinationPath = join(testRoot, '已有订单.xlsx');
    const originalContents = Buffer.from('existing-workbook-contents');
    await writeFile(destinationPath, originalContents);
    const invalidPlan: OrderExportWorkbookPlan = {
      worksheets: [
        {
          name: '订单总表',
          columns: [{ header: '下单时间', valueType: 'datetime' }],
          rows: [[new Date(Number.NaN)]],
        },
        {
          name: '订单商品明细表',
          columns: [{ header: '订单号', valueType: 'text' }],
          rows: [],
        },
      ],
    };

    await expect(writeOrderExportWorkbook(destinationPath, invalidPlan)).rejects.toThrow();
    expect(await readFile(destinationPath)).toEqual(originalContents);
    expect((await readdir(testRoot)).filter((name) => name.includes('.tmp.xlsx'))).toEqual([]);
  });

  it('动态展开超过 Excel 列上限时在写入前明确拒绝并保留已有文件', async () => {
    const items = Array.from({ length: 5_461 }, (_, index) => ({
      sourceTitle: `极端商品${index + 1}`,
      sourceSpec: `规格${index + 1}`,
      unitPriceCents: 1,
      quantity: 1,
      quantityInferred: false,
    }));
    const { application, testRoot } = await createApplicationWithOrders([
      recognition({
        orderNumber: 'XY-TOO-WIDE-001',
        productTotalCents: items.length,
        amountCents: items.length,
        items,
      }),
    ]);
    const order = application.queryOrders({}).orders[0];
    const orderTemplate = application.createTableTemplate({
      name: '极端宽表',
      granularity: 'order',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
        {
          kind: 'dynamic_product_group',
          labels: { product: '商品', specification: '款式或规格', quantity: '数量' },
        },
        { field: { kind: 'computed', key: 'order_total' }, displayName: '成交金额' },
      ],
      query: {},
    });
    const itemTemplate = application.createTableTemplate({
      name: '极端宽表商品明细',
      granularity: 'order_item',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '订单号' },
      ],
      query: {},
    });
    const destinationPath = join(testRoot, '已有订单.xlsx');
    const originalContents = Buffer.from('existing-workbook-contents');
    await writeFile(destinationPath, originalContents);

    await expect(application.exportOrdersToWorkbook({
      scope: { kind: 'selected_orders', orderIds: [order.id] },
      orderTemplateId: orderTemplate.id,
      includeOrderItems: true,
      orderItemTemplateId: itemTemplate.id,
      masking: 'masked',
    }, destinationPath))
      .rejects.toThrow('订单总表列数 16385 超过 Excel 上限 16384');
    expect(await readFile(destinationPath)).toEqual(originalContents);
    expect((await readdir(testRoot)).filter((name) => name.includes('.tmp.xlsx'))).toEqual([]);
  });
});

function cellByHeader(
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  header: string,
): ExcelJS.Cell {
  const headerValues = worksheet.getRow(1).values;
  if (!Array.isArray(headerValues)) throw new Error('导出表头格式无效');
  const columnNumber = headerValues.findIndex((value) => value === header);
  if (columnNumber < 1) throw new Error(`未找到表头 ${header}`);
  return worksheet.getCell(rowNumber, columnNumber);
}

function rowValues(worksheet: ExcelJS.Worksheet, rowNumber: number): unknown[] {
  const values = worksheet.getRow(rowNumber).values;
  if (!Array.isArray(values)) throw new Error('导出行格式无效');
  return values.slice(1);
}

function previewCellText(value: unknown, valueType: CustomFieldType): string {
  if (value === null || value === undefined || value === '') return '';
  if (valueType === 'money' && typeof value === 'number') return `¥${value.toFixed(2)}`;
  if (valueType === 'datetime' && value instanceof Date) {
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (valueType === 'checkbox' && typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

async function readZipText(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('无法读取导出工作簿'));
        return;
      }
      const entries: string[] = [];
      zipFile.once('error', reject);
      zipFile.once('end', () => resolve(entries.join('\n')));
      zipFile.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('无法读取导出工作簿内容'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.once('error', reject);
          stream.once('end', () => {
            entries.push(`${entry.fileName}\n${Buffer.concat(chunks).toString('utf8')}`);
            zipFile.readEntry();
          });
        });
      });
      zipFile.readEntry();
    });
  });
}
