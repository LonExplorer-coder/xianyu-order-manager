// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesktopApi } from '../src/core/desktop-api';
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
    addresses: [],
    mergedIntoRecipientId: null,
    mergedReason: null,
    mergedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
    effectiveName: overrides.effectiveName ?? overrides.name,
  };
}
