import { describe, expect, it } from 'vitest';

import type { RecognitionResult } from '../src/core/contracts';
import {
  evaluateStageOneAcceptance,
  parseStageOneAcceptanceCapture,
  parseStageOneAcceptanceManifest,
  renderStageOneAcceptanceMarkdown,
  type StageOneAcceptanceCapture,
  type StageOneAcceptanceManifest,
  type StageOneAcceptanceObservation,
} from '../src/core/stage-one-acceptance';

describe('第一阶段私有金标验收', () => {
  it('30 张不同截图全部匹配时生成不含订单原值的通过报告', () => {
    const manifest = manifestWithCases(30);
    const observations = manifest.cases.map((testCase, index) => (
      passingObservation(testCase, index)
    ));

    const report = evaluateStageOneAcceptance({
      manifest,
      observations,
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      status: 'passed',
      dataset: {
        id: 'dataset-aaaaaaaaaaaa',
        version: 'manifest-aaaaaaaaaaaa',
        caseCount: 30,
        distinctScreenshotCount: 30,
        manifestSha256: 'a'.repeat(64),
      },
      criticalFields: {
        total: 90,
        correct: 90,
        blocked: 0,
        silentErrors: 0,
      },
      otherFields: {
        accuracy: 1,
        threshold: 0.95,
      },
      itemCounts: {
        total: 30,
        correct: 30,
        blocked: 0,
        silentErrors: 0,
      },
    });
    expect(report.violations).toEqual([]);

    const publicText = JSON.stringify(report);
    expect(publicText).not.toContain('验收收件人');
    expect(publicText).not.toContain('13900000000');
    expect(publicText).not.toContain('广东省深圳市南山区验收路');
    expect(publicText).not.toContain('images/case-');
  });

  it('不会把“仅关闭自动入库”当作关键字段错误已被安全拦截', () => {
    const manifest = manifestWithCases(30);
    const observations = manifest.cases.map((testCase, index) => observation(
      testCase.id,
      testCase.screenshotSha256,
      index === 0
        ? { ...recognition(index), phoneNormalized: '13999999999' }
        : recognition(index),
      index === 0 ? 'awaiting_confirmation' : passingOutcome(index),
      index === 0 ? undefined : persistedOrderId(index),
      index === 0 ? ['automatic_import_disabled'] : [],
    ));

    const report = evaluateStageOneAcceptance({
      manifest,
      observations,
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(report.status).toBe('failed');
    expect(report.criticalFields).toMatchObject({
      correct: 89,
      blocked: 0,
      silentErrors: 1,
    });
    expect(report.violations).toContainEqual({
      code: 'critical_field_silent_error',
      caseId: 'case-001',
      field: 'phoneNormalized',
    });
  });

  it('关键字段和商品条目数不一致时只有真实校验原因且未入库才算安全拦截', () => {
    const manifest = manifestWithCases(30);
    const observations = manifest.cases.map((testCase, index) => {
      if (index !== 0) {
        return passingObservation(testCase, index);
      }
      return observation(
        testCase.id,
        testCase.screenshotSha256,
        {
          ...recognition(index),
          orderNumber: 'WRONG-ORDER-0001',
          amountCents: 999,
          items: [],
        },
        'awaiting_confirmation',
        undefined,
        ['missing_items'],
      );
    });

    const report = evaluateStageOneAcceptance({
      manifest,
      observations,
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(report.criticalFields).toMatchObject({
      correct: 88,
      blocked: 2,
      silentErrors: 0,
    });
    expect(report.itemCounts).toMatchObject({
      correct: 29,
      blocked: 1,
      silentErrors: 0,
    });
    // 被拦截只保护关键字段和商品条目数；其他可见原子字段仍照常计分。
    expect(report.otherFields.incorrect).toBeGreaterThan(0);
  });

  it('少量普通字段差异会被定位，但在准确率仍达 95% 时不误判整体验收失败', () => {
    const manifest = manifestWithCases(30);
    const observations = manifest.cases.map((testCase, index) => observation(
      testCase.id,
      testCase.screenshotSha256,
      index === 0
        ? { ...recognition(index), buyerNickname: '识别成了另一个昵称' }
        : recognition(index),
      passingOutcome(index),
      persistedOrderId(index),
    ));

    const report = evaluateStageOneAcceptance({
      manifest,
      observations,
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(report.status).toBe('passed');
    expect(report.otherFields).toMatchObject({ incorrect: 1 });
    expect(report.fieldDifferences).toContainEqual({
      caseId: 'case-001',
      field: 'buyerNickname',
    });
    expect(report.violations).toEqual([]);
  });

  it('拒绝不足 30 个不同图片指纹以及重复组产生多笔正式订单', () => {
    const manifest = manifestWithCases(30);
    manifest.cases[1] = {
      ...manifest.cases[1],
      screenshotSha256: manifest.cases[0].screenshotSha256,
      duplicateGroup: 'same-order',
    };
    manifest.cases[0] = { ...manifest.cases[0], duplicateGroup: 'same-order' };
    const observations = manifest.cases.map((testCase, index) => observation(
      testCase.id,
      testCase.screenshotSha256,
      recognition(index),
      passingOutcome(index),
      index < 2 ? `duplicate-order-${index}` : persistedOrderId(index),
    ));

    const report = evaluateStageOneAcceptance({
      manifest,
      observations,
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(report.status).toBe('failed');
    expect(report.violations).toEqual(expect.arrayContaining([
      { code: 'insufficient_distinct_screenshots' },
      { code: 'duplicate_group_created_multiple_orders', groupId: 'group-001' },
    ]));
  });

  it('要求正式数据集至少覆盖两个重复组和一个多商品案例', () => {
    const withoutDuplicateGroups = manifestWithCases(30);
    withoutDuplicateGroups.cases = withoutDuplicateGroups.cases.map((testCase) => {
      const { duplicateGroup: _duplicateGroup, ...rest } = testCase;
      return rest;
    });
    const duplicateCoverageReport = evaluateStageOneAcceptance({
      manifest: withoutDuplicateGroups,
      observations: withoutDuplicateGroups.cases.map((testCase, index) => observation(
        testCase.id,
        testCase.screenshotSha256,
        recognition(index),
        'imported',
        `independent-order-${index}`,
      )),
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(duplicateCoverageReport.violations).toContainEqual({
      code: 'insufficient_duplicate_groups',
    });

    const withoutMultiItem = manifestWithCases(30);
    withoutMultiItem.cases = withoutMultiItem.cases.map((testCase) => ({
      ...testCase,
      expected: {
        ...testCase.expected,
        items: testCase.expected.items.slice(0, 1),
      },
    }));
    const multiItemCoverageReport = evaluateStageOneAcceptance({
      manifest: withoutMultiItem,
      observations: withoutMultiItem.cases.map((testCase, index) => {
        const result = recognition(index);
        return observation(
          testCase.id,
          testCase.screenshotSha256,
          { ...result, items: result.items.slice(0, 1) },
          passingOutcome(index),
          persistedOrderId(index),
        );
      }),
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(multiItemCoverageReport.violations).toContainEqual({
      code: 'missing_multi_item_case',
    });
  });

  it('重复组中每张截图都必须解析到同一订单且实际出现重复跳过', () => {
    const manifest = manifestWithCases(30);
    const observations = manifest.cases.map((testCase, index) => {
      if (index === 1) {
        return observation(
          testCase.id,
          testCase.screenshotSha256,
          recognition(index),
          'awaiting_confirmation',
          undefined,
          ['duplicate_order'],
        );
      }
      return passingObservation(testCase, index);
    });

    const report = evaluateStageOneAcceptance({
      manifest,
      observations,
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(report.violations).toContainEqual({
      code: 'duplicate_group_not_resolved',
      groupId: 'group-001',
    });
  });

  it('空值金标不扩充 95% 分母，但从不可见区域臆造的值仍计为差异', () => {
    const manifest = manifestWithCases(30);
    manifest.cases = manifest.cases.map((testCase) => ({
      ...testCase,
      expected: {
        ...testCase.expected,
        alipayTransactionNumber: '',
        buyerNickname: '',
      },
    }));
    const matching = manifest.cases.map((testCase, index) => {
      const result = recognition(index);
      return observation(
        testCase.id,
        testCase.screenshotSha256,
        { ...result, alipayTransactionNumber: '', buyerNickname: '' },
        passingOutcome(index),
        persistedOrderId(index),
      );
    });
    const baseline = evaluateStageOneAcceptance({
      manifest,
      observations: matching,
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });
    const hallucinated = structuredClone(matching);
    if (!hallucinated[0].result) throw new Error('测试识别结果缺失');
    hallucinated[0].result.buyerNickname = '截图中不存在的昵称';
    const hallucinationReport = evaluateStageOneAcceptance({
      manifest,
      observations: hallucinated,
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(baseline.otherFields.total).toBeLessThan(30 * 18);
    expect(hallucinationReport.otherFields).toMatchObject({
      total: baseline.otherFields.total + 1,
      correct: baseline.otherFields.correct,
      incorrect: 1,
    });
    expect(hallucinationReport.fieldDifferences).toContainEqual({
      caseId: 'case-001',
      field: 'buyerNickname',
    });
  });

  it('带正式订单标识的待确认结果不能冒充安全拦截', () => {
    const manifest = manifestWithCases(30);
    const observations = manifest.cases.map((testCase, index) => {
      if (index !== 0) return passingObservation(testCase, index);
      return observation(
        testCase.id,
        testCase.screenshotSha256,
        { ...recognition(index), amountCents: 999 },
        'awaiting_confirmation',
        'unexpected-persisted-order',
        ['missing_items'],
      );
    });

    const report = evaluateStageOneAcceptance({
      manifest,
      observations,
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });

    expect(report.violations).toContainEqual({
      code: 'critical_field_silent_error',
      caseId: 'case-001',
      field: 'amountCents',
    });
  });

  it('在付费识别前拒绝绝对路径、目录穿越、无效指纹和缺失字段', () => {
    const valid = manifestWithCases(30);
    expect(parseStageOneAcceptanceManifest(valid)).toEqual(valid);

    for (const screenshot of [
      '/Users/example/private.png',
      'C:\\Users\\example\\private.png',
      '../outside/private.png',
      'images/../../outside.png',
    ]) {
      const invalid = structuredClone(valid) as Record<string, unknown>;
      (invalid.cases as StageOneAcceptanceManifest['cases'])[0].screenshot = screenshot;
      expect(() => parseStageOneAcceptanceManifest(invalid)).toThrowError(
        '金标清单中的截图必须使用清单目录内的相对路径',
      );
    }

    const invalidHash = structuredClone(valid);
    invalidHash.cases[0].screenshotSha256 = 'not-a-sha256';
    expect(() => parseStageOneAcceptanceManifest(invalidHash)).toThrowError(
      '金标清单中的图片指纹格式无效',
    );

    const missingExpectedField = structuredClone(valid) as unknown as {
      cases: Array<{ expected: Record<string, unknown> }>;
    };
    delete missingExpectedField.cases[0].expected.recipient;
    expect(() => parseStageOneAcceptanceManifest(missingExpectedField)).toThrowError(
      '金标清单字段不完整或格式无效',
    );
  });

  it('严格校验私有捕获文件，并把报告渲染为不含字段原值的 Markdown', () => {
    const manifest = manifestWithCases(30);
    const capture: StageOneAcceptanceCapture = {
      schemaVersion: 1,
      manifestSha256: 'a'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      gitDirty: false,
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
      observations: manifest.cases.map((testCase, index) => (
        passingObservation(testCase, index)
      )),
    };
    expect(parseStageOneAcceptanceCapture(capture)).toEqual(capture);

    const unknownIssue = structuredClone(capture) as unknown as {
      observations: Array<{ reviewIssues: string[] }>;
    };
    unknownIssue.observations[0].reviewIssues = ['invented_block_reason'];
    expect(() => parseStageOneAcceptanceCapture(unknownIssue)).toThrowError(
      '私有捕获文件格式无效',
    );

    const markdownMetadata = structuredClone(capture);
    markdownMetadata.model = 'qwen3.5-ocr\n# injected';
    expect(() => parseStageOneAcceptanceCapture(markdownMetadata)).toThrowError(
      '私有捕获文件格式无效',
    );

    const report = evaluateStageOneAcceptance({
      manifest,
      observations: capture.observations,
      manifestSha256: capture.manifestSha256,
      applicationVersion: capture.applicationVersion,
      gitCommit: capture.gitCommit,
      model: capture.model,
      region: capture.region,
      capturedAt: capture.capturedAt,
      generatedAt: '2026-08-01T12:30:00.000Z',
    });
    const markdown = renderStageOneAcceptanceMarkdown(report);
    expect(markdown).toContain('# 第一阶段核心可用版验收报告');
    expect(markdown).toContain('结论：通过');
    expect(markdown).toContain('30 张');
    expect(markdown).not.toContain('验收收件人');
    expect(markdown).not.toContain('13900000000');
    expect(markdown).not.toContain('广东省深圳市南山区验收路');
  });

  it('公开报告会重编私有数据集、案例和重复组标识', () => {
    const manifest = manifestWithCases(30);
    manifest.datasetId = 'customer-zhang';
    manifest.datasetVersion = 'order-batch-20260801';
    manifest.cases = manifest.cases.map((testCase, index) => ({
      ...testCase,
      id: `private-order-331471225243-${index}`,
      ...(testCase.duplicateGroup
        ? { duplicateGroup: index < 2 ? 'phone-13900000000' : 'phone-13800000000' }
        : {}),
    }));
    const observations = manifest.cases.map((testCase, index) => (
      passingObservation(testCase, index)
    ));

    const report = evaluateStageOneAcceptance({
      manifest,
      observations,
      manifestSha256: 'c'.repeat(64),
      applicationVersion: '0.2.25',
      gitCommit: 'b'.repeat(40),
      model: 'qwen3.5-ocr',
      region: 'cn-beijing',
      capturedAt: '2026-08-01T12:00:00.000Z',
    });
    const publicText = JSON.stringify(report) + renderStageOneAcceptanceMarkdown(report);

    expect(report.dataset).toMatchObject({
      id: 'dataset-cccccccccccc',
      version: 'manifest-cccccccccccc',
    });
    for (const privateValue of [
      'customer-zhang',
      'order-batch-20260801',
      'private-order-331471225243',
      'phone-13900000000',
      'phone-13800000000',
    ]) {
      expect(publicText).not.toContain(privateValue);
    }
  });
});

function manifestWithCases(count: number): StageOneAcceptanceManifest {
  return {
    schemaVersion: 1,
    datasetId: 'stage-one-private',
    datasetVersion: '2026-08-01',
    cases: Array.from({ length: count }, (_, index) => ({
      id: `case-${String(index + 1).padStart(3, '0')}`,
      screenshot: `images/case-${String(index + 1).padStart(3, '0')}.png`,
      screenshotSha256: index.toString(16).padStart(64, '0'),
      tags: index === 0 ? ['expanded', 'multi-item'] : ['collapsed'],
      ...(index < 4
        ? { duplicateGroup: `duplicate-order-${Math.floor(index / 2) + 1}` }
        : {}),
      expected: expectedOrder(index),
    })),
  };
}

function expectedOrder(index: number): StageOneAcceptanceManifest['cases'][number]['expected'] {
  const result = recognition(index);
  if (result.amountCents === null) throw new Error('合成验收订单缺少成交金额');
  return {
    orderNumber: result.orderNumber,
    phoneNormalized: result.phoneNormalized,
    amountCents: result.amountCents,
    alipayTransactionNumber: result.alipayTransactionNumber,
    buyerNickname: result.buyerNickname,
    recipient: result.recipient,
    addressOriginal: result.addressOriginal,
    addressNormalized: result.addressNormalized,
    province: result.province,
    city: result.city,
    district: result.district,
    orderedAtNormalized: result.orderedAtNormalized,
    paidAtNormalized: result.paidAtNormalized,
    productTotalCents: result.productTotalCents,
    shippingFeeCents: result.shippingFeeCents,
    platformTransactionStatus: result.platformTransactionStatus,
    fulfillmentStatus: result.fulfillmentStatus,
    items: result.items.map((item) => ({
      sourceTitle: item.sourceTitle,
      sourceSpec: item.sourceSpec,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
    })),
  };
}

function recognition(index: number): RecognitionResult {
  const sourceIndex = canonicalOrderIndex(index);
  return {
    platform: 'xianyu',
    sellerAccount: '验收卖家',
    orderNumber: `ORDER-ACCEPTANCE-${String(sourceIndex + 1).padStart(4, '0')}`,
    alipayTransactionNumber: `ALI-ACCEPTANCE-${String(sourceIndex + 1).padStart(4, '0')}`,
    buyerNickname: sourceIndex % 2 === 0 ? '验***家' : '',
    recipient: '验收收件人',
    phone: '13900000000',
    phoneNormalized: '13900000000',
    addressOriginal: '广东省深圳市南山区验收路1号',
    addressNormalized: '广东省深圳市南山区验收路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-08-01 10:00:00',
    orderedAtNormalized: '2026-08-01T10:00:00+08:00',
    paidAtOriginal: '2026-08-01 10:00:08',
    paidAtNormalized: '2026-08-01T10:00:08+08:00',
    productTotalCents: 1_600,
    shippingFeeCents: 0,
    amountCents: 1_600,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [
      {
        sourceTitle: '验收商品',
        sourceSpec: '标准款',
        unitPriceCents: 800,
        quantity: 2,
        quantityInferred: false,
      },
      ...(sourceIndex === 0
        ? [{
          sourceTitle: '验收商品二',
          sourceSpec: '加大款',
          unitPriceCents: 400,
          quantity: 1,
          quantityInferred: false,
        }]
        : []),
    ],
  };
}

function canonicalOrderIndex(index: number): number {
  if (index === 1) return 0;
  if (index === 3) return 2;
  return index;
}

function passingOutcome(
  index: number,
): StageOneAcceptanceObservation['outcome'] {
  return index === 1 || index === 3 ? 'duplicate_skipped' : 'imported';
}

function persistedOrderId(index: number): string {
  return `order-${canonicalOrderIndex(index)}`;
}

function passingObservation(
  testCase: StageOneAcceptanceManifest['cases'][number],
  index: number,
): StageOneAcceptanceObservation {
  return observation(
    testCase.id,
    testCase.screenshotSha256,
    recognition(index),
    passingOutcome(index),
    persistedOrderId(index),
  );
}

function observation(
  caseId: string,
  screenshotSha256: string,
  result: RecognitionResult,
  outcome: StageOneAcceptanceObservation['outcome'],
  persistedOrderId?: string,
  reviewIssues: StageOneAcceptanceObservation['reviewIssues'] = [],
): StageOneAcceptanceObservation {
  return {
    caseId,
    screenshotSha256,
    outcome,
    result,
    reviewIssues,
    ...(persistedOrderId ? { persistedOrderId } : {}),
  };
}
