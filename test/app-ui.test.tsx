// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type {
  OrderDetails,
  OrderDraft,
  OriginalOrder,
  RecognitionBatchItemStatus,
  RecognitionBatchView,
} from '../src/core/contracts';
import { summarizeRecognitionBatchItems } from '../src/core/recognition-batches';
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
  alipayTransactionNumber: 'ALI-SYNTH-UI-0001',
  buyerNickname: '测试买家',
  recipient: '测试收件人',
  phone: '13800000000',
  phoneNormalized: '13800000000',
  addressOriginal: '广东省深圳市南山区测试路1号',
  addressNormalized: '广东省深圳市南山区测试路1号',
  province: '广东省',
  city: '深圳市',
  district: '南山区',
  orderedAtOriginal: '2026-07-27 11:21:46',
  orderedAtNormalized: '2026-07-27T11:21:46+08:00',
  paidAtOriginal: '2026-07-27 11:21:54',
  paidAtNormalized: '2026-07-27T11:21:54+08:00',
  productTotalCents: 800,
  shippingFeeCents: 0,
  amountCents: 800,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
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
  alipayTransactionNumber: draft.alipayTransactionNumber,
  buyerNickname: draft.buyerNickname,
  recipient: '人工修正收件人',
  phone: draft.phone,
  phoneNormalized: draft.phoneNormalized,
  addressOriginal: draft.addressOriginal,
  addressNormalized: draft.addressNormalized,
  province: draft.province,
  city: draft.city,
  district: draft.district,
  orderedAtOriginal: draft.orderedAtOriginal,
  orderedAtNormalized: draft.orderedAtNormalized,
  paidAtOriginal: draft.paidAtOriginal,
  paidAtNormalized: draft.paidAtNormalized,
  productTotalCents: draft.productTotalCents,
  shippingFeeCents: draft.shippingFeeCents,
  amountCents: 800,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  lifecycleStatus: 'active',
  createdAt: '2026-07-27T11:22:00.000Z',
  updatedAt: '2026-07-27T11:24:00.000Z',
  items: [{
    ...draft.items[0],
    unitPriceCents: 800,
    quantity: 2,
    quantityInferred: false,
    subtotalCents: 1_600,
  }],
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

type DesktopApiTestOverrides = Partial<DesktopApi> & {
  selectSourceScreenshot?: () => Promise<OrderDraft | null>;
};

function createApi(overrides: DesktopApiTestOverrides = {}): DesktopApi {
  const {
    selectSourceScreenshot = vi.fn().mockResolvedValue(null),
    ...desktopApiOverrides
  } = overrides;
  const selectOneSourceScreenshot = selectSourceScreenshot
    ?? vi.fn().mockResolvedValue(null);
  let selectedDraft: OrderDraft | null = null;
  return {
    getBootstrapState: vi.fn().mockResolvedValue({ kind: 'needs_data_directory' }),
    retryDataDirectory: vi.fn().mockResolvedValue({ kind: 'needs_data_directory' }),
    selectDataDirectory: vi.fn().mockResolvedValue({
      kind: 'ready',
      dataDirectory: '/Users/test/闲鱼订单',
      orders: [],
    }),
    selectSourceScreenshots: vi.fn(async () => {
      selectedDraft = await selectOneSourceScreenshot();
      return selectedDraft ? batchForDraft(selectedDraft) : null;
    }),
    listRecognitionBatches: vi.fn().mockResolvedValue([]),
    retryRecognitionItem: vi.fn().mockResolvedValue(undefined),
    createManualDraft: vi.fn(),
    getDraft: vi.fn(async () => {
      if (!selectedDraft) throw new Error('未找到订单草稿');
      return selectedDraft;
    }),
    onRecognitionBatchesChanged: vi.fn(() => () => undefined),
    cancelDraft: vi.fn().mockResolvedValue(undefined),
    confirmDraft: vi.fn(),
    listOrders: vi.fn().mockResolvedValue([]),
    getOrder: vi.fn(),
    getScreenshotDataUrl: vi.fn(),
    getOcrSettings: vi.fn().mockResolvedValue({
      workspaceId: '',
      region: 'cn-beijing',
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr',
      apiKeyConfigured: false,
      apiKeyMask: '',
      credentialStore: '测试系统凭据库',
    }),
    saveOcrSettings: vi.fn(),
    removeOcrApiKey: vi.fn(),
    testOcrConnection: vi.fn(),
    ...desktopApiOverrides,
  };
}

function batchForDraft(value: OrderDraft): RecognitionBatchView {
  const status: RecognitionBatchItemStatus = value.status === 'confirmed'
    ? 'imported'
    : value.status === 'cancelled'
      ? 'cancelled'
      : 'awaiting_confirmation';
  return recognitionBatchView(value.batchId, [{
    id: `batch-item-${value.id}`,
    batchId: value.batchId,
    sourceName: '脱敏测试订单.png',
    status,
    draftId: value.id,
  }]);
}

function recognitionBatchView(
  id: string,
  items: RecognitionBatchView['items'],
): RecognitionBatchView {
  return {
    id,
    createdAt: '2026-07-30T06:32:00.000Z',
    ...summarizeRecognitionBatchItems(items),
    items,
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
    expect(screen.getByRole('button', { name: '上传订单截图' })).toBeVisible();
    expect(screen.getByText(
      '截图会发送至您配置的阿里云百炼，原图仍保存在本机。每张截图通常调用 1 次 OCR；关键字段缺失或冲突时最多自动复核 1 次，可能产生第 2 次调用与费用。复核失败仍保留首次结果供人工校对。',
    )).toBeVisible();
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
          platformTransactionStatus: confirmedOrder.platformTransactionStatus,
          fulfillmentStatus: confirmedOrder.fulfillmentStatus,
          createdAt: confirmedOrder.createdAt,
        },
      ]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

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

  it('可取消本次校对并回到上传页，且不会确认订单', async () => {
    const user = userEvent.setup();
    const cancelDraft = vi.fn().mockResolvedValue(undefined);
    const confirmDraft = vi.fn();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      cancelDraft,
      confirmDraft,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '取消本次校对' }));

    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '校对识别结果' })).not.toBeInTheDocument();
    expect(cancelDraft).toHaveBeenCalledWith(draft.id);
    expect(confirmDraft).not.toHaveBeenCalled();
  });

  it('收件人与买家昵称疑似错位时给出明确校对提示', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue({
        ...draft,
        buyerNickname: '陈测试',
        recipient: '陈测试',
      }),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByText(
      'OCR 疑似把收件人同时填入了买家昵称，请对照截图核对',
    )).toBeVisible();
    await user.clear(screen.getByRole('textbox', { name: '买家昵称' }));
    await user.type(screen.getByRole('textbox', { name: '买家昵称' }), '测***户');
    expect(screen.queryByText(
      'OCR 疑似把收件人同时填入了买家昵称，请对照截图核对',
    )).not.toBeInTheDocument();
  });

  it('取消校对失败时保留截图与编辑内容，并允许重试', async () => {
    const user = userEvent.setup();
    const cancelDraft = vi.fn().mockRejectedValue(new Error('暂时无法取消校对'));
    const confirmDraft = vi.fn();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      cancelDraft,
      confirmDraft,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    const recipient = await screen.findByRole('textbox', { name: '收件人' });
    await user.clear(recipient);
    await user.type(recipient, '人工校对中的收件人');
    await user.click(screen.getByRole('button', { name: '取消本次校对' }));

    expect(await screen.findByText('暂时无法取消校对')).toBeVisible();
    expect(screen.getByRole('heading', { name: '校对识别结果' })).toBeVisible();
    expect(screen.getByRole('img', { name: '来源截图' })).toBeVisible();
    expect(recipient).toHaveValue('人工校对中的收件人');
    expect(screen.getByRole('button', { name: '取消本次校对' })).toBeEnabled();
    expect(confirmDraft).not.toHaveBeenCalled();
  });

  it('校对时可修正完整交易、地址、时间、金额与状态字段', async () => {
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
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByRole('textbox', { name: '平台' })).toHaveValue('闲鱼');
    expect(screen.getByRole('textbox', { name: '平台' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '卖家账号' })).toBeRequired();

    await user.clear(screen.getByRole('textbox', { name: '支付宝交易号' }));
    await user.type(screen.getByRole('textbox', { name: '支付宝交易号' }), 'ALI-CORRECTED-001');
    await user.clear(screen.getByRole('textbox', { name: '完整收货地址' }));
    await user.type(screen.getByRole('textbox', { name: '完整收货地址' }), '广东省 深圳市 南山区 科技路2号');
    await user.clear(screen.getByRole('textbox', { name: '下单时间（原文）' }));
    await user.type(screen.getByRole('textbox', { name: '下单时间（原文）' }), '2026-07-27 11:22:00');
    await user.clear(screen.getByRole('textbox', { name: '付款时间（原文）' }));
    await user.type(screen.getByRole('textbox', { name: '付款时间（原文）' }), '2026-07-27 11:23:00');

    await user.clear(screen.getByRole('spinbutton', { name: '商品总价' }));
    await user.type(screen.getByRole('spinbutton', { name: '商品总价' }), '18.00');
    await user.clear(screen.getByRole('spinbutton', { name: '运费' }));
    await user.type(screen.getByRole('spinbutton', { name: '运费' }), '2.00');
    await user.clear(screen.getByRole('spinbutton', { name: '成交金额' }));
    await user.type(screen.getByRole('spinbutton', { name: '成交金额' }), '20.00');
    await user.selectOptions(screen.getByRole('combobox', { name: '平台交易状态' }), 'refunded');
    await user.selectOptions(screen.getByRole('combobox', { name: '履约状态' }), 'shipped');
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({
      alipayTransactionNumber: 'ALI-CORRECTED-001',
      addressNormalized: '广东省深圳市南山区科技路2号',
      orderedAtNormalized: '2026-07-27T11:22:00+08:00',
      paidAtNormalized: '2026-07-27T11:23:00+08:00',
      productTotalCents: 1_800,
      shippingFeeCents: 200,
      amountCents: 2_000,
      platformTransactionStatus: 'refunded',
      fulfillmentStatus: 'shipped',
    }));
  });

  it('金额按十进制精确保存为分，并拒绝三位小数与指数格式', async () => {
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
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    fireEvent.change(screen.getByRole('spinbutton', { name: '商品总价' }), {
      target: { value: '1.005' },
    });
    expect(screen.getByText('金额仅支持普通数字，最多两位小数')).toBeVisible();
    expect(screen.getByRole('button', { name: '确认并入库' })).toBeDisabled();

    fireEvent.change(screen.getByRole('spinbutton', { name: '商品总价' }), {
      target: { value: '1.05' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '运费' }), {
      target: { value: '1e2' },
    });
    expect(screen.getByText('金额仅支持普通数字，最多两位小数')).toBeVisible();
    expect(screen.getByRole('button', { name: '确认并入库' })).toBeDisabled();

    fireEvent.change(screen.getByRole('spinbutton', { name: '运费' }), {
      target: { value: '0.10' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '成交金额' }), {
      target: { value: '1.15' },
    });
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({
      productTotalCents: 105,
      shippingFeeCents: 10,
      amountCents: 115,
    }));
  });

  it('成交金额缺失时保留空白并阻止确认入库', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue({ ...draft, amountCents: null }),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    expect(screen.getByRole('spinbutton', { name: '成交金额' })).toHaveValue(null);
    expect(screen.getByRole('button', { name: '确认并入库' })).toBeDisabled();

    fireEvent.change(screen.getByRole('spinbutton', { name: '成交金额' }), {
      target: { value: '0.00' },
    });
    expect(screen.getByRole('button', { name: '确认并入库' })).toBeEnabled();
  });

  it('数量缺失时显示推定标记，且单个商品也可删除后重新添加', async () => {
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
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByText('截图未显示数量，已按 1 件处理')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '删除商品 1' }));

    expect(screen.getByRole('heading', { name: '商品明细 · 0' })).toBeVisible();
    expect(screen.getByText('暂无商品明细')).toBeVisible();
    expect(screen.getByRole('button', { name: '确认并入库' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '添加商品' }));
    expect(screen.getByRole('heading', { name: '商品明细 · 1' })).toBeVisible();
    expect(screen.queryByText('截图未显示数量，已按 1 件处理')).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: '数量' })).toHaveValue(1);

    await user.type(screen.getByRole('textbox', { name: '商品标题' }), '人工补录商品');
    await user.type(screen.getByRole('spinbutton', { name: '单价' }), '1.00');
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({
        sourceTitle: '人工补录商品',
        unitPriceCents: 100,
        quantity: 1,
        quantityInferred: false,
      })],
    }));
  });

  it('商品数量必须是大于等于 1 的整数', async () => {
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
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    fireEvent.change(screen.getByRole('spinbutton', { name: '数量' }), {
      target: { value: '1.5' },
    });

    expect(screen.getByRole('button', { name: '确认并入库' })).toBeDisabled();
    expect(confirmDraft).not.toHaveBeenCalled();
  });

  it('修正手机号和原始地址时同步只读的规范化值', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    fireEvent.change(screen.getByRole('textbox', { name: '手机号' }), {
      target: { value: '+86 139-0000-0002' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '完整收货地址' }), {
      target: { value: '测试省，测试市 示例区 安全路 2号' },
    });

    expect(screen.getByRole('textbox', { name: '规范化手机号' }))
      .toHaveValue('8613900000002');
    expect(screen.getByRole('textbox', { name: '规范化手机号' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '规范化地址' }))
      .toHaveValue('测试省测试市示例区安全路2号');
    expect(screen.getByRole('textbox', { name: '规范化地址' })).toHaveAttribute('readonly');
  });

  it('修正交易时间原文时同步只读的规范化时间', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    fireEvent.change(screen.getByRole('textbox', { name: '下单时间（原文）' }), {
      target: { value: '2026年7月30日 08:09:10' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '付款时间（原文）' }), {
      target: { value: '2026/07/30 08:09:18' },
    });

    expect(screen.getByRole('textbox', { name: '下单时间（规范化）' }))
      .toHaveValue('2026-07-30T08:09:10+08:00');
    expect(screen.getByRole('textbox', { name: '下单时间（规范化）' }))
      .toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '付款时间（规范化）' }))
      .toHaveValue('2026-07-30T08:09:18+08:00');
    expect(screen.getByRole('textbox', { name: '付款时间（规范化）' }))
      .toHaveAttribute('readonly');
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
            platformTransactionStatus: confirmedOrder.platformTransactionStatus,
            fulfillmentStatus: confirmedOrder.fulfillmentStatus,
            createdAt: confirmedOrder.createdAt,
          },
        ],
      }),
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);

    expect(await screen.findByRole('table', { name: '原始订单' })).toBeVisible();
    expect(screen.getByText(
      '截图会发送至您配置的阿里云百炼，原图仍保存在本机。每张截图通常调用 1 次 OCR；关键字段缺失或冲突时最多自动复核 1 次，可能产生第 2 次调用与费用。复核失败仍保留首次结果供人工校对。',
    )).toBeVisible();
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

  it('订单详情展示完整当前值与真实状态，不暴露 OCR 原始响应', async () => {
    const user = userEvent.setup();
    const detailedOrder: OriginalOrder = {
      ...confirmedOrder,
      alipayTransactionNumber: 'ALI-DETAIL-20260727',
      addressNormalized: '广东省深圳市南山区科技路2号',
      orderedAtOriginal: '2026-07-27 11:21:46',
      orderedAtNormalized: '2026-07-27T11:21:46+08:00',
      paidAtOriginal: '2026-07-27 11:21:54',
      paidAtNormalized: '2026-07-27T11:21:54+08:00',
      productTotalCents: 1_800,
      shippingFeeCents: 200,
      amountCents: 2_000,
      platformTransactionStatus: 'refunded',
      fulfillmentStatus: 'shipped',
    };
    const detailsWithEvidence = {
      ...orderDetails,
      order: detailedOrder,
      sourceSnapshot: {
        ...orderDetails.sourceSnapshot,
        rawResponse: 'SECRET_RAW_OCR_RESPONSE',
      },
    } as OrderDetails;
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [{
          id: detailedOrder.id,
          orderNumber: detailedOrder.orderNumber,
          buyerNickname: detailedOrder.buyerNickname,
          recipient: detailedOrder.recipient,
          amountCents: detailedOrder.amountCents,
          itemCount: detailedOrder.items.length,
          platformTransactionStatus: detailedOrder.platformTransactionStatus,
          fulfillmentStatus: detailedOrder.fulfillmentStatus,
          createdAt: detailedOrder.createdAt,
        }],
      }),
      getOrder: vi.fn().mockResolvedValue(detailsWithEvidence),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);
    const orderTable = await screen.findByRole('table', { name: '原始订单' });
    expect(orderTable).toHaveTextContent('已退款');
    expect(orderTable).toHaveTextContent('已发货');
    await user.click(await screen.findByRole('button', { name: `查看订单 ${detailedOrder.orderNumber}` }));

    const detailPage = (await screen.findByRole('heading', { name: '订单详情' })).closest('section');
    expect(detailPage).not.toBeNull();
    expect(detailPage).toHaveTextContent('闲鱼');
    expect(detailPage).toHaveTextContent('ALI-DETAIL-20260727');
    expect(detailPage).toHaveTextContent('已退款 · 已发货');
    expect(detailPage).toHaveTextContent('商品总价¥18.00');
    expect(detailPage).toHaveTextContent('运费¥2.00');
    expect(detailPage).toHaveTextContent('成交金额¥20.00');
    expect(detailPage).toHaveTextContent('2026-07-27 11:21:46');
    expect(detailPage).toHaveTextContent('2026-07-27T11:21:54+08:00');
    expect(detailPage).toHaveTextContent('广东省深圳市南山区科技路2号');
    expect(detailPage).not.toHaveTextContent('SECRET_RAW_OCR_RESPONSE');
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
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(screen.getByRole('button', { name: '正在添加来源截图…' })).toBeDisabled();
    await act(async () => finishSelection(null));

    expect(await screen.findByRole('button', { name: '上传订单截图' })).toBeEnabled();
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
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('来源截图识别失败，请稍后重试');
    expect(screen.getByRole('button', { name: '上传订单截图' })).toBeEnabled();
  });

  it('批次页实时汇总整批进度，并逐张展示全部处理状态和原因', async () => {
    const user = userEvent.setup();
    const statuses: RecognitionBatchItemStatus[] = [
      'waiting_recognition',
      'recognizing',
      'validating',
      'awaiting_confirmation',
      'imported',
      'waiting_retry',
      'failed',
      'duplicate_skipped',
      'cancelled',
    ];
    const batch = recognitionBatchView('batch-all-statuses', statuses.map((status, index) => ({
      id: `batch-item-${index}`,
      batchId: 'batch-all-statuses',
      sourceName: `订单截图-${index + 1}.png`,
      status,
      draftId: status === 'awaiting_confirmation' ? draft.id : undefined,
      errorMessage: status === 'failed' ? '截图内容不完整' : undefined,
    })));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByRole('heading', { name: '识别批次' })).toBeVisible();
    expect(screen.getByRole('progressbar', { name: '批次识别进度' })).toHaveAttribute('value', '5');
    expect(screen.getByRole('status')).toHaveTextContent('5/9');
    expect(screen.getByLabelText('批次结果统计')).toHaveTextContent('4处理中');
    const table = screen.getByRole('table', { name: '批次截图状态' });
    for (const label of [
      '等待识别',
      '识别中',
      '校验中',
      '待确认',
      '已入库',
      '等待重试',
      '失败',
      '重复跳过',
      '已取消',
    ]) {
      expect(within(table).getByText(label)).toBeVisible();
    }
    expect(within(table).getByText('截图内容不完整')).toBeVisible();
    expect(within(table).getByText('已保留原图，将按受控退避自动重试')).toBeVisible();
    expect(screen.getByText(/断网或重启不会丢失未完成任务/)).toBeVisible();
  });

  it('离开批次页后继续接收后台进度，并在订单首页显示最近结果', async () => {
    const user = userEvent.setup();
    let publish!: (batches: RecognitionBatchView[]) => void;
    const running = recognitionBatchView('batch-background', [{
      id: 'batch-item-background',
      batchId: 'batch-background',
      sourceName: '后台订单.png',
      status: 'recognizing',
    }]);
    const completed = recognitionBatchView('batch-background', [{
      id: 'batch-item-background',
      batchId: 'batch-background',
      sourceName: '后台订单.png',
      status: 'awaiting_confirmation',
      draftId: draft.id,
    }]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(running),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      onRecognitionBatchesChanged: vi.fn((listener) => {
        publish = listener;
        return () => undefined;
      }),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    expect(await screen.findByRole('heading', { name: '识别批次' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '订单' }));
    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    await act(async () => publish([completed]));

    expect(await screen.findByText('1/1 张已处理')).toBeVisible();
    expect(screen.getByRole('region', { name: '最近识别批次' })).toHaveTextContent('待确认');
    await user.click(screen.getByRole('button', { name: '查看批次' }));
    expect(await screen.findByRole('table', { name: '批次截图状态' })).toHaveTextContent('待确认');
  });

  it('较晚返回的旧批次查询不会覆盖主进程刚推送的新进度', async () => {
    let publish!: (batches: RecognitionBatchView[]) => void;
    let finishInitialQuery!: (batches: RecognitionBatchView[]) => void;
    const initialQuery = new Promise<RecognitionBatchView[]>((resolve) => {
      finishInitialQuery = resolve;
    });
    const completed = recognitionBatchView('batch-newer-event', [{
      id: 'batch-item-newer-event',
      batchId: 'batch-newer-event',
      sourceName: '已完成订单.png',
      status: 'awaiting_confirmation',
      draftId: draft.id,
    }]);
    const onRecognitionBatchesChanged = vi.fn((listener) => {
      publish = listener;
      return () => undefined;
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockReturnValue(initialQuery),
      onRecognitionBatchesChanged,
    });

    render(<App api={api} />);
    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    await waitFor(() => expect(onRecognitionBatchesChanged).toHaveBeenCalledOnce());
    await act(async () => publish([completed]));
    expect(await screen.findByText('1/1 张已处理')).toBeVisible();

    await act(async () => finishInitialQuery([]));
    expect(screen.getByText('1/1 张已处理')).toBeVisible();
  });

  it('选图调用的初始快照不会覆盖期间已经推送的完成状态', async () => {
    const user = userEvent.setup();
    let publish!: (batches: RecognitionBatchView[]) => void;
    let finishSelection!: (batch: RecognitionBatchView) => void;
    const initial = recognitionBatchView('batch-selection-race', [{
      id: 'batch-item-selection-race',
      batchId: 'batch-selection-race',
      sourceName: '快速订单.png',
      status: 'waiting_recognition',
    }]);
    const completed = recognitionBatchView('batch-selection-race', [{
      id: 'batch-item-selection-race',
      batchId: 'batch-selection-race',
      sourceName: '快速订单.png',
      status: 'duplicate_skipped',
    }]);
    const selection = new Promise<RecognitionBatchView>((resolve) => {
      finishSelection = resolve;
    });
    const onRecognitionBatchesChanged = vi.fn((listener) => {
      publish = listener;
      return () => undefined;
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockReturnValue(selection),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      onRecognitionBatchesChanged,
    });

    render(<App api={api} />);
    await waitFor(() => expect(onRecognitionBatchesChanged).toHaveBeenCalledOnce());
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    await act(async () => {
      publish([completed]);
      finishSelection(initial);
    });

    const table = await screen.findByRole('table', { name: '批次截图状态' });
    expect(within(table).getByText('重复跳过')).toBeVisible();
    expect(within(table).queryByText('等待识别')).not.toBeInTheDocument();
  });

  it('批次失败项可单独立即重试，并且只提交被点击的批次项', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-manual-retry', [
      {
        id: 'batch-item-stays-failed',
        batchId: 'batch-manual-retry',
        sourceName: '保持失败.png',
        status: 'failed',
        errorMessage: '截图内容不完整',
      },
      {
        id: 'batch-item-retry-target',
        batchId: 'batch-manual-retry',
        sourceName: '只重试这一张.png',
        status: 'failed',
        errorMessage: '服务暂时不可用',
      },
    ]);
    let publish!: (batches: RecognitionBatchView[]) => void;
    const retryingBatch = recognitionBatchView('batch-manual-retry', [
      batch.items[0],
      { ...batch.items[1], status: 'waiting_recognition', errorMessage: undefined },
    ]);
    const retryRecognitionItem = vi.fn(async () => {
      publish([retryingBatch]);
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      retryRecognitionItem,
      onRecognitionBatchesChanged: vi.fn((listener) => {
        publish = listener;
        return () => undefined;
      }),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    const table = await screen.findByRole('table', { name: '批次截图状态' });
    const targetRow = within(table).getByText('只重试这一张.png').closest('tr');
    if (!targetRow) throw new Error('未找到目标批次项');

    await user.click(within(targetRow).getByRole('button', { name: '立即重试' }));

    expect(retryRecognitionItem).toHaveBeenCalledOnce();
    expect(retryRecognitionItem).toHaveBeenCalledWith(
      'batch-manual-retry',
      'batch-item-retry-target',
    );
    expect(within(table).getByText('保持失败.png').closest('tr')).toHaveTextContent('失败');
    expect(targetRow).toHaveTextContent('等待识别');
  });

  it('批次失败项可用原截图进入人工录入校对页', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-manual-entry', [{
      id: 'batch-item-manual-entry',
      batchId: 'batch-manual-entry',
      sourceName: '人工录入来源.png',
      status: 'failed',
      errorMessage: '图片版式暂不支持',
    }]);
    const manualDraft: OrderDraft = {
      ...draft,
      id: 'draft-manual-entry',
      batchId: 'batch-manual-entry',
      screenshotId: 'shot-manual-entry',
      orderNumber: '',
      recipient: '',
      phone: '',
      phoneNormalized: '',
      amountCents: null,
      items: [{
        ...draft.items[0],
        id: 'manual-entry-item',
        sourceTitle: '',
        unitPriceCents: null,
      }],
    };
    const createManualDraft = vi.fn().mockResolvedValue(manualDraft);
    const getScreenshotDataUrl = vi.fn().mockResolvedValue(
      'data:image/png;base64,bWFudWFsLWVudHJ5',
    );
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      createManualDraft,
      getScreenshotDataUrl,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '人工录入' }));

    expect(createManualDraft).toHaveBeenCalledWith(
      'batch-manual-entry',
      'batch-item-manual-entry',
    );
    expect(getScreenshotDataUrl).toHaveBeenCalledWith('shot-manual-entry');
    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();
    expect(screen.getByAltText('来源截图')).toHaveAttribute(
      'src',
      'data:image/png;base64,bWFudWFsLWVudHJ5',
    );
    expect(screen.getByLabelText('成交金额')).toHaveValue(null);
  });

  it('从批次进入单张校对，确认后返回原批次并更新为已入库', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-review-return', [
      {
        id: 'batch-item-review',
        batchId: 'batch-review-return',
        sourceName: '待校对订单.png',
        status: 'awaiting_confirmation',
        draftId: draft.id,
      },
      {
        id: 'batch-item-failed',
        batchId: 'batch-review-return',
        sourceName: '失败订单.png',
        status: 'failed',
        errorMessage: '截图不完整',
      },
    ]);
    const confirmDraft = vi.fn().mockResolvedValue(confirmedOrder);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      getDraft: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));
    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '确认并入库' }));
    const table = await screen.findByRole('table', { name: '批次截图状态' });
    expect(within(table).getByText('待校对订单.png').closest('tr')).toHaveTextContent('已入库');
    expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({ id: draft.id }));
  });

  it('选择超过 50 张时在首页明确提示，且不会创建批次视图', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockRejectedValue(
        new Error('一次最多选择 50 张，当前选择了 51 张，请重新选择'),
      ),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '一次最多选择 50 张，当前选择了 51 张，请重新选择',
    );
    expect(screen.getByRole('heading', { name: '还没有订单' })).toBeVisible();
  });

  it('从侧栏打开百炼 OCR 设置时只显示密钥状态，不回填 API Key', async () => {
    const user = userEvent.setup();
    const getOcrSettings = vi.fn().mockResolvedValue({
      workspaceId: 'ws-existing',
      region: 'cn-beijing',
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr',
      apiKeyConfigured: true,
      apiKeyMask: '••••••••',
      credentialStore: 'macOS 钥匙串',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: '/Users/test/闲鱼订单',
        orders: [],
      }),
      getOcrSettings,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));

    expect(await screen.findByRole('heading', { name: '百炼 OCR' })).toBeVisible();
    expect(getOcrSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'Workspace ID' })).toHaveValue('ws-existing');
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password');
    expect(screen.getByText('••••••••')).toBeVisible();
    expect(screen.getByText('已保存在 macOS 钥匙串')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '地域' })).toHaveValue('中国（北京）');
    expect(screen.getByRole('textbox', { name: '地域' })).toHaveAttribute('readonly');
    expect(screen.getByText('qwen3.5-ocr 当前仅开放华北 2（北京）')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveValue('qwen3.5-ocr');
    expect(screen.getByRole('textbox', { name: '模型' })).toHaveAttribute('readonly');

    await user.click(screen.getByRole('button', { name: '订单' }));
    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
  });

  it('可保存百炼设置并清空密钥输入，保存失败时显示可读错误', async () => {
    const user = userEvent.setup();
    const savedSettings = {
      workspaceId: 'ws-new',
      region: 'cn-beijing' as const,
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr' as const,
      apiKeyConfigured: true,
      apiKeyMask: '••••••••',
      credentialStore: 'Windows 凭据管理器',
    };
    const saveOcrSettings = vi
      .fn()
      .mockResolvedValueOnce(savedSettings)
      .mockRejectedValueOnce(new Error('无法保存 OCR 设置'));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      saveOcrSettings,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByRole('heading', { name: '百炼 OCR' });

    await user.type(screen.getByRole('textbox', { name: 'Workspace ID' }), 'ws-new');
    await user.type(screen.getByLabelText('API Key'), 'sk-new-secret');
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(saveOcrSettings).toHaveBeenLastCalledWith({
      workspaceId: 'ws-new',
      region: 'cn-beijing',
      apiKey: 'sk-new-secret',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('设置已保存');
    expect(screen.getByLabelText('API Key')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存 OCR 设置');
  });

  it('连接测试必须先展示付费调用提示，再次确认后才发起请求', async () => {
    const user = userEvent.setup();
    const testOcrConnection = vi.fn().mockResolvedValue({
      ok: true,
      model: 'qwen3.5-ocr',
      message: '连接成功，qwen3.5-ocr 可以使用',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOcrSettings: vi.fn().mockResolvedValue({
        workspaceId: 'ws-existing',
        region: 'cn-beijing',
        regionLabel: '中国（北京）',
        model: 'qwen3.5-ocr',
        apiKeyConfigured: true,
        apiKeyMask: '••••••••',
        credentialStore: '测试系统凭据库',
      }),
      testOcrConnection,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    await user.click(await screen.findByRole('button', { name: '测试连接' }));

    expect(testOcrConnection).not.toHaveBeenCalled();
    expect(
      screen.getByText('发送一张内置测试图片并可能产生一次 OCR 调用'),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: '确认并测试连接' }));
    expect(testOcrConnection).toHaveBeenCalledOnce();
    expect(testOcrConnection).toHaveBeenCalledWith({ consentToPaidCall: true });
    expect(await screen.findByRole('status')).toHaveTextContent(
      '连接成功，qwen3.5-ocr 可以使用',
    );
  });

  it('可从系统凭据库移除 API Key', async () => {
    const user = userEvent.setup();
    const removedSettings = {
      workspaceId: 'ws-existing',
      region: 'cn-beijing' as const,
      regionLabel: '中国（北京）',
      model: 'qwen3.5-ocr' as const,
      apiKeyConfigured: false,
      apiKeyMask: '',
      credentialStore: '测试系统凭据库',
    };
    const removeOcrApiKey = vi.fn().mockResolvedValue(removedSettings);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOcrSettings: vi.fn().mockResolvedValue({
        ...removedSettings,
        apiKeyConfigured: true,
        apiKeyMask: '••••••••',
      }),
      removeOcrApiKey,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    await user.click(await screen.findByRole('button', { name: '移除 API Key' }));

    expect(removeOcrApiKey).toHaveBeenCalledOnce();
    expect(await screen.findByRole('status')).toHaveTextContent('API Key 已移除');
    expect(screen.getByText('尚未保存 API Key')).toBeVisible();
    expect(screen.queryByText('••••••••')).not.toBeInTheDocument();
  });
});
