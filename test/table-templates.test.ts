import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Recognizer } from '../src/core/contracts';
import { LocalApplication } from '../src/main/local-application';

const applications: LocalApplication[] = [];
const unusedRecognizer: Recognizer = {
  recognize: async () => {
    throw new Error('本测试不应调用 OCR');
  },
};

afterEach(() => {
  for (const application of applications.splice(0)) application.close();
});

async function openApplication(): Promise<{
  application: LocalApplication;
  dataDirectory: string;
}> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'xianyu-table-templates-'));
  const application = new LocalApplication(unusedRecognizer);
  applications.push(application);
  application.openDataDirectory(dataDirectory);
  return { application, dataDirectory };
}

function closeApplication(application: LocalApplication): void {
  application.close();
  applications.splice(applications.indexOf(application), 1);
}

describe('多套表格模板', () => {
  it('按粒度保存多套命名模板，并在关闭数据目录后完整恢复列、别名、顺序、筛选和排序', async () => {
    const { application, dataDirectory } = await openApplication();
    const priority = application.createCustomFieldDefinition({
      name: '拣货优先级',
      granularity: 'order',
      type: 'single_select',
      required: false,
      defaultValue: null,
      options: ['普通', '加急'],
    });
    const bin = application.createCustomFieldDefinition({
      name: '货位',
      granularity: 'order_item',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });

    const picking = application.createTableTemplate({
      name: ' 待发货拣货 ',
      granularity: 'order',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '单号' },
        { field: { kind: 'custom', definitionId: priority.id }, displayName: '优先级' },
        { field: { kind: 'computed', key: 'item_quantity_total' }, displayName: '总件数' },
        { field: { kind: 'computed', key: 'order_total' }, displayName: '实付' },
      ],
      query: {
        dateField: 'ordered_at',
        lifecycleStatus: 'active',
        fulfillmentStatus: 'pending_shipment',
        sortField: 'amount',
        sortDirection: 'desc',
        customFieldFilter: { definitionId: priority.id, value: '加急' },
      },
    });
    const finance = application.createTableTemplate({
      name: '财务核对',
      granularity: 'order',
      columns: [
        { field: { kind: 'computed', key: 'order_total' }, displayName: '成交金额' },
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '平台订单号' },
      ],
      query: {
        dateField: 'paid_at',
        lifecycleStatus: 'all',
        sortField: 'paid_at',
        sortDirection: 'asc',
      },
    });
    const itemTemplate = application.createTableTemplate({
      name: '待发货拣货',
      granularity: 'order_item',
      columns: [
        { field: { kind: 'builtin', key: 'product_title' }, displayName: '商品' },
        { field: { kind: 'custom', definitionId: bin.id }, displayName: '拣货位' },
        { field: { kind: 'computed', key: 'item_subtotal' }, displayName: '小计' },
      ],
      query: {
        customFieldSort: { definitionId: bin.id, direction: 'asc' },
      },
    });

    expect(picking.name).toBe('待发货拣货');
    expect(finance.id).not.toBe(picking.id);
    expect(itemTemplate.name).toBe(picking.name);
    expect(application.listTableTemplates()).toHaveLength(3);

    const updatedFinance = application.updateTableTemplate(finance.id, {
      name: '财务复核',
      columns: [
        { field: { kind: 'builtin', key: 'seller_account' }, displayName: '账号' },
        { field: { kind: 'computed', key: 'order_total' }, displayName: '实收' },
      ],
      query: {
        dateField: 'paid_at',
        lifecycleStatus: 'active',
        sortField: 'amount',
        sortDirection: 'desc',
      },
    });
    expect(updatedFinance).toMatchObject({
      id: finance.id,
      granularity: 'order',
      name: '财务复核',
    });

    const beforeRestart = application.listTableTemplates();
    closeApplication(application);
    const reopened = new LocalApplication(unusedRecognizer);
    applications.push(reopened);
    reopened.openDataDirectory(dataDirectory);

    expect(reopened.listTableTemplates()).toEqual(beforeRestart);
    expect(reopened.listTableTemplates('order')).toHaveLength(2);
    expect(reopened.listTableTemplates('order_item')).toEqual([itemTemplate]);

    reopened.deleteTableTemplate(picking.id);
    expect(reopened.listTableTemplates().map((template) => template.id).sort()).toEqual([
      updatedFinance.id,
      itemTemplate.id,
    ].sort());
  });

  it('原子拒绝空列、重复字段、跨粒度引用和任意公式输入', async () => {
    const { application } = await openApplication();
    const itemField = application.createCustomFieldDefinition({
      name: '商品备注',
      granularity: 'order_item',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    const validBase = {
      name: '非法输入不会落库',
      granularity: 'order' as const,
      query: {
        dateField: 'ordered_at' as const,
        lifecycleStatus: 'active' as const,
        sortField: 'created_at' as const,
        sortDirection: 'desc' as const,
      },
    };

    const invalidInputs: unknown[] = [
      { ...validBase, columns: [] },
      {
        ...validBase,
        columns: [
          { field: { kind: 'builtin', key: 'order_number' }, displayName: '单号' },
          { field: { kind: 'builtin', key: 'order_number' }, displayName: '重复单号' },
        ],
      },
      {
        ...validBase,
        columns: [{
          field: { kind: 'custom', definitionId: itemField.id },
          displayName: '跨粒度字段',
        }],
      },
      {
        ...validBase,
        columns: [{
          field: { kind: 'computed', key: 'item_subtotal' },
          displayName: '跨粒度计算',
        }],
      },
      {
        ...validBase,
        columns: [{
          field: { kind: 'formula', expression: 'SUM(amount)' },
          displayName: '任意公式',
        }],
      },
      {
        ...validBase,
        columns: [{
          field: { kind: 'computed', key: 'unknown_total' },
          displayName: '未知计算',
        }],
      },
      {
        ...validBase,
        columns: [{ field: { kind: 'builtin', key: 'order_number' }, displayName: '单号' }],
        query: {
          ...validBase.query,
          customFieldFilter: { definitionId: itemField.id, value: '错误粒度' },
        },
      },
    ];

    for (const input of invalidInputs) {
      expect(() => application.createTableTemplate(input as never)).toThrow();
    }
    expect(application.listTableTemplates()).toEqual([]);

    application.createTableTemplate({
      ...validBase,
      name: 'Daily',
      columns: [{ field: { kind: 'builtin', key: 'order_number' }, displayName: '单号' }],
    });
    expect(() => application.createTableTemplate({
      ...validBase,
      name: ' daily ',
      columns: [{ field: { kind: 'builtin', key: 'seller_account' }, displayName: '账号' }],
    })).toThrow();
    expect(application.listTableTemplates()).toHaveLength(1);
  });
});
