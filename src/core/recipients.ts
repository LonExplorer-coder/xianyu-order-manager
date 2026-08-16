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
  mergedIntoRecipientId: string | null;
  mergedReason: string | null;
  mergedAt: string | null;
  createdAt: string;
};

export type MergeRecipientsInput = {
  sourceRecipientId: string;
  targetRecipientId: string;
  keepNameFrom: 'source' | 'target';
  reason: string;
};
