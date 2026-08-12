import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { OrderSummary } from '../core/contracts';
import type {
  CustomFieldDefinition,
  CustomFieldType,
  CustomFieldValueRecord,
} from '../core/custom-fields';
import {
  defaultMaskedOrderCell,
  orderExportBuiltinTextLabel,
  type OrderExportAddressRegion,
  type OrderExportPreviewSheet,
} from '../core/order-export';
import type { OrderItemWorkbenchItem } from '../core/order-workbench';
import {
  availableTableFields,
  createOrderTableProjectionPlan,
  createCustomFieldValueIndex,
  fieldReferenceKey,
  projectOrderItemTableCell,
  projectOrderTableProjectionRow,
  type AvailableTableField,
  type OrderTableProjectionColumn,
  type TableCellValue,
  type TableFieldReference,
  type TableTemplateColumn,
  type TableTemplateLayoutItem,
} from '../core/table-templates';

export type OrderExportWorkbookSource = {
  masking: 'masked' | 'original';
  includeOrderItems: boolean;
  orders: OrderSummary[];
  orderItems: OrderItemWorkbenchItem[];
  orderColumns: TableTemplateLayoutItem[];
  orderItemColumns: TableTemplateColumn[];
  customFieldDefinitions: CustomFieldDefinition[];
  orderCustomFieldValues: CustomFieldValueRecord[];
  orderItemCustomFieldValues: CustomFieldValueRecord[];
  addressRegions: ReadonlyMap<string, OrderExportAddressRegion>;
  orderMaximumItemCount?: number;
};

type WorkbookCellValue = string | number | boolean | Date | null;

const EXCEL_MAX_COLUMNS = 16_384;

export type OrderExportWorksheetPlan = {
  name: '订单总表' | '订单商品明细表';
  columns: Array<{
    header: string;
    valueType: CustomFieldType;
  }>;
  rows: WorkbookCellValue[][];
};

export type OrderExportWorkbookPlan = {
  worksheets: OrderExportWorksheetPlan[];
};

export function createOrderExportPreviewSheets(
  plan: OrderExportWorkbookPlan,
  rowLimit = 5,
  totalRowCounts: Partial<Record<OrderExportWorksheetPlan['name'], number>> = {},
): OrderExportPreviewSheet[] {
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1) {
    throw new Error('订单导出预览行数无效');
  }
  return plan.worksheets.map((worksheet) => ({
    name: worksheet.name,
    columns: worksheet.columns.map((column) => ({ ...column })),
    rows: worksheet.rows.slice(0, rowLimit).map((row) => (
      row.map((value, index) => orderExportPreviewCellText(
        value,
        worksheet.columns[index]?.valueType,
      ))
    )),
    totalRowCount: totalRowCounts[worksheet.name] ?? worksheet.rows.length,
  }));
}

export function createOrderExportWorkbookPlan(
  source: OrderExportWorkbookSource,
): OrderExportWorkbookPlan {
  const orderCustomValues = createCustomFieldValueIndex(source.orderCustomFieldValues);
  const orderProjection = createOrderTableProjectionPlan(
    source.orderColumns,
    source.orders,
    source.customFieldDefinitions,
    source.orderMaximumItemCount,
  );
  assertExcelColumnCount('订单总表', orderProjection.columns.length);

  const orderRows = source.orders.map((order) => {
    const projectedValues = projectOrderTableProjectionRow(
      orderProjection,
      order,
      orderCustomValues,
    );
    const region = source.addressRegions.get(order.id) ?? {
      province: '',
      city: '',
      district: '',
    };
    return orderProjection.columns.map((column, index) => {
      const rawValue = projectedValues[index] ?? null;
      if (column.kind === 'dynamic_product') {
        return toWorkbookCellValue(null, column.valueType, rawValue);
      }
      const valueType = requireProjectionValueType(column);
      const maskedValue = source.masking === 'masked' && column.field.kind === 'builtin'
        ? defaultMaskedOrderCell(column.field.key, rawValue, region)
        : rawValue;
      return toWorkbookCellValue(column.field, valueType, maskedValue);
    });
  });
  const worksheets: OrderExportWorksheetPlan[] = [{
    name: '订单总表',
    columns: orderProjection.columns.map((column) => ({
      header: column.header,
      valueType: column.kind === 'dynamic_product'
        ? column.valueType
        : requireProjectionValueType(column),
    })),
    rows: orderRows,
  }];
  if (source.includeOrderItems) {
    assertExcelColumnCount('订单商品明细表', source.orderItemColumns.length);
    const orderItemCatalog = availableTableFields('order_item', source.customFieldDefinitions);
    const orderItemCustomValues = createCustomFieldValueIndex(source.orderItemCustomFieldValues);
    const orderItemRows = source.orderItems.map((item) => (
      source.orderItemColumns.map((column) => {
        const descriptor = requireDescriptor(orderItemCatalog, column.field);
        const value = projectOrderItemTableCell(item, column.field, orderItemCustomValues);
        return toWorkbookCellValue(column.field, descriptor.valueType, value);
      })
    ));
    worksheets.push({
      name: '订单商品明细表',
      columns: source.orderItemColumns.map((column) => ({
        header: column.displayName,
        valueType: requireDescriptor(orderItemCatalog, column.field).valueType,
      })),
      rows: orderItemRows,
    });
  }

  return { worksheets };
}

function requireProjectionValueType(
  column: Extract<OrderTableProjectionColumn, { kind: 'field' }>,
): CustomFieldType {
  if (column.valueType === null) throw new Error(`导出字段不可用：${column.key}`);
  return column.valueType;
}

export async function writeOrderExportWorkbook(
  destinationPath: string,
  plan: OrderExportWorkbookPlan,
): Promise<void> {
  for (const sheetPlan of plan.worksheets) {
    assertExcelColumnCount(sheetPlan.name, sheetPlan.columns.length);
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '闲鱼订单管理';
  workbook.lastModifiedBy = '闲鱼订单管理';
  workbook.created = new Date();
  workbook.modified = workbook.created;

  for (const sheetPlan of plan.worksheets) {
    const worksheet = workbook.addWorksheet(sheetPlan.name, {
      properties: { defaultRowHeight: 20 },
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    worksheet.columns = sheetPlan.columns.map((column, index) => ({
      header: column.header,
      key: `column_${index + 1}`,
      width: Math.min(36, Math.max(12, [...column.header].length + 4)),
      style: { numFmt: numberFormat(column.valueType) },
    }));
    for (const row of sheetPlan.rows) worksheet.addRow(row);
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: sheetPlan.columns.length },
    };
    const header = worksheet.getRow(1);
    header.height = 24;
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF16324F' },
    };
    header.alignment = { vertical: 'middle' };
  }

  const temporaryPath = join(
    dirname(destinationPath),
    `.${basename(destinationPath)}.${randomUUID()}.tmp.xlsx`,
  );
  try {
    await workbook.xlsx.writeFile(temporaryPath, {
      useStyles: true,
      useSharedStrings: true,
    });
    await verifyWrittenWorkbook(temporaryPath, plan);
    await rename(temporaryPath, destinationPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function assertExcelColumnCount(
  sheetName: OrderExportWorksheetPlan['name'],
  columnCount: number,
): void {
  if (columnCount > EXCEL_MAX_COLUMNS) {
    throw new Error(
      `${sheetName}列数 ${columnCount} 超过 Excel 上限 ${EXCEL_MAX_COLUMNS}`,
    );
  }
}

async function verifyWrittenWorkbook(
  filePath: string,
  plan: OrderExportWorkbookPlan,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  if (workbook.worksheets.length !== plan.worksheets.length) {
    throw workbookVerificationError('工作表数量不正确');
  }
  const definedNames: string[] = [];
  workbook.definedNames.forEach((name) => definedNames.push(name));
  if (definedNames.length > 0) throw workbookVerificationError('包含命名区域');

  for (const [sheetIndex, sheetPlan] of plan.worksheets.entries()) {
    const worksheet = workbook.worksheets[sheetIndex];
    if (!worksheet || worksheet.name !== sheetPlan.name) {
      throw workbookVerificationError(`缺少工作表：${sheetPlan.name}`);
    }
    if (worksheet.state !== 'visible') {
      throw workbookVerificationError(`工作表被隐藏：${sheetPlan.name}`);
    }
    if (worksheet.columnCount !== sheetPlan.columns.length) {
      throw workbookVerificationError(`工作表列数不正确：${sheetPlan.name}`);
    }
    if (worksheet.rowCount !== sheetPlan.rows.length + 1) {
      throw workbookVerificationError(`工作表行数不正确：${sheetPlan.name}`);
    }

    for (const [columnIndex, column] of sheetPlan.columns.entries()) {
      const excelColumn = columnIndex + 1;
      const header = worksheet.getCell(1, excelColumn);
      if (header.value !== column.header) {
        throw workbookVerificationError(`工作表表头不正确：${sheetPlan.name}`);
      }
      if (worksheet.getColumn(excelColumn).hidden) {
        throw workbookVerificationError(`工作表包含隐藏列：${sheetPlan.name}`);
      }
    }

    for (const [rowIndex, expectedRow] of sheetPlan.rows.entries()) {
      const excelRow = rowIndex + 2;
      const row = worksheet.getRow(excelRow);
      if (row.hidden) throw workbookVerificationError(`工作表包含隐藏行：${sheetPlan.name}`);
      for (const [columnIndex, expected] of expectedRow.entries()) {
        const cell = worksheet.getCell(excelRow, columnIndex + 1);
        verifyWorkbookCell(cell, expected, sheetPlan.name);
      }
    }

    worksheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        if (cell.formula !== undefined || cell.hyperlink !== undefined || cell.note !== undefined) {
          throw workbookVerificationError(`工作表包含公式、链接或批注：${sheetPlan.name}`);
        }
      });
    });
  }
}

function verifyWorkbookCell(
  cell: ExcelJS.Cell,
  expected: WorkbookCellValue,
  sheetName: string,
): void {
  const actual = cell.value;
  if (expected instanceof Date) {
    if (!Number.isFinite(expected.getTime()) ||
      !(actual instanceof Date) ||
      actual.getTime() !== expected.getTime()) {
      throw workbookVerificationError(`日期单元格不正确：${sheetName}!${cell.address}`);
    }
    return;
  }
  if (typeof expected === 'number' && !Number.isFinite(expected)) {
    throw workbookVerificationError(`数值单元格不正确：${sheetName}!${cell.address}`);
  }
  if (actual !== expected) {
    throw workbookVerificationError(`单元格内容不正确：${sheetName}!${cell.address}`);
  }
}

function workbookVerificationError(reason: string): Error {
  return new Error(`订单导出工作簿复验失败：${reason}`);
}

function requireDescriptor(
  catalog: readonly AvailableTableField[],
  reference: TableFieldReference,
): AvailableTableField {
  const key = fieldReferenceKey(reference);
  const descriptor = catalog.find((field) => fieldReferenceKey(field.reference) === key);
  if (!descriptor) throw new Error(`导出字段不可用：${key}`);
  return descriptor;
}

function toWorkbookCellValue(
  reference: TableFieldReference | null,
  valueType: CustomFieldType,
  value: TableCellValue,
): WorkbookCellValue {
  if (value === null || value === '') return null;
  if (reference?.kind === 'builtin' && typeof value === 'string') {
    const label = orderExportBuiltinTextLabel(reference.key, value);
    if (label !== undefined) return label;
  }
  switch (valueType) {
    case 'money':
      if (typeof value !== 'number') throw new Error('导出金额字段值无效');
      return value / 100;
    case 'number':
      if (typeof value !== 'number') throw new Error('导出数字字段值无效');
      return value;
    case 'datetime':
      if (typeof value !== 'string') throw new Error('导出日期时间字段值无效');
      return shanghaiWallClockDate(value);
    case 'checkbox':
      if (typeof value !== 'boolean') throw new Error('导出勾选字段值无效');
      return value;
    case 'multi_select':
      if (!Array.isArray(value)) throw new Error('导出多选字段值无效');
      return value.join('、');
    case 'text':
    case 'single_select':
      if (typeof value !== 'string') throw new Error('导出文本字段值无效');
      return value;
  }
}

function shanghaiWallClockDate(value: string): Date {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error('导出日期时间字段值无效');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const selected = parts.find((entry) => entry.type === type)?.value;
    if (!selected) throw new Error('导出日期时间字段值无效');
    return Number(selected);
  };
  return new Date(Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  ));
}

function numberFormat(valueType: CustomFieldType): string {
  if (valueType === 'money') return '¥#,##0.00';
  if (valueType === 'datetime') return 'yyyy-mm-dd hh:mm:ss';
  if (valueType === 'number') return '0.########';
  return '@';
}

function orderExportPreviewCellText(
  value: WorkbookCellValue,
  valueType: CustomFieldType | undefined,
): string {
  if (!valueType) throw new Error('订单导出预览字段类型缺失');
  if (value === null) return '';
  if (valueType === 'money') {
    if (typeof value !== 'number') throw new Error('订单导出预览金额无效');
    return `¥${value.toFixed(2)}`;
  }
  if (valueType === 'datetime') {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error('订单导出预览日期时间无效');
    }
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  if (valueType === 'checkbox') {
    if (typeof value !== 'boolean') throw new Error('订单导出预览勾选值无效');
    return value ? '是' : '否';
  }
  return String(value);
}
