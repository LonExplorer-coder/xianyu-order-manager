import type {
  RecognitionBatchItem,
  RecognitionBatchItemStatus,
  RecognitionBatchView,
} from './contracts';

export const RECOGNITION_BATCH_ITEM_STATUSES = [
  'waiting_recognition',
  'recognizing',
  'validating',
  'awaiting_confirmation',
  'imported',
  'waiting_retry',
  'failed',
  'duplicate_skipped',
  'cancelled',
] as const satisfies readonly RecognitionBatchItemStatus[];

export const AUTOMATIC_RECOGNITION_RETRY_DELAYS_MS = [
  30_000,
  120_000,
  600_000,
  1_800_000,
  1_800_000,
] as const;
export const MAX_AUTOMATIC_RECOGNITION_RETRIES =
  AUTOMATIC_RECOGNITION_RETRY_DELAYS_MS.length;

const ACTIVE_RECOGNITION_BATCH_ITEM_STATUSES = new Set<RecognitionBatchItemStatus>([
  'waiting_recognition',
  'recognizing',
  'validating',
  'waiting_retry',
]);

const PROCESSED_RECOGNITION_BATCH_ITEM_STATUSES = new Set<RecognitionBatchItemStatus>([
  'awaiting_confirmation',
  'imported',
  'failed',
  'duplicate_skipped',
  'cancelled',
]);

export function isRecognitionBatchItemStatus(
  value: unknown,
): value is RecognitionBatchItemStatus {
  return typeof value === 'string' && (
    RECOGNITION_BATCH_ITEM_STATUSES as readonly string[]
  ).includes(value);
}

export function isActiveRecognitionBatchItemStatus(
  status: RecognitionBatchItemStatus,
): boolean {
  return ACTIVE_RECOGNITION_BATCH_ITEM_STATUSES.has(status);
}

export function summarizeRecognitionBatchItems(
  items: readonly Pick<RecognitionBatchItem, 'status'>[],
): Pick<RecognitionBatchView, 'totalCount' | 'processedCount' | 'counts'> {
  const counts: RecognitionBatchView['counts'] = {
    waiting_recognition: 0,
    recognizing: 0,
    validating: 0,
    awaiting_confirmation: 0,
    imported: 0,
    waiting_retry: 0,
    failed: 0,
    duplicate_skipped: 0,
    cancelled: 0,
  };
  let processedCount = 0;
  for (const item of items) {
    counts[item.status] += 1;
    if (PROCESSED_RECOGNITION_BATCH_ITEM_STATUSES.has(item.status)) {
      processedCount += 1;
    }
  }
  return { totalCount: items.length, processedCount, counts };
}
