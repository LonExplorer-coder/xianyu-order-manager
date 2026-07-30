import { describe, expect, it } from 'vitest';

import type { RecognitionResult } from '../src/core/contracts';
import {
  assessAutomaticImport,
  assessOrderForAutomaticImport,
  orderReviewIssueLabel,
} from '../src/core/order-intake';

const completeOrder: RecognitionResult = {
  platform: 'xianyu',
  sellerAccount: '测试卖家',
  orderNumber: 'ORDER-20260730-001',
  alipayTransactionNumber: '',
  buyerNickname: '买***家',
  recipient: '张三',
  phone: '138 0000 0000',
  phoneNormalized: '13800000000',
  addressOriginal: '广东省 深圳市 南山区 测试路1号',
  addressNormalized: '广东省深圳市南山区测试路1号',
  province: '广东省',
  city: '深圳市',
  district: '南山区',
  orderedAtOriginal: '2026-07-30 10:00:00',
  orderedAtNormalized: '2026-07-30T10:00:00+08:00',
  paidAtOriginal: '2026-07-30 10:00:01',
  paidAtNormalized: '2026-07-30T10:00:01+08:00',
  productTotalCents: 1_600,
  shippingFeeCents: 100,
  amountCents: 1_700,
  platformTransactionStatus: 'paid',
  fulfillmentStatus: 'pending_shipment',
  items: [{
    sourceTitle: '测试商品',
    sourceSpec: '标准款',
    unitPriceCents: 800,
    quantity: 2,
    quantityInferred: false,
  }],
};

describe('自动入库确定性校验', () => {
  it('只允许完整、格式有效且交叉一致的订单', () => {
    expect(assessAutomaticImport(completeOrder)).toEqual([]);
    expect(assessOrderForAutomaticImport(completeOrder)).toEqual({
      eligible: true,
      reviewIssues: [],
    });
  });

  it('允许平台优惠造成的成交金额差异和省直管县地址', () => {
    expect(assessAutomaticImport({
      ...completeOrder,
      amountCents: 1_500,
      addressOriginal: '海南省省直辖县级行政区澄迈县安全路1号',
      addressNormalized: '海南省省直辖县级行政区澄迈县安全路1号',
      province: '海南省',
      city: '',
      district: '澄迈县',
    })).toEqual([]);
  });

  it('不会把小区名称中的区字当作完整行政地址证据', () => {
    expect(assessAutomaticImport({
      ...completeOrder,
      addressOriginal: '南山小区3栋401室',
      addressNormalized: '南山小区3栋401室',
      province: '',
      city: '',
      district: '',
    })).toContain('incomplete_address');
  });

  it('只有省级字段的楼盘门牌仍需人工确认', () => {
    expect(assessAutomaticImport({
      ...completeOrder,
      addressOriginal: '广东省某某小区3栋401室',
      addressNormalized: '广东省某某小区3栋401室',
      province: '广东省',
      city: '',
      district: '',
    })).toContain('incomplete_address');
  });

  it('直辖市重复省市层级且没有区县时仍需人工确认', () => {
    expect(assessAutomaticImport({
      ...completeOrder,
      addressOriginal: '上海市某某小区3栋401室',
      addressNormalized: '上海市某某小区3栋401室',
      province: '上海市',
      city: '上海市',
      district: '',
    })).toContain('incomplete_address');
  });

  it('只有省市区层级而没有详细地址时仍需人工确认', () => {
    expect(assessAutomaticImport({
      ...completeOrder,
      addressOriginal: '广东省深圳市南山区',
      addressNormalized: '广东省深圳市南山区',
      province: '广东省',
      city: '深圳市',
      district: '南山区',
    })).toContain('incomplete_address');
  });

  it('不要求详细地址必须带数字以兼容乡村地址', () => {
    expect(assessAutomaticImport({
      ...completeOrder,
      addressOriginal: '河南省周口市淮阳区王店乡刘庄村',
      addressNormalized: '河南省周口市淮阳区王店乡刘庄村',
      province: '河南省',
      city: '周口市',
      district: '淮阳区',
    })).toEqual([]);
  });

  it('以稳定顺序去重合并适配层原因与字段原因', () => {
    const result = {
      ...completeOrder,
      orderNumber: '',
      phone: '12345',
      phoneNormalized: '12345',
      addressOriginal: '南山区',
      addressNormalized: '南山区',
      province: '',
      city: '',
      district: '南山区',
      productTotalCents: 900,
      amountCents: 900,
    };

    expect(assessOrderForAutomaticImport(result, [
      'targeted_review_conflict',
      'invalid_phone',
      'targeted_review_conflict',
    ])).toMatchObject({
      eligible: false,
      reviewIssues: [
        'targeted_review_conflict',
      'missing_order_number',
      'invalid_phone',
      'incomplete_address',
      'item_total_mismatch',
    ],
    });
  });

  it('区分缺失、格式异常、身份冲突和时间先后冲突', () => {
    const reviewIssues = assessAutomaticImport({
      ...completeOrder,
      buyerNickname: '张三',
      recipient: '张三',
      paidAtOriginal: '2026-07-30 09:59:59',
      paidAtNormalized: '2026-07-30T09:59:59+08:00',
      items: [{
        ...completeOrder.items[0],
        sourceTitle: '',
        unitPriceCents: null,
        quantity: 0,
      }],
    });

    expect(reviewIssues).toEqual([
      'missing_item_title',
      'missing_item_price',
      'invalid_item_quantity',
      'buyer_recipient_conflict',
      'payment_before_order',
    ]);
    expect(orderReviewIssueLabel('payment_before_order')).toBe('付款时间早于下单时间');
  });
});
