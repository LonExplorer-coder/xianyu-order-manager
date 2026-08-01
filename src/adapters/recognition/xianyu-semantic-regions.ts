export const XIANYU_SEMANTIC_REGION_IDS = [
  'platform_status',
  'shipping_information',
  'purchased_items',
  'amount_summary',
  'order_details',
  'fulfillment_signals',
] as const;

export type XianyuSemanticRegionId =
  (typeof XIANYU_SEMANTIC_REGION_IDS)[number];

type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type LocatedOcrWord = Bounds & {
  text: string;
};

type LocatedOcrLine = Bounds & {
  text: string;
  words: LocatedOcrWord[];
};

export type XianyuSemanticRegion = {
  startY: number;
  endY: number;
  words: LocatedOcrWord[];
};

export type XianyuSemanticRegionLayout = {
  regions: Record<XianyuSemanticRegionId, XianyuSemanticRegion>;
  excludedPromotion: {
    startY: number;
    endY: number;
    words: LocatedOcrWord[];
  };
};

const PLATFORM_STATUS_PATTERN =
  /(?:买家已付款|(?:卖家|商家)?已发货|等待买家(?:确认)?收货|交易成功|交易已取消|订单已取消|交易已关闭|订单已关闭|退款成功|退款完成|已退款)/u;
const AMOUNT_LABEL_PATTERN = /(?:成交价|实付金额|商品总价)/u;
const ORDER_NUMBER_LABEL_PATTERN = /(?:订单编号|订单号)/u;
const DETAIL_LABEL_PATTERN =
  /(?:订单编号|订单号|交易快照|支付宝交易号|买家昵称|下单时间|付款时间|订单时间|支付时间)/u;
const ALIPAY_TRANSACTION_LABEL_PATTERN = /支付宝交易号/u;
const DETAIL_NUMERIC_CONTINUATION_PATTERN = /^\d{1,8}$/u;
const ITEM_CUE_PATTERN = /(?:[¥￥]\s*\d|款式|规格|[x×]\s*\d|数量\s*[:：]?\s*\d|共\s*\d+\s*件)/iu;
const FULFILLMENT_CONTROL_PATTERN =
  /(?:联系买家|联系卖家|联系对方|取消订单|去发货|查看物流|提醒收货)/u;

export function planXianyuSemanticRegions(
  wordsInfo: unknown,
): XianyuSemanticRegionLayout | undefined {
  const words = parseLocatedWords(wordsInfo);
  if (words.length === 0) return undefined;
  const lines = locatedOcrLines(words);

  const status = firstMatchingLine(lines, PLATFORM_STATUS_PATTERN);
  if (!status) return undefined;
  const shippingContact = lines.find((line) =>
    line.top > status.top && mobilePhones(line.text).length > 0
  );
  if (!shippingContact) return undefined;

  const amountStart = lines.find((line) =>
    line.top > shippingContact.top && matchesNormalizedLine(line, AMOUNT_LABEL_PATTERN)
  );
  if (!amountStart) return undefined;
  const detailsStart = lines.find((line) =>
    line.top > amountStart.top && matchesNormalizedLine(line, ORDER_NUMBER_LABEL_PATTERN)
  );
  if (!detailsStart) return undefined;

  const itemCue = lines.find((line) =>
    line.top > shippingContact.bottom &&
    line.top < amountStart.top &&
    matchesNormalizedLine(line, ITEM_CUE_PATTERN)
  );
  if (!itemCue) return undefined;

  const medianHeight = median(lines.map((line) => line.bottom - line.top)) || 1;
  const itemStart = precedingItemRowStart(
    lines,
    shippingContact,
    itemCue,
    medianHeight,
  );
  const detailLines = lines.filter((line) =>
    line.top >= detailsStart.top && matchesNormalizedLine(line, DETAIL_LABEL_PATTERN)
  );
  let lastDetailAnchor = detailsStart;
  for (const candidate of detailLines) {
    if (candidate === detailsStart) continue;
    const precedingContentEnd = detailIdentifierContinuationEnd(
      lines,
      lastDetailAnchor,
      candidate,
      medianHeight,
    );
    if (candidate.top - precedingContentEnd > medianHeight * 2.5) break;
    lastDetailAnchor = candidate;
  }
  const detailContentEnd = Math.min(
    Math.max(lastDetailAnchor.bottom, lastDetailAnchor.bottom + medianHeight * 0.8),
    words.at(-1)?.bottom ?? lastDetailAnchor.bottom,
  );
  const fulfillmentControls = lines.filter((line) =>
    line.top > detailContentEnd &&
    FULFILLMENT_CONTROL_PATTERN.test(normalizedLine(line.text))
  );
  if (fulfillmentControls.length === 0) return undefined;
  const fulfillmentStart = Math.min(...fulfillmentControls.map((word) => word.top));
  if (fulfillmentStart <= detailContentEnd) return undefined;

  const statusShippingBoundary = midpoint(status.bottom, shippingContact.top);
  const shippingItemsBoundary = midpoint(
    Math.max(
      shippingContact.bottom,
        ...lines
        .filter((line) => line.top >= shippingContact.top && line.top < itemStart)
        .map((line) => line.bottom),
    ),
    itemStart,
  );
  const itemsAmountBoundary = midpoint(
    Math.max(
      itemStart,
        ...lines
        .filter((line) => line.top >= itemStart && line.top < amountStart.top)
        .map((line) => line.bottom),
    ),
    amountStart.top,
  );
  const amountDetailsBoundary = midpoint(
    Math.max(
      amountStart.bottom,
        ...lines
        .filter((line) => line.top >= amountStart.top && line.top < detailsStart.top)
        .map((line) => line.bottom),
    ),
    detailsStart.top,
  );
  const firstTop = Math.min(...words.map((word) => word.top));
  const lastBottom = Math.max(...words.map((word) => word.bottom));

  const ranges: Record<XianyuSemanticRegionId, [number, number]> = {
    platform_status: [firstTop, statusShippingBoundary],
    shipping_information: [statusShippingBoundary, shippingItemsBoundary],
    purchased_items: [shippingItemsBoundary, itemsAmountBoundary],
    amount_summary: [itemsAmountBoundary, amountDetailsBoundary],
    order_details: [amountDetailsBoundary, detailContentEnd],
    fulfillment_signals: [fulfillmentStart, lastBottom],
  };
  const regions = Object.fromEntries(
    XIANYU_SEMANTIC_REGION_IDS.map((id) => {
      const [startY, endY] = ranges[id];
      return [id, {
        startY,
        endY,
        words: wordsInRange(words, startY, endY),
      } satisfies XianyuSemanticRegion];
    }),
  ) as Record<XianyuSemanticRegionId, XianyuSemanticRegion>;

  return {
    regions,
    excludedPromotion: {
      startY: detailContentEnd,
      endY: fulfillmentStart,
      words: wordsInRange(words, detailContentEnd, fulfillmentStart),
    },
  };
}

export function semanticRegionContainsText(
  layout: XianyuSemanticRegionLayout,
  regionId: XianyuSemanticRegionId,
  value: unknown,
): boolean {
  if (typeof value !== 'string') return false;
  const candidate = comparableText(value);
  if (candidate.length < 2) return false;
  const words = layout.regions[regionId].words;
  const combined = comparableText(words.map((word) => word.text).join(''));
  if (combined.includes(candidate)) return true;
  return words.some((word) => {
    const text = comparableText(word.text);
    return text.includes(candidate);
  });
}

export function semanticRegionRows(
  layout: XianyuSemanticRegionLayout,
  regionId: XianyuSemanticRegionId,
): string[] {
  return locatedOcrLines(layout.regions[regionId].words)
    .map((line) => line.text);
}

function locatedOcrLines(words: readonly LocatedOcrWord[]): LocatedOcrLine[] {
  const rows: Array<Bounds & { words: LocatedOcrWord[] }> = [];
  for (const word of words) {
    const centerY = (word.top + word.bottom) / 2;
    const row = rows.find((candidate) => {
      const candidateCenter = (candidate.top + candidate.bottom) / 2;
      const tolerance = Math.max(
        word.bottom - word.top,
        candidate.bottom - candidate.top,
      ) * 0.6;
      return Math.abs(centerY - candidateCenter) <= tolerance;
    });
    if (row) {
      row.left = Math.min(row.left, word.left);
      row.top = Math.min(row.top, word.top);
      row.right = Math.max(row.right, word.right);
      row.bottom = Math.max(row.bottom, word.bottom);
      row.words.push(word);
    } else {
      rows.push({
        left: word.left,
        top: word.top,
        right: word.right,
        bottom: word.bottom,
        words: [word],
      });
    }
  }
  return rows
    .sort((left, right) => left.top - right.top)
    .map((row) => ({
      ...row,
      words: [...row.words].sort((left, right) => left.left - right.left),
      text: [...row.words]
        .sort((left, right) => left.left - right.left)
        .map((word) => word.text)
        .join(' '),
    }));
}

export function semanticExcludedLines(
  layout: XianyuSemanticRegionLayout,
): string[] {
  return layout.excludedPromotion.words.map((word) => word.text);
}

function parseLocatedWords(value: unknown): LocatedOcrWord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseLocatedWord)
    .filter((word): word is LocatedOcrWord => word !== undefined)
    .sort((left, right) => left.top - right.top || left.left - right.left);
}

function parseLocatedWord(value: unknown): LocatedOcrWord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string' || !record.text.trim()) return undefined;
  const location = numericArray(record.location);
  let bounds: Bounds | undefined;
  if (location.length >= 8) {
    const xValues = location.filter((_, index) => index % 2 === 0);
    const yValues = location.filter((_, index) => index % 2 === 1);
    bounds = {
      left: Math.min(...xValues),
      top: Math.min(...yValues),
      right: Math.max(...xValues),
      bottom: Math.max(...yValues),
    };
  } else {
    const rotateRect = numericArray(record.rotate_rect);
    if (rotateRect.length >= 4) {
      const [centerX, centerY, width, height] = rotateRect;
      bounds = {
        left: centerX - width / 2,
        top: centerY - height / 2,
        right: centerX + width / 2,
        bottom: centerY + height / 2,
      };
    }
  }
  if (!bounds || bounds.bottom <= bounds.top || bounds.right <= bounds.left) {
    return undefined;
  }
  return { text: record.text.trim(), ...bounds };
}

function numericArray(value: unknown): number[] {
  return Array.isArray(value) && value.every((entry) =>
    typeof entry === 'number' && Number.isFinite(entry)
  )
    ? value
    : [];
}

function firstMatchingLine(
  lines: readonly LocatedOcrLine[],
  pattern: RegExp,
): LocatedOcrLine | undefined {
  return lines.find((line) => matchesNormalizedLine(line, pattern));
}

function matchesNormalizedLine(
  line: LocatedOcrLine,
  pattern: RegExp,
): boolean {
  return pattern.test(normalizedLine(line.text));
}

function precedingItemRowStart(
  lines: readonly LocatedOcrLine[],
  shippingContact: LocatedOcrLine,
  cue: LocatedOcrLine,
  medianHeight: number,
): number {
  const previous = lines
    .filter((line) => line.top > shippingContact.bottom && line.bottom <= cue.top)
    .at(-1);
  if (!previous || cue.top - previous.bottom > medianHeight * 1.8) return cue.top;
  return previous.top;
}

function detailIdentifierContinuationEnd(
  lines: readonly LocatedOcrLine[],
  anchor: LocatedOcrLine,
  nextAnchor: LocatedOcrLine,
  medianHeight: number,
): number {
  const identifierBounds = alipayNumericIdentifierBounds(anchor);
  if (!identifierBounds) return anchor.bottom;
  let contentEnd = anchor.bottom;
  for (const line of lines) {
    if (line.top <= anchor.bottom) continue;
    if (line.top >= nextAnchor.top) break;
    if (line.top - contentEnd > medianHeight * 1.5) break;
    if (!DETAIL_NUMERIC_CONTINUATION_PATTERN.test(normalizedLine(line.text))) {
      break;
    }
    if (
      line.right < identifierBounds.left ||
      Math.abs(line.right - identifierBounds.right) > medianHeight * 2
    ) {
      break;
    }
    contentEnd = Math.max(contentEnd, line.bottom);
  }
  return contentEnd;
}

function alipayNumericIdentifierBounds(
  line: LocatedOcrLine,
): Bounds | undefined {
  const normalized = normalizedLine(line.text);
  const labelMatch = ALIPAY_TRANSACTION_LABEL_PATTERN.exec(normalized);
  if (!labelMatch) return undefined;
  const remainder = normalized.slice(labelMatch.index + labelMatch[0].length);
  const identifier = /^[⌃⌄∨^:：]*(\d{8,63})(?:复制)?$/u.exec(remainder)?.[1];
  if (!identifier) return undefined;

  const identifierWords = line.words.filter((word) => {
    const candidate = normalizedLine(word.text);
    return /^\d+$/u.test(candidate) && identifier.includes(candidate);
  });
  if (identifierWords.length === 0) return line;
  return {
    left: Math.min(...identifierWords.map((word) => word.left)),
    top: Math.min(...identifierWords.map((word) => word.top)),
    right: Math.max(...identifierWords.map((word) => word.right)),
    bottom: Math.max(...identifierWords.map((word) => word.bottom)),
  };
}

function wordsInRange(
  words: readonly LocatedOcrWord[],
  startY: number,
  endY: number,
): LocatedOcrWord[] {
  return words.filter((word) => {
    const centerY = (word.top + word.bottom) / 2;
    return centerY >= startY && centerY <= endY;
  });
}

function mobilePhones(value: string): string[] {
  return [...new Set(
    [...value.normalize('NFKC').matchAll(
      /(?:^|[^\d])((?:\+?86[\s\p{Pd}()（）]*)?1[3-9](?:[\s\p{Pd}()（）]*\d){9})(?!\d)/gu,
    )]
      .map((match) => match[1].replace(/\D/gu, '').replace(/^86(?=1)/u, ''))
      .filter((phone) => /^1[3-9]\d{9}$/u.test(phone)),
  )];
}

function normalizedLine(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function comparableText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

function midpoint(left: number, right: number): number {
  return left + Math.max(0, right - left) / 2;
}


function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
