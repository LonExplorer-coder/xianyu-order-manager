const CROPPED_PURCHASED_ITEM_SCHEMA = {
  title: '订单商品标题',
  spec: '商品款式或规格',
  unit_price: '商品单价金额',
  price_tag_text: '商品单价原文',
  quantity: '商品数量',
  quantity_text: '商品数量原文',
} as const;

export const CROPPED_ORDER_RESULT_SCHEMA = {
  platform_status: {
    top_status_text: '平台状态标题',
  },
  shipping_information: {
    recipient: '收件人姓名',
    recipient_phone_line_text: '姓名与手机号原行',
    phone: '收件人手机号',
    address: '完整收货地址',
    controls: ['收货信息区按钮文字'],
  },
  purchased_items: {
    items: [CROPPED_PURCHASED_ITEM_SCHEMA],
    controls: ['商品信息区按钮文字'],
  },
  amount_summary: {
    product_total: '商品总价金额',
    shipping_fee: '运费金额',
    amount: '成交金额',
  },
  order_details: {
    detail_state: 'collapsed | expanded | unknown',
    order_number: '订单编号',
    alipay_transaction_number: '支付宝交易号',
    buyer_nickname_label: '买家昵称标签',
    buyer_nickname: '买家昵称',
    order_time: '下单时间',
    payment_time: '付款时间',
    controls: ['订单详情区按钮文字'],
  },
} as const;

const CROPPED_SCHEMA_DESCRIPTIONS = new Set(
  collectSchemaDescriptions(CROPPED_ORDER_RESULT_SCHEMA).map(normalizeSchemaText),
);

export function looksLikeXianyuKieInstructionEcho(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = normalizeSchemaText(value);
  if (!normalized) return false;
  if (CROPPED_SCHEMA_DESCRIPTIONS.has(normalized)) return true;
  return /(?:原样(?:复制|列出)|(?:只|仅)(?:提取|返回|列出|填写)|不要(?:包含|复制|填写|列入)|不得(?:包含|使用|复制|填写)|看不到时?返回|无法(?:确认|判断)时?返回|必须(?:填写|返回|把))/u
    .test(normalized) || (
      /(?:返回|提取|列出|填写)/u.test(normalized) &&
      /(?:看不到|无法|例如|null|字段|区域)/iu.test(normalized)
    );
}

function collectSchemaDescriptions(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectSchemaDescriptions);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(collectSchemaDescriptions);
}

function normalizeSchemaText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}
