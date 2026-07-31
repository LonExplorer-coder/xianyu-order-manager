import {
  CANDIDATE_VERIFICATION_LIMITS,
  isCandidateVerificationBatchValid,
  isCandidateVerificationSetValid,
  type CandidateDecision,
  type CandidateContextLine,
  type CandidateSet,
} from '../../core/candidate-verification';
import type { PlatformTransactionStatus } from '../../core/contracts';
import type {
  LocatedOcrWord,
  XianyuSemanticRegionId,
  XianyuSemanticRegionLayout,
} from './xianyu-semantic-regions';

type CandidatePatchOperation = {
  path: readonly (string | number)[];
  value: unknown;
};

export type XianyuLocalCandidatePatch = {
  ambiguityId: string;
  operations: readonly CandidatePatchOperation[];
};

export type XianyuCandidateAdjudicationPlan = {
  candidateSets: CandidateSet[];
  rejectedCandidateSets: CandidateSet[];
  candidatePatches: ReadonlyMap<string, XianyuLocalCandidatePatch>;
};

const SHIPPING_CONTACT_AMBIGUITY_ID =
  'xianyu:shipping_information:contact';
const PLATFORM_STATUS_AMBIGUITY_ID =
  'xianyu:platform_status:transaction_status';

export function planXianyuCandidateAdjudication(input: {
  extracted: Record<string, unknown>;
  layout: XianyuSemanticRegionLayout;
}): XianyuCandidateAdjudicationPlan {
  const candidateSets: CandidateSet[] = [];
  const rejectedCandidateSets: CandidateSet[] = [];
  const candidatePatches = new Map<string, XianyuLocalCandidatePatch>();
  let overflowCandidateCount = 0;
  const appendWithinLimits = (candidatePlan: {
    candidateSet: CandidateSet;
    patches: ReadonlyMap<string, XianyuLocalCandidatePatch>;
  } | undefined) => {
    if (!candidatePlan) return;
    if (
      candidateSets.length + rejectedCandidateSets.length >=
      CANDIDATE_VERIFICATION_LIMITS.auditAmbiguitiesPerScreenshot - 1
    ) {
      overflowCandidateCount += 1;
      return;
    }
    const boundedAuditSet = boundedCandidateSetForAudit(candidatePlan.candidateSet);
    if (!boundedAuditSet) return;
    if (!isCandidateVerificationBatchValid([candidatePlan.candidateSet])) {
      rejectedCandidateSets.push(boundedAuditSet);
      return;
    }
    const nextBatch = [...candidateSets, candidatePlan.candidateSet];
    if (!isCandidateVerificationBatchValid(nextBatch)) {
      rejectedCandidateSets.push(boundedAuditSet);
      return;
    }
    candidateSets.push(candidatePlan.candidateSet);
    for (const [candidateId, patch] of candidatePlan.patches) {
      candidatePatches.set(candidateId, patch);
    }
  };
  appendWithinLimits(platformStatusCandidateSet(input.layout, input.extracted));
  appendWithinLimits(shippingContactCandidateSet(input.layout));
  for (const itemTitle of itemTitleCandidateSets(input.layout)) {
    appendWithinLimits(itemTitle);
  }
  if (overflowCandidateCount > 0) {
    rejectedCandidateSets.push(candidateOverflowAuditSet(overflowCandidateCount));
  }
  return { candidateSets, rejectedCandidateSets, candidatePatches };
}

function boundedCandidateSetForAudit(
  candidateSet: CandidateSet,
): CandidateSet | undefined {
  const sourceCandidates = candidateSet.candidates.slice(
    0,
    CANDIDATE_VERIFICATION_LIMITS.candidatesPerAmbiguity,
  );
  const linesById = new Map(candidateSet.contextLines.map((line) => [line.lineId, line]));
  const selectedLineIds = new Set<string>();
  for (const candidate of sourceCandidates) {
    const firstAvailableReference = candidate.evidenceRefs.find((reference) => (
      linesById.has(reference.lineId)
    ));
    if (firstAvailableReference) selectedLineIds.add(firstAvailableReference.lineId);
  }
  for (const candidate of sourceCandidates) {
    for (const reference of candidate.evidenceRefs) {
      if (
        linesById.has(reference.lineId) &&
        selectedLineIds.size < CANDIDATE_VERIFICATION_LIMITS.contextLinesPerAmbiguity
      ) selectedLineIds.add(reference.lineId);
    }
  }
  for (const line of candidateSet.contextLines) {
    if (selectedLineIds.size >= CANDIDATE_VERIFICATION_LIMITS.contextLinesPerAmbiguity) {
      break;
    }
    selectedLineIds.add(line.lineId);
  }
  const contextLines = [...selectedLineIds].flatMap((lineId) => {
    const line = linesById.get(lineId);
    if (!line) return [];
    const text = line.text.slice(
      0,
      CANDIDATE_VERIFICATION_LIMITS.contextLineTextLength,
    );
    if (!text.trim()) return [];
    const left = safeNonNegativeCoordinate(line.left);
    const top = safeNonNegativeCoordinate(line.top);
    const right = Math.max(left, safeNonNegativeCoordinate(line.right));
    const bottom = Math.max(top, safeNonNegativeCoordinate(line.bottom));
    return [{ lineId, text, left, top, right, bottom }];
  });
  const boundedLines = new Map(contextLines.map((line) => [line.lineId, line]));
  const candidates = sourceCandidates.flatMap((candidate) => {
    const displayText = candidate.displayText.slice(
      0,
      CANDIDATE_VERIFICATION_LIMITS.candidateDisplayTextLength,
    );
    if (!displayText.trim()) return [];
    const evidenceRefs = candidate.evidenceRefs
      .flatMap((reference) => {
        const line = boundedLines.get(reference.lineId);
        if (!line) return [];
        if (
          reference.startOffset === undefined ||
          reference.endOffset === undefined
        ) return [{ lineId: reference.lineId }];
        const startOffset = Math.min(
          Math.max(0, reference.startOffset),
          line.text.length,
        );
        const endOffset = Math.min(
          Math.max(startOffset, reference.endOffset),
          line.text.length,
        );
        return [{ lineId: reference.lineId, startOffset, endOffset }];
      })
      .slice(0, CANDIDATE_VERIFICATION_LIMITS.evidenceRefsPerCandidate);
    if (evidenceRefs.length === 0) return [];
    return [{
      candidateId: candidate.candidateId,
      displayText,
      evidenceRefs,
    }];
  });
  const bounded: CandidateSet = {
    ambiguityId: candidateSet.ambiguityId,
    region: candidateSet.region,
    field: candidateSet.field,
    ...(candidateSet.itemIndex === undefined ? {} : { itemIndex: candidateSet.itemIndex }),
    contextLines,
    candidates,
  };
  return isCandidateVerificationSetValid(bounded) ? bounded : undefined;
}

function candidateOverflowAuditSet(count: number): CandidateSet {
  const lineId = 'xianyu:candidate_audit:overflow:line';
  const summary = `另有 ${count} 项歧义超出逐项审计上限，未发送远程模型`;
  return {
    ambiguityId: 'xianyu:candidate_audit:overflow',
    region: 'order_details',
    field: 'candidate_overflow',
    contextLines: [{
      lineId,
      text: summary,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    }],
    candidates: [{
      candidateId: 'xianyu:candidate_audit:overflow:keep-local',
      displayText: '保留本机规则结果',
      evidenceRefs: [{ lineId }],
    }, {
      candidateId: 'xianyu:candidate_audit:overflow:manual-review',
      displayText: `${count} 项歧义需人工确认`,
      evidenceRefs: [{ lineId }],
    }],
  };
}

function safeNonNegativeCoordinate(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

const PLATFORM_STATUS_DEFINITIONS: ReadonlyArray<{
  status: PlatformTransactionStatus;
  displayText: string;
  canonicalText: string;
  pattern: RegExp;
}> = [
  {
    status: 'refunded',
    displayText: '已退款',
    canonicalText: '退款成功',
    pattern: /(?:退款成功|退款完成|已退款)/u,
  },
  {
    status: 'cancelled',
    displayText: '已取消',
    canonicalText: '交易已取消',
    pattern: /(?:交易已取消|订单已取消|交易已关闭|订单已关闭|交易关闭)/u,
  },
  {
    status: 'paid',
    displayText: '已付款',
    canonicalText: '买家已付款',
    pattern: /(?:买家已付款|(?:卖家|商家)?已发货|等待买家(?:确认)?收货|交易成功)/u,
  },
];

function platformStatusCandidateSet(
  layout: XianyuSemanticRegionLayout,
  extracted: Record<string, unknown>,
): {
  candidateSet: CandidateSet;
  patches: ReadonlyMap<string, XianyuLocalCandidatePatch>;
} | undefined {
  const contextLines = locatedRegionLines(layout, 'platform_status');
  const occurrences = contextLines.flatMap((line) =>
    PLATFORM_STATUS_DEFINITIONS.flatMap((definition) => {
      const match = definition.pattern.exec(
        line.text.normalize('NFKC').replace(/\s+/gu, ''),
      );
      return match
        ? [{ definition, line, start: match.index, end: match.index + match[0].length }]
        : [];
    }).sort((left, right) => left.start - right.start)
  );
  const byStatus = new Map<PlatformTransactionStatus, typeof occurrences[number]>();
  for (const occurrence of occurrences) {
    if (!byStatus.has(occurrence.definition.status)) {
      byStatus.set(occurrence.definition.status, occurrence);
    }
  }
  if (byStatus.size < 2) return undefined;

  const patches = new Map<string, XianyuLocalCandidatePatch>();
  const usesRecoveredModule = Object.prototype.hasOwnProperty.call(
    extracted,
    'page_header_status_text',
  ) || Object.prototype.hasOwnProperty.call(extracted, 'page_context');
  const candidates = [...byStatus.values()].map((occurrence) => {
    const { definition, line, start, end } = occurrence;
    const candidateId = `${PLATFORM_STATUS_AMBIGUITY_ID}:${definition.status}`;
    patches.set(candidateId, {
      ambiguityId: PLATFORM_STATUS_AMBIGUITY_ID,
      operations: usesRecoveredModule
        ? [
            {
              path: ['page_header_status_text'],
              value: definition.canonicalText,
            },
            {
              path: ['page_context', 'top_status_text'],
              value: definition.canonicalText,
            },
          ]
        : [{
            path: ['platform_status', 'top_status_text'],
            value: definition.canonicalText,
          }],
    });
    return {
      candidateId,
      displayText: definition.displayText,
      evidenceRefs: [{ lineId: line.lineId, startOffset: start, endOffset: end }],
    };
  });
  return {
    candidateSet: {
      ambiguityId: PLATFORM_STATUS_AMBIGUITY_ID,
      region: 'platform_status',
      field: 'platform_status',
      contextLines,
      candidates,
    },
    patches,
  };
}

export function applyXianyuCandidateDecisions(
  extracted: Record<string, unknown>,
  plan: XianyuCandidateAdjudicationPlan,
  decisions: readonly CandidateDecision[],
): Record<string, unknown> {
  const result = structuredClone(extracted);
  const decisionsByAmbiguity = new Map<string, CandidateDecision[]>();
  for (const decision of decisions) {
    const current = decisionsByAmbiguity.get(decision.ambiguityId) ?? [];
    current.push(decision);
    decisionsByAmbiguity.set(decision.ambiguityId, current);
  }
  const knownAmbiguities = new Set(
    plan.candidateSets.map((candidateSet) => candidateSet.ambiguityId),
  );
  for (const [ambiguityId, matchingDecisions] of decisionsByAmbiguity) {
    if (!knownAmbiguities.has(ambiguityId) || matchingDecisions.length !== 1) {
      continue;
    }
    const [decision] = matchingDecisions;
    if (!decision || decision.resolution !== 'selected') continue;
    const candidateSet = plan.candidateSets.find(
      (candidate) => candidate.ambiguityId === ambiguityId,
    );
    if (!candidateSet?.candidates.some(
      (candidate) => candidate.candidateId === decision.candidateId,
    )) {
      continue;
    }
    const patch = plan.candidatePatches.get(decision.candidateId);
    if (!patch || patch.ambiguityId !== ambiguityId) continue;
    for (const operation of patch.operations) {
      setPath(result, operation.path, operation.value);
    }
  }
  return result;
}

function shippingContactCandidateSet(
  layout: XianyuSemanticRegionLayout,
): {
  candidateSet: CandidateSet;
  patches: ReadonlyMap<string, XianyuLocalCandidatePatch>;
} | undefined {
  const contextLines = locatedRegionLines(layout, 'shipping_information');
  const uniquePhones = [...new Set(contextLines.flatMap((line) =>
    chineseMobileMatches(line.text).map((match) => match.phone)
  ))];
  if (uniquePhones.length < 2) return undefined;

  const bindings = uniquePhones.flatMap((phone) => {
    const matchingLines = contextLines.filter((line) =>
      chineseMobileMatches(line.text).some((match) => match.phone === phone)
    );
    if (matchingLines.length !== 1) return [];
    const [line] = matchingLines;
    if (!line) return [];
    const matches = chineseMobileMatches(line.text);
    if (matches.length !== 1) return [];
    const recipient = recipientBeforePhone(line.text, matches[0]);
    if (!isPlausibleRecipient(recipient)) return [];
    return [{ line, phone, recipient }];
  });
  if (bindings.length !== uniquePhones.length) return undefined;

  const patches = new Map<string, XianyuLocalCandidatePatch>();
  const candidates = bindings.map((binding, index) => {
    const candidateId = `${SHIPPING_CONTACT_AMBIGUITY_ID}:candidate:${index + 1}`;
    patches.set(candidateId, {
      ambiguityId: SHIPPING_CONTACT_AMBIGUITY_ID,
      operations: [
        {
          path: ['shipping_information', 'recipient'],
          value: binding.recipient,
        },
        {
          path: ['shipping_information', 'recipient_phone_line_text'],
          value: `${binding.recipient} ${binding.phone}`,
        },
        {
          path: ['shipping_information', 'phone'],
          value: binding.phone,
        },
      ],
    });
    return {
      candidateId,
      displayText: `${binding.recipient} ${binding.phone}`,
      evidenceRefs: [{ lineId: binding.line.lineId }],
    };
  });
  return {
    candidateSet: {
      ambiguityId: SHIPPING_CONTACT_AMBIGUITY_ID,
      region: 'shipping_information',
      field: 'shipping_contact',
      contextLines,
      candidates,
    },
    patches,
  };
}

function itemTitleCandidateSets(
  layout: XianyuSemanticRegionLayout,
): Array<{
  candidateSet: CandidateSet;
  patches: ReadonlyMap<string, XianyuLocalCandidatePatch>;
}> {
  const lines = locatedRegionLines(layout, 'purchased_items');
  const results: Array<{
    candidateSet: CandidateSet;
    patches: ReadonlyMap<string, XianyuLocalCandidatePatch>;
  }> = [];
  let pendingTitleLines: CandidateContextLine[] = [];
  let itemIndex = 0;
  for (const line of lines) {
    const price = itemPrice(line.text);
    if (!price) {
      if (isKnownItemMetadataLine(line.text)) {
        pendingTitleLines = [];
      } else {
        pendingTitleLines.push(line);
      }
      continue;
    }
    const titleOnPriceLine = line.text.slice(0, price.index).trim();
    if (pendingTitleLines.some((pending) => isUnknownLabeledItemLine(pending.text))) {
      const fullTitle = [...pendingTitleLines.map((pending) => pending.text), titleOnPriceLine]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('');
      const tailTitle = titleOnPriceLine;
      if (
        fullTitle.length >= 2 &&
        tailTitle.length >= 2 &&
        comparableText(fullTitle) !== comparableText(tailTitle)
      ) {
        results.push(itemTitleCandidateSet({
          itemIndex,
          contextLines: [...pendingTitleLines, line],
          fullTitle,
          tailTitle,
          priceLine: line,
        }));
      }
    }
    pendingTitleLines = [];
    itemIndex += 1;
  }
  return results;
}

function itemTitleCandidateSet(input: {
  itemIndex: number;
  contextLines: CandidateContextLine[];
  fullTitle: string;
  tailTitle: string;
  priceLine: CandidateContextLine;
}): {
  candidateSet: CandidateSet;
  patches: ReadonlyMap<string, XianyuLocalCandidatePatch>;
} {
  const ambiguityId = `xianyu:purchased_items:item_title:${input.itemIndex}`;
  const fullCandidateId = `${ambiguityId}:include-labeled-line`;
  const tailCandidateId = `${ambiguityId}:price-line-only`;
  const patches = new Map<string, XianyuLocalCandidatePatch>();
  for (const [candidateId, title] of [
    [fullCandidateId, input.fullTitle],
    [tailCandidateId, input.tailTitle],
  ] as const) {
    patches.set(candidateId, {
      ambiguityId,
      operations: [{
        path: ['purchased_items', 'items', input.itemIndex, 'title'],
        value: title,
      }],
    });
  }
  return {
    candidateSet: {
      ambiguityId,
      region: 'purchased_items',
      field: 'item_title',
      itemIndex: input.itemIndex,
      contextLines: input.contextLines,
      candidates: [
        {
          candidateId: fullCandidateId,
          displayText: input.fullTitle,
          evidenceRefs: input.contextLines.map((line) => ({ lineId: line.lineId })),
        },
        {
          candidateId: tailCandidateId,
          displayText: input.tailTitle,
          evidenceRefs: [{ lineId: input.priceLine.lineId }],
        },
      ],
    },
    patches,
  };
}

function itemPrice(value: string): { index: number } | undefined {
  const match = /[¥￥]\s*\d+(?:\.\d{1,2})?/u.exec(value.normalize('NFKC'));
  return match ? { index: match.index } : undefined;
}

function isKnownItemMetadataLine(value: string): boolean {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, '');
  return /^(?:款式|规格|颜色|色号|尺码|尺寸|型号|款号|套餐|版本|容量|口味|材质|样式|类型)[:：]?/iu.test(
    normalized,
  ) || /(?:[x×]\d+|数量[:：]?\d+|共\d+件)/iu.test(normalized);
}

function isUnknownLabeledItemLine(value: string): boolean {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, '');
  return /^[\p{L}\p{N}]{1,12}[:：].+/u.test(normalized) &&
    !isKnownItemMetadataLine(value);
}

function comparableText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

type MobileMatch = {
  phone: string;
  start: number;
};

function chineseMobileMatches(value: string): MobileMatch[] {
  const matches = value.normalize('NFKC').matchAll(
    /(?:^|[^\d])((?:\+?86[\s\p{Pd}()（）]*)?1[3-9](?:[\s\p{Pd}()（）]*\d){9})(?!\d)/gu,
  );
  return [...matches].flatMap((match) => {
    const raw = match[1];
    if (!raw) return [];
    const digits = raw.replace(/\D/gu, '');
    const phone = digits.length === 13 && digits.startsWith('86')
      ? digits.slice(2)
      : digits;
    if (!/^1[3-9]\d{9}$/u.test(phone)) return [];
    return [{
      phone,
      start: (match.index ?? 0) + match[0].indexOf(raw),
    }];
  });
}

function recipientBeforePhone(line: string, phone: MobileMatch): string {
  return line
    .slice(0, phone.start)
    .replace(/^(?:收件人|联系人)\s*[:：]?\s*/u, '')
    .replace(/^[^\p{L}]+/u, '')
    .replace(/[\s,，:：|｜·\p{Pd}()（）]+$/gu, '')
    .trim();
}

function isPlausibleRecipient(value: string): boolean {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, '').trim();
  if (!normalized || normalized.length > 32 || /\d/u.test(normalized)) {
    return false;
  }
  if (!/[\p{L}]/u.test(normalized)) return false;
  return !/^(?:复制|去发货|发货|联系买家|联系卖家|联系对方|取消订单|查看物流|提醒收货|修改地址|收货地址)$/u.test(
    normalized,
  );
}

function locatedRegionLines(
  layout: XianyuSemanticRegionLayout,
  region: XianyuSemanticRegionId,
): CandidateContextLine[] {
  const rows: Array<{
    left: number;
    top: number;
    right: number;
    bottom: number;
    words: LocatedOcrWord[];
  }> = [];
  for (const word of layout.regions[region].words) {
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
    .sort((left, right) => left.top - right.top || left.left - right.left)
    .map((row, index) => ({
      lineId: `${region}:line:${index + 1}`,
      text: [...row.words]
        .sort((left, right) => left.left - right.left)
        .map((word) => word.text)
        .join(' '),
      left: row.left,
      top: row.top,
      right: row.right,
      bottom: row.bottom,
    }));
}

function setPath(
  target: Record<string, unknown>,
  path: readonly (string | number)[],
  value: unknown,
): void {
  if (path.length === 0) return;
  let cursor: Record<string | number, unknown> | unknown[] = target;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      setContainerValue(cursor, segment, value);
      return;
    }
    const next = containerValue(cursor, segment);
    if (typeof next === 'object' && next !== null) {
      cursor = next as Record<string | number, unknown> | unknown[];
      return;
    }
    const replacement: Record<string, unknown> | unknown[] =
      typeof path[index + 1] === 'number' ? [] : {};
    setContainerValue(cursor, segment, replacement);
    cursor = replacement;
  });
}

function containerValue(
  container: Record<string | number, unknown> | unknown[],
  key: string | number,
): unknown {
  if (Array.isArray(container)) {
    return typeof key === 'number' ? container[key] : undefined;
  }
  return container[key];
}

function setContainerValue(
  container: Record<string | number, unknown> | unknown[],
  key: string | number,
  value: unknown,
): void {
  if (Array.isArray(container)) {
    if (typeof key === 'number') container[key] = value;
    return;
  }
  container[key] = value;
}
