// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type { CustomFieldDefinition } from '../src/core/custom-fields';
import type {
  OrderDetails,
  OrderDraft,
  OrderSummary,
  OriginalOrder,
  RecognitionBatchItemStatus,
  RecognitionBatchView,
} from '../src/core/contracts';
import type {
  OrderWorkbenchQuery,
  OrderWorkbenchResult,
} from '../src/core/order-workbench';
import { orderReviewIssueLabel } from '../src/core/order-intake';
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
  revision: 1,
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

const sourceScreenshot = {
  id: draft.screenshotId,
  originalName: '脱敏测试订单.png',
  relativePath: 'screenshots/shot-1.png',
  mimeType: 'image/png',
  sha256: 'abc123',
  createdAt: draft.createdAt,
};
const sourceSnapshot = {
  id: 'snapshot-1',
  createdAt: draft.createdAt,
  recognition: draft,
  confirmed: { ...draft, recipient: confirmedOrder.recipient },
};
const orderDetails: OrderDetails = {
  order: confirmedOrder,
  sourceScreenshot,
  sourceSnapshot,
  sources: [{ recognitionStatus: 'imported', sourceScreenshot, sourceSnapshot }],
  changeEvents: [],
  customFieldDefinitions: [],
  customFieldValues: [],
};

function orderSummary(
  order: OriginalOrder = confirmedOrder,
  overrides: Partial<OrderSummary> = {},
): OrderSummary {
  return {
    id: order.id,
    platform: order.platform,
    sellerAccount: order.sellerAccount,
    orderNumber: order.orderNumber,
    buyerNickname: order.buyerNickname,
    recipient: order.recipient,
    phone: order.phone,
    addressOriginal: order.addressOriginal,
    amountCents: order.amountCents,
    itemCount: order.items.reduce((total, item) => total + item.quantity, 0),
    initialSourceRecognitionStatus: 'imported',
    platformTransactionStatus: order.platformTransactionStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    lifecycleStatus: order.lifecycleStatus,
    orderedAtNormalized: order.orderedAtNormalized,
    paidAtNormalized: order.paidAtNormalized,
    createdAt: order.createdAt,
    items: order.items.map(({ sourceTitle, sourceSpec, quantity }) => ({
      sourceTitle,
      sourceSpec,
      quantity,
    })),
    ...overrides,
  };
}

function workbenchResult(
  orders: OrderSummary[],
  overrides: Partial<OrderWorkbenchResult> = {},
): OrderWorkbenchResult {
  const activeOrderCount = overrides.activeOrderCount ?? orders.filter(
    (order) => order.lifecycleStatus === 'active',
  ).length;
  return {
    orders,
    activeOrderCount,
    allLifecycleOrderCount: Math.max(orders.length, activeOrderCount),
    pendingShipmentCount: orders.filter((order) => (
      order.lifecycleStatus === 'active' &&
      order.platformTransactionStatus === 'paid' &&
      order.fulfillmentStatus === 'pending_shipment'
    )).length,
    platforms: [...new Set(orders.map((order) => order.platform))],
    sellerAccounts: [...new Set(orders.map((order) => order.sellerAccount))],
    ...overrides,
  };
}

type DesktopApiTestOverrides = Partial<DesktopApi> & {
  selectSourceScreenshot?: () => Promise<OrderDraft | null>;
};

function createApi(overrides: DesktopApiTestOverrides = {}): DesktopApi {
  const {
    selectSourceScreenshot = vi.fn().mockResolvedValue(null),
    queryOrders = vi.fn().mockResolvedValue(workbenchResult([])),
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
    getDraftReview: vi.fn(async (draftId) => {
      const selected = desktopApiOverrides.getDraft
        ? await desktopApiOverrides.getDraft(draftId)
        : selectedDraft;
      if (!selected) throw new Error('未找到订单草稿');
      return { kind: 'new_order' as const, draft: selected };
    }),
    onRecognitionBatchesChanged: vi.fn(() => () => undefined),
    cancelDraft: vi.fn().mockResolvedValue(undefined),
    confirmDraft: vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    }),
    confirmOrderUpdate: vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'order_updated',
    }),
    listOrders: vi.fn().mockResolvedValue([]),
    queryOrders,
    queryOrderItems: vi.fn().mockResolvedValue({ items: [] }),
    onOrdersChanged: vi.fn(() => () => undefined),
    getOrder: vi.fn(),
    listCustomFieldDefinitions: vi.fn().mockResolvedValue([]),
    createCustomFieldDefinition: vi.fn(),
    saveCustomFieldValues: vi.fn().mockResolvedValue([]),
    getScreenshotDataUrl: vi.fn(),
    getOrderIntakeSettings: vi.fn().mockResolvedValue({
      automaticImportEnabled: false,
    }),
    saveOrderIntakeSettings: vi.fn(async (input) => input),
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
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
    const queryOrders = vi.fn()
      .mockResolvedValueOnce(workbenchResult([]))
      .mockResolvedValue(workbenchResult([orderSummary()]));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      listOrders: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([orderSummary()]),
      queryOrders,
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

  it('人工确认新订单时要求每件商品补齐必填自定义字段', async () => {
    const user = userEvent.setup();
    const requiredItemField: CustomFieldDefinition = {
      id: 'field-required-item-bin',
      name: '商品库位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([requiredItemField]),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));

    const confirmButton = await screen.findByRole('button', { name: '确认并入库' });
    const itemField = screen.getByRole('textbox', { name: '商品库位' });
    expect(itemField).toHaveAttribute('aria-required', 'true');
    expect(confirmButton).toBeDisabled();
    expect(screen.getByText('请填写每件商品的全部必填自定义字段后再确认入库。'))
      .toBeVisible();

    await user.type(itemField, 'A-03');
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    expect(confirmDraft).toHaveBeenCalledWith(draft, {
      orderValues: [],
      itemValues: [{
        definitionId: requiredItemField.id,
        draftItemId: draft.items[0].id,
        value: 'A-03',
      }],
    });
  });

  it('校对中的自定义金额显示非法精度时不能提交旧值或空值', async () => {
    const user = userEvent.setup();
    const moneyField: CustomFieldDefinition = {
      id: 'field-review-extra-cost',
      name: '附加成本',
      granularity: 'order',
      type: 'money',
      required: false,
      defaultValue: 100,
      options: [],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const confirmDraft = vi.fn();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([moneyField]),
      confirmDraft,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    const confirmButton = await screen.findByRole('button', { name: '确认并入库' });
    const moneyInput = screen.getByRole('textbox', { name: '附加成本' });
    expect(confirmButton).toBeEnabled();

    await user.clear(moneyInput);
    await user.type(moneyInput, '1.005');

    expect(screen.getByText(/金额最多支持两位小数/u)).toBeVisible();
    expect(confirmButton).toBeDisabled();
    expect(confirmDraft).not.toHaveBeenCalled();
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
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
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
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
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
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
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
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
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

  it('有订单时首页明确汇总在库订单、全部待确认和待发货', async () => {
    const awaitingBatch = recognitionBatchView('batch-workbench-summary', [
      {
        id: 'batch-item-awaiting-1',
        batchId: 'batch-workbench-summary',
        sourceName: '待确认1.png',
        status: 'awaiting_confirmation',
        draftId: 'draft-awaiting-1',
      },
      {
        id: 'batch-item-awaiting-2',
        batchId: 'batch-workbench-summary',
        sourceName: '待确认2.png',
        status: 'awaiting_confirmation',
        draftId: 'draft-awaiting-2',
      },
    ]);
    const summary = orderSummary();
    const cancelled = orderSummary(confirmedOrder, {
      id: 'order-cancelled',
      orderNumber: 'XY-CANCELLED',
      platformTransactionStatus: 'cancelled',
    });
    const refunded = orderSummary(confirmedOrder, {
      id: 'order-refunded',
      orderNumber: 'XY-REFUNDED',
      platformTransactionStatus: 'refunded',
    });
    const trashed = orderSummary(confirmedOrder, {
      id: 'order-trashed',
      orderNumber: 'XY-TRASHED',
      lifecycleStatus: 'trashed',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary, cancelled, refunded, trashed],
      }),
      listOrders: vi.fn().mockResolvedValue([summary, cancelled, refunded, trashed]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary], {
        activeOrderCount: 1,
        pendingShipmentCount: 1,
      })),
      listRecognitionBatches: vi.fn().mockResolvedValue([awaitingBatch]),
    });

    render(<App api={api} />);

    const overview = await screen.findByRole('region', { name: '订单概况' });
    expect(overview).toHaveTextContent('在库订单1');
    await waitFor(() => expect(overview).toHaveTextContent('待确认2'));
    expect(overview).toHaveTextContent('待发货1');
  });

  it('订单行直接展示完整收件信息、商品、平台卖家和四个独立状态', async () => {
    const summary = orderSummary(confirmedOrder, {
      addressOriginal: '广东省深圳市南山区商务路88号',
      phone: '13800000000',
      items: [{ sourceTitle: '限量测试商品', sourceSpec: '商务黑', quantity: 2 }],
      itemCount: 2,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
    });

    render(<App api={api} />);

    const row = (await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    })).closest('tr');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('闲鱼');
    expect(row).toHaveTextContent(summary.sellerAccount);
    expect(row).toHaveTextContent(`${summary.recipient}13800000000广东省深圳市南山区商务路88号`);
    expect(row).toHaveTextContent('限量测试商品 · 商务黑 ×2');
    expect(row).toHaveTextContent('已入库');
    expect(row).toHaveTextContent('已付款');
    expect(row).toHaveTextContent('待发货');
    expect(row).toHaveTextContent('正常');
  });

  it('主搜索框可按买家和商品找到订单', async () => {
    const user = userEvent.setup();
    const first = orderSummary(confirmedOrder, {
      id: 'order-buyer-a',
      orderNumber: 'XY-BUYER-A',
      buyerNickname: '买家甲',
      items: [{ sourceTitle: '苹果商品', sourceSpec: '', quantity: 1 }],
    });
    const second = orderSummary(confirmedOrder, {
      id: 'order-buyer-b',
      orderNumber: 'XY-BUYER-B',
      buyerNickname: '买家乙',
      items: [{ sourceTitle: '香蕉商品', sourceSpec: '', quantity: 1 }],
    });
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => (
      query.text === '买家乙' || query.text === '香蕉商品'
        ? workbenchResult([second], { activeOrderCount: 2 })
        : workbenchResult([first, second])
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [first, second],
      }),
      listOrders: vi.fn().mockResolvedValue([first, second]),
      queryOrders,
    });

    render(<App api={api} />);
    await screen.findByRole('button', { name: '查看订单 XY-BUYER-A' });

    await user.type(screen.getByRole('searchbox', { name: '搜索订单' }), '买家乙');

    expect(await screen.findByRole('button', { name: '查看订单 XY-BUYER-B' })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('button', {
      name: '查看订单 XY-BUYER-A',
    })).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('显示 1 / 2 笔');

    await user.clear(screen.getByRole('searchbox', { name: '搜索订单' }));
    await user.type(screen.getByRole('searchbox', { name: '搜索订单' }), '香蕉商品');
    expect(await screen.findByRole('button', { name: '查看订单 XY-BUYER-B' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '查看订单 XY-BUYER-A' })).not.toBeInTheDocument();
  });

  it('查询无匹配时保留查询区并可一键清除条件', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => (
      query.text
        ? workbenchResult([], {
          activeOrderCount: 1,
          platforms: [summary.platform],
          sellerAccounts: [summary.sellerAccount],
        })
        : workbenchResult([summary])
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders,
    });

    render(<App api={api} />);
    await user.type(await screen.findByRole('searchbox', { name: '搜索订单' }), '不存在');

    expect(await screen.findByRole('heading', { name: '没有符合条件的订单' })).toBeVisible();
    expect(screen.getByRole('searchbox', { name: '搜索订单' })).toHaveValue('不存在');
    await user.click(screen.getByRole('button', { name: '清除筛选' }));

    expect(await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    })).toBeVisible();
    expect(screen.getByRole('searchbox', { name: '搜索订单' })).toHaveValue('');
  });

  it('只有回收站订单时仍展示查询工作台并可切换生命周期', async () => {
    const user = userEvent.setup();
    const trashed = orderSummary(confirmedOrder, {
      id: 'order-only-trashed',
      orderNumber: 'XY-ONLY-TRASHED',
      lifecycleStatus: 'trashed',
    });
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => (
      query.lifecycleStatus === 'trashed'
        ? workbenchResult([trashed], { activeOrderCount: 0, allLifecycleOrderCount: 1 })
        : workbenchResult([], {
          activeOrderCount: 0,
          allLifecycleOrderCount: 1,
          platforms: [trashed.platform],
          sellerAccounts: [trashed.sellerAccount],
        })
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      queryOrders,
    });

    render(<App api={api} />);

    expect(await screen.findByRole('heading', { name: '没有符合条件的订单' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '还没有订单' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('显示 0 / 1 笔');
    expect(screen.getByRole('region', { name: '订单概况' })).toHaveTextContent('在库订单0');

    await user.selectOptions(screen.getByRole('combobox', { name: '生命周期状态' }), 'trashed');

    expect(await screen.findByRole('button', { name: '查看订单 XY-ONLY-TRASHED' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('显示 1 / 1 笔');
  });

  it('可组合日期、平台卖家和四个状态筛选订单', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => {
      const matched = query.dateField === 'paid_at' &&
        query.dateFrom === '2026-07-01' &&
        query.dateTo === '2026-07-31' &&
        query.platform === 'xianyu' &&
        query.sellerAccount === summary.sellerAccount &&
        query.buyerText === summary.buyerNickname &&
        query.productText === summary.items[0].sourceTitle &&
        query.initialSourceRecognitionStatus === 'imported' &&
        query.platformTransactionStatus === 'paid' &&
        query.fulfillmentStatus === 'pending_shipment' &&
        query.lifecycleStatus === 'active';
      return workbenchResult(matched ? [summary] : [], {
        activeOrderCount: 1,
        platforms: ['xianyu'],
        sellerAccounts: [summary.sellerAccount],
      });
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders,
    });

    render(<App api={api} />);
    await screen.findByRole('region', { name: '订单查询' });

    await user.selectOptions(screen.getByRole('combobox', { name: '日期字段' }), 'paid_at');
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-07-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-07-31' } });
    await user.selectOptions(screen.getByRole('combobox', { name: '平台' }), 'xianyu');
    await user.selectOptions(screen.getByRole('combobox', { name: '卖家账号' }), summary.sellerAccount);
    await user.type(screen.getByRole('textbox', { name: '买家' }), summary.buyerNickname);
    await user.type(screen.getByRole('textbox', { name: '商品' }), summary.items[0].sourceTitle);
    await user.selectOptions(screen.getByRole('combobox', { name: '初始来源识别状态' }), 'imported');
    await user.selectOptions(screen.getByRole('combobox', { name: '平台交易状态' }), 'paid');
    await user.selectOptions(screen.getByRole('combobox', { name: '履约状态' }), 'pending_shipment');
    await user.selectOptions(screen.getByRole('combobox', { name: '生命周期状态' }), 'active');

    expect(await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('显示 1 / 1 笔');
  });

  it('选择商品升序后表格按查询结果顺序呈现', async () => {
    const user = userEvent.setup();
    const zOrder = orderSummary(confirmedOrder, {
      id: 'order-product-z',
      orderNumber: 'XY-PRODUCT-Z',
      items: [{ sourceTitle: 'Zeta 商品', sourceSpec: '', quantity: 1 }],
    });
    const aOrder = orderSummary(confirmedOrder, {
      id: 'order-product-a',
      orderNumber: 'XY-PRODUCT-A',
      items: [{ sourceTitle: 'Alpha 商品', sourceSpec: '', quantity: 1 }],
    });
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => (
      query.sortField === 'product' && query.sortDirection === 'asc'
        ? workbenchResult([aOrder, zOrder])
        : workbenchResult([zOrder, aOrder])
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [zOrder, aOrder],
      }),
      listOrders: vi.fn().mockResolvedValue([zOrder, aOrder]),
      queryOrders,
    });

    render(<App api={api} />);
    const table = await screen.findByRole('table', { name: '原始订单' });
    await user.selectOptions(screen.getByRole('combobox', { name: '排序方式' }), 'product:asc');

    await waitFor(() => expect(
      within(table).getAllByRole('button', { name: /查看订单/u })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['查看订单 XY-PRODUCT-A', '查看订单 XY-PRODUCT-Z']));
  });

  it('较晚返回的旧筛选响应不会覆盖较新的查询结果', async () => {
    let finishOldQuery!: (result: OrderWorkbenchResult) => void;
    const oldQuery = new Promise<OrderWorkbenchResult>((resolve) => {
      finishOldQuery = resolve;
    });
    const initial = orderSummary(confirmedOrder, {
      id: 'order-query-initial',
      orderNumber: 'XY-QUERY-INITIAL',
    });
    const stale = orderSummary(confirmedOrder, {
      id: 'order-query-stale',
      orderNumber: 'XY-QUERY-STALE',
    });
    const latest = orderSummary(confirmedOrder, {
      id: 'order-query-latest',
      orderNumber: 'XY-QUERY-LATEST',
    });
    const queryOrders = vi.fn((query: OrderWorkbenchQuery) => {
      if (query.text === '旧查询') return oldQuery;
      if (query.text === '新查询') return Promise.resolve(workbenchResult([latest]));
      return Promise.resolve(workbenchResult([initial]));
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [initial],
      }),
      queryOrders,
    });

    render(<App api={api} />);
    const search = await screen.findByRole('searchbox', { name: '搜索订单' });
    await screen.findByRole('button', { name: '查看订单 XY-QUERY-INITIAL' });

    fireEvent.change(search, { target: { value: '旧查询' } });
    await waitFor(() => expect(queryOrders).toHaveBeenCalledWith(expect.objectContaining({
      text: '旧查询',
    })));
    fireEvent.change(search, { target: { value: '新查询' } });

    expect(await screen.findByRole('button', { name: '查看订单 XY-QUERY-LATEST' })).toBeVisible();
    await act(async () => finishOldQuery(workbenchResult([stale])));

    expect(screen.getByRole('button', { name: '查看订单 XY-QUERY-LATEST' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '查看订单 XY-QUERY-STALE' })).not.toBeInTheDocument();
  });

  it('从查询结果打开详情再返回时保留原条件', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const queryOrders = vi.fn(async (query: OrderWorkbenchQuery) => (
      query.text === summary.buyerNickname
        ? workbenchResult([summary])
        : workbenchResult([summary])
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders,
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);
    await user.type(await screen.findByRole('searchbox', { name: '搜索订单' }), summary.buyerNickname);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    }));
    await user.click(await screen.findByRole('button', { name: '返回订单表' }));

    expect(await screen.findByRole('searchbox', { name: '搜索订单' })).toHaveValue(summary.buyerNickname);
    expect(screen.getByRole('button', {
      name: `查看订单 ${summary.orderNumber}`,
    })).toBeVisible();
  });

  it('有订单时直接展示主表，并可查看带来源截图的订单详情', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [orderSummary()],
      }),
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
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
    expect(screen.getByText('脱敏测试订单.png', { selector: 'figcaption span' })).toBeVisible();
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
        orders: [orderSummary(detailedOrder)],
      }),
      getOrder: vi.fn().mockResolvedValue(detailsWithEvidence),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
      listOrders: vi.fn().mockResolvedValue([orderSummary(detailedOrder)]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary(detailedOrder)])),
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

  it('订单详情分别呈现四个状态和完整收件信息', async () => {
    const user = userEvent.setup();
    const summary = orderSummary();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [summary],
      }),
      listOrders: vi.fn().mockResolvedValue([summary]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([summary])),
      getOrder: vi.fn().mockResolvedValue(orderDetails),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,ZGV0YWls'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${confirmedOrder.orderNumber}`,
    }));

    const statuses = await screen.findByRole('region', { name: '订单状态' });
    expect(statuses).toHaveTextContent('当前来源识别状态已入库');
    expect(statuses).toHaveTextContent('平台交易状态已付款');
    expect(statuses).toHaveTextContent('履约状态待发货');
    expect(statuses).toHaveTextContent('生命周期状态正常');

    const recipientSection = screen.getByRole('heading', { name: '收货信息' }).closest('section');
    expect(recipientSection).toHaveTextContent(confirmedOrder.recipient);
    expect(recipientSection).toHaveTextContent(confirmedOrder.phone);
    expect(recipientSection).toHaveTextContent(confirmedOrder.addressOriginal);
  });

  it('订单详情可切换查看全部来源截图并查看字段级修改记录', async () => {
    const user = userEvent.setup();
    const earlierScreenshot = {
      ...sourceScreenshot,
      id: 'shot-earlier-source',
      originalName: '首次订单截图.png',
      sha256: 'earlier-source-hash',
      createdAt: '2026-07-27T11:22:00.000Z',
    };
    const earlierSnapshot = {
      ...sourceSnapshot,
      id: 'snapshot-earlier-source',
      createdAt: earlierScreenshot.createdAt,
      confirmed: draft,
    };
    const latestScreenshot = {
      ...sourceScreenshot,
      id: 'shot-latest-source',
      originalName: '更新订单截图.png',
      sha256: 'latest-source-hash',
      createdAt: '2026-07-27T11:40:00.000Z',
    };
    const latestSnapshot = {
      ...sourceSnapshot,
      id: 'snapshot-latest-source',
      createdAt: latestScreenshot.createdAt,
    };
    const detailsWithHistory: OrderDetails = {
      ...orderDetails,
      sourceScreenshot: latestScreenshot,
      sourceSnapshot: latestSnapshot,
      sources: [
        {
          recognitionStatus: 'imported',
          sourceScreenshot: latestScreenshot,
          sourceSnapshot: latestSnapshot,
        },
        {
          recognitionStatus: 'duplicate_skipped',
          sourceScreenshot: earlierScreenshot,
          sourceSnapshot: earlierSnapshot,
        },
      ],
      changeEvents: [{
        id: 'event-source-update',
        sourceSnapshotId: latestSnapshot.id,
        source: 'source_update',
        baseRevision: 1,
        resultRevision: 2,
        createdAt: '2026-07-27T11:41:00.000Z',
        changes: [
          {
            path: 'recipient',
            before: '首次收件人',
            after: confirmedOrder.recipient,
          },
          {
            path: 'items.removed[0]',
            before: {
              sourceTitle: '旧商品',
              sourceSpec: '旧规格',
              unitPriceCents: 600,
              quantity: 1,
              quantityInferred: false,
            },
            after: null,
          },
        ],
      }],
    };
    const getScreenshotDataUrl = vi.fn(async (screenshotId: string) => (
      screenshotId === earlierScreenshot.id
        ? 'data:image/png;base64,ZWFybGllcg=='
        : 'data:image/png;base64,bGF0ZXN0'
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [orderSummary()],
      }),
      getOrder: vi.fn().mockResolvedValue(detailsWithHistory),
      getScreenshotDataUrl,
      listOrders: vi.fn().mockResolvedValue([orderSummary()]),
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([orderSummary()])),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: `查看订单 ${confirmedOrder.orderNumber}` }));

    const history = await screen.findByRole('region', { name: '来源与修改记录' });
    expect(history).toHaveTextContent('2 份来源 · 1 次更新');
    expect(history).toHaveTextContent('更新订单截图.png');
    expect(history).toHaveTextContent('首次订单截图.png');
    expect(history).toHaveTextContent('v1 → v2');
    expect(history).toHaveTextContent(`收件人首次收件人→${confirmedOrder.recipient}`);
    expect(history).toHaveTextContent('原商品 1 · 已移除');
    expect(within(history).getByRole('button', {
      name: '查看修改来源 更新订单截图.png',
    })).toBeVisible();

    await user.click(within(history).getByRole('button', { name: '查看来源 首次订单截图.png' }));

    await waitFor(() => expect(screen.getByRole('img', { name: '来源截图' })).toHaveAttribute(
      'src',
      'data:image/png;base64,ZWFybGllcg==',
    ));
    expect(screen.getByText('首次订单截图.png', { selector: 'figcaption span' })).toBeVisible();
    expect(screen.getByRole('region', { name: '订单状态' }))
      .toHaveTextContent('当前来源识别状态重复跳过');
    expect(screen.queryByText(/已在本次来源确认时修正/)).not.toBeInTheDocument();
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

  it('批次结果明确区分相同图片、内容等价订单和已确认更新', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-order-resolution', [
      {
        id: 'batch-item-identical-image',
        batchId: 'batch-order-resolution',
        sourceName: '相同图片.png',
        status: 'duplicate_skipped',
        resolution: 'identical_image',
      },
      {
        id: 'batch-item-equivalent-order',
        batchId: 'batch-order-resolution',
        sourceName: '等价订单.png',
        status: 'duplicate_skipped',
        resolution: 'equivalent_order',
      },
      {
        id: 'batch-item-order-updated',
        batchId: 'batch-order-resolution',
        sourceName: '订单更新.png',
        status: 'imported',
        resolution: 'order_updated',
      },
    ]);
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

    const table = await screen.findByRole('table', { name: '批次截图状态' });
    expect(within(table).getByText('相同截图已接收过，本次未重复调用 OCR')).toBeVisible();
    expect(within(table).getByText(
      '不同来源截图的订单内容等价，已记录来源且未创建重复订单',
    )).toBeVisible();
    expect(within(table).getByText('已确认字段变化并更新订单当前值')).toBeVisible();
    expect(within(table).getByText('已更新')).toBeVisible();
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

  it('自动入库后接收订单变更通知，无需刷新即更新订单表', async () => {
    let publishOrders!: (orders: OrderSummary[]) => void;
    const onOrdersChanged = vi.fn((listener: Parameters<DesktopApi['onOrdersChanged']>[0]) => {
      publishOrders = listener;
      return () => undefined;
    });
    const queryOrders = vi.fn()
      .mockResolvedValueOnce(workbenchResult([]))
      .mockResolvedValue(workbenchResult([orderSummary()]));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      onOrdersChanged,
      queryOrders,
    });

    render(<App api={api} />);
    expect(await screen.findByRole('heading', { name: '还没有订单' })).toBeVisible();
    await waitFor(() => expect(onOrdersChanged).toHaveBeenCalledOnce());

    await act(async () => publishOrders([orderSummary()]));

    expect(await screen.findByRole('table', { name: '原始订单' })).toBeVisible();
    await waitFor(() => expect(queryOrders).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', {
      name: `查看订单 ${confirmedOrder.orderNumber}`,
    })).toBeVisible();
  });

  it('启动快照与事件订阅之间发生的自动入库会通过订阅后查询补齐', async () => {
    const importedOrder = orderSummary();
    const onOrdersChanged = vi.fn(() => () => undefined);
    const listOrders = vi.fn().mockResolvedValue([importedOrder]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      onOrdersChanged,
      listOrders,
      queryOrders: vi.fn().mockResolvedValue(workbenchResult([importedOrder])),
    });

    render(<App api={api} />);

    expect(await screen.findByRole('table', { name: '原始订单' })).toBeVisible();
    expect(onOrdersChanged).toHaveBeenCalledOnce();
    expect(listOrders).toHaveBeenCalledOnce();
  });

  it('启动订单查询较晚返回时不会关闭用户已经打开的校对页', async () => {
    const user = userEvent.setup();
    let finishInitialQuery!: (orders: OrderSummary[]) => void;
    const initialQuery = new Promise<OrderSummary[]>((resolve) => {
      finishInitialQuery = resolve;
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      listOrders: vi.fn().mockReturnValue(initialQuery),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();

    await act(async () => finishInitialQuery([]));

    expect(screen.getByRole('heading', { name: '校对识别结果' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: '收件人' })).toHaveValue(draft.recipient);
  });

  it('确认后的较晚订单查询不会覆盖期间收到的自动入库通知', async () => {
    const user = userEvent.setup();
    let publishOrders!: (orders: OrderSummary[]) => void;
    let finishConfirmationQuery!: (orders: OrderSummary[]) => void;
    const confirmationQuery = new Promise<OrderSummary[]>((resolve) => {
      finishConfirmationQuery = resolve;
    });
    const confirmedSummary = orderSummary();
    const automaticSummary: OrderSummary = {
      ...confirmedSummary,
      id: 'order-auto-newer',
      orderNumber: 'XY-AUTO-NEWER-0001',
      recipient: '自动入库收件人',
    };
    const listOrders = vi.fn()
      .mockResolvedValueOnce([])
      .mockReturnValue(confirmationQuery);
    const queryOrders = vi.fn()
      .mockResolvedValueOnce(workbenchResult([]))
      .mockResolvedValue(workbenchResult([automaticSummary, confirmedSummary]));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshot: vi.fn().mockResolvedValue(draft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft: vi.fn().mockResolvedValue({
        order: confirmedOrder,
        resolution: 'new_order',
      }),
      listOrders,
      queryOrders,
      onOrdersChanged: vi.fn((listener) => {
        publishOrders = listener;
        return () => undefined;
      }),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    await user.click(await screen.findByRole('button', { name: '确认并入库' }));
    await waitFor(() => expect(listOrders).toHaveBeenCalledTimes(2));

    await act(async () => publishOrders([automaticSummary, confirmedSummary]));
    await act(async () => finishConfirmationQuery([confirmedSummary]));

    expect(await screen.findByRole('button', {
      name: `查看订单 ${automaticSummary.orderNumber}`,
    })).toBeVisible();
    expect(screen.getByRole('button', {
      name: `查看订单 ${confirmedSummary.orderNumber}`,
    })).toBeVisible();
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

  it('批次结果和校对页展示确定性待确认原因，不展示模型置信度', async () => {
    const user = userEvent.setup();
    const reviewIssues = ['missing_phone', 'item_total_mismatch'] as const;
    const reviewDraft: OrderDraft = {
      ...draft,
      reviewIssues: [...reviewIssues],
    };
    const batch = recognitionBatchView('batch-review-issues', [{
      id: 'batch-item-review-issues',
      batchId: 'batch-review-issues',
      sourceName: '需重点校对.png',
      status: 'awaiting_confirmation',
      draftId: reviewDraft.id,
      reviewIssues: [...reviewIssues],
    }]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraft: vi.fn().mockResolvedValue(reviewDraft),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    const table = await screen.findByRole('table', { name: '批次截图状态' });
    const row = within(table).getByText('需重点校对.png').closest('tr');
    if (!row) throw new Error('未找到待确认批次项');
    const batchReasons = within(row).getByRole('list', { name: '待确认原因' });
    for (const issue of reviewIssues) {
      expect(batchReasons).toHaveTextContent(orderReviewIssueLabel(issue));
    }
    expect(row).not.toHaveTextContent('置信度');

    await user.click(within(row).getByRole('button', { name: '校对' }));
    const reviewReasons = await screen.findByRole('region', { name: '请重点核对' });
    for (const issue of reviewIssues) {
      expect(reviewReasons).toHaveTextContent(orderReviewIssueLabel(issue));
    }
    expect(screen.getByRole('heading', { name: '校对识别结果' }).closest('section'))
      .not.toHaveTextContent('置信度');
  });

  it('订单内容变化时展示当前值与新识别值并通过明确动作确认更新', async () => {
    const user = userEvent.setup();
    const updateDraft: OrderDraft = {
      ...draft,
      id: 'draft-order-update',
      batchId: 'batch-order-update',
      screenshotId: 'shot-order-update',
      recipient: '新识别收件人',
      reviewIssues: ['order_content_changed'],
    };
    const currentOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-update-target',
      revision: 3,
      recipient: '当前收件人',
    };
    const existingOrderField: CustomFieldDefinition = {
      id: 'field-existing-order-priority',
      name: '订单优先级',
      granularity: 'order',
      type: 'single_select',
      required: true,
      defaultValue: '普通',
      options: ['普通', '加急'],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const review = {
      kind: 'order_update' as const,
      draft: updateDraft,
      currentOrder,
      expectedRevision: 3,
      changes: [{
        path: 'recipient',
        before: '当前收件人',
        after: '新识别收件人',
      }],
      sourceSnapshot: {
        id: 'snapshot-order-update',
        createdAt: updateDraft.createdAt,
        recognition: updateDraft,
        confirmed: null,
      },
      customFieldValues: [{
        definitionId: existingOrderField.id,
        orderId: currentOrder.id,
        orderItemId: null,
        value: '加急',
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
      }],
    };
    const batch = recognitionBatchView('batch-order-update', [{
      id: 'batch-item-order-update',
      batchId: 'batch-order-update',
      sourceName: '订单内容变化.png',
      status: 'awaiting_confirmation',
      draftId: updateDraft.id,
      reviewIssues: ['order_content_changed'],
    }]);
    const confirmOrderUpdate = vi.fn().mockResolvedValue({
      order: {
        ...currentOrder,
        recipient: '新识别收件人',
        revision: 4,
      },
      resolution: 'order_updated',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraft: vi.fn().mockResolvedValue(updateDraft),
      getDraftReview: vi.fn().mockResolvedValue(review),
      confirmOrderUpdate,
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([existingOrderField]),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,dXBkYXRl'),
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));

    const comparison = await screen.findByRole('table', { name: '订单变化对比' });
    expect(within(comparison).getByRole('columnheader', { name: '当前值' })).toBeVisible();
    expect(within(comparison).getByRole('columnheader', { name: '新识别值' })).toBeVisible();
    expect(within(comparison).getByText('收件人').closest('tr')).toHaveTextContent(
      '当前收件人新识别收件人',
    );
    expect(screen.getByRole('textbox', { name: '卖家账号' })).not.toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '订单号' })).not.toHaveAttribute('readonly');
    expect(screen.getByRole('combobox', { name: '订单优先级' })).toHaveValue('加急');

    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    expect(confirmOrderUpdate).toHaveBeenCalledWith(updateDraft, 3, {
      orderValues: [{
        definitionId: existingOrderField.id,
        value: '加急',
      }],
      itemValues: [],
    });
  });

  it('同一订单更新时显示旧订单缺失的必填商品字段，填写后才可确认', async () => {
    const user = userEvent.setup();
    const updateDraft: OrderDraft = {
      ...draft,
      id: 'draft-update-required-item-field',
      batchId: 'batch-update-required-item-field',
      recipient: '新识别收件人',
      reviewIssues: ['order_content_changed'],
    };
    const currentOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-update-required-item-field',
      recipient: '当前收件人',
    };
    const requiredItemField: CustomFieldDefinition = {
      id: 'field-required-item-bin',
      name: '拣货位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: 'A-DEFAULT',
      options: [],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const review = {
      kind: 'order_update' as const,
      draft: updateDraft,
      currentOrder,
      expectedRevision: currentOrder.revision,
      changes: [{
        path: 'recipient',
        before: currentOrder.recipient,
        after: updateDraft.recipient,
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: updateDraft,
        confirmed: null,
      },
      // 该旧商品曾在详情页清空过带默认值的字段。
      customFieldValues: [],
    };
    const batch = recognitionBatchView(updateDraft.batchId, [{
      id: 'batch-item-update-required-item-field',
      batchId: updateDraft.batchId,
      sourceName: '旧订单缺必填商品字段.png',
      status: 'awaiting_confirmation',
      draftId: updateDraft.id,
    }]);
    const confirmOrderUpdate = vi.fn().mockResolvedValue({
      order: { ...currentOrder, recipient: updateDraft.recipient, revision: 2 },
      resolution: 'order_updated' as const,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraftReview: vi.fn().mockResolvedValue(review),
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([requiredItemField]),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,aXRlbQ=='),
      confirmOrderUpdate,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));

    const field = await screen.findByRole('textbox', { name: '拣货位' });
    const confirmButton = screen.getByRole('button', { name: '确认更新订单' });
    expect(field).toHaveValue('');
    expect(confirmButton).toBeDisabled();

    await user.type(field, 'B-07');
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    expect(confirmOrderUpdate).toHaveBeenCalledWith(
      updateDraft,
      currentOrder.revision,
      {
        orderValues: [],
        itemValues: [{
          definitionId: requiredItemField.id,
          draftItemId: updateDraft.items[0].id,
          value: 'B-07',
        }],
      },
    );
  });

  it('更新中商品从未匹配修正为已有商品时，重新载入旧自定义值', async () => {
    const user = userEvent.setup();
    const currentOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-update-rematched-item',
      recipient: '当前收件人',
    };
    const updateDraft: OrderDraft = {
      ...draft,
      id: 'draft-update-rematched-item',
      batchId: 'batch-update-rematched-item',
      recipient: '新识别收件人',
      reviewIssues: ['order_content_changed'],
      items: [{
        ...draft.items[0],
        sourceTitle: '识别错误的新商品',
        sourceSpec: '识别错误规格',
      }],
    };
    const priorityField: CustomFieldDefinition = {
      id: 'field-item-priority-rematch',
      name: '商品优先级',
      granularity: 'order_item',
      type: 'single_select',
      required: false,
      defaultValue: '普通',
      options: ['普通', '加急'],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const review = {
      kind: 'order_update' as const,
      draft: updateDraft,
      currentOrder,
      expectedRevision: currentOrder.revision,
      changes: [{
        path: 'recipient',
        before: currentOrder.recipient,
        after: updateDraft.recipient,
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: updateDraft,
        confirmed: null,
      },
      customFieldValues: [{
        definitionId: priorityField.id,
        orderId: null,
        orderItemId: currentOrder.items[0].id,
        value: '加急',
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
      }],
    };
    const batch = recognitionBatchView(updateDraft.batchId, [{
      id: 'batch-item-update-rematched-item',
      batchId: updateDraft.batchId,
      sourceName: '商品修正匹配.png',
      status: 'awaiting_confirmation',
      draftId: updateDraft.id,
    }]);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraftReview: vi.fn().mockResolvedValue(review),
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([priorityField]),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,cmVtYXRjaA=='),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));

    const priority = await screen.findByRole('combobox', { name: '商品优先级' });
    expect(priority).toHaveValue('普通');
    const title = screen.getByRole('textbox', { name: '商品标题' });
    await user.clear(title);
    await user.type(title, currentOrder.items[0].sourceTitle);

    await waitFor(() => expect(priority).toHaveValue('加急'));
  });

  it('订单更新确认失败时保留用户尚未提交成功的表单修改', async () => {
    const user = userEvent.setup();
    const updateDraft: OrderDraft = {
      ...draft,
      id: 'draft-update-failure',
      batchId: 'batch-update-failure',
      recipient: 'OCR 新收件人',
      reviewIssues: ['order_content_changed'],
    };
    const currentOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'order-update-failure',
      recipient: '当前收件人',
    };
    const review = {
      kind: 'order_update' as const,
      draft: updateDraft,
      currentOrder,
      expectedRevision: 1,
      changes: [{
        path: 'recipient',
        before: '当前收件人',
        after: 'OCR 新收件人',
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: updateDraft,
        confirmed: null,
      },
      customFieldValues: [],
    };
    const batch = recognitionBatchView('batch-update-failure', [{
      id: 'batch-item-update-failure',
      batchId: 'batch-update-failure',
      sourceName: '更新失败保留表单.png',
      status: 'awaiting_confirmation',
      draftId: updateDraft.id,
    }]);
    const refreshedReview = {
      ...review,
      currentOrder: {
        ...currentOrder,
        revision: 2,
        recipient: '其他操作刚更新的收件人',
      },
      expectedRevision: 2,
      changes: [{
        path: 'recipient',
        before: '其他操作刚更新的收件人',
        after: updateDraft.recipient,
      }],
    };
    const getDraftReview = vi.fn()
      .mockResolvedValueOnce(review)
      .mockResolvedValueOnce(refreshedReview);
    const confirmOrderUpdate = vi.fn()
      .mockRejectedValueOnce(new Error('订单已在其他操作中更新，请刷新对比后重试'))
      .mockResolvedValueOnce({
        order: {
          ...currentOrder,
          revision: 3,
          recipient: '用户手工修正但尚未成功',
        },
        resolution: 'order_updated' as const,
      });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraftReview,
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,dXBkYXRl'),
      confirmOrderUpdate,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));
    const recipientInput = await screen.findByRole('textbox', { name: '收件人' });
    await user.clear(recipientInput);
    await user.type(recipientInput, '用户手工修正但尚未成功');
    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('订单已在其他操作中更新');
    expect(screen.getByRole('textbox', { name: '收件人' })).toHaveValue(
      '用户手工修正但尚未成功',
    );
    expect(screen.getByRole('table', { name: '订单变化对比' })).toHaveTextContent(
      '其他操作刚更新的收件人用户手工修正但尚未成功',
    );
    expect(getDraftReview).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    expect(confirmOrderUpdate).toHaveBeenNthCalledWith(2, {
      ...updateDraft,
      recipient: '用户手工修正但尚未成功',
    }, 2);
  });

  it('订单更新校对中修正身份命中另一已有订单时切换到新的对比对象', async () => {
    const user = userEvent.setup();
    const initialDraft: OrderDraft = {
      ...draft,
      id: 'draft-update-reroute',
      batchId: 'batch-update-reroute',
      orderNumber: 'OCR-MISTAKEN-ORDER',
      recipient: '新截图收件人',
      reviewIssues: ['order_content_changed'],
    };
    const initialOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'wrong-candidate-order',
      orderNumber: initialDraft.orderNumber,
      recipient: '误命中订单收件人',
    };
    const correctedDraft = {
      ...initialDraft,
      orderNumber: 'CORRECTED-EXISTING-ORDER',
    };
    const correctedOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'corrected-candidate-order',
      orderNumber: correctedDraft.orderNumber,
      recipient: '正确候选当前收件人',
    };
    const initialReview = {
      kind: 'order_update' as const,
      draft: initialDraft,
      currentOrder: initialOrder,
      expectedRevision: 1,
      changes: [{
        path: 'recipient',
        before: initialOrder.recipient,
        after: initialDraft.recipient,
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: initialDraft,
        confirmed: null,
      },
      customFieldValues: [],
    };
    const reroutedReview = {
      ...initialReview,
      draft: correctedDraft,
      currentOrder: correctedOrder,
      changes: [{
        path: 'recipient',
        before: correctedOrder.recipient,
        after: correctedDraft.recipient,
      }],
    };
    const getDraftReview = vi.fn()
      .mockResolvedValueOnce(initialReview)
      .mockResolvedValueOnce(reroutedReview);
    const batch = recognitionBatchView(initialDraft.batchId, [{
      id: 'batch-item-update-reroute',
      batchId: initialDraft.batchId,
      sourceName: '纠正候选订单.png',
      status: 'awaiting_confirmation',
      draftId: initialDraft.id,
    }]);
    const confirmOrderUpdate = vi.fn().mockRejectedValue(new Error(
      '修正后的订单身份命中另一笔已有订单，已切换对比，请核对后再次确认',
    ));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraftReview,
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,cmVyb3V0ZQ=='),
      confirmOrderUpdate,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));
    const orderNumber = await screen.findByRole('textbox', { name: '订单号' });
    await user.clear(orderNumber);
    await user.type(orderNumber, correctedDraft.orderNumber);
    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('已切换对比');
    expect(screen.getByRole('textbox', { name: '订单号' })).toHaveValue(
      correctedDraft.orderNumber,
    );
    expect(screen.getByRole('table', { name: '订单变化对比' })).toHaveTextContent(
      '正确候选当前收件人新截图收件人',
    );
    expect(confirmOrderUpdate).toHaveBeenCalledWith(correctedDraft, 1);
    expect(getDraftReview).toHaveBeenCalledTimes(2);
  });

  it('订单更新修正为新订单时重新加载默认值，不沿用旧目标的自定义值', async () => {
    const user = userEvent.setup();
    const initialDraft: OrderDraft = {
      ...draft,
      id: 'draft-update-to-new-order',
      batchId: 'batch-update-to-new-order',
      orderNumber: 'EXISTING-TARGET-ORDER',
      recipient: '新截图收件人',
      reviewIssues: ['order_content_changed'],
    };
    const initialOrder: OriginalOrder = {
      ...confirmedOrder,
      id: 'existing-target-before-new-order',
      orderNumber: initialDraft.orderNumber,
      recipient: '当前收件人',
    };
    const correctedDraft = {
      ...initialDraft,
      orderNumber: 'TRULY-NEW-ORDER',
    };
    const priorityField: CustomFieldDefinition = {
      id: 'field-order-priority-target-switch',
      name: '订单优先级',
      granularity: 'order',
      type: 'single_select',
      required: true,
      defaultValue: '普通',
      options: ['普通', '加急'],
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    };
    const initialReview = {
      kind: 'order_update' as const,
      draft: initialDraft,
      currentOrder: initialOrder,
      expectedRevision: initialOrder.revision,
      changes: [{
        path: 'recipient',
        before: initialOrder.recipient,
        after: initialDraft.recipient,
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: initialDraft,
        confirmed: null,
      },
      customFieldValues: [{
        definitionId: priorityField.id,
        orderId: initialOrder.id,
        orderItemId: null,
        value: '加急',
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
      }],
    };
    const getDraftReview = vi.fn()
      .mockResolvedValueOnce(initialReview)
      .mockResolvedValueOnce({ kind: 'new_order' as const, draft: correctedDraft });
    const batch = recognitionBatchView(initialDraft.batchId, [{
      id: 'batch-item-update-to-new-order',
      batchId: initialDraft.batchId,
      sourceName: '修正为新订单.png',
      status: 'awaiting_confirmation',
      draftId: initialDraft.id,
    }]);
    const confirmOrderUpdate = vi.fn().mockRejectedValue(new Error(
      '修正后的订单身份未命中已有订单，已切换为新订单校对，请再次确认',
    ));
    const confirmDraft = vi.fn().mockResolvedValue({
      order: { ...confirmedOrder, orderNumber: correctedDraft.orderNumber },
      resolution: 'new_order' as const,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      listRecognitionBatches: vi.fn().mockResolvedValue([batch]),
      getDraftReview,
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([priorityField]),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,bmV3'),
      confirmOrderUpdate,
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '识别批次' }));
    await user.click(await screen.findByRole('button', { name: '校对' }));
    expect(await screen.findByRole('combobox', { name: '订单优先级' }))
      .toHaveValue('加急');

    const orderNumber = screen.getByRole('textbox', { name: '订单号' });
    await user.clear(orderNumber);
    await user.type(orderNumber, correctedDraft.orderNumber);
    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    expect(await screen.findByRole('heading', { name: '校对识别结果' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: '订单优先级' }))
      .toHaveValue('普通');
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(confirmDraft).toHaveBeenCalledWith(correctedDraft, {
      orderValues: [{ definitionId: priorityField.id, value: '普通' }],
      itemValues: [],
    });
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
    const confirmDraft = vi.fn().mockResolvedValue({
      order: confirmedOrder,
      resolution: 'new_order',
    });
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

  it('确认请求完成前锁定全部校对字段，避免界面接受未提交的修改', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-confirm-lock', [{
      id: 'batch-item-confirm-lock',
      batchId: 'batch-confirm-lock',
      sourceName: '确认期间锁定.png',
      status: 'awaiting_confirmation',
      draftId: draft.id,
    }]);
    let finishConfirmation!: (
      value: Awaited<ReturnType<DesktopApi['confirmDraft']>>,
    ) => void;
    const confirmDraft = vi.fn(() => new Promise<
      Awaited<ReturnType<DesktopApi['confirmDraft']>>
    >((resolve) => {
      finishConfirmation = resolve;
    }));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      getDraftReview: vi.fn().mockResolvedValue({ kind: 'new_order', draft }),
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,bG9ja2Vk'),
      confirmDraft,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    const recipient = await screen.findByRole('textbox', { name: '收件人' });
    const valueAtSubmit = recipient.getAttribute('value');
    await user.click(screen.getByRole('button', { name: '确认并入库' }));

    expect(recipient).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '订单号' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '添加商品' })).toBeDisabled();
    await user.type(recipient, '不会被接受的修改');
    expect(recipient).toHaveValue(valueAtSubmit);

    await act(async () => finishConfirmation({
      order: confirmedOrder,
      resolution: 'new_order',
    }));

    expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({
      recipient: valueAtSubmit,
    }));
  });

  it('校对新订单时若最终命中等价订单则显示重复跳过而不是已入库', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-review-equivalent', [{
      id: 'batch-item-review-equivalent',
      batchId: 'batch-review-equivalent',
      sourceName: '校正后等价订单.png',
      status: 'awaiting_confirmation',
      draftId: draft.id,
    }]);
    const equivalentOrder = {
      ...confirmedOrder,
      recipient: draft.recipient,
    };
    const transitionedReview = {
      kind: 'order_update' as const,
      draft,
      currentOrder: equivalentOrder,
      expectedRevision: equivalentOrder.revision,
      changes: [],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: draft,
        confirmed: null,
      },
      customFieldValues: [],
    };
    const getDraftReview = vi.fn()
      .mockResolvedValueOnce({ kind: 'new_order' as const, draft })
      .mockResolvedValueOnce(transitionedReview);
    const confirmDraft = vi.fn().mockRejectedValue(new Error(
      '该订单已存在，已转为已有订单校对，请确认自定义字段后再次提交',
    ));
    const confirmOrderUpdate = vi.fn().mockResolvedValue({
      order: equivalentOrder,
      resolution: 'equivalent_order',
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      getDraftReview,
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft,
      confirmOrderUpdate,
      listOrders: vi.fn().mockResolvedValue([]),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    await user.click(await screen.findByRole('button', { name: '确认并入库' }));
    expect(await screen.findByRole('heading', { name: '确认订单更新' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '确认更新订单' }));

    await user.click(await screen.findByRole('button', { name: '查看批次' }));
    const table = await screen.findByRole('table', { name: '批次截图状态' });
    const row = within(table).getByText('校正后等价订单.png').closest('tr');
    expect(row).toHaveTextContent('重复跳过');
    expect(row).toHaveTextContent('不同来源截图的订单内容等价');
    expect(row).not.toHaveTextContent('已入库');
    expect(getDraftReview).toHaveBeenCalledTimes(2);
    expect(confirmOrderUpdate).toHaveBeenCalledWith(draft, equivalentOrder.revision);
  });

  it('校对新订单时若最终命中已有变化订单会立即切换到新旧对比', async () => {
    const user = userEvent.setup();
    const batch = recognitionBatchView('batch-review-transition', [{
      id: 'batch-item-review-transition',
      batchId: 'batch-review-transition',
      sourceName: '校正身份后内容变化.png',
      status: 'awaiting_confirmation',
      draftId: draft.id,
    }]);
    const transitionedDraft = {
      ...draft,
      recipient: '需要更新的收件人',
      reviewIssues: ['order_content_changed'] as const,
    };
    const currentOrder = {
      ...confirmedOrder,
      id: 'existing-transition-order',
      recipient: '当前收件人',
    };
    const transitionedReview = {
      kind: 'order_update' as const,
      draft: transitionedDraft,
      currentOrder,
      expectedRevision: 1,
      changes: [{
        path: 'recipient',
        before: '当前收件人',
        after: '需要更新的收件人',
      }],
      sourceSnapshot: {
        ...sourceSnapshot,
        recognition: transitionedDraft,
        confirmed: null,
      },
      customFieldValues: [],
    };
    const getDraftReview = vi.fn()
      .mockResolvedValueOnce({ kind: 'new_order', draft })
      .mockResolvedValueOnce(transitionedReview);
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      selectSourceScreenshots: vi.fn().mockResolvedValue(batch),
      listRecognitionBatches: vi.fn().mockResolvedValue([]),
      getDraftReview,
      getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,c291cmNl'),
      confirmDraft: vi.fn().mockRejectedValue(new Error(
        '该订单已存在且内容有变化，已转为订单更新，请核对新旧对比后再次确认',
      )),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '上传订单截图' }));
    await user.click(await screen.findByRole('button', { name: '确认并入库' }));

    expect(await screen.findByRole('heading', { name: '确认订单更新' })).toBeVisible();
    const comparison = screen.getByRole('table', { name: '订单变化对比' });
    expect(within(comparison).getByText('收件人').closest('tr')).toHaveTextContent(
      '当前收件人需要更新的收件人',
    );
    expect(screen.getByRole('button', { name: '确认更新订单' })).toBeEnabled();
    expect(getDraftReview).toHaveBeenCalledTimes(2);
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

  it('设置页在 OCR 之前显示自动入库开关，切换后立即保存', async () => {
    const user = userEvent.setup();
    let finishSave!: (value: { automaticImportEnabled: boolean }) => void;
    const saveOrderIntakeSettings = vi.fn((
      _input: { automaticImportEnabled: boolean },
    ) => new Promise<{ automaticImportEnabled: boolean }>((resolve) => {
      finishSave = resolve;
    }));
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOrderIntakeSettings: vi.fn().mockResolvedValue({
        automaticImportEnabled: false,
      }),
      saveOrderIntakeSettings,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    const automaticImport = await screen.findByRole('switch', { name: '自动入库' });
    const settingsForm = screen.getByRole('form', { name: '应用设置' });
    expect(within(settingsForm).getAllByRole('heading', { level: 2 }).slice(0, 2)
      .map((heading) => heading.textContent)).toEqual(['自动入库', '百炼 OCR']);
    expect(automaticImport).toHaveAttribute('aria-checked', 'false');

    await user.click(automaticImport);

    expect(saveOrderIntakeSettings).toHaveBeenCalledOnce();
    expect(saveOrderIntakeSettings).toHaveBeenCalledWith({ automaticImportEnabled: true });
    expect(automaticImport).toHaveAttribute('aria-checked', 'true');
    expect(automaticImport).toBeDisabled();

    await act(async () => finishSave({ automaticImportEnabled: true }));
    expect(await screen.findByText('自动入库已开启')).toBeVisible();
    expect(automaticImport).toBeEnabled();
  });

  it('自动入库设置保存失败时回滚开关并显示错误', async () => {
    const user = userEvent.setup();
    const saveOrderIntakeSettings = vi.fn().mockRejectedValue(
      new Error('无法保存自动入库设置'),
    );
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOrderIntakeSettings: vi.fn().mockResolvedValue({
        automaticImportEnabled: false,
      }),
      saveOrderIntakeSettings,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));
    const automaticImport = await screen.findByRole('switch', { name: '自动入库' });
    await user.click(automaticImport);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存自动入库设置');
    expect(automaticImport).toHaveAttribute('aria-checked', 'false');
    expect(automaticImport).toBeEnabled();
  });

  it('OCR 设置读取失败时仍可查看并关闭已开启的自动入库', async () => {
    const user = userEvent.setup();
    const saveOrderIntakeSettings = vi.fn().mockResolvedValue({
      automaticImportEnabled: false,
    });
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOrderIntakeSettings: vi.fn().mockResolvedValue({
        automaticImportEnabled: true,
      }),
      saveOrderIntakeSettings,
      getOcrSettings: vi.fn().mockRejectedValue(
        new Error('无法读取系统凭据库中的 OCR 设置'),
      ),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));

    const automaticImport = await screen.findByRole('switch', { name: '自动入库' });
    expect(automaticImport).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '无法读取系统凭据库中的 OCR 设置',
    );

    await user.click(automaticImport);

    expect(saveOrderIntakeSettings).toHaveBeenCalledWith({
      automaticImportEnabled: false,
    });
    expect(await screen.findByText('自动入库已关闭')).toBeVisible();
    expect(automaticImport).toHaveAttribute('aria-checked', 'false');
  });

  it('OCR 设置一直未返回时也不会阻塞自动入库开关', async () => {
    const user = userEvent.setup();
    const api = createApi({
      getBootstrapState: vi.fn().mockResolvedValue({
        kind: 'ready',
        dataDirectory: 'D:\\闲鱼订单',
        orders: [],
      }),
      getOrderIntakeSettings: vi.fn().mockResolvedValue({
        automaticImportEnabled: true,
      }),
      getOcrSettings: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '设置' }));

    const automaticImport = await screen.findByRole('switch', { name: '自动入库' });
    expect(automaticImport).toHaveAttribute('aria-checked', 'true');
    expect(automaticImport).toBeEnabled();
    expect(screen.getByText('正在读取 OCR 设置…')).toBeVisible();
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
