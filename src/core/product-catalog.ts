import type { ProductMappingScope } from './product-standardization';

export type ProductCatalogProductColumns = {
  sku: number;
  name: number;
  specification: number;
};

export type ProductCatalogMappingColumns = {
  sku: number;
  sourceTitle: number;
  sourceSpec: number | null;
  scope: number | null;
  platform: number | null;
  sellerAccount: number | null;
};

export type ProductCatalogColumnMapping = {
  productWorksheet: string;
  productColumns: ProductCatalogProductColumns;
  mappingWorksheet: string | null;
  mappingColumns: ProductCatalogMappingColumns;
};

export type ProductCatalogDuplicateSkuResolution = {
  skuKey: string;
  selectedRowNumber: number;
};

export type ProductCatalogImportInput = {
  columnMapping: ProductCatalogColumnMapping;
  duplicateSkuResolutions: ProductCatalogDuplicateSkuResolution[];
};

export type ProductCatalogImportConfirmationInput = ProductCatalogImportInput & {
  previewToken: string;
  mappingUpdateReason: string;
};

export type ProductCatalogWorkbookInspection = {
  worksheets: Array<{
    name: string;
    headers: string[];
  }>;
  suggestedColumnMapping: ProductCatalogColumnMapping;
};

export type ProductCatalogProductImportAction =
  | 'create'
  | 'update'
  | 'unchanged'
  | 'duplicate'
  | 'error';

export type ProductCatalogProductPreviewRow = {
  rowNumber: number;
  sku: string;
  skuKey: string;
  name: string;
  specification: string;
  action: ProductCatalogProductImportAction;
  errors: string[];
};

export type ProductCatalogMappingImportAction = 'create' | 'update' | 'unchanged' | 'error';

export type ProductCatalogMappingPreviewRow = {
  rowNumber: number;
  sku: string;
  skuKey: string;
  sourceTitle: string;
  sourceSpec: string;
  scope: ProductMappingScope;
  platform: string | null;
  sellerAccount: string | null;
  existingMappingId: string | null;
  action: ProductCatalogMappingImportAction;
  errors: string[];
};

export type ProductCatalogDuplicateSkuPreview = {
  skuKey: string;
  rowNumbers: number[];
  selectedRowNumber: number | null;
};

export type ProductCatalogImportPreview = {
  previewToken: string;
  productRows: ProductCatalogProductPreviewRow[];
  mappingRows: ProductCatalogMappingPreviewRow[];
  duplicateSkus: ProductCatalogDuplicateSkuPreview[];
  summary: {
    createProductCount: number;
    updateProductCount: number;
    unchangedProductCount: number;
    createMappingCount: number;
    updateMappingCount: number;
    unchangedMappingCount: number;
    errorRowCount: number;
  };
};

export type ProductCatalogImportResult = {
  createdProductCount: number;
  updatedProductCount: number;
  createdMappingCount: number;
  updatedMappingCount: number;
  skippedErrorRowCount: number;
};

export type ProductCatalogImportSelectionOutcome =
  | { kind: 'canceled' }
  | {
    kind: 'selected';
    sessionId: string;
    fileName: string;
    inspection: ProductCatalogWorkbookInspection;
  };

export type ProductCatalogExportOutcome =
  | { kind: 'cancelled' }
  | { kind: 'saved'; fileName: string; filePath: string };

export function normalizeProductCatalogImportInput(value: unknown): ProductCatalogImportInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('商品目录导入内容无效');
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(record, ['columnMapping', 'duplicateSkuResolutions'], '商品目录导入');
  return {
    columnMapping: normalizeColumnMapping(record.columnMapping),
    duplicateSkuResolutions: normalizeDuplicateSkuResolutions(record.duplicateSkuResolutions),
  };
}

export function normalizeProductCatalogImportConfirmationInput(
  value: unknown,
): ProductCatalogImportConfirmationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('商品目录导入确认内容无效');
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(
    record,
    ['columnMapping', 'duplicateSkuResolutions', 'previewToken', 'mappingUpdateReason'],
    '商品目录导入确认',
  );
  if (
    typeof record.previewToken !== 'string' ||
    !record.previewToken.trim() ||
    record.previewToken.trim().length > 200
  ) {
    throw new Error('商品目录预览标识无效');
  }
  if (typeof record.mappingUpdateReason !== 'string') {
    throw new Error('商品映射更新原因无效');
  }
  const mappingUpdateReason = record.mappingUpdateReason.normalize('NFKC').trim();
  if (mappingUpdateReason.length > 500) throw new Error('商品映射更新原因无效');
  return {
    columnMapping: normalizeColumnMapping(record.columnMapping),
    duplicateSkuResolutions: normalizeDuplicateSkuResolutions(record.duplicateSkuResolutions),
    previewToken: record.previewToken.trim(),
    mappingUpdateReason,
  };
}

function normalizeColumnMapping(value: unknown): ProductCatalogColumnMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('商品目录列映射无效');
  }
  const record = value as Record<string, unknown>;
  assertExactKeys(
    record,
    ['productWorksheet', 'productColumns', 'mappingWorksheet', 'mappingColumns'],
    '商品目录列映射',
  );
  const productWorksheet = requiredWorksheetName(record.productWorksheet);
  const mappingWorksheet = record.mappingWorksheet === null
    ? null
    : requiredWorksheetName(record.mappingWorksheet);
  return {
    productWorksheet,
    productColumns: normalizeProductColumns(record.productColumns),
    mappingWorksheet,
    mappingColumns: normalizeMappingColumns(record.mappingColumns),
  };
}

function normalizeProductColumns(value: unknown): ProductCatalogProductColumns {
  const record = requireColumnRecord(value, '标准商品列映射');
  assertExactKeys(record, ['sku', 'name', 'specification'], '标准商品列映射');
  return {
    sku: requiredColumnNumber(record.sku),
    name: requiredColumnNumber(record.name),
    specification: requiredColumnNumber(record.specification),
  };
}

function normalizeMappingColumns(value: unknown): ProductCatalogMappingColumns {
  const record = requireColumnRecord(value, '商品映射列映射');
  assertExactKeys(
    record,
    ['sku', 'sourceTitle', 'sourceSpec', 'scope', 'platform', 'sellerAccount'],
    '商品映射列映射',
  );
  return {
    sku: requiredColumnNumber(record.sku),
    sourceTitle: requiredColumnNumber(record.sourceTitle),
    sourceSpec: optionalColumnNumber(record.sourceSpec),
    scope: optionalColumnNumber(record.scope),
    platform: optionalColumnNumber(record.platform),
    sellerAccount: optionalColumnNumber(record.sellerAccount),
  };
}

function normalizeDuplicateSkuResolutions(value: unknown): ProductCatalogDuplicateSkuResolution[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error('重复 SKU 选择无效');
  }
  const normalized = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('重复 SKU 选择无效');
    }
    const record = entry as Record<string, unknown>;
    assertExactKeys(record, ['skuKey', 'selectedRowNumber'], '重复 SKU 选择');
    if (typeof record.skuKey !== 'string' || !record.skuKey.trim()) {
      throw new Error('重复 SKU 选择无效');
    }
    return {
      skuKey: record.skuKey.normalize('NFKC').trim().toLocaleUpperCase('en-US'),
      selectedRowNumber: requiredRowNumber(record.selectedRowNumber),
    };
  });
  if (new Set(normalized.map(({ skuKey }) => skuKey)).size !== normalized.length) {
    throw new Error('重复 SKU 不能多次选择');
  }
  return normalized;
}

function requireColumnRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}无效`);
  }
  return value as Record<string, unknown>;
}

function requiredWorksheetName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('工作表名称无效');
  const normalized = value.trim();
  if (!normalized || normalized.length > 31) throw new Error('工作表名称无效');
  return normalized;
}

function requiredColumnNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 200) {
    throw new Error('列编号无效');
  }
  return value as number;
}

function optionalColumnNumber(value: unknown): number | null {
  return value === null ? null : requiredColumnNumber(value);
}

function requiredRowNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 2 || (value as number) > 10_001) {
    throw new Error('行编号无效');
  }
  return value as number;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  if (
    Object.keys(record).some((key) => !expected.has(key)) ||
    expectedKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error(`${label}字段无效`);
  }
}
