import { describe, expect, it } from 'vitest';

import { normalizeProductMappingHistoryCorrectionInput } from '../src/core/product-standardization';

describe('商品身份更正输入校验', () => {
  it('接受最小合法输入：去空白、保留明细与订单版本', () => {
    expect(normalizeProductMappingHistoryCorrectionInput({
      itemIds: [' item-1 ', 'item-2'],
      reason: ' 历史关联维护错误 ',
      expectedOrderRevisions: [
        { orderId: ' order-1 ', revision: 2 },
        { orderId: 'order-2', revision: 5 },
      ],
    })).toEqual({
      itemIds: ['item-1', 'item-2'],
      reason: '历史关联维护错误',
      expectedOrderRevisions: [
        { orderId: 'order-1', revision: 2 },
        { orderId: 'order-2', revision: 5 },
      ],
    });
  });

  it('拒绝未知字段、空明细、重复明细、空原因与无效版本', () => {
    const valid = {
      itemIds: ['item-1'],
      reason: '原因',
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 1 }],
    };
    expect(() => normalizeProductMappingHistoryCorrectionInput({
      ...valid,
      unexpected: true,
    })).toThrow('商品身份更正包含未知字段');
    expect(() => normalizeProductMappingHistoryCorrectionInput({
      ...valid,
      itemIds: [],
    })).toThrow('批量关联商品明细无效');
    expect(() => normalizeProductMappingHistoryCorrectionInput({
      ...valid,
      itemIds: ['item-1', 'item-1'],
    })).toThrow('批量关联商品明细不能重复');
    expect(() => normalizeProductMappingHistoryCorrectionInput({
      ...valid,
      reason: ' ',
    })).toThrow('映射变更原因无效');
    expect(() => normalizeProductMappingHistoryCorrectionInput({
      ...valid,
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 0 }],
    })).toThrow('订单版本无效，请刷新后重试');
  });
});
