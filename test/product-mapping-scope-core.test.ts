import { describe, expect, it } from 'vitest';

import {
  selectProductMappingMatch,
  type ProductMapping,
} from '../src/core/product-standardization';

type MappingMatchEntry = Pick<
  ProductMapping,
  'scope' | 'platform' | 'sellerAccount' | 'standardProductId'
>;

function mapping(overrides: Partial<MappingMatchEntry> = {}): MappingMatchEntry {
  return {
    scope: 'workspace',
    platform: null,
    sellerAccount: null,
    standardProductId: 'product-workspace',
    ...overrides,
  };
}

const context = { platform: 'xianyu', sellerAccount: '主账号' };

describe('商品映射匹配优先级', () => {
  it('当前账号映射优先于当前平台与工作区映射', () => {
    expect(selectProductMappingMatch([
      mapping(),
      mapping({
        scope: 'current_platform',
        platform: 'xianyu',
        standardProductId: 'product-platform',
      }),
      mapping({
        scope: 'current_account',
        platform: 'xianyu',
        sellerAccount: '主账号',
        standardProductId: 'product-account',
      }),
    ], context)).toMatchObject({
      standardProductId: 'product-account',
      scope: 'current_account',
    });
  });

  it('当前账号落空时回退到当前平台映射', () => {
    expect(selectProductMappingMatch([
      mapping(),
      mapping({
        scope: 'current_platform',
        platform: 'xianyu',
        standardProductId: 'product-platform',
      }),
      mapping({
        scope: 'current_account',
        platform: 'xianyu',
        sellerAccount: '另一个账号',
        standardProductId: 'product-account',
      }),
    ], context)).toMatchObject({
      standardProductId: 'product-platform',
      scope: 'current_platform',
    });
  });

  it('账号与平台都落空时回退到工作区映射', () => {
    expect(selectProductMappingMatch([
      mapping(),
      mapping({
        scope: 'current_platform',
        platform: 'taobao',
        standardProductId: 'product-platform',
      }),
      mapping({
        scope: 'current_account',
        platform: 'xianyu',
        sellerAccount: '另一个账号',
        standardProductId: 'product-account',
      }),
    ], context)).toMatchObject({
      standardProductId: 'product-workspace',
      scope: 'workspace',
    });
  });

  it('三级都落空时不命中映射', () => {
    expect(selectProductMappingMatch([
      mapping({
        scope: 'current_account',
        platform: 'xianyu',
        sellerAccount: '另一个账号',
        standardProductId: 'product-account',
      }),
      mapping({
        scope: 'current_platform',
        platform: 'taobao',
        standardProductId: 'product-platform',
      }),
    ], context)).toBeNull();
    expect(selectProductMappingMatch([], context)).toBeNull();
  });
});
