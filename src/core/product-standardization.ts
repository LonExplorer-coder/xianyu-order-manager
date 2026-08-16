export type StandardProduct = {
  id: string;
  sku: string;
  name: string;
  specification: string;
  defaultOrderPriceCents: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type StandardProductPriceEvent = {
  id: string;
  standardProductId: string;
  previousDefaultOrderPriceCents: number | null;
  defaultOrderPriceCents: number | null;
  reason: string;
  occurredAt: string;
  createdAt: string;
};

export type ProductStandardizationSource = 'exact' | 'mapping' | 'manual';

export type ProductMapping = {
  id: string;
  sourceTitle: string;
  sourceSpec: string;
  standardProductId: string;
  createdAt: string;
  updatedAt: string;
};

export type ProductStandardizationCandidate = {
  product: StandardProduct;
  reason: 'fuzzy' | 'previous_manual_choice';
  score: number;
  mappingSuggested: boolean;
};

export type DraftItemProductStandardization = {
  draftItemId: string;
  sourceTitle: string;
  sourceSpec: string;
  automaticProduct: StandardProduct | null;
  automaticSource: Extract<ProductStandardizationSource, 'exact' | 'mapping'> | null;
  candidates: ProductStandardizationCandidate[];
};

export type ProductStandardizationConfirmation = {
  draftItemId: string;
  standardProductId: string | null;
  createMapping: boolean;
};

export type CreateStandardProductInput = {
  sku: string;
  name: string;
  specification: string;
  defaultOrderPriceCents?: number | null;
  priceChangeReason?: string;
};

export type UpdateStandardProductInput = Omit<CreateStandardProductInput, 'defaultOrderPriceCents'> & {
  defaultOrderPriceCents: number | null;
  expectedRevision: number;
};

export type StandardDisplayPreference = 'prefer_standard' | 'prefer_source';

export type UpdateOrderItemStandardizationInput = {
  standardProductId: string | null;
  standardDisplayPreference?: StandardDisplayPreference;
  expectedRevision: number;
};

/** 订单商品明细批量关联的逐条关联状态。 */
export type OrderItemStandardizationBatchLinkState =
  | 'unlinked'
  | 'same_product'
  | 'other_product';

/** 批量关联中逐条阻断且必须显式确认的冲突原因。 */
export type OrderItemStandardizationBatchBlockReason =
  | 'linked_other_product'
  | 'amount_mismatch';

export type OrderItemStandardizationBatchOptions = {
  standardDisplayPreference: StandardDisplayPreference;
  useDefaultOrderPrice: boolean;
  updateProductTotal: boolean;
};

export type OrderItemStandardizationBatchPreviewInput = {
  itemIds: string[];
  standardProductId: string;
  options: OrderItemStandardizationBatchOptions;
};

export type OrderItemStandardizationBatchApplyInput =
  OrderItemStandardizationBatchPreviewInput & {
    confirmedOverrideItemIds: string[];
    confirmedAmountMismatchOrderIds: string[];
    expectedOrderRevisions: Array<{ orderId: string; revision: number }>;
  };

/** 批量关联预览计算所需的最小订单商品明细状态。 */
export type OrderItemStandardizationBatchItemState = {
  itemId: string;
  orderId: string;
  position: number;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  standardProductId: string | null;
};

/** 批量关联预览计算所需的最小订单状态；金额一律整数分。 */
export type OrderItemStandardizationBatchOrderState = {
  orderId: string;
  revision: number;
  shippedOrDelivered: boolean;
  hasAftersales: boolean;
  productTotalCents: number;
  shippingFeeCents: number;
  amountCents: number;
  itemsSubtotalCents: number;
};

export type OrderItemStandardizationBatchItemPlan = {
  itemId: string;
  orderId: string;
  linkState: OrderItemStandardizationBatchLinkState;
  plannedUnitPriceCents: number;
  unitPriceChanges: boolean;
  plannedSubtotalCents: number;
  blockReasons: OrderItemStandardizationBatchBlockReason[];
};

export type OrderItemStandardizationBatchOrderPlan = {
  orderId: string;
  revision: number;
  shippedOrDelivered: boolean;
  hasAftersales: boolean;
  productTotalCents: number;
  shippingFeeCents: number;
  amountCents: number;
  suggestedProductTotalCents: number;
  productTotalChanges: boolean;
  amountMismatch: boolean;
};

export type OrderItemStandardizationBatchPlan = {
  priceSyncRequested: boolean;
  priceSyncAvailable: boolean;
  defaultOrderPriceCents: number | null;
  orderCount: number;
  itemCount: number;
  totalQuantity: number;
  unlinkedCount: number;
  sameProductCount: number;
  otherProductCount: number;
  shippedOrderCount: number;
  aftersalesOrderCount: number;
  priceAffectedItemCount: number;
  suggestedProductTotalOrderCount: number;
  items: OrderItemStandardizationBatchItemPlan[];
  orders: OrderItemStandardizationBatchOrderPlan[];
};

export type OrderItemStandardizationBatchPreviewItem = {
  itemId: string;
  orderId: string;
  orderNumber: string;
  systemOrderNumber: string;
  position: number;
  sourceTitle: string;
  sourceSpec: string;
  quantity: number;
  currentUnitPriceCents: number;
  plannedUnitPriceCents: number;
  currentSubtotalCents: number;
  plannedSubtotalCents: number;
  beforeStandardProductSku: string | null;
  linkState: OrderItemStandardizationBatchLinkState;
  blockReasons: OrderItemStandardizationBatchBlockReason[];
};

export type OrderItemStandardizationBatchPreviewOrder = {
  orderId: string;
  orderNumber: string;
  systemOrderNumber: string;
  revision: number;
  shippedOrDelivered: boolean;
  hasAftersales: boolean;
  productTotalCents: number;
  shippingFeeCents: number;
  amountCents: number;
  suggestedProductTotalCents: number;
  productTotalChanges: boolean;
  amountMismatch: boolean;
};

export type OrderItemStandardizationBatchPreview = {
  standardProduct: StandardProduct;
  options: OrderItemStandardizationBatchOptions;
  priceSyncRequested: boolean;
  priceSyncAvailable: boolean;
  defaultOrderPriceCents: number | null;
  orderCount: number;
  itemCount: number;
  totalQuantity: number;
  unlinkedCount: number;
  sameProductCount: number;
  otherProductCount: number;
  shippedOrderCount: number;
  aftersalesOrderCount: number;
  priceAffectedItemCount: number;
  suggestedProductTotalOrderCount: number;
  items: OrderItemStandardizationBatchPreviewItem[];
  orders: OrderItemStandardizationBatchPreviewOrder[];
};

export type OrderItemStandardizationBatchItemResult = {
  itemId: string;
  orderId: string;
  applied: boolean;
  blockReason: OrderItemStandardizationBatchBlockReason | null;
  beforeStandardProductSku: string | null;
  afterStandardProductSku: string | null;
};

export type OrderItemStandardizationBatchResult = {
  batchId: string;
  standardProduct: StandardProduct;
  appliedItemCount: number;
  blockedItemCount: number;
  results: OrderItemStandardizationBatchItemResult[];
};

/**
 * 规格 5.3 与第 6 节的批量关联预览计算：统计影响、计划价格同步并逐条标记
 * 必须显式确认的冲突。金额差异按应用批次后的最终商品总价加运费与成交金额比较。
 */
export function planOrderItemStandardizationBatch(input: {
  items: readonly OrderItemStandardizationBatchItemState[];
  orders: readonly OrderItemStandardizationBatchOrderState[];
  product: { id: string; defaultOrderPriceCents: number | null };
  options: OrderItemStandardizationBatchOptions;
}): OrderItemStandardizationBatchPlan {
  const { items, orders, product, options } = input;
  const orderStateById = new Map(orders.map((order) => [order.orderId, order] as const));
  const priceSyncAvailable = product.defaultOrderPriceCents !== null;
  const syncPrices = options.useDefaultOrderPrice && priceSyncAvailable;

  const plannedSubtotalByItemId = new Map<string, number>();
  const itemPlans = items.map((item): OrderItemStandardizationBatchItemPlan => {
    if (!orderStateById.has(item.orderId)) throw new Error('批量关联缺少订单数据');
    const linkState: OrderItemStandardizationBatchLinkState = item.standardProductId === null
      ? 'unlinked'
      : item.standardProductId === product.id
        ? 'same_product'
        : 'other_product';
    const plannedUnitPriceCents = syncPrices
      ? product.defaultOrderPriceCents as number
      : item.unitPriceCents;
    const plannedSubtotalCents = plannedUnitPriceCents * item.quantity;
    if (!Number.isSafeInteger(plannedSubtotalCents) || plannedSubtotalCents < 0) {
      throw new Error('商品小计超出安全范围');
    }
    plannedSubtotalByItemId.set(item.itemId, plannedSubtotalCents);
    return {
      itemId: item.itemId,
      orderId: item.orderId,
      linkState,
      plannedUnitPriceCents,
      unitPriceChanges: plannedUnitPriceCents !== item.unitPriceCents,
      plannedSubtotalCents,
      blockReasons: [],
    };
  });

  const itemPlansByOrder = new Map<string, OrderItemStandardizationBatchItemPlan[]>();
  for (const plan of itemPlans) {
    const grouped = itemPlansByOrder.get(plan.orderId) ?? [];
    grouped.push(plan);
    itemPlansByOrder.set(plan.orderId, grouped);
  }
  const itemStateById = new Map(items.map((item) => [item.itemId, item] as const));
  const orderPlans = orders.map((order): OrderItemStandardizationBatchOrderPlan => {
    const grouped = itemPlansByOrder.get(order.orderId) ?? [];
    const subtotalDelta = grouped.reduce((total, plan) => (
      total + plan.plannedSubtotalCents -
      (itemStateById.get(plan.itemId)?.subtotalCents ?? 0)
    ), 0);
    const suggestedProductTotalCents = order.itemsSubtotalCents + subtotalDelta;
    if (!Number.isSafeInteger(suggestedProductTotalCents) || suggestedProductTotalCents < 0) {
      throw new Error('商品明细合计超出安全范围');
    }
    const hasPriceChange = grouped.some((plan) => plan.unitPriceChanges);
    const finalProductTotalCents = options.updateProductTotal
      ? suggestedProductTotalCents
      : order.productTotalCents;
    return {
      orderId: order.orderId,
      revision: order.revision,
      shippedOrDelivered: order.shippedOrDelivered,
      hasAftersales: order.hasAftersales,
      productTotalCents: order.productTotalCents,
      shippingFeeCents: order.shippingFeeCents,
      amountCents: order.amountCents,
      suggestedProductTotalCents,
      productTotalChanges: hasPriceChange && suggestedProductTotalCents !== order.productTotalCents,
      amountMismatch: syncPrices && hasPriceChange &&
        finalProductTotalCents + order.shippingFeeCents !== order.amountCents,
    };
  });
  const orderPlanById = new Map(orderPlans.map((order) => [order.orderId, order] as const));
  for (const plan of itemPlans) {
    const blockReasons: OrderItemStandardizationBatchBlockReason[] = [];
    if (plan.linkState === 'other_product') blockReasons.push('linked_other_product');
    if (orderPlanById.get(plan.orderId)?.amountMismatch) blockReasons.push('amount_mismatch');
    plan.blockReasons = blockReasons;
  }

  return {
    priceSyncRequested: options.useDefaultOrderPrice,
    priceSyncAvailable,
    defaultOrderPriceCents: product.defaultOrderPriceCents,
    orderCount: orderPlans.length,
    itemCount: itemPlans.length,
    totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
    unlinkedCount: itemPlans.filter((plan) => plan.linkState === 'unlinked').length,
    sameProductCount: itemPlans.filter((plan) => plan.linkState === 'same_product').length,
    otherProductCount: itemPlans.filter((plan) => plan.linkState === 'other_product').length,
    shippedOrderCount: orderPlans.filter((order) => order.shippedOrDelivered).length,
    aftersalesOrderCount: orderPlans.filter((order) => order.hasAftersales).length,
    priceAffectedItemCount: itemPlans.filter((plan) => plan.unitPriceChanges).length,
    suggestedProductTotalOrderCount: orderPlans.filter((order) => order.productTotalChanges).length,
    items: itemPlans,
    orders: orderPlans,
  };
}

const MAX_BATCH_ENTRIES = 200;

const BATCH_OPTION_KEYS = new Set([
  'standardDisplayPreference',
  'useDefaultOrderPrice',
  'updateProductTotal',
]);
const BATCH_PREVIEW_KEYS = new Set(['itemIds', 'standardProductId', 'options']);
const BATCH_APPLY_KEYS = new Set([
  ...BATCH_PREVIEW_KEYS,
  'confirmedOverrideItemIds',
  'confirmedAmountMismatchOrderIds',
  'expectedOrderRevisions',
]);

export function normalizeOrderItemStandardizationBatchPreviewInput(
  value: unknown,
): OrderItemStandardizationBatchPreviewInput {
  const record = requireBatchRecord(value, BATCH_PREVIEW_KEYS, BATCH_PREVIEW_KEYS);
  return {
    itemIds: normalizeBatchItemIds(record.itemIds),
    standardProductId: normalizeBatchProductId(record.standardProductId),
    options: normalizeBatchOptions(record.options),
  };
}

export function normalizeOrderItemStandardizationBatchApplyInput(
  value: unknown,
): OrderItemStandardizationBatchApplyInput {
  const record = requireBatchRecord(value, BATCH_APPLY_KEYS, BATCH_APPLY_KEYS);
  const itemIds = normalizeBatchItemIds(record.itemIds);
  const confirmedOverrideItemIds = normalizeBatchIdList(
    record.confirmedOverrideItemIds,
    '批量关联覆盖确认无效',
  );
  if (confirmedOverrideItemIds.some((itemId) => !itemIds.includes(itemId))) {
    throw new Error('批量关联覆盖确认超出了所选商品明细');
  }
  const confirmedAmountMismatchOrderIds = normalizeBatchIdList(
    record.confirmedAmountMismatchOrderIds,
    '批量关联金额差异确认无效',
  );
  const expectedOrderRevisions = normalizeBatchExpectedOrderRevisions(
    record.expectedOrderRevisions,
  );
  const expectedOrderIds = new Set(expectedOrderRevisions.map(({ orderId }) => orderId));
  if (confirmedAmountMismatchOrderIds.some((orderId) => !expectedOrderIds.has(orderId))) {
    throw new Error('批量关联金额差异确认超出了涉及订单');
  }
  return {
    itemIds,
    standardProductId: normalizeBatchProductId(record.standardProductId),
    options: normalizeBatchOptions(record.options),
    confirmedOverrideItemIds,
    confirmedAmountMismatchOrderIds,
    expectedOrderRevisions,
  };
}

function requireBatchRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('批量关联内容无效');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error('批量关联包含未知字段');
  }
  const missingKey = [...requiredKeys].find((key) => !Object.hasOwn(record, key));
  if (missingKey) throw new Error(`批量关联缺少字段：${missingKey}`);
  return record;
}

function normalizeBatchItemIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_ENTRIES) {
    throw new Error('批量关联商品明细无效');
  }
  const itemIds = value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.trim().length > 200) {
      throw new Error('批量关联商品明细无效');
    }
    return entry.trim();
  });
  if (new Set(itemIds).size !== itemIds.length) {
    throw new Error('批量关联商品明细不能重复');
  }
  return itemIds;
}

function normalizeBatchIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH_ENTRIES) throw new Error(label);
  const ids = value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.trim().length > 200) {
      throw new Error(label);
    }
    return entry.trim();
  });
  if (new Set(ids).size !== ids.length) throw new Error(label);
  return ids;
}

function normalizeBatchProductId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    throw new Error('标准商品标识无效');
  }
  return value.trim();
}

function normalizeBatchOptions(value: unknown): OrderItemStandardizationBatchOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('批量关联选项无效');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !BATCH_OPTION_KEYS.has(key))) {
    throw new Error('批量关联选项包含未知字段');
  }
  if (
    record.standardDisplayPreference !== 'prefer_standard' &&
    record.standardDisplayPreference !== 'prefer_source'
  ) {
    throw new Error('标准商品显示偏好无效');
  }
  if (
    typeof record.useDefaultOrderPrice !== 'boolean' ||
    typeof record.updateProductTotal !== 'boolean'
  ) {
    throw new Error('批量关联选项无效');
  }
  if (record.updateProductTotal && !record.useDefaultOrderPrice) {
    throw new Error('未使用标准商品默认单价时不能同步商品总价');
  }
  return {
    standardDisplayPreference: record.standardDisplayPreference,
    useDefaultOrderPrice: record.useDefaultOrderPrice,
    updateProductTotal: record.updateProductTotal,
  };
}

function normalizeBatchExpectedOrderRevisions(
  value: unknown,
): Array<{ orderId: string; revision: number }> {
  const invalid = () => new Error('订单版本无效，请刷新后重试');
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_ENTRIES) throw invalid();
  const revisions = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== 'orderId' && key !== 'revision') ||
      typeof record.orderId !== 'string' || !record.orderId.trim() ||
      !Number.isSafeInteger(record.revision) || (record.revision as number) < 1
    ) {
      throw invalid();
    }
    return { orderId: record.orderId.trim(), revision: record.revision as number };
  });
  if (new Set(revisions.map(({ orderId }) => orderId)).size !== revisions.length) {
    throw invalid();
  }
  return revisions;
}

export function normalizeUpdateOrderItemStandardizationInput(
  value: unknown,
): UpdateOrderItemStandardizationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('商品标准化修改内容无效');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(['standardProductId', 'standardDisplayPreference', 'expectedRevision']);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error('商品标准化修改包含未知字段');
  }
  if (!('standardProductId' in record)) {
    throw new Error('标准商品标识无效');
  }
  if (
    record.standardProductId !== null &&
    (typeof record.standardProductId !== 'string' || !record.standardProductId.trim())
  ) {
    throw new Error('标准商品标识无效');
  }
  if (!Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 1) {
    throw new Error('订单版本无效，请刷新后重试');
  }
  let standardDisplayPreference: StandardDisplayPreference | undefined;
  if ('standardDisplayPreference' in record) {
    if (
      record.standardDisplayPreference !== 'prefer_standard' &&
      record.standardDisplayPreference !== 'prefer_source'
    ) {
      throw new Error('标准商品显示偏好无效');
    }
    standardDisplayPreference = record.standardDisplayPreference;
  }
  const standardProductId = typeof record.standardProductId === 'string'
    ? record.standardProductId.trim()
    : null;
  if (standardProductId === null && standardDisplayPreference !== undefined) {
    throw new Error('解除商品标准化关联时不能设置标准商品显示偏好');
  }
  return {
    standardProductId,
    ...(standardDisplayPreference !== undefined ? { standardDisplayPreference } : {}),
    expectedRevision: record.expectedRevision as number,
  };
}

export function normalizeProductStandardizationConfirmations(
  value: unknown,
): ProductStandardizationConfirmation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_BATCH_ENTRIES) {
    throw new Error('商品标准化确认内容无效');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('商品标准化确认内容无效');
    }
    const record = entry as Record<string, unknown>;
    const allowed = new Set(['draftItemId', 'standardProductId', 'createMapping']);
    if (Object.keys(record).some((key) => !allowed.has(key))) {
      throw new Error('商品标准化确认包含未知字段');
    }
    if (typeof record.draftItemId !== 'string' || !record.draftItemId.trim()) {
      throw new Error('商品标准化确认目标无效');
    }
    if (
      record.standardProductId !== null &&
      (typeof record.standardProductId !== 'string' || !record.standardProductId.trim())
    ) {
      throw new Error('标准商品标识无效');
    }
    if (typeof record.createMapping !== 'boolean') {
      throw new Error('商品映射确认选项无效');
    }
    if (record.createMapping && record.standardProductId === null) {
      throw new Error('未选择标准商品时不能建立商品映射');
    }
    return {
      draftItemId: record.draftItemId.trim(),
      standardProductId: typeof record.standardProductId === 'string'
        ? record.standardProductId.trim()
        : null,
      createMapping: record.createMapping,
    };
  });
}

export function normalizeStandardProductInput(
  value: unknown,
): CreateStandardProductInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('标准商品内容无效');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'sku',
    'name',
    'specification',
    'defaultOrderPriceCents',
    'priceChangeReason',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error('标准商品包含未知字段');
  }
  const normalized: CreateStandardProductInput = {
    sku: requiredProductText(record.sku, 'SKU', 100),
    name: requiredProductText(record.name, '标准商品名', 300),
    specification: requiredProductText(record.specification, '标准规格', 300),
  };
  if ('defaultOrderPriceCents' in record) {
    normalized.defaultOrderPriceCents = normalizeDefaultOrderPriceCents(
      record.defaultOrderPriceCents,
    );
  }
  if ('priceChangeReason' in record) {
    normalized.priceChangeReason = normalizePriceChangeReason(record.priceChangeReason);
  }
  return normalized;
}

export function normalizeUpdateStandardProductInput(
  value: unknown,
): UpdateStandardProductInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('标准商品修改内容无效');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'sku',
    'name',
    'specification',
    'defaultOrderPriceCents',
    'priceChangeReason',
    'expectedRevision',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error('标准商品修改包含未知字段');
  }
  if (!Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 1) {
    throw new Error('标准商品版本无效');
  }
  if (!('defaultOrderPriceCents' in record)) {
    throw new Error('默认订单单价无效');
  }
  return {
    ...normalizeStandardProductInput({
      sku: record.sku,
      name: record.name,
      specification: record.specification,
    }),
    defaultOrderPriceCents: normalizeDefaultOrderPriceCents(record.defaultOrderPriceCents),
    ...('priceChangeReason' in record
      ? { priceChangeReason: normalizePriceChangeReason(record.priceChangeReason) }
      : {}),
    expectedRevision: record.expectedRevision as number,
  };
}

export function normalizeProductText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN');
}

export function normalizeSkuKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleUpperCase('en-US');
}

export function fuzzyProductSimilarity(
  sourceTitle: string,
  sourceSpec: string,
  product: Pick<StandardProduct, 'name' | 'specification'>,
): number {
  const source = normalizeProductText(`${sourceTitle} ${sourceSpec}`).replace(/\s/gu, '');
  const target = normalizeProductText(`${product.name} ${product.specification}`).replace(/\s/gu, '');
  if (!source || !target) return 0;
  if (source.includes(target) || target.includes(source)) {
    return Math.min(source.length, target.length) / Math.max(source.length, target.length);
  }
  const sourcePairs = characterPairs(source);
  const targetPairs = characterPairs(target);
  const shared = [...sourcePairs].filter((pair) => targetPairs.has(pair)).length;
  const union = new Set([...sourcePairs, ...targetPairs]).size;
  return union === 0 ? 0 : shared / union;
}

/** 相似标题规格判定阈值：商品标准化候选与订单商品明细相似筛选共用同一口径。 */
export const PRODUCT_SIMILARITY_THRESHOLD = 0.35;

export function displayedProductTitle(item: {
  sourceTitle: string;
  standardProduct?: StandardProduct | null;
  standardDisplayPreference?: StandardDisplayPreference | null;
}): string {
  if (item.standardDisplayPreference === 'prefer_source') return item.sourceTitle;
  return item.standardProduct?.name || item.sourceTitle;
}

export function displayedProductSpecification(item: {
  sourceSpec: string;
  standardProduct?: StandardProduct | null;
  standardDisplayPreference?: StandardDisplayPreference | null;
}): string {
  if (item.standardDisplayPreference === 'prefer_source') return item.sourceSpec;
  return item.standardProduct?.specification || item.sourceSpec;
}

function characterPairs(value: string): Set<string> {
  const characters = [...value];
  if (characters.length === 1) return new Set(characters);
  return new Set(characters.slice(0, -1).map((character, index) => (
    `${character}${characters[index + 1]}`
  )));
}

function normalizeDefaultOrderPriceCents(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('默认订单单价无效');
  }
  return value as number;
}

function normalizePriceChangeReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('价格变更原因无效');
  const reason = value.trim();
  if (!reason || reason.length > 500) throw new Error('价格变更原因无效');
  return reason;
}

function requiredProductText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label}无效`);
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > maximumLength) throw new Error(`${label}无效`);
  return normalized;
}
