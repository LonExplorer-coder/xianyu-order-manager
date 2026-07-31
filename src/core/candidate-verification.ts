export const CANDIDATE_REGIONS = [
  'platform_status',
  'shipping_information',
  'purchased_items',
  'amount_summary',
  'order_details',
  'fulfillment_signals',
] as const;

export type CandidateRegion = (typeof CANDIDATE_REGIONS)[number];

export const CANDIDATE_VERIFICATION_LIMITS = {
  ambiguitiesPerRequest: 20,
  auditAmbiguitiesPerScreenshot: 100,
  contextLinesPerAmbiguity: 40,
  candidatesPerAmbiguity: 20,
  evidenceRefsPerCandidate: 20,
  identifierLength: 128,
  fieldLength: 128,
  contextLineTextLength: 2_000,
  candidateDisplayTextLength: 1_000,
  requestBytes: 256 * 1_024,
} as const;

/**
 * Field identifiers are intentionally extensible. Candidate adjudication is
 * provider-independent and future deterministic extractors may add fields
 * without changing the transport contract.
 */
export type CandidateField = string;

export type CandidateContextLine = {
  lineId: string;
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type CandidateEvidenceRef = {
  lineId: string;
  startOffset?: number;
  endOffset?: number;
};

export type Candidate = {
  candidateId: string;
  displayText: string;
  evidenceRefs: CandidateEvidenceRef[];
};

export type CandidateSet = {
  ambiguityId: string;
  region: CandidateRegion;
  field: CandidateField;
  itemIndex?: number;
  contextLines: CandidateContextLine[];
  candidates: Candidate[];
};

export type CandidateDecision =
  | {
    ambiguityId: string;
    resolution: 'selected';
    candidateId: string;
  }
  | {
    ambiguityId: string;
    resolution: 'unresolved';
  };

export type CandidateModelProvider =
  | 'deepseek'
  | 'aliyun-bailian'
  | 'openai-compatible';

export type CandidateAdjudicationFailureCode =
  | 'invalid_request'
  | 'timeout'
  | 'authentication'
  | 'rate_limited'
  | 'network'
  | 'remote_error'
  | 'response_too_large'
  | 'unsafe_response'
  | 'invalid_response';

export type CandidateAdjudicationFailure = {
  code: CandidateAdjudicationFailureCode;
  message: string;
};

export type CandidateAdjudicationResult =
  | {
    status: 'completed';
    provider: CandidateModelProvider;
    model: string;
    requestId?: string;
    decisions: CandidateDecision[];
  }
  | {
    status: 'failed';
    provider: CandidateModelProvider;
    model: string;
    requestId?: string;
    failure: CandidateAdjudicationFailure;
  };

export type CandidateModelConnectionTestResult =
  | {
    ok: true;
    provider: CandidateModelProvider;
    model: string;
    requestId?: string;
  }
  | {
    ok: false;
    provider: CandidateModelProvider;
    model: string;
    requestId?: string;
    failure: CandidateAdjudicationFailure;
  };

export interface CandidateAdjudicator {
  /** Optional metadata lets the OCR boundary record a safe failure audit if an adapter rejects. */
  readonly provider?: CandidateModelProvider;
  readonly model?: string;
  adjudicate(candidateSets: readonly CandidateSet[]): Promise<CandidateAdjudicationResult>;
  testConnection(): Promise<CandidateModelConnectionTestResult>;
}

export function isCandidateVerificationBatchValid(
  candidateSets: readonly CandidateSet[],
): boolean {
  if (
    candidateSets.length === 0 ||
    candidateSets.length > CANDIDATE_VERIFICATION_LIMITS.ambiguitiesPerRequest
  ) return false;

  const ambiguityIds = new Set<string>();
  for (const set of candidateSets) {
    if (!isCandidateVerificationSetValid(set) || ambiguityIds.has(set.ambiguityId)) {
      return false;
    }
    ambiguityIds.add(set.ambiguityId);
  }

  return new TextEncoder().encode(JSON.stringify({ candidateSets })).byteLength <=
    CANDIDATE_VERIFICATION_LIMITS.requestBytes;
}

export function isCandidateVerificationSetValid(set: CandidateSet): boolean {
  if (
    !isBoundedCandidateIdentifier(set.ambiguityId) ||
    !CANDIDATE_REGIONS.some((region) => region === set.region) ||
    !isBoundedCandidateText(set.field, CANDIDATE_VERIFICATION_LIMITS.fieldLength) ||
    (
      set.itemIndex !== undefined &&
      (!Number.isSafeInteger(set.itemIndex) || set.itemIndex < 0)
    ) ||
    !Array.isArray(set.contextLines) ||
    set.contextLines.length === 0 ||
    set.contextLines.length > CANDIDATE_VERIFICATION_LIMITS.contextLinesPerAmbiguity ||
    !Array.isArray(set.candidates) ||
    set.candidates.length < 2 ||
    set.candidates.length > CANDIDATE_VERIFICATION_LIMITS.candidatesPerAmbiguity
  ) return false;

  const linesById = new Map<string, CandidateContextLine>();
  for (const line of set.contextLines) {
    if (
      !isBoundedCandidateIdentifier(line.lineId) ||
      linesById.has(line.lineId) ||
      !isBoundedCandidateText(
        line.text,
        CANDIDATE_VERIFICATION_LIMITS.contextLineTextLength,
      ) ||
      !isValidCandidateBounds(line)
    ) return false;
    linesById.set(line.lineId, line);
  }

  const candidateIds = new Set<string>();
  for (const candidate of set.candidates) {
    if (
      !isBoundedCandidateIdentifier(candidate.candidateId) ||
      candidateIds.has(candidate.candidateId) ||
      !isBoundedCandidateText(
        candidate.displayText,
        CANDIDATE_VERIFICATION_LIMITS.candidateDisplayTextLength,
      ) ||
      !Array.isArray(candidate.evidenceRefs) ||
      candidate.evidenceRefs.length === 0 ||
      candidate.evidenceRefs.length >
        CANDIDATE_VERIFICATION_LIMITS.evidenceRefsPerCandidate
    ) return false;
    candidateIds.add(candidate.candidateId);

    for (const reference of candidate.evidenceRefs) {
      const line = linesById.get(reference.lineId);
      if (!line || !isValidCandidateEvidenceReference(reference, line.text.length)) {
        return false;
      }
    }
  }
  return true;
}

function isBoundedCandidateIdentifier(value: unknown): value is string {
  return isBoundedCandidateText(
    value,
    CANDIDATE_VERIFICATION_LIMITS.identifierLength,
  ) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedCandidateText(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximumLength;
}

function isValidCandidateBounds(value: CandidateContextLine): boolean {
  return [value.left, value.top, value.right, value.bottom]
    .every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0) &&
    value.right >= value.left &&
    value.bottom >= value.top;
}

function isValidCandidateEvidenceReference(
  reference: CandidateEvidenceRef,
  textLength: number,
): boolean {
  if (reference.startOffset === undefined && reference.endOffset === undefined) {
    return true;
  }
  return Number.isSafeInteger(reference.startOffset) &&
    Number.isSafeInteger(reference.endOffset) &&
    reference.startOffset! >= 0 &&
    reference.endOffset! >= reference.startOffset! &&
    reference.endOffset! <= textLength;
}
