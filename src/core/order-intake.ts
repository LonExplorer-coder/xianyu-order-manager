import {
  ORDER_REVIEW_ISSUE_CODES,
  type OrderReviewIssueCode,
  type RecognitionItem,
  type RecognitionResult,
} from './contracts';
import {
  isValidAddressPair,
  isValidPhonePair,
  normalizeAddress,
  normalizeShanghaiDateTime,
} from './order-normalization';

export type OrderIntakeSettingsView = {
  automaticImportEnabled: boolean;
};

export type SaveOrderIntakeSettingsInput = {
  automaticImportEnabled: boolean;
};

export type OrderIntakeAssessment = {
  eligible: boolean;
  reviewIssues: OrderReviewIssueCode[];
};

export const DEFAULT_ORDER_INTAKE_SETTINGS: OrderIntakeSettingsView = {
  automaticImportEnabled: false,
};

const ORDER_REVIEW_ISSUE_LABELS: Record<OrderReviewIssueCode, string> = {
  automatic_import_disabled: '自动入库已关闭',
  automatic_import_failed: '自动入库失败，请人工确认',
  duplicate_order: '已存在相同订单身份的记录',
  order_content_changed: '同一订单的新截图包含字段变化，请确认是否更新',
  screenshot_content_incomplete: '截图关键区域未显示完整或未识别',
  targeted_review_failed: '关键字段定向复核未完成',
  targeted_review_conflict: '关键字段两次识别仍有冲突',
  missing_seller_account: '缺少卖家账号',
  missing_order_number: '缺少订单编号',
  invalid_order_number: '订单编号格式异常',
  missing_recipient: '缺少收件人',
  invalid_recipient: '收件人格式异常',
  missing_phone: '缺少手机号',
  invalid_phone: '手机号格式异常',
  missing_address: '缺少完整收货地址',
  incomplete_address: '收货地址内容可能不完整',
  address_mismatch: '完整地址与规范化或省市区信息不一致',
  missing_items: '缺少商品明细',
  missing_item_title: '商品明细缺少标题',
  invalid_item_title: '商品标题格式异常',
  missing_item_price: '商品明细缺少单价',
  invalid_item_price: '商品单价格式异常',
  missing_item_quantity: '商品明细缺少数量',
  invalid_item_quantity: '商品数量格式异常',
  missing_product_total: '缺少商品总价',
  invalid_product_total: '商品总价格式异常',
  missing_shipping_fee: '缺少运费',
  invalid_shipping_fee: '运费格式异常',
  missing_amount: '缺少成交金额',
  invalid_amount: '成交金额格式异常',
  item_total_mismatch: '商品明细小计与商品总价不一致',
  buyer_recipient_conflict: '买家昵称与收件人识别结果冲突',
  invalid_order_time: '下单时间格式或规范化结果异常',
  invalid_payment_time: '付款时间格式或规范化结果异常',
  payment_before_order: '付款时间早于下单时间',
};

const ORDER_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u;
const INVALID_RECIPIENT_PATTERN = /(?:\*|[复制去发货收货信息收件人手机号地址]{4,}|\d{7,})/u;
const INVALID_ITEM_TITLE_PATTERN = /^(?:商品|商品标题|标题|去发货|复制)$/u;
const PROVINCE_PATTERN = /^(?:(?:北京|天津|上海|重庆)市|[\p{Script=Han}]{2,12}(?:省|自治区|特别行政区))$/u;
const CITY_PATTERN = /^[\p{Script=Han}]{2,12}(?:市|自治州|地区|盟)$/u;
const DISTRICT_PATTERN = /^[\p{Script=Han}]{1,12}(?:自治县|市辖区|区|县|旗|市)$/u;
const FACILITY_ADDRESS_PART_PATTERN = /(?:小区|园区|社区|校区|景区|厂区|片区)$/u;

export function orderReviewIssueLabel(code: OrderReviewIssueCode): string {
  return ORDER_REVIEW_ISSUE_LABELS[code];
}

export function isOrderReviewIssueCode(value: unknown): value is OrderReviewIssueCode {
  return typeof value === 'string' && (
    ORDER_REVIEW_ISSUE_CODES as readonly string[]
  ).includes(value);
}

export function normalizeOrderReviewIssues(
  issues: readonly OrderReviewIssueCode[],
): OrderReviewIssueCode[] {
  const selected = new Set(issues);
  return ORDER_REVIEW_ISSUE_CODES.filter((code) => selected.has(code));
}

export function assessOrderForAutomaticImport(
  result: RecognitionResult,
  reportedReviewIssues: readonly OrderReviewIssueCode[] = [],
): OrderIntakeAssessment {
  const issues = new Set<OrderReviewIssueCode>(reportedReviewIssues);
  assessIdentity(result, issues);
  assessShipping(result, issues);
  const itemTotal = assessItems(result.items, issues);
  assessAmounts(result, itemTotal, issues);
  assessTimes(result, issues);
  const reviewIssues = normalizeOrderReviewIssues([...issues]);
  return { eligible: reviewIssues.length === 0, reviewIssues };
}

export const assessOrderIntake = assessOrderForAutomaticImport;

export function assessAutomaticImport(
  result: RecognitionResult & { reviewIssues?: readonly OrderReviewIssueCode[] },
): OrderReviewIssueCode[] {
  return assessOrderForAutomaticImport(
    result,
    result.reviewIssues ?? [],
  ).reviewIssues;
}

function assessIdentity(
  result: RecognitionResult,
  issues: Set<OrderReviewIssueCode>,
): void {
  if (!result.sellerAccount.trim()) issues.add('missing_seller_account');

  const orderNumber = result.orderNumber.trim();
  if (!orderNumber) issues.add('missing_order_number');
  else if (!ORDER_NUMBER_PATTERN.test(orderNumber)) issues.add('invalid_order_number');

  const recipient = result.recipient.normalize('NFKC').trim();
  if (!recipient) issues.add('missing_recipient');
  else if (
    recipient.length > 64 ||
    INVALID_RECIPIENT_PATTERN.test(recipient) ||
    !/[\p{L}]/u.test(recipient)
  ) {
    issues.add('invalid_recipient');
  }

  const buyerNickname = result.buyerNickname.normalize('NFKC').trim();
  if (recipient && buyerNickname && recipient === buyerNickname) {
    issues.add('buyer_recipient_conflict');
  }
}

function assessShipping(
  result: RecognitionResult,
  issues: Set<OrderReviewIssueCode>,
): void {
  if (!result.phone.trim()) issues.add('missing_phone');
  else if (!isValidPhonePair(result.phone, result.phoneNormalized)) {
    issues.add('invalid_phone');
  }

  if (!result.addressOriginal.trim()) {
    issues.add('missing_address');
  } else {
    const normalizedAddress = normalizeAddress(result.addressOriginal);
    const province = normalizeAddress(result.province);
    const city = normalizeAddress(result.city);
    const district = normalizeAddress(result.district);
    const normalizedParts = [province, city, district]
      .filter(Boolean);
    const trustedProvince = PROVINCE_PATTERN.test(province) ? province : '';
    const trustedCity = CITY_PATTERN.test(city) ? city : '';
    const trustedDistrict = (
      DISTRICT_PATTERN.test(district) && !FACILITY_ADDRESS_PART_PATTERN.test(district)
    ) ? district : '';
    const trustedAdministrativeParts = [
      trustedProvince,
      trustedCity,
      trustedDistrict,
    ].filter(Boolean);
    const uniqueAdministrativeParts = [...new Set(trustedAdministrativeParts)];
    const hasAdministrativeRoot = Boolean(trustedProvince || trustedCity);
    const hasAdministrativeHierarchy = hasAdministrativeRoot &&
      uniqueAdministrativeParts.length >= 2;
    const hasDetailedAddress = addressDetailText(
      normalizedAddress,
      uniqueAdministrativeParts,
    ).length >= 3;
    const hasInvalidProvidedPart = (
      Boolean(province) && !trustedProvince
    ) || (
      Boolean(city) && !trustedCity
    ) || (
      Boolean(district) && !trustedDistrict
    );
    if (
      normalizedAddress.length < 8 ||
      !hasAdministrativeHierarchy ||
      !hasDetailedAddress
    ) {
      issues.add('incomplete_address');
    }
    if (
      hasInvalidProvidedPart ||
      !isValidAddressPair(result.addressOriginal, result.addressNormalized) ||
      normalizedParts.some((part) => !result.addressNormalized.includes(part))
    ) {
      issues.add('address_mismatch');
    }
  }
}

function addressDetailText(
  normalizedAddress: string,
  administrativeParts: readonly string[],
): string {
  let detail = normalizedAddress;
  for (const part of [...administrativeParts].sort((left, right) => right.length - left.length)) {
    detail = detail.split(part).join('');
  }
  return detail
    .replace(
      /(?:市辖区|省直辖县级行政区(?:划)?|自治区直辖县级行政区(?:划)?)/gu,
      '',
    )
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function assessItems(
  items: readonly RecognitionItem[],
  issues: Set<OrderReviewIssueCode>,
): number | null {
  if (!Array.isArray(items) || items.length === 0) {
    issues.add('missing_items');
    return null;
  }

  let total = 0;
  let canCalculateTotal = true;
  for (const item of items) {
    const title = typeof item.sourceTitle === 'string'
      ? item.sourceTitle.normalize('NFKC').trim()
      : '';
    if (!title) issues.add('missing_item_title');
    else if (title.length > 500 || INVALID_ITEM_TITLE_PATTERN.test(title)) {
      issues.add('invalid_item_title');
    }

    if (item.unitPriceCents === null || item.unitPriceCents === undefined) {
      issues.add('missing_item_price');
      canCalculateTotal = false;
    } else if (!isNonNegativeSafeInteger(item.unitPriceCents)) {
      issues.add('invalid_item_price');
      canCalculateTotal = false;
    }

    if (item.quantity === null || item.quantity === undefined) {
      issues.add('missing_item_quantity');
      canCalculateTotal = false;
    } else if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      issues.add('invalid_item_quantity');
      canCalculateTotal = false;
    }

    if (canCalculateTotal && item.unitPriceCents !== null) {
      const subtotal = item.unitPriceCents * item.quantity;
      if (!Number.isSafeInteger(subtotal) || subtotal < 0) {
        issues.add('invalid_item_price');
        canCalculateTotal = false;
      } else {
        total += subtotal;
        if (!Number.isSafeInteger(total)) {
          issues.add('invalid_item_price');
          canCalculateTotal = false;
        }
      }
    }
  }
  return canCalculateTotal ? total : null;
}

function assessAmounts(
  result: RecognitionResult,
  itemTotal: number | null,
  issues: Set<OrderReviewIssueCode>,
): void {
  assessMoney(result.productTotalCents, 'missing_product_total', 'invalid_product_total', issues);
  assessMoney(result.shippingFeeCents, 'missing_shipping_fee', 'invalid_shipping_fee', issues);
  assessMoney(result.amountCents, 'missing_amount', 'invalid_amount', issues);

  if (
    itemTotal !== null &&
    isNonNegativeSafeInteger(result.productTotalCents) &&
    itemTotal !== result.productTotalCents
  ) {
    issues.add('item_total_mismatch');
  }

}

function assessMoney(
  value: number | null,
  missing: OrderReviewIssueCode,
  invalid: OrderReviewIssueCode,
  issues: Set<OrderReviewIssueCode>,
): void {
  if (value === null || value === undefined) issues.add(missing);
  else if (!isNonNegativeSafeInteger(value)) issues.add(invalid);
}

function assessTimes(
  result: RecognitionResult,
  issues: Set<OrderReviewIssueCode>,
): void {
  const orderTimeValid = isValidTimePair(
    result.orderedAtOriginal,
    result.orderedAtNormalized,
  );
  const paymentTimeValid = isValidTimePair(
    result.paidAtOriginal,
    result.paidAtNormalized,
  );
  if (!orderTimeValid) issues.add('invalid_order_time');
  if (!paymentTimeValid) issues.add('invalid_payment_time');
  if (
    orderTimeValid &&
    paymentTimeValid &&
    result.orderedAtNormalized &&
    result.paidAtNormalized &&
    Date.parse(result.paidAtNormalized) < Date.parse(result.orderedAtNormalized)
  ) {
    issues.add('payment_before_order');
  }
}

function isValidTimePair(original: string, normalized: string): boolean {
  if (!original.trim() && !normalized.trim()) return true;
  const expected = normalizeShanghaiDateTime(original);
  return Boolean(expected) && normalized === expected;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
