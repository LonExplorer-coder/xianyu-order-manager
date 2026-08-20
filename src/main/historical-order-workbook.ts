import { createHash } from 'node:crypto';

import ExcelJS from 'exceljs';

import type {
  HistoricalOrderColumnKey,
  HistoricalOrderColumnMapping,
  HistoricalOrderImportCandidate,
  HistoricalOrderImportErrorRow,
  HistoricalOrderImportPreview,
  HistoricalOrderWorkbookInspection,
} from '../core/historical-order-import';
import type { OriginalOrder } from '../core/contracts';
import {
  diffOrderCurrentValues,
  hasEquivalentOrderContent,
  normalizedOrderIdentityPart,
} from '../core/order-comparison';
import {
  deriveAddressParts,
  isValidPhonePair,
  normalizeAddress,
  normalizePhone,
  normalizeShanghaiDateTime,
} from '../core/order-normalization';
import { assertXlsxWorkbookArchiveLimits } from './xlsx-workbook-safety';

const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;
const MAX_WORKSHEETS = 20;
const MAX_DATA_ROWS = 10_000;
const MAX_COLUMNS = 200;
const REQUIRED_COLUMNS: readonly HistoricalOrderColumnKey[] = [
  'platform', 'sellerAccount', 'orderNumber', 'recipient', 'phone', 'address',
  'amount', 'itemTitle', 'unitPrice', 'quantity',
];

type ParsedRow = {
  rowNumber: number;
  platformText: string;
  sellerAccount: string;
  orderNumber: string;
  candidate: HistoricalOrderImportCandidate | null;
  errors: string[];
};

export type HistoricalOrderWorkbookPreviewPlan = {
  preview: HistoricalOrderImportPreview;
  candidates: HistoricalOrderImportCandidate[];
};

export async function inspectHistoricalOrderWorkbook(
  buffer: Buffer,
): Promise<HistoricalOrderWorkbookInspection> {
  const workbook = await loadWorkbook(buffer);
  const worksheets = workbook.worksheets.map((worksheet) => ({
    name: worksheet.name,
    headers: worksheetHeaders(worksheet),
  }));
  if (worksheets.length === 0) throw new Error('历史订单工作簿没有工作表');
  const worksheet = [...worksheets].sort((left, right) => (
    headerMatchScore(right.headers) - headerMatchScore(left.headers)
  ))[0];
  return {
    worksheets,
    suggestedColumnMapping: {
      worksheet: worksheet.name,
      columns: Object.fromEntries(
        (Object.keys(HEADER_ALIASES) as HistoricalOrderColumnKey[]).map((key) => (
          [key, findHeaderColumn(worksheet.headers, HEADER_ALIASES[key])]
        )),
      ) as HistoricalOrderColumnMapping['columns'],
    },
  };
}

export async function previewHistoricalOrderWorkbook(input: {
  buffer: Buffer;
  columnMapping: HistoricalOrderColumnMapping;
  findExistingOrder: (candidate: HistoricalOrderImportCandidate) => OriginalOrder | null;
}): Promise<HistoricalOrderWorkbookPreviewPlan> {
  for (const key of REQUIRED_COLUMNS) {
    if (input.columnMapping.columns[key] === null) {
      throw new Error(`请先映射“${COLUMN_LABELS[key]}”列`);
    }
  }
  const workbook = await loadWorkbook(input.buffer);
  const worksheet = workbook.getWorksheet(input.columnMapping.worksheet);
  if (!worksheet) throw new Error(`未找到工作表“${input.columnMapping.worksheet}”`);
  const rows = parseRows(worksheet, input.columnMapping);
  const candidates = groupRowsAsOrders(rows);
  const errorRows: HistoricalOrderImportErrorRow[] = rows
    .filter(({ errors }) => errors.length > 0)
    .map((row) => ({
      rowNumber: row.rowNumber,
      platform: row.platformText,
      sellerAccount: row.sellerAccount,
      orderNumber: row.orderNumber,
      errors: row.errors,
    }));
  const orders = candidates.map((candidate) => {
    const existing = input.findExistingOrder(candidate);
    const action = !existing
      ? 'create' as const
      : hasEquivalentOrderContent(existing, candidate)
        ? 'duplicate' as const
        : 'update' as const;
    return {
      rowNumbers: candidate.rowNumbers,
      platform: candidate.platform,
      sellerAccount: candidate.sellerAccount,
      orderNumber: candidate.orderNumber,
      recipient: candidate.recipient,
      amountCents: candidate.amountCents,
      itemCount: candidate.items.length,
      action,
      existingOrderId: existing?.id ?? null,
      expectedRevision: existing?.revision ?? null,
      changes: existing && action === 'update'
        ? diffOrderCurrentValues(existing, candidate)
        : [],
      errors: [],
    };
  });
  const previewWithoutToken = {
    orders,
    errorRows,
    summary: {
      createOrderCount: orders.filter(({ action }) => action === 'create').length,
      updateOrderCount: orders.filter(({ action }) => action === 'update').length,
      duplicateOrderCount: orders.filter(({ action }) => action === 'duplicate').length,
      errorRowCount: errorRows.length,
    },
  };
  return {
    candidates,
    preview: {
      previewToken: createHash('sha256').update(JSON.stringify({
        columnMapping: input.columnMapping,
        preview: previewWithoutToken,
      })).digest('hex'),
      ...previewWithoutToken,
    },
  };
}

export async function createHistoricalOrderErrorRowsWorkbook(input: {
  buffer: Buffer;
  columnMapping: HistoricalOrderColumnMapping;
  errorRows: readonly HistoricalOrderImportErrorRow[];
}): Promise<Buffer> {
  if (input.errorRows.length === 0) throw new Error('当前预览没有错误行');
  const sourceWorkbook = await loadWorkbook(input.buffer);
  const sourceWorksheet = sourceWorkbook.getWorksheet(input.columnMapping.worksheet);
  if (!sourceWorksheet) throw new Error(`未找到工作表“${input.columnMapping.worksheet}”`);
  const headers = worksheetHeaders(sourceWorksheet);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '闲鱼订单管理系统';
  const worksheet = workbook.addWorksheet('错误行');
  worksheet.addRow(['原工作表行号', ...headers, '错误原因']);
  for (const errorRow of input.errorRows) {
    const sourceRow = sourceWorksheet.getRow(errorRow.rowNumber);
    worksheet.addRow([
      errorRow.rowNumber,
      ...headers.map((_, index) => sourceRow.getCell(index + 1).text),
      errorRow.errors.join('；'),
    ]);
  }
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length + 2 } };
  worksheet.getRow(1).font = { bold: true };
  worksheet.columns.forEach((column, index) => {
    if (index === 0) column.width = 16;
    else if (index === headers.length + 1) column.width = 42;
    else column.width = 18;
  });
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  if (buffer.length > MAX_WORKBOOK_BYTES) {
    throw new Error('历史订单错误行工作簿不能超过 10 MB');
  }
  await assertXlsxWorkbookArchiveLimits(buffer, '历史订单错误行工作簿');
  return buffer;
}

function parseRows(
  worksheet: ExcelJS.Worksheet,
  mapping: HistoricalOrderColumnMapping,
): ParsedRow[] {
  const rows: ParsedRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const mappedTexts = Object.values(mapping.columns).map((column) => (
      column === null ? '' : cellText(row, column)
    ));
    if (mappedTexts.every((value) => !value)) return;

    const platformText = textFor(row, mapping, 'platform');
    const sellerAccount = textFor(row, mapping, 'sellerAccount');
    const orderNumber = textFor(row, mapping, 'orderNumber');
    const errors: string[] = [];
    if (!platformText) errors.push('平台不能为空');
    else if (!['闲鱼', 'xianyu'].includes(normalizeKey(platformText))) {
      errors.push('当前仅支持闲鱼平台订单');
    }
    if (!sellerAccount) errors.push('卖家账号不能为空');
    if (!orderNumber) errors.push('平台订单编号不能为空');
    if (sellerAccount.length > 200) errors.push('卖家账号不能超过 200 个字符');
    if (orderNumber.length > 200) errors.push('平台订单编号不能超过 200 个字符');

    const recipient = textFor(row, mapping, 'recipient');
    const phone = textFor(row, mapping, 'phone');
    const phoneNormalized = normalizePhone(phone);
    const addressOriginal = textFor(row, mapping, 'address');
    const addressNormalized = normalizeAddress(addressOriginal);
    if (!recipient) errors.push('收件人不能为空');
    if (!phone) errors.push('手机号不能为空');
    else if (!isValidPhonePair(phone, phoneNormalized)) errors.push('手机号格式无效');
    if (!addressOriginal) errors.push('完整收货地址不能为空');

    const amountCents = moneyFor(row, mapping, 'amount', true, errors);
    const unitPriceCents = moneyFor(row, mapping, 'unitPrice', true, errors);
    const productTotalCents = moneyFor(row, mapping, 'productTotal', false, errors);
    const shippingFeeCents = moneyFor(row, mapping, 'shippingFee', false, errors);
    const sourceTitle = textFor(row, mapping, 'itemTitle');
    const sourceSpec = textFor(row, mapping, 'itemSpec');
    const quantity = quantityFor(row, mapping, errors);
    if (!sourceTitle) errors.push('商品标题不能为空');

    const orderedAtOriginal = dateTimeTextFor(row, mapping, 'orderedAt');
    const paidAtOriginal = dateTimeTextFor(row, mapping, 'paidAt');
    const orderedAtNormalized = normalizeDateTime(orderedAtOriginal, '下单时间', errors);
    const paidAtNormalized = normalizeDateTime(paidAtOriginal, '付款时间', errors);
    const platformTransactionStatus = transactionStatusFor(row, mapping, errors);
    const fulfillmentStatus = fulfillmentStatusFor(row, mapping, errors);
    const addressParts = deriveAddressParts(addressNormalized, {
      province: '', city: '', district: '',
    });
    const candidate = errors.length > 0 || amountCents === null || unitPriceCents === null
      ? null
      : {
        rowNumbers: [rowNumber],
        platform: 'xianyu' as const,
        sellerAccount,
        orderNumber,
        alipayTransactionNumber: textFor(row, mapping, 'alipayTransactionNumber'),
        buyerNickname: textFor(row, mapping, 'buyerNickname'),
        recipient,
        phone,
        phoneNormalized,
        addressOriginal,
        addressNormalized,
        ...addressParts,
        orderedAtOriginal,
        orderedAtNormalized,
        paidAtOriginal,
        paidAtNormalized,
        productTotalCents,
        shippingFeeCents,
        amountCents,
        platformTransactionStatus,
        fulfillmentStatus,
        items: [{
          id: `historical-row-${rowNumber}`,
          sourceTitle,
          sourceSpec,
          unitPriceCents,
          quantity,
          quantitySource: 'legacy_explicit_or_manual' as const,
          quantityInferred: false,
        }],
      };
    rows.push({ rowNumber, platformText, sellerAccount, orderNumber, candidate, errors });
  });
  return rows;
}

function groupRowsAsOrders(rows: ParsedRow[]): HistoricalOrderImportCandidate[] {
  const grouped = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    const key = rowIdentityKey(row);
    if (!key) continue;
    const matches = grouped.get(key) ?? [];
    matches.push(row);
    grouped.set(key, matches);
  }

  const candidates: HistoricalOrderImportCandidate[] = [];
  for (const matches of grouped.values()) {
    if (matches.some(({ errors }) => errors.length > 0)) {
      for (const row of matches) {
        if (row.errors.length === 0) {
          row.errors.push('同一原始订单包含错误行，整笔订单未导入');
          row.candidate = null;
        }
      }
      continue;
    }
    const parsed = matches.map(({ candidate }) => candidate).filter(
      (candidate): candidate is HistoricalOrderImportCandidate => candidate !== null,
    );
    if (parsed.length !== matches.length || parsed.length === 0) continue;
    const [first] = parsed;
    if (parsed.some((candidate) => (
      comparableOrderFields(candidate) !== comparableOrderFields(first)
    ))) {
      for (const row of matches) {
        row.errors.push('同一原始订单的订单字段不一致');
        row.candidate = null;
      }
      continue;
    }
    candidates.push({
      ...first,
      rowNumbers: parsed.flatMap(({ rowNumbers }) => rowNumbers),
      items: parsed.flatMap(({ items }) => items),
    });
  }
  return candidates.sort((left, right) => left.rowNumbers[0] - right.rowNumbers[0]);
}

function rowIdentityKey(row: ParsedRow): string | null {
  if (!row.platformText || !row.sellerAccount || !row.orderNumber) return null;
  const platform = normalizeKey(row.platformText);
  if (platform !== '闲鱼' && platform !== 'xianyu') return null;
  return JSON.stringify([
    'xianyu',
    normalizedOrderIdentityPart(row.sellerAccount),
    normalizedOrderIdentityPart(row.orderNumber),
  ]);
}

function comparableOrderFields(candidate: HistoricalOrderImportCandidate): string {
  const { rowNumbers: _rowNumbers, items: _items, ...orderFields } = candidate;
  return JSON.stringify(orderFields);
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_WORKBOOK_BYTES) {
    throw new Error('历史订单工作簿大小无效');
  }
  await assertXlsxWorkbookArchiveLimits(buffer, '历史订单工作簿');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new Error('无法读取历史订单工作簿，请确认文件是有效的 .xlsx 文件');
  }
  if (workbook.worksheets.length > MAX_WORKSHEETS) throw new Error('历史订单工作表数量过多');
  for (const worksheet of workbook.worksheets) {
    if (worksheet.rowCount > MAX_DATA_ROWS + 1) throw new Error('历史订单工作表行数过多');
    if (worksheet.columnCount > MAX_COLUMNS) throw new Error('历史订单工作表列数过多');
  }
  return workbook;
}

function worksheetHeaders(worksheet: ExcelJS.Worksheet): string[] {
  const row = worksheet.getRow(1);
  const headers = Array.from({ length: Math.min(row.cellCount, MAX_COLUMNS) }, (_, index) => (
    cellText(row, index + 1)
  ));
  while (headers.at(-1) === '') headers.pop();
  return headers;
}

function headerMatchScore(headers: readonly string[]): number {
  return Object.values(HEADER_ALIASES)
    .filter((aliases) => findHeaderColumn(headers, aliases) !== null).length;
}

function findHeaderColumn(headers: readonly string[], aliases: readonly string[]): number | null {
  const normalizedAliases = aliases.map(normalizeHeader);
  const exact = headers.findIndex((header) => normalizedAliases.includes(normalizeHeader(header)));
  if (exact >= 0) return exact + 1;
  const partial = headers.findIndex((header) => normalizedAliases.some((alias) => (
    alias.length >= 2 && normalizeHeader(header).includes(alias)
  )));
  return partial >= 0 ? partial + 1 : null;
}

function textFor(
  row: ExcelJS.Row,
  mapping: HistoricalOrderColumnMapping,
  key: HistoricalOrderColumnKey,
): string {
  const column = mapping.columns[key];
  return column === null ? '' : cellText(row, column);
}

function cellText(row: ExcelJS.Row, column: number): string {
  return row.getCell(column).text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function rawValueFor(
  row: ExcelJS.Row,
  mapping: HistoricalOrderColumnMapping,
  key: HistoricalOrderColumnKey,
): ExcelJS.CellValue | null {
  const column = mapping.columns[key];
  return column === null ? null : row.getCell(column).value;
}

function moneyFor(
  row: ExcelJS.Row,
  mapping: HistoricalOrderColumnMapping,
  key: HistoricalOrderColumnKey,
  required: boolean,
  errors: string[],
): number | null {
  const text = textFor(row, mapping, key);
  if (!text) {
    if (required) errors.push(`${COLUMN_LABELS[key]}不能为空`);
    return null;
  }
  const raw = rawValueFor(row, mapping, key);
  const value = typeof raw === 'number' ? raw : Number(text.replace(/[¥￥,，\s]/gu, ''));
  const cents = Math.round(value * 100);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(cents)) {
    errors.push(`${COLUMN_LABELS[key]}格式无效`);
    return null;
  }
  return cents;
}

function quantityFor(
  row: ExcelJS.Row,
  mapping: HistoricalOrderColumnMapping,
  errors: string[],
): number {
  const text = textFor(row, mapping, 'quantity');
  const raw = rawValueFor(row, mapping, 'quantity');
  const value = typeof raw === 'number' ? raw : Number(text);
  if (!text || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    errors.push(!text ? '商品数量不能为空' : '商品数量格式无效');
    return 1;
  }
  return value;
}

function dateTimeTextFor(
  row: ExcelJS.Row,
  mapping: HistoricalOrderColumnMapping,
  key: 'orderedAt' | 'paidAt',
): string {
  const raw = rawValueFor(row, mapping, key);
  if (raw instanceof Date) {
    const part = (value: number) => String(value).padStart(2, '0');
    return `${raw.getFullYear()}-${part(raw.getMonth() + 1)}-${part(raw.getDate())} ${part(raw.getHours())}:${part(raw.getMinutes())}:${part(raw.getSeconds())}`;
  }
  return textFor(row, mapping, key);
}

function normalizeDateTime(value: string, label: string, errors: string[]): string {
  if (!value) return '';
  const normalized = normalizeShanghaiDateTime(value);
  if (!normalized) errors.push(`${label}格式无效`);
  return normalized;
}

function transactionStatusFor(
  row: ExcelJS.Row,
  mapping: HistoricalOrderColumnMapping,
  errors: string[],
): HistoricalOrderImportCandidate['platformTransactionStatus'] {
  const value = normalizeKey(textFor(row, mapping, 'platformTransactionStatus'));
  if (!value || value === 'unknown' || value === '未知') return 'unknown';
  if (value === 'paid' || value === '已付款') return 'paid';
  if (value === 'cancelled' || value === 'canceled' || value === '已取消') return 'cancelled';
  if (value === 'refunded' || value === '已退款') return 'refunded';
  errors.push('平台交易状态格式无效');
  return 'unknown';
}

function fulfillmentStatusFor(
  row: ExcelJS.Row,
  mapping: HistoricalOrderColumnMapping,
  errors: string[],
): HistoricalOrderImportCandidate['fulfillmentStatus'] {
  const value = normalizeKey(textFor(row, mapping, 'fulfillmentStatus'));
  if (!value || value === 'unknown' || value === '未知') return 'unknown';
  if (value === 'pending_shipment' || value === '待发货') return 'pending_shipment';
  if (value === 'partially_shipped' || value === '部分发货') return 'partially_shipped';
  if (value === 'shipped' || value === '已发货') return 'shipped';
  if (value === 'delivered' || value === '已收货' || value === '已签收') return 'delivered';
  errors.push('履约状态格式无效');
  return 'unknown';
}

function normalizeHeader(value: string): string {
  return value.normalize('NFKC').trim().replace(/[\s_\-／/]/gu, '').toLocaleLowerCase('zh-CN');
}
function normalizeKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

const COLUMN_LABELS: Record<HistoricalOrderColumnKey, string> = {
  platform: '平台', sellerAccount: '卖家账号', orderNumber: '平台订单编号',
  alipayTransactionNumber: '支付宝交易号', buyerNickname: '买家昵称', recipient: '收件人',
  phone: '手机号', address: '完整收货地址', orderedAt: '下单时间', paidAt: '付款时间',
  productTotal: '商品总价', shippingFee: '运费', amount: '成交金额',
  platformTransactionStatus: '平台交易状态', fulfillmentStatus: '履约状态',
  itemTitle: '商品标题', itemSpec: '款式或规格', unitPrice: '商品单价', quantity: '商品数量',
};

const HEADER_ALIASES: Record<HistoricalOrderColumnKey, readonly string[]> = {
  platform: ['平台', '交易平台'], sellerAccount: ['卖家账号', '业务账号', '账号'],
  orderNumber: ['平台订单编号', '平台订单号', '平台单号', '订单号'],
  alipayTransactionNumber: ['支付宝交易号', '支付宝订单号'], buyerNickname: ['买家昵称', '买家'],
  recipient: ['收件人', '收件姓名', '收货人'], phone: ['手机号', '联系电话', '手机'],
  address: ['完整收货地址', '收货地址', '完整地址', '地址'], orderedAt: ['下单时间', '订单时间'],
  paidAt: ['付款时间', '支付时间'], productTotal: ['商品总价', '商品金额'],
  shippingFee: ['运费', '邮费'], amount: ['成交金额', '实付金额', '订单总额'],
  platformTransactionStatus: ['平台交易状态', '交易状态'], fulfillmentStatus: ['履约状态', '发货状态'],
  itemTitle: ['原始商品标题', '商品标题', '商品名称', '商品'],
  itemSpec: ['原始款式或规格', '原始款式／规格', '商品规格', '款式或规格', '规格'],
  unitPrice: ['商品单价', '单价'], quantity: ['商品数量', '购买数量', '数量'],
};
