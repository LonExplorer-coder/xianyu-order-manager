import type { LifecycleStatus } from './contracts';

export const ORDER_TRASH_RETENTION_DAYS = 30;
export const PERMANENT_DELETE_CONFIRMATION = '永久删除';

export type OrderLifecycleEventAction =
  | 'moved_to_trash'
  | 'restored'
  | 'permanently_deleted'
  | 'retention_expired';

export type OrderLifecycleEventInitiator = 'user' | 'system';

export type OrderLifecycleEvent = {
  id: string;
  orderId: string;
  action: OrderLifecycleEventAction;
  initiator: OrderLifecycleEventInitiator;
  beforeStatus: LifecycleStatus;
  afterStatus: LifecycleStatus;
  baseRevision: number;
  resultRevision: number;
  createdAt: string;
};

export type OrderLifecycleActionInput = {
  orderId: string;
  expectedRevision: number;
};

export type PermanentlyDeleteOrderInput = OrderLifecycleActionInput & {
  confirmation: typeof PERMANENT_DELETE_CONFIRMATION;
};

export function normalizeOrderLifecycleActionInput(
  input: unknown,
): OrderLifecycleActionInput {
  return normalizeTarget(input, false);
}

export function normalizePermanentlyDeleteOrderInput(
  input: unknown,
): PermanentlyDeleteOrderInput {
  const target = normalizeTarget(input, true);
  const confirmation = (input as Record<string, unknown>).confirmation;
  if (confirmation !== PERMANENT_DELETE_CONFIRMATION) {
    throw new Error(`请确认输入“${PERMANENT_DELETE_CONFIRMATION}”`);
  }
  return { ...target, confirmation };
}

export function orderTrashExpiresAt(trashedAt: string): string {
  const timestamp = Date.parse(trashedAt);
  if (!Number.isFinite(timestamp)) throw new Error('订单移入回收站时间无效');
  return new Date(
    timestamp + ORDER_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

function normalizeTarget(input: unknown, permanent: boolean): OrderLifecycleActionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('订单生命周期操作格式无效');
  }
  const record = input as Record<string, unknown>;
  const allowedKeys = permanent
    ? new Set(['orderId', 'expectedRevision', 'confirmation'])
    : new Set(['orderId', 'expectedRevision']);
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`订单生命周期操作包含未知字段：${unknownKey}`);
  if (typeof record.orderId !== 'string') throw new Error('订单标识格式无效');
  const orderId = record.orderId.normalize('NFKC').trim();
  if (!orderId || orderId.length > 200) throw new Error('订单标识格式无效');
  if (!Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 1) {
    throw new Error('订单版本格式无效');
  }
  return { orderId, expectedRevision: record.expectedRevision as number };
}
