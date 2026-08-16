import { describe, expect, it } from 'vitest';

import {
  normalizeOrderItemStandardizationBatchApplyInput,
  normalizeOrderItemStandardizationBatchPreviewInput,
  planOrderItemStandardizationBatch,
  type OrderItemStandardizationBatchItemState,
  type OrderItemStandardizationBatchOptions,
  type OrderItemStandardizationBatchOrderState,
} from '../src/core/product-standardization';

const defaultOptions: OrderItemStandardizationBatchOptions = {
  standardDisplayPreference: 'prefer_standard',
  useDefaultOrderPrice: false,
  updateProductTotal: false,
};

function itemState(overrides: Partial<OrderItemStandardizationBatchItemState> = {}): OrderItemStandardizationBatchItemState {
  return {
    itemId: 'item-1',
    orderId: 'order-1',
    position: 0,
    quantity: 1,
    unitPriceCents: 800,
    subtotalCents: 800,
    standardProductId: null,
    ...overrides,
  };
}

function orderState(overrides: Partial<OrderItemStandardizationBatchOrderState> = {}): OrderItemStandardizationBatchOrderState {
  return {
    orderId: 'order-1',
    revision: 1,
    shippedOrDelivered: false,
    hasAftersales: false,
    productTotalCents: 800,
    shippingFeeCents: 0,
    amountCents: 800,
    itemsSubtotalCents: 800,
    ...overrides,
  };
}

describe('订单商品批量关联预览与执行输入校验', () => {
  it('接受最小合法预览输入并拒绝未知字段与无效内容', () => {
    expect(normalizeOrderItemStandardizationBatchPreviewInput({
      itemIds: [' item-1 ', 'item-2'],
      standardProductId: ' product-1 ',
      options: {
        standardDisplayPreference: 'prefer_source',
        useDefaultOrderPrice: false,
        updateProductTotal: false,
      },
    })).toEqual({
      itemIds: ['item-1', 'item-2'],
      standardProductId: 'product-1',
      options: {
        standardDisplayPreference: 'prefer_source',
        useDefaultOrderPrice: false,
        updateProductTotal: false,
      },
    });

    expect(() => normalizeOrderItemStandardizationBatchPreviewInput(null))
      .toThrow('批量关联内容无效');
    expect(() => normalizeOrderItemStandardizationBatchPreviewInput({
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options: defaultOptions,
      createMapping: true,
    })).toThrow('批量关联包含未知字段');
    expect(() => normalizeOrderItemStandardizationBatchPreviewInput({
      itemIds: [],
      standardProductId: 'product-1',
      options: defaultOptions,
    })).toThrow('批量关联商品明细无效');
    expect(() => normalizeOrderItemStandardizationBatchPreviewInput({
      itemIds: ['item-1', ' item-1 '],
      standardProductId: 'product-1',
      options: defaultOptions,
    })).toThrow('批量关联商品明细不能重复');
    expect(() => normalizeOrderItemStandardizationBatchPreviewInput({
      itemIds: ['item-1', 42],
      standardProductId: 'product-1',
      options: defaultOptions,
    })).toThrow('批量关联商品明细无效');
    expect(() => normalizeOrderItemStandardizationBatchPreviewInput({
      itemIds: ['item-1'],
      standardProductId: ' ',
      options: defaultOptions,
    })).toThrow('标准商品标识无效');
    expect(() => normalizeOrderItemStandardizationBatchPreviewInput({
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options: { ...defaultOptions, standardDisplayPreference: 'sometimes' },
    })).toThrow('标准商品显示偏好无效');
    expect(() => normalizeOrderItemStandardizationBatchPreviewInput({
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options: { ...defaultOptions, useDefaultOrderPrice: 'yes' },
    })).toThrow('批量关联选项无效');
    expect(() => normalizeOrderItemStandardizationBatchPreviewInput({
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options: { ...defaultOptions, createMapping: false },
    })).toThrow('批量关联选项包含未知字段');
    expect(() => normalizeOrderItemStandardizationBatchPreviewInput({
      itemIds: ['item-1'],
      standardProductId: 'product-1',
      options: {
        standardDisplayPreference: 'prefer_standard',
        useDefaultOrderPrice: false,
        updateProductTotal: true,
      },
    })).toThrow('未使用标准商品默认单价时不能同步商品总价');
  });

  it('执行输入额外校验逐条确认与订单版本快照', () => {
    const preview = {
      itemIds: ['item-1', 'item-2'],
      standardProductId: 'product-1',
      options: defaultOptions,
    };
    expect(normalizeOrderItemStandardizationBatchApplyInput({
      ...preview,
      confirmedOverrideItemIds: ['item-2'],
      confirmedAmountMismatchOrderIds: ['order-1'],
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 3 }],
    })).toEqual({
      ...preview,
      confirmedOverrideItemIds: ['item-2'],
      confirmedAmountMismatchOrderIds: ['order-1'],
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 3 }],
    });

    expect(() => normalizeOrderItemStandardizationBatchApplyInput({
      ...preview,
      confirmedOverrideItemIds: ['item-3'],
      confirmedAmountMismatchOrderIds: [],
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 1 }],
    })).toThrow('批量关联覆盖确认超出了所选商品明细');
    expect(() => normalizeOrderItemStandardizationBatchApplyInput({
      ...preview,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: ['order-9'],
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 1 }],
    })).toThrow('批量关联金额差异确认超出了涉及订单');
    expect(() => normalizeOrderItemStandardizationBatchApplyInput({
      ...preview,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [],
      expectedOrderRevisions: [],
    })).toThrow('订单版本无效，请刷新后重试');
    expect(() => normalizeOrderItemStandardizationBatchApplyInput({
      ...preview,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [],
      expectedOrderRevisions: [
        { orderId: 'order-1', revision: 1 },
        { orderId: 'order-1', revision: 2 },
      ],
    })).toThrow('订单版本无效，请刷新后重试');
    expect(() => normalizeOrderItemStandardizationBatchApplyInput({
      ...preview,
      confirmedOverrideItemIds: [],
      confirmedAmountMismatchOrderIds: [],
      expectedOrderRevisions: [{ orderId: 'order-1', revision: 0 }],
    })).toThrow('订单版本无效，请刷新后重试');
  });
});

describe('订单商品批量关联预览计算', () => {
  it('统计订单、明细、商品数量与三种关联状态', () => {
    const plan = planOrderItemStandardizationBatch({
      items: [
        itemState({ itemId: 'item-1', orderId: 'order-1', quantity: 2, subtotalCents: 1600 }),
        itemState({ itemId: 'item-2', orderId: 'order-1', position: 1 }),
        itemState({
          itemId: 'item-3',
          orderId: 'order-2',
          standardProductId: 'product-1',
        }),
        itemState({
          itemId: 'item-4',
          orderId: 'order-3',
          standardProductId: 'product-9',
        }),
      ],
      orders: [
        orderState({ orderId: 'order-1', itemsSubtotalCents: 2400, productTotalCents: 2400, amountCents: 2400 }),
        orderState({ orderId: 'order-2', shippedOrDelivered: true }),
        orderState({ orderId: 'order-3', hasAftersales: true }),
      ],
      product: { id: 'product-1', defaultOrderPriceCents: 1299 },
      options: defaultOptions,
    });

    expect(plan).toMatchObject({
      priceSyncRequested: false,
      priceSyncAvailable: true,
      defaultOrderPriceCents: 1299,
      orderCount: 3,
      itemCount: 4,
      totalQuantity: 5,
      unlinkedCount: 2,
      sameProductCount: 1,
      otherProductCount: 1,
      shippedOrderCount: 1,
      aftersalesOrderCount: 1,
      priceAffectedItemCount: 0,
      suggestedProductTotalOrderCount: 0,
    });
    expect(plan.items.map((item) => [item.itemId, item.linkState])).toEqual([
      ['item-1', 'unlinked'],
      ['item-2', 'unlinked'],
      ['item-3', 'same_product'],
      ['item-4', 'other_product'],
    ]);
    expect(plan.items.find((item) => item.itemId === 'item-4')?.blockReasons)
      .toEqual(['linked_other_product']);
    expect(plan.orders.every((order) => !order.amountMismatch)).toBe(true);
  });

  it('勾选使用默认单价时重算小计并建议商品总价，成交金额不变但产生差异核对', () => {
    const plan = planOrderItemStandardizationBatch({
      items: [
        itemState({ itemId: 'item-1', orderId: 'order-1', quantity: 2, unitPriceCents: 800, subtotalCents: 1600 }),
        itemState({ itemId: 'item-2', orderId: 'order-1', position: 1, unitPriceCents: 1299, subtotalCents: 1299 }),
      ],
      orders: [orderState({
        orderId: 'order-1',
        itemsSubtotalCents: 2899,
        productTotalCents: 2899,
        shippingFeeCents: 0,
        amountCents: 2899,
      })],
      product: { id: 'product-1', defaultOrderPriceCents: 1299 },
      options: {
        standardDisplayPreference: 'prefer_standard',
        useDefaultOrderPrice: true,
        updateProductTotal: true,
      },
    });

    const first = plan.items.find((item) => item.itemId === 'item-1');
    expect(first).toMatchObject({
      plannedUnitPriceCents: 1299,
      unitPriceChanges: true,
      plannedSubtotalCents: 2598,
    });
    const second = plan.items.find((item) => item.itemId === 'item-2');
    expect(second).toMatchObject({
      plannedUnitPriceCents: 1299,
      unitPriceChanges: false,
      plannedSubtotalCents: 1299,
    });
    expect(plan.priceAffectedItemCount).toBe(1);
    expect(plan.orders[0]).toMatchObject({
      productTotalCents: 2899,
      suggestedProductTotalCents: 3897,
      productTotalChanges: true,
      amountMismatch: true,
    });
    expect(plan.suggestedProductTotalOrderCount).toBe(1);
    expect(plan.items.map((item) => item.blockReasons)).toEqual([
      ['amount_mismatch'],
      ['amount_mismatch'],
    ]);
  });

  it('商品总价与成交金额扣除运费后一致时不产生差异核对', () => {
    const plan = planOrderItemStandardizationBatch({
      items: [itemState({ itemId: 'item-1', orderId: 'order-1' })],
      orders: [orderState({
        orderId: 'order-1',
        itemsSubtotalCents: 800,
        productTotalCents: 800,
        shippingFeeCents: 200,
        amountCents: 1000,
      })],
      product: { id: 'product-1', defaultOrderPriceCents: 800 },
      options: {
        standardDisplayPreference: 'prefer_standard',
        useDefaultOrderPrice: true,
        updateProductTotal: false,
      },
    });

    expect(plan.orders[0].amountMismatch).toBe(false);
    expect(plan.items[0].blockReasons).toEqual([]);
  });

  it('标准商品没有默认单价时标记价格同步不可用且不改动单价', () => {
    const plan = planOrderItemStandardizationBatch({
      items: [itemState({ itemId: 'item-1', orderId: 'order-1' })],
      orders: [orderState({ orderId: 'order-1' })],
      product: { id: 'product-1', defaultOrderPriceCents: null },
      options: {
        standardDisplayPreference: 'prefer_standard',
        useDefaultOrderPrice: true,
        updateProductTotal: false,
      },
    });

    expect(plan.priceSyncAvailable).toBe(false);
    expect(plan.priceAffectedItemCount).toBe(0);
    expect(plan.items[0]).toMatchObject({
      plannedUnitPriceCents: 800,
      unitPriceChanges: false,
      plannedSubtotalCents: 800,
      blockReasons: [],
    });
    expect(plan.orders[0]).toMatchObject({
      productTotalChanges: false,
      amountMismatch: false,
    });
  });

  it('明细引用缺失订单状态时直接拒绝', () => {
    expect(() => planOrderItemStandardizationBatch({
      items: [itemState({ itemId: 'item-1', orderId: 'order-missing' })],
      orders: [orderState({ orderId: 'order-1' })],
      product: { id: 'product-1', defaultOrderPriceCents: null },
      options: defaultOptions,
    })).toThrow('批量关联缺少订单数据');
  });
});
