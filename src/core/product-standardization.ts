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

export function normalizeProductStandardizationConfirmations(
  value: unknown,
): ProductStandardizationConfirmation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) {
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

export function displayedProductTitle(item: {
  sourceTitle: string;
  standardProduct?: StandardProduct | null;
}): string {
  return item.standardProduct?.name || item.sourceTitle;
}

export function displayedProductSpecification(item: {
  sourceSpec: string;
  standardProduct?: StandardProduct | null;
}): string {
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
