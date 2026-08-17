import { describe, expect, it } from 'vitest';

import {
  normalizeCreateProductMappingInput,
  normalizeCorrectProductMappingInput,
  normalizeProductMappingReasonInput,
  productMappingHitKey,
  summarizeProductMappingHits,
} from '../src/core/product-standardization';

describe('商品映射命中投影', () => {
  it('按规范化原文键与目标商品汇总命中订单数、明细数与商品总数量', () => {
    const summaries = summarizeProductMappingHits([
      { sourceTitle: ' 古风娃鞋　白模 ', sourceSpec: '05M', standardProductId: 'product-1', orderId: 'order-1', quantity: 2 },
      { sourceTitle: '古风娃鞋 白模', sourceSpec: '05m', standardProductId: 'product-1', orderId: 'order-1', quantity: 1 },
      { sourceTitle: '古风娃鞋 白模', sourceSpec: '05M', standardProductId: 'product-1', orderId: 'order-2', quantity: 3 },
      { sourceTitle: '十二分娃鞋', sourceSpec: '小号', standardProductId: 'product-2', orderId: 'order-3', quantity: 5 },
    ]);
    expect(summaries.get(productMappingHitKey('古风娃鞋 白模', '05M', 'product-1'))).toEqual({
      orderCount: 2,
      itemCount: 3,
      totalQuantity: 6,
    });
    expect(summaries.get(productMappingHitKey('十二分娃鞋', '小号', 'product-2'))).toEqual({
      orderCount: 1,
      itemCount: 1,
      totalQuantity: 5,
    });
    expect(summaries.size).toBe(2);
  });

  it('同一原文指向不同商品时分别汇总，互不串数', () => {
    const summaries = summarizeProductMappingHits([
      { sourceTitle: '古风娃鞋 白模', sourceSpec: '05M', standardProductId: 'product-1', orderId: 'order-1', quantity: 2 },
      { sourceTitle: '古风娃鞋 白模', sourceSpec: '05M', standardProductId: 'product-2', orderId: 'order-2', quantity: 5 },
    ]);
    expect(summaries.get(productMappingHitKey('古风娃鞋 白模', '05M', 'product-1'))?.totalQuantity).toBe(2);
    expect(summaries.get(productMappingHitKey('古风娃鞋 白模', '05M', 'product-2'))?.totalQuantity).toBe(5);
    expect(summaries.size).toBe(2);
  });

  it('空事实集合投影为空', () => {
    expect(summarizeProductMappingHits([]).size).toBe(0);
  });
});

describe('商品映射新增输入规范化', () => {
  it('规范化原文标题、规格与三级范围字段', () => {
    expect(normalizeCreateProductMappingInput({
      sourceTitle: '  古风娃鞋  白模 ',
      sourceSpec: ' 05M ',
      scope: 'current_account',
      platform: ' xianyu ',
      sellerAccount: ' 主账号 ',
    })).toEqual({
      sourceTitle: '古风娃鞋 白模',
      sourceSpec: '05M',
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '主账号',
    });
    expect(normalizeCreateProductMappingInput({
      sourceTitle: '标题',
      sourceSpec: '',
      scope: 'workspace',
    })).toEqual({
      sourceTitle: '标题',
      sourceSpec: '',
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
    });
  });

  it('拒绝空标题、非法范围与范围字段不一致', () => {
    expect(() => normalizeCreateProductMappingInput({
      sourceTitle: '  ',
      sourceSpec: '',
      scope: 'workspace',
    })).toThrow('原始商品标题无效');
    expect(() => normalizeCreateProductMappingInput({
      sourceTitle: '标题',
      sourceSpec: '',
      scope: 'account_wide',
    })).toThrow('商品映射适用范围无效');
    expect(() => normalizeCreateProductMappingInput({
      sourceTitle: '标题',
      sourceSpec: '',
      scope: 'current_account',
      platform: 'xianyu',
    })).toThrow('当前平台与卖家账号级映射必须提供平台与卖家账号');
    expect(() => normalizeCreateProductMappingInput({
      sourceTitle: '标题',
      sourceSpec: '',
      scope: 'current_platform',
      platform: 'xianyu',
      sellerAccount: '主账号',
    })).toThrow('当前平台级映射不能包含卖家账号');
    expect(() => normalizeCreateProductMappingInput({
      sourceTitle: '标题',
      sourceSpec: '',
      scope: 'workspace',
      platform: 'xianyu',
    })).toThrow('工作区级映射不能包含平台或卖家账号');
    expect(() => normalizeCreateProductMappingInput({
      sourceTitle: '标题',
      sourceSpec: '',
      scope: 'workspace',
      script: 'unexpected',
    })).toThrow('商品映射包含未知字段');
  });
});

describe('商品映射更正输入规范化', () => {
  it('要求非空原因与至少一项更正内容', () => {
    expect(normalizeCorrectProductMappingInput({
      standardProductId: ' product-2 ',
      reason: ' 目标选错了 ',
    })).toEqual({ standardProductId: 'product-2', reason: '目标选错了' });
    expect(normalizeCorrectProductMappingInput({
      scope: 'workspace',
      reason: '放宽到整个工作区',
    })).toEqual({
      scope: 'workspace',
      platform: null,
      sellerAccount: null,
      reason: '放宽到整个工作区',
    });
    expect(() => normalizeCorrectProductMappingInput({
      standardProductId: 'product-2',
    })).toThrow('映射变更原因无效');
    expect(() => normalizeCorrectProductMappingInput({
      standardProductId: 'product-2',
      reason: '   ',
    })).toThrow('映射变更原因无效');
    expect(() => normalizeCorrectProductMappingInput({
      reason: '只填原因',
    })).toThrow('商品映射更正内容为空');
    expect(() => normalizeCorrectProductMappingInput({
      platform: 'xianyu',
      reason: '缺少范围',
    })).toThrow('商品映射更正内容为空');
    expect(() => normalizeCorrectProductMappingInput({
      scope: 'current_platform',
      reason: '缺平台',
    })).toThrow('当前平台级映射必须提供平台');
    expect(() => normalizeCorrectProductMappingInput({
      scope: 'current_account',
      platform: 'xianyu',
      sellerAccount: '账号',
      reason: ' ok ',
      unexpected: 1,
    })).toThrow('商品映射更正包含未知字段');
  });
});

describe('商品映射原因输入规范化', () => {
  it('停用与删除必须提供非空原因', () => {
    expect(normalizeProductMappingReasonInput({ reason: ' 不再销售 ' })).toEqual({
      reason: '不再销售',
    });
    expect(() => normalizeProductMappingReasonInput({})).toThrow('映射变更原因无效');
    expect(() => normalizeProductMappingReasonInput({ reason: '' })).toThrow('映射变更原因无效');
    expect(() => normalizeProductMappingReasonInput({
      reason: '停用',
      extra: true,
    })).toThrow('商品映射操作包含未知字段');
  });
});
