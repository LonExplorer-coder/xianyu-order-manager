const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const SYSTEM_ORDER_NUMBER_DATE = /^\d{8}$/u;
const MAX_DAILY_SEQUENCE = 999_999;

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function shanghaiDateKey(instant: string | Date): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error('系统订单首次入库时间无效');
  const parts = SHANGHAI_DATE_FORMATTER.formatToParts(date);
  const year = parts.find(({ type }) => type === 'year')?.value;
  const month = parts.find(({ type }) => type === 'month')?.value;
  const day = parts.find(({ type }) => type === 'day')?.value;
  if (!year || !month || !day) throw new Error('无法计算系统订单编号日期');
  return `${year}${month}${day}`;
}

export function systemOrderNumberForSequence(
  dateKey: string,
  sequence: number,
): string {
  if (!SYSTEM_ORDER_NUMBER_DATE.test(dateKey)) {
    throw new Error('系统订单编号日期无效');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_DAILY_SEQUENCE) {
    throw new Error('当日系统订单编号已用尽');
  }
  return `${dateKey}-${String(sequence).padStart(6, '0')}`;
}

export function systemOrderNumberSequence(value: string, dateKey: string): number {
  if (!value.startsWith(`${dateKey}-`) || value.length !== 15) return 0;
  const sequence = Number(value.slice(9));
  return Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= MAX_DAILY_SEQUENCE
    ? sequence
    : 0;
}
