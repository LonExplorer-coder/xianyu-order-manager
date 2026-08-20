import { describe, expect, it } from 'vitest';

import type {
  OriginalOrder,
  RecognitionItem,
  SourceSnapshot,
} from '../src/core/contracts';
import {
  buildOrderHistoryTimeline,
  buildOrderSourceValueRows,
} from '../src/core/order-history';

function item(sourceTitle: string): RecognitionItem {
  return {
    sourceTitle,
    sourceSpec: `${sourceTitle}规格`,
    unitPriceCents: 1_000,
    quantity: 1,
    quantityInferred: false,
  };
}

function snapshot(items: RecognitionItem[]): SourceSnapshot {
  const recognition = { items } as SourceSnapshot['recognition'];
  return {
    id: 'source-snapshot-1',
    createdAt: '2026-08-21T01:00:00.000Z',
    confirmedAt: '2026-08-21T01:05:00.000Z',
    sourceType: 'screenshot',
    sourceName: null,
    sourceRowNumbers: [],
    recognition,
    confirmed: structuredClone(recognition),
  } as SourceSnapshot;
}

describe('订单历史时间线投影', () => {
  it('把来源建立与校对确认按各自发生时间分开呈现', () => {
    const sourceSnapshot = snapshot([item('商品 A')]);
    const timeline = buildOrderHistoryTimeline({
      sourceSnapshot,
      sources: [{
        recognitionStatus: 'imported',
        sourceScreenshot: {
          id: 'screenshot-1',
          originalName: '订单截图.png',
          relativePath: 'screenshots/订单截图.png',
          mimeType: 'image/png',
          sha256: 'source-history-test',
          createdAt: sourceSnapshot.createdAt,
        },
        sourceSnapshot,
      }],
      changeEvents: [],
      shipmentGroupAdjustmentEvents: [],
      lifecycleEvents: [],
    });

    expect(timeline.map(({ kind, occurredAt }) => ({ kind, occurredAt }))).toEqual([
      { kind: 'source_confirmation', occurredAt: '2026-08-21T01:05:00.000Z' },
      { kind: 'source', occurredAt: '2026-08-21T01:00:00.000Z' },
    ]);
  });

  it('来源快照中的首条订单商品明细被删除后不会错配订单当前值', () => {
    const sourceSnapshot = snapshot([item('商品 A'), item('商品 B')]);
    const currentOrder = {
      items: [{ id: 'current-b', position: 0, ...item('商品 B') }],
    } as OriginalOrder;

    const rows = buildOrderSourceValueRows(sourceSnapshot, currentOrder);

    expect(rows.find(({ path }) => path === 'items[0].sourceTitle')).toMatchObject({
      recognition: '商品 A',
      confirmed: '商品 A',
      current: null,
    });
    expect(rows.find(({ path }) => path === 'items[1].sourceTitle')).toMatchObject({
      recognition: '商品 B',
      confirmed: '商品 B',
      current: '商品 B',
    });
  });
});
