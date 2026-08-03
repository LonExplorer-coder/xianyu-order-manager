import type {
  OrderChangeValue,
  OrderEditInput,
  OrderEditItemInput,
  OrderEditReview,
  OrderFieldChange,
  OrderItem,
  OrderPlatform,
  OriginalOrder,
} from './contracts';
import type {
  CustomFieldDefinition,
  CustomFieldValue,
  CustomFieldValueRecord,
} from './custom-fields';
import {
  isMissingCustomFieldValue,
  normalizeCustomFieldValue,
} from './custom-fields';
import {
  isValidPhonePair,
  normalizeAddress,
  normalizePhone,
  normalizeShanghaiDateTime,
} from './order-normalization';
import {
  isQuantitySource,
  quantityInferredFromSource,
  quantitySourceFromLegacy,
  type QuantitySource,
} from './quantity-source';

export type PreparedOrderEditItem = OrderEditItemInput & {
  quantitySource: QuantitySource;
  quantityInferred: boolean;
  subtotalCents: number;
};

export type PreparedOrderEdit = {
  review: OrderEditReview;
  identity: {
    platform: OrderPlatform;
    sellerAccount: string;
    orderNumber: string;
  };
  values: {
    alipayTransactionNumber: string;
    buyerNickname: string;
    recipient: string;
    phone: string;
    phoneNormalized: string;
    addressOriginal: string;
    addressNormalized: string;
    province: string;
    city: string;
    district: string;
    orderedAtOriginal: string;
    orderedAtNormalized: string;
    paidAtOriginal: string;
    paidAtNormalized: string;
    productTotalCents: number;
    shippingFeeCents: number;
    amountCents: number;
    note: string;
  };
  items: PreparedOrderEditItem[];
};

const ORDER_EDIT_KEYS = new Set([
  'orderId',
  'expectedRevision',
  'identityCorrection',
  'alipayTransactionNumber',
  'buyerNickname',
  'recipient',
  'phone',
  'addressOriginal',
  'province',
  'city',
  'district',
  'orderedAtOriginal',
  'paidAtOriginal',
  'productTotalCents',
  'shippingFeeCents',
  'amountCents',
  'note',
  'items',
]);
const IDENTITY_KEYS = new Set(['platform', 'sellerAccount', 'orderNumber']);
const ITEM_KEYS = new Set([
  'id',
  'sourceTitle',
  'sourceSpec',
  'unitPriceCents',
  'quantity',
  'customFieldValues',
]);
const ITEM_OPTIONAL_KEYS = new Set(['customFieldValues']);
const ITEM_CUSTOM_FIELD_VALUE_KEYS = new Set(['definitionId', 'value']);
const ORDER_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u;
const INVALID_RECIPIENT_PATTERN = /(?:\*|复制|去发货|\d{7,})/u;

export function reviewOrderEdit(
  current: OriginalOrder,
  input: unknown,
  customFieldDefinitions: readonly CustomFieldDefinition[] = [],
  currentCustomFieldValues: readonly CustomFieldValueRecord[] = [],
): OrderEditReview {
  return prepareOrderEdit(
    current,
    input,
    customFieldDefinitions,
    currentCustomFieldValues,
  ).review;
}

export function orderEditTargetId(input: unknown): string {
  const record = strictRecord(input, '订单修改', ORDER_EDIT_KEYS);
  return requiredText(record.orderId, 200, '订单标识');
}

export function prepareOrderEdit(
  current: OriginalOrder,
  input: unknown,
  customFieldDefinitions: readonly CustomFieldDefinition[] = [],
  currentCustomFieldValues: readonly CustomFieldValueRecord[] = [],
): PreparedOrderEdit {
  const record = strictRecord(input, '订单修改', ORDER_EDIT_KEYS);
  const orderId = requiredText(record.orderId, 200, '订单标识');
  if (orderId !== current.id) throw new Error('订单修改目标与当前订单不一致');
  const expectedRevision = requiredPositiveInteger(record.expectedRevision, '订单版本');
  if (expectedRevision !== current.revision) {
    throw new Error('订单已在其他操作中更新，请刷新后重试');
  }
  const identityCorrection = normalizeIdentityCorrection(record.identityCorrection);
  const identity = identityCorrection ?? {
    platform: current.platform,
    sellerAccount: current.sellerAccount,
    orderNumber: current.orderNumber,
  };

  const alipayTransactionNumber = optionalText(
    record.alipayTransactionNumber,
    200,
    '支付宝交易号',
  );
  const buyerNickname = optionalText(record.buyerNickname, 200, '买家昵称');
  const recipient = requiredText(record.recipient, 64, '收件人');
  if (INVALID_RECIPIENT_PATTERN.test(recipient) || !/[\p{L}]/u.test(recipient)) {
    throw new Error('收件人格式无效');
  }
  const phone = requiredText(record.phone, 64, '手机号');
  const phoneNormalized = normalizePhone(phone);
  if (!isValidPhonePair(phone, phoneNormalized)) throw new Error('手机号格式无效');
  const addressOriginal = requiredText(record.addressOriginal, 2_000, '完整收货地址');
  const addressNormalized = normalizeAddress(addressOriginal);
  const province = optionalText(record.province, 100, '省');
  const city = optionalText(record.city, 100, '市');
  const district = optionalText(record.district, 100, '区县');
  for (const part of [province, city, district].filter(Boolean)) {
    if (!addressNormalized.includes(normalizeAddress(part))) {
      throw new Error('省市区与完整收货地址不一致');
    }
  }
  const orderedAtOriginal = optionalText(record.orderedAtOriginal, 100, '下单时间');
  const orderedAtNormalized = normalizedDateTime(orderedAtOriginal, '下单时间');
  const paidAtOriginal = optionalText(record.paidAtOriginal, 100, '付款时间');
  const paidAtNormalized = normalizedDateTime(paidAtOriginal, '付款时间');
  if (
    orderedAtNormalized &&
    paidAtNormalized &&
    Date.parse(paidAtNormalized) < Date.parse(orderedAtNormalized)
  ) {
    throw new Error('付款时间不能早于下单时间');
  }
  const productTotalCents = requiredMoney(record.productTotalCents, '商品总价');
  const shippingFeeCents = requiredMoney(record.shippingFeeCents, '运费');
  const amountCents = requiredMoney(record.amountCents, '成交金额');
  const note = optionalText(record.note, 4_000, '备注');
  const items = resolveNewItemCustomFieldValues(
    normalizeItems(record.items, current.items),
    customFieldDefinitions,
  );

  const normalizedInput: OrderEditInput = {
    orderId,
    expectedRevision,
    identityCorrection,
    alipayTransactionNumber,
    buyerNickname,
    recipient,
    phone,
    addressOriginal,
    province,
    city,
    district,
    orderedAtOriginal,
    paidAtOriginal,
    productTotalCents,
    shippingFeeCents,
    amountCents,
    note,
    items: items.map(({ quantitySource: _source, quantityInferred: _inferred, subtotalCents: _subtotal, ...item }) => item),
  };
  const values = {
    alipayTransactionNumber,
    buyerNickname,
    recipient,
    phone,
    phoneNormalized,
    addressOriginal,
    addressNormalized,
    province,
    city,
    district,
    orderedAtOriginal,
    orderedAtNormalized,
    paidAtOriginal,
    paidAtNormalized,
    productTotalCents,
    shippingFeeCents,
    amountCents,
    note,
  };
  const changes = diffManualOrderEdit(
    current,
    identity,
    values,
    items,
    currentCustomFieldValues,
  );
  return {
    review: {
      orderId,
      expectedRevision,
      input: normalizedInput,
      changes,
      shippedSnapshotWarning: [
        'shipped',
        'delivered',
        'returned',
      ].includes(current.fulfillmentStatus),
    },
    identity,
    values,
    items,
  };
}

function normalizeIdentityCorrection(value: unknown): OrderEditInput['identityCorrection'] {
  if (value === null) return null;
  const record = strictRecord(value, '订单身份更正', IDENTITY_KEYS);
  if (record.platform !== 'xianyu') throw new Error('当前仅支持闲鱼平台订单');
  const sellerAccount = requiredText(record.sellerAccount, 128, '卖家账号');
  const orderNumber = requiredText(record.orderNumber, 64, '订单号');
  if (!ORDER_NUMBER_PATTERN.test(orderNumber.normalize('NFKC'))) {
    throw new Error('订单号格式无效');
  }
  return { platform: 'xianyu', sellerAccount, orderNumber };
}

function normalizeItems(value: unknown, currentItems: readonly OrderItem[]): PreparedOrderEditItem[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('订单至少需要一项商品明细');
  if (value.length > 200) throw new Error('一笔订单最多保留 200 项商品');
  const currentById = new Map(currentItems.map((item) => [item.id, item]));
  const seenIds = new Set<string>();
  const normalizedItems = value.map((entry, index) => {
    const record = strictRecord(entry, `商品 ${index + 1}`, ITEM_KEYS, ITEM_OPTIONAL_KEYS);
    let id: string | null;
    if (record.id === null) {
      id = null;
    } else {
      id = requiredText(record.id, 200, `商品 ${index + 1} 标识`);
      if (seenIds.has(id)) throw new Error('订单商品标识不能重复');
      if (!currentById.has(id)) throw new Error('订单商品不属于当前订单，请刷新后重试');
      seenIds.add(id);
    }
    const sourceTitle = requiredText(record.sourceTitle, 500, `商品 ${index + 1} 标题`);
    const sourceSpec = optionalText(record.sourceSpec, 2_000, `商品 ${index + 1} 款式或规格`);
    const unitPriceCents = requiredMoney(record.unitPriceCents, `商品 ${index + 1} 单价`);
    const quantity = requiredPositiveInteger(record.quantity, `商品 ${index + 1} 数量`);
    const customFieldValues = normalizeItemCustomFieldValues(
      record.customFieldValues,
      `商品 ${index + 1}`,
    );
    const prior = id === null ? undefined : currentById.get(id);
    const quantitySource: QuantitySource = !prior || prior.quantity !== quantity
      ? 'manual'
      : requiredStoredQuantitySource(prior);
    return {
      id,
      sourceTitle,
      sourceSpec,
      unitPriceCents,
      quantity,
      customFieldValues,
      quantitySource,
      quantityInferred: quantityInferredFromSource(quantitySource),
      subtotalCents: safeSubtotal(unitPriceCents, quantity),
    };
  });
  const retainedIds = new Set(normalizedItems.flatMap((item) => (
    item.id === null ? [] : [item.id]
  )));
  const currentRetainedOrder = currentItems
    .map((item) => item.id)
    .filter((id) => retainedIds.has(id));
  const requestedRetainedOrder = normalizedItems.flatMap((item) => (
    item.id === null ? [] : [item.id]
  ));
  if (JSON.stringify(currentRetainedOrder) !== JSON.stringify(requestedRetainedOrder)) {
    throw new Error('当前版本不支持调整已有商品顺序');
  }
  return normalizedItems;
}

function diffManualOrderEdit(
  current: OriginalOrder,
  identity: PreparedOrderEdit['identity'],
  values: PreparedOrderEdit['values'],
  items: readonly PreparedOrderEditItem[],
  currentCustomFieldValues: readonly CustomFieldValueRecord[],
): OrderFieldChange[] {
  const changes: OrderFieldChange[] = [];
  appendChange(changes, 'platform', current.platform, identity.platform);
  appendChange(changes, 'sellerAccount', current.sellerAccount, identity.sellerAccount);
  appendChange(changes, 'orderNumber', current.orderNumber, identity.orderNumber);
  for (const field of [
    'alipayTransactionNumber',
    'buyerNickname',
    'recipient',
    'phone',
    'phoneNormalized',
    'addressOriginal',
    'addressNormalized',
    'province',
    'city',
    'district',
    'orderedAtOriginal',
    'orderedAtNormalized',
    'paidAtOriginal',
    'paidAtNormalized',
    'productTotalCents',
    'shippingFeeCents',
    'amountCents',
    'note',
  ] as const) {
    appendChange(
      changes,
      field,
      field === 'note' ? (current.note ?? '') : current[field],
      values[field],
    );
  }

  const currentById = new Map(current.items.map((item) => [item.id, item]));
  const retainedIds = new Set<string>();
  items.forEach((item, index) => {
    if (item.id === null) {
      changes.push({ path: `items[${index}]`, before: null, after: addedItemChangeValue(item) });
      return;
    }
    retainedIds.add(item.id);
    const prior = currentById.get(item.id);
    if (!prior) return;
    for (const field of [
      'sourceTitle',
      'sourceSpec',
      'unitPriceCents',
      'quantity',
      'quantitySource',
    ] as const) {
      appendChange(
        changes,
        `items[${index}].${field}`,
        field === 'quantitySource' ? requiredStoredQuantitySource(prior) : prior[field],
        item[field],
      );
    }
  });
  current.items.forEach((item, index) => {
    if (retainedIds.has(item.id)) return;
    changes.push({
      path: `items.removed[${index}]`,
      before: {
        ...itemChangeValue(item),
        customFieldValues: currentCustomFieldValues
          .filter((value) => value.orderItemId === item.id)
          .map((value) => ({
            definitionId: value.definitionId,
            value: value.value as OrderChangeValue,
          })),
      },
      after: null,
    });
  });
  return changes;
}

function appendChange(
  changes: OrderFieldChange[],
  path: string,
  before: OrderChangeValue,
  after: OrderChangeValue,
): void {
  if (before === after) return;
  changes.push({ path, before, after });
}

function itemChangeValue(item: Pick<
  OrderItem | PreparedOrderEditItem,
  'sourceTitle' | 'sourceSpec' | 'unitPriceCents' | 'quantity' | 'quantitySource'
>): { [key: string]: OrderChangeValue } {
  return {
    sourceTitle: item.sourceTitle,
    sourceSpec: item.sourceSpec,
    unitPriceCents: item.unitPriceCents,
    quantity: item.quantity,
    quantitySource: isQuantitySource(item.quantitySource)
      ? item.quantitySource
      : requiredStoredQuantitySource(item as OrderItem),
  };
}

function addedItemChangeValue(item: PreparedOrderEditItem): { [key: string]: OrderChangeValue } {
  return {
    ...itemChangeValue(item),
    customFieldValues: (item.customFieldValues ?? []).map((entry) => ({
      definitionId: entry.definitionId,
      value: entry.value as OrderChangeValue,
    })),
  };
}

function resolveNewItemCustomFieldValues(
  items: readonly PreparedOrderEditItem[],
  definitions: readonly CustomFieldDefinition[],
): PreparedOrderEditItem[] {
  const itemDefinitions = definitions.filter((definition) => (
    definition.granularity === 'order_item'
  ));
  const definitionById = new Map(itemDefinitions.map((definition) => [definition.id, definition]));
  return items.map((item) => {
    const supplied = item.customFieldValues ?? [];
    if (item.id !== null) {
      if (supplied.length > 0) {
        throw new Error('已有商品的自定义字段请在订单详情中单独保存');
      }
      return { ...item, customFieldValues: [] };
    }
    const suppliedByDefinitionId = new Map(supplied.map((entry) => {
      const definition = definitionById.get(entry.definitionId);
      if (!definition) throw new Error('新增商品自定义字段无效');
      return [definition.id, entry.value] as const;
    }));
    const resolved: NonNullable<OrderEditItemInput['customFieldValues']> = [];
    for (const definition of itemDefinitions) {
      const rawValue = suppliedByDefinitionId.has(definition.id)
        ? suppliedByDefinitionId.get(definition.id) ?? null
        : definition.defaultValue;
      if (isMissingCustomFieldValue(rawValue)) {
        if (definition.required) {
          throw new Error(`新增商品缺少必填自定义字段“${definition.name}”`);
        }
        continue;
      }
      resolved.push({
        definitionId: definition.id,
        value: normalizeCustomFieldValue(definition.type, rawValue, definition.options),
      });
    }
    return { ...item, customFieldValues: resolved };
  });
}

function strictRecord(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>,
  optionalKeys: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`${label}包含未知字段：${unknownKey}`);
  const missingKey = [...allowedKeys].find((key) => (
    !optionalKeys.has(key) && !Object.hasOwn(record, key)
  ));
  if (missingKey) throw new Error(`${label}缺少字段：${missingKey}`);
  return record;
}

function normalizeItemCustomFieldValues(
  value: unknown,
  itemLabel: string,
): NonNullable<OrderEditItemInput['customFieldValues']> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) {
    throw new Error(`${itemLabel}自定义字段格式无效`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const record = strictRecord(
      entry,
      `${itemLabel}自定义字段`,
      ITEM_CUSTOM_FIELD_VALUE_KEYS,
    );
    const definitionId = requiredText(record.definitionId, 200, '自定义字段标识');
    if (seen.has(definitionId)) throw new Error(`${itemLabel}自定义字段不能重复`);
    seen.add(definitionId);
    return { definitionId, value: parseCustomFieldValue(record.value) };
  });
}

function parseCustomFieldValue(value: unknown): CustomFieldValue | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  ) {
    return value as CustomFieldValue | null;
  }
  throw new Error('自定义字段值格式无效');
}

function requiredText(value: unknown, maximum: number, label: string): string {
  const normalized = optionalText(value, maximum, label);
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function optionalText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${label}最多 ${maximum} 个字符`);
  return normalized;
}

function requiredMoney(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label}必须使用非负整数分`);
  }
  return value as number;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label}必须为正整数`);
  }
  return value as number;
}

function normalizedDateTime(value: string, label: string): string {
  if (!value) return '';
  const normalized = normalizeShanghaiDateTime(value);
  if (!normalized) throw new Error(`${label}格式无效`);
  return normalized;
}

function safeSubtotal(unitPriceCents: number, quantity: number): number {
  const subtotal = unitPriceCents * quantity;
  if (!Number.isSafeInteger(subtotal) || subtotal < 0) {
    throw new Error('商品小计超出安全范围');
  }
  return subtotal;
}

function requiredStoredQuantitySource(item: OrderItem): QuantitySource {
  if (isQuantitySource(item.quantitySource)) return item.quantitySource;
  return quantitySourceFromLegacy(item.quantityInferred);
}
