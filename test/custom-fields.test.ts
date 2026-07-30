import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  OriginalOrder,
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';

const openedApplications: LocalApplication[] = [];

class SequenceRecognizer implements Recognizer {
  public constructor(private readonly results: RecognitionResult[]) {}

  public async recognize(_source: RecognizerSource): Promise<RecognitionAttempt> {
    const result = this.results.shift();
    if (!result) throw new Error('测试识别结果已用尽');
    return {
      result: structuredClone(result),
      evidences: [{
        provider: 'controlled',
        model: 'controlled',
        requestId: '',
        schemaVersion: 1,
        rawResponse: JSON.stringify(result),
      }],
    };
  }
}

function recognition(
  orderNumber: string,
  overrides: Partial<RecognitionResult> = {},
): RecognitionResult {
  return {
    platform: 'xianyu',
    sellerAccount: '自定义字段测试账号',
    orderNumber,
    alipayTransactionNumber: `ALI-${orderNumber}`,
    buyerNickname: '测***家',
    recipient: '林海棠',
    phone: '13800000001',
    phoneNormalized: '13800000001',
    addressOriginal: '广东省深圳市南山区海棠路1号',
    addressNormalized: '广东省深圳市南山区海棠路1号',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    orderedAtOriginal: '2026-07-30 09:30:00',
    orderedAtNormalized: '2026-07-30T09:30:00+08:00',
    paidAtOriginal: '2026-07-30 09:31:00',
    paidAtNormalized: '2026-07-30T09:31:00+08:00',
    productTotalCents: 3_600,
    shippingFeeCents: 0,
    amountCents: 3_600,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '海棠杯',
      sourceSpec: '红色 450ml',
      unitPriceCents: 1_800,
      quantity: 2,
      quantityInferred: false,
    }],
    ...overrides,
  };
}

async function createApplication(
  results: RecognitionResult[] = [],
): Promise<{ application: LocalApplication; dataDirectory: string; uploadDirectory: string }> {
  const testRoot = await mkdtemp(join(tmpdir(), 'xianyu-custom-fields-'));
  const dataDirectory = join(testRoot, '数据');
  const uploadDirectory = join(testRoot, '上传');
  await mkdir(uploadDirectory, { recursive: true });
  const application = new LocalApplication(new SequenceRecognizer([...results]));
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);
  return { application, dataDirectory, uploadDirectory };
}

async function importOrder(
  application: LocalApplication,
  uploadDirectory: string,
  orderNumber: string,
): Promise<OriginalOrder> {
  const sourcePath = join(uploadDirectory, `${orderNumber}.png`);
  await writeFile(sourcePath, Buffer.from(`synthetic-${orderNumber}`));
  const batch = await application.submitRecognitionBatch([sourcePath]);
  return application.confirmDraft(batch.drafts[0]);
}

function forgetApplication(application: LocalApplication): void {
  application.close();
  openedApplications.splice(openedApplications.indexOf(application), 1);
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('自定义字段库', () => {
  it('持久化往返六种字段类型、数据粒度、默认值和必填声明', async () => {
    const { application, dataDirectory } = await createApplication();
    const inputs = [
      {
        name: '内部备注',
        granularity: 'order' as const,
        type: 'text' as const,
        required: false,
        defaultValue: '待核对',
        options: [] as string[],
      },
      {
        name: '打包优先级',
        granularity: 'order' as const,
        type: 'number' as const,
        required: true,
        defaultValue: 2.5,
        options: [] as string[],
      },
      {
        name: '附加成本',
        granularity: 'order_item' as const,
        type: 'money' as const,
        required: false,
        defaultValue: 125,
        options: [] as string[],
      },
      {
        name: '承诺发货时间',
        granularity: 'order' as const,
        type: 'datetime' as const,
        required: false,
        defaultValue: '2026-08-01T09:30:00.000Z',
        options: [] as string[],
      },
      {
        name: '仓库',
        granularity: 'order_item' as const,
        type: 'single_select' as const,
        required: true,
        defaultValue: '华南仓',
        options: ['华南仓', '华东仓'],
      },
      {
        name: '标签',
        granularity: 'order' as const,
        type: 'multi_select' as const,
        required: false,
        defaultValue: ['易碎', '加急'],
        options: ['易碎', '加急', '礼品'],
      },
      {
        name: '已打包',
        granularity: 'order_item' as const,
        type: 'checkbox' as const,
        required: false,
        defaultValue: false,
        options: [] as string[],
      },
    ];

    const created = inputs.map((input) => application.createCustomFieldDefinition(input));
    expect(created.map(({ id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...field }) => field))
      .toEqual(inputs);

    forgetApplication(application);
    const reopened = new LocalApplication(new SequenceRecognizer([]));
    openedApplications.push(reopened);
    reopened.openDataDirectory(dataDirectory);

    const reopenedDefinitions = reopened.listCustomFieldDefinitions();
    expect(reopenedDefinitions).toHaveLength(created.length);
    expect(reopenedDefinitions).toEqual(expect.arrayContaining(created));
  });

  it('在创建字段和保存值时都按字段类型拒绝非法值', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-FIELD-VALIDATION-001'),
    ]);
    const order = await importOrder(application, uploadDirectory, 'XY-FIELD-VALIDATION-001');

    const invalidDefinitions: unknown[] = [
      { name: '文本', granularity: 'order', type: 'text', required: false, defaultValue: 1, options: [] },
      { name: '数字', granularity: 'order', type: 'number', required: false, defaultValue: Number.POSITIVE_INFINITY, options: [] },
      { name: '金额', granularity: 'order', type: 'money', required: false, defaultValue: 12.5, options: [] },
      { name: '时间', granularity: 'order', type: 'datetime', required: false, defaultValue: '下周一', options: [] },
      { name: '时间无时区', granularity: 'order', type: 'datetime', required: false, defaultValue: '2026-08-01T09:30:00', options: [] },
      { name: '不存在的日期', granularity: 'order', type: 'datetime', required: false, defaultValue: '2026-02-30T09:30:00+08:00', options: [] },
      { name: '单选', granularity: 'order', type: 'single_select', required: false, defaultValue: '不存在', options: ['A', 'B'] },
      { name: '多选', granularity: 'order', type: 'multi_select', required: false, defaultValue: ['A', 'A'], options: ['A', 'B'] },
      { name: '空白文本默认值', granularity: 'order', type: 'text', required: false, defaultValue: '   ', options: [] },
      { name: '空多选默认值', granularity: 'order', type: 'multi_select', required: false, defaultValue: [], options: ['A', 'B'] },
      { name: '勾选', granularity: 'order', type: 'checkbox', required: false, defaultValue: '是', options: [] },
    ];

    for (const invalid of invalidDefinitions) {
      expect(() => application.createCustomFieldDefinition(invalid as never)).toThrow();
    }

    const numberField = application.createCustomFieldDefinition({
      name: '复核次数',
      granularity: 'order',
      type: 'number',
      required: false,
      defaultValue: null,
      options: [],
    });
    expect(() => application.saveCustomFieldValues({
      orderId: order.id,
      orderValues: [{ definitionId: numberField.id, value: '三次' as never }],
      itemValues: [],
    })).toThrow();
    expect(application.getOrder(order.id).customFieldValues).toEqual([]);
  });

  it('按订单和商品粒度隔离值，且任一非法赋值会回滚整次保存', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-FIELD-TARGET-001', {
        items: [
          {
            sourceTitle: '海棠杯',
            sourceSpec: '红色',
            unitPriceCents: 1_800,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '杯盖',
            sourceSpec: '蓝色',
            unitPriceCents: 1_800,
            quantity: 1,
            quantityInferred: false,
          },
        ],
      }),
    ]);
    const order = await importOrder(application, uploadDirectory, 'XY-FIELD-TARGET-001');
    const [firstItem, secondItem] = order.items;
    const orderField = application.createCustomFieldDefinition({
      name: '客服备注',
      granularity: 'order',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    const itemField = application.createCustomFieldDefinition({
      name: '拣货位',
      granularity: 'order_item',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });

    application.saveCustomFieldValues({
      orderId: order.id,
      orderValues: [{ definitionId: orderField.id, value: '联系前电话确认' }],
      itemValues: [
        { definitionId: itemField.id, orderItemId: firstItem.id, value: 'A-01' },
        { definitionId: itemField.id, orderItemId: secondItem.id, value: 'B-02' },
      ],
    });

    const savedValues = application.getOrder(order.id).customFieldValues;
    expect(savedValues).toHaveLength(3);
    expect(savedValues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        definitionId: orderField.id,
        orderId: order.id,
        orderItemId: null,
        value: '联系前电话确认',
      }),
      expect.objectContaining({
        definitionId: itemField.id,
        orderId: null,
        orderItemId: firstItem.id,
        value: 'A-01',
      }),
      expect.objectContaining({
        definitionId: itemField.id,
        orderId: null,
        orderItemId: secondItem.id,
        value: 'B-02',
      }),
    ]));

    expect(() => application.saveCustomFieldValues({
      orderId: order.id,
      orderValues: [{ definitionId: orderField.id, value: '这一项不应落库' }],
      itemValues: [{
        definitionId: orderField.id,
        orderItemId: firstItem.id,
        value: '订单字段不能写到商品',
      }],
    })).toThrow();

    const valuesAfterFailedSave = application.getOrder(order.id).customFieldValues;
    expect(valuesAfterFailedSave).toHaveLength(3);
    expect(valuesAfterFailedSave).toEqual(expect.arrayContaining([
      expect.objectContaining({ definitionId: orderField.id, value: '联系前电话确认' }),
      expect.objectContaining({ definitionId: itemField.id, orderItemId: firstItem.id, value: 'A-01' }),
      expect.objectContaining({ definitionId: itemField.id, orderItemId: secondItem.id, value: 'B-02' }),
    ]));
  });

  it('保存事务按最终状态校验全部必填字段，空文本和空数组缺失而 false 与 0 有效', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-REQUIRED-FINAL-STATE-001', {
        items: [
          {
            sourceTitle: '商品 A',
            sourceSpec: '标准款',
            unitPriceCents: 1_800,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '商品 B',
            sourceSpec: '标准款',
            unitPriceCents: 1_800,
            quantity: 1,
            quantityInferred: false,
          },
        ],
      }),
    ]);
    const order = await importOrder(application, uploadDirectory, 'XY-REQUIRED-FINAL-STATE-001');
    const note = application.createCustomFieldDefinition({
      name: '必填备注',
      granularity: 'order',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    const checked = application.createCustomFieldDefinition({
      name: '已人工复核',
      granularity: 'order',
      type: 'checkbox',
      required: true,
      defaultValue: null,
      options: [],
    });
    const tags = application.createCustomFieldDefinition({
      name: '必填商品标签',
      granularity: 'order_item',
      type: 'multi_select',
      required: true,
      defaultValue: null,
      options: ['普通', '易碎'],
    });
    const pickingSequence = application.createCustomFieldDefinition({
      name: '必填拣货序号',
      granularity: 'order_item',
      type: 'number',
      required: true,
      defaultValue: null,
      options: [],
    });
    const [firstItem, secondItem] = order.items;

    expect(() => application.saveCustomFieldValues({
      orderId: order.id,
      orderValues: [
        { definitionId: note.id, value: '本次不应落库' },
        { definitionId: checked.id, value: false },
      ],
      itemValues: [
        { definitionId: tags.id, orderItemId: firstItem.id, value: ['普通'] },
        { definitionId: pickingSequence.id, orderItemId: firstItem.id, value: 0 },
      ],
    })).toThrow(/必填/);
    expect(application.getOrder(order.id).customFieldValues).toEqual([]);

    expect(() => application.saveCustomFieldValues({
      orderId: order.id,
      orderValues: [
        { definitionId: note.id, value: '   ' },
        { definitionId: checked.id, value: false },
      ],
      itemValues: order.items.flatMap((item) => [
        { definitionId: tags.id, orderItemId: item.id, value: [] },
        { definitionId: pickingSequence.id, orderItemId: item.id, value: 0 },
      ]),
    })).toThrow(/必填/);
    expect(application.getOrder(order.id).customFieldValues).toEqual([]);

    application.saveCustomFieldValues({
      orderId: order.id,
      orderValues: [
        { definitionId: note.id, value: '已复核' },
        { definitionId: checked.id, value: false },
      ],
      itemValues: [firstItem, secondItem].flatMap((item) => [
        { definitionId: tags.id, orderItemId: item.id, value: ['普通'] },
        { definitionId: pickingSequence.id, orderItemId: item.id, value: 0 },
      ]),
    });

    expect(application.getOrder(order.id).customFieldValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ definitionId: note.id, value: '已复核' }),
      expect.objectContaining({ definitionId: checked.id, value: false }),
      ...order.items.flatMap((item) => [
        expect.objectContaining({ definitionId: tags.id, orderItemId: item.id, value: ['普通'] }),
        expect.objectContaining({ definitionId: pickingSequence.id, orderItemId: item.id, value: 0 }),
      ]),
    ]));
  });

  it('人工确认草稿必须补齐订单及每件商品的必填自定义字段', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-MANUAL-REQUIRED-001', {
        items: [
          {
            sourceTitle: '商品 A',
            sourceSpec: '标准款',
            unitPriceCents: 1_800,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '商品 B',
            sourceSpec: '标准款',
            unitPriceCents: 1_800,
            quantity: 1,
            quantityInferred: false,
          },
        ],
      }),
    ]);
    const orderNote = application.createCustomFieldDefinition({
      name: '订单复核意见',
      granularity: 'order',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    const itemTag = application.createCustomFieldDefinition({
      name: '商品拣货标签',
      granularity: 'order_item',
      type: 'multi_select',
      required: true,
      defaultValue: null,
      options: ['普通', '易碎'],
    });
    const sourcePath = join(uploadDirectory, 'XY-MANUAL-REQUIRED-001.png');
    await writeFile(sourcePath, Buffer.from('synthetic-manual-required'));
    const batch = await application.submitRecognitionBatch([sourcePath]);
    const draft = batch.drafts[0];

    expect(() => application.confirmDraft(draft)).toThrow(/必填/);
    expect(() => application.confirmDraft(draft, {
      orderValues: [{ definitionId: orderNote.id, value: '已核对' }],
      itemValues: [
        { definitionId: itemTag.id, draftItemId: draft.items[0].id, value: ['普通'] },
        { definitionId: itemTag.id, draftItemId: draft.items[1].id, value: [] },
      ],
    })).toThrow(/必填/);

    const confirmed = application.confirmDraft(draft, {
      orderValues: [{ definitionId: orderNote.id, value: '已核对' }],
      itemValues: draft.items.map((item) => ({
        definitionId: itemTag.id,
        draftItemId: item.id,
        value: ['普通'],
      })),
    });
    expect(application.getOrder(confirmed.id).customFieldValues).toHaveLength(3);
  });

  it('订单更新新增商品时必须补齐其必填字段，并保留匹配旧商品的原值', async () => {
    const originalItem = {
      sourceTitle: '商品 A',
      sourceSpec: '标准款',
      unitPriceCents: 1_800,
      quantity: 2,
      quantityInferred: false,
    };
    const addedItem = {
      sourceTitle: '商品 B',
      sourceSpec: '新增款',
      unitPriceCents: 600,
      quantity: 1,
      quantityInferred: false,
    };
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-UPDATE-REQUIRED-NEW-ITEM-001', { items: [originalItem] }),
      recognition('XY-UPDATE-REQUIRED-NEW-ITEM-001', {
        recipient: '更新后的收件人',
        productTotalCents: 4_200,
        amountCents: 4_200,
        items: [originalItem, addedItem],
      }),
    ]);
    const original = await importOrder(
      application,
      uploadDirectory,
      'XY-UPDATE-REQUIRED-NEW-ITEM-001',
    );
    const location = application.createCustomFieldDefinition({
      name: '更新必填库位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    application.saveCustomFieldValues({
      orderId: original.id,
      orderValues: [],
      itemValues: [{
        definitionId: location.id,
        orderItemId: original.items[0].id,
        value: 'A-01',
      }],
    });
    const updatePath = join(uploadDirectory, 'XY-UPDATE-REQUIRED-NEW-ITEM-001-update.png');
    await writeFile(updatePath, Buffer.from('synthetic-required-new-item-update'));
    const updateBatch = await application.submitRecognitionBatch([updatePath]);
    application.saveDraftOrderMatch(
      updateBatch.drafts[0].id,
      original.id,
      ['order_content_changed'],
      updateBatch.drafts[0],
    );
    const review = application.getDraftReview(updateBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');
    expect(review.customFieldValues).toEqual([
      expect.objectContaining({
        definitionId: location.id,
        orderItemId: original.items[0].id,
        value: 'A-01',
      }),
    ]);

    expect(() => application.confirmOrderUpdate(
      review.draft,
      review.expectedRevision,
    )).toThrow(/必填/);
    expect(application.getOrder(original.id)).toMatchObject({
      order: { revision: original.revision, items: [{ id: original.items[0].id }] },
      customFieldValues: [expect.objectContaining({
        orderItemId: original.items[0].id,
        value: 'A-01',
      })],
    });

    application.confirmOrderUpdate(review.draft, review.expectedRevision, {
      orderValues: [],
      itemValues: [{
        definitionId: location.id,
        draftItemId: review.draft.items[1].id,
        value: 'B-02',
      }],
    });

    const updated = application.getOrder(original.id);
    expect(updated.order.items[0].id).toBe(original.items[0].id);
    expect(updated.order.items[1].id).not.toBe(original.items[0].id);
    expect(updated.customFieldValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderItemId: original.items[0].id, value: 'A-01' }),
      expect.objectContaining({ orderItemId: updated.order.items[1].id, value: 'B-02' }),
    ]));
  });

  it('订单更新也会拦截此前自动入库留下的匹配旧商品必填空值', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-UPDATE-REQUIRED-LEGACY-001'),
      recognition('XY-UPDATE-REQUIRED-LEGACY-001', {
        recipient: '更新后的收件人',
      }),
    ]);
    const location = application.createCustomFieldDefinition({
      name: '历史缺值库位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    const sourcePath = join(uploadDirectory, 'XY-UPDATE-REQUIRED-LEGACY-001.png');
    await writeFile(sourcePath, Buffer.from('synthetic-required-legacy'));
    const firstBatch = await application.submitRecognitionBatch([sourcePath]);
    const original = application.confirmDraft(firstBatch.drafts[0], undefined, {
      enforceRequiredItemFields: false,
    });
    expect(application.getOrder(original.id).customFieldValues).toEqual([]);

    const updatePath = join(uploadDirectory, 'XY-UPDATE-REQUIRED-LEGACY-001-update.png');
    await writeFile(updatePath, Buffer.from('synthetic-required-legacy-update'));
    const updateBatch = await application.submitRecognitionBatch([updatePath]);
    application.saveDraftOrderMatch(
      updateBatch.drafts[0].id,
      original.id,
      ['order_content_changed'],
      updateBatch.drafts[0],
    );
    const review = application.getDraftReview(updateBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');

    expect(() => application.confirmOrderUpdate(
      review.draft,
      review.expectedRevision,
    )).toThrow(/必填/);
    expect(application.getOrder(original.id).order.revision).toBe(original.revision);

    application.confirmOrderUpdate(review.draft, review.expectedRevision, {
      orderValues: [],
      itemValues: [{
        definitionId: location.id,
        draftItemId: review.draft.items[0].id,
        value: 'A-09',
      }],
    });
    const updated = application.getOrder(original.id);
    expect(updated.order.items[0].id).toBe(original.items[0].id);
    expect(updated.customFieldValues).toEqual([
      expect.objectContaining({ orderItemId: original.items[0].id, value: 'A-09' }),
    ]);
  });

  it('校对恢复成等价内容时仍会原子保存用于补齐必填字段的自定义值', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-EQUIVALENT-CUSTOM-VALUE-001'),
      recognition('XY-EQUIVALENT-CUSTOM-VALUE-001'),
    ]);
    const original = await importOrder(
      application,
      uploadDirectory,
      'XY-EQUIVALENT-CUSTOM-VALUE-001',
    );
    const obsoleteNote = application.createCustomFieldDefinition({
      name: '等价来源待清空备注',
      granularity: 'order',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    application.saveCustomFieldValues({
      orderId: original.id,
      orderValues: [{ definitionId: obsoleteNote.id, value: '待清空' }],
      itemValues: [],
    });
    const location = application.createCustomFieldDefinition({
      name: '等价来源补填库位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    const equivalentPath = join(uploadDirectory, 'XY-EQUIVALENT-CUSTOM-VALUE-001-again.png');
    await writeFile(equivalentPath, Buffer.from('synthetic-equivalent-custom-value'));
    const equivalentBatch = await application.submitRecognitionBatch([equivalentPath]);
    application.saveDraftOrderMatch(
      equivalentBatch.drafts[0].id,
      original.id,
      ['duplicate_order'],
      equivalentBatch.drafts[0],
    );
    const review = application.getDraftReview(equivalentBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');
    expect(review.changes).toEqual([]);

    const outcome = application.confirmOrderUpdate(review.draft, review.expectedRevision, {
      orderValues: [{ definitionId: obsoleteNote.id, value: null }],
      itemValues: [{
        definitionId: location.id,
        draftItemId: review.draft.items[0].id,
        value: 'A-11',
      }],
    });

    expect(outcome).toMatchObject({
      resolution: 'equivalent_order',
      order: { id: original.id, revision: original.revision },
    });
    expect(application.getOrder(original.id).customFieldValues).toEqual([
      expect.objectContaining({ orderItemId: original.items[0].id, value: 'A-11' }),
    ]);
  });

  it('等价订单更新即使调用方未提交自定义值也不会绕过最终必填校验', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-EQUIVALENT-REQUIRED-GUARD-001'),
      recognition('XY-EQUIVALENT-REQUIRED-GUARD-001'),
    ]);
    application.createCustomFieldDefinition({
      name: '等价更新必填库位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    const firstPath = join(uploadDirectory, 'XY-EQUIVALENT-REQUIRED-GUARD-001-first.png');
    await writeFile(firstPath, Buffer.from('synthetic-equivalent-required-first'));
    const firstBatch = await application.submitRecognitionBatch([firstPath]);
    const original = application.confirmDraft(firstBatch.drafts[0], undefined, {
      enforceRequiredItemFields: false,
    });

    const repeatedPath = join(uploadDirectory, 'XY-EQUIVALENT-REQUIRED-GUARD-001-again.png');
    await writeFile(repeatedPath, Buffer.from('synthetic-equivalent-required-again'));
    const repeatedBatch = await application.submitRecognitionBatch([repeatedPath]);
    application.saveDraftOrderMatch(
      repeatedBatch.drafts[0].id,
      original.id,
      ['duplicate_order'],
      repeatedBatch.drafts[0],
    );
    const review = application.getDraftReview(repeatedBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');
    expect(review.changes).toEqual([]);

    expect(() => application.confirmOrderUpdate(
      review.draft,
      review.expectedRevision,
    )).toThrow(/必填/);
    expect(application.getDraft(review.draft.id).status).toBe('awaiting_review');
  });

  it('订单更新会按显式 null 清空已有订单级自定义值', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-UPDATE-CLEAR-ORDER-FIELD-001'),
      recognition('XY-UPDATE-CLEAR-ORDER-FIELD-001', {
        recipient: '更新后的收件人',
      }),
    ]);
    const original = await importOrder(
      application,
      uploadDirectory,
      'XY-UPDATE-CLEAR-ORDER-FIELD-001',
    );
    const note = application.createCustomFieldDefinition({
      name: '待清空订单备注',
      granularity: 'order',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    application.saveCustomFieldValues({
      orderId: original.id,
      orderValues: [{ definitionId: note.id, value: '旧备注' }],
      itemValues: [],
    });
    const updatePath = join(uploadDirectory, 'XY-UPDATE-CLEAR-ORDER-FIELD-001-update.png');
    await writeFile(updatePath, Buffer.from('synthetic-clear-order-field-update'));
    const updateBatch = await application.submitRecognitionBatch([updatePath]);
    application.saveDraftOrderMatch(
      updateBatch.drafts[0].id,
      original.id,
      ['order_content_changed'],
      updateBatch.drafts[0],
    );
    const review = application.getDraftReview(updateBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');

    application.confirmOrderUpdate(review.draft, review.expectedRevision, {
      orderValues: [{ definitionId: note.id, value: null }],
      itemValues: [],
    });

    expect(application.getOrder(original.id).customFieldValues).toEqual([]);
  });

  it('订单更新会按显式 null 清空匹配商品的已有商品级自定义值', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-UPDATE-CLEAR-ITEM-FIELD-001'),
      recognition('XY-UPDATE-CLEAR-ITEM-FIELD-001', {
        recipient: '更新后的收件人',
      }),
    ]);
    const original = await importOrder(
      application,
      uploadDirectory,
      'XY-UPDATE-CLEAR-ITEM-FIELD-001',
    );
    const location = application.createCustomFieldDefinition({
      name: '待清空商品库位',
      granularity: 'order_item',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    application.saveCustomFieldValues({
      orderId: original.id,
      orderValues: [],
      itemValues: [{
        definitionId: location.id,
        orderItemId: original.items[0].id,
        value: 'A-13',
      }],
    });
    const updatePath = join(uploadDirectory, 'XY-UPDATE-CLEAR-ITEM-FIELD-001-update.png');
    await writeFile(updatePath, Buffer.from('synthetic-clear-item-field-update'));
    const updateBatch = await application.submitRecognitionBatch([updatePath]);
    application.saveDraftOrderMatch(
      updateBatch.drafts[0].id,
      original.id,
      ['order_content_changed'],
      updateBatch.drafts[0],
    );
    const review = application.getDraftReview(updateBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');

    application.confirmOrderUpdate(review.draft, review.expectedRevision, {
      orderValues: [],
      itemValues: [{
        definitionId: location.id,
        draftItemId: review.draft.items[0].id,
        value: null,
      }],
    });

    const updated = application.getOrder(original.id);
    expect(updated.order.items[0].id).toBe(original.items[0].id);
    expect(updated.customFieldValues).toEqual([]);
  });

  it('订单更新不会允许显式 null 清空必填订单或商品自定义值', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-UPDATE-CLEAR-REQUIRED-001'),
      recognition('XY-UPDATE-CLEAR-REQUIRED-001', {
        recipient: '更新后的收件人',
      }),
    ]);
    const original = await importOrder(
      application,
      uploadDirectory,
      'XY-UPDATE-CLEAR-REQUIRED-001',
    );
    const orderNote = application.createCustomFieldDefinition({
      name: '不可清空订单备注',
      granularity: 'order',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    const itemLocation = application.createCustomFieldDefinition({
      name: '不可清空商品库位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: null,
      options: [],
    });
    application.saveCustomFieldValues({
      orderId: original.id,
      orderValues: [{ definitionId: orderNote.id, value: '保留订单值' }],
      itemValues: [{
        definitionId: itemLocation.id,
        orderItemId: original.items[0].id,
        value: '保留商品值',
      }],
    });
    const before = application.getOrder(original.id);
    const updatePath = join(uploadDirectory, 'XY-UPDATE-CLEAR-REQUIRED-001-update.png');
    await writeFile(updatePath, Buffer.from('synthetic-clear-required-update'));
    const updateBatch = await application.submitRecognitionBatch([updatePath]);
    application.saveDraftOrderMatch(
      updateBatch.drafts[0].id,
      original.id,
      ['order_content_changed'],
      updateBatch.drafts[0],
    );
    const review = application.getDraftReview(updateBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');

    expect(() => application.confirmOrderUpdate(review.draft, review.expectedRevision, {
      orderValues: [{ definitionId: orderNote.id, value: null }],
      itemValues: [{
        definitionId: itemLocation.id,
        draftItemId: review.draft.items[0].id,
        value: null,
      }],
    })).toThrow(/必填/);

    const after = application.getOrder(original.id);
    expect(after.order.revision).toBe(before.order.revision);
    expect(after.customFieldValues).toEqual(before.customFieldValues);
  });

  it('字段创建在既有订单之后或之前时，都为相应粒度生成默认值', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-DEFAULT-EXISTING', {
        items: [
          {
            sourceTitle: '商品 A',
            sourceSpec: '标准款',
            unitPriceCents: 1_800,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '商品 B',
            sourceSpec: '标准款',
            unitPriceCents: 1_800,
            quantity: 1,
            quantityInferred: false,
          },
        ],
      }),
      recognition('XY-DEFAULT-NEW'),
    ]);
    const existingOrder = await importOrder(
      application,
      uploadDirectory,
      'XY-DEFAULT-EXISTING',
    );
    const orderField = application.createCustomFieldDefinition({
      name: '处理阶段',
      granularity: 'order',
      type: 'single_select',
      required: true,
      defaultValue: '待处理',
      options: ['待处理', '已完成'],
    });
    const itemField = application.createCustomFieldDefinition({
      name: '需要贴标',
      granularity: 'order_item',
      type: 'checkbox',
      required: false,
      defaultValue: true,
      options: [],
    });

    const existingValues = application.getOrder(existingOrder.id).customFieldValues;
    expect(existingValues).toHaveLength(1 + existingOrder.items.length);
    expect(existingValues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        definitionId: orderField.id,
        orderId: existingOrder.id,
        orderItemId: null,
        value: '待处理',
      }),
      ...existingOrder.items.map((item) => expect.objectContaining({
        definitionId: itemField.id,
        orderId: null,
        orderItemId: item.id,
        value: true,
      })),
    ]));

    const newOrder = await importOrder(application, uploadDirectory, 'XY-DEFAULT-NEW');
    const newValues = application.getOrder(newOrder.id).customFieldValues;
    expect(newValues).toHaveLength(2);
    expect(newValues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        definitionId: orderField.id,
        orderId: newOrder.id,
        orderItemId: null,
        value: '待处理',
      }),
      expect.objectContaining({
        definitionId: itemField.id,
        orderId: null,
        orderItemId: newOrder.items[0].id,
        value: true,
      }),
    ]));
  });

  it('订单更新按完整商品事实保留标识，同标题规格的不同价格商品交换顺序也不会串值', async () => {
    const lowerPriceItem = {
      sourceTitle: '同款收纳盒',
      sourceSpec: '标准款',
      unitPriceCents: 1_200,
      quantity: 1,
      quantityInferred: false,
    };
    const higherPriceItem = {
      ...lowerPriceItem,
      unitPriceCents: 2_400,
    };
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-ITEM-FACT-MATCH-001', {
        items: [lowerPriceItem, higherPriceItem],
      }),
      recognition('XY-ITEM-FACT-MATCH-001', {
        recipient: '更新后的收件人',
        items: [higherPriceItem, lowerPriceItem],
      }),
    ]);
    const original = await importOrder(
      application,
      uploadDirectory,
      'XY-ITEM-FACT-MATCH-001',
    );
    const location = application.createCustomFieldDefinition({
      name: '交换顺序测试库位',
      granularity: 'order_item',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    application.saveCustomFieldValues({
      orderId: original.id,
      orderValues: [],
      itemValues: [
        { definitionId: location.id, orderItemId: original.items[0].id, value: 'LOW' },
        { definitionId: location.id, orderItemId: original.items[1].id, value: 'HIGH' },
      ],
    });

    const updatePath = join(uploadDirectory, 'XY-ITEM-FACT-MATCH-001-update.png');
    await writeFile(updatePath, Buffer.from('synthetic-fact-match-update'));
    const updateBatch = await application.submitRecognitionBatch([updatePath]);
    application.saveDraftOrderMatch(
      updateBatch.drafts[0].id,
      original.id,
      ['order_content_changed'],
      updateBatch.drafts[0],
    );
    const review = application.getDraftReview(updateBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');

    application.confirmOrderUpdate(review.draft, review.expectedRevision);

    const details = application.getOrder(original.id);
    expect(details.order.items.map(({ id, unitPriceCents }) => ({ id, unitPriceCents }))).toEqual([
      { id: original.items[1].id, unitPriceCents: 2_400 },
      { id: original.items[0].id, unitPriceCents: 1_200 },
    ]);
    expect(details.customFieldValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderItemId: original.items[0].id, value: 'LOW' }),
      expect.objectContaining({ orderItemId: original.items[1].id, value: 'HIGH' }),
    ]));
  });

  it('订单更新中标题轻微变化但规格和价格双侧唯一时仍保留商品自定义值', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-ITEM-TITLE-CHANGE-001', {
        items: [{
          sourceTitle: '古风娃鞋白模',
          sourceSpec: '05M 白模鞋',
          unitPriceCents: 800,
          quantity: 1,
          quantityInferred: true,
        }],
      }),
      recognition('XY-ITEM-TITLE-CHANGE-001', {
        recipient: '更新后的收件人',
        items: [{
          sourceTitle: '古风娃鞋（白模）',
          sourceSpec: '05M 白模鞋',
          unitPriceCents: 800,
          quantity: 1,
          quantityInferred: true,
        }],
      }),
    ]);
    const original = await importOrder(
      application,
      uploadDirectory,
      'XY-ITEM-TITLE-CHANGE-001',
    );
    const location = application.createCustomFieldDefinition({
      name: '标题变化测试库位',
      granularity: 'order_item',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    application.saveCustomFieldValues({
      orderId: original.id,
      orderValues: [],
      itemValues: [{
        definitionId: location.id,
        orderItemId: original.items[0].id,
        value: 'A-05',
      }],
    });

    const updatePath = join(uploadDirectory, 'XY-ITEM-TITLE-CHANGE-001-update.png');
    await writeFile(updatePath, Buffer.from('synthetic-title-change-update'));
    const updateBatch = await application.submitRecognitionBatch([updatePath]);
    application.saveDraftOrderMatch(
      updateBatch.drafts[0].id,
      original.id,
      ['order_content_changed'],
      updateBatch.drafts[0],
    );
    const review = application.getDraftReview(updateBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');

    application.confirmOrderUpdate(review.draft, review.expectedRevision);

    const details = application.getOrder(original.id);
    expect(details.order.items[0].id).toBe(original.items[0].id);
    expect(details.customFieldValues).toEqual([
      expect.objectContaining({ orderItemId: original.items[0].id, value: 'A-05' }),
    ]);
  });

  it('订单更新中商品事实双侧均不唯一时不按位置猜测，而是为草稿商品分配新标识', async () => {
    const ambiguousItem = {
      sourceTitle: '无规格同款赠品',
      sourceSpec: '',
      unitPriceCents: 100,
      quantity: 1,
      quantityInferred: true,
    };
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-ITEM-AMBIGUOUS-001', {
        productTotalCents: 200,
        amountCents: 200,
        items: [ambiguousItem, ambiguousItem],
      }),
      recognition('XY-ITEM-AMBIGUOUS-001', {
        recipient: '更新后的收件人',
        productTotalCents: 200,
        amountCents: 200,
        items: [ambiguousItem, ambiguousItem],
      }),
    ]);
    const original = await importOrder(
      application,
      uploadDirectory,
      'XY-ITEM-AMBIGUOUS-001',
    );
    const note = application.createCustomFieldDefinition({
      name: '歧义商品备注',
      granularity: 'order_item',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    application.saveCustomFieldValues({
      orderId: original.id,
      orderValues: [],
      itemValues: [
        { definitionId: note.id, orderItemId: original.items[0].id, value: '原第一行' },
        { definitionId: note.id, orderItemId: original.items[1].id, value: '原第二行' },
      ],
    });

    const updatePath = join(uploadDirectory, 'XY-ITEM-AMBIGUOUS-001-update.png');
    await writeFile(updatePath, Buffer.from('synthetic-ambiguous-item-update'));
    const updateBatch = await application.submitRecognitionBatch([updatePath]);
    application.saveDraftOrderMatch(
      updateBatch.drafts[0].id,
      original.id,
      ['order_content_changed'],
      updateBatch.drafts[0],
    );
    const review = application.getDraftReview(updateBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');

    application.confirmOrderUpdate(review.draft, review.expectedRevision);

    const updated = application.getOrder(original.id);
    expect(updated.order.items.every((item) => (
      !original.items.some((originalItem) => originalItem.id === item.id)
    ))).toBe(true);
    expect(updated.customFieldValues).toEqual([]);
  });

  it('订单更新先按商品事实保留旧标识，插入到首位的新商品不会串用旧商品自定义值', async () => {
    const originalItems = [
      {
        sourceTitle: '商品 A',
        sourceSpec: '红色',
        unitPriceCents: 1_200,
        quantity: 1,
        quantityInferred: false,
      },
      {
        sourceTitle: '商品 B',
        sourceSpec: '蓝色',
        unitPriceCents: 2_400,
        quantity: 1,
        quantityInferred: false,
      },
    ];
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-ITEM-ID-UPDATE-001', { items: originalItems }),
      recognition('XY-ITEM-ID-UPDATE-001', {
        recipient: '更新后的收件人',
        items: [
          {
            sourceTitle: '商品 C',
            sourceSpec: '绿色',
            unitPriceCents: 600,
            quantity: 1,
            quantityInferred: false,
          },
          ...originalItems,
        ],
      }),
      recognition('XY-ITEM-ID-UPDATE-001', {
        recipient: '再次更新后的收件人',
        items: [
          {
            sourceTitle: '商品 D',
            sourceSpec: '紫色',
            unitPriceCents: 900,
            quantity: 1,
            quantityInferred: false,
          },
          ...originalItems,
        ],
      }),
    ]);
    const original = await importOrder(application, uploadDirectory, 'XY-ITEM-ID-UPDATE-001');
    const location = application.createCustomFieldDefinition({
      name: '拣货位',
      granularity: 'order_item',
      type: 'text',
      required: true,
      defaultValue: '待分配',
      options: [],
    });
    application.saveCustomFieldValues({
      orderId: original.id,
      orderValues: [],
      itemValues: [
        { definitionId: location.id, orderItemId: original.items[0].id, value: 'A-01' },
        { definitionId: location.id, orderItemId: original.items[1].id, value: 'B-02' },
      ],
    });

    const changedPath = join(uploadDirectory, 'XY-ITEM-ID-UPDATE-001-changed.png');
    await writeFile(changedPath, Buffer.from('synthetic-update'));
    const changedBatch = await application.submitRecognitionBatch([changedPath]);
    application.saveDraftOrderMatch(
      changedBatch.drafts[0].id,
      original.id,
      ['order_content_changed'],
      changedBatch.drafts[0],
    );
    const review = application.getDraftReview(changedBatch.drafts[0].id);
    if (review.kind !== 'order_update') throw new Error('预期订单更新校对');

    const firstUpdate = application.confirmOrderUpdate(review.draft, review.expectedRevision);

    const details = application.getOrder(original.id);
    const [itemC, itemA, itemB] = details.order.items;
    expect(itemA.id).toBe(original.items[0].id);
    expect(itemB.id).toBe(original.items[1].id);
    expect(itemC.id).not.toBe(original.items[0].id);
    expect(itemC.id).not.toBe(original.items[1].id);
    expect(details.customFieldValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderItemId: itemC.id, value: '待分配' }),
      expect.objectContaining({ orderItemId: itemA.id, value: 'A-01' }),
      expect.objectContaining({ orderItemId: itemB.id, value: 'B-02' }),
    ]));

    application.saveCustomFieldValues({
      orderId: original.id,
      orderValues: [],
      itemValues: [{ definitionId: location.id, orderItemId: itemC.id, value: 'C-03' }],
    });
    const replacementPath = join(uploadDirectory, 'XY-ITEM-ID-UPDATE-001-replacement.png');
    await writeFile(replacementPath, Buffer.from('synthetic-replacement-update'));
    const replacementBatch = await application.submitRecognitionBatch([replacementPath]);
    application.saveDraftOrderMatch(
      replacementBatch.drafts[0].id,
      original.id,
      ['order_content_changed'],
      replacementBatch.drafts[0],
    );
    const replacementReview = application.getDraftReview(replacementBatch.drafts[0].id);
    if (replacementReview.kind !== 'order_update') throw new Error('预期替换商品的订单更新校对');
    expect(replacementReview.expectedRevision).toBe(firstUpdate.order.revision);
    application.confirmOrderUpdate(replacementReview.draft, replacementReview.expectedRevision);

    const replacementDetails = application.getOrder(original.id);
    const [itemD, preservedA, preservedB] = replacementDetails.order.items;
    expect(preservedA.id).toBe(itemA.id);
    expect(preservedB.id).toBe(itemB.id);
    expect(itemD.id).not.toBe(itemC.id);
    expect(replacementDetails.customFieldValues).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderItemId: itemD.id, value: '待分配' }),
      expect.objectContaining({ orderItemId: preservedA.id, value: 'A-01' }),
      expect.objectContaining({ orderItemId: preservedB.id, value: 'B-02' }),
    ]));
    expect(replacementDetails.customFieldValues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'C-03' }),
    ]));
  });

  it('保存自定义值不修改内置订单事实、来源快照或订单版本', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-INDEPENDENT-001'),
    ]);
    const order = await importOrder(application, uploadDirectory, 'XY-INDEPENDENT-001');
    const field = application.createCustomFieldDefinition({
      name: '出库备注',
      granularity: 'order',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    const before = application.getOrder(order.id);

    application.saveCustomFieldValues({
      orderId: order.id,
      orderValues: [{ definitionId: field.id, value: '周五前寄出' }],
      itemValues: [],
    });
    const after = application.getOrder(order.id);

    expect(after.order).toEqual(before.order);
    expect(after.order.revision).toBe(before.order.revision);
    expect(after.sourceScreenshot).toEqual(before.sourceScreenshot);
    expect(after.sourceSnapshot).toEqual(before.sourceSnapshot);
    expect(after.sources).toEqual(before.sources);
    expect(after.changeEvents).toEqual(before.changeEvents);
    expect(after.customFieldDefinitions).toContainEqual(field);
    expect(after.customFieldValues).toEqual([
      expect.objectContaining({ definitionId: field.id, value: '周五前寄出' }),
    ]);
  });

  it('订单粒度自定义字段只参与订单工作台的筛选和排序', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-ORDER-QUERY-001'),
      recognition('XY-ORDER-QUERY-002'),
      recognition('XY-ORDER-QUERY-003'),
    ]);
    const orders: OriginalOrder[] = [];
    for (const orderNumber of [
      'XY-ORDER-QUERY-001',
      'XY-ORDER-QUERY-002',
      'XY-ORDER-QUERY-003',
    ]) {
      orders.push(await importOrder(application, uploadDirectory, orderNumber));
    }
    const priority = application.createCustomFieldDefinition({
      name: '处理优先级',
      granularity: 'order',
      type: 'number',
      required: false,
      defaultValue: null,
      options: [],
    });
    [30, 10, 20].forEach((value, index) => application.saveCustomFieldValues({
      orderId: orders[index].id,
      orderValues: [{ definitionId: priority.id, value }],
      itemValues: [],
    }));

    expect(application.queryOrders({
      customFieldFilter: { definitionId: priority.id, value: 20 },
    }).orders.map((order) => order.orderNumber)).toEqual(['XY-ORDER-QUERY-003']);
    expect(application.queryOrders({
      customFieldSort: { definitionId: priority.id, direction: 'asc' },
    }).orders.map((order) => order.orderNumber)).toEqual([
      'XY-ORDER-QUERY-002',
      'XY-ORDER-QUERY-003',
      'XY-ORDER-QUERY-001',
    ]);
  });

  it('多选值始终按定义选项顺序保存，筛选不受输入集合顺序影响', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-MULTI-SELECT-ORDER-001'),
    ]);
    const order = await importOrder(application, uploadDirectory, 'XY-MULTI-SELECT-ORDER-001');
    const labels = application.createCustomFieldDefinition({
      name: '处理标签',
      granularity: 'order',
      type: 'multi_select',
      required: false,
      defaultValue: null,
      options: ['易碎', '加急', '礼品'],
    });

    application.saveCustomFieldValues({
      orderId: order.id,
      orderValues: [{ definitionId: labels.id, value: ['加急', '易碎'] }],
      itemValues: [],
    });

    expect(application.getOrder(order.id).customFieldValues).toEqual([
      expect.objectContaining({ definitionId: labels.id, value: ['易碎', '加急'] }),
    ]);
    expect(application.queryOrders({
      customFieldFilter: { definitionId: labels.id, value: ['加急', '易碎'] },
    }).orders.map((candidate) => candidate.id)).toEqual([order.id]);
    expect(application.queryOrders({
      customFieldFilter: { definitionId: labels.id, value: ['易碎'] },
    }).orders.map((candidate) => candidate.id)).toEqual([order.id]);
    expect(application.queryOrders({
      customFieldFilter: { definitionId: labels.id, value: ['易碎', '礼品'] },
    }).orders).toEqual([]);
  });

  it('商品粒度自定义字段在独立商品查询中筛选和排序', async () => {
    const { application, uploadDirectory } = await createApplication([
      recognition('XY-ITEM-QUERY-001', {
        items: [
          {
            sourceTitle: '商品 A',
            sourceSpec: '标准款',
            unitPriceCents: 1_200,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '商品 B',
            sourceSpec: '标准款',
            unitPriceCents: 1_200,
            quantity: 1,
            quantityInferred: false,
          },
          {
            sourceTitle: '商品 C',
            sourceSpec: '标准款',
            unitPriceCents: 1_200,
            quantity: 1,
            quantityInferred: false,
          },
        ],
      }),
    ]);
    const order = await importOrder(application, uploadDirectory, 'XY-ITEM-QUERY-001');
    const pickingSequence = application.createCustomFieldDefinition({
      name: '拣货顺序',
      granularity: 'order_item',
      type: 'number',
      required: false,
      defaultValue: null,
      options: [],
    });
    const picked = application.createCustomFieldDefinition({
      name: '已拣货',
      granularity: 'order_item',
      type: 'checkbox',
      required: false,
      defaultValue: null,
      options: [],
    });
    const labels = application.createCustomFieldDefinition({
      name: '商品标签',
      granularity: 'order_item',
      type: 'multi_select',
      required: false,
      defaultValue: null,
      options: ['易碎', '加急', '礼品'],
    });
    const labelsByPosition = [
      ['易碎', '加急'],
      ['易碎'],
      ['礼品'],
    ];
    [30, 10, 20].forEach((value, index) => application.saveCustomFieldValues({
      orderId: order.id,
      orderValues: [],
      itemValues: [
        {
          definitionId: pickingSequence.id,
          orderItemId: order.items[index].id,
          value,
        },
        {
          definitionId: picked.id,
          orderItemId: order.items[index].id,
          value: index !== 1,
        },
        {
          definitionId: labels.id,
          orderItemId: order.items[index].id,
          value: labelsByPosition[index],
        },
      ],
    }));

    expect(application.queryOrderItems({
      customFieldFilter: { definitionId: picked.id, value: true },
    }).items.map((item) => item.id)).toEqual([
      order.items[0].id,
      order.items[2].id,
    ]);
    expect(application.queryOrderItems({
      customFieldSort: { definitionId: pickingSequence.id, direction: 'asc' },
    }).items.map((item) => item.id)).toEqual([
      order.items[1].id,
      order.items[2].id,
      order.items[0].id,
    ]);
    expect(application.queryOrderItems({
      customFieldFilter: { definitionId: labels.id, value: ['易碎'] },
    }).items.map((item) => item.id)).toEqual([
      order.items[0].id,
      order.items[1].id,
    ]);
    expect(application.queryOrderItems({
      customFieldFilter: { definitionId: labels.id, value: ['易碎', '加急'] },
    }).items.map((item) => item.id)).toEqual([order.items[0].id]);
  });
});
