import { createHash } from 'node:crypto';

import ExcelJS from 'exceljs';

import type {
  ProductCatalogColumnMapping,
  ProductCatalogDuplicateSkuResolution,
  ProductCatalogImportPreview,
  ProductCatalogMappingPreviewRow,
  ProductCatalogProductPreviewRow,
  ProductCatalogWorkbookInspection,
} from '../core/product-catalog';
import {
  normalizeProductText,
  normalizeSkuKey,
  type ProductMappingScope,
  type ProductMappingView,
  type StandardProduct,
} from '../core/product-standardization';
import { assertXlsxWorkbookArchiveLimits } from './xlsx-workbook-safety';

const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;
const MAX_WORKSHEETS = 20;
const MAX_DATA_ROWS_PER_WORKSHEET = 10_000;
const MAX_COLUMNS_PER_WORKSHEET = 200;

type ParsedProductRow = Omit<ProductCatalogProductPreviewRow, 'action' | 'errors'> & {
  errors: string[];
};

type ParsedMappingRow = Omit<
  ProductCatalogMappingPreviewRow,
  'action' | 'errors' | 'existingMappingId'
> & {
  errors: string[];
};

export async function inspectProductCatalogWorkbook(
  buffer: Buffer,
): Promise<ProductCatalogWorkbookInspection> {
  const workbook = await loadWorkbook(buffer);
  const worksheets = workbook.worksheets.map((worksheet) => ({
    name: worksheet.name,
    headers: worksheetHeaders(worksheet),
  }));
  if (worksheets.length === 0) throw new Error('商品目录工作簿没有工作表');

  const productWorksheet = bestWorksheet(worksheets, [
    PRODUCT_HEADER_ALIASES.sku,
    PRODUCT_HEADER_ALIASES.name,
    PRODUCT_HEADER_ALIASES.specification,
  ]) ?? worksheets[0];
  const mappingWorksheet = bestWorksheet(worksheets, [
    MAPPING_HEADER_ALIASES.sku,
    MAPPING_HEADER_ALIASES.sourceTitle,
  ], 2);
  const productColumns = {
    sku: findHeaderColumn(productWorksheet.headers, PRODUCT_HEADER_ALIASES.sku) ?? 1,
    name: findHeaderColumn(productWorksheet.headers, PRODUCT_HEADER_ALIASES.name) ?? 2,
    specification: findHeaderColumn(
      productWorksheet.headers,
      PRODUCT_HEADER_ALIASES.specification,
    ) ?? 3,
  };
  return {
    worksheets,
    suggestedColumnMapping: {
      productWorksheet: productWorksheet.name,
      productColumns,
      mappingWorksheet: mappingWorksheet?.name ?? null,
      mappingColumns: {
        sku: mappingWorksheet
          ? findHeaderColumn(mappingWorksheet.headers, MAPPING_HEADER_ALIASES.sku) ?? 1
          : 1,
        sourceTitle: mappingWorksheet
          ? findHeaderColumn(mappingWorksheet.headers, MAPPING_HEADER_ALIASES.sourceTitle) ?? 2
          : 2,
        sourceSpec: mappingWorksheet
          ? findHeaderColumn(mappingWorksheet.headers, MAPPING_HEADER_ALIASES.sourceSpec)
          : null,
        scope: mappingWorksheet
          ? findHeaderColumn(mappingWorksheet.headers, MAPPING_HEADER_ALIASES.scope)
          : null,
        platform: mappingWorksheet
          ? findHeaderColumn(mappingWorksheet.headers, MAPPING_HEADER_ALIASES.platform)
          : null,
        sellerAccount: mappingWorksheet
          ? findHeaderColumn(mappingWorksheet.headers, MAPPING_HEADER_ALIASES.sellerAccount)
          : null,
      },
    },
  };
}

export async function previewProductCatalogWorkbook(input: {
  buffer: Buffer;
  columnMapping: ProductCatalogColumnMapping;
  duplicateSkuResolutions: ProductCatalogDuplicateSkuResolution[];
  existingProducts: readonly StandardProduct[];
  existingMappings: readonly ProductMappingView[];
}): Promise<ProductCatalogImportPreview> {
  const workbook = await loadWorkbook(input.buffer);
  const products = parseProductRows(workbook, input.columnMapping);
  const resolutions = new Map(input.duplicateSkuResolutions.map((resolution) => (
    [normalizeSkuKey(resolution.skuKey), resolution.selectedRowNumber] as const
  )));
  const duplicateGroups = groupDuplicateSkus(products);
  for (const [skuKey, selectedRowNumber] of resolutions) {
    const rows = duplicateGroups.get(skuKey);
    if (!rows || !rows.some((row) => row.rowNumber === selectedRowNumber)) {
      throw new Error('重复 SKU 选择不属于当前工作簿');
    }
  }

  const existingProductBySku = new Map(input.existingProducts.map((product) => (
    [normalizeSkuKey(product.sku), product] as const
  )));
  const productRows = products.map((row): ProductCatalogProductPreviewRow => {
    const duplicateRows = duplicateGroups.get(row.skuKey);
    const selectedRowNumber = duplicateRows ? resolutions.get(row.skuKey) : undefined;
    if (duplicateRows && selectedRowNumber === undefined) {
      return {
        ...row,
        action: 'duplicate',
        errors: [...row.errors, 'SKU 在文件中重复，必须选择保留行'],
      };
    }
    if (duplicateRows && selectedRowNumber !== row.rowNumber) {
      return { ...row, action: 'duplicate', errors: row.errors };
    }
    if (row.errors.length > 0) return { ...row, action: 'error', errors: row.errors };
    const existing = existingProductBySku.get(row.skuKey);
    if (!existing) return { ...row, action: 'create', errors: [] };
    const action = existing.name === row.name && existing.specification === row.specification
      ? 'unchanged'
      : 'update';
    return { ...row, action, errors: [] };
  });

  const effectiveProductSkuKeys = new Set(existingProductBySku.keys());
  for (const row of productRows) {
    if (row.action === 'create' || row.action === 'update' || row.action === 'unchanged') {
      effectiveProductSkuKeys.add(row.skuKey);
    }
  }
  const existingProductSkuById = new Map(input.existingProducts.map((product) => (
    [product.id, normalizeSkuKey(product.sku)] as const
  )));
  const existingMappingByKey = new Map(input.existingMappings.map((mapping) => (
    [mappingIdentity(mapping), {
      mapping,
      targetSkuKey: existingProductSkuById.get(mapping.standardProductId) ?? '',
    }] as const
  )));
  const parsedMappingRows = parseMappingRows(workbook, input.columnMapping);
  const importedTargetsByMappingKey = new Map<string, Set<string>>();
  for (const row of parsedMappingRows) {
    if (row.errors.length > 0 || !row.skuKey || !effectiveProductSkuKeys.has(row.skuKey)) continue;
    const key = mappingIdentity(row);
    const targets = importedTargetsByMappingKey.get(key) ?? new Set<string>();
    targets.add(row.skuKey);
    importedTargetsByMappingKey.set(key, targets);
  }
  const conflictingImportedMappingKeys = new Set(
    [...importedTargetsByMappingKey]
      .filter(([, targets]) => targets.size > 1)
      .map(([key]) => key),
  );
  const plannedMappingTargetByKey = new Map<string, string>();
  const mappingRows = parsedMappingRows.map(
    (row): ProductCatalogMappingPreviewRow => {
      const errors = [...row.errors];
      if (row.skuKey && !effectiveProductSkuKeys.has(row.skuKey)) {
        errors.push('SKU 对应的标准商品不存在或未通过预览');
      }
      const key = mappingIdentity(row);
      const existing = existingMappingByKey.get(key);
      const plannedTarget = plannedMappingTargetByKey.get(key);
      if (conflictingImportedMappingKeys.has(key)) {
        errors.push('文件中相同适用范围的商品映射指向多个 SKU');
      }
      if (errors.length > 0) {
        return { ...row, existingMappingId: existing?.mapping.id ?? null, action: 'error', errors };
      }
      if (existing?.targetSkuKey === row.skuKey || plannedTarget === row.skuKey) {
        return {
          ...row,
          existingMappingId: existing?.mapping.id ?? null,
          action: 'unchanged',
          errors: [],
        };
      }
      if (existing) {
        plannedMappingTargetByKey.set(key, row.skuKey);
        return {
          ...row,
          existingMappingId: existing.mapping.id,
          action: 'update',
          errors: [],
        };
      }
      plannedMappingTargetByKey.set(key, row.skuKey);
      return { ...row, existingMappingId: null, action: 'create', errors: [] };
    },
  );

  const duplicateSkus = [...duplicateGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([skuKey, rows]) => ({
      skuKey,
      rowNumbers: rows.map(({ rowNumber }) => rowNumber),
      selectedRowNumber: resolutions.get(skuKey) ?? null,
    }));
  const previewWithoutToken = {
    productRows,
    mappingRows,
    duplicateSkus,
    summary: {
      createProductCount: productRows.filter(({ action }) => action === 'create').length,
      updateProductCount: productRows.filter(({ action }) => action === 'update').length,
      unchangedProductCount: productRows.filter(({ action }) => action === 'unchanged').length,
      createMappingCount: mappingRows.filter(({ action }) => action === 'create').length,
      updateMappingCount: mappingRows.filter(({ action }) => action === 'update').length,
      unchangedMappingCount: mappingRows.filter(({ action }) => action === 'unchanged').length,
      errorRowCount: productRows.filter(({ action }) => action === 'error').length +
        mappingRows.filter(({ action }) => action === 'error').length,
    },
  };
  return {
    previewToken: createHash('sha256').update(JSON.stringify({
      columnMapping: input.columnMapping,
      duplicateSkuResolutions: input.duplicateSkuResolutions,
      existingProducts: input.existingProducts,
      existingMappings: input.existingMappings,
      preview: previewWithoutToken,
    })).digest('hex'),
    ...previewWithoutToken,
  };
}

export async function createProductCatalogWorkbook(input: {
  products: readonly StandardProduct[];
  mappings: readonly ProductMappingView[];
}): Promise<Buffer> {
  const activeMappings = input.mappings.filter(({ status }) => status === 'active');
  if (
    input.products.length > MAX_DATA_ROWS_PER_WORKSHEET ||
    activeMappings.length > MAX_DATA_ROWS_PER_WORKSHEET
  ) {
    throw new Error('商品目录单张工作表最多导出 10000 条记录');
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '闲鱼订单管理';
  workbook.created = new Date();

  const products = workbook.addWorksheet('标准商品');
  products.addRow(['SKU', '标准商品名', '标准规格']);
  for (const product of input.products) {
    products.addRow([product.sku, product.name, product.specification]);
  }
  styleWorksheet(products, [24, 32, 28]);

  const mappings = workbook.addWorksheet('商品映射');
  mappings.addRow(['SKU', '原始商品标题', '原始规格', '适用范围', '平台', '卖家账号']);
  for (const mapping of activeMappings) {
    mappings.addRow([
      mapping.targetProductSku,
      mapping.sourceTitle,
      mapping.sourceSpec,
      scopeLabel(mapping.scope),
      mapping.platform ?? '',
      mapping.sellerAccount ?? '',
    ]);
  }
  styleWorksheet(mappings, [24, 36, 28, 22, 18, 24]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  if (buffer.length > MAX_WORKBOOK_BYTES) {
    throw new Error('商品目录工作簿不能超过 10 MB，请减少目录记录后重试');
  }
  await assertProductCatalogWorkbookArchiveLimits(buffer);
  return buffer;
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_WORKBOOK_BYTES) {
    throw new Error('商品目录工作簿大小无效');
  }
  await assertProductCatalogWorkbookArchiveLimits(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
  } catch {
    throw new Error('无法读取商品目录工作簿，请确认文件是有效的 .xlsx 文件');
  }
  if (workbook.worksheets.length > MAX_WORKSHEETS) {
    throw new Error('商品目录工作表数量过多');
  }
  for (const worksheet of workbook.worksheets) {
    if (worksheet.rowCount > MAX_DATA_ROWS_PER_WORKSHEET + 1) {
      throw new Error('商品目录工作表行数过多');
    }
    if (worksheet.columnCount > MAX_COLUMNS_PER_WORKSHEET) {
      throw new Error('商品目录工作表列数过多');
    }
  }
  return workbook;
}

export function assertProductCatalogWorkbookArchiveLimits(buffer: Buffer): Promise<void> {
  return assertXlsxWorkbookArchiveLimits(buffer, '商品目录工作簿');
}

function parseProductRows(
  workbook: ExcelJS.Workbook,
  mapping: ProductCatalogColumnMapping,
): ParsedProductRow[] {
  const worksheet = requiredWorksheet(workbook, mapping.productWorksheet);
  const rows: ParsedProductRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const sku = cellText(row, mapping.productColumns.sku);
    const name = cellText(row, mapping.productColumns.name);
    const specification = cellText(row, mapping.productColumns.specification);
    if (!sku && !name && !specification) return;
    const errors: string[] = [];
    if (!sku) errors.push('SKU 不能为空');
    if (sku.length > 100) errors.push('SKU 不能超过 100 个字符');
    if (!name) errors.push('标准商品名不能为空');
    if (name.length > 300) errors.push('标准商品名不能超过 300 个字符');
    if (!specification) errors.push('标准规格不能为空');
    if (specification.length > 300) errors.push('标准规格不能超过 300 个字符');
    rows.push({
      rowNumber,
      sku,
      skuKey: normalizeSkuKey(sku),
      name,
      specification,
      errors,
    });
  });
  return rows;
}

function parseMappingRows(
  workbook: ExcelJS.Workbook,
  mapping: ProductCatalogColumnMapping,
): ParsedMappingRow[] {
  if (!mapping.mappingWorksheet) return [];
  const worksheet = requiredWorksheet(workbook, mapping.mappingWorksheet);
  const rows: ParsedMappingRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const sku = cellText(row, mapping.mappingColumns.sku);
    const sourceTitle = cellText(row, mapping.mappingColumns.sourceTitle);
    const sourceSpec = optionalCellText(row, mapping.mappingColumns.sourceSpec);
    const scopeText = optionalCellText(row, mapping.mappingColumns.scope);
    const platformText = optionalCellText(row, mapping.mappingColumns.platform);
    const sellerAccountText = optionalCellText(row, mapping.mappingColumns.sellerAccount);
    if (!sku && !sourceTitle && !sourceSpec && !scopeText && !platformText && !sellerAccountText) {
      return;
    }
    const errors: string[] = [];
    if (!sku) errors.push('SKU 不能为空');
    if (!sourceTitle) errors.push('原始商品标题不能为空');
    if (sourceTitle.length > 300) errors.push('原始商品标题不能超过 300 个字符');
    if (sourceSpec.length > 300) errors.push('原始规格不能超过 300 个字符');
    const scope = parseScope(scopeText, errors);
    const platform = platformText || null;
    const sellerAccount = sellerAccountText || null;
    if (platformText.length > 200) errors.push('平台不能超过 200 个字符');
    if (sellerAccountText.length > 200) errors.push('卖家账号不能超过 200 个字符');
    if (scope === 'current_account' && (!platform || !sellerAccount)) {
      errors.push('当前平台与卖家账号级映射必须提供平台与卖家账号');
    }
    if (scope === 'current_platform' && !platform) {
      errors.push('当前平台级映射必须提供平台');
    }
    if (scope === 'current_platform' && sellerAccount) {
      errors.push('当前平台级映射不能包含卖家账号');
    }
    if (scope === 'workspace' && (platform || sellerAccount)) {
      errors.push('工作区级映射不能包含平台或卖家账号');
    }
    rows.push({
      rowNumber,
      sku,
      skuKey: normalizeSkuKey(sku),
      sourceTitle,
      sourceSpec,
      scope,
      platform,
      sellerAccount,
      errors,
    });
  });
  return rows;
}

function groupDuplicateSkus(rows: readonly ParsedProductRow[]): Map<string, ParsedProductRow[]> {
  const grouped = new Map<string, ParsedProductRow[]>();
  for (const row of rows) {
    if (!row.skuKey) continue;
    const matches = grouped.get(row.skuKey) ?? [];
    matches.push(row);
    grouped.set(row.skuKey, matches);
  }
  return new Map([...grouped].filter(([, matches]) => matches.length > 1));
}

function requiredWorksheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const worksheet = workbook.getWorksheet(name);
  if (!worksheet) throw new Error(`未找到工作表“${name}”`);
  return worksheet;
}

function cellText(row: ExcelJS.Row, column: number): string {
  return row.getCell(column).text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function optionalCellText(row: ExcelJS.Row, column: number | null): string {
  return column === null ? '' : cellText(row, column);
}

function parseScope(value: string, errors: string[]): ProductMappingScope {
  const normalized = normalizeProductText(value);
  if (!normalized) {
    errors.push('适用范围不能为空');
    return 'workspace';
  }
  if (normalized === 'workspace' || normalized === '整个工作区') return 'workspace';
  if (normalized === 'current_platform' || normalized === '当前平台全部账号') {
    return 'current_platform';
  }
  if (normalized === 'current_account' || normalized === '当前平台与卖家账号') {
    return 'current_account';
  }
  errors.push('适用范围必须是当前平台与卖家账号、当前平台全部账号或整个工作区');
  return 'workspace';
}

function mappingIdentity(mapping: Pick<
  ProductCatalogMappingPreviewRow | ProductMappingView,
  'sourceTitle' | 'sourceSpec' | 'scope' | 'platform' | 'sellerAccount'
>): string {
  return [
    mapping.scope,
    mapping.platform ?? '',
    mapping.sellerAccount ?? '',
    normalizeProductText(mapping.sourceTitle),
    normalizeProductText(mapping.sourceSpec),
  ].join('\u0000');
}

function worksheetHeaders(worksheet: ExcelJS.Worksheet): string[] {
  const row = worksheet.getRow(1);
  const headers = Array.from({ length: Math.min(row.cellCount, MAX_COLUMNS_PER_WORKSHEET) }, (_, index) => (
    cellText(row, index + 1)
  ));
  while (headers.at(-1) === '') headers.pop();
  return headers;
}

function findHeaderColumn(headers: readonly string[], aliases: readonly string[]): number | null {
  const normalizedAliases = aliases.map(normalizeHeader);
  const exact = headers.findIndex((header) => normalizedAliases.includes(normalizeHeader(header)));
  if (exact >= 0) return exact + 1;
  const partial = headers.findIndex((header) => (
    normalizedAliases.some((alias) => normalizeHeader(header).includes(alias))
  ));
  return partial >= 0 ? partial + 1 : null;
}

function bestWorksheet(
  worksheets: readonly ProductCatalogWorkbookInspection['worksheets'][number][],
  fieldAliases: readonly (readonly string[])[],
  minimumScore = fieldAliases.length,
): ProductCatalogWorkbookInspection['worksheets'][number] | null {
  const scored = worksheets.map((worksheet) => ({
    worksheet,
    score: fieldAliases.filter((aliases) => findHeaderColumn(worksheet.headers, aliases)).length,
  })).sort((left, right) => right.score - left.score);
  return scored[0] && scored[0].score >= minimumScore ? scored[0].worksheet : null;
}

function normalizeHeader(value: string): string {
  return value.normalize('NFKC').trim().replace(/[\s_\-]/gu, '').toLocaleLowerCase('zh-CN');
}

function scopeLabel(scope: ProductMappingScope): string {
  if (scope === 'current_account') return '当前平台与卖家账号';
  if (scope === 'current_platform') return '当前平台全部账号';
  return '整个工作区';
}

function styleWorksheet(worksheet: ExcelJS.Worksheet, widths: readonly number[]): void {
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF305A7A' },
  };
  widths.forEach((width, index) => { worksheet.getColumn(index + 1).width = width; });
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, worksheet.rowCount), column: widths.length },
  };
}

const PRODUCT_HEADER_ALIASES = {
  sku: ['SKU', '商品编码', '货号'],
  name: ['标准商品名', '商品名称', '名称'],
  specification: ['标准规格', '商品规格', '规格'],
} as const;

const MAPPING_HEADER_ALIASES = {
  sku: ['SKU', '关联SKU', '商品编码'],
  sourceTitle: ['原始商品标题', '标题别名', '别名标题', '别名'],
  sourceSpec: ['原始规格', '别名规格'],
  scope: ['适用范围', '范围'],
  platform: ['平台'],
  sellerAccount: ['卖家账号', '账号'],
} as const;
