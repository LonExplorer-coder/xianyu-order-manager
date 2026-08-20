import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProductCatalogColumnMapping } from '../src/core/product-catalog';
import type { DesktopSession } from '../src/main/desktop-session';

const electronBoundary = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    on: vi.fn(),
    quit: vi.fn(),
  },
  BrowserWindow: class MockBrowserWindow {
    public static getAllWindows(): unknown[] { return []; }
    public static fromWebContents(): unknown { return { isDestroyed: () => false }; }
  },
  dialog: {
    showOpenDialog: electronBoundary.showOpenDialog,
    showSaveDialog: electronBoundary.showSaveDialog,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronBoundary.handlers.set(channel, handler);
    },
  },
}));

import { registerIpcHandlers } from '../src/main/electron-main';

const mapping: ProductCatalogColumnMapping = {
  productWorksheet: '标准商品',
  productColumns: { sku: 1, name: 2, specification: 3 },
  mappingWorksheet: null,
  mappingColumns: {
    sku: 1,
    sourceTitle: 2,
    sourceSpec: null,
    scope: null,
    platform: null,
    sellerAccount: null,
  },
};

afterEach(() => {
  electronBoundary.handlers.clear();
  electronBoundary.showOpenDialog.mockReset();
  electronBoundary.showSaveDialog.mockReset();
});

describe('商品目录工作簿 Electron IPC', () => {
  it('选择文件后只用短期会话预览和确认，导出时补全 xlsx 扩展名', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-product-catalog-ipc-'));
    const sourcePath = join(root, '待导入.xlsx');
    await writeFile(sourcePath, Buffer.from('synthetic-catalog-workbook'));
    const destinationWithoutExtension = join(root, '商品目录导出');
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [sourcePath],
    });
    electronBoundary.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: destinationWithoutExtension,
    });

    const inspection = {
      worksheets: [{ name: '标准商品', headers: ['SKU', '标准商品名', '标准规格'] }],
      suggestedColumnMapping: mapping,
    };
    const preview = {
      previewToken: 'preview-token',
      productRows: [],
      mappingRows: [],
      duplicateSkus: [],
      summary: {
        createProductCount: 0,
        updateProductCount: 0,
        unchangedProductCount: 0,
        createMappingCount: 0,
        updateMappingCount: 0,
        unchangedMappingCount: 0,
        errorRowCount: 0,
      },
    };
    const result = {
      createdProductCount: 0,
      updatedProductCount: 0,
      createdMappingCount: 0,
      updatedMappingCount: 0,
      skippedErrorRowCount: 0,
    };
    const inspectProductCatalogWorkbook = vi.fn().mockResolvedValue(inspection);
    const previewProductCatalogImport = vi.fn().mockResolvedValue(preview);
    const confirmProductCatalogImport = vi.fn().mockResolvedValue(result);
    const createProductCatalogWorkbook = vi.fn().mockResolvedValue(Buffer.from('xlsx-output'));
    registerIpcHandlers({
      inspectProductCatalogWorkbook,
      previewProductCatalogImport,
      confirmProductCatalogImport,
      createProductCatalogWorkbook,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    const selected = await invoke('products:select-catalog-import') as {
      kind: 'selected';
      sessionId: string;
      fileName: string;
      inspection: typeof inspection;
    };
    expect(selected).toMatchObject({
      kind: 'selected',
      fileName: '待导入.xlsx',
      inspection,
    });
    expect(selected.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(inspectProductCatalogWorkbook).toHaveBeenCalledWith(
      Buffer.from('synthetic-catalog-workbook'),
    );

    const input = { columnMapping: mapping, duplicateSkuResolutions: [] };
    await expect(invoke('products:preview-catalog-import', selected.sessionId, input))
      .resolves.toEqual(preview);
    expect(previewProductCatalogImport).toHaveBeenCalledWith(
      Buffer.from('synthetic-catalog-workbook'),
      input,
    );
    await expect(invoke('products:preview-catalog-import', selected.sessionId, {
      ...input,
      unexpected: true,
    })).rejects.toThrow('商品目录导入字段无效');

    const confirmation = {
      ...input,
      previewToken: preview.previewToken,
      mappingUpdateReason: '',
    };
    await expect(invoke('products:confirm-catalog-import', selected.sessionId, confirmation))
      .resolves.toEqual(result);
    await expect(invoke('products:preview-catalog-import', selected.sessionId, input))
      .rejects.toThrow('商品目录导入会话已失效');

    await expect(invoke('products:export-catalog')).resolves.toEqual({
      kind: 'saved',
      fileName: '商品目录导出.xlsx',
      filePath: `${destinationWithoutExtension}.xlsx`,
    });
    expect(await readFile(`${destinationWithoutExtension}.xlsx`, 'utf8')).toBe('xlsx-output');
  });

  it('在读取内容前拒绝超过上限的文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-product-catalog-large-ipc-'));
    const sourcePath = join(root, '超大商品目录.xlsx');
    await writeFile(sourcePath, Buffer.alloc(10 * 1024 * 1024 + 1));
    electronBoundary.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [sourcePath],
    });
    const inspectProductCatalogWorkbook = vi.fn();
    registerIpcHandlers({
      inspectProductCatalogWorkbook,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    await expect(invoke('products:select-catalog-import'))
      .rejects.toThrow('商品目录工作簿不能超过 10 MB');
    expect(inspectProductCatalogWorkbook).not.toHaveBeenCalled();
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}
