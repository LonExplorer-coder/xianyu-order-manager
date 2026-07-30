import { describe, expect, it } from 'vitest';

import type { OrderSummary } from '../src/core/contracts';
import type {
  CustomFieldDefinition,
  CustomFieldValueRecord,
} from '../src/core/custom-fields';
import type { OrderItemWorkbenchItem } from '../src/core/order-workbench';
import type { QuantitySource } from '../src/core/quantity-source';
import {
  availableTableFields,
  createCustomFieldValueIndex,
  fieldReferenceKey,
  normalizeCreateTableTemplateInput,
  normalizeUpdateTableTemplateInput,
  projectOrderItemTableCell,
  projectOrderTableCell,
  tableTemplateNameKey,
  type TableTemplateColumn,
} from '../src/core/table-templates';

const orderField: CustomFieldDefinition = {
  id: 'field-order-note',
  name: '客服备注',
  granularity: 'order',
  type: 'text',
  required: false,
  defaultValue: null,
  options: [],
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
};

const itemField: CustomFieldDefinition = {
  id: 'field-item-bin',
  name: '拣货位',
  granularity: 'order_item',
  type: 'single_select',
  required: false,
  defaultValue: null,
  options: ['A-01', 'A-02'],
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
};

const definitions = [orderField, itemField];

function orderColumn(
  field: TableTemplateColumn['field'],
  displayName = '列名',
): TableTemplateColumn {
  return { field, displayName };
}

function validOrderInput(): unknown {
  return {
    name: ' 待发货订单 ',
    granularity: 'order',
    columns: [
      orderColumn({ kind: 'builtin', key: 'order_number' }, ' 订单号 '),
      orderColumn({ kind: 'computed', key: 'order_total' }, '订单总额'),
      orderColumn({ kind: 'custom', definitionId: orderField.id }, '客服备注'),
    ],
    query: {
      text: '杯子',
      buyerText: '林',
      productText: '马克杯',
      dateField: 'paid_at',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-30',
      platform: 'xianyu',
      sellerAccount: '主账号',
      initialSourceRecognitionStatus: 'imported',
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      lifecycleStatus: 'active',
      sortField: 'amount',
      sortDirection: 'desc',
      customFieldFilter: {
        definitionId: orderField.id,
        value: ['加急', '易碎'],
      },
      customFieldSort: {
        definitionId: orderField.id,
        direction: 'asc',
      },
    },
  };
}

describe('表格模板核心契约', () => {
  it('按粒度公开稳定的系统、自定义和受控计算字段目录', () => {
    const orderFields = availableTableFields('order', definitions);
    expect(orderFields).toEqual(expect.arrayContaining([
      {
        reference: { kind: 'builtin', key: 'order_number' },
        defaultLabel: '订单号',
        valueType: 'text',
      },
      {
        reference: { kind: 'computed', key: 'item_quantity_total' },
        defaultLabel: '商品总数量',
        valueType: 'number',
      },
      {
        reference: { kind: 'computed', key: 'order_total' },
        defaultLabel: '订单总额',
        valueType: 'money',
      },
      {
        reference: { kind: 'custom', definitionId: orderField.id },
        defaultLabel: orderField.name,
        valueType: orderField.type,
      },
    ]));
    expect(orderFields.map(({ reference }) => fieldReferenceKey(reference)))
      .not.toContain(`custom:${itemField.id}`);

    const itemFields = availableTableFields('order_item', definitions);
    expect(itemFields.filter(({ reference }) => reference.kind !== 'custom')).toEqual([
      {
        reference: { kind: 'builtin', key: 'order_number' },
        defaultLabel: '订单号',
        valueType: 'text',
      },
      {
        reference: { kind: 'builtin', key: 'product_title' },
        defaultLabel: '原始商品标题',
        valueType: 'text',
      },
      {
        reference: { kind: 'builtin', key: 'product_spec' },
        defaultLabel: '原始款式／规格',
        valueType: 'text',
      },
      {
        reference: { kind: 'builtin', key: 'unit_price' },
        defaultLabel: '商品单价',
        valueType: 'money',
      },
      {
        reference: { kind: 'builtin', key: 'quantity' },
        defaultLabel: '数量',
        valueType: 'number',
      },
      {
        reference: { kind: 'builtin', key: 'quantity_source' },
        defaultLabel: '数量来源',
        valueType: 'text',
      },
      {
        reference: { kind: 'computed', key: 'item_subtotal' },
        defaultLabel: '商品小计',
        valueType: 'money',
      },
    ]);
    expect(itemFields).toContainEqual({
      reference: { kind: 'custom', definitionId: itemField.id },
      defaultLabel: itemField.name,
      valueType: itemField.type,
    });
    expect(itemFields.map(({ reference }) => fieldReferenceKey(reference)))
      .not.toContain(`custom:${orderField.id}`);
  });

  it('规范化完整订单模板并深拷贝查询快照', () => {
    const input = validOrderInput() as Record<string, unknown>;
    const normalized = normalizeCreateTableTemplateInput(input, definitions);

    expect(normalized.name).toBe('待发货订单');
    expect(normalized.granularity).toBe('order');
    expect(normalized.columns.map(({ displayName }) => displayName))
      .toEqual(['订单号', '订单总额', '客服备注']);
    expect(normalized.query).toEqual((input.query as Record<string, unknown>));
    expect(normalized.query).not.toBe(input.query);
    expect((normalized.query as { customFieldFilter?: unknown }).customFieldFilter)
      .not.toBe((input.query as { customFieldFilter?: unknown }).customFieldFilter);
    expect((normalized.query as { customFieldFilter?: { value?: unknown } }).customFieldFilter?.value)
      .not.toBe((input.query as { customFieldFilter?: { value?: unknown } }).customFieldFilter?.value);
  });

  it('规范化完整更新输入且要求稳定模板 id', () => {
    const { granularity: _granularity, ...input } = validOrderInput() as {
      granularity: string;
      name: string;
      columns: unknown[];
      query: object;
    };
    const normalized = normalizeUpdateTableTemplateInput(
      ' template-001 ',
      'order',
      input,
      definitions,
    );
    expect(normalized.name).toBe('待发货订单');

    expect(() => normalizeUpdateTableTemplateInput('   ', 'order', input, definitions))
      .toThrow(/模板 ID/);
  });

  it.each([
    ['没有列', { ...(validOrderInput() as object), columns: [] }, /至少选择一个字段/],
    ['空表头', {
      ...(validOrderInput() as object),
      columns: [orderColumn({ kind: 'builtin', key: 'order_number' }, '   ')],
    }, /显示名称不能为空/],
    ['重复字段', {
      ...(validOrderInput() as object),
      columns: [
        orderColumn({ kind: 'builtin', key: 'order_number' }, '订单号'),
        orderColumn({ kind: 'builtin', key: 'order_number' }, '平台单号'),
      ],
    }, /字段不能重复/],
    ['重复表头', {
      ...(validOrderInput() as object),
      columns: [
        orderColumn({ kind: 'builtin', key: 'order_number' }, '订单号'),
        orderColumn({ kind: 'builtin', key: 'platform' }, '订单号'),
      ],
    }, /显示名称不能重复/],
    ['未知系统字段', {
      ...(validOrderInput() as object),
      columns: [orderColumn({ kind: 'builtin', key: 'secret' } as never, '秘密')],
    }, /字段无效/],
    ['跨粒度系统字段', {
      ...(validOrderInput() as object),
      columns: [orderColumn({ kind: 'builtin', key: 'unit_price' }, '单价')],
    }, /字段无效/],
    ['跨粒度计算字段', {
      ...(validOrderInput() as object),
      columns: [orderColumn({ kind: 'computed', key: 'item_subtotal' }, '小计')],
    }, /字段无效/],
    ['跨粒度自定义字段', {
      ...(validOrderInput() as object),
      columns: [orderColumn({ kind: 'custom', definitionId: itemField.id }, '拣货位')],
    }, /数据粒度/],
    ['未知自定义字段', {
      ...(validOrderInput() as object),
      columns: [orderColumn({ kind: 'custom', definitionId: 'missing' }, '不存在')],
    }, /不存在/],
    ['公式字段入口', {
      ...(validOrderInput() as object),
      columns: [{
        field: { kind: 'computed', key: 'order_total', expression: 'amountCents * 100' },
        displayName: '危险公式',
      }],
    }, /未知属性/],
  ])('拒绝%s', (_label, input, expected) => {
    expect(() => normalizeCreateTableTemplateInput(input, definitions)).toThrow(expected);
  });

  it.each([
    ['模板未知属性', { ...(validOrderInput() as object), formula: '1 + 1' }],
    ['查询未知属性', {
      ...(validOrderInput() as object),
      query: { ...((validOrderInput() as { query: object }).query), pageSize: 100 },
    }],
    ['筛选未知属性', {
      ...(validOrderInput() as object),
      query: {
        customFieldFilter: { definitionId: orderField.id, value: 'A', expression: 'true' },
      },
    }],
    ['排序未知属性', {
      ...(validOrderInput() as object),
      query: { customFieldSort: { definitionId: orderField.id, direction: 'asc', nulls: 'first' } },
    }],
  ])('拒绝%s，核心模型不开放任意公式或透传配置', (_label, input) => {
    expect(() => normalizeCreateTableTemplateInput(input, definitions)).toThrow(/未知属性/);
  });

  it.each([
    ['非法粒度', { granularity: 'shipment' }],
    ['非法日期字段', { dateField: 'updated_at' }],
    ['非法日期', { dateFrom: '2026-02-30' }],
    ['颠倒日期范围', { dateFrom: '2026-07-30', dateTo: '2026-07-01' }],
    ['非法平台', { platform: 'taobao' }],
    ['非法识别状态', { initialSourceRecognitionStatus: 'done' }],
    ['非法交易状态', { platformTransactionStatus: 'completed' }],
    ['非法履约状态', { fulfillmentStatus: 'delivered' }],
    ['非法生命周期', { lifecycleStatus: 'archived' }],
    ['非法排序字段', { sortField: 'phone' }],
    ['非法排序方向', { sortDirection: 'sideways' }],
    ['非法筛选值', {
      customFieldFilter: { definitionId: orderField.id, value: { nested: true } },
    }],
    ['非法筛选字段 ID', {
      customFieldFilter: { definitionId: '   ', value: 'A' },
    }],
    ['非法自定义排序方向', {
      customFieldSort: { definitionId: orderField.id, direction: 'up' },
    }],
  ])('严格拒绝订单查询中的%s', (_label, patch) => {
    const base = validOrderInput() as { query: Record<string, unknown> };
    const input = 'granularity' in patch
      ? { ...base, ...patch }
      : { ...base, query: { ...base.query, ...patch } };
    expect(() => normalizeCreateTableTemplateInput(input, definitions)).toThrow();
  });

  it('商品模板查询只允许商品查询结构', () => {
    const input = {
      name: '拣货明细',
      granularity: 'order_item',
      columns: [orderColumn({ kind: 'builtin', key: 'product_title' }, '商品')],
      query: {
        sourceTitle: 'Ａ款海棠杯',
        sourceSpec: 'Ｌ码',
        customFieldFilter: { definitionId: itemField.id, value: 'A-01' },
        customFieldSort: { definitionId: itemField.id, direction: 'desc' },
      },
    };
    expect(normalizeCreateTableTemplateInput(input, definitions)).toEqual(input);
    expect(() => normalizeCreateTableTemplateInput({
      ...input,
      query: { text: '订单查询字段不能混入商品模板' },
    }, definitions)).toThrow(/未知属性/);
    expect(() => normalizeCreateTableTemplateInput({
      ...input,
      query: { quantitySource: 'unknown_source' },
    }, definitions)).toThrow(/数量来源/);
  });

  it('把订单字段投影为可复用的原始单元格值', () => {
    const order: OrderSummary = {
      id: 'order-1',
      platform: 'xianyu',
      sellerAccount: '主账号',
      orderNumber: 'XY-001',
      alipayTransactionNumber: 'ALI-XY-001',
      buyerNickname: '买***家',
      recipient: '林海棠',
      phone: '13800000001',
      addressOriginal: '广东省深圳市南山区海棠路1号',
      amountCents: 3_600,
      itemCount: 3,
      initialSourceRecognitionStatus: 'imported',
      platformTransactionStatus: 'paid',
      fulfillmentStatus: 'pending_shipment',
      lifecycleStatus: 'active',
      orderedAtNormalized: '2026-07-30T09:30:00+08:00',
      paidAtNormalized: '2026-07-30T09:31:00+08:00',
      createdAt: '2026-07-30T01:32:00.000Z',
      items: [
        { sourceTitle: '海棠杯', sourceSpec: '红色', quantity: 2 },
        { sourceTitle: '杯盖', sourceSpec: '', quantity: 1 },
      ],
    };
    const customValues: CustomFieldValueRecord[] = [{
      definitionId: orderField.id,
      orderId: order.id,
      orderItemId: null,
      value: '优先发货',
      createdAt: '2026-07-30T02:00:00.000Z',
      updatedAt: '2026-07-30T02:00:00.000Z',
    }];

    expect(projectOrderTableCell(order, { kind: 'builtin', key: 'order_number' }))
      .toBe('XY-001');
    expect(projectOrderTableCell(order, { kind: 'builtin', key: 'address' }))
      .toBe(order.addressOriginal);
    expect(projectOrderTableCell(order, { kind: 'builtin', key: 'product_summary' }))
      .toBe('海棠杯 · 红色 ×2；杯盖 ×1');
    expect(projectOrderTableCell(order, { kind: 'computed', key: 'item_quantity_total' }))
      .toBe(3);
    expect(projectOrderTableCell(order, { kind: 'computed', key: 'order_total' }))
      .toBe(3_600);
    expect(projectOrderTableCell(
      order,
      { kind: 'custom', definitionId: orderField.id },
      customValues,
    )).toBe('优先发货');
    expect(projectOrderTableCell(
      order,
      { kind: 'custom', definitionId: 'missing' },
      customValues,
    )).toBeNull();
  });

  it('把商品明细字段投影为可复用的原始单元格值', () => {
    const item: OrderItemWorkbenchItem & { orderNumber: string } = {
      id: 'item-1',
      orderId: 'order-1',
      orderNumber: 'XY-001',
      position: 0,
      sourceTitle: '海棠杯',
      sourceSpec: '红色',
      unitPriceCents: 1_800,
      quantity: 2,
      quantitySource: 'ocr_explicit',
      quantityInferred: false,
      subtotalCents: 3_600,
    };
    const customValues: CustomFieldValueRecord[] = [{
      definitionId: itemField.id,
      orderId: item.orderId,
      orderItemId: item.id,
      value: 'A-01',
      createdAt: '2026-07-30T02:00:00.000Z',
      updatedAt: '2026-07-30T02:00:00.000Z',
    }];

    expect(projectOrderItemTableCell(item, { kind: 'builtin', key: 'order_number' }))
      .toBe('XY-001');
    expect(projectOrderItemTableCell(item, { kind: 'builtin', key: 'unit_price' }))
      .toBe(1_800);
    const quantitySourceLabels: Array<[QuantitySource, string]> = [
      ['manual', '人工修改'],
      ['ocr_explicit', 'OCR 识别'],
      ['system_default_1', '系统默认 1'],
      ['legacy_explicit_or_manual', '已明确（历史来源不明）'],
    ];
    for (const [quantitySource, expected] of quantitySourceLabels) {
      expect(projectOrderItemTableCell(
        { ...item, quantitySource },
        { kind: 'builtin', key: 'quantity_source' },
      )).toBe(expected);
    }
    expect(projectOrderItemTableCell(item, { kind: 'computed', key: 'item_subtotal' }))
      .toBe(3_600);
    expect(projectOrderItemTableCell(
      item,
      { kind: 'custom', definitionId: itemField.id },
      customValues,
    )).toBe('A-01');
  });

  it('按所有者和字段定义建立索引，并保留数组投影调用兼容', () => {
    const otherOrderValue: CustomFieldValueRecord = {
      definitionId: orderField.id,
      orderId: 'order-2',
      orderItemId: null,
      value: '普通发货',
      createdAt: '2026-07-30T02:00:00.000Z',
      updatedAt: '2026-07-30T02:00:00.000Z',
    };
    const selectedOrderValue: CustomFieldValueRecord = {
      ...otherOrderValue,
      orderId: 'order-1',
      value: '优先发货',
    };
    const order = {
      id: 'order-1',
    } as OrderSummary;
    const values = [otherOrderValue, selectedOrderValue];
    const index = createCustomFieldValueIndex(values);

    expect(projectOrderTableCell(
      order,
      { kind: 'custom', definitionId: orderField.id },
      index,
    )).toBe('优先发货');
    expect(projectOrderTableCell(
      order,
      { kind: 'custom', definitionId: orderField.id },
      values,
    )).toBe('优先发货');
    expect(index.get('order-1')?.get(orderField.id)).toBe(selectedOrderValue);
  });

  it('模板名称唯一键统一全角、空白和大小写', () => {
    expect(tableTemplateNameKey(' ＤＡＩＬＹ ')).toBe('daily');
    expect(tableTemplateNameKey('Daily')).toBe(tableTemplateNameKey(' daily '));
  });
});
