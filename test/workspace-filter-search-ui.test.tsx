// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
import type { FulfillmentDemandView } from '../src/core/fulfillment-demand';
import type { FulfillmentPlanView } from '../src/core/fulfillment-plans';
import type { RecipientSummaryView } from '../src/core/recipients';
import { FulfillmentPlansWorkspace } from '../src/renderer/FulfillmentPlansWorkspace';
import { RecipientsWorkspace } from '../src/renderer/RecipientsWorkspace';

afterEach(() => cleanup());

describe('履约计划工作区筛选工具栏', () => {
  it('按计划名称搜索收窄列表并显示计数，清除后恢复', async () => {
    const user = userEvent.setup();
    renderPlans();

    expect(await screen.findByRole('heading', { name: '八月预售' })).toBeVisible();
    expect(screen.getByText('显示 5 / 5 个')).toBeVisible();

    await user.type(screen.getByRole('searchbox', { name: '搜索履约计划' }), '预售');
    expect(screen.getByText('显示 3 / 5 个')).toBeVisible();
    expect(screen.getByRole('heading', { name: '八月预售' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '白露预售' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '团购备货' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByText('显示 5 / 5 个')).toBeVisible();
    expect(screen.getByRole('heading', { name: '团购备货' })).toBeVisible();
  });

  it('按类型与派生状态筛选，具备释放条件为派生 ready 状态', async () => {
    const user = userEvent.setup();
    renderPlans();
    await screen.findByRole('heading', { name: '八月预售' });

    await user.selectOptions(screen.getByRole('combobox', { name: '类型' }), 'group_buy');
    expect(screen.getByText('显示 2 / 5 个')).toBeVisible();
    expect(screen.getByRole('heading', { name: '团购备货' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '已释放团购' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '八月预售' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: '类型' }), '');
    await user.selectOptions(screen.getByRole('combobox', { name: '状态' }), 'ready');
    expect(screen.getByText('显示 1 / 5 个')).toBeVisible();
    expect(screen.getByRole('heading', { name: '白露预售' })).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: '状态' }), 'closed');
    expect(screen.getByRole('heading', { name: '已关闭预售' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '白露预售' })).not.toBeInTheDocument();
  });

  it('筛选无结果时显示引导空态，清除后恢复列表', async () => {
    const user = userEvent.setup();
    renderPlans();
    await screen.findByRole('heading', { name: '八月预售' });

    await user.type(screen.getByRole('searchbox', { name: '搜索履约计划' }), '不存在的计划');
    expect(screen.getByText('显示 0 / 5 个')).toBeVisible();
    expect(screen.getByText('没有匹配的履约计划')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByRole('heading', { name: '八月预售' })).toBeVisible();
  });
});

describe('收件人工作区筛选工具栏', () => {
  it('按姓名、手机号片段、补零编号与地址搜索并显示计数', async () => {
    const user = userEvent.setup();
    renderRecipients();
    expect(await screen.findByRole('heading', { name: '张三' })).toBeVisible();
    expect(screen.getByText('显示 2 / 2 个')).toBeVisible();

    const search = screen.getByRole('searchbox', { name: '搜索收件人' });
    await user.type(search, '李四');
    expect(screen.getByText('显示 1 / 2 个')).toBeVisible();
    expect(screen.queryByRole('heading', { name: '张三' })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '3344');
    expect(screen.getByRole('heading', { name: '李四' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '张三' })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '002');
    expect(screen.getByRole('heading', { name: '李四' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '张三' })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '西湖区');
    expect(screen.getByRole('heading', { name: '李四' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '张三' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByText('显示 2 / 2 个')).toBeVisible();
    expect(screen.getByRole('heading', { name: '张三' })).toBeVisible();
  });

  it('收件人卡片呈现累计消费与累计退款', async () => {
    renderRecipients();
    expect(await screen.findByRole('heading', { name: '张三' })).toBeVisible();
    expect(screen.getByText(/累计消费 ¥123\.45/)).toBeVisible();
    expect(screen.getByText(/累计退款 ¥5\.00/)).toBeVisible();
  });

  it('搜索联动已合并区块并在无匹配时显示引导空态', async () => {
    const user = userEvent.setup();
    renderRecipients();
    expect(await screen.findByRole('heading', { name: '张三' })).toBeVisible();
    expect(screen.getByText('已合并（1）')).toBeVisible();

    const search = screen.getByRole('searchbox', { name: '搜索收件人' });
    await user.type(search, '张三');
    expect(screen.getByText('显示 1 / 2 个')).toBeVisible();
    expect(screen.queryByText('已合并（1）')).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '不存在的人');
    expect(screen.getByText('没有匹配的收件人')).toBeVisible();
    expect(screen.queryByText('已合并（1）')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByRole('heading', { name: '张三' })).toBeVisible();
    expect(screen.getByText('已合并（1）')).toBeVisible();
  });
});

describe('预售需求与采购建议区块', () => {
  it('展开预售计划呈现需求数字、阈值提醒、未映射提示与建议列表', async () => {
    const user = userEvent.setup();
    renderDemandPlans();

    await user.click(await screen.findByRole('button', { name: '订单与记录' }));
    expect(await screen.findByText('预售需求与采购建议')).toBeVisible();
    expect(screen.getByText((_, element) => (
      element?.className === 'fulfillment-plan-demand__totals'
      && element.textContent === '有效需求 12 件 · 退款/取消 2 件 · 现货可覆盖 0 件 · 采购在途 3 件 · 已到货 2 件 · 已确认建议 4 件 · 未确认建议 3 件 · 剩余缺口 6 件 · 待检查 0 件 · 已释放 1 单'
    ))).toBeVisible();
    expect(screen.getByText('玻璃保鲜盒（1000ml）未覆盖 6 件，达到提醒阈值')).toBeVisible();
    expect(screen.getByText(/已确认采购超过当前需求 1 件/)).toBeVisible();
    expect(screen.getByRole('table', { name: '计划关联的采购订单' })).toBeVisible();
    expect(
      within(screen.getByRole('table', { name: '计划关联的采购订单' }))
        .getByRole('row', { name: /#3 样品供应厂 已确认 5 2/ }),
    ).toBeVisible();
    expect(screen.getByText('已转采购订单')).toBeVisible();
    expect(screen.getByText(/未建档手作发夹（蓝色） × 2 · 涉及 1 单/)).toBeVisible();
    expect(screen.getByText(/请先在订单校对中关联标准商品或建立映射/)).toBeVisible();
    expect(screen.getAllByText(/待确认|已确认（采购意向）/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '登记发货前退款' })).toBeVisible();
    expect(screen.getByRole('button', { name: '确认' })).toBeVisible();
  });

  it('登记发货前退款提交商品数量与原因', async () => {
    const user = userEvent.setup();
    const registerFulfillmentRefund = vi.fn().mockResolvedValue(demandFixture());
    renderDemandPlans({ registerFulfillmentRefund });

    await user.click(await screen.findByRole('button', { name: '订单与记录' }));
    await screen.findByText('预售需求与采购建议');
    await user.click(screen.getByRole('button', { name: '登记发货前退款' }));
    await user.clear(screen.getByRole('spinbutton', { name: '退款数量' }));
    await user.type(screen.getByRole('spinbutton', { name: '退款数量' }), '1');
    await user.type(
      screen.getByRole('textbox', { name: /退款原因/ }),
      '买家退回1件',
    );
    await user.click(screen.getByRole('button', { name: '登记退款' }));
    expect(registerFulfillmentRefund).toHaveBeenCalledWith({
      planId: 'plan-demand',
      orderId: 'order-demand-1',
      orderItemId: 'item-demand-1',
      quantity: 1,
      reason: '买家退回1件',
    });
  });

  it('确认待确认建议需填写原因并计入已确认采购', async () => {
    const user = userEvent.setup();
    const confirmPurchaseSuggestion = vi.fn().mockResolvedValue(demandFixture());
    renderDemandPlans({ confirmPurchaseSuggestion });

    await user.click(await screen.findByRole('button', { name: '订单与记录' }));
    await screen.findByText('预售需求与采购建议');
    await user.click(screen.getByRole('button', { name: '确认' }));
    await user.type(
      screen.getByRole('textbox', { name: /确认原因/ }),
      '联系供应方下单',
    );
    await user.click(screen.getByRole('button', { name: '确认建议' }));
    expect(confirmPurchaseSuggestion).toHaveBeenCalledWith({
      planId: 'plan-demand',
      suggestionId: 'suggestion-draft',
      reason: '联系供应方下单',
    });
  });

  it('释放被拒时缺口明细显示在对话框内，勾选强制后可放行', async () => {
    const user = userEvent.setup();
    const releaseFulfillmentPlanOrders = vi.fn()
      .mockRejectedValueOnce(new Error(
        '可用现货不足：玻璃保鲜盒（1000ml）还差 2 件；可补货或到货后释放，或勾选知悉缺货风险强制释放',
      ))
      .mockResolvedValueOnce(plan({ id: 'plan-demand', name: '八月预售' }));
    renderDemandPlans({ releaseFulfillmentPlanOrders });

    await user.click(await screen.findByRole('button', { name: '订单与记录' }));
    await user.click(screen.getByRole('button', { name: '全部释放' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /操作原因/ }), '备货完成');
    await user.click(within(dialog).getByRole('button', { name: '确认释放' }));
    expect(within(dialog).getByText(/玻璃保鲜盒（1000ml）还差 2 件/)).toBeVisible();
    expect(within(dialog).getByRole('checkbox', { name: /我知悉可用现货不足/ })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox', { name: /我知悉可用现货不足/ }));
    await user.click(within(dialog).getByRole('button', { name: '确认释放' }));
    expect(releaseFulfillmentPlanOrders).toHaveBeenLastCalledWith(expect.objectContaining({
      acknowledgeStockShortageRisk: true,
    }));
  });

  it('全部释放经对话框提交并按勾选传递缺货风险确认', async () => {
    const user = userEvent.setup();
    const releaseFulfillmentPlanOrders = vi.fn().mockResolvedValue(
      plan({ id: 'plan-demand', name: '八月预售' }),
    );
    renderDemandPlans({ releaseFulfillmentPlanOrders });

    await user.click(await screen.findByRole('button', { name: '订单与记录' }));
    await user.click(screen.getByRole('button', { name: '全部释放' }));
    const checkbox = screen.getByRole('checkbox', { name: /我知悉可用现货不足的缺货风险/ });
    expect(checkbox).not.toBeChecked();
    await user.type(screen.getByRole('textbox', { name: /操作原因/ }), '备货完成');
    await user.click(screen.getByRole('button', { name: '确认释放' }));
    expect(releaseFulfillmentPlanOrders).toHaveBeenCalledWith(expect.objectContaining({
      orderIds: null,
      reason: '备货完成',
      acknowledgeStockShortageRisk: false,
    }));

    await user.click(await screen.findByRole('button', { name: '全部释放' }));
    await user.click(screen.getByRole('checkbox', { name: /我知悉可用现货不足的缺货风险/ }));
    await user.type(screen.getByRole('textbox', { name: /操作原因/ }), '买家催发强制释放');
    await user.click(screen.getByRole('button', { name: '确认释放' }));
    expect(releaseFulfillmentPlanOrders).toHaveBeenLastCalledWith(expect.objectContaining({
      reason: '买家催发强制释放',
      acknowledgeStockShortageRisk: true,
    }));
  });

  it('已确认建议可转入采购订单：对话框预填数量并提交供应方、单价与原因', async () => {
    const user = userEvent.setup();
    const createPurchaseOrderFromSuggestion = vi.fn().mockResolvedValue({
      suppliers: [],
      orders: [],
      supplierReturns: [],
    });
    renderDemandPlans({ createPurchaseOrderFromSuggestion });

    await user.click(await screen.findByRole('button', { name: '订单与记录' }));
    await screen.findByText('预售需求与采购建议');
    await user.click(screen.getByRole('button', { name: '转入采购订单' }));
    expect(await screen.findByText(/转入采购订单 · 八月预售/)).toBeVisible();
    await user.clear(screen.getByRole('spinbutton', { name: '采购数量' }));
    await user.type(screen.getByRole('spinbutton', { name: '采购数量' }), '4');
    await user.type(screen.getByRole('textbox', { name: '采购单价' }), '12.50');
    await user.type(
      screen.getByRole('textbox', { name: /转入原因/ }),
      '第一批下单',
    );
    const submit = screen.getByRole('button', { name: '创建采购订单草稿' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('交期'), '2026-09-10T10:00');
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(createPurchaseOrderFromSuggestion).toHaveBeenCalledWith({
      suggestionId: 'suggestion-confirmed',
      supplierId: 'supplier-1',
      quantity: 4,
      unitPriceCents: 1250,
      expectedAt: '2026-09-10T10:00',
      reason: '第一批下单',
    });
  });
});

describe('团购成团与条件性需求区块', () => {
  function groupBuyMember(
    orderId: string,
    platformTransactionStatus: string,
  ): FulfillmentPlanView['members'][number] {
    return {
      orderId,
      systemOrderNumber: `XY2608-${orderId.slice(-4)}`,
      platformOrderNumber: `XY-GB-${orderId.slice(-4)}`,
      buyerNickname: '团购买家',
      platformTransactionStatus,
      joinedAt: '2026-08-10T08:00:00.000Z',
      joinReason: '加入团购',
      releasedAt: null,
      releasedReason: null,
      removedAt: null,
      removedReason: null,
      items: [{
        itemId: `item-${orderId}`,
        sourceTitle: '玻璃保鲜盒',
        sourceSpec: '1000ml',
        quantity: 2,
      }],
    };
  }

  function renderGroupBuyPlans(
    planOverrides: Partial<FulfillmentPlanView>,
    apiOverrides: Record<string, unknown> = {},
  ): void {
    const api = {
      queryFulfillmentPlans: vi.fn().mockResolvedValue([
        plan({
          id: 'plan-groupbuy-test',
          name: '处暑团购',
          type: 'group_buy',
          ...planOverrides,
        }),
      ]),
      queryFulfillmentPlanProgress: vi.fn(
        async (planId: string) => ({ planId, orders: [] }),
      ),
      queryFulfillmentDemand: vi.fn().mockResolvedValue(demandFixture()),
      getReadableOrderNumbers: vi.fn().mockResolvedValue({}),
      ...apiOverrides,
    } as unknown as DesktopApi;
    render(<FulfillmentPlansWorkspace api={api} />);
  }

  it('未成团团购展示确认成团入口，依据与原因经对话框提交', async () => {
    const user = userEvent.setup();
    const confirmGroupFormation = vi.fn().mockResolvedValue(
      plan({
        id: 'plan-groupbuy-test',
        name: '处暑团购',
        type: 'group_buy',
        formedAt: '2026-08-18T08:00:00.000Z',
      }),
    );
    renderGroupBuyPlans({
      targetQuantity: 2,
      activeOrderCount: 1,
      activeItemQuantity: 2,
      members: [groupBuyMember('order-gb-1', 'paid')],
    }, { confirmGroupFormation });

    expect(await screen.findByText('团购·待成团')).toBeVisible();
    expect(screen.getByText(/具备成团条件，请人工确认成团/)).toBeVisible();
    expect(screen.getByRole('button', { name: '加入订单' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '全部释放' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '确认成团' }));
    expect(screen.getByRole('radio', { name: /已达成团数量（2\/2 件）/ })).toBeChecked();
    await user.type(screen.getByRole('textbox', { name: /成团原因/ }), '到量成团');
    const submitButtons = screen.getAllByRole('button', { name: '确认成团' });
    await user.click(submitButtons[submitButtons.length - 1]);
    expect(confirmGroupFormation).toHaveBeenCalledWith(
      expect.objectContaining({ basis: 'quantity', reason: '到量成团' }),
    );
  });

  it('条件性需求标注预测口径，提前采购必须勾选风险确认', async () => {
    const user = userEvent.setup();
    const createPurchaseSuggestion = vi.fn().mockResolvedValue(demandFixture());
    renderGroupBuyPlans({
      targetQuantity: 10,
      activeOrderCount: 1,
      activeItemQuantity: 2,
      members: [groupBuyMember('order-gb-2', 'paid')],
    }, {
      createPurchaseSuggestion,
      queryFulfillmentDemand: vi.fn().mockResolvedValue({
        ...demandFixture(),
        conditional: true,
      }),
    });

    await user.click(await screen.findByRole('button', { name: '订单与记录' }));
    expect(await screen.findByText('条件性团购需求（预测）与采购建议')).toBeVisible();
    expect(screen.getByText((_, element) => (
      element?.className === 'fulfillment-plan-demand__totals'
      && element.textContent === '条件性需求 12 件 · 退款/取消 2 件 · 现货可覆盖 0 件 · 采购在途 3 件 · 已到货 2 件 · 已确认建议 4 件 · 未确认建议 3 件 · 预测缺口 6 件 · 待检查 0 件 · 已释放 1 单'
    ))).toBeVisible();

    const generateButtons = screen.getAllByRole('button', { name: '生成采购建议' });
    await user.click(generateButtons[0]);
    expect(screen.getByText(/该团购计划尚未确认成团/)).toBeVisible();
    const submit = screen.getByRole('button', { name: '生成建议' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole('spinbutton', { name: '建议数量' }), '2');
    await user.type(screen.getByRole('textbox', { name: /生成原因/ }), '供应方交期长');
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /我知悉未成团库存风险/ }));
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(createPurchaseSuggestion).toHaveBeenCalledWith(expect.objectContaining({
      quantity: 2,
      reason: '供应方交期长',
      acknowledgeUnformedRisk: true,
    }));
  });

  it('未成团关闭的团购展示待退款清单，平台已退款订单移出口径', async () => {
    const user = userEvent.setup();
    renderGroupBuyPlans({
      status: 'closed',
      closedAt: '2026-08-18T00:00:00.000Z',
      targetQuantity: 10,
      activeOrderCount: 2,
      activeItemQuantity: 4,
      members: [
        groupBuyMember('order-gb-3', 'paid'),
        groupBuyMember('order-gb-4', 'refunded'),
      ],
    });

    expect(await screen.findByText('未成团已关闭')).toBeVisible();
    expect(screen.getByText(/未成团已关闭，成员订单待退款/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '订单与记录' }));
    expect(await screen.findByRole('heading', { name: '待退款清单' })).toBeVisible();
    expect(screen.getByText(/XY2608-gb-3 · 团购买家 · 玻璃保鲜盒 1000ml × 2 件/)).toBeVisible();
    expect(screen.queryByText(/XY2608-gb-4 · 团购买家/)).not.toBeInTheDocument();
    expect(screen.queryByText(/预售需求与采购建议/)).not.toBeInTheDocument();
    expect(screen.queryByText(/条件性团购需求/)).not.toBeInTheDocument();
  });
});

function demandFixture(): FulfillmentDemandView {
  return {
    planId: 'plan-demand',
    planName: '八月预售',
    conditional: false,
    demandAlertThreshold: 5,
    products: [{
      standardProductId: 'product-1',
      sku: 'SKU-DEMAND-A',
      name: '玻璃保鲜盒',
      specification: '1000ml',
      demandQuantity: 10,
      refundedOrCancelledQuantity: 2,
      sellableCoveredQuantity: 0,
      confirmedInTransitQuantity: 0,
      arrivedQuantity: 0,
      confirmedSuggestionQuantity: 4,
      draftSuggestionQuantity: 3,
      uncoveredQuantity: 6,
      overPurchaseRisk: false,
      draftExceedsUncovered: false,
    }, {
      standardProductId: 'product-2',
      sku: 'SKU-DEMAND-B',
      name: '硅胶封口夹',
      specification: '大号',
      demandQuantity: 2,
      refundedOrCancelledQuantity: 0,
      sellableCoveredQuantity: 0,
      confirmedInTransitQuantity: 3,
      arrivedQuantity: 2,
      confirmedSuggestionQuantity: 0,
      draftSuggestionQuantity: 0,
      uncoveredQuantity: 0,
      overPurchaseRisk: true,
      draftExceedsUncovered: false,
    }],
    unmapped: [{
      sourceTitle: '未建档手作发夹',
      sourceSpec: '蓝色',
      quantity: 2,
      orderCount: 1,
    }],
    suggestions: [
      {
        id: 'suggestion-confirmed',
        planId: 'plan-demand',
        standardProductId: 'product-1',
        sku: 'SKU-DEMAND-A',
        name: '玻璃保鲜盒',
        specification: '1000ml',
        quantity: 4,
        status: 'confirmed',
        createdAt: '2026-08-10T08:00:00.000Z',
        confirmedAt: '2026-08-11T08:00:00.000Z',
        cancelledAt: null,
        cancelReason: null,
        riskAcknowledgedAt: null,
        purchaseOrderId: null,
      },
      {
        id: 'suggestion-draft',
        planId: 'plan-demand',
        standardProductId: 'product-1',
        sku: 'SKU-DEMAND-A',
        name: '玻璃保鲜盒',
        specification: '1000ml',
        quantity: 3,
        status: 'draft',
        createdAt: '2026-08-12T08:00:00.000Z',
        confirmedAt: null,
        cancelledAt: null,
        cancelReason: null,
        riskAcknowledgedAt: null,
        purchaseOrderId: null,
      },
      {
        id: 'suggestion-converted',
        planId: 'plan-demand',
        standardProductId: 'product-2',
        sku: 'SKU-DEMAND-B',
        name: '硅胶封口夹',
        specification: '大号',
        quantity: 5,
        status: 'converted',
        createdAt: '2026-08-13T08:00:00.000Z',
        confirmedAt: '2026-08-13T08:10:00.000Z',
        cancelledAt: null,
        cancelReason: null,
        riskAcknowledgedAt: null,
        purchaseOrderId: 'order-purchase-1',
      },
    ],
    linkedPurchaseOrders: [{
      orderId: 'order-purchase-1',
      sequence: 3,
      status: 'confirmed',
      supplierName: '样品供应厂',
      expectedAt: '2026-08-20T08:00:00.000Z',
      orderedQuantity: 5,
      arrivedQuantity: 2,
    }],
    totals: {
      demandQuantity: 12,
      refundedOrCancelledQuantity: 2,
      sellableCoveredQuantity: 0,
      confirmedInTransitQuantity: 3,
      arrivedQuantity: 2,
      confirmedSuggestionQuantity: 4,
      draftSuggestionQuantity: 3,
      uncoveredQuantity: 6,
      pendingInspectionQuantity: 0,
      releasedOrderCount: 1,
    },
  };
}

function renderDemandPlans(overrides: Record<string, unknown> = {}): void {
  const api = {
    queryFulfillmentPlans: vi.fn().mockResolvedValue([
      plan({
        id: 'plan-demand',
        name: '八月预售',
        expectedShipAt: '2099-01-01T00:00:00.000Z',
        demandAlertThreshold: 5,
        activeOrderCount: 1,
        activeItemQuantity: 10,
        members: [{
          orderId: 'order-demand-1',
          systemOrderNumber: 'XY2608-0001',
          platformOrderNumber: 'XY-DEMAND-0001',
          buyerNickname: '测试买家',
          platformTransactionStatus: 'paid',
          joinedAt: '2026-08-10T08:00:00.000Z',
          joinReason: '加入预售',
          releasedAt: null,
          releasedReason: null,
          removedAt: null,
          removedReason: null,
          items: [{
            itemId: 'item-demand-1',
            sourceTitle: '玻璃保鲜盒',
            sourceSpec: '1000ml',
            quantity: 10,
          }],
        }],
      }),
    ]),
    queryFulfillmentPlanProgress: vi.fn(
      async (planId: string) => ({ planId, orders: [] }),
    ),
    queryFulfillmentDemand: vi.fn().mockResolvedValue(demandFixture()),
    getReadableOrderNumbers: vi.fn().mockResolvedValue({}),
    registerFulfillmentRefund: vi.fn(),
    createPurchaseSuggestion: vi.fn(),
    confirmPurchaseSuggestion: vi.fn(),
    cancelPurchaseSuggestion: vi.fn(),
    queryPurchases: vi.fn().mockResolvedValue({
      suppliers: [{
        supplierId: 'supplier-1',
        name: '样品供应厂',
        contact: null,
        note: null,
        createdAt: '2026-08-10T08:00:00.000Z',
      }],
      orders: [],
      supplierReturns: [],
    }),
    createPurchaseOrderFromSuggestion: vi.fn().mockResolvedValue({
      suppliers: [],
      orders: [],
      supplierReturns: [],
    }),
    ...overrides,
  } as unknown as DesktopApi;
  render(<FulfillmentPlansWorkspace api={api} />);
}

function renderPlans(): void {
  const api = {
    queryFulfillmentPlans: vi.fn().mockResolvedValue(planFixtures()),
    queryFulfillmentPlanProgress: vi.fn(
      async (planId: string) => ({ planId, orders: [] }),
    ),
    getReadableOrderNumbers: vi.fn().mockResolvedValue({}),
  } as unknown as DesktopApi;
  render(<FulfillmentPlansWorkspace api={api} />);
}

function renderRecipients(): void {
  const api = {
    queryRecipients: vi.fn().mockResolvedValue(recipientFixtures()),
    queryRecipientOrders: vi.fn().mockResolvedValue([]),
    mergeRecipients: vi.fn(),
  } as unknown as DesktopApi;
  render(<RecipientsWorkspace api={api} />);
}

function planFixtures(): FulfillmentPlanView[] {
  return [
    plan({
      id: 'plan-presale-pending',
      name: '八月预售',
      expectedShipAt: '2099-01-01T00:00:00.000Z',
    }),
    plan({
      id: 'plan-group-pending',
      type: 'group_buy',
      name: '团购备货',
      expectedShipAt: null,
      targetQuantity: 5,
    }),
    plan({
      id: 'plan-ready',
      name: '白露预售',
      expectedShipAt: '2020-01-01T00:00:00.000Z',
    }),
    plan({
      id: 'plan-closed',
      name: '已关闭预售',
      status: 'closed',
      closedAt: '2026-08-01T00:00:00.000Z',
    }),
    plan({
      id: 'plan-released',
      type: 'group_buy',
      name: '已释放团购',
      status: 'released',
      targetQuantity: 5,
      expectedShipAt: null,
    }),
  ];
}

function plan(overrides: Partial<FulfillmentPlanView> & { id: string; name: string }): FulfillmentPlanView {
  return {
    type: 'presale',
    status: 'pending',
    expectedShipAt: null,
    targetQuantity: null,
    deadlineAt: null,
    demandAlertThreshold: null,
    formedAt: null,
    revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    closedAt: null,
    members: [],
    events: [],
    activeOrderCount: 0,
    activeItemQuantity: 0,
    releasedOrderCount: 0,
    ...overrides,
  };
}

function recipientFixtures(): RecipientSummaryView[] {
  return [
    recipient({
      id: 'recipient-1',
      recipientNumber: 1,
      name: '张三',
      phoneNormalized: '13900000001',
      orderCount: 2,
      totalSpendCents: 12_345,
      totalRefundCents: 500,
      addresses: ['广东省深圳市南山区甲路1号'],
    }),
    recipient({
      id: 'recipient-2',
      recipientNumber: 2,
      name: '李四',
      phoneNormalized: '13911113344',
      orderCount: 1,
      addresses: ['浙江省杭州市西湖区乙路2号'],
    }),
    recipient({
      id: 'recipient-3',
      recipientNumber: 3,
      name: '王五',
      effectiveName: '李四',
      phoneNormalized: '13900000033',
      orderCount: 0,
      addresses: [],
      mergedIntoRecipientId: 'recipient-1',
      mergedReason: '同一买家',
      mergedAt: '2026-08-02T00:00:00.000Z',
    }),
  ];
}

function recipient(
  overrides: Partial<RecipientSummaryView> & { id: string; recipientNumber: number; name: string },
): RecipientSummaryView {
  return {
    displayName: null,
    phoneNormalized: '',
    orderCount: 0,
    totalSpendCents: 0,
    totalRefundCents: 0,
    addresses: [],
    mergedIntoRecipientId: null,
    mergedReason: null,
    mergedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
    effectiveName: overrides.effectiveName ?? overrides.name,
  };
}
