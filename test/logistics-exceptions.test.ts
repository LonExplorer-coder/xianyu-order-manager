import { describe, expect, it } from 'vitest';

import {
  prepareLogisticsCorrection,
  prepareLogisticsExceptionOpening,
  prepareLogisticsExceptionProgress,
  prepareLogisticsStatusChange,
  sameLogisticsExceptionImpact,
  supportsCarrierClaim,
  type LogisticsStatusChangeFacts,
} from '../src/core/logistics-exceptions';

function statusFacts(
  overrides: Partial<LogisticsStatusChangeFacts> = {},
): LogisticsStatusChangeFacts {
  return {
    direction: 'return',
    currentStatus: 'awaiting_carrier',
    nextStatus: 'in_transit',
    carrierAcceptedAt: null,
    physicalReceiptAt: null,
    carrierAcceptanceConfirmed: true,
    occurredAt: '2026-08-14T11:00:00+08:00',
    latestOccurredAt: '2026-08-14T10:30:00+08:00',
    ...overrides,
  };
}

describe('共同物流事实与异常事项规则', () => {
  it('正常运输状态只描述包裹位置进展并保护证据与时序', () => {
    expect(prepareLogisticsStatusChange(statusFacts())).toEqual({
      nextStatus: 'in_transit',
      carrierAcceptedAt: '2026-08-14T11:00:00+08:00',
    });
    expect(() => prepareLogisticsStatusChange(statusFacts({
      occurredAt: '2026-08-14T10:29:59+08:00',
    }))).toThrow('物流事件时间不能早于上一条事件');
    expect(() => prepareLogisticsStatusChange(statusFacts({
      carrierAcceptedAt: '2026-08-14T10:20:00+08:00',
      nextStatus: 'awaiting_carrier',
      carrierAcceptanceConfirmed: false,
    }))).toThrow('已有承运方揽收证据，不能登记为待承运方接收');
    expect(() => prepareLogisticsStatusChange(statusFacts({
      currentStatus: 'delivered',
      nextStatus: 'in_transit',
      physicalReceiptAt: '2026-08-14T10:40:00+08:00',
    }))).toThrow('已收到或检查的退货包裹不能回退到收件前的物流状态');
  });

  it('正向和退货包裹共用异常登记、影响范围与丢件证据约束', () => {
    expect(() => prepareLogisticsExceptionOpening({
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      availableItems: [{ sourceItemId: 'item-1', quantity: 2 }],
      occurredAt: '2026-08-14T11:00:00+08:00',
      evidence: {
        carrierAcceptedAt: null,
        physicalReceiptAt: null,
        carrierConfirmedLoss: true,
      },
    })).toThrow('没有承运方揽收证据');
    expect(() => prepareLogisticsExceptionOpening({
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      availableItems: [{ sourceItemId: 'item-1', quantity: 2 }],
      occurredAt: '2026-08-14T11:00:00+08:00',
      evidence: {
        carrierAcceptedAt: '2026-08-14T10:20:00+08:00',
        physicalReceiptAt: null,
        carrierConfirmedLoss: true,
      },
    })).not.toThrow();
    expect(() => prepareLogisticsExceptionOpening({
      exceptionType: 'lost',
      stage: 'confirmed',
      impact: { scope: 'package' },
      availableItems: [{ sourceItemId: 'item-1', quantity: 2 }],
      occurredAt: '2026-08-14T11:00:00+08:00',
      evidence: {
        carrierAcceptedAt: '2026-08-14T11:00:01+08:00',
        physicalReceiptAt: null,
        carrierConfirmedLoss: true,
      },
    })).toThrow('丢件确认时间不能早于承运方揽收时间');
    expect(() => prepareLogisticsExceptionOpening({
      exceptionType: 'damaged',
      stage: 'pending_verification',
      impact: { scope: 'items', items: [{ sourceItemId: 'item-1', quantity: 3 }] },
      availableItems: [{ sourceItemId: 'item-1', quantity: 2 }],
      occurredAt: '2026-08-14T11:00:00+08:00',
      evidence: {
        carrierAcceptedAt: '2026-08-14T10:20:00+08:00',
        physicalReceiptAt: null,
        carrierConfirmedLoss: false,
      },
    })).toThrow('物流异常商品数量不能超过包裹内数量');
    expect(() => prepareLogisticsExceptionOpening({
      exceptionType: 'damaged',
      stage: 'pending_verification',
      impact: { scope: 'items', items: [{ sourceItemId: 'item-1', quantity: 1 }] },
      availableItems: [{ sourceItemId: 'item-1', quantity: 2 }],
      occurredAt: '2026-08-14T11:00:00+08:00',
      evidence: {
        carrierAcceptedAt: '2026-08-14T10:20:00+08:00',
        physicalReceiptAt: null,
        carrierConfirmedLoss: false,
      },
    })).not.toThrow();
    expect(() => prepareLogisticsExceptionOpening({
      exceptionType: 'damaged',
      stage: 'investigating',
      impact: { scope: 'items', items: [{ sourceItemId: 'item-1', quantity: 1 }] },
      availableItems: [{ sourceItemId: 'item-1', quantity: 2 }],
      occurredAt: '2026-08-14T11:10:00+08:00',
      evidence: {
        carrierAcceptedAt: '2026-08-14T10:20:00+08:00',
        physicalReceiptAt: '2026-08-14T11:05:00+08:00',
        carrierConfirmedLoss: false,
      },
    })).not.toThrow();
  });

  it('异常阶段只允许向前推进，丢件可找回且终态不可再改', () => {
    const shared = {
      exceptionType: 'lost' as const,
      occurredAt: '2026-08-14T11:00:00+08:00',
      latestOccurredAt: '2026-08-14T10:30:00+08:00',
      evidence: {
        carrierAcceptedAt: '2026-08-14T10:20:00+08:00',
        physicalReceiptAt: null,
        carrierConfirmedLoss: true,
      },
    };
    expect(() => prepareLogisticsExceptionProgress({
      ...shared,
      currentStage: 'pending_verification',
      nextStage: 'confirmed',
    })).not.toThrow();
    expect(() => prepareLogisticsExceptionProgress({
      ...shared,
      currentStage: 'confirmed',
      nextStage: 'recovered',
    })).not.toThrow();
    expect(() => prepareLogisticsExceptionProgress({
      ...shared,
      currentStage: 'resolved',
      nextStage: 'investigating',
    })).toThrow('物流异常处理阶段不能这样推进');
    expect(() => prepareLogisticsExceptionProgress({
      ...shared,
      exceptionType: 'damaged',
      currentStage: 'confirmed',
      nextStage: 'recovered',
    })).toThrow('只有丢件异常可以登记已找回');
  });

  it('承运索赔只接受已确认异常事项', () => {
    expect(supportsCarrierClaim({ exceptionType: 'damaged', stage: 'confirmed' })).toBe(true);
    expect(supportsCarrierClaim({
      exceptionType: 'damaged',
      stage: 'pending_verification',
    })).toBe(false);
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
