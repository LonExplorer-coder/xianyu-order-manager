// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type {
  OrderDetails,
  OrderSummary,
  OriginalOrder,
} from '../src/core/contracts';
import type {
  OrderItemWorkbenchQuery,
  OrderItemWorkbenchResult,
  OrderWorkbenchQuery,
  OrderWorkbenchResult,
} from '../src/core/order-workbench';
import { App } from '../src/renderer/App';

afterEach(cleanup);

type CustomFieldGranularity = 'order' | 'order_item';
type CustomFieldType =
  | 'text'
  | 'number'
  | 'money'
  | 'datetime'
  | 'single_select'
  | 'multi_select'
  | 'checkbox';
type CustomFieldValue = string | number | boolean | string[];

type CustomFieldDefinition = {
  id: string;
  name: string;
  granularity: CustomFieldGranularity;
  type: CustomFieldType;
  required: boolean;
  defaultValue: CustomFieldValue | null;
  options: string[];
  createdAt: string;
  updatedAt: string;
};

type CustomFieldValueRecord = {
  definitionId: string;
  orderId: string | null;
  orderItemId: string | null;
  value: CustomFieldValue;
  createdAt: string;
  updatedAt: string;
};

type CreateCustomFieldDefinitionInput = Omit<
  CustomFieldDefinition,
  'id' | 'createdAt' | 'updatedAt'
>;

type SaveCustomFieldValuesInput = {
  orderId: string;
  orderValues: Array<{ definitionId: string; value: CustomFieldValue | null }>;
  itemValues: Array<{
    definitionId: string;
    orderItemId: string;
    value: CustomFieldValue | null;
  }>;
};

type CustomFieldsDesktopApi = DesktopApi & {
  listCustomFieldDefinitions(): Promise<CustomFieldDefinition[]>;
  createCustomFieldDefinition(
    input: CreateCustomFieldDefinitionInput,
  ): Promise<CustomFieldDefinition>;
  saveCustomFieldValues(input: SaveCustomFieldValuesInput): Promise<CustomFieldValueRecord[]>;
};

const createdAt = '2026-07-30T08:00:00.000Z';

const orderTextField: CustomFieldDefinition = {
  id: 'field-order-note',
  name: '客服备注',
  granularity: 'order',
  type: 'text',
  required: false,
  defaultValue: null,
  options: [],
  createdAt,
  updatedAt: createdAt,
};

const itemCheckboxField: CustomFieldDefinition = {
  id: 'field-item-checked',
  name: '已核验',
  granularity: 'order_item',
  type: 'checkbox',
  required: false,
  defaultValue: false,
  options: [],
  createdAt,
  updatedAt: createdAt,
};

const itemTextField: CustomFieldDefinition = {
  id: 'field-item-bin',
  name: '仓位',
  granularity: 'order_item',
  type: 'text',
  required: false,
  defaultValue: null,
  options: [],
  createdAt,
  updatedAt: createdAt,
};

const confirmedOrder: OriginalOrder = {
  id: 'order-1',
  revision: 1,
  platform: 'xianyu',
  sellerAccount: '测试闲鱼账号',
  orderNumber: 'XY-CUSTOM-FIELD-001',
  alipayTransactionNumber: 'ALI-CUSTOM-FIELD-001',
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
  shippingCarrier: '',
  trackingNumber: '',
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  lifecycleStatus: 'active',
  createdAt,
  updatedAt: createdAt,
  items: [{
    id: 'order-item-1',
    position: 0,
    sourceTitle: '脱敏测试商品',
    sourceSpec: '白色',
    unitPriceCents: 800,
    quantity: 1,
    quantityInferred: false,
    subtotalCents: 800,
  }],
};

const sourceScreenshot = {
  id: 'screenshot-1',
  originalName: '自定义字段测试订单.png',
  relativePath: 'screenshots/screenshot-1.png',
  mimeType: 'image/png',
  sha256: 'custom-field-test-hash',
  createdAt,
};

const sourceSnapshot = {
  id: 'snapshot-1',
  createdAt,
  recognition: {
    id: 'draft-1',
    batchId: 'batch-1',
    screenshotId: sourceScreenshot.id,
    status: 'confirmed' as const,
    createdAt,
    platform: confirmedOrder.platform,
    sellerAccount: confirmedOrder.sellerAccount,
    orderNumber: confirmedOrder.orderNumber,
    alipayTransactionNumber: confirmedOrder.alipayTransactionNumber,
    buyerNickname: confirmedOrder.buyerNickname,
    recipient: confirmedOrder.recipient,
    phone: confirmedOrder.phone,
    phoneNormalized: confirmedOrder.phoneNormalized,
    addressOriginal: confirmedOrder.addressOriginal,
    addressNormalized: confirmedOrder.addressNormalized,
    province: confirmedOrder.province,
    city: confirmedOrder.city,
    district: confirmedOrder.district,
    orderedAtOriginal: confirmedOrder.orderedAtOriginal,
    orderedAtNormalized: confirmedOrder.orderedAtNormalized,
    paidAtOriginal: confirmedOrder.paidAtOriginal,
    paidAtNormalized: confirmedOrder.paidAtNormalized,
    productTotalCents: confirmedOrder.productTotalCents,
    shippingFeeCents: confirmedOrder.shippingFeeCents,
    amountCents: confirmedOrder.amountCents,
    platformTransactionStatus: confirmedOrder.platformTransactionStatus,
    fulfillmentStatus: 'pending_shipment' as const,
    items: confirmedOrder.items.map(({ subtotalCents: _subtotalCents, ...item }) => item),
  },
  confirmed: null,
};

function summary(order: OriginalOrder = confirmedOrder): OrderSummary {
  return {
    id: order.id,
    platform: order.platform,
    sellerAccount: order.sellerAccount,
    orderNumber: order.orderNumber,
    alipayTransactionNumber: order.alipayTransactionNumber,
    buyerNickname: order.buyerNickname,
    recipient: order.recipient,
    phone: order.phone,
    addressOriginal: order.addressOriginal,
    amountCents: order.amountCents,
    shippingCarrier: order.shippingCarrier,
    trackingNumber: order.trackingNumber,
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
  };
}

function workbenchResult(
  definitions: CustomFieldDefinition[] = [],
): OrderWorkbenchResult {
  return {
    orders: [summary()],
    customFieldValues: [],
    activeOrderCount: 1,
    allLifecycleOrderCount: 1,
    pendingShipmentCount: 1,
    platforms: ['xianyu'],
    sellerAccounts: [confirmedOrder.sellerAccount],
    customFieldDefinitions: definitions,
  } as OrderWorkbenchResult;
}

function itemWorkbenchResult(): OrderItemWorkbenchResult {
  return {
    items: confirmedOrder.items.map((item) => ({
      ...item,
      orderId: confirmedOrder.id,
      orderNumber: confirmedOrder.orderNumber,
    })),
    customFieldValues: [],
  };
}

function details(
  definitions: CustomFieldDefinition[] = [],
  values: CustomFieldValueRecord[] = [],
): OrderDetails {
  return {
    order: confirmedOrder,
    sourceScreenshot,
    sourceSnapshot,
    sources: [{
      recognitionStatus: 'imported',
      sourceScreenshot,
      sourceSnapshot,
    }],
    changeEvents: [],
    customFieldDefinitions: definitions,
    customFieldValues: values,
    operations: {
      shipmentRecords: [],
      aftersalesCases: [],
      currentTodo: '无需物流操作',
    },
  };
}

function createApi(
  overrides: Partial<CustomFieldsDesktopApi> = {},
): CustomFieldsDesktopApi {
  return {
    getBootstrapState: vi.fn().mockResolvedValue({
      kind: 'ready',
      dataDirectory: 'D:\\闲鱼订单',
      orders: [summary()],
    }),
    retryDataDirectory: vi.fn(),
    selectDataDirectory: vi.fn(),
    selectSourceScreenshots: vi.fn().mockResolvedValue(null),
    listRecognitionBatches: vi.fn().mockResolvedValue([]),
    retryRecognitionItem: vi.fn(),
    createManualDraft: vi.fn(),
    getDraft: vi.fn(),
    getDraftReview: vi.fn(),
    onRecognitionBatchesChanged: vi.fn(() => () => undefined),
    cancelDraft: vi.fn(),
    confirmDraft: vi.fn(),
    confirmOrderUpdate: vi.fn(),
    listOrders: vi.fn().mockResolvedValue([summary()]),
    queryOrders: vi.fn().mockResolvedValue(workbenchResult()),
    queryOrderItems: vi.fn().mockResolvedValue(itemWorkbenchResult()),
    onOrdersChanged: vi.fn(() => () => undefined),
    getOrder: vi.fn().mockResolvedValue(details()),
    getScreenshotDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,Y3VzdG9t'),
    getOrderIntakeSettings: vi.fn().mockResolvedValue({ automaticImportEnabled: false }),
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
    listCustomFieldDefinitions: vi.fn().mockResolvedValue([]),
    createCustomFieldDefinition: vi.fn(),
    saveCustomFieldValues: vi.fn().mockResolvedValue([]),
    listTableTemplates: vi.fn().mockResolvedValue([]),
    createTableTemplate: vi.fn(),
    updateTableTemplate: vi.fn(),
    deleteTableTemplate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as CustomFieldsDesktopApi;
}

describe('自定义字段界面', () => {
  it('可从主导航进入字段库并创建订单级文本字段', async () => {
    const user = userEvent.setup();
    const listCustomFieldDefinitions = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([orderTextField]);
    const createCustomFieldDefinition = vi.fn().mockResolvedValue(orderTextField);
    const api = createApi({
      listCustomFieldDefinitions,
      createCustomFieldDefinition,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '字段库' }));

    expect(await screen.findByRole('heading', { name: '字段库' })).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: '字段名称' }), '客服备注');
    await user.selectOptions(screen.getByRole('combobox', { name: '数据粒度' }), 'order');
    await user.selectOptions(screen.getByRole('combobox', { name: '字段类型' }), 'text');
    await user.click(screen.getByRole('button', { name: '创建字段' }));

    await waitFor(() => expect(createCustomFieldDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '客服备注',
        granularity: 'order',
        type: 'text',
      }),
    ));
    expect(await screen.findByText('客服备注')).toBeVisible();
    expect(screen.getByText('订单')).toBeVisible();
    expect(screen.getByText('文本')).toBeVisible();
  });

  it('字段类型选择覆盖文本、数字与金额、日期时间、单选、多选和复选框', async () => {
    const user = userEvent.setup();
    const api = createApi();

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', { name: '字段库' }));

    const typeSelect = await screen.findByRole('combobox', { name: '字段类型' });
    const options = within(typeSelect).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      '文本',
      '数字',
      '金额',
      '日期时间',
      '单选',
      '多选',
      '复选框',
    ]);

    await user.selectOptions(typeSelect, 'single_select');
    expect(screen.getByRole('textbox', { name: '可选项' })).toBeVisible();

    await user.selectOptions(typeSelect, 'multi_select');
    expect(screen.getByRole('textbox', { name: '可选项' })).toBeVisible();

    await user.selectOptions(typeSelect, 'checkbox');
    expect(screen.getByRole('checkbox', { name: '默认勾选' })).toBeVisible();
  });

  it('订单详情可填写并一起保存订单级与商品级字段值', async () => {
    const user = userEvent.setup();
    const saveCustomFieldValues = vi.fn().mockResolvedValue([
      {
        definitionId: orderTextField.id,
        orderId: confirmedOrder.id,
        orderItemId: null,
        value: '优先发货',
        createdAt,
        updatedAt: createdAt,
      },
      {
        definitionId: itemCheckboxField.id,
        orderId: null,
        orderItemId: confirmedOrder.items[0].id,
        value: true,
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    const api = createApi({
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([
        orderTextField,
        itemCheckboxField,
      ]),
      getOrder: vi.fn().mockResolvedValue(details([
        orderTextField,
        itemCheckboxField,
      ])),
      saveCustomFieldValues,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${confirmedOrder.orderNumber}`,
    }));

    expect(await screen.findByRole('heading', { name: '自定义字段' })).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: '客服备注' }), '优先发货');
    await user.selectOptions(screen.getByRole('combobox', { name: '已核验' }), 'true');
    await user.click(screen.getByRole('button', { name: '保存自定义字段' }));

    await waitFor(() => expect(saveCustomFieldValues).toHaveBeenCalledWith({
      orderId: confirmedOrder.id,
      orderValues: [{
        definitionId: orderTextField.id,
        value: '优先发货',
      }],
      itemValues: [{
        definitionId: itemCheckboxField.id,
        orderItemId: confirmedOrder.items[0].id,
        value: true,
      }],
    }));
  });

  it('订单详情有未保存自定义字段时，返回或切换导航前需确认放弃', async () => {
    const user = userEvent.setup();
    const api = createApi({
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([orderTextField]),
      getOrder: vi.fn().mockResolvedValue(details([orderTextField])),
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${confirmedOrder.orderNumber}`,
    }));
    await user.type(
      await screen.findByRole('textbox', { name: '客服备注' }),
      '尚未保存',
    );

    await user.click(screen.getByRole('button', { name: '返回订单表' }));
    expect(confirm).toHaveBeenCalledWith('自定义字段还有未保存修改，确定放弃吗？');
    expect(screen.getByRole('heading', { name: '订单详情' })).toBeVisible();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: '字段库' }));
    expect(await screen.findByRole('heading', { name: '字段库' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '订单详情' })).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  it('订单详情保存自定义字段期间锁定输入，避免响应覆盖后续编辑', async () => {
    const user = userEvent.setup();
    let finishSave!: (values: CustomFieldValueRecord[]) => void;
    const saveCustomFieldValues = vi.fn(() => new Promise<CustomFieldValueRecord[]>((resolve) => {
      finishSave = resolve;
    }));
    const api = createApi({
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([orderTextField]),
      getOrder: vi.fn().mockResolvedValue(details([orderTextField])),
      saveCustomFieldValues,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${confirmedOrder.orderNumber}`,
    }));
    const input = await screen.findByRole('textbox', { name: '客服备注' });
    await user.type(input, '已提交内容');
    await user.click(screen.getByRole('button', { name: '保存自定义字段' }));

    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    await user.type(input, '不应写入');
    expect(input).toHaveValue('已提交内容');

    await act(async () => finishSave([{
      definitionId: orderTextField.id,
      orderId: confirmedOrder.id,
      orderItemId: null,
      value: '已提交内容',
      createdAt,
      updatedAt: createdAt,
    }]));
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue('已提交内容');
  });

  it('订单详情就地提示必填状态和保存失败原因', async () => {
    const user = userEvent.setup();
    const requiredField: CustomFieldDefinition = {
      ...orderTextField,
      id: 'field-required-handler',
      name: '处理人',
      required: true,
    };
    const saveCustomFieldValues = vi.fn().mockRejectedValue(new Error('无法保存自定义字段'));
    const api = createApi({
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([requiredField]),
      getOrder: vi.fn().mockResolvedValue(details([requiredField])),
      saveCustomFieldValues,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${confirmedOrder.orderNumber}`,
    }));

    const customFieldsSection = (await screen.findByRole('heading', { name: '自定义字段' }))
      .closest('section');
    if (!customFieldsSection) throw new Error('未找到自定义字段详情区');
    const saveButton = within(customFieldsSection).getByRole('button', {
      name: '保存自定义字段',
    });
    expect(saveButton).toBeDisabled();
    expect(within(customFieldsSection).getByText(
      '请填写订单及每件商品的全部必填自定义字段。',
    )).toBeVisible();

    await user.type(within(customFieldsSection).getByRole('textbox', { name: '处理人' }), '小林');
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);

    await waitFor(() => expect(within(customFieldsSection).getByRole('alert'))
      .toHaveTextContent('无法保存自定义字段'));
  });

  it('详情中的自定义金额显示非法精度时禁用保存且不调用 API', async () => {
    const user = userEvent.setup();
    const moneyField: CustomFieldDefinition = {
      ...orderTextField,
      id: 'field-detail-extra-cost',
      name: '附加成本',
      type: 'money',
    };
    const existingValue: CustomFieldValueRecord = {
      definitionId: moneyField.id,
      orderId: confirmedOrder.id,
      orderItemId: null,
      value: 100,
      createdAt,
      updatedAt: createdAt,
    };
    const saveCustomFieldValues = vi.fn();
    const api = createApi({
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([moneyField]),
      getOrder: vi.fn().mockResolvedValue(details([moneyField], [existingValue])),
      saveCustomFieldValues,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('button', {
      name: `查看订单 ${confirmedOrder.orderNumber}`,
    }));

    const saveButton = await screen.findByRole('button', { name: '保存自定义字段' });
    const moneyInput = screen.getByRole('textbox', { name: '附加成本' });
    await user.clear(moneyInput);
    await user.type(moneyInput, '1.005');

    expect(saveButton).toBeDisabled();
    expect(saveCustomFieldValues).not.toHaveBeenCalled();
  });

  it('订单工作台可按订单级自定义字段筛选和排序并发送字段标识', async () => {
    const user = userEvent.setup();
    const queryOrders = vi.fn(async (_query: OrderWorkbenchQuery) => (
      workbenchResult([orderTextField, itemCheckboxField])
    ));
    const api = createApi({
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([
        orderTextField,
        itemCheckboxField,
      ]),
      queryOrders,
    });

    render(<App api={api} />);
    await screen.findByRole('region', { name: '订单查询' });

    const fieldFilter = await screen.findByRole('combobox', { name: '自定义字段筛选' });
    expect(within(fieldFilter).getByRole('option', { name: '客服备注' })).toBeVisible();
    expect(within(fieldFilter).queryByRole('option', { name: '已核验' })).not.toBeInTheDocument();
    await user.selectOptions(fieldFilter, orderTextField.id);
    await user.type(screen.getByRole('textbox', { name: '自定义字段值' }), '加急');

    const fieldSort = screen.getByRole('combobox', { name: '自定义字段排序' });
    expect(within(fieldSort).getByRole('option', { name: '客服备注：升序' })).toBeVisible();
    expect(within(fieldSort).queryByRole('option', { name: /已核验/u })).not.toBeInTheDocument();
    await user.selectOptions(fieldSort, `${orderTextField.id}:asc`);

    const builtInSort = screen.getByRole('combobox', { name: '排序方式' });
    expect(builtInSort).toHaveValue('');
    expect(within(builtInSort).getByRole('option', {
      name: '当前由自定义字段排序',
    })).toBeDisabled();

    await waitFor(() => expect(queryOrders).toHaveBeenCalledWith(expect.objectContaining({
      customFieldFilter: {
        definitionId: orderTextField.id,
        value: '加急',
      },
      customFieldSort: {
        definitionId: orderTextField.id,
        direction: 'asc',
      },
    }), []));

    await user.selectOptions(
      builtInSort,
      'amount:desc',
    );
    await waitFor(() => {
      const latestQuery = queryOrders.mock.calls.at(-1)?.[0];
      expect(latestQuery).toMatchObject({ sortField: 'amount', sortDirection: 'desc' });
      expect(latestQuery?.customFieldSort).toBeUndefined();
    });
  });

  it('商品视图可按商品级自定义字段筛选和排序并打开所属订单', async () => {
    const user = userEvent.setup();
    const queryOrderItems = vi.fn(async (_query: OrderItemWorkbenchQuery) => (
      itemWorkbenchResult()
    ));
    const getOrder = vi.fn().mockResolvedValue(details([
      orderTextField,
      itemTextField,
    ]));
    const api = createApi({
      listCustomFieldDefinitions: vi.fn().mockResolvedValue([
        orderTextField,
        itemTextField,
      ]),
      queryOrderItems,
      getOrder,
    });

    render(<App api={api} />);
    await user.click(await screen.findByRole('tab', { name: '商品' }));

    await waitFor(() => expect(queryOrderItems).toHaveBeenCalledWith({}, []));
    const fieldFilter = await screen.findByRole('combobox', {
      name: '商品自定义字段筛选',
    });
    expect(within(fieldFilter).getByRole('option', { name: '仓位' })).toBeVisible();
    expect(within(fieldFilter).queryByRole('option', { name: '客服备注' })).not.toBeInTheDocument();
    await user.selectOptions(fieldFilter, itemTextField.id);
    await user.type(screen.getByRole('textbox', { name: '商品自定义字段值' }), 'A-03');

    const fieldSort = screen.getByRole('combobox', {
      name: '商品自定义字段排序',
    });
    expect(within(fieldSort).getByRole('option', { name: '仓位：降序' })).toBeVisible();
    expect(within(fieldSort).queryByRole('option', { name: /客服备注/u })).not.toBeInTheDocument();
    await user.selectOptions(fieldSort, `${itemTextField.id}:desc`);

    await waitFor(() => expect(queryOrderItems).toHaveBeenCalledWith({
      customFieldFilter: {
        definitionId: itemTextField.id,
        value: 'A-03',
      },
      customFieldSort: {
        definitionId: itemTextField.id,
        direction: 'desc',
      },
    }, []));

    await user.click(screen.getByRole('button', {
      name: `打开商品 ${confirmedOrder.items[0].sourceTitle} 所属订单`,
    }));
    await waitFor(() => expect(getOrder).toHaveBeenCalledWith(confirmedOrder.id));
  });
});
