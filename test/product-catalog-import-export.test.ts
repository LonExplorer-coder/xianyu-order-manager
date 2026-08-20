import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  ProductCatalogColumnMapping,
  ProductCatalogImportInput,
} from '../src/core/product-catalog';
import type {
  ProductMappingView,
  StandardProduct,
} from '../src/core/product-standardization';
import { ControlledRecognizer } from '../src/adapters/recognition/controlled-recognizer';
import { LocalApplication } from '../src/main/local-application';
import { createProductCatalogWorkbook } from '../src/main/product-catalog-workbook';

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

async function customCatalogWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const products = workbook.addWorksheet('我的商品');
  products.addRow(['商品编码', '名称列', '规格列']);
  products.addRow(['SKU-NEW', '新商品', '蓝色']);
  products.addRow(['SKU-UPDATE', '更新后的商品', '新版规格']);
  products.addRow(['SKU-DUP', '重复商品甲', '甲规格']);
  products.addRow(['sku-dup', '重复商品乙', '乙规格']);
  products.addRow(['SKU-ERROR', '', '缺少名称']);

  const mappings = workbook.addWorksheet('我的映射');
  mappings.addRow(['关联SKU', '别名标题', '别名规格', '范围', '平台列', '账号列']);
  mappings.addRow(['SKU-NEW', '新商品闲鱼专拍', '蓝色', '整个工作区', '', '']);
  mappings.addRow(['SKU-UPDATE', '旧别名', '旧规格', '当前平台全部账号', 'xianyu', '']);
  mappings.addRow(['', '错误别名', '', '整个工作区', '', '']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const customColumnMapping: ProductCatalogColumnMapping = {
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

describe('商品目录工作簿', () => {
  it('先预览新增、更新、重复 SKU 与错误行，解决重复后只写入可确认内容', async () => {
    const application = await openApplication('xianyu-product-catalog-import-');
    const existing = application.createStandardProduct({
      sku: 'SKU-UPDATE',
      name: '更新前商品',
      specification: '旧版规格',
    });
    application.createProductMapping(existing.id, {
      sourceTitle: '旧别名',
      sourceSpec: '旧规格',
      scope: 'current_platform',
      platform: 'xianyu',
      sellerAccount: null,
    });
    const buffer = await customCatalogWorkbook();

    const inspection = await application.inspectProductCatalogWorkbook(buffer);
    expect(inspection.worksheets).toEqual([
      expect.objectContaining({ name: '我的商品', headers: ['商品编码', '名称列', '规格列'] }),
      expect.objectContaining({
        name: '我的映射',
        headers: ['关联SKU', '别名标题', '别名规格', '范围', '平台列', '账号列'],
      }),
    ]);

    const preview = await application.previewProductCatalogImport(buffer, {
      columnMapping: customColumnMapping,
      duplicateSkuResolutions: [],
    });
    expect(application.listStandardProducts()).toHaveLength(1);
    expect(preview.productRows.map(({ rowNumber, sku, action, errors }) => ({
      rowNumber,
      sku,
      action,
      errors,
    }))).toEqual([
      { rowNumber: 2, sku: 'SKU-NEW', action: 'create', errors: [] },
      { rowNumber: 3, sku: 'SKU-UPDATE', action: 'update', errors: [] },
      { rowNumber: 4, sku: 'SKU-DUP', action: 'duplicate', errors: ['SKU 在文件中重复，必须选择保留行'] },
      { rowNumber: 5, sku: 'sku-dup', action: 'duplicate', errors: ['SKU 在文件中重复，必须选择保留行'] },
      { rowNumber: 6, sku: 'SKU-ERROR', action: 'error', errors: ['标准商品名不能为空'] },
    ]);
    expect(preview.duplicateSkus).toEqual([{
      skuKey: 'SKU-DUP',
      rowNumbers: [4, 5],
      selectedRowNumber: null,
    }]);
    expect(preview.mappingRows.map(({ rowNumber, action, errors }) => ({
      rowNumber,
      action,
      errors,
    }))).toEqual([
      { rowNumber: 2, action: 'create', errors: [] },
      { rowNumber: 3, action: 'unchanged', errors: [] },
      { rowNumber: 4, action: 'error', errors: ['SKU 不能为空'] },
    ]);
    await expect(application.confirmProductCatalogImport(buffer, {
      columnMapping: customColumnMapping,
      duplicateSkuResolutions: [],
      previewToken: preview.previewToken,
      mappingUpdateReason: '',
    })).rejects.toThrow('重复 SKU 必须全部明确选择保留行');
    expect(application.listStandardProducts()).toHaveLength(1);

    const selectedInput: ProductCatalogImportInput = {
      columnMapping: customColumnMapping,
      duplicateSkuResolutions: [{ skuKey: 'SKU-DUP', selectedRowNumber: 5 }],
    };
    const selectedPreview = await application.previewProductCatalogImport(buffer, selectedInput);
    const result = await application.confirmProductCatalogImport(buffer, {
      ...selectedInput,
      previewToken: selectedPreview.previewToken,
      mappingUpdateReason: '',
    });
    expect(result).toMatchObject({
      createdProductCount: 2,
      updatedProductCount: 1,
      createdMappingCount: 1,
      skippedErrorRowCount: 2,
    });
    expect(application.listStandardProducts().map(({ sku, name, specification }) => ({
      sku,
      name,
      specification,
    }))).toEqual([
      { sku: 'sku-dup', name: '重复商品乙', specification: '乙规格' },
      { sku: 'SKU-NEW', name: '新商品', specification: '蓝色' },
      { sku: 'SKU-UPDATE', name: '更新后的商品', specification: '新版规格' },
    ]);
    const imported = application.listStandardProducts().find(({ sku }) => sku === 'SKU-NEW');
    expect(imported).toBeDefined();
    expect(application.listProductMappings(imported!.id)).toEqual([
      expect.objectContaining({
        sourceTitle: '新商品闲鱼专拍',
        sourceSpec: '蓝色',
        scope: 'workspace',
        platform: null,
        sellerAccount: null,
        status: 'active',
      }),
    ]);
  });

  it('导出的标准商品与当前有效商品映射可在空工作区重新导入并保持语义', async () => {
    const source = await openApplication('xianyu-product-catalog-export-source-');
    const cup = source.createStandardProduct({
      sku: 'SKU-CUP',
      name: '海棠杯',
      specification: '红色 450ml',
    });
    const shoe = source.createStandardProduct({
      sku: 'SKU-SHOE',
      name: '古风娃鞋',
      specification: '05M',
    });
    source.createProductMapping(cup.id, {
      sourceTitle: '海棠杯闲鱼专拍',
      sourceSpec: '红色',
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
    });
    source.createProductMapping(shoe.id, {
      sourceTitle: '古风娃鞋白模',
      sourceSpec: '05M',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '娃物账号',
    });

    const buffer = await source.createProductCatalogWorkbook();
    const target = await openApplication('xianyu-product-catalog-export-target-');
    const inspection = await target.inspectProductCatalogWorkbook(buffer);
    expect(inspection.suggestedColumnMapping).toEqual({
      productWorksheet: '标准商品',
      productColumns: { sku: 1, name: 2, specification: 3 },
      mappingWorksheet: '商品映射',
      mappingColumns: {
        sku: 1,
        sourceTitle: 2,
        sourceSpec: 3,
        scope: 4,
        platform: 5,
        sellerAccount: 6,
      },
    });

    const preview = await target.previewProductCatalogImport(buffer, {
      columnMapping: inspection.suggestedColumnMapping,
      duplicateSkuResolutions: [],
    });
    expect(preview.summary).toMatchObject({
      createProductCount: 2,
      updateProductCount: 0,
      createMappingCount: 2,
      errorRowCount: 0,
    });
    await target.confirmProductCatalogImport(buffer, {
      columnMapping: inspection.suggestedColumnMapping,
      duplicateSkuResolutions: [],
      previewToken: preview.previewToken,
      mappingUpdateReason: '',
    });

    expect(target.listStandardProducts().map(({ sku, name, specification }) => ({
      sku,
      name,
      specification,
    }))).toEqual([
      { sku: 'SKU-CUP', name: '海棠杯', specification: '红色 450ml' },
      { sku: 'SKU-SHOE', name: '古风娃鞋', specification: '05M' },
    ]);
    const importedProducts = new Map(target.listStandardProducts().map((product) => (
      [product.sku, product] as const
    )));
    expect(target.listProductMappings(importedProducts.get('SKU-CUP')!.id)).toEqual([
      expect.objectContaining({
        sourceTitle: '海棠杯闲鱼专拍',
        sourceSpec: '红色',
        scope: 'workspace',
        platform: null,
        sellerAccount: null,
      }),
    ]);
    expect(target.listProductMappings(importedProducts.get('SKU-SHOE')!.id)).toEqual([
      expect.objectContaining({
        sourceTitle: '古风娃鞋白模',
        sourceSpec: '05M',
        scope: 'current_account',
        platform: 'xianyu',
        sellerAccount: '娃物账号',
      }),
    ]);
  });

  it('文件内相同适用范围的商品映射指向多个 SKU 时全部作为错误行跳过', async () => {
    const workbook = new ExcelJS.Workbook();
    const products = workbook.addWorksheet('标准商品');
    products.addRow(['SKU', '标准商品名', '标准规格']);
    products.addRow(['SKU-A', '商品甲', '甲规格']);
    products.addRow(['SKU-B', '商品乙', '乙规格']);
    const mappings = workbook.addWorksheet('商品映射');
    mappings.addRow(['SKU', '原始商品标题', '原始规格', '适用范围', '平台', '卖家账号']);
    mappings.addRow(['SKU-A', '共享标题', '共享规格', '整个工作区', '', '']);
    mappings.addRow(['SKU-B', '共享标题', '共享规格', '整个工作区', '', '']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const application = await openApplication('xianyu-product-catalog-mapping-conflict-');
    const inspection = await application.inspectProductCatalogWorkbook(buffer);
    const input = {
      columnMapping: inspection.suggestedColumnMapping,
      duplicateSkuResolutions: [],
    };
    const preview = await application.previewProductCatalogImport(buffer, input);
    expect(preview.mappingRows).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        action: 'error',
        errors: ['文件中相同适用范围的商品映射指向多个 SKU'],
      }),
      expect.objectContaining({
        rowNumber: 3,
        action: 'error',
        errors: ['文件中相同适用范围的商品映射指向多个 SKU'],
      }),
    ]);
    await expect(application.confirmProductCatalogImport(buffer, {
      ...input,
      previewToken: preview.previewToken,
      mappingUpdateReason: '',
    })).resolves.toMatchObject({
      createdProductCount: 2,
      createdMappingCount: 0,
      skippedErrorRowCount: 2,
    });
  });

  it('可把现有标题别名改指向另一标准商品，并要求留下变更原因', async () => {
    const application = await openApplication('xianyu-product-catalog-mapping-update-');
    const productA = application.createStandardProduct({
      sku: 'SKU-A',
      name: '商品甲',
      specification: '甲规格',
    });
    const productB = application.createStandardProduct({
      sku: 'SKU-B',
      name: '商品乙',
      specification: '乙规格',
    });
    application.createProductMapping(productA.id, {
      sourceTitle: '共享标题',
      sourceSpec: '共享规格',
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
    });

    const workbook = new ExcelJS.Workbook();
    const products = workbook.addWorksheet('标准商品');
    products.addRow(['SKU', '标准商品名', '标准规格']);
    products.addRow(['SKU-A', '商品甲', '甲规格']);
    products.addRow(['SKU-B', '商品乙', '乙规格']);
    const mappings = workbook.addWorksheet('商品映射');
    mappings.addRow(['SKU', '原始商品标题', '原始规格', '适用范围', '平台', '卖家账号']);
    mappings.addRow(['SKU-B', '共享标题', '共享规格', '整个工作区', '', '']);
    mappings.addRow(['SKU-B', '共享标题', '共享规格', '整个工作区', '', '']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const inspection = await application.inspectProductCatalogWorkbook(buffer);
    const input = {
      columnMapping: inspection.suggestedColumnMapping,
      duplicateSkuResolutions: [],
    };
    const preview = await application.previewProductCatalogImport(buffer, input);

    expect(preview.mappingRows).toEqual([
      expect.objectContaining({ action: 'update', errors: [] }),
      expect.objectContaining({ action: 'unchanged', errors: [] }),
    ]);
    expect(preview.summary.updateMappingCount).toBe(1);
    await expect(application.confirmProductCatalogImport(buffer, {
      ...input,
      previewToken: preview.previewToken,
      mappingUpdateReason: '',
    })).rejects.toThrow('商品映射更新必须填写原因');

    await expect(application.confirmProductCatalogImport(buffer, {
      ...input,
      previewToken: preview.previewToken,
      mappingUpdateReason: '修正标题别名归属',
    })).resolves.toMatchObject({ updatedMappingCount: 1 });
    expect(application.listProductMappings(productA.id)).toEqual([]);
    expect(application.listProductMappings(productB.id)).toEqual([
      expect.objectContaining({ sourceTitle: '共享标题', targetProductSku: 'SKU-B' }),
    ]);
    expect(application.listProductMappingEvents(productB.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: 'corrected', reason: '修正标题别名归属' }),
      ]),
    );
  });

  it('确认时拒绝已经过期的预览', async () => {
    const application = await openApplication('xianyu-product-catalog-stale-preview-');
    const product = application.createStandardProduct({
      sku: 'SKU-A',
      name: '旧名称',
      specification: '旧规格',
    });
    const workbook = new ExcelJS.Workbook();
    const products = workbook.addWorksheet('标准商品');
    products.addRow(['SKU', '标准商品名', '标准规格']);
    products.addRow(['SKU-A', '导入名称', '导入规格']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const inspection = await application.inspectProductCatalogWorkbook(buffer);
    const input = {
      columnMapping: inspection.suggestedColumnMapping,
      duplicateSkuResolutions: [],
    };
    const preview = await application.previewProductCatalogImport(buffer, input);
    application.updateStandardProduct(product.id, {
      sku: 'SKU-A',
      name: '预览后编辑的名称',
      specification: '预览后编辑的规格',
      defaultOrderPriceCents: null,
      expectedRevision: product.revision,
    });

    await expect(application.confirmProductCatalogImport(buffer, {
      ...input,
      previewToken: preview.previewToken,
      mappingUpdateReason: '',
    })).rejects.toThrow('商品目录预览已过期，请重新预览');
    expect(application.listStandardProducts().find(({ id }) => id === product.id)).toMatchObject({
      name: '预览后编辑的名称',
      specification: '预览后编辑的规格',
    });
  });

  it('重复 SKU 可选择第 201 行之后的保留行', async () => {
    const application = await openApplication('xianyu-product-catalog-late-duplicate-');
    const workbook = new ExcelJS.Workbook();
    const products = workbook.addWorksheet('标准商品');
    products.addRow(['SKU', '标准商品名', '标准规格']);
    for (let rowNumber = 2; rowNumber <= 201; rowNumber += 1) {
      products.addRow([`SKU-${rowNumber}`, `商品 ${rowNumber}`, `规格 ${rowNumber}`]);
    }
    products.addRow(['SKU-2', '第 202 行商品', '第 202 行规格']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const inspection = await application.inspectProductCatalogWorkbook(buffer);
    const preview = await application.previewProductCatalogImport(buffer, {
      columnMapping: inspection.suggestedColumnMapping,
      duplicateSkuResolutions: [{ skuKey: 'SKU-2', selectedRowNumber: 202 }],
    });
    expect(preview.duplicateSkus).toEqual([
      { skuKey: 'SKU-2', rowNumbers: [2, 202], selectedRowNumber: 202 },
    ]);
  });

  it('缺失适用范围与过长范围字段只标记当前错误行', async () => {
    const application = await openApplication('xianyu-product-catalog-row-validation-');
    const workbook = new ExcelJS.Workbook();
    const products = workbook.addWorksheet('标准商品');
    products.addRow(['SKU', '标准商品名', '标准规格']);
    products.addRow(['SKU-A', '商品甲', '甲规格']);
    const mappings = workbook.addWorksheet('商品映射');
    mappings.addRow(['SKU', '原始商品标题', '原始规格', '适用范围', '平台', '卖家账号']);
    mappings.addRow(['SKU-A', '缺范围', '', '', '', '']);
    mappings.addRow(['SKU-A', '平台过长', '', '当前平台全部账号', 'x'.repeat(201), '']);
    mappings.addRow(['SKU-A', '账号过长', '', '当前平台与卖家账号', 'xianyu', 'a'.repeat(201)]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const inspection = await application.inspectProductCatalogWorkbook(buffer);
    const input = {
      columnMapping: inspection.suggestedColumnMapping,
      duplicateSkuResolutions: [],
    };
    const preview = await application.previewProductCatalogImport(buffer, input);

    expect(preview.mappingRows.map(({ action, errors }) => ({ action, errors }))).toEqual([
      { action: 'error', errors: ['适用范围不能为空'] },
      { action: 'error', errors: ['平台不能超过 200 个字符'] },
      { action: 'error', errors: ['卖家账号不能超过 200 个字符'] },
    ]);
    await expect(application.confirmProductCatalogImport(buffer, {
      ...input,
      previewToken: preview.previewToken,
      mappingUpdateReason: '',
    })).resolves.toMatchObject({
      createdProductCount: 1,
      createdMappingCount: 0,
      skippedErrorRowCount: 3,
    });
  });

  it('在 Excel 解析前拒绝解压后异常膨胀的工作簿', async () => {
    const application = await openApplication('xianyu-product-catalog-archive-limit-');
    const workbook = new ExcelJS.Workbook();
    const products = workbook.addWorksheet('标准商品');
    products.addRow(['SKU', '标准商品名', '标准规格']);
    products.addRow(['SKU-A', '商品甲', '甲规格']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const centralDirectoryEntry = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralDirectoryEntry).toBeGreaterThanOrEqual(0);
    const malformed = Buffer.from(buffer);
    malformed.writeUInt32LE(60 * 1024 * 1024, centralDirectoryEntry + 24);

    await expect(application.inspectProductCatalogWorkbook(malformed))
      .rejects.toThrow('商品目录工作簿解压后内容过大');
  });

  it('成功导出的最多一万条标准商品仍可重新导入', async () => {
    const now = '2026-08-20T00:00:00.000Z';
    const products: StandardProduct[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `product-${index + 1}`,
      sku: `SKU-${index + 1}`,
      name: `商品 ${index + 1}`,
      specification: `规格 ${index + 1}`,
      defaultOrderPriceCents: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const buffer = await createProductCatalogWorkbook({ products, mappings: [] });
    const application = await openApplication('xianyu-product-catalog-export-limit-');
    const inspection = await application.inspectProductCatalogWorkbook(buffer);
    const preview = await application.previewProductCatalogImport(buffer, {
      columnMapping: inspection.suggestedColumnMapping,
      duplicateSkuResolutions: [],
    });

    expect(preview.summary).toMatchObject({ createProductCount: 10_000, errorRowCount: 0 });
    await expect(createProductCatalogWorkbook({
      products: [...products, { ...products[0], id: 'product-10001', sku: 'SKU-10001' }],
      mappings: [],
    })).rejects.toThrow('商品目录单张工作表最多导出 10000 条记录');
  }, 20_000);

  it('拒绝生成超过重新导入大小上限的商品目录工作簿', async () => {
    const now = '2026-08-20T00:00:00.000Z';
    const products: StandardProduct[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `product-${index + 1}`,
      sku: `SKU-${index + 1}`,
      name: deterministicWideText(index * 2, 300),
      specification: deterministicWideText(index * 2 + 1, 300),
      defaultOrderPriceCents: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const mappings: ProductMappingView[] = products.map((product, index) => ({
      id: `mapping-${index + 1}`,
      sourceTitle: deterministicWideText(20_000 + index * 2, 300),
      sourceSpec: deterministicWideText(20_000 + index * 2 + 1, 300),
      sourceTitleKey: `title-${index + 1}`,
      sourceSpecKey: `spec-${index + 1}`,
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
      standardProductId: product.id,
      status: 'active',
      origin: 'manual',
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
      targetProductSku: product.sku,
      targetProductName: product.name,
      hitOrderCount: 0,
    }));

    await expect(createProductCatalogWorkbook({ products, mappings }))
      .rejects.toThrow('商品目录工作簿不能超过 10 MB');
  }, 20_000);

  it('拒绝生成压缩后虽小但解压后超过回读上限的商品目录工作簿', async () => {
    const now = '2026-08-20T00:00:00.000Z';
    const products: StandardProduct[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `product-${index + 1}`,
      sku: `SKU-${index + 1}`,
      name: escapedWideText(index),
      specification: escapedWideText(10_000 + index),
      defaultOrderPriceCents: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const mappings: ProductMappingView[] = products.map((product, index) => ({
      id: `mapping-${index + 1}`,
      sourceTitle: escapedWideText(20_000 + index),
      sourceSpec: escapedWideText(30_000 + index),
      sourceTitleKey: `title-${index + 1}`,
      sourceSpecKey: `spec-${index + 1}`,
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
      standardProductId: product.id,
      status: 'active',
      origin: 'manual',
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
      targetProductSku: product.sku,
      targetProductName: product.name,
      hitOrderCount: 0,
    }));

    await expect(createProductCatalogWorkbook({ products, mappings }))
      .rejects.toThrow('商品目录工作簿解压后内容过大');
  }, 20_000);
});

function deterministicWideText(seed: number, length: number): string {
  let state = seed + 1;
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return String.fromCharCode(0x4e00 + (state % 20_000));
  }).join('');
}

function escapedWideText(index: number): string {
  return `${'&'.repeat(294)}${String(index).padStart(6, '0')}`;
}
