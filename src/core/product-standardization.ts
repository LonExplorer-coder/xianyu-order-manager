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

/** 商品映射的三级适用范围：当前平台与卖家账号、当前平台全部账号或整个工作区。 */
export type ProductMappingScope = 'current_account' | 'current_platform' | 'workspace';

/** 商品映射的当前状态：有效或已停用；停用保留行与历史但不再参与匹配。 */
export type ProductMappingStatus = 'active' | 'disabled';

/** 商品映射的建立来源：关联确认建立或手工新增。 */
export type ProductMappingOrigin = 'confirmation' | 'manual';

/** 不可变商品映射变更事件的操作类型。 */
export type ProductMappingEventType = 'created' | 'corrected' | 'disabled' | 'deleted';

/** 商品映射变更事件的前值或后值快照。 */
export type ProductMappingEventSnapshot = {
  sourceTitle: string;
  sourceSpec: string;
  standardProductId: string;
  scope: ProductMappingScope;
  platform: string | null;
  sellerAccount: string | null;
  status: ProductMappingStatus;
};

/** 不可变商品映射变更事件：前后值快照、来源、原因与时间；删除映射后仍按标准商品可查。 */
export type ProductMappingEvent = {
  id: string;
  mappingId: string;
  standardProductId: string;
  eventType: ProductMappingEventType;
  before: ProductMappingEventSnapshot | null;
  after: ProductMappingEventSnapshot | null;
  origin: ProductMappingOrigin;
  reason: string;
  occurredAt: string;
  createdAt: string;
};

export type ProductMapping = {
  id: string;
  sourceTitle: string;
  sourceSpec: string;
  scope: ProductMappingScope;
  platform: string | null;
  sellerAccount: string | null;
  standardProductId: string;
  status: ProductMappingStatus;
  origin: ProductMappingOrigin;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 商品映射可视列表行：映射本身、目标 SKU 与标准商品、命中订单数投影。 */
export type ProductMappingView = ProductMapping & {
  sourceTitleKey: string;
  sourceSpecKey: string;
  targetProductSku: string;
  targetProductName: string;
  hitOrderCount: number;
};

/** 标准商品详情的映射区域统计，全部由关联事实投影。 */
export type ProductMappingStats = {
  activeMappingCount: number;
  linkedOrderCount: number;
  linkedItemCount: number;
  linkedTotalQuantity: number;
};

export type CreateProductMappingInput = {
  sourceTitle: string;
  sourceSpec: string;
  scope: ProductMappingScope;
  platform: string | null;
  sellerAccount: string | null;
};

export type CorrectProductMappingInput = {
  standardProductId?: string;
  scope?: ProductMappingScope;
  platform?: string | null;
  sellerAccount?: string | null;
  reason: string;
};

export type ProductMappingReasonInput = {
  reason: string;
};

/**
 * 映射冲突查询：校对确认等有订单上下文的入口在建立映射前，
 * 按当前账号适用范围查找相同规范化原文的有效映射（规格 4.4）。
 */
export type ProductMappingConflictQueryInput = {
  sourceTitle: string;
  sourceSpec: string;
  platform: string;
  sellerAccount: string;
};

/** 命中投影所需的映射关联事实：source='mapping' 的订单商品明细。 */
export type ProductMappingHitFact = {
  sourceTitle: string;
  sourceSpec: string;
  standardProductId: string;
  orderId: string;
  quantity: number;
};

export type ProductMappingHitSummary = {
  orderCount: number;
  itemCount: number;
  totalQuantity: number;
};

/** 映射匹配上下文：待匹配订单商品所属的平台与卖家账号。 */
export type ProductMappingMatchContext = {
  platform: string;
  sellerAccount: string;
};

export type ProductMappingMatch = {
  standardProductId: string;
  scope: ProductMappingScope;
};

/**
 * 规格 4.3 的映射匹配优先级：当前账号映射 → 当前平台映射 → 工作区映射。
 * 传入的候选映射已由调用方按规范化原文标题与规格筛好（且只含有效映射）；
 * 返回命中结果及其来源行，供调用方更新最近使用时间。
 */
export function selectProductMappingMatch<
  Row extends Pick<
    ProductMapping,
    'scope' | 'platform' | 'sellerAccount' | 'standardProductId'
  >,
>(
  mappings: readonly Row[],
  context: ProductMappingMatchContext,
): (ProductMappingMatch & { row: Row }) | null {
  const account = mappings.find((mapping) => (
    mapping.scope === 'current_account' &&
    mapping.platform === context.platform &&
    mapping.sellerAccount === context.sellerAccount
  ));
  if (account) {
    return {
      standardProductId: account.standardProductId,
      scope: 'current_account',
      row: account,
    };
  }
  const platform = mappings.find((mapping) => (
    mapping.scope === 'current_platform' && mapping.platform === context.platform
  ));
  if (platform) {
    return {
      standardProductId: platform.standardProductId,
      scope: 'current_platform',
      row: platform,
    };
  }
  const workspace = mappings.find((mapping) => mapping.scope === 'workspace');
  if (workspace) {
    return {
      standardProductId: workspace.standardProductId,
      scope: 'workspace',
      row: workspace,
    };
  }
  return null;
}

/** 映射的规范化原文匹配键，命中投影与列表查询共用同一口径。 */
export function productMappingSourceKey(sourceTitle: string, sourceSpec: string): string {
  return `${normalizeProductText(sourceTitle)}\u0000${normalizeProductText(sourceSpec)}`;
}

/**
 * 命中统计由关联事实（standardization_source='mapping' 的订单商品明细）投影，
 * 按规范化原文键与目标商品汇总命中订单数、明细数与商品总数量，不另存计数副本。
 * 同一原文可在不同范围指向不同商品（规格 4.4 只约束同范围唯一），
 * 因此汇总键必须带目标商品，避免跨商品串数。
 */
export function summarizeProductMappingHits(
  facts: readonly ProductMappingHitFact[],
): ReadonlyMap<string, ProductMappingHitSummary> {
  const orderIdsByKey = new Map<string, Set<string>>();
  const summaries = new Map<string, ProductMappingHitSummary>();
  for (const fact of facts) {
    const key = productMappingHitKey(fact.sourceTitle, fact.sourceSpec, fact.standardProductId);
    const orderIds = orderIdsByKey.get(key) ?? new Set<string>();
    orderIds.add(fact.orderId);
    orderIdsByKey.set(key, orderIds);
    const summary = summaries.get(key) ?? { orderCount: 0, itemCount: 0, totalQuantity: 0 };
    summary.itemCount += 1;
    summary.totalQuantity += fact.quantity;
    summaries.set(key, summary);
  }
  for (const [key, summary] of summaries) {
    summary.orderCount = orderIdsByKey.get(key)?.size ?? 0;
  }
  return summaries;
}

/** 命中投影键：规范化原文键 + 目标商品，命中投影与映射视图查询共用同一口径。 */
export function productMappingHitKey(
  sourceTitle: string,
  sourceSpec: string,
  standardProductId: string,
): string {
  return `${productMappingSourceKey(sourceTitle, sourceSpec)}\u0000${standardProductId}`;
}

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
  automaticMappingScope: ProductMappingScope | null;
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
  | 'amount_mismatch'
  | 'mapping_conflict';

export type OrderItemStandardizationBatchOptions = {
  standardDisplayPreference: StandardDisplayPreference;
  useDefaultOrderPrice: boolean;
  updateProductTotal: boolean;
  /** 勾选后按当前账号适用范围为成功关联的明细建立商品映射（规格第 6 节默认不勾）。 */
  createMappings: boolean;
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
    /** 映射冲突明细的逐条确认：确认后按单笔例外关联，不建立也不修改商品映射。 */
    confirmedMappingConflictItemIds: string[];
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
  /** 该明细所属订单的当前账号适用范围内、相同规范化原文的有效商品映射目标；无有效映射为 null。 */
  currentAccountMappingProductId: string | null;
  /** 该明细在当前账号适用范围内的映射键（平台|卖家账号|规范化标题|规范化规格）。 */
  currentAccountMappingKey: string;
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
  createMappingsRequested: boolean;
  plannedMappingCreationCount: number;
  mappingConflictCount: number;
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
  createMappingsRequested: boolean;
  plannedMappingCreationCount: number;
  mappingConflictCount: number;
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
  createdMappingCount: number;
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
    // 规格第 6 节：相同原文已有指向其他 SKU 的有效映射不能静默通过。
    const mappingProductId = itemStateById.get(plan.itemId)?.currentAccountMappingProductId ?? null;
    if (
      options.createMappings &&
      mappingProductId !== null &&
      mappingProductId !== product.id
    ) {
      blockReasons.push('mapping_conflict');
    }
    plan.blockReasons = blockReasons;
  }

  return {
    priceSyncRequested: options.useDefaultOrderPrice,
    priceSyncAvailable,
    defaultOrderPriceCents: product.defaultOrderPriceCents,
    createMappingsRequested: options.createMappings,
    // 规格第 6 节：预计新增条数按映射键去重（同原文多条明细只建一条映射），
    // 映射冲突明细按单笔例外处理后不建映射，不计入。
    plannedMappingCreationCount: options.createMappings
      ? new Set(items.flatMap((item, index) => (
          item.currentAccountMappingProductId === null &&
          !itemPlans[index].blockReasons.includes('mapping_conflict')
            ? [item.currentAccountMappingKey]
            : []
        ))).size
      : 0,
    mappingConflictCount: itemPlans.filter(
      (plan) => plan.blockReasons.includes('mapping_conflict'),
    ).length,
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
  'createMappings',
]);
const BATCH_PREVIEW_KEYS = new Set(['itemIds', 'standardProductId', 'options']);
const BATCH_APPLY_KEYS = new Set([
  ...BATCH_PREVIEW_KEYS,
  'confirmedOverrideItemIds',
  'confirmedAmountMismatchOrderIds',
  'confirmedMappingConflictItemIds',
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
  const options = normalizeBatchOptions(record.options);
  const confirmedMappingConflictItemIds = normalizeBatchIdList(
    record.confirmedMappingConflictItemIds,
    '批量关联映射冲突确认无效',
  );
  if (confirmedMappingConflictItemIds.some((itemId) => !itemIds.includes(itemId))) {
    throw new Error('批量关联映射冲突确认超出了所选商品明细');
  }
  if (!options.createMappings && confirmedMappingConflictItemIds.length > 0) {
    throw new Error('未勾选建立商品映射时不能确认映射冲突');
  }
  return {
    itemIds,
    standardProductId: normalizeBatchProductId(record.standardProductId),
    options,
    confirmedOverrideItemIds,
    confirmedAmountMismatchOrderIds,
    confirmedMappingConflictItemIds,
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
    typeof record.updateProductTotal !== 'boolean' ||
    typeof record.createMappings !== 'boolean'
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
    createMappings: record.createMappings,
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

const CREATE_MAPPING_KEYS = new Set([
  'sourceTitle',
  'sourceSpec',
  'scope',
  'platform',
  'sellerAccount',
]);
const CORRECT_MAPPING_KEYS = new Set([
  'standardProductId',
  'scope',
  'platform',
  'sellerAccount',
  'reason',
]);

export function normalizeCreateProductMappingInput(
  value: unknown,
): CreateProductMappingInput {
  const record = requireMappingRecord(value, '商品映射', CREATE_MAPPING_KEYS);
  return {
    sourceTitle: requiredProductText(record.sourceTitle, '原始商品标题', 300),
    sourceSpec: normalizeMappingSourceSpec(record.sourceSpec),
    ...normalizeMappingScopeFields(record),
  };
}

export function normalizeCorrectProductMappingInput(
  value: unknown,
): CorrectProductMappingInput {
  const record = requireMappingRecord(value, '商品映射更正', CORRECT_MAPPING_KEYS);
  const reason = normalizeMappingChangeReason(record.reason);
  const result: CorrectProductMappingInput = { reason };
  let hasChange = false;
  if ('standardProductId' in record) {
    result.standardProductId = normalizeBatchProductId(record.standardProductId);
    hasChange = true;
  }
  if ('scope' in record) {
    Object.assign(result, normalizeMappingScopeFields(record));
    hasChange = true;
  }
  if (!hasChange) throw new Error('商品映射更正内容为空');
  return result;
}

export function normalizeProductMappingReasonInput(
  value: unknown,
): ProductMappingReasonInput {
  const record = requireMappingRecord(value, '商品映射操作', new Set(['reason']));
  return { reason: normalizeMappingChangeReason(record.reason) };
}

const MAPPING_CONFLICT_QUERY_KEYS = new Set([
  'sourceTitle',
  'sourceSpec',
  'platform',
  'sellerAccount',
]);

export function normalizeProductMappingConflictQueryInput(
  value: unknown,
): ProductMappingConflictQueryInput {
  const record = requireMappingRecord(value, '商品映射冲突查询', MAPPING_CONFLICT_QUERY_KEYS);
  const platform = normalizeOptionalMappingText(record.platform);
  const sellerAccount = normalizeOptionalMappingText(record.sellerAccount);
  if (!platform || !sellerAccount) {
    throw new Error('商品映射冲突查询必须提供平台与卖家账号');
  }
  return {
    sourceTitle: requiredProductText(record.sourceTitle, '原始商品标题', 300),
    sourceSpec: normalizeMappingSourceSpec(record.sourceSpec),
    platform,
    sellerAccount,
  };
}

export function normalizeProductMappingSearch(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('商品映射搜索内容无效');
  const normalized = value.trim();
  if (normalized.length > 300) throw new Error('商品映射搜索内容无效');
  return normalized;
}

function requireMappingRecord(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}内容无效`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label}包含未知字段`);
  }
  return record;
}

function normalizeMappingScopeFields(record: Record<string, unknown>): {
  scope: ProductMappingScope;
  platform: string | null;
  sellerAccount: string | null;
} {
  const scope = record.scope;
  if (scope !== 'current_account' && scope !== 'current_platform' && scope !== 'workspace') {
    throw new Error('商品映射适用范围无效');
  }
  const platform = normalizeOptionalMappingText(record.platform);
  const sellerAccount = normalizeOptionalMappingText(record.sellerAccount);
  if (scope === 'current_account' && (!platform || !sellerAccount)) {
    throw new Error('当前平台与卖家账号级映射必须提供平台与卖家账号');
  }
  if (scope === 'current_platform') {
    if (!platform) throw new Error('当前平台级映射必须提供平台');
    if (sellerAccount) throw new Error('当前平台级映射不能包含卖家账号');
  }
  if (scope === 'workspace' && (platform || sellerAccount)) {
    throw new Error('工作区级映射不能包含平台或卖家账号');
  }
  return { scope, platform, sellerAccount };
}

function normalizeOptionalMappingText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('商品映射范围字段无效');
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (normalized.length > 200) throw new Error('商品映射范围字段无效');
  return normalized || null;
}

function normalizeMappingSourceSpec(value: unknown): string {
  if (typeof value !== 'string') throw new Error('原始规格无效');
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (normalized.length > 300) throw new Error('原始规格无效');
  return normalized;
}

function normalizeMappingChangeReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('映射变更原因无效');
  const reason = value.trim();
  if (!reason || reason.length > 500) throw new Error('映射变更原因无效');
  return reason;
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
