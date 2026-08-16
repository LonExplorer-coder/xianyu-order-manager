export type ReadableOrderNumberKind = 'PL' | 'PT';

export type ReadableOrderNumberParts = {
  /** 上海时区两位年月，如 2608。 */
  yymm: string;
  /** 计划当月批次或现货当月次序，拼接为两位。 */
  sequence: number;
  /** 收件人编号，拼接为三位。 */
  recipientNumber: number;
  kind: ReadableOrderNumberKind;
};

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiParts(value: string): { fullYear: number; month: number } {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error('时间格式无效');
  const shifted = new Date(timestamp + SHANGHAI_OFFSET_MS);
  return {
    fullYear: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
  };
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** 上海时区日历月键，用于按月分组（与平台交易时间口径一致）。 */
export function shanghaiMonthKey(value: string): string {
  const { fullYear, month } = shanghaiParts(value);
  return `${fullYear}-${pad(month, 2)}`;
}

/** 上海时区两位年月，如 2608。 */
export function shanghaiYYMM(value: string): string {
  const { fullYear, month } = shanghaiParts(value);
  return `${pad(fullYear % 100, 2)}${pad(month, 2)}`;
}

export function formatReadableOrderNumber(parts: ReadableOrderNumberParts): string {
  return `${parts.yymm}${pad(parts.sequence, 2)}-${pad(parts.recipientNumber, 3)}-${parts.kind}`;
}
