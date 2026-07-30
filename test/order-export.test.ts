import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';
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

describe('默认脱敏的两表工作簿导出', () => {
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

    const outcome = await application.exportOrdersToWorkbook({
      scope: {
        kind: 'current_result',
        orderIds: currentResultIds,
      },
      orderTemplateId: null,
      orderItemTemplateId: null,
      masking: 'default',
    }, destinationPath);

    expect(outcome).toEqual({ orderCount: 1, orderItemCount: 2 });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    expect(workbook.worksheets.map(({ name }) => name)).toEqual(['订单总表', '商品明细']);

    const orders = workbook.getWorksheet('订单总表');
    const items = workbook.getWorksheet('商品明细');
    expect(orders?.rowCount).toBe(2);
    expect(items?.rowCount).toBe(3);
    if (!orders || !items) throw new Error('缺少导出工作表');

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
    expect(cellByHeader(orders, 2, '支付宝交易号')).toMatchObject({
      value: 'ALI-XY-EXPORT-001',
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
    expect(cellByHeader(items, 2, '单价')).toMatchObject({
      value: 18,
      type: ExcelJS.ValueType.Number,
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
        items: [{
          sourceTitle: '乙商品',
          sourceSpec: '蓝色',
          unitPriceCents: 2_300,
          quantity: 1,
          quantityInferred: false,
        }],
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
    const itemsByOrderId = new Map(
      application.queryOrderItems({}).items.map((item) => [item.orderId, item]),
    );
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

    await application.exportOrdersToWorkbook({
      scope: { kind: 'selected_orders', orderIds: [second.id, first.id] },
      orderTemplateId: orderTemplate.id,
      orderItemTemplateId: itemTemplate.id,
      masking: 'default',
    }, destinationPath);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    const orders = workbook.getWorksheet('订单总表');
    const items = workbook.getWorksheet('商品明细');
    if (!orders || !items) throw new Error('缺少导出工作表');
    expect(rowValues(orders, 1)).toEqual(['补差金额', '指定单号', '复核时间']);
    expect(rowValues(items, 1)).toEqual(['验货标记', '所属单号', '商品标题']);
    expect(orders.getColumn(2).values.slice(2)).toEqual([
      'XY-TEMPLATE-002',
      'XY-TEMPLATE-001',
    ]);
    expect(items.getColumn(2).values.slice(2)).toEqual([
      'XY-TEMPLATE-002',
      'XY-TEMPLATE-001',
    ]);
    expect(orders.getCell(2, 1)).toMatchObject({
      value: 56.78,
      type: ExcelJS.ValueType.Number,
    });
    expect(orders.getCell(2, 3)).toMatchObject({
      value: expect.any(Date),
      type: ExcelJS.ValueType.Date,
    });
    expect(items.getCell(2, 1)).toMatchObject({
      value: true,
      type: ExcelJS.ValueType.Boolean,
    });
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
      orderItemTemplateId: null,
      masking: 'default',
    }, destinationPath);

    expect(outcome).toEqual({ orderCount: 1, orderItemCount: 2 });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    const items = workbook.getWorksheet('商品明细');
    const orders = workbook.getWorksheet('订单总表');
    if (!orders || !items) throw new Error('缺少导出工作表');
    expect(cellByHeader(orders, 2, '订单号').value).toBe('XY-TRASHED-EXPORT-001');
    expect(items.rowCount).toBe(3);
    expect(cellByHeader(items, 2, '商品')).toMatchObject({
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
      orderItemTemplateId: null,
      masking: 'default' as const,
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
          name: '商品明细',
          columns: [{ header: '订单号', valueType: 'text' }],
          rows: [],
        },
      ],
    };

    await expect(writeOrderExportWorkbook(destinationPath, invalidPlan)).rejects.toThrow();
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
