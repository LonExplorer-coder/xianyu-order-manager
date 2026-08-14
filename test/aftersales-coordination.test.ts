import { describe, expect, it } from 'vitest';

import {
  coordinateAftersales,
  type AftersalesOutboundExceptionEvidence,
} from '../src/core/aftersales-coordination';

function exception(
  exceptionId: string,
  occurredAt: string,
  decided: boolean,
): AftersalesOutboundExceptionEvidence & {
  decisionTimeline: Parameters<typeof coordinateAftersales>[0]['outboundExceptions'] extends
    Array<infer Item> | undefined ? Item extends { decisionTimeline: infer Timeline }
      ? Timeline : never : never;
} {
  return {
    exceptionId,
    sourceShipmentRecordId: 'shipment-1',
    packageId: `package-${exceptionId}`,
    exceptionType: 'lost',
    stage: 'confirmed',
    affectedQuantity: 1,
    affectedItems: [{
      shipmentPackageItemId: `item-${exceptionId}`,
      sourceTitle: '测试商品',
      sourceSpec: '标准款',
      quantity: 1,
    }],
    occurredAt,
    decisionTimeline: decided ? [{
      kind: 'selected',
      exceptionId,
      packageId: `package-${exceptionId}`,
      before: null,
      after: 'wait_investigation',
      affectedItems: [{
        shipmentPackageItemId: `item-${exceptionId}`,
        sourceTitle: '测试商品',
        sourceSpec: '标准款',
        quantity: 1,
      }],
      occurredAt,
      reason: '先等待调查',
      createdAt: occurredAt,
    }] : [],
  };
}

describe('售后正向异常协调', () => {
  it('多个已确认异常时优先暴露尚未选择的事项', () => {
    const coordination = coordinateAftersales({
      handlingDirection: 'waiting',
      sourcePackages: [],
      interception: null,
      outboundExceptions: [
        exception('older-undecided', '2026-08-14T09:00:00+08:00', false),
        exception('newer-decided', '2026-08-14T10:00:00+08:00', true),
      ],
    });

    expect(coordination.outboundException?.exceptionId).toBe('older-undecided');
    expect(coordination.outboundExceptionHistory).toHaveLength(2);
  });
});
