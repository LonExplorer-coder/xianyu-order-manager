import type {
  FulfillmentStatus,
  OrderReviewIssueCode,
  PlatformTransactionStatus,
  RecognitionResult,
} from './contracts';
import { ORDER_REVIEW_ISSUE_CODES } from './contracts';

export const STAGE_ONE_MINIMUM_CASES = 30;
export const STAGE_ONE_MINIMUM_DUPLICATE_GROUPS = 2;
export const STAGE_ONE_OTHER_FIELD_ACCURACY_THRESHOLD = 0.95;

export type StageOneExpectedItem = {
  sourceTitle: string;
  sourceSpec: string;
  unitPriceCents: number | null;
  quantity: number;
};

export type StageOneExpectedOrder = {
  orderNumber: string;
  phoneNormalized: string;
  amountCents: number;
  alipayTransactionNumber: string;
  buyerNickname: string;
  recipient: string;
  addressOriginal: string;
  addressNormalized: string;
  province: string;
  city: string;
  district: string;
  orderedAtNormalized: string;
  paidAtNormalized: string;
  productTotalCents: number | null;
  shippingFeeCents: number | null;
  platformTransactionStatus: PlatformTransactionStatus;
  fulfillmentStatus: FulfillmentStatus;
  items: StageOneExpectedItem[];
};

export type StageOneAcceptanceCase = {
  id: string;
  screenshot: string;
  screenshotSha256: string;
  tags: string[];
  duplicateGroup?: string;
  expected: StageOneExpectedOrder;
};

export type StageOneAcceptanceManifest = {
  schemaVersion: 1;
  datasetId: string;
  datasetVersion: string;
  cases: StageOneAcceptanceCase[];
};

export type StageOneAcceptanceObservation = {
  caseId: string;
  screenshotSha256: string;
  outcome:
    | 'imported'
    | 'awaiting_confirmation'
    | 'duplicate_skipped'
    | 'failed'
    | 'cancelled';
  result: RecognitionResult | null;
  reviewIssues: OrderReviewIssueCode[];
  persistedOrderId?: string;
};

export type StageOneAcceptanceCapture = {
  schemaVersion: 1;
  manifestSha256: string;
  applicationVersion: string;
  gitCommit: string;
  gitDirty: boolean;
  model: string;
  region: string;
  capturedAt: string;
  observations: StageOneAcceptanceObservation[];
};

export type StageOneAcceptanceViolation =
  | { code: 'insufficient_cases' }
  | { code: 'insufficient_distinct_screenshots' }
  | { code: 'insufficient_duplicate_groups' }
  | { code: 'missing_multi_item_case' }
  | { code: 'duplicate_case_id'; caseId: string }
  | { code: 'missing_observation'; caseId: string }
  | { code: 'duplicate_observation'; caseId: string }
  | { code: 'unexpected_observation'; caseId: string }
  | { code: 'screenshot_hash_mismatch'; caseId: string }
  | {
    code: 'critical_field_silent_error';
    caseId: string;
    field: StageOneCriticalField;
  }
  | { code: 'other_field_accuracy_below_threshold' }
  | { code: 'item_count_silent_error'; caseId: string }
  | { code: 'duplicate_group_incomplete'; groupId: string }
  | { code: 'duplicate_group_not_resolved'; groupId: string }
  | { code: 'duplicate_group_created_multiple_orders'; groupId: string };

export type StageOneAcceptanceReport = {
  schemaVersion: 1;
  status: 'passed' | 'failed';
  generatedAt: string;
  application: {
    version: string;
    gitCommit: string;
  };
  recognition: {
    model: string;
    region: string;
    capturedAt: string;
  };
  dataset: {
    id: string;
    version: string;
    caseCount: number;
    distinctScreenshotCount: number;
    multiItemCaseCount: number;
    totalExpectedItemCount: number;
    manifestSha256: string;
  };
  criticalFields: {
    total: number;
    correct: number;
    blocked: number;
    silentErrors: number;
  };
  otherFields: {
    total: number;
    correct: number;
    incorrect: number;
    accuracy: number;
    threshold: number;
  };
  itemCounts: {
    total: number;
    correct: number;
    blocked: number;
    silentErrors: number;
  };
  duplicateGroups: {
    total: number;
    passed: number;
    failed: number;
  };
  fieldDifferences: Array<{ caseId: string; field: string }>;
  violations: StageOneAcceptanceViolation[];
};

export type EvaluateStageOneAcceptanceInput = {
  manifest: StageOneAcceptanceManifest;
  observations: StageOneAcceptanceObservation[];
  manifestSha256: string;
  applicationVersion: string;
  gitCommit: string;
  model: string;
  region: string;
  capturedAt: string;
  generatedAt?: string;
};

const CRITICAL_FIELDS = [
  'orderNumber',
  'phoneNormalized',
  'amountCents',
] as const;

type StageOneCriticalField = (typeof CRITICAL_FIELDS)[number];

const OTHER_ORDER_FIELDS = [
  'alipayTransactionNumber',
  'buyerNickname',
  'recipient',
  'addressOriginal',
  'addressNormalized',
  'province',
  'city',
  'district',
  'orderedAtNormalized',
  'paidAtNormalized',
  'productTotalCents',
  'shippingFeeCents',
  'platformTransactionStatus',
  'fulfillmentStatus',
] as const;

const OTHER_ITEM_FIELDS = [
  'sourceTitle',
  'sourceSpec',
  'unitPriceCents',
  'quantity',
] as const;

const NON_SUBSTANTIVE_REVIEW_ISSUES = new Set<OrderReviewIssueCode>([
  'automatic_import_disabled',
]);

const REVIEW_ISSUE_CODES = new Set<string>(ORDER_REVIEW_ISSUE_CODES);
const PLATFORM_TRANSACTION_STATUSES = new Set<PlatformTransactionStatus>([
  'paid',
  'cancelled',
  'refunded',
  'unknown',
]);
const FULFILLMENT_STATUSES = new Set<FulfillmentStatus>([
  'pending_shipment',
  'shipped',
  'unknown',
]);
const OBSERVATION_OUTCOMES = new Set<StageOneAcceptanceObservation['outcome']>([
  'imported',
  'awaiting_confirmation',
  'duplicate_skipped',
  'failed',
  'cancelled',
]);

export function parseStageOneAcceptanceManifest(
  value: unknown,
): StageOneAcceptanceManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isIdentifier(value.datasetId) ||
    !isBoundedString(value.datasetVersion, 100) ||
    !Array.isArray(value.cases) ||
    value.cases.length === 0 ||
    value.cases.length > 1_000
  ) {
    throw new Error('金标清单格式无效');
  }
  const cases = value.cases.map((entry) => parseAcceptanceCase(entry));
  return {
    schemaVersion: 1,
    datasetId: value.datasetId,
    datasetVersion: value.datasetVersion,
    cases,
  };
}

export function parseStageOneAcceptanceCapture(
  value: unknown,
): StageOneAcceptanceCapture {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isSha256(value.manifestSha256) ||
    !isVersion(value.applicationVersion) ||
    !isGitCommit(value.gitCommit) ||
    typeof value.gitDirty !== 'boolean' ||
    !isPublicMetadata(value.model, 200) ||
    !isPublicMetadata(value.region, 100) ||
    !isIsoDateTime(value.capturedAt) ||
    !Array.isArray(value.observations) ||
    value.observations.length > 1_000
  ) {
    throw new Error('私有捕获文件格式无效');
  }
  try {
    return {
      schemaVersion: 1,
      manifestSha256: value.manifestSha256,
      applicationVersion: value.applicationVersion,
      gitCommit: value.gitCommit,
      gitDirty: value.gitDirty,
      model: value.model,
      region: value.region,
      capturedAt: value.capturedAt,
      observations: value.observations.map((entry) => parseObservation(entry)),
    };
  } catch {
    throw new Error('私有捕获文件格式无效');
  }
}

export function renderStageOneAcceptanceMarkdown(
  report: StageOneAcceptanceReport,
): string {
  const conclusion = report.status === 'passed' ? '通过' : '不通过';
  const percentage = (report.otherFields.accuracy * 100).toFixed(2);
  const lines = [
    '# 第一阶段核心可用版验收报告',
    '',
    `- 结论：${conclusion}`,
    `- 应用版本：${report.application.version}`,
    `- Git 提交：${report.application.gitCommit}`,
    `- 识别模型：${report.recognition.model}（${report.recognition.region}）`,
    `- 数据集：${report.dataset.id} / ${report.dataset.version}`,
    `- 样本：${report.dataset.caseCount} 张，${report.dataset.distinctScreenshotCount} 个不同图片指纹`,
    `- 商品覆盖：${report.dataset.multiItemCaseCount} 个多商品案例，${report.dataset.totalExpectedItemCount} 条金标商品明细`,
    `- 清单 SHA-256：${report.dataset.manifestSha256}`,
    '',
    '## 验收门槛',
    '',
    `- 关键字段：${report.criticalFields.correct} 项正确，${report.criticalFields.blocked} 项被安全拦截，${report.criticalFields.silentErrors} 项静默错误（共 ${report.criticalFields.total} 项）`,
    `- 其他原子字段：${report.otherFields.correct}/${report.otherFields.total}，准确率 ${percentage}%（门槛 ${(report.otherFields.threshold * 100).toFixed(0)}%）`,
    `- 商品条目数：${report.itemCounts.correct} 项正确，${report.itemCounts.blocked} 项被安全拦截，${report.itemCounts.silentErrors} 项静默错误（共 ${report.itemCounts.total} 项）`,
    `- 重复组：${report.duplicateGroups.passed}/${report.duplicateGroups.total} 通过`,
    '',
    '## 定位信息',
    '',
  ];
  if (report.violations.length === 0 && report.fieldDifferences.length === 0) {
    lines.push('- 无');
  } else {
    for (const violation of report.violations) {
      lines.push(`- 门槛：${formatViolation(violation)}`);
    }
    for (const difference of report.fieldDifferences) {
      lines.push(`- 普通字段差异：${difference.caseId} / ${difference.field}`);
    }
  }
  lines.push('', '> 本报告只包含匿名案例编号、字段路径和汇总值，不包含截图路径、订单字段原值或 OCR 识别原文。', '');
  return lines.join('\n');
}

export function evaluateStageOneAcceptance(
  input: EvaluateStageOneAcceptanceInput,
): StageOneAcceptanceReport {
  const violations: StageOneAcceptanceViolation[] = [];
  const fieldDifferences: Array<{ caseId: string; field: string }> = [];
  const caseIds = new Set<string>();
  for (const testCase of input.manifest.cases) {
    if (caseIds.has(testCase.id)) {
      violations.push({ code: 'duplicate_case_id', caseId: testCase.id });
    }
    caseIds.add(testCase.id);
  }

  const distinctScreenshotCount = new Set(
    input.manifest.cases.map(({ screenshotSha256 }) => screenshotSha256),
  ).size;
  if (input.manifest.cases.length < STAGE_ONE_MINIMUM_CASES) {
    violations.push({ code: 'insufficient_cases' });
  }
  if (distinctScreenshotCount < STAGE_ONE_MINIMUM_CASES) {
    violations.push({ code: 'insufficient_distinct_screenshots' });
  }
  const multiItemCaseCount = input.manifest.cases.filter(
    ({ expected }) => expected.items.length > 1,
  ).length;
  const totalExpectedItemCount = input.manifest.cases.reduce(
    (total, { expected }) => total + expected.items.length,
    0,
  );
  if (multiItemCaseCount === 0) {
    violations.push({ code: 'missing_multi_item_case' });
  }

  const observationGroups = new Map<string, StageOneAcceptanceObservation[]>();
  for (const observation of input.observations) {
    const group = observationGroups.get(observation.caseId) ?? [];
    group.push(observation);
    observationGroups.set(observation.caseId, group);
    if (!caseIds.has(observation.caseId)) {
      violations.push({
        code: 'unexpected_observation',
        caseId: observation.caseId,
      });
    }
  }

  let criticalCorrect = 0;
  let criticalBlocked = 0;
  let criticalSilentErrors = 0;
  let otherCorrect = 0;
  let otherIncorrect = 0;
  let itemCountCorrect = 0;
  let itemCountBlocked = 0;
  let itemCountSilentErrors = 0;

  for (const testCase of input.manifest.cases) {
    const matchingObservations = observationGroups.get(testCase.id) ?? [];
    if (matchingObservations.length === 0) {
      violations.push({ code: 'missing_observation', caseId: testCase.id });
    } else if (matchingObservations.length > 1) {
      violations.push({ code: 'duplicate_observation', caseId: testCase.id });
    }
    const observation = matchingObservations[0];
    if (
      observation &&
      observation.screenshotSha256 !== testCase.screenshotSha256
    ) {
      violations.push({ code: 'screenshot_hash_mismatch', caseId: testCase.id });
    }
    const blocked = observation ? isSubstantivelyBlocked(observation) : false;

    for (const field of CRITICAL_FIELDS) {
      if (observation?.result && valuesEqual(
        observation.result[field],
        testCase.expected[field],
      )) {
        criticalCorrect += 1;
      } else if (blocked) {
        criticalBlocked += 1;
      } else {
        criticalSilentErrors += 1;
        violations.push({
          code: 'critical_field_silent_error',
          caseId: testCase.id,
          field,
        });
      }
    }

    for (const field of OTHER_ORDER_FIELDS) {
      const score = scoreOtherField(
        observation?.result?.[field],
        testCase.expected[field],
      );
      if (score === 'excluded') continue;
      if (score === 'correct') otherCorrect += 1;
      else {
        otherIncorrect += 1;
        fieldDifferences.push({ caseId: testCase.id, field });
      }
    }

    for (const [itemIndex, expectedItem] of testCase.expected.items.entries()) {
      const actualItem = observation?.result?.items[itemIndex];
      for (const field of OTHER_ITEM_FIELDS) {
        const score = scoreOtherField(actualItem?.[field], expectedItem[field]);
        if (score === 'excluded') continue;
        if (score === 'correct') otherCorrect += 1;
        else {
          otherIncorrect += 1;
          fieldDifferences.push({
            caseId: testCase.id,
            field: `items[${itemIndex}].${field}`,
          });
        }
      }
    }

    if (observation?.result?.items.length === testCase.expected.items.length) {
      itemCountCorrect += 1;
    } else if (blocked) {
      itemCountBlocked += 1;
    } else {
      itemCountSilentErrors += 1;
      violations.push({ code: 'item_count_silent_error', caseId: testCase.id });
    }
  }

  const otherTotal = otherCorrect + otherIncorrect;
  const otherAccuracy = otherTotal === 0 ? 0 : otherCorrect / otherTotal;
  if (otherAccuracy < STAGE_ONE_OTHER_FIELD_ACCURACY_THRESHOLD) {
    violations.push({ code: 'other_field_accuracy_below_threshold' });
  }

  const duplicateGroups = new Map<string, StageOneAcceptanceCase[]>();
  for (const testCase of input.manifest.cases) {
    if (!testCase.duplicateGroup) continue;
    const group = duplicateGroups.get(testCase.duplicateGroup) ?? [];
    group.push(testCase);
    duplicateGroups.set(testCase.duplicateGroup, group);
  }
  if (duplicateGroups.size < STAGE_ONE_MINIMUM_DUPLICATE_GROUPS) {
    violations.push({ code: 'insufficient_duplicate_groups' });
  }
  let duplicateGroupsPassed = 0;
  for (const [groupId, cases] of duplicateGroups) {
    if (cases.length < 2) {
      violations.push({ code: 'duplicate_group_incomplete', groupId });
      continue;
    }
    const observations = cases.flatMap((testCase) => (
      observationGroups.get(testCase.id) ?? []
    ));
    if (
      observations.length !== cases.length ||
      observations.some(({ outcome, persistedOrderId }) => (
        !persistedOrderId ||
        (outcome !== 'imported' && outcome !== 'duplicate_skipped')
      )) ||
      !observations.some(({ outcome }) => outcome === 'imported') ||
      !observations.some(({ outcome }) => outcome === 'duplicate_skipped')
    ) {
      violations.push({ code: 'duplicate_group_not_resolved', groupId });
      continue;
    }
    const persistedOrderIds = new Set(
      observations.map(({ persistedOrderId }) => persistedOrderId),
    );
    if (persistedOrderIds.size !== 1) {
      violations.push({
        code: 'duplicate_group_created_multiple_orders',
        groupId,
      });
      continue;
    }
    duplicateGroupsPassed += 1;
  }

  const publicViolations = anonymizeViolations(
    violations,
    input.manifest.cases,
  );
  const publicFieldDifferences = anonymizeFieldDifferences(
    fieldDifferences,
    input.manifest.cases,
  );
  const publicDatasetSuffix = input.manifestSha256.slice(0, 12);

  return {
    schemaVersion: 1,
    status: publicViolations.length === 0 ? 'passed' : 'failed',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    application: {
      version: input.applicationVersion,
      gitCommit: input.gitCommit,
    },
    recognition: {
      model: input.model,
      region: input.region,
      capturedAt: input.capturedAt,
    },
    dataset: {
      id: `dataset-${publicDatasetSuffix}`,
      version: `manifest-${publicDatasetSuffix}`,
      caseCount: input.manifest.cases.length,
      distinctScreenshotCount,
      multiItemCaseCount,
      totalExpectedItemCount,
      manifestSha256: input.manifestSha256,
    },
    criticalFields: {
      total: input.manifest.cases.length * CRITICAL_FIELDS.length,
      correct: criticalCorrect,
      blocked: criticalBlocked,
      silentErrors: criticalSilentErrors,
    },
    otherFields: {
      total: otherTotal,
      correct: otherCorrect,
      incorrect: otherIncorrect,
      accuracy: otherAccuracy,
      threshold: STAGE_ONE_OTHER_FIELD_ACCURACY_THRESHOLD,
    },
    itemCounts: {
      total: input.manifest.cases.length,
      correct: itemCountCorrect,
      blocked: itemCountBlocked,
      silentErrors: itemCountSilentErrors,
    },
    duplicateGroups: {
      total: duplicateGroups.size,
      passed: duplicateGroupsPassed,
      failed: duplicateGroups.size - duplicateGroupsPassed,
    },
    fieldDifferences: publicFieldDifferences,
    violations: publicViolations,
  };
}

function isSubstantivelyBlocked(observation: StageOneAcceptanceObservation): boolean {
  if (observation.persistedOrderId) return false;
  if (observation.outcome === 'failed') return true;
  if (observation.outcome !== 'awaiting_confirmation') return false;
  return observation.reviewIssues.some((issue) => (
    !NON_SUBSTANTIVE_REVIEW_ISSUES.has(issue)
  ));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function scoreOtherField(
  actual: unknown,
  expected: unknown,
): 'correct' | 'incorrect' | 'excluded' {
  if (isNotApplicableGoldValue(expected)) {
    if (actual === undefined || valuesEqual(actual, expected)) return 'excluded';
    return 'incorrect';
  }
  return valuesEqual(actual, expected) ? 'correct' : 'incorrect';
}

function isNotApplicableGoldValue(value: unknown): boolean {
  return value === '' || value === null || value === 'unknown';
}

function anonymizeViolations(
  violations: StageOneAcceptanceViolation[],
  cases: StageOneAcceptanceCase[],
): StageOneAcceptanceViolation[] {
  const { caseIds, groupIds } = publicAcceptanceIds(cases);
  const unexpectedCaseIds = new Map<string, string>();
  return violations.map((violation) => {
    if ('caseId' in violation) {
      let publicCaseId = caseIds.get(violation.caseId);
      if (!publicCaseId) {
        publicCaseId = unexpectedCaseIds.get(violation.caseId);
        if (!publicCaseId) {
          publicCaseId = `unexpected-${String(unexpectedCaseIds.size + 1).padStart(3, '0')}`;
          unexpectedCaseIds.set(violation.caseId, publicCaseId);
        }
      }
      return { ...violation, caseId: publicCaseId };
    }
    if ('groupId' in violation) {
      return {
        ...violation,
        groupId: groupIds.get(violation.groupId) ?? 'group-unknown',
      };
    }
    return violation;
  });
}

function anonymizeFieldDifferences(
  differences: Array<{ caseId: string; field: string }>,
  cases: StageOneAcceptanceCase[],
): Array<{ caseId: string; field: string }> {
  const { caseIds } = publicAcceptanceIds(cases);
  return differences.map((difference) => ({
    ...difference,
    caseId: caseIds.get(difference.caseId) ?? 'case-unknown',
  }));
}

function publicAcceptanceIds(cases: StageOneAcceptanceCase[]): {
  caseIds: Map<string, string>;
  groupIds: Map<string, string>;
} {
  const caseIds = new Map<string, string>();
  const groupIds = new Map<string, string>();
  for (const [index, testCase] of cases.entries()) {
    if (!caseIds.has(testCase.id)) {
      caseIds.set(
        testCase.id,
        `case-${String(index + 1).padStart(3, '0')}`,
      );
    }
    if (testCase.duplicateGroup && !groupIds.has(testCase.duplicateGroup)) {
      groupIds.set(
        testCase.duplicateGroup,
        `group-${String(groupIds.size + 1).padStart(3, '0')}`,
      );
    }
  }
  return { caseIds, groupIds };
}

function parseAcceptanceCase(value: unknown): StageOneAcceptanceCase {
  if (
    !isRecord(value) ||
    !isIdentifier(value.id) ||
    !isSafeRelativeScreenshotPath(value.screenshot) ||
    !isSha256(value.screenshotSha256) ||
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => isIdentifier(tag)) ||
    (
      value.duplicateGroup !== undefined &&
      !isIdentifier(value.duplicateGroup)
    )
  ) {
    if (isRecord(value) && !isSafeRelativeScreenshotPath(value.screenshot)) {
      throw new Error('金标清单中的截图必须使用清单目录内的相对路径');
    }
    if (isRecord(value) && !isSha256(value.screenshotSha256)) {
      throw new Error('金标清单中的图片指纹格式无效');
    }
    throw new Error('金标清单格式无效');
  }
  return {
    id: value.id,
    screenshot: value.screenshot,
    screenshotSha256: value.screenshotSha256,
    tags: [...value.tags],
    ...(value.duplicateGroup === undefined
      ? {}
      : { duplicateGroup: value.duplicateGroup }),
    expected: parseExpectedOrder(value.expected),
  };
}

function parseExpectedOrder(value: unknown): StageOneExpectedOrder {
  if (
    !isRecord(value) ||
    !isBoundedString(value.orderNumber, 100) ||
    !isNormalizedPhone(value.phoneNormalized) ||
    !isMoney(value.amountCents, false) ||
    !isBoundedString(value.alipayTransactionNumber, 200, true) ||
    !isBoundedString(value.buyerNickname, 500, true) ||
    !isBoundedString(value.recipient, 200, true) ||
    !isBoundedString(value.addressOriginal, 1_000, true) ||
    !isBoundedString(value.addressNormalized, 1_000, true) ||
    !isBoundedString(value.province, 100, true) ||
    !isBoundedString(value.city, 100, true) ||
    !isBoundedString(value.district, 100, true) ||
    !isBoundedString(value.orderedAtNormalized, 100, true) ||
    !isBoundedString(value.paidAtNormalized, 100, true) ||
    !isMoney(value.productTotalCents, true) ||
    !isMoney(value.shippingFeeCents, true) ||
    !PLATFORM_TRANSACTION_STATUSES.has(
      value.platformTransactionStatus as PlatformTransactionStatus,
    ) ||
    !FULFILLMENT_STATUSES.has(value.fulfillmentStatus as FulfillmentStatus) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > 100
  ) {
    throw new Error('金标清单字段不完整或格式无效');
  }
  return {
    orderNumber: value.orderNumber,
    phoneNormalized: value.phoneNormalized,
    amountCents: value.amountCents,
    alipayTransactionNumber: value.alipayTransactionNumber,
    buyerNickname: value.buyerNickname,
    recipient: value.recipient,
    addressOriginal: value.addressOriginal,
    addressNormalized: value.addressNormalized,
    province: value.province,
    city: value.city,
    district: value.district,
    orderedAtNormalized: value.orderedAtNormalized,
    paidAtNormalized: value.paidAtNormalized,
    productTotalCents: value.productTotalCents,
    shippingFeeCents: value.shippingFeeCents,
    platformTransactionStatus: value.platformTransactionStatus as PlatformTransactionStatus,
    fulfillmentStatus: value.fulfillmentStatus as FulfillmentStatus,
    items: value.items.map((item) => parseExpectedItem(item)),
  };
}

function parseExpectedItem(value: unknown): StageOneExpectedItem {
  if (
    !isRecord(value) ||
    !isBoundedString(value.sourceTitle, 1_000, true) ||
    !isBoundedString(value.sourceSpec, 1_000, true) ||
    !isMoney(value.unitPriceCents, true) ||
    !Number.isSafeInteger(value.quantity) ||
    Number(value.quantity) < 1
  ) {
    throw new Error('金标清单字段不完整或格式无效');
  }
  return {
    sourceTitle: value.sourceTitle,
    sourceSpec: value.sourceSpec,
    unitPriceCents: value.unitPriceCents,
    quantity: value.quantity as number,
  };
}

function parseObservation(value: unknown): StageOneAcceptanceObservation {
  if (
    !isRecord(value) ||
    !isIdentifier(value.caseId) ||
    !isSha256(value.screenshotSha256) ||
    !OBSERVATION_OUTCOMES.has(value.outcome as StageOneAcceptanceObservation['outcome']) ||
    !Array.isArray(value.reviewIssues) ||
    !value.reviewIssues.every((issue) => (
      typeof issue === 'string' && REVIEW_ISSUE_CODES.has(issue)
    )) ||
    (
      value.persistedOrderId !== undefined &&
      !isBoundedString(value.persistedOrderId, 200)
    )
  ) {
    throw new Error('invalid observation');
  }
  const result = value.result === null ? null : parseRecognitionResult(value.result);
  return {
    caseId: value.caseId,
    screenshotSha256: value.screenshotSha256,
    outcome: value.outcome as StageOneAcceptanceObservation['outcome'],
    result,
    reviewIssues: [...value.reviewIssues] as OrderReviewIssueCode[],
    ...(value.persistedOrderId === undefined
      ? {}
      : { persistedOrderId: value.persistedOrderId }),
  };
}

function parseRecognitionResult(value: unknown): RecognitionResult {
  if (
    !isRecord(value) ||
    value.platform !== 'xianyu' ||
    !isBoundedString(value.sellerAccount, 500, true) ||
    !isBoundedString(value.orderNumber, 200, true) ||
    !isBoundedString(value.alipayTransactionNumber, 300, true) ||
    !isBoundedString(value.buyerNickname, 1_000, true) ||
    !isBoundedString(value.recipient, 500, true) ||
    !isBoundedString(value.phone, 200, true) ||
    !isBoundedString(value.phoneNormalized, 200, true) ||
    !isBoundedString(value.addressOriginal, 2_000, true) ||
    !isBoundedString(value.addressNormalized, 2_000, true) ||
    !isBoundedString(value.province, 200, true) ||
    !isBoundedString(value.city, 200, true) ||
    !isBoundedString(value.district, 200, true) ||
    !isBoundedString(value.orderedAtOriginal, 200, true) ||
    !isBoundedString(value.orderedAtNormalized, 200, true) ||
    !isBoundedString(value.paidAtOriginal, 200, true) ||
    !isBoundedString(value.paidAtNormalized, 200, true) ||
    !isMoney(value.productTotalCents, true) ||
    !isMoney(value.shippingFeeCents, true) ||
    !isMoney(value.amountCents, true) ||
    !PLATFORM_TRANSACTION_STATUSES.has(
      value.platformTransactionStatus as PlatformTransactionStatus,
    ) ||
    !FULFILLMENT_STATUSES.has(value.fulfillmentStatus as FulfillmentStatus) ||
    !Array.isArray(value.items) ||
    value.items.length > 100
  ) {
    throw new Error('invalid recognition result');
  }
  const items = value.items.map((item) => parseRecognitionItem(item));
  return {
    platform: 'xianyu',
    sellerAccount: value.sellerAccount,
    orderNumber: value.orderNumber,
    alipayTransactionNumber: value.alipayTransactionNumber,
    buyerNickname: value.buyerNickname,
    recipient: value.recipient,
    phone: value.phone,
    phoneNormalized: value.phoneNormalized,
    addressOriginal: value.addressOriginal,
    addressNormalized: value.addressNormalized,
    province: value.province,
    city: value.city,
    district: value.district,
    orderedAtOriginal: value.orderedAtOriginal,
    orderedAtNormalized: value.orderedAtNormalized,
    paidAtOriginal: value.paidAtOriginal,
    paidAtNormalized: value.paidAtNormalized,
    productTotalCents: value.productTotalCents,
    shippingFeeCents: value.shippingFeeCents,
    amountCents: value.amountCents,
    platformTransactionStatus: value.platformTransactionStatus as PlatformTransactionStatus,
    fulfillmentStatus: value.fulfillmentStatus as FulfillmentStatus,
    items,
  };
}

function parseRecognitionItem(value: unknown): RecognitionResult['items'][number] {
  if (
    !isRecord(value) ||
    !isBoundedString(value.sourceTitle, 2_000, true) ||
    !isBoundedString(value.sourceSpec, 2_000, true) ||
    !isMoney(value.unitPriceCents, true) ||
    !Number.isSafeInteger(value.quantity) ||
    Number(value.quantity) < 0 ||
    typeof value.quantityInferred !== 'boolean'
  ) {
    throw new Error('invalid recognition item');
  }
  return {
    sourceTitle: value.sourceTitle,
    sourceSpec: value.sourceSpec,
    unitPriceCents: value.unitPriceCents,
    quantity: value.quantity as number,
    quantityInferred: value.quantityInferred,
    ...(typeof value.quantitySource === 'string'
      ? { quantitySource: value.quantitySource as RecognitionResult['items'][number]['quantitySource'] }
      : {}),
  };
}

function formatViolation(violation: StageOneAcceptanceViolation): string {
  if ('caseId' in violation && 'field' in violation) {
    return `${violation.code} / ${violation.caseId} / ${violation.field}`;
  }
  if ('caseId' in violation) return `${violation.code} / ${violation.caseId}`;
  if ('groupId' in violation) return `${violation.code} / ${violation.groupId}`;
  return violation.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): value is string {
  return typeof value === 'string' &&
    value.length <= maximumLength &&
    (allowEmpty || value.trim().length > 0);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,99}$/u.test(value);
}

function isPublicMetadata(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === 'string' &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(value);
}

function isSafeRelativeScreenshotPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 1_000) return false;
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/u.test(value)) return false;
  const segments = value.split(/[\\/]/u);
  if (segments.some((segment) => !segment || segment === '..')) return false;
  return /\.(?:png|jpe?g|webp)$/iu.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isGitCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40,64}$/u.test(value);
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isNormalizedPhone(value: unknown): value is string {
  return typeof value === 'string' && /^1\d{10}$/u.test(value);
}

function isMoney(value: unknown, allowNull: false): value is number;
function isMoney(value: unknown, allowNull: true): value is number | null;
function isMoney(value: unknown, allowNull: boolean): value is number | null {
  return (allowNull && value === null) || (
    Number.isSafeInteger(value) && Number(value) >= 0
  );
}
