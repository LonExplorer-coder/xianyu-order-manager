import { describe, expect, it } from 'vitest';

import { planOrderItemAmountPrompt } from '../src/core/order-edit';

describe('订单商品金额提示计算', () => {
  it('修改商品单价后输出四行提示数据，建议商品总价为新的商品明细合计', () => {
    const prompt = planOrderItemAmountPrompt({
      before: { unitPriceCents: 800, quantity: 2 },
      after: { unitPriceCents: 1_000, quantity: 2 },
      productTotalCents: 1_600,
      amountCents: 1_600,
    });

    expect(prompt).toEqual({
      unitPrice: { beforeCents: 800, afterCents: 1_000 },
      subtotal: { beforeCents: 1_600, afterCents: 2_000 },
      productTotal: { beforeCents: 1_600, suggestedCents: 2_000 },
      amountCents: 1_600,
      itemsTotalCents: 2_000,
      differsFromAmount: true,
    });
    const aligned = planOrderItemAmountPrompt({
      before: { unitPriceCents: 800, quantity: 2 },
      after: { unitPriceCents: 1_000, quantity: 2 },
      productTotalCents: 1_600,
      amountCents: 2_000,
    });
    expect(aligned.differsFromAmount).toBe(false);
  });

  it('建议商品总价计入其他商品行小计，数量变化同样触发重算', () => {
    const prompt = planOrderItemAmountPrompt({
      before: { unitPriceCents: 800, quantity: 1 },
      after: { unitPriceCents: 800, quantity: 3 },
      productTotalCents: 1_300,
      amountCents: 1_300,
      otherItemsSubtotalCents: 500,
    });

    expect(prompt.subtotal).toEqual({ beforeCents: 800, afterCents: 2_400 });
    expect(prompt.productTotal).toEqual({ beforeCents: 1_300, suggestedCents: 2_900 });
    expect(prompt.itemsTotalCents).toBe(2_900);
  });

  it('商品明细合计与成交金额存在差异时只标记提示，建议值仍为明细合计且不改动成交金额', () => {
    const prompt = planOrderItemAmountPrompt({
      before: { unitPriceCents: 800, quantity: 1 },
      after: { unitPriceCents: 1_299, quantity: 1 },
      productTotalCents: 800,
      amountCents: 800,
    });

    expect(prompt.productTotal).toEqual({ beforeCents: 800, suggestedCents: 1_299 });
    expect(prompt.amountCents).toBe(800);
    expect(prompt.itemsTotalCents).toBe(1_299);
    expect(prompt.differsFromAmount).toBe(true);
  });

  it('拒绝非整数分、负数与超出安全范围的金额', () => {
    expect(() => planOrderItemAmountPrompt({
      before: { unitPriceCents: 0, quantity: 1 },
      after: { unitPriceCents: 12.5, quantity: 1 },
      productTotalCents: 0,
      amountCents: 0,
    })).toThrow('商品单价必须使用非负整数分');
    expect(() => planOrderItemAmountPrompt({
      before: { unitPriceCents: -1, quantity: 1 },
      after: { unitPriceCents: 0, quantity: 1 },
      productTotalCents: 0,
      amountCents: 0,
    })).toThrow('商品单价必须使用非负整数分');
    expect(() => planOrderItemAmountPrompt({
      before: { unitPriceCents: 0, quantity: 1 },
      after: { unitPriceCents: 0, quantity: 0 },
      productTotalCents: 0,
      amountCents: 0,
    })).toThrow('商品数量必须为正整数');
    expect(() => planOrderItemAmountPrompt({
      before: { unitPriceCents: 0, quantity: 1 },
      after: { unitPriceCents: 0, quantity: 1 },
      productTotalCents: -1,
      amountCents: 0,
    })).toThrow('商品总价必须使用非负整数分');
    expect(() => planOrderItemAmountPrompt({
      before: { unitPriceCents: 0, quantity: 1 },
      after: { unitPriceCents: 0, quantity: 1 },
      productTotalCents: 0,
      amountCents: -1,
    })).toThrow('成交金额必须使用非负整数分');
    expect(() => planOrderItemAmountPrompt({
      before: { unitPriceCents: 0, quantity: 1 },
      after: { unitPriceCents: 0, quantity: 1 },
      productTotalCents: 0,
      amountCents: 0,
      otherItemsSubtotalCents: -1,
    })).toThrow('商品明细合计必须使用非负整数分');
    expect(() => planOrderItemAmountPrompt({
      before: { unitPriceCents: 0, quantity: 1 },
      after: { unitPriceCents: Number.MAX_SAFE_INTEGER, quantity: 2 },
      productTotalCents: 0,
      amountCents: 0,
    })).toThrow('商品小计超出安全范围');
  });
});
