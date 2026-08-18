import { describe, expect, it } from 'vitest';

import {
  fulfillmentPlanDisplayStatus,
  fulfillmentPlanStatusAfterRelease,
  fulfillmentPlanStatusLabel,
  fulfillmentPlanTodo,
  isFulfillmentPlanReleaseReady,
  normalizeAddFulfillmentPlanOrdersInput,
  normalizeCloseFulfillmentPlanInput,
  normalizeCreateFulfillmentPlanInput,
  normalizeFulfillmentPlanId,
  normalizeReleaseFulfillmentPlanOrdersInput,
  normalizeRemoveFulfillmentPlanOrderInput,
  normalizeUpdateFulfillmentPlanInput,
  type FulfillmentPlanView,
} from '../src/core/fulfillment-plans';

const NOW = '2026-08-14T10:00:00.000Z';

function planView(overrides: Partial<FulfillmentPlanView> = {}): FulfillmentPlanView {
  return {
    id: 'plan-1',
    type: 'presale',
    name: '八月预售',
    status: 'pending',
    expectedShipAt: '2026-08-20T00:00:00.000Z',
    targetQuantity: null,
    deadlineAt: null,
    demandAlertThreshold: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    members: [],
    events: [],
    activeOrderCount: 0,
    activeItemQuantity: 0,
    releasedOrderCount: 0,
    ...overrides,
  };
}

describe('履约计划输入规范化', () => {
  it('规范化履约计划标识', () => {
    expect(normalizeFulfillmentPlanId(' plan-1 ')).toBe('plan-1');
    expect(() => normalizeFulfillmentPlanId(' ')).toThrow('履约计划标识无效');
    expect(() => normalizeFulfillmentPlanId(42)).toThrow('履约计划标识无效');
  });
  it('接受带预计发货时间的预售计划', () => {
    expect(normalizeCreateFulfillmentPlanInput({
      type: 'presale',
      name: '  八月预售  ',
      expectedShipAt: '2026-08-20T00:00:00.000Z',
      reason: '预售开始备货',
    })).toEqual({
      type: 'presale',
      name: '八月预售',
      expectedShipAt: '2026-08-20T00:00:00.000Z',
      targetQuantity: null,
      deadlineAt: null,
      demandAlertThreshold: null,
      reason: '预售开始备货',
    });
  });

  it('接受带成团数量与截止时间的团购计划', () => {
    expect(normalizeCreateFulfillmentPlanInput({
      type: 'group_buy',
      name: '团购批次A',
      targetQuantity: 30,
      deadlineAt: '2026-08-31T00:00:00.000Z',
      reason: '开团',
    })).toMatchObject({ type: 'group_buy', targetQuantity: 30 });
  });

  it('拒绝缺少计划条件的创建', () => {
    expect(() => normalizeCreateFulfillmentPlanInput({
      type: 'presale',
      name: '八月预售',
      reason: '预售开始备货',
    })).toThrow('预售计划需要预计发货时间');
    expect(() => normalizeCreateFulfillmentPlanInput({
      type: 'group_buy',
      name: '团购批次A',
      reason: '开团',
    })).toThrow('团购计划需要成团数量或截止时间');
  });

  it('拒绝空名称、未知类型与空原因', () => {
    expect(() => normalizeCreateFulfillmentPlanInput({
      type: 'presale', name: '  ', expectedShipAt: '2026-08-20T00:00:00.000Z', reason: 'r',
    })).toThrow('请填写 1 至 100 字的履约计划名称');
    expect(() => normalizeCreateFulfillmentPlanInput({
      type: 'flash_sale', name: 'n', expectedShipAt: '2026-08-20T00:00:00.000Z', reason: 'r',
    })).toThrow('履约计划类型无效');
    expect(() => normalizeCreateFulfillmentPlanInput({
      type: 'presale', name: 'n', expectedShipAt: '2026-08-20T00:00:00.000Z', reason: '  ',
    })).toThrow('请填写非空原因');
  });

  it('拒绝无效时间与非法成团数量', () => {
    expect(() => normalizeCreateFulfillmentPlanInput({
      type: 'presale', name: 'n', expectedShipAt: '不是时间', reason: 'r',
    })).toThrow('预计发货时间无效');
    expect(() => normalizeCreateFulfillmentPlanInput({
      type: 'group_buy', name: 'n', targetQuantity: 0, reason: 'r',
    })).toThrow('成团数量无效');
  });

  it('规范化加入、退出、释放、更新与关闭输入并要求非空原因', () => {
    expect(normalizeAddFulfillmentPlanOrdersInput({
      planId: 'plan-1', expectedRevision: 1, orderIds: ['o1', 'o2'], reason: '加入预售',
    })).toEqual({
      planId: 'plan-1', expectedRevision: 1, orderIds: ['o1', 'o2'], reason: '加入预售',
    });
    expect(() => normalizeAddFulfillmentPlanOrdersInput({
      planId: 'plan-1', expectedRevision: 1, orderIds: [], reason: '加入预售',
    })).toThrow('请选择要加入的订单');
    expect(normalizeRemoveFulfillmentPlanOrderInput({
      planId: 'plan-1', expectedRevision: 2, orderId: 'o1', reason: '买家取消预售',
    })).toMatchObject({ orderId: 'o1', reason: '买家取消预售' });
    expect(normalizeReleaseFulfillmentPlanOrdersInput({
      planId: 'plan-1', expectedRevision: 2, reason: '到货可发',
    })).toEqual({
      planId: 'plan-1', expectedRevision: 2, orderIds: null, reason: '到货可发',
    });
    expect(() => normalizeReleaseFulfillmentPlanOrdersInput({
      planId: 'plan-1', expectedRevision: 2, orderIds: ['o1'], reason: ' ',
    })).toThrow('请填写非空原因');
    expect(normalizeUpdateFulfillmentPlanInput({
      planId: 'plan-1', expectedRevision: 3,
      expectedShipAt: '2026-09-01T00:00:00.000Z', markDelayed: true, reason: '供应方延期',
    })).toMatchObject({ markDelayed: true });
    expect(normalizeCloseFulfillmentPlanInput({
      planId: 'plan-1', expectedRevision: 3, reason: '未成团关闭',
    })).toEqual({ planId: 'plan-1', expectedRevision: 3, reason: '未成团关闭' });
  });
});

describe('履约计划释放条件', () => {
  it('预售到达预计发货时间才具备释放条件', () => {
    const plan = planView({ expectedShipAt: '2026-08-20T00:00:00.000Z' });
    expect(isFulfillmentPlanReleaseReady(plan, 0, '2026-08-19T23:59:59.000Z')).toBe(false);
    expect(isFulfillmentPlanReleaseReady(plan, 0, '2026-08-20T00:00:00.000Z')).toBe(true);
  });

  it('团购按成员商品数量达到成团数量具备释放条件', () => {
    const plan = planView({ type: 'group_buy', expectedShipAt: null, targetQuantity: 30 });
    expect(isFulfillmentPlanReleaseReady(plan, 18, NOW)).toBe(false);
    expect(isFulfillmentPlanReleaseReady(plan, 30, NOW)).toBe(true);
    expect(isFulfillmentPlanReleaseReady(plan, 31, NOW)).toBe(true);
  });

  it('团购到达截止时间后具备释放条件并提示人工确认', () => {
    const plan = planView({
      type: 'group_buy',
      expectedShipAt: null,
      targetQuantity: null,
      deadlineAt: '2026-08-20T00:00:00.000Z',
    });
    expect(isFulfillmentPlanReleaseReady(plan, 5, '2026-08-19T23:59:59.000Z')).toBe(false);
    expect(fulfillmentPlanTodo(plan, 5, '2026-08-19T23:59:59.000Z'))
      .toBe('待成团，到达截止时间后由人工确认');
    expect(isFulfillmentPlanReleaseReady(plan, 5, '2026-08-20T00:00:00.000Z')).toBe(true);
    expect(fulfillmentPlanDisplayStatus(plan, 5, '2026-08-20T00:00:00.000Z')).toBe('ready');
    expect(fulfillmentPlanTodo(plan, 5, '2026-08-20T00:00:00.000Z')).toContain('人工确认释放');
  });

  it('已释放与已关闭计划不再具备释放条件', () => {
    const released = planView({ status: 'released', expectedShipAt: '2026-08-01T00:00:00.000Z' });
    const closed = planView({ status: 'closed', expectedShipAt: '2026-08-01T00:00:00.000Z' });
    expect(isFulfillmentPlanReleaseReady(released, 0, NOW)).toBe(false);
    expect(isFulfillmentPlanReleaseReady(closed, 0, NOW)).toBe(false);
  });
});

describe('履约计划展示状态与待办', () => {
  it('到达条件但未人工释放时展示为具备释放条件', () => {
    const plan = planView({ expectedShipAt: '2026-08-01T00:00:00.000Z' });
    expect(fulfillmentPlanDisplayStatus(plan, 0, NOW)).toBe('ready');
    expect(fulfillmentPlanStatusLabel(plan.type, 'ready')).toBe('预售·具备释放条件');
    expect(fulfillmentPlanTodo(plan, 0, NOW)).toContain('人工确认释放');
  });

  it('团购展示成团进度与待成团待办', () => {
    const plan = planView({ type: 'group_buy', expectedShipAt: null, targetQuantity: 30 });
    expect(fulfillmentPlanDisplayStatus(plan, 18, NOW)).toBe('pending');
    expect(fulfillmentPlanStatusLabel(plan.type, 'pending')).toBe('团购·待成团');
    expect(fulfillmentPlanTodo(plan, 18, NOW)).toBe('待成团（18/30）');
    expect(fulfillmentPlanStatusLabel(plan.type, 'ready')).toBe('团购·已成团待释放');
    expect(fulfillmentPlanStatusLabel(plan.type, 'closed')).toBe('未成团已关闭');
  });

  it('延期与部分释放状态按类型给出标签', () => {
    expect(fulfillmentPlanStatusLabel('presale', 'delayed')).toBe('预售·已延期');
    expect(fulfillmentPlanStatusLabel('presale', 'partially_released')).toBe('预售·部分已释放');
    expect(fulfillmentPlanStatusLabel('presale', 'released')).toBe('已释放待发货');
    expect(fulfillmentPlanStatusLabel('presale', 'closed')).toBe('预售·已关闭');
  });
});

describe('整单释放后的计划状态', () => {
  it('全部成员释放后计划为已释放，否则部分释放', () => {
    expect(fulfillmentPlanStatusAfterRelease(3, 3)).toBe('released');
    expect(fulfillmentPlanStatusAfterRelease(3, 1)).toBe('partially_released');
    expect(() => fulfillmentPlanStatusAfterRelease(3, 0)).toThrow('请选择要释放的订单');
    expect(() => fulfillmentPlanStatusAfterRelease(3, 4)).toThrow('释放订单超出计划成员');
  });
});
