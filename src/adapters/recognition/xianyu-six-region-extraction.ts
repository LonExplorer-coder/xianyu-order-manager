import type {
  PlatformTransactionStatus,
  RecognitionConflictDetail,
  RecognitionConflictField,
  RecognitionConflictKind,
} from '../../core/contracts';
import { RECOGNITION_CONFLICT_LIMITS } from '../../core/contracts';
import {
  deriveAddressParts,
  normalizeAddress,
} from '../../core/order-normalization';
import {
  semanticExcludedLines,
  semanticRegionContainsText,
  semanticRegionRows,
  type XianyuSemanticRegionId,
  type XianyuSemanticRegionLayout,
} from './xianyu-semantic-regions';
import {
  looksLikeXianyuKieInstructionEcho as looksLikeInstructionEcho,
} from './xianyu-kie-schema';

type ExtractionModule = Record<string, unknown>;

export type XianyuSixRegionModularExtraction = {
  page_header_status_text: unknown;
  purchased_items: ExtractionModule;
  shipping_information: ExtractionModule;
  transaction_information: ExtractionModule;
  page_context: {
    top_status_text: unknown;
    global_controls: unknown;
    excluded_regions: string[];
  };
};

export type XianyuSixRegionProcessingResult = {
  modularExtraction: XianyuSixRegionModularExtraction;
  hasCriticalConflict: boolean;
  recognitionConflicts: RecognitionConflictDetail[];
};

export function processXianyuSixRegionExtraction(input: {
  extracted: Record<string, unknown>;
  layout: XianyuSemanticRegionLayout;
  processedOrderNumber?: string;
}): XianyuSixRegionProcessingResult {
  const { extracted, layout } = input;
  const recognitionConflicts = sixRegionExtractionConflicts(
    extracted,
    layout,
    input.processedOrderNumber ?? '',
  );
  const modules = recoverSixRegionModules({
    platformStatus: constrainRegionFields(
      recordOrEmpty(extracted.platform_status),
      layout,
      'platform_status',
      ['top_status_text'],
    ),
    shipping: {
      ...constrainRegionFields(
        recordOrEmpty(extracted.shipping_information),
        layout,
        'shipping_information',
        [
          'recipient',
          'recipient_phone_line_text',
          'phone',
          'address',
          'province',
          'city',
          'district',
        ],
      ),
      controls: supportedRegionStrings(
        recordOrEmpty(extracted.shipping_information).controls,
        layout,
        'shipping_information',
      ),
    },
    purchasedItems: {
      ...recordOrEmpty(extracted.purchased_items),
      items: constrainPurchasedItems(
        recordOrEmpty(extracted.purchased_items).items,
        layout,
      ),
      controls: supportedRegionStrings(
        recordOrEmpty(extracted.purchased_items).controls,
        layout,
        'purchased_items',
      ),
    },
    amountSummary: constrainSemanticAmounts(
      recordOrEmpty(extracted.amount_summary),
      layout,
    ),
    orderDetails: constrainSemanticOrderDetails(
      extracted,
      layout,
      input.processedOrderNumber ?? '',
    ),
    fulfillment: {
      ...recordOrEmpty(extracted.fulfillment_signals),
      global_controls: supportedRegionStrings(
        recordOrEmpty(extracted.fulfillment_signals).global_controls,
        layout,
        'fulfillment_signals',
      ),
    },
  }, layout);
  const topStatusText = modules.platformStatus.top_status_text;

  return {
    hasCriticalConflict: recognitionConflicts.length > 0,
    recognitionConflicts,
    modularExtraction: {
      page_header_status_text: topStatusText,
      purchased_items: modules.purchasedItems,
      shipping_information: modules.shipping,
      transaction_information: {
        ...modules.orderDetails,
        ...modules.amountSummary,
        platform_transaction_status: null,
        fulfillment_status: null,
      },
      page_context: {
        top_status_text: topStatusText,
        global_controls: modules.fulfillment.global_controls,
        excluded_regions: semanticExcludedLines(layout),
      },
    },
  };
}

function constrainRegionFields(
  source: Record<string, unknown>,
  layout: XianyuSemanticRegionLayout,
  regionId: XianyuSemanticRegionId,
  keys: readonly string[],
): Record<string, unknown> {
  const constrained: Record<string, unknown> = { ...source };
  for (const key of keys) {
    constrained[key] = supportedRegionValue(source[key], layout, regionId);
  }
  return constrained;
}

function constrainSemanticOrderDetails(
  extracted: Record<string, unknown>,
  layout: XianyuSemanticRegionLayout,
  processedOrderNumberValue: string,
): Record<string, unknown> {
  const source = recordOrEmpty(extracted.order_details);
  const lines = semanticRegionRows(layout, 'order_details');
  const expected = expectedSemanticOrderDetails(lines);
  const constrained: Record<string, unknown> = {
    ...source,
    detail_state: supportedDetailState(
      source.detail_state,
      expected.detail_state,
    ),
    order_number: supportedLabeledText(
      source.order_number,
      expected.order_number,
    ),
    alipay_transaction_number: supportedLabeledText(
      source.alipay_transaction_number,
      expected.alipay_transaction_number,
    ),
    buyer_nickname_label: supportedLabeledText(
      source.buyer_nickname_label,
      expected.buyer_nickname_label,
    ),
    buyer_nickname: supportedLabeledText(
      source.buyer_nickname,
      expected.buyer_nickname,
    ),
    order_time: supportedLabeledText(source.order_time, expected.order_time),
    payment_time: supportedLabeledText(
      source.payment_time,
      expected.payment_time,
    ),
  };
  const processedOrderNumber = validatedOrderNumber(processedOrderNumberValue);
  if (
    isMissingExtractedValue(constrained.order_number) &&
    !expected.order_number &&
    processedOrderNumber &&
    processedOrderNumber === validatedOrderNumber(source.order_number)
  ) {
    constrained.order_number = processedOrderNumber;
  }
  return {
    ...constrained,
    controls: supportedRegionStrings(source.controls, layout, 'order_details'),
  };
}

function constrainSemanticAmounts(
  source: Record<string, unknown>,
  layout: XianyuSemanticRegionLayout,
): Record<string, unknown> {
  const expected = expectedSemanticAmounts(
    semanticRegionRows(layout, 'amount_summary'),
  );
  return {
    ...source,
    product_total: supportedLabeledMoney(
      source.product_total,
      expected.product_total,
    ),
    shipping_fee: supportedLabeledMoney(
      source.shipping_fee,
      expected.shipping_fee,
    ),
    amount: supportedLabeledMoney(source.amount, expected.amount),
  };
}

type SemanticExpectedOrderDetails = {
  detail_state: 'collapsed' | 'expanded' | 'unknown';
  order_number?: string;
  alipay_transaction_number?: string;
  buyer_nickname_label?: string;
  buyer_nickname?: string;
  order_time?: string;
  payment_time?: string;
};

type SemanticExpectedAmounts = {
  product_total?: string;
  shipping_fee?: string;
  amount?: string;
};

function expectedSemanticOrderDetails(
  lines: string[],
): SemanticExpectedOrderDetails {
  const expanded = lines.some((line) =>
    /(?:支付宝交易号|买家昵称|下单时间|付款时间|订单时间|支付时间)/u.test(line)
  );
  const collapsed = lines.some((line) =>
    /(?:展开|查看更多|显示全部)/u.test(line)
  );
  return {
    detail_state: expanded ? 'expanded' : collapsed ? 'collapsed' : 'unknown',
    order_number: semanticIdentifierAfterLabel(lines, /(?:订单编号|订单号)/u),
    alipay_transaction_number: semanticIdentifierAfterLabel(
      lines,
      /支付宝交易号/u,
      { appendNumericContinuation: true },
    ),
    buyer_nickname_label: semanticLinesContainLabel(lines, /买家昵称/u)
      ? '买家昵称'
      : undefined,
    buyer_nickname: semanticTextAfterLabel(lines, /买家昵称/u),
    order_time: semanticDateTimeAfterLabel(lines, /(?:下单时间|订单时间)/u),
    payment_time: semanticDateTimeAfterLabel(lines, /(?:付款时间|支付时间)/u),
  };
}

function expectedSemanticAmounts(lines: string[]): SemanticExpectedAmounts {
  return {
    product_total: semanticMoneyAfterLabel(lines, /商品总价/u),
    shipping_fee: semanticMoneyAfterLabel(lines, /运费/u),
    amount: semanticMoneyAfterLabel(lines, /(?:成交价|实付金额)/u),
  };
}

function supportedLabeledText(value: unknown, expected?: string): unknown {
  if (isMissingExtractedValue(value)) return value;
  if (typeof value !== 'string' || !expected) return null;
  return comparableText(value) === comparableText(expected) ? value : null;
}

function supportedDetailState(
  value: unknown,
  expected: SemanticExpectedOrderDetails['detail_state'],
): unknown {
  if (isMissingExtractedValue(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!['collapsed', 'expanded', 'unknown'].includes(normalized)) return null;
  return expected === 'unknown' || normalized === expected ? normalized : null;
}

function supportedLabeledMoney(value: unknown, expected?: string): unknown {
  if (isMissingExtractedValue(value)) return value;
  if (expected === undefined) return null;
  try {
    return moneyToCents(value) === moneyToCents(expected) ? value : null;
  } catch {
    return null;
  }
}

function constrainPurchasedItems(
  value: unknown,
  layout: XianyuSemanticRegionLayout,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const sections = semanticItemSections(
    semanticRegionRows(layout, 'purchased_items'),
  );
  return value
    .map(recordOrEmpty)
    .flatMap((item, index) => {
      if (!semanticRegionContainsText(layout, 'purchased_items', item.title)) {
        return [];
      }
      const section = semanticSectionForItem(item, sections, index);
      if (!section) return [];
      const extractedQuantity = positiveQuantity(item.quantity);
      const quantityIsSupported = !extractedQuantity.inferred &&
        section.quantity?.value === extractedQuantity.value;
      return [{
        ...item,
        spec: isMissingExtractedValue(item.spec) ||
          semanticSectionContainsText(section, item.spec)
            ? item.spec
            : null,
        unit_price: isMissingExtractedValue(item.unit_price) ||
          semanticSectionSupportsMoney(section, item.unit_price)
            ? item.unit_price
            : null,
        price_tag_text: isMissingExtractedValue(item.price_tag_text) ||
          semanticSectionSupportsMoney(section, item.price_tag_text)
            ? item.price_tag_text
            : null,
        quantity: quantityIsSupported ? item.quantity : null,
        quantity_text: quantityIsSupported ? item.quantity_text : null,
      }];
    });
}

type SemanticItemSection = {
  lines: string[];
  title: string;
  titleAmbiguous: boolean;
  unitPrice: string;
  specification?: string;
  quantity?: { value: number; raw: string };
};

function semanticItemSections(lines: string[]): SemanticItemSection[] {
  const sections: SemanticItemSection[] = [];
  let pendingTitleLines: string[] = [];
  let pendingTitleIsAmbiguous = false;
  for (const line of lines) {
    const price = semanticPrice(line);
    if (price) {
      const titleOnPriceLine = line
        .slice(0, price.index)
        .replace(/(?:单价|价格)\s*[:：]?\s*$/u, '')
        .trim();
      sections.push({
        lines: [...pendingTitleLines, line],
        title: pendingTitleIsAmbiguous
          ? ''
          : [...pendingTitleLines, titleOnPriceLine]
            .map((part) => part.trim())
            .filter(Boolean)
            .join(''),
        titleAmbiguous: pendingTitleIsAmbiguous,
        unitPrice: price.value,
      });
      pendingTitleLines = [];
      pendingTitleIsAmbiguous = false;
      continue;
    }
    if (semanticItemMetadataLine(line)) {
      if (pendingTitleLines.length > 0) {
        sections.at(-1)?.lines.push(...pendingTitleLines);
        pendingTitleLines = [];
      }
      pendingTitleIsAmbiguous = false;
      sections.at(-1)?.lines.push(line);
      continue;
    }
    pendingTitleLines.push(line);
    if (semanticUnknownLabeledItemLine(line)) {
      pendingTitleIsAmbiguous = true;
    }
  }
  if (pendingTitleLines.length > 0) {
    sections.at(-1)?.lines.push(...pendingTitleLines);
  }
  return sections.map((section) => ({
    ...section,
    specification: semanticSpecification(section.lines),
    quantity: semanticExplicitQuantity(section.lines),
  }));
}

function semanticItemMetadataLine(line: string): boolean {
  const normalized = line.normalize('NFKC').replace(/\s+/gu, '');
  return /^(?:款式|规格|颜色|色号|尺码|尺寸|型号|款号|套餐|版本|容量|口味|材质|样式|类型)[:：]?/iu.test(
    normalized,
  ) || /(?:[x×]\d+|数量[:：]?\d+|共\d+件)/iu.test(normalized);
}

function semanticUnknownLabeledItemLine(line: string): boolean {
  const normalized = line.normalize('NFKC').replace(/\s+/gu, '');
  return /^[\p{L}\p{N}]{1,12}[:：].+/u.test(normalized);
}

function semanticSectionForItem(
  item: Record<string, unknown>,
  sections: SemanticItemSection[],
  fallbackIndex: number,
): SemanticItemSection | undefined {
  const title = typeof item.title === 'string' ? comparableText(item.title) : '';
  return sections.find((section) =>
    title && comparableText(section.lines.join('')).includes(title)
  ) ?? sections[fallbackIndex];
}

function semanticSectionContainsText(
  section: SemanticItemSection,
  value: unknown,
): boolean {
  if (typeof value !== 'string') return false;
  const candidate = comparableText(value);
  return Boolean(
    candidate && comparableText(section.lines.join('')).includes(candidate),
  );
}

function semanticSectionSupportsMoney(
  section: SemanticItemSection,
  value: unknown,
): boolean {
  try {
    return moneyToCents(value) === moneyToCents(section.unitPrice);
  } catch {
    return false;
  }
}

function semanticSpecification(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = /(?:款式|规格)\s*[:：]?\s*(.*?)(?=\s*(?:[x×]\s*\d|数量\s*[:：]?\s*\d|共\s*\d+\s*件)|$)/iu.exec(
      line,
    );
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function semanticExplicitQuantity(
  lines: string[],
): { value: number; raw: string } | undefined {
  for (const line of lines) {
    const match = /(?:[x×]\s*(\d+)|数量\s*[:：]?\s*(\d+)|共\s*(\d+)\s*件)/iu.exec(line);
    const raw = match?.[0]?.trim();
    const quantity = Number(match?.slice(1).find(Boolean));
    if (raw && Number.isSafeInteger(quantity) && quantity >= 1) {
      return { value: quantity, raw };
    }
  }
  return undefined;
}

function supportedRegionStrings(
  value: unknown,
  layout: XianyuSemanticRegionLayout,
  regionId: XianyuSemanticRegionId,
): string[] {
  return stringList(value).filter((entry) =>
    semanticRegionContainsText(layout, regionId, entry)
  );
}

function supportedRegionValue(
  value: unknown,
  layout: XianyuSemanticRegionLayout,
  regionId: XianyuSemanticRegionId,
): unknown {
  if (isMissingExtractedValue(value)) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return semanticRegionSupportsScalar(layout, regionId, String(value))
    ? value
    : null;
}

function semanticRegionSupportsScalar(
  layout: XianyuSemanticRegionLayout,
  regionId: XianyuSemanticRegionId,
  value: string,
): boolean {
  if (semanticRegionContainsText(layout, regionId, value)) return true;
  const candidate = value.normalize('NFKC').trim();
  if (/^\d$/u.test(candidate)) {
    const exactDigit = new RegExp(`(?:^|\\D)${candidate}(?:\\D|$)`, 'u');
    return semanticRegionRows(layout, regionId).some((line) =>
      exactDigit.test(line.normalize('NFKC'))
    );
  }
  if (/^\p{Script=Han}$/u.test(candidate)) {
    return semanticRegionRows(layout, regionId).some((line) => line.includes(candidate));
  }
  return false;
}

function sixRegionExtractionConflicts(
  extracted: Record<string, unknown>,
  layout: XianyuSemanticRegionLayout,
  processedOrderNumber: string,
): RecognitionConflictDetail[] {
  const conflicts = moduleStructureConflicts(extracted);
  const platformLines = semanticRegionRows(layout, 'platform_status');
  const platformStatuses = semanticPlatformStatuses(platformLines);
  const platformModule = recordOrEmpty(extracted.platform_status);
  if (platformStatuses.length > 1) {
    conflicts.push(createConflictDetail({
      region: 'platform_status',
      field: 'platform_status',
      kind: 'multiple_candidates',
      locatedValues: platformLines.filter((line) =>
        semanticPlatformStatuses([line]).length > 0
      ),
      extractedValues: conflictValues(platformModule.top_status_text),
      retainedValue: null,
    }));
  }

  const shippingLines = semanticRegionRows(layout, 'shipping_information');
  const shippingPhones = semanticPhones(shippingLines);
  const shippingModule = recordOrEmpty(extracted.shipping_information);
  if (shippingPhones.length > 1) {
    conflicts.push(createConflictDetail({
      region: 'shipping_information',
      field: 'phone',
      kind: 'multiple_candidates',
      locatedValues: shippingPhones,
      extractedValues: conflictValues(shippingModule.phone),
      retainedValue: null,
    }));
  }

  conflicts.push(...amountSummaryConflicts(extracted, layout));
  conflicts.push(...orderDetailsConflicts(extracted, layout, processedOrderNumber));
  conflicts.push(...purchasedItemsConflicts(extracted, layout));

  const locatedPlatformStatus = platformLines.find((line) =>
    semanticPlatformStatuses([line]).length === 1
  );
  const locatedShipping = recoverSemanticShipping({}, shippingLines);
  const checks: Array<{
    module: Record<string, unknown>;
    regionId: RecognitionConflictDetail['region'];
    fields: Array<{
      key: string;
      field: RecognitionConflictField;
      retainedValue: unknown;
    }>;
  }> = [
    {
      module: platformModule,
      regionId: 'platform_status',
      fields: [{
        key: 'top_status_text',
        field: 'platform_status',
        retainedValue: locatedPlatformStatus,
      }],
    },
    {
      module: shippingModule,
      regionId: 'shipping_information',
      fields: [
        { key: 'recipient', field: 'recipient', retainedValue: locatedShipping.recipient },
        {
          key: 'recipient_phone_line_text',
          field: 'recipient_phone_line_text',
          retainedValue: locatedShipping.recipient_phone_line_text,
        },
        { key: 'phone', field: 'phone', retainedValue: locatedShipping.phone },
        { key: 'address', field: 'address', retainedValue: locatedShipping.address },
        { key: 'province', field: 'province', retainedValue: locatedShipping.province },
        { key: 'city', field: 'city', retainedValue: locatedShipping.city },
        { key: 'district', field: 'district', retainedValue: locatedShipping.district },
      ],
    },
  ];
  for (const { module, regionId, fields } of checks) {
    for (const { key, field, retainedValue } of fields) {
      const value = module[key];
      const retainedConflictValue = conflictValue(retainedValue);
      const usesAddressHierarchy = regionId === 'shipping_information' &&
        ['province', 'city', 'district'].includes(field) &&
        retainedConflictValue !== null;
      const isSupported = usesAddressHierarchy
        ? comparableText(value) === comparableText(retainedConflictValue)
        : supportedRegionValue(value, layout, regionId) !== null;
      if (
        isMissingExtractedValue(value) ||
        isSupported
      ) {
        continue;
      }
      conflicts.push(createConflictDetail({
        region: regionId,
        field,
        kind: looksLikeInstructionEcho(value)
          ? 'instruction_echo'
          : retainedConflictValue === null
            ? 'unsupported_value'
            : 'value_mismatch',
        locatedValues: conflictValues(retainedValue),
        extractedValues: conflictValues(value),
        retainedValue: conflictValue(retainedValue),
      }));
    }
  }
  conflicts.push(...regionControlConflicts({
    value: shippingModule.controls,
    layout,
    region: 'shipping_information',
    field: 'shipping_controls',
    knownControls: ['复制', '去发货'],
  }));
  const purchasedModule = recordOrEmpty(extracted.purchased_items);
  conflicts.push(...regionControlConflicts({
    value: purchasedModule.controls,
    layout,
    region: 'purchased_items',
    field: 'item_controls',
    knownControls: [],
  }));
  const orderDetailsModule = recordOrEmpty(extracted.order_details);
  conflicts.push(...regionControlConflicts({
    value: orderDetailsModule.controls,
    layout,
    region: 'order_details',
    field: 'order_detail_controls',
    knownControls: ['复制', '交易快照', '展开', '收起'],
  }));
  return conflicts.slice(0, RECOGNITION_CONFLICT_LIMITS.details);
}

function moduleStructureConflicts(
  extracted: Record<string, unknown>,
): RecognitionConflictDetail[] {
  const modules: Array<[
    string,
    RecognitionConflictDetail['region'],
  ]> = [
    ['platform_status', 'platform_status'],
    ['shipping_information', 'shipping_information'],
    ['purchased_items', 'purchased_items'],
    ['amount_summary', 'amount_summary'],
    ['order_details', 'order_details'],
  ];
  const conflicts = modules.flatMap(([key, region]) => {
    const value = extracted[key];
    if (isMissingExtractedValue(value) || isRecord(value)) return [];
    return [createConflictDetail({
      region,
      field: 'module_structure',
      kind: containsInstructionEcho(value)
        ? 'instruction_echo'
        : 'unsupported_value',
      locatedValues: [],
      extractedValues: conflictValues(value),
      retainedValue: null,
    })];
  });
  const purchasedItems = recordOrEmpty(extracted.purchased_items).items;
  if (!isMissingExtractedValue(purchasedItems) && !Array.isArray(purchasedItems)) {
    conflicts.push(createConflictDetail({
      region: 'purchased_items',
      field: 'module_structure',
      kind: containsInstructionEcho(purchasedItems)
        ? 'instruction_echo'
        : 'unsupported_value',
      locatedValues: [],
      extractedValues: conflictValues(purchasedItems),
      retainedValue: null,
    }));
  }
  return conflicts;
}

function regionControlConflicts(input: {
  value: unknown;
  layout: XianyuSemanticRegionLayout;
  region: RecognitionConflictDetail['region'];
  field: RecognitionConflictField;
  knownControls: string[];
}): RecognitionConflictDetail[] {
  if (isMissingExtractedValue(input.value)) return [];
  const controls = stringList(input.value);
  const unsupported = controls.filter((control) =>
    !semanticRegionContainsText(input.layout, input.region, control)
  );
  const malformed = !Array.isArray(input.value);
  if (!malformed && unsupported.length === 0) return [];
  const extractedValues = malformed
    ? conflictValues(input.value)
    : unsupported;
  const locatedValues = controlsFromSemanticLines(
    semanticRegionRows(input.layout, input.region),
    input.knownControls,
  );
  return [createConflictDetail({
    region: input.region,
    field: input.field,
    kind: containsInstructionEcho(input.value)
      ? 'instruction_echo'
      : 'unsupported_value',
    locatedValues,
    extractedValues,
    retainedValue: conflictValue(locatedValues.join('、')),
  })];
}

function amountSummaryConflicts(
  extracted: Record<string, unknown>,
  layout: XianyuSemanticRegionLayout,
): RecognitionConflictDetail[] {
  const source = recordOrEmpty(extracted.amount_summary);
  const expected = expectedSemanticAmounts(
    semanticRegionRows(layout, 'amount_summary'),
  );
  const fields: Array<[string, RecognitionConflictField, string | undefined]> = [
    ['product_total', 'product_total', expected.product_total],
    ['shipping_fee', 'shipping_fee', expected.shipping_fee],
    ['amount', 'amount', expected.amount],
  ];
  return fields.flatMap(([key, field, expectedValue]) => {
    const value = source[key];
    if (
      isMissingExtractedValue(value) ||
      supportedLabeledMoney(value, expectedValue) !== null
    ) {
      return [];
    }
    return [createConflictDetail({
      region: 'amount_summary',
      field,
      kind: looksLikeInstructionEcho(value)
        ? 'instruction_echo'
        : expectedValue === undefined
          ? 'unsupported_value'
          : 'value_mismatch',
      locatedValues: conflictValues(expectedValue),
      extractedValues: conflictValues(value),
      retainedValue: conflictValue(expectedValue),
    })];
  });
}

function orderDetailsConflicts(
  extracted: Record<string, unknown>,
  layout: XianyuSemanticRegionLayout,
  processedOrderNumberValue: string,
): RecognitionConflictDetail[] {
  const source = recordOrEmpty(extracted.order_details);
  const expected = expectedSemanticOrderDetails(
    semanticRegionRows(layout, 'order_details'),
  );
  const fields: Array<[string, RecognitionConflictField, string | undefined]> = [
    ['detail_state', 'detail_state', expected.detail_state],
    ['order_number', 'order_number', expected.order_number],
    [
      'alipay_transaction_number',
      'alipay_transaction_number',
      expected.alipay_transaction_number,
    ],
    ['buyer_nickname_label', 'buyer_nickname_label', expected.buyer_nickname_label],
    ['buyer_nickname', 'buyer_nickname', expected.buyer_nickname],
    ['order_time', 'order_time', expected.order_time],
    ['payment_time', 'payment_time', expected.payment_time],
  ];
  const processedOrderNumber = validatedOrderNumber(processedOrderNumberValue);
  return fields.flatMap(([key, field, expectedValue]) => {
    const value = source[key];
    if (
      isMissingExtractedValue(value) ||
      (key === 'detail_state'
        ? supportedDetailState(value, expected.detail_state)
        : supportedLabeledText(value, expectedValue)) !== null
    ) {
      return [];
    }
    const retainedValue = key === 'order_number' &&
        expectedValue === undefined &&
        processedOrderNumber &&
        processedOrderNumber === validatedOrderNumber(value)
      ? processedOrderNumber
      : expectedValue;
    return [createConflictDetail({
      region: 'order_details',
      field,
      kind: looksLikeInstructionEcho(value)
        ? 'instruction_echo'
        : expectedValue === undefined
          ? 'unsupported_value'
          : 'value_mismatch',
      locatedValues: conflictValues(expectedValue),
      extractedValues: conflictValues(value),
      retainedValue: conflictValue(retainedValue),
    })];
  });
}

function purchasedItemsConflicts(
  extracted: Record<string, unknown>,
  layout: XianyuSemanticRegionLayout,
): RecognitionConflictDetail[] {
  const module = recordOrEmpty(extracted.purchased_items);
  if (!Array.isArray(module.items)) return [];
  const sections = semanticItemSections(
    semanticRegionRows(layout, 'purchased_items'),
  );
  const conflicts: RecognitionConflictDetail[] = [];
  module.items.map(recordOrEmpty).forEach((item, itemIndex) => {
    if (isMissingExtractedValue(item.title)) return;
    const title = typeof item.title === 'string' ? comparableText(item.title) : '';
    const section = sections.find((candidate) =>
      title && comparableText(candidate.lines.join('')).includes(title)
    );
    if (!section) {
      const retainedTitle = sections[itemIndex]?.title;
      conflicts.push(createConflictDetail({
        region: 'purchased_items',
        field: 'item_title',
        kind: looksLikeInstructionEcho(item.title)
          ? 'instruction_echo'
          : 'outside_region',
        itemIndex,
        locatedValues: conflictValues(retainedTitle),
        extractedValues: conflictValues(item.title),
        retainedValue: conflictValue(retainedTitle),
      }));
      return;
    }
    if (
      !isMissingExtractedValue(item.spec) &&
      !semanticSectionContainsText(section, item.spec)
    ) {
      conflicts.push(createConflictDetail({
        region: 'purchased_items',
        field: 'item_spec',
        kind: looksLikeInstructionEcho(item.spec)
          ? 'instruction_echo'
          : section.specification === undefined
            ? 'unsupported_value'
            : 'value_mismatch',
        itemIndex,
        locatedValues: conflictValues(section.specification),
        extractedValues: conflictValues(item.spec),
        retainedValue: conflictValue(section.specification),
      }));
    }
    const extractedPrices = [item.unit_price, item.price_tag_text]
      .filter((value) => !isMissingExtractedValue(value));
    const unsupportedPrices = extractedPrices.filter((value) =>
      !semanticSectionSupportsMoney(section, value)
    );
    if (unsupportedPrices.length > 0) {
      conflicts.push(createConflictDetail({
        region: 'purchased_items',
        field: 'item_unit_price',
        kind: unsupportedPrices.some(looksLikeInstructionEcho)
          ? 'instruction_echo'
          : 'value_mismatch',
        itemIndex,
        locatedValues: [section.unitPrice],
        extractedValues: unsupportedPrices.flatMap(conflictValues),
        retainedValue: section.unitPrice,
      }));
    }
    const quantityValue = hasExplicitQuantity(item.quantity)
      ? item.quantity
      : item.quantity_text;
    if (!isMissingExtractedValue(quantityValue)) {
      const quantity = positiveQuantity(quantityValue);
      if (quantity.inferred || section.quantity?.value !== quantity.value) {
        conflicts.push(createConflictDetail({
          region: 'purchased_items',
          field: 'item_quantity',
          kind: looksLikeInstructionEcho(quantityValue)
            ? 'instruction_echo'
            : section.quantity === undefined
              ? 'unsupported_value'
              : 'value_mismatch',
          itemIndex,
          locatedValues: conflictValues(section.quantity?.raw),
          extractedValues: conflictValues(quantityValue),
          retainedValue: conflictValue(section.quantity?.raw),
        }));
      }
    }
  });
  return conflicts;
}

function createConflictDetail(
  input: RecognitionConflictDetail,
): RecognitionConflictDetail {
  return {
    ...input,
    locatedValues: boundedConflictValues(input.locatedValues),
    extractedValues: boundedConflictValues(input.extractedValues),
    retainedValue: input.retainedValue === null
      ? null
      : boundedConflictText(input.retainedValue),
  };
}

function boundedConflictValues(values: string[]): string[] {
  return [...new Set(values
    .filter(Boolean)
    .map(boundedConflictText))]
    .slice(0, RECOGNITION_CONFLICT_LIMITS.valuesPerSide);
}

function boundedConflictText(value: string): string {
  return value.slice(0, RECOGNITION_CONFLICT_LIMITS.textLength);
}

function conflictValues(value: unknown): string[] {
  const normalized = conflictValue(value);
  return normalized === null ? [] : [normalized];
}

function conflictValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized && !isNullMarker(normalized) ? normalized : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && value !== null) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized) return serialized;
    } catch {
      return '[无法序列化的异常值]';
    }
  }
  return null;
}

function containsInstructionEcho(value: unknown): boolean {
  if (looksLikeInstructionEcho(value)) return true;
  if (Array.isArray(value)) return value.some(containsInstructionEcho);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsInstructionEcho);
}

type SixRegionModules = {
  platformStatus: Record<string, unknown>;
  shipping: Record<string, unknown>;
  purchasedItems: Record<string, unknown>;
  amountSummary: Record<string, unknown>;
  orderDetails: Record<string, unknown>;
  fulfillment: Record<string, unknown>;
};

function recoverSixRegionModules(
  modules: SixRegionModules,
  layout: XianyuSemanticRegionLayout,
): SixRegionModules {
  const platformStatus = { ...modules.platformStatus };
  const statusLines = semanticRegionRows(layout, 'platform_status');
  const statusCandidates = semanticPlatformStatuses(statusLines);
  if (statusCandidates.length > 1) {
    platformStatus.top_status_text = null;
  } else if (isMissingExtractedValue(platformStatus.top_status_text)) {
    const candidate = statusLines.find((line) =>
      semanticPlatformStatuses([line]).length === 1
    );
    if (candidate) platformStatus.top_status_text = candidate;
  }

  const shipping = recoverSemanticShipping(
    modules.shipping,
    semanticRegionRows(layout, 'shipping_information'),
  );
  const purchasedItems = recoverSemanticItems(
    modules.purchasedItems,
    semanticRegionRows(layout, 'purchased_items'),
  );
  const amountSummary = { ...modules.amountSummary };
  const amountLines = semanticRegionRows(layout, 'amount_summary');
  fillMissingScalar(
    amountSummary,
    { product_total: semanticMoneyAfterLabel(amountLines, /商品总价/u) },
    'product_total',
  );
  fillMissingScalar(
    amountSummary,
    { shipping_fee: semanticMoneyAfterLabel(amountLines, /运费/u) },
    'shipping_fee',
  );
  fillMissingScalar(
    amountSummary,
    { amount: semanticMoneyAfterLabel(amountLines, /(?:成交价|实付金额)/u) },
    'amount',
  );

  const orderDetails = recoverSemanticOrderDetails(
    modules.orderDetails,
    semanticRegionRows(layout, 'order_details'),
  );
  const fulfillment = { ...modules.fulfillment };
  fulfillment.global_controls = mergeSemanticControls(
    fulfillment.global_controls,
    controlsFromSemanticLines(
      semanticRegionRows(layout, 'fulfillment_signals'),
      [
        '联系买家',
        '联系卖家',
        '联系对方',
        '取消订单',
        '去发货',
        '查看物流',
        '提醒收货',
      ],
    ),
  );
  return {
    platformStatus,
    shipping,
    purchasedItems,
    amountSummary,
    orderDetails,
    fulfillment,
  };
}

function recoverSemanticShipping(
  source: Record<string, unknown>,
  lines: string[],
): Record<string, unknown> {
  const shipping = { ...source };
  const phones = semanticPhones(lines);
  if (phones.length > 1) {
    shipping.recipient = null;
    shipping.recipient_phone_line_text = null;
    shipping.phone = null;
  }
  if (phones.length === 1) {
    const phone = phones[0];
    const contactLine = lines.find((line) =>
      chineseMobileCores(line).includes(phone)
    ) ?? '';
    const recipient = semanticRecipientBeforePhone(contactLine, phone);
    if (recipient && semanticRecipientNeedsRecovery(shipping.recipient)) {
      shipping.recipient = recipient;
    }
    if (isMissingExtractedValue(shipping.phone)) shipping.phone = phone;
    if (
      recipient &&
      (isMissingExtractedValue(shipping.recipient_phone_line_text) ||
        !contactLineConfirmsRecipient(
          shipping.recipient_phone_line_text,
          recipient,
          phone,
        ))
    ) {
      shipping.recipient_phone_line_text = `${recipient} ${phone}`;
    }

    if (isMissingExtractedValue(shipping.address)) {
      const contactIndex = lines.indexOf(contactLine);
      const address = lines
        .slice(Math.max(0, contactIndex + 1))
        .map((line) => stripSemanticControls(
          line,
          ['复制', '去发货'],
        ))
        .filter((line) =>
          line &&
          chineseMobileCores(line).length === 0 &&
          !isHighConfidenceUiControlText(line)
        )
        .join('')
        .trim();
      if (address.length >= 6) shipping.address = address;
    }
  }
  const normalizedAddress = typeof shipping.address === 'string'
    ? normalizeAddress(shipping.address)
    : '';
  if (normalizedAddress) {
    const addressParts = deriveAddressParts(normalizedAddress, {
      province: typeof shipping.province === 'string' ? shipping.province : '',
      city: typeof shipping.city === 'string' ? shipping.city : '',
      district: typeof shipping.district === 'string' ? shipping.district : '',
    });
    if (addressParts.province) shipping.province = addressParts.province;
    if (addressParts.city) shipping.city = addressParts.city;
    if (addressParts.district) shipping.district = addressParts.district;
  }
  shipping.controls = mergeSemanticControls(
    shipping.controls,
    controlsFromSemanticLines(lines, ['复制', '去发货']),
  );
  return shipping;
}

function semanticPhones(lines: string[]): string[] {
  return [...new Set(lines.flatMap(chineseMobileCores))];
}

function semanticPlatformStatuses(
  lines: string[],
): PlatformTransactionStatus[] {
  const statuses: PlatformTransactionStatus[] = [];
  for (const line of lines) {
    const normalized = line.normalize('NFKC').replace(/\s+/gu, '');
    if (/(?:退款成功|退款完成|已退款)/u.test(normalized)) {
      statuses.push('refunded');
    }
    if (/(?:交易已取消|订单已取消|交易已关闭|订单已关闭|交易关闭)/u.test(normalized)) {
      statuses.push('cancelled');
    }
    if (/(?:买家已付款|(?:卖家|商家)?已发货|等待买家(?:确认)?收货|交易成功)/u.test(normalized)) {
      statuses.push('paid');
    }
  }
  return [...new Set(statuses)];
}

function recoverSemanticItems(
  source: Record<string, unknown>,
  lines: string[],
): Record<string, unknown> {
  const purchasedItems = { ...source };
  const sections = semanticItemSections(lines);
  const items = Array.isArray(purchasedItems.items)
    ? purchasedItems.items.map(recordOrEmpty)
    : [];
  if (sections.length === 0) {
    purchasedItems.items = items;
    return purchasedItems;
  }
  purchasedItems.items = sections
    .filter((section) => section.titleAmbiguous || section.title.length >= 2)
    .map((section, index) => {
      const existing = items.find((item) => {
        const title = typeof item.title === 'string' ? comparableText(item.title) : '';
        return title && comparableText(section.lines.join('')).includes(title);
      }) ?? items[index] ?? {};
      const recovered: Record<string, unknown> = {
        ...existing,
        title: section.titleAmbiguous
          ? null
          : isMissingExtractedValue(existing.title)
            ? section.title
            : existing.title,
      };
      fillMissingScalar(
        recovered,
        { spec: section.specification },
        'spec',
      );
      fillMissingScalar(
        recovered,
        { unit_price: section.unitPrice },
        'unit_price',
      );
      fillMissingScalar(
        recovered,
        { quantity: section.quantity?.value },
        'quantity',
      );
      fillMissingScalar(
        recovered,
        { quantity_text: section.quantity?.raw },
        'quantity_text',
      );
      return recovered;
    });
  return purchasedItems;
}

function recoverSemanticOrderDetails(
  source: Record<string, unknown>,
  lines: string[],
): Record<string, unknown> {
  const details = { ...source };
  const expected = expectedSemanticOrderDetails(lines);
  fillMissingScalar(
    details,
    { order_number: semanticIdentifierAfterLabel(
      lines,
      /(?:订单编号|订单号)/u,
    ) },
    'order_number',
  );
  fillMissingScalar(
    details,
    { alipay_transaction_number: semanticIdentifierAfterLabel(
      lines,
      /支付宝交易号/u,
      { appendNumericContinuation: true },
    ) },
    'alipay_transaction_number',
  );
  const buyerNickname = semanticTextAfterLabel(lines, /买家昵称/u);
  if (buyerNickname) {
    fillMissingScalar(details, { buyer_nickname_label: '买家昵称' }, 'buyer_nickname_label');
    fillMissingScalar(details, { buyer_nickname: buyerNickname }, 'buyer_nickname');
  }
  fillMissingScalar(
    details,
    { order_time: semanticDateTimeAfterLabel(lines, /(?:下单时间|订单时间)/u) },
    'order_time',
  );
  fillMissingScalar(
    details,
    { payment_time: semanticDateTimeAfterLabel(lines, /(?:付款时间|支付时间)/u) },
    'payment_time',
  );
  if (
    isMissingExtractedValue(details.detail_state) ||
    details.detail_state === 'unknown'
  ) {
    details.detail_state = expected.detail_state;
  }
  details.controls = mergeSemanticControls(
    details.controls,
    controlsFromSemanticLines(lines, ['复制', '交易快照', '展开', '收起']),
  );
  return details;
}

function semanticRecipientBeforePhone(line: string, expectedPhone: string): string {
  const match = /(?:^|[^\d])((?:\+?86[\s\p{Pd}()（）]*)?1[3-9](?:[\s\p{Pd}()（）]*\d){9})(?!\d)/u.exec(
    line.normalize('NFKC'),
  );
  if (!match || chineseMobileCore(match[1]) !== expectedPhone) return '';
  const phoneStart = match.index + match[0].indexOf(match[1]);
  return line
    .slice(0, phoneStart)
    .replace(/^(?:收件人|联系人)\s*[:：]?\s*/u, '')
    .replace(/^[^\p{L}]+/u, '')
    .replace(/[\s,，:：|｜·\p{Pd}()（）]+$/gu, '')
    .trim();
}

function semanticRecipientNeedsRecovery(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return true;
  return chineseMobileCores(value).length > 0 || /(?:复制|去发货)/u.test(value);
}

function semanticLinesContainLabel(lines: string[], label: RegExp): boolean {
  return lines.some((line) => label.test(
    line.normalize('NFKC').replace(/\s+/gu, ''),
  ));
}

function semanticMoneyAfterLabel(
  lines: string[],
  label: RegExp,
): string | undefined {
  for (const line of lines) {
    const compactLine = line.normalize('NFKC').replace(/\s+/gu, '');
    const labelMatch = label.exec(compactLine);
    if (!labelMatch) continue;
    const remainder = compactLine.slice(labelMatch.index + labelMatch[0].length);
    const money = /[^\d]{0,40}[¥￥]?\s*(\d+(?:\.\d{1,2})?)/u.exec(remainder)?.[1];
    if (money !== undefined) return money;
  }
  return undefined;
}

function semanticPrice(line: string): { value: string; index: number } | undefined {
  const match = /[¥￥]\s*(\d+(?:\.\d{1,2})?)/u.exec(line.normalize('NFKC'));
  return match?.[1] ? { value: match[1], index: match.index } : undefined;
}

function semanticIdentifierAfterLabel(
  lines: string[],
  label: RegExp,
  options: { appendNumericContinuation?: boolean } = {},
): string | undefined {
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const compactLine = line.normalize('NFKC').replace(/\s+/gu, '');
    const labelMatch = label.exec(compactLine);
    if (!labelMatch) continue;
    const remainder = compactLine.slice(labelMatch.index + labelMatch[0].length);
    const identifier = /[⌃⌄∨^\s:：]*([A-Za-z0-9][A-Za-z0-9_-]{7,63})/u.exec(
      remainder,
    )?.[1];
    if (!identifier) continue;
    if (!options.appendNumericContinuation || !/^\d{8,63}$/u.test(identifier)) {
      return identifier;
    }
    let combined = identifier;
    for (const continuationLine of lines.slice(lineIndex + 1)) {
      const continuation = continuationLine.normalize('NFKC').replace(/\s+/gu, '');
      if (!/^\d{1,8}$/u.test(continuation)) break;
      if (combined.length + continuation.length > 64) break;
      combined += continuation;
    }
    return combined;
  }
  return undefined;
}

function semanticTextAfterLabel(
  lines: string[],
  label: RegExp,
): string | undefined {
  for (const line of lines) {
    const labelMatch = label.exec(line);
    if (!labelMatch) continue;
    const value = stripSemanticControls(
      line.slice(labelMatch.index + labelMatch[0].length),
      ['复制', '展开', '收起'],
    ).replace(/^[\s:：]+/u, '').trim();
    if (value) return value;
  }
  return undefined;
}

function semanticDateTimeAfterLabel(
  lines: string[],
  label: RegExp,
): string | undefined {
  for (const line of lines) {
    if (!label.test(line)) continue;
    const value = /\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/u.exec(line)?.[0];
    if (value) return value;
  }
  return undefined;
}

function controlsFromSemanticLines(
  lines: string[],
  allowed: string[],
): string[] {
  return allowed.filter((control) => lines.some((line) =>
    comparableText(line).includes(comparableText(control))
  ));
}

function mergeSemanticControls(current: unknown, recovered: string[]): string[] {
  return [...new Set([...stringList(current), ...recovered])];
}

function stripSemanticControls(value: string, controls: string[]): string {
  let result = value.normalize('NFKC').trim();
  for (const control of [...controls].sort((left, right) => right.length - left.length)) {
    result = result.replace(
      new RegExp(`[\\s,，:：|｜·\\p{Pd}()（）]*${escapeRegExp(control)}[>›»…\\s]*$`, 'u'),
      '',
    ).trim();
  }
  return result;
}

const ORDER_NUMBER_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u;

const XIANYU_UI_CONTROL_LABELS = new Set([
  '去发货',
  '发货',
  '取消订单',
  '联系买家',
  '联系卖家',
  '联系对方',
  '复制',
  '更多',
  '收起',
  '展开',
  '查看详情',
  '交易快照',
  '查看物流',
  '提醒发货',
  '修改地址',
  '确认收货',
  '申请退款',
  '去评价',
  '删除订单',
  '延长收货',
  '一键转卖',
  '立即购买',
  '我想要',
  '聊一聊',
]);

function validatedOrderNumber(value: unknown): string {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  return ORDER_NUMBER_VALUE_PATTERN.test(candidate) ? candidate : '';
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      const control = recordOrEmpty(entry);
      if (typeof control.text === 'string') return control.text.trim();
      return typeof control.label === 'string' ? control.label.trim() : '';
    })
    .filter(Boolean)
    .slice(0, 100);
}

function isMissingExtractedValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return normalized === '' || isNullMarker(normalized);
}

function fillMissingScalar(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  if (isMissingExtractedValue(target[key]) && !isMissingExtractedValue(source[key])) {
    target[key] = source[key];
  }
}

function comparableText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/gu, '').trim()
    : '';
}

function positiveQuantity(value: unknown): { value: number; inferred: boolean } {
  if (value === null || value === undefined || value === '') {
    return { value: 1, inferred: true };
  }
  const normalized = typeof value === 'number'
    ? String(value)
    : comparableText(value);
  const match = /^(?:(?:[x×]\s*)|(?:数量\s*[:：]?\s*)|(?:共\s*))?(\d+)(?:\s*(?:件|个))?$/iu.exec(
    normalized,
  );
  if (!match) return { value: 1, inferred: true };
  const quantity = Number(match[1]);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return { value: 1, inferred: true };
  }
  return { value: quantity, inferred: false };
}

function hasExplicitQuantity(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return !positiveQuantity(value).inferred;
}

function moneyToCents(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('金额格式无效');
  }
  const normalized = String(value)
    .normalize('NFKC')
    .replace(/[¥￥,\s]/gu, '');
  if (isNullMarker(normalized)) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(normalized);
  if (!match) throw new Error('金额格式无效');
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额超出安全范围');
  return Number(cents);
}

function isNullMarker(value: string): boolean {
  return ['null', 'none', 'n/a', '未显示', '未提供'].includes(
    value.trim().toLowerCase(),
  );
}

function chineseMobileCore(value: unknown): string {
  const digits = comparableText(value).replace(/\D/gu, '');
  const core = digits.length === 13 && digits.startsWith('86')
    ? digits.slice(2)
    : digits;
  return /^1[3-9]\d{9}$/u.test(core) ? core : '';
}

function chineseMobileCores(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const matches = value.normalize('NFKC').matchAll(
    /(?:^|[^\d])((?:\+?86[\s\p{Pd}()（）]*)?1[3-9](?:[\s\p{Pd}()（）]*\d){9})(?!\d)/gu,
  );
  return [...new Set(
    [...matches]
      .map((match) => chineseMobileCore(match[1]))
      .filter(Boolean),
  )];
}

function contactLineConfirmsRecipient(
  lineValue: unknown,
  recipientCandidate: string,
  phoneValue: unknown,
): boolean {
  const line = comparableText(lineValue).replace(/[\p{Pd}()（）]/gu, '');
  const candidate = comparableText(recipientCandidate);
  const phone = chineseMobileCore(phoneValue);
  const candidateIndex = line.indexOf(candidate);
  const phoneIndex = line.indexOf(phone);
  const phoneEnd = phoneIndex + phone.length;
  const between = candidateIndex >= 0 && phoneIndex >= 0
    ? line.slice(candidateIndex + candidate.length, phoneIndex)
      .replace(/^(?:\+?86)?/u, '')
      .replace(/[:：,，|·]/gu, '')
    : '';
  return Boolean(
    line &&
    (candidate.length >= 2 || /^\p{Script=Han}$/u.test(candidate)) &&
    phone.length === 11 &&
    candidateIndex >= 0 &&
    phoneIndex >= candidateIndex + candidate.length &&
    !/\d/u.test(line[phoneEnd] ?? '') &&
    between === '',
  );
}

function isHighConfidenceUiControlText(value: unknown): boolean {
  const normalized = comparableText(value).replace(/[>›»…]+$/gu, '');
  if (!normalized) return false;
  if (XIANYU_UI_CONTROL_LABELS.has(normalized)) return true;
  return /^(?:(?:去|立即|马上|开始|一键)(?:发货|付款|支付|评价|购买|转卖|配送)|(?:确认收货|申请退款|查看物流|提醒发货|修改地址))$/u.test(
    normalized,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$()|[\]{}\\]/gu, '\\$&');
}
