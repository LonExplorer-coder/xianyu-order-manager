// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type { OrderDetails, OrderDraft, OriginalOrder } from '../src/core/contracts';
import { App } from '../src/renderer/App';

afterEach(cleanup);

const draft: OrderDraft = {
  id: 'draft-1',
  batchId: 'batch-1',
  screenshotId: 'shot-1',
  status: 'awaiting_review',
  createdAt: '2026-07-27T11:22:00.000Z',
  platform: 'xianyu',
  sellerAccount: '测试闲鱼账号',
  orderNumber: 'XY-TEST-20260727-0001',
  buyerNickname: '测试买家',
  recipient: '测试收件人',
  phone: '13800000000',
  addressOriginal: '广东省深圳市南山区测试路1号',
  amountCents: 800,
  items: [
    {
      id: 'item-1',
      position: 0,
      sourceTitle: '脱敏测试商品',
      sourceSpec: '白色',
      unitPriceCents: 800,
      quantity: 1,
      quantityInferred: true,
    },
  ],
};

const confirmedOrder: OriginalOrder = {
  id: 'order-1',
  platform: 'xianyu',
  sellerAccount: draft.sellerAccount,
  orderNumber: draft.orderNumber,
  buyerNickname: draft.buyerNickname,
  recipient: '人工修正收件人',
  phone: draft.phone,
  addressOriginal: draft.addressOriginal,
  amountCents: 800,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  lifecycleStatus: 'active',
  createdAt: '2026-07-27T11:22:00.000Z',
  updatedAt: '2026-07-27T11:24:00.000Z',
  items: [{ ...draft.items[0], quantity: 2, quantityInferred: false, subtotalCents: 1_600 }],
};

const orderDetails: OrderDetails = {
  order: confirmedOrder,
  sourceScreenshot: {
    id: draft.screenshotId,
    originalName: '脱敏测试订单.png',
    relativePath: 'screenshots/shot-1.png',
    mimeType: 'image/png',
    sha256: 'abc123',
    createdAt: draft.createdAt,
  },
  sourceSnapshot: {
    id: 'snapshot-1',
    createdAt: draft.createdAt,
    recognition: draft,
    confirmed: { ...draft, recipient: confirmedOrder.recipient },
  },
};

function createApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getBootstrapState: vi.fn().mockResolvedValue({ kind: 'needs_data_directory' }),
    retryDataDirectory: vi.fn().mockResolvedValue({ kind: 'needs_data_directory' }),
    selectDataDirectory: vi.fn().mockResolvedValue({
      kind: 'ready',
      dataDirectory: '/Users/test/闲鱼订单',
      orders: [],
    }),
    selectSourceScreenshot: vi.fn().mockResolvedValue(null),
    confirmDraft: vi.fn(),
    listOrders: vi.fn().mockResolvedValue([]),
    getOrder: vi.fn(),
    getScreenshotDataUrl: vi.fn(),
    ...overrides,
  };
}

describe('订单管理工作台', () => {
  it('首次使用选择数据目录后，立即进入以上传为主操作的空订单页', async () => {
    const user = userEvent.setup();
    const api = createApi();

    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: '选择订单数据保存位置' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '选择数据目录' }));

    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    expect(screen.getByRole('button', { name: '上传来源截图' })).toBeVisible();
    expect(screen.getByText('/Users/test/闲鱼订单')).toBeVisible();
  });

  it('上传一张来源截图后可对照来源修正识别结果，确认后以订单表为主视图', async () => {
    const user = userEvent.setup();
    const confirmDraft = vi.fn().mockResolvedValue(confirmedOrder);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([
        {
          id: confirmedOrder.id,
          orderNumber: confirmedOrder.orderNumber,
          buyerNickname: confirmedOrder.buyerNickname,
          recipient: confirmedOrder.recipient,
          amountCents: confirmedOrder.amountCents,
          itemCount: 1,
          createdAt: confirmedOrder.createdAt,
        },
      ]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传来源截图' }));

    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();
    expect(screen.getByRole('img', { name: '来源截图' })).toHaveAttribute(
      'src',
      'data:image/png;base64,c291cmNl',
    );

    await user.clear(screen.getByRole('textbox', { name: '收件人' }));
    await user.type(screen.getByRole('textbox', { name: '收件人' }), '人工修正收件人');
    await user.clear(screen.getByRole('spinbutton', { name: '数量' }));
    await user.type(screen.getByRole('spinbutton', { name: '数量' }), '2');
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(await screen.findByRole('heading', { name: '订单' })).toBeVisible();
    expect(screen.getByRole('table', { name: '原始订单' })).toHaveTextContent('人工修正收件人');
    expect(confirmDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: '人工修正收件人',
        items: [expect.objectContaining({ quantity: 2, quantityInferred: false })],
      }),
    );
  });

  it('有订单时直接展示主表，并可查看带来源截图的订单详情', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [
          {
            id: confirmedOrder.id,
            orderNumber: confirmedOrder.orderNumber,
            buyerNickname: confirmedOrder.buyerNickname,
            recipient: confirmedOrder.recipient,
            amountCents: confirmedOrder.amountCents,
            itemCount: 1,
            createdAt: confirmedOrder.createdAt,
          },
        ],
      }),
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);

    expect(await screen.findByRole('table', { name: '原始订单' })).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: `查看订单 ${confirmedOrder.orderNumber}` }),
    );

    expect(await screen.findByRole('heading', { name: '订单详情' })).toBeVisible();
    expect(screen.getByText('脱敏测试订单.png')).toBeVisible();
    expect(screen.getByRole('img', { name: '来源截图' })).toHaveAttribute(
      'src',
      'data:image/png;base64,ZGV0YWls',
    );
  });

  it('数据目录被其他实例占用时说明原因，并允许选择其他目录', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'locked',
        dataDirectory: 'D:\\闲鱼订单',
        message: '该数据目录正在被另一个窗口使用',
      }),
      selectDataDirectory: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'E:\\备用订单',
        orders: [],
      }),
    });

    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: '数据目录正在使用' })).toBeVisible();
    expect(screen.getByText('该数据目录正在被另一个窗口使用')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '选择其他目录' }));

    expect(await screen.findByText('E:\\备用订单')).toBeVisible();
  });

  it('启动异常时显示可恢复错误，重试成功后进入工作台', async () => {
    const user = userEvent.setup();
    const retryDataDirectory = vi.fn().mockResolvedValue({
      kind: 'ready',
      dataDirectory: 'D:\\闲鱼订单',
      orders: [],
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'error',
        message: '订单数据库暂时无法读取',
      }),
      retryDataDirectory,
    });

    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: '无法打开订单数据' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('订单数据库暂时无法读取');
    await user.click(screen.getByRole('button', { name: '重新尝试' }));

    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    expect(retryDataDirectory).toHaveBeenCalledOnce();
  });

  it('识别期间锁定上传动作，用户取消选图后安静返回空状态', async () => {
    const user = userEvent.setup();
    let finishSelection!: (value: OrderDraft | null) => void;
    const selection = new Promise<OrderDraft | null>((resolve) => {
      finishSelection = resolve;
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockReturnValue(selection),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传来源截图' }));

    expect(screen.getByRole('button', { name: '正在识别来源截图…' })).toBeDisabled();
    await act(async () => finishSelection(null));

    expect(await screen.findByRole('button', { name: '上传来源截图' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('来源截图识别失败时保留当前工作区，并给出可读的错误提示', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockRejectedValue(new Error('来源截图识别失败，请稍后重试')),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传来源截图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('来源截图识别失败，请稍后重试');
    expect(screen.getByRole('button', { name: '上传来源截图' })).toBeEnabled();
  });
});
