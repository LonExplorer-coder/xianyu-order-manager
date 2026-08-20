import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HistoricalOrderColumnMapping } from '../src/core/historical-order-import';
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

const mapping: HistoricalOrderColumnMapping = {
  worksheet: '旧订单',
  columns: {
    platform: 1,
    sellerAccount: 2,
    orderNumber: 3,
    alipayTransactionNumber: null,
    buyerNickname: null,
    recipient: 4,
    phone: 5,
    address: 6,
    orderedAt: null,
    paidAt: null,
    productTotal: null,
    shippingFee: null,
    amount: 7,
    platformTransactionStatus: null,
    fulfillmentStatus: null,
    itemTitle: 8,
    itemSpec: null,
    unitPrice: 9,
    quantity: 10,
  },
};

afterEach(() => {
  electronBoundary.handlers.clear();
  electronBoundary.showOpenDialog.mockReset();
  electronBoundary.showSaveDialog.mockReset();
});

describe('历史订单工作簿 Electron IPC', () => {
  it('通过短期会话预览、下载错误行并确认，成功后立即使会话失效', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-historical-order-ipc-'));
    const sourcePath = join(root, '旧订单.xlsx');
    await writeFile(sourcePath, Buffer.from('synthetic-historical-workbook'));
    const errorRowsPath = join(root, '错误行');
    electronBoundary.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sourcePath] });
    electronBoundary.showSaveDialog.mockResolvedValue({ canceled: false, filePath: errorRowsPath });

    const inspection = {
      worksheets: [{ name: '旧订单', headers: ['平台', '账号', '订单号'] }],
      suggestedColumnMapping: mapping,
    };
    const preview = {
      previewToken: 'preview-token',
      orders: [],
      errorRows: [{
        rowNumber: 2,
        platform: '闲鱼',
        sellerAccount: '',
        orderNumber: '',
        errors: ['卖家账号不能为空'],
      }],
      summary: {
        createOrderCount: 0,
        updateOrderCount: 0,
        duplicateOrderCount: 0,
        errorRowCount: 1,
      },
    };
    const result = {
      createdOrderCount: 0,
      updatedOrderCount: 0,
      skippedDuplicateOrderCount: 0,
      skippedErrorRowCount: 1,
    };
    const inspectHistoricalOrderWorkbook = vi.fn().mockResolvedValue(inspection);
    const previewHistoricalOrderImport = vi.fn().mockResolvedValue(preview);
    const confirmHistoricalOrderImport = vi.fn().mockResolvedValue(result);
    const createHistoricalOrderErrorRowsWorkbook = vi.fn()
      .mockResolvedValue(Buffer.from('historical-errors-xlsx'));
    registerIpcHandlers({
      inspectHistoricalOrderWorkbook,
      previewHistoricalOrderImport,
      confirmHistoricalOrderImport,
      createHistoricalOrderErrorRowsWorkbook,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    const selected = await invoke('orders:select-historical-import') as {
      kind: 'selected';
      sessionId: string;
      fileName: string;
      inspection: typeof inspection;
    };
    expect(selected).toMatchObject({ kind: 'selected', fileName: '旧订单.xlsx', inspection });
    expect(selected.sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(inspectHistoricalOrderWorkbook).toHaveBeenCalledWith(
      Buffer.from('synthetic-historical-workbook'),
    );

    const input = { columnMapping: mapping };
    await expect(invoke('orders:preview-historical-import', selected.sessionId, input))
      .resolves.toEqual(preview);
    expect(previewHistoricalOrderImport).toHaveBeenCalledWith(
      Buffer.from('synthetic-historical-workbook'),
      input,
    );
    await expect(invoke('orders:preview-historical-import', selected.sessionId, {
      ...input,
      unexpected: true,
    })).rejects.toThrow('历史订单导入字段无效');

    const confirmation = { ...input, previewToken: preview.previewToken };
    await expect(invoke(
      'orders:download-historical-import-errors',
      selected.sessionId,
      confirmation,
    )).resolves.toEqual({
      kind: 'saved',
      fileName: '错误行.xlsx',
      filePath: `${errorRowsPath}.xlsx`,
      rowCount: 1,
    });
    expect(await readFile(`${errorRowsPath}.xlsx`, 'utf8')).toBe('historical-errors-xlsx');

    await expect(invoke(
      'orders:confirm-historical-import',
      selected.sessionId,
      confirmation,
    )).resolves.toEqual(result);
    expect(confirmHistoricalOrderImport).toHaveBeenCalledWith(
      Buffer.from('synthetic-historical-workbook'),
      '旧订单.xlsx',
      confirmation,
    );
    await expect(invoke('orders:preview-historical-import', selected.sessionId, input))
      .rejects.toThrow('历史订单导入会话已失效');
  });

  it('在读取内容前拒绝超过上限的文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xianyu-historical-order-large-ipc-'));
    const sourcePath = join(root, '超大旧订单.xlsx');
    await writeFile(sourcePath, Buffer.alloc(10 * 1024 * 1024 + 1));
    electronBoundary.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sourcePath] });
    const inspectHistoricalOrderWorkbook = vi.fn();
    registerIpcHandlers({
      inspectHistoricalOrderWorkbook,
      onRecognitionBatchesChanged: vi.fn(),
      onOrdersChanged: vi.fn(),
    } as unknown as DesktopSession);

    await expect(invoke('orders:select-historical-import'))
      .rejects.toThrow('历史订单工作簿不能超过 10 MB');
    expect(inspectHistoricalOrderWorkbook).not.toHaveBeenCalled();
  });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electronBoundary.handlers.get(channel);
  if (!handler) throw new Error(`IPC 通道未注册：${channel}`);
  return handler({ sender: {} }, ...args);
}
