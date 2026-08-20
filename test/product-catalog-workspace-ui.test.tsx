// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type {
  ProductCatalogColumnMapping,
  ProductCatalogImportInput,
  ProductCatalogImportPreview,
} from '../src/core/product-catalog';
import type {
  ProductMappingView,
  StandardProduct,
} from '../src/core/product-standardization';
import { StandardProductsWorkspace } from '../src/renderer/StandardProductsWorkspace';

afterEach(cleanup);

const mapping: ProductCatalogColumnMapping = {
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
};

function preview(selectedRowNumber: number | null): ProductCatalogImportPreview {
  return {
    previewToken: `preview-${selectedRowNumber ?? 'none'}`,
    productRows: [
      {
        rowNumber: 2,
        sku: 'SKU-NEW',
        skuKey: 'SKU-NEW',
        name: '新商品',
        specification: '蓝色',
        action: 'create',
        errors: [],
      },
      {
        rowNumber: 3,
        sku: 'SKU-DUP',
        skuKey: 'SKU-DUP',
        name: '重复商品甲',
        specification: '甲规格',
        action: selectedRowNumber === 3 ? 'create' : 'duplicate',
        errors: selectedRowNumber === null ? ['SKU 在文件中重复，必须选择保留行'] : [],
      },
      {
        rowNumber: 4,
        sku: 'SKU-DUP',
        skuKey: 'SKU-DUP',
        name: '重复商品乙',
        specification: '乙规格',
        action: 'duplicate',
        errors: selectedRowNumber === null ? ['SKU 在文件中重复，必须选择保留行'] : [],
      },
      {
        rowNumber: 5,
        sku: 'SKU-BAD',
        skuKey: 'SKU-BAD',
        name: '',
        specification: '错误规格',
        action: 'error',
        errors: ['标准商品名不能为空'],
      },
    ],
    mappingRows: [{
      rowNumber: 2,
      sku: 'SKU-NEW',
      skuKey: 'SKU-NEW',
      sourceTitle: '新商品闲鱼专拍',
      sourceSpec: '蓝色',
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
      existingMappingId: 'mapping-1',
      action: 'update',
      errors: [],
    }],
    duplicateSkus: [{
      skuKey: 'SKU-DUP',
      rowNumbers: [3, 4],
      selectedRowNumber,
    }],
    summary: {
      createProductCount: selectedRowNumber === 3 ? 2 : 1,
      updateProductCount: 0,
      unchangedProductCount: 0,
      createMappingCount: 0,
      updateMappingCount: 1,
      unchangedMappingCount: 0,
      errorRowCount: 1,
    },
  };
}

describe('标准商品页商品目录工作簿', () => {
  it('展示列映射和逐行预览，重复 SKU 选择完成后才允许确认，并可导出', async () => {
    const user = userEvent.setup();
    const currentProduct: StandardProduct = {
      id: 'product-a',
      sku: 'SKU-A',
      name: '商品甲',
      specification: '甲规格',
      defaultOrderPriceCents: null,
      revision: 1,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    };
    const currentMapping: ProductMappingView = {
      id: 'mapping-1',
      sourceTitle: '新商品闲鱼专拍',
      sourceSpec: '蓝色',
      sourceTitleKey: '新商品闲鱼专拍',
      sourceSpecKey: '蓝色',
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
      standardProductId: currentProduct.id,
      targetProductSku: currentProduct.sku,
      targetProductName: currentProduct.name,
      status: 'active',
      origin: 'manual',
      lastUsedAt: null,
      createdAt: currentProduct.createdAt,
      updatedAt: currentProduct.updatedAt,
      hitOrderCount: 1,
    };
    const previewProductCatalogImport = vi.fn(async (
      _sessionId: string,
      input: ProductCatalogImportInput,
    ) => preview(input.duplicateSkuResolutions[0]?.selectedRowNumber ?? null));
    const confirmProductCatalogImport = vi.fn().mockResolvedValue({
      createdProductCount: 2,
      updatedProductCount: 0,
      createdMappingCount: 0,
      updatedMappingCount: 1,
      skippedErrorRowCount: 1,
    });
    const exportProductCatalog = vi.fn().mockResolvedValue({
      kind: 'saved',
      fileName: '商品目录.xlsx',
      filePath: '/tmp/商品目录.xlsx',
    });
    const api = {
      listStandardProducts: vi.fn().mockResolvedValue([currentProduct]),
      selectProductCatalogImport: vi.fn().mockResolvedValue({
        kind: 'selected',
        sessionId: 'catalog-session-1',
        fileName: '待导入.xlsx',
        inspection: {
          worksheets: [
            { name: '标准商品', headers: ['SKU', '标准商品名', '标准规格'] },
            { name: '商品映射', headers: ['SKU', '原始商品标题', '原始规格', '适用范围', '平台', '卖家账号'] },
          ],
          suggestedColumnMapping: mapping,
        },
      }),
      previewProductCatalogImport,
      confirmProductCatalogImport,
      exportProductCatalog,
      listStandardProductPriceEvents: vi.fn().mockResolvedValue([]),
      getProductMappingStats: vi.fn().mockResolvedValue({
        activeMappingCount: 1,
        linkedOrderCount: 0,
        linkedItemCount: 0,
        linkedTotalQuantity: 0,
      }),
      listProductMappings: vi.fn()
        .mockResolvedValueOnce([currentMapping])
        .mockResolvedValue([]),
      listProductMappingEvents: vi.fn().mockResolvedValue([]),
      previewProductMappingHistoryCandidates: vi.fn().mockResolvedValue({
        mapping: currentMapping,
        targetProduct: currentProduct,
        items: [{
          itemId: 'item-1',
          orderId: 'order-1',
          orderNumber: 'ORDER-1',
          systemOrderNumber: 'XY-1',
          orderRevision: 1,
          position: 0,
          quantity: 1,
          beforeStandardProductId: 'product-b',
          beforeStandardProductSku: 'SKU-B',
          standardizationSource: 'manual',
          shippedOrDelivered: false,
          hasAftersales: false,
        }],
        orderCount: 1,
        itemCount: 1,
        totalQuantity: 1,
        shippedOrderCount: 0,
        aftersalesOrderCount: 0,
      }),
    } as unknown as DesktopApi;
    render(<StandardProductsWorkspace api={api} onOpenLinkedOrderItems={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '编辑标准商品 SKU-A' }));
    await waitFor(() => expect(api.listProductMappings).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole('button', {
      name: '查看映射 新商品闲鱼专拍 的历史候选',
    }));
    expect(await screen.findByRole('region', { name: '历史候选批量更正' })).toBeVisible();

    await user.click(await screen.findByRole('button', { name: '导入商品目录' }));
    const section = await screen.findByRole('region', { name: '商品目录导入预览' });
    expect(within(section).getByText('待导入.xlsx')).toBeVisible();
    expect(within(section).getByRole('combobox', { name: '标准商品工作表' }))
      .toHaveValue('标准商品');
    expect(within(section).getByRole('combobox', { name: 'SKU 列' })).toHaveValue('1');
    expect(within(section).getByText(/新增标准商品 1/u)).toBeVisible();
    expect(within(section).getByText(/错误行 1/u)).toBeVisible();
    expect(within(section).getByText('标准商品名不能为空')).toBeVisible();
    expect(within(section).getByRole('button', { name: '确认导入有效行' })).toBeDisabled();

    await user.click(within(section).getByRole('radio', { name: /保留第 3 行/u }));
    await waitFor(() => expect(previewProductCatalogImport).toHaveBeenLastCalledWith(
      'catalog-session-1',
      {
        columnMapping: mapping,
        duplicateSkuResolutions: [{ skuKey: 'SKU-DUP', selectedRowNumber: 3 }],
      },
    ));
    expect(within(section).getByText(/更新商品映射 1/u)).toBeVisible();
    expect(within(section).getByText('候选更新')).toBeVisible();
    expect(within(section).getByRole('button', { name: '确认导入有效行' })).toBeDisabled();
    await user.type(within(section).getByRole('textbox', { name: '商品映射更新原因' }), '修正别名归属');
    expect(within(section).getByRole('button', { name: '确认导入有效行' })).toBeEnabled();
    await user.click(within(section).getByRole('button', { name: '确认导入有效行' }));
    await waitFor(() => expect(confirmProductCatalogImport).toHaveBeenCalledWith(
      'catalog-session-1',
      {
        columnMapping: mapping,
        duplicateSkuResolutions: [{ skuKey: 'SKU-DUP', selectedRowNumber: 3 }],
        previewToken: 'preview-3',
        mappingUpdateReason: '修正别名归属',
      },
    ));
    expect(await screen.findByText(/已新增 2 个标准商品/u)).toBeVisible();
    await waitFor(() => expect(api.listProductMappings).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: '历史候选批量更正' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '导出商品目录' }));
    expect(exportProductCatalog).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/商品目录.xlsx/u)).toBeVisible();
  });
});
