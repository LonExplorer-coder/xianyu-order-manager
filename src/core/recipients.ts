export type RecipientSummaryView = {
  id: string;
  recipientNumber: number;
  name: string;
  displayName: string | null;
  /** 有效显示名称：display_name ?? name；已合并行跟随合并链到存续方。 */
  effectiveName: string;
  phoneNormalized: string;
  /** 解析到该终态收件人的订单数；已合并行恒为 0。 */
  orderCount: number;
  /** 该终态收件人全部订单的去重地址，按订单入库先后排列。 */
  addresses: string[];
  /** 收件人累计消费：全部有效订单实付金额合计，不扣退款。 */
  totalSpendCents: number;
  /** 收件人累计退款：售后实退加未走售后的整单退款推断，同一订单不重复计。 */
  totalRefundCents: number;
  mergedIntoRecipientId: string | null;
  mergedReason: string | null;
  mergedAt: string | null;
  createdAt: string;
};

export type OrderSpendingView = {
  /** 该订单在收件人有效订单时间序列中的 1 基序号；非有效订单或未归属收件人为 null。 */
  repurchaseRank: number | null;
  totalSpendCents: number;
  totalRefundCents: number;
};

export type MergeRecipientsInput = {
  sourceRecipientId: string;
  targetRecipientId: string;
  keepNameFrom: 'source' | 'target';
  reason: string;
};
