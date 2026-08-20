import type { FinanceDirectionName, FinanceRecordTypeName } from './funds';

// 资金明细组件：已确认记录或待确认事项分摊到某行后的可追溯条目。
export type ProfitMoneyComponent = {
  kind: 'record' | 'pending';
  id: string;
  type: FinanceRecordTypeName;
  direction: FinanceDirectionName;
  amountCents: number;
  // 分摊到当前行的带方向净额（收入为正、支出为负）；单订单挂账时等于 ±amountCents。
  allocatedCents: number;
  // 待确认事项的剩余金额（带方向）；已确认记录为 null。
  remainingCents: number | null;
  // 来源链描述，如「发货记录 SF123（首发运费）」「售后处理单 a1b2c3d4 实际退款」。
  sourceLabel: string;
  occurredAt: string;
  note: string;
  // 成交金额类记录仅参照列示，不参与利润（ADR 0045 决策 1）。
  reference: boolean;
};

// 成本明细组件：订单维度的发出与冲回条目，商品维度另有报废条目。
export type ProfitCostComponent = {
  kind: 'dispatch' | 'recovery' | 'scrap';
  // 发出为发货记录；冲回为退货检查或拦截检查；报废为到货检查或库存检查流水。
  sourceLabel: string;
  shipmentRecordId: string | null;
  returnRecordId: string | null;
  standardProductId: string;
  sku: string;
  name: string;
  quantity: number;
  unitCostCents: number;
  // 订单行内：发出为正成本、冲回与报废冲回为负；商品行的报废为损失金额。
  amountCents: number;
  occurredAt: string;
  reason: string;
};

export type ProfitOrderRow = {
  orderId: string;
  orderNumber: string;
  sellerAccount: string;
  buyerNickname: string;
  orderedAt: string;
  // 成交金额取订单本身，不依赖资金记录。
  transactionAmountCents: number;
  settlementNetCents: number;
  refundNetCents: number;
  platformFeeNetCents: number;
  freightNetCents: number;
  claimNetCents: number;
  miscNetCents: number;
  purchaseCostCents: number;
  profitCents: number;
  // 待确认净额（收入为正、支出为负），不参与利润。
  pendingRemainingCents: number;
  moneyComponents: ProfitMoneyComponent[];
  costComponents: ProfitCostComponent[];
};

// 商品行的库存与采购追溯条目：到货、退货签收与供应方退回的原记录明细。
export type ProfitTraceComponent = {
  kind: 'arrival' | 'return_receipt' | 'supplier_return';
  sourceLabel: string;
  quantity: number;
  // 到货与供应方退回带批次单价；退货签收无金额概念，为 null。
  unitCostCents: number | null;
  detail: string;
  occurredAt: string;
  reason: string;
};

export type ProfitProductRow = {
  standardProductId: string;
  sku: string;
  name: string;
  specification: string;
  avgUnitCostCents: number;
  arrivedQuantity: number;
  supplierReturnedQuantity: number;
  orderCount: number;
  transactionCents: number;
  allocatedNetCents: number;
  dispatchedQuantity: number;
  dispatchedCostCents: number;
  scrapQuantity: number;
  scrapCostCents: number;
  returnReceivedQuantity: number;
  marginCents: number;
  traceComponents: ProfitTraceComponent[];
  allocations: Array<{
    orderId: string;
    orderNumber: string;
    transactionCents: number;
    allocatedNetCents: number;
  }>;
  costComponents: ProfitCostComponent[];
};

export type ProfitReportTotals = {
  transactionCents: number;
  profitCents: number;
  pendingRemainingCents: number;
  scrapCostCents: number;
  purchasePaymentNetCents: number;
  othersNetCents: number;
};

export type ProfitReportView = {
  generatedAt: string;
  orders: ProfitOrderRow[];
  products: ProfitProductRow[];
  unmapped: {
    orderCount: number;
    transactionCents: number;
    allocatedNetCents: number;
  };
  // 采购付款、供应方退款与无来源直接录入：不进订单利润，单独列示可下钻。
  others: ProfitMoneyComponent[];
  totals: ProfitReportTotals;
};
