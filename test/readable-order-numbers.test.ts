import { describe, expect, it } from 'vitest';

import {
  formatReadableOrderNumber,
  shanghaiMonthKey,
  shanghaiYYMM,
} from '../src/core/readable-order-numbers';

describe('可读订单编号格式化', () => {
  it('按上海时区取年月', () => {
    expect(shanghaiYYMM('2026-08-03T08:00:00+08:00')).toBe('2608');
    expect(shanghaiYYMM('2026-01-01T00:00:00+08:00')).toBe('2601');
    expect(shanghaiYYMM('2026-12-15T23:59:59.000Z')).toBe('2612');
  });

  it('上海时区跨月边界按上海日期计', () => {
    // UTC 8 月 31 日 16:30 = 上海 9 月 1 日 00:30
    expect(shanghaiYYMM('2026-08-31T16:30:00.000Z')).toBe('2609');
    expect(shanghaiMonthKey('2026-08-31T16:30:00.000Z')).toBe('2026-09');
    expect(shanghaiMonthKey('2026-08-03T08:00:00+08:00')).toBe('2026-08');
  });

  it('拼接年月、批次/次序与收件人编号', () => {
    expect(formatReadableOrderNumber({
      yymm: '2608',
      sequence: 2,
      recipientNumber: 1,
      kind: 'PL',
    })).toBe('260802-001-PL');
    expect(formatReadableOrderNumber({
      yymm: '2608',
      sequence: 5,
      recipientNumber: 1,
      kind: 'PT',
    })).toBe('260805-001-PT');
    expect(formatReadableOrderNumber({
      yymm: '2608',
      sequence: 5,
      recipientNumber: 12,
      kind: 'PT',
    })).toBe('260805-012-PT');
    expect(formatReadableOrderNumber({
      yymm: '2601',
      sequence: 10,
      recipientNumber: 123,
      kind: 'PT',
    })).toBe('260110-123-PT');
  });
});
