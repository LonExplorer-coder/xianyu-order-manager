import { describe, expect, it } from 'vitest';

import {
  displayedProductSpecification,
  displayedProductTitle,
  type StandardProduct,
} from '../src/core/product-standardization';

const standardProduct: StandardProduct = {
  id: 'product-display-1',
  sku: 'CUP-RED',
  name: '海棠杯',
  specification: '红色标准款',
  defaultOrderPriceCents: null,
  revision: 1,
  createdAt: '2026-08-16T10:00:00.000Z',
  updatedAt: '2026-08-16T10:00:00.000Z',
};

const sourceItem = {
  sourceTitle: '海棠杯（闲鱼专拍）',
  sourceSpec: '红色 450ml',
};

describe('标准商品显示偏好投影助手', () => {
  it('优先展示标准商品信息时显示标准商品名与标准规格', () => {
    const item = {
      ...sourceItem,
      standardProduct,
      standardDisplayPreference: 'prefer_standard' as const,
    };

    expect(displayedProductTitle(item)).toBe('海棠杯');
    expect(displayedProductSpecification(item)).toBe('红色标准款');
  });

  it('无偏好信息的存量关联默认优先展示标准商品信息', () => {
    expect(displayedProductTitle({ ...sourceItem, standardProduct })).toBe('海棠杯');
    expect(displayedProductSpecification({ ...sourceItem, standardProduct }))
      .toBe('红色标准款');
    expect(displayedProductTitle({
      ...sourceItem,
      standardProduct,
      standardDisplayPreference: null,
    })).toBe('海棠杯');
  });

  it('优先展示订单来源原文时显示来源标题与来源规格', () => {
    const item = {
      ...sourceItem,
      standardProduct,
      standardDisplayPreference: 'prefer_source' as const,
    };

    expect(displayedProductTitle(item)).toBe('海棠杯（闲鱼专拍）');
    expect(displayedProductSpecification(item)).toBe('红色 450ml');
  });

  it('未关联标准商品时始终回退到来源标题与来源规格', () => {
    expect(displayedProductTitle(sourceItem)).toBe('海棠杯（闲鱼专拍）');
    expect(displayedProductSpecification(sourceItem)).toBe('红色 450ml');
    expect(displayedProductTitle({ ...sourceItem, standardProduct: null }))
      .toBe('海棠杯（闲鱼专拍）');
    expect(displayedProductSpecification({ ...sourceItem, standardProduct: null }))
      .toBe('红色 450ml');
  });
});
