import type {
  OrderFieldChange,
  OrderPlatformTransactionStatusPatch,
  OrderPlatformTransactionStatusTarget,
  OrderPlatformTransactionStatusUpdateInput,
  OriginalOrder,
} from './contracts';

export type PreparedOrderPlatformTransactionStatusUpdate = {
  input: OrderPlatformTransactionStatusUpdateInput;
};

export function prepareOrderPlatformTransactionStatusUpdate(
  input: unknown,
): PreparedOrderPlatformTransactionStatusUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('订单交易状态修改格式无效');
  }
  const record = input as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => (
    key !== 'targets' && key !== 'patch'
  ));
  if (unknownKey) throw new Error(`订单交易状态修改包含未知字段：${unknownKey}`);
  if (!Array.isArray(record.targets)) throw new Error('订单交易状态修改目标格式无效');
  if (record.targets.length === 0) throw new Error('订单交易状态修改至少需要一笔目标订单');
  if (record.targets.length > 200) throw new Error('订单交易状态修改每批最多处理 200 笔订单');
  if (!record.patch || typeof record.patch !== 'object' || Array.isArray(record.patch)) {
    throw new Error('订单交易状态修改内容格式无效');
  }
  const targets = record.targets.map((target, index) => normalizeTarget(target, index));
  if (new Set(targets.map((target) => target.orderId)).size !== targets.length) {
    throw new Error('订单交易状态修改目标不能重复');
  }
  return { input: { targets, patch: normalizePatch(record.patch as Record<string, unknown>) } };
}

function normalizePatch(record: Record<string, unknown>): OrderPlatformTransactionStatusPatch {
  const unknownKey = Object.keys(record).find((key) => key !== 'platformTransactionStatus');
  if (unknownKey) throw new Error(`订单交易状态修改内容包含未知字段：${unknownKey}`);
  if (!Object.hasOwn(record, 'platformTransactionStatus')) {
    throw new Error('订单交易状态修改必须提供平台交易状态');
  }
  const value = record.platformTransactionStatus;
  if (value !== 'paid' && value !== 'cancelled' && value !== 'refunded' && value !== 'unknown') {
    throw new Error('平台交易状态格式无效');
  }
  return { platformTransactionStatus: value };
}

function normalizeTarget(value: unknown, index: number): OrderPlatformTransactionStatusTarget {
  const label = `目标订单 ${index + 1}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => (
    key !== 'orderId' && key !== 'expectedRevision'
  ));
  if (unknownKey) throw new Error(`${label} 包含未知字段：${unknownKey}`);
  for (const key of ['orderId', 'expectedRevision'] as const) {
    if (!Object.hasOwn(record, key)) throw new Error(`${label} 缺少字段：${key}`);
  }
  if (typeof record.orderId !== 'string') throw new Error(`${label} 的订单标识格式无效`);
  const orderId = record.orderId.normalize('NFKC').trim();
  if (!orderId || orderId.length > 200) throw new Error(`${label} 的订单标识格式无效`);
  if (!Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 1) {
    throw new Error(`${label} 的订单版本格式无效`);
  }
  return { orderId, expectedRevision: record.expectedRevision as number };
}

export function diffOrderPlatformTransactionStatus(
  current: OriginalOrder,
  patch: OrderPlatformTransactionStatusPatch,
): OrderFieldChange[] {
  if (current.platformTransactionStatus === patch.platformTransactionStatus) return [];
  return [{
    path: 'platformTransactionStatus',
    before: current.platformTransactionStatus,
    after: patch.platformTransactionStatus,
  }];
}
