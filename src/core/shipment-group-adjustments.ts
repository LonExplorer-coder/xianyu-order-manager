import type { ShipmentGroupProjection } from './shipment-groups';
import { shipmentMatchKeyIdentity } from './shipment-groups';

export type ShipmentGroupAdjustmentOperation = 'split' | 'merge';

export type ShipmentGroupAdjustmentEvent = {
  id: string;
  operation: ShipmentGroupAdjustmentOperation;
  reason: string;
  sourceGroupIds: string[];
  sourceOrderIds: string[];
  targetGroupId: string;
  targetOrderIds: string[];
  selectedRecipientOrderId: string | null;
  createdAt: string;
};

export type SplitShipmentGroupInput = {
  groupId: string;
  expectedMemberOrderIds: string[];
  splitOrderIds: string[];
  reason: string;
};

export type MergeShipmentGroupsInput = {
  groupIds: string[];
  expectedMemberOrderIds: string[];
  selectedRecipientOrderId: string | null;
  reason: string;
};

export type ShipmentGroupAdjustmentState = {
  groupIdByOrderId: Map<string, string>;
  selectedRecipientOrderIdByGroupId: Map<string, string | null>;
};

export type ShipmentGroupAdjustmentResult = {
  event: ShipmentGroupAdjustmentEvent;
  projection: ShipmentGroupProjection;
};

export function prepareSplitShipmentGroup(
  value: unknown,
  projection: ShipmentGroupProjection,
): SplitShipmentGroupInput {
  const record = asRecord(value, '拆分发货组参数无效');
  const input: SplitShipmentGroupInput = {
    groupId: boundedText(record.groupId, 200, '发货组标识无效'),
    expectedMemberOrderIds: distinctTextArray(
      record.expectedMemberOrderIds,
      '发货组成员快照无效',
    ),
    splitOrderIds: distinctTextArray(record.splitOrderIds, '请选择要拆出的订单'),
    reason: boundedText(record.reason, 500, '请填写拆分原因'),
  };
  const group = projection.groups.find(({ id }) => id === input.groupId);
  if (!group) throw new Error('发货组已变化，请刷新后重试');
  const currentOrderIds = group.orders.map(({ id }) => id);
  if (!sameMembers(currentOrderIds, input.expectedMemberOrderIds)) {
    throw new Error('发货组成员已变化，请刷新后重试');
  }
  if (currentOrderIds.length < 2) throw new Error('单成员发货组不能继续拆分');
  if (input.splitOrderIds.length >= currentOrderIds.length) {
    throw new Error('拆分后原发货组必须至少保留一笔订单');
  }
  const currentOrderIdSet = new Set(currentOrderIds);
  if (input.splitOrderIds.some((orderId) => !currentOrderIdSet.has(orderId))) {
    throw new Error('要拆出的订单不属于当前发货组');
  }
  return input;
}

export function prepareMergeShipmentGroups(
  value: unknown,
  projection: ShipmentGroupProjection,
): MergeShipmentGroupsInput {
  const record = asRecord(value, '重组发货组参数无效');
  const groupIds = distinctTextArray(record.groupIds, '请选择要重组的发货组');
  if (groupIds.length < 2) throw new Error('请至少选择两个发货组');
  const input: MergeShipmentGroupsInput = {
    groupIds,
    expectedMemberOrderIds: distinctTextArray(
      record.expectedMemberOrderIds,
      '发货组成员快照无效',
    ),
    selectedRecipientOrderId: nullableBoundedText(
      record.selectedRecipientOrderId,
      200,
      '最终收货信息无效',
    ),
    reason: boundedText(record.reason, 500, '请填写重组原因'),
  };
  const groupById = new Map(projection.groups.map((group) => [group.id, group]));
  const groups = input.groupIds.map((groupId) => groupById.get(groupId));
  if (groups.some((group) => group === undefined)) {
    throw new Error('发货组已变化，请刷新后重试');
  }
  const currentGroups = groups.filter((group) => group !== undefined);
  const currentOrderIds = currentGroups.flatMap((group) => (
    group.orders.map(({ id }) => id)
  ));
  if (new Set(currentOrderIds).size !== currentOrderIds.length) {
    throw new Error('发货组成员状态异常，请刷新后重试');
  }
  if (!sameMembers(currentOrderIds, input.expectedMemberOrderIds)) {
    throw new Error('发货组成员已变化，请刷新后重试');
  }
  const currentOrderIdSet = new Set(currentOrderIds);
  if (
    input.selectedRecipientOrderId &&
    !currentOrderIdSet.has(input.selectedRecipientOrderId)
  ) {
    throw new Error('最终收货信息必须来自当前成员订单');
  }
  const matchKeyIdentities = new Set(currentGroups.map((group) => (
    shipmentMatchKeyIdentity({
      phoneNormalized: group.phoneNormalized,
      addressNormalized: group.addressNormalized,
    })
  )));
  if (matchKeyIdentities.size > 1 && !input.selectedRecipientOrderId) {
    throw new Error('不同收货信息的发货组重组时，请选择最终收货信息');
  }
  if (matchKeyIdentities.size === 1 && !input.selectedRecipientOrderId) {
    input.selectedRecipientOrderId = currentGroups.find((group) => (
      group.selectedRecipientOrderId !== null
    ))?.selectedRecipientOrderId ?? null;
  }
  return input;
}

export function replayShipmentGroupAdjustmentEvents(
  events: readonly ShipmentGroupAdjustmentEvent[],
): ShipmentGroupAdjustmentState {
  const groupIdByOrderId = new Map<string, string>();
  const selectedRecipientOrderIdByGroupId = new Map<string, string | null>();
  for (const event of events) {
    for (const orderId of event.targetOrderIds) {
      groupIdByOrderId.set(orderId, event.targetGroupId);
    }
    selectedRecipientOrderIdByGroupId.set(
      event.targetGroupId,
      event.selectedRecipientOrderId,
    );
  }
  return { groupIdByOrderId, selectedRecipientOrderIdByGroupId };
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, maxLength: number, message: string): string {
  if (typeof value !== 'string') throw new Error(message);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > maxLength) throw new Error(message);
  return normalized;
}

function nullableBoundedText(
  value: unknown,
  maxLength: number,
  message: string,
): string | null {
  if (value === null) return null;
  return boundedText(value, maxLength, message);
}

function distinctTextArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new Error(message);
  }
  const normalized = value.map((item) => boundedText(item, 200, message));
  if (new Set(normalized).size !== normalized.length) throw new Error(message);
  return normalized;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
