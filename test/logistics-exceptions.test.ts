import { describe, expect, it } from 'vitest';

import {
  prepareLogisticsCorrection,
  prepareLogisticsStatusChange,
  sameLogisticsExceptionImpact,
  type LogisticsStatusChangeFacts,
} from '../src/core/logistics-exceptions';

function facts(
  overrides: Partial<LogisticsStatusChangeFacts> = {},
): LogisticsStatusChangeFacts {
  return {
    direction: 'return',
    currentStatus: 'in_transit',
    nextStatus: 'lost',
    carrierAcceptedAt: null,
    physicalReceiptAt: null,
    carrierAcceptanceConfirmed: false,
    carrierConfirmedLoss: true,
    occurredAt: '2026-08-14T11:00:00+08:00',
    latestOccurredAt: '2026-08-14T10:30:00+08:00',
    impact: { scope: 'package' },
    availableItems: [{ sourceItemId: 'return-item-1', quantity: 2 }],
    ...overrides,
  };
}

describe('共同物流异常规则', () => {
  it('正向和退货包裹都不能在没有揽收证据时登记丢件', () => {
    for (const direction of ['outbound', 'return'] as const) {
      expect(() => prepareLogisticsStatusChange(facts({ direction })))
        .toThrow('没有承运方揽收证据，不能登记丢件');
    }
  });

  it('用同一套规则保护事件时序和已收到的实物事实', () => {
    expect(() => prepareLogisticsStatusChange(facts({
      carrierAcceptedAt: '2026-08-14T10:20:00+08:00',
      occurredAt: '2026-08-14T10:29:59+08:00',
    }))).toThrow('物流事件时间不能早于上一条事件');

    expect(() => prepareLogisticsStatusChange(facts({
      direction: 'outbound',
      carrierAcceptedAt: '2026-08-14T10:20:00+08:00',
      physicalReceiptAt: '2026-08-14T10:40:00+08:00',
      nextStatus: 'in_transit',
      carrierConfirmedLoss: false,
    }))).toThrow('已经收到的包裹不能回退到收件前状态');
  });

  it('商品级异常只接受包裹内的商品和不超量数量', () => {
    const shared = facts({
      carrierAcceptedAt: '2026-08-14T10:20:00+08:00',
      nextStatus: 'damaged',
      carrierConfirmedLoss: false,
    });
    expect(() => prepareLogisticsStatusChange({
      ...shared,
      impact: {
        scope: 'items',
        items: [{ sourceItemId: 'return-item-1', quantity: 3 }],
      },
    })).toThrow('物流异常商品数量不能超过包裹内数量');

    expect(() => prepareLogisticsStatusChange({
      ...shared,
      impact: {
        scope: 'items',
        items: [{ sourceItemId: 'other-item', quantity: 1 }],
      },
    })).toThrow('物流异常商品不属于当前包裹');

    expect(prepareLogisticsStatusChange({
      ...shared,
      impact: {
        scope: 'items',
        items: [{ sourceItemId: 'return-item-1', quantity: 1 }],
      },
    })).toMatchObject({
      nextStatus: 'damaged',
      impact: {
        scope: 'items',
        items: [{ sourceItemId: 'return-item-1', quantity: 1 }],
      },
    });
  });

  it('揽收证据一旦建立就不能回退为待承运方接收', () => {
    expect(() => prepareLogisticsStatusChange(facts({
      carrierAcceptedAt: '2026-08-14T10:20:00+08:00',
      nextStatus: 'awaiting_carrier',
      carrierConfirmedLoss: false,
    }))).toThrow('已有承运方揽收证据，不能登记为待承运方接收');
  });

  it('正向和退货物流信息更正共用变化与时间约束', () => {
    const shared = {
      current: { shippingCarrier: '顺丰', trackingNumber: 'SF001' },
      next: { shippingCarrier: '中通', trackingNumber: 'ZT001' },
      occurredAt: '2026-08-14T11:00:00+08:00',
      latestOccurredAt: '2026-08-14T10:30:00+08:00',
    };
    expect(prepareLogisticsCorrection(shared)).toEqual(shared.next);
    expect(() => prepareLogisticsCorrection({
      ...shared,
      next: shared.current,
    })).toThrow('物流信息没有变化');
    expect(() => prepareLogisticsCorrection({
      ...shared,
      occurredAt: '2026-08-14T10:29:59+08:00',
    })).toThrow('物流更正时间不能早于上一条物流事件');
  });

  it('按商品标识与数量判断异常影响范围是否相同', () => {
    expect(sameLogisticsExceptionImpact(
      { scope: 'items', items: [{ sourceItemId: 'item-1', quantity: 1 }] },
      { scope: 'items', items: [{ sourceItemId: 'item-1', quantity: 1 }] },
    )).toBe(true);
    expect(sameLogisticsExceptionImpact(
      { scope: 'items', items: [{ sourceItemId: 'item-1', quantity: 1 }] },
      { scope: 'items', items: [{ sourceItemId: 'item-1', quantity: 2 }] },
    )).toBe(false);
  });
});
