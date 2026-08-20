import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  RecognitionAttempt,
  RecognitionResult,
  Recognizer,
  RecognizerSource,
} from '../src/core/contracts';
import { normalizeShipmentGroupExportInput } from '../src/core/shipment-group-export';
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
    sellerAccount: '发货表测试账号',
    orderNumber,
    alipayTransactionNumber: `ALI-${orderNumber}`,
    buyerNickname: '测试买家',
    recipient: '刘测试',
    phone: '13800000001',
    phoneNormalized: '13800000001',
    addressOriginal: '广东省惠州市惠城区测试路1号',
    addressNormalized: '广东省惠州市惠城区测试路1号',
    province: '广东省',
    city: '惠州市',
    district: '惠城区',
    orderedAtOriginal: '2026-08-14 09:00:00',
    orderedAtNormalized: '2026-08-14T09:00:00+08:00',
    paidAtOriginal: '2026-08-14 09:00:08',
    paidAtNormalized: '2026-08-14T09:00:08+08:00',
    productTotalCents: 600,
    shippingFeeCents: 0,
    amountCents: 600,
    platformTransactionStatus: 'paid',
    fulfillmentStatus: 'pending_shipment',
    items: [{
      sourceTitle: '白模鞋',
      sourceSpec: '05M',
      unitPriceCents: 300,
      quantity: 2,
      quantityInferred: false,
    }],
    ...overrides,
  };
}

async function openApplication(): Promise<{
  application: LocalApplication;
  dataDirectory: string;
}> {
  return openApplicationWithResults([
    recognition('XY-GROUP-0001'),
    recognition('XY-GROUP-0002'),
  ]);
}

async function openApplicationWithResults(results: RecognitionResult[]): Promise<{
  application: LocalApplication;
  dataDirectory: string;
}> {
  const incremental = await openIncrementalApplication(results);
  for (const _result of results) await incremental.confirmNextOrder();
  return {
    application: incremental.application,
    dataDirectory: incremental.dataDirectory,
  };
}

async function openIncrementalApplication(results: RecognitionResult[]): Promise<{
  application: LocalApplication;
  dataDirectory: string;
  confirmNextOrder: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'xianyu-shipment-group-template-'));
  const dataDirectory = join(root, '数据');
  const uploadDirectory = join(root, '上传');
  await mkdir(uploadDirectory, { recursive: true });
  const application = new LocalApplication(new SequenceRecognizer([...results]));
  openedApplications.push(application);
  application.openDataDirectory(dataDirectory);
  let nextIndex = 0;
  return {
    application,
    dataDirectory,
    confirmNextOrder: async () => {
      const index = nextIndex;
      if (index >= results.length) throw new Error('测试订单已用尽');
      nextIndex += 1;
      const sourcePath = join(uploadDirectory, `订单-${index + 1}.png`);
      await writeFile(sourcePath, Buffer.from(`shipment-group-template-${index + 1}`));
      const batch = await application.submitRecognitionBatch([sourcePath]);
      application.confirmDraft(batch.drafts[0]);
    },
  };
}

afterEach(() => {
  for (const application of openedApplications.splice(0)) application.close();
});

describe('发货组字段与模板持久化', () => {
  it('保存组级字段后可筛选，模板与字段值在重启后保持', async () => {
    const { application, dataDirectory } = await openApplication();
    const zone = application.createCustomFieldDefinition({
      name: '拣货区域',
      granularity: 'shipment_group',
      type: 'single_select',
      required: true,
      defaultValue: null,
      options: ['东区', '西区'],
    });
    const initial = application.queryShipmentGroupWorkbench({}, [zone.id]);
    const shipmentGroup = initial.groups[0];

    expect(initial.groups).toHaveLength(1);
    expect(initial.customFieldValues).toEqual([]);

    application.saveShipmentGroupCustomFieldValues({
      shipmentGroupId: shipmentGroup.id,
      expectedMemberOrderIds: shipmentGroup.orders.map(({ id }) => id),
      values: [{ definitionId: zone.id, value: '东区' }],
    });
    const template = application.createTableTemplate({
      name: '东区合并拣货表',
      granularity: 'shipment_group',
      columns: [
        { field: { kind: 'builtin', key: 'member_order_numbers' }, displayName: '订单集合' },
        { field: { kind: 'custom', definitionId: zone.id }, displayName: '拣货区' },
        {
          field: { kind: 'computed', key: 'shipment_group_total_quantity' },
          displayName: '总件数',
        },
      ],
      query: {
        customFieldFilter: { definitionId: zone.id, value: '东区' },
        sortField: 'total_quantity',
        sortDirection: 'desc',
      },
    });
    const filtered = application.queryShipmentGroupWorkbench(template.query, [zone.id]);

    expect(filtered.groups.map(({ id }) => id)).toEqual([shipmentGroup.id]);
    expect(filtered.customFieldValues).toEqual([{
      shipmentGroupId: shipmentGroup.id,
      definitionId: zone.id,
      value: '东区',
    }]);

    application.close();
    openedApplications.splice(openedApplications.indexOf(application), 1);
    const reopened = new LocalApplication({
      recognize: async () => {
        throw new Error('重启持久性测试不应调用 OCR');
      },
    });
    openedApplications.push(reopened);
    reopened.openDataDirectory(dataDirectory);

    expect(reopened.listTableTemplates('shipment_group')).toEqual([template]);
    expect(reopened.queryShipmentGroupWorkbench(template.query, [zone.id]))
      .toMatchObject({
        groups: [{ id: shipmentGroup.id }],
        customFieldValues: [{
          shipmentGroupId: shipmentGroup.id,
          definitionId: zone.id,
          value: '东区',
        }],
      });
  });

  it('按三种粒度模板导出并重新读取三张工作表', async () => {
    const { application, dataDirectory } = await openApplication();
    const group = application.queryShipmentGroups().groups[0];
    const zone = application.createCustomFieldDefinition({
      name: '拣货区域',
      granularity: 'shipment_group',
      type: 'single_select',
      required: false,
      defaultValue: null,
      options: ['东区', '西区'],
    });
    application.saveShipmentGroupCustomFieldValues({
      shipmentGroupId: group.id,
      expectedMemberOrderIds: group.orders.map(({ id }) => id),
      values: [{ definitionId: zone.id, value: '东区' }],
    });
    const orderTemplate = application.createTableTemplate({
      name: '发货订单总表',
      granularity: 'order',
      columns: [
        { field: { kind: 'builtin', key: 'system_order_number' }, displayName: '系统编号' },
        { field: { kind: 'builtin', key: 'recipient' }, displayName: '订单收件人' },
      ],
      query: {},
    });
    const itemTemplate = application.createTableTemplate({
      name: '发货订单商品',
      granularity: 'order_item',
      columns: [
        { field: { kind: 'builtin', key: 'order_number' }, displayName: '平台订单号' },
        { field: { kind: 'builtin', key: 'product_title' }, displayName: '商品' },
        { field: { kind: 'builtin', key: 'quantity' }, displayName: '件数' },
      ],
      query: {},
    });
    const groupTemplate = application.createTableTemplate({
      name: '合并拣货表',
      granularity: 'shipment_group',
      columns: [
        { field: { kind: 'builtin', key: 'member_order_numbers' }, displayName: '订单集合' },
        { field: { kind: 'builtin', key: 'recipient' }, displayName: '最终收件人' },
        { field: { kind: 'builtin', key: 'product_summary' }, displayName: '合并商品' },
        { field: { kind: 'custom', definitionId: zone.id }, displayName: '拣货区' },
        {
          field: { kind: 'computed', key: 'shipment_group_total_quantity' },
          displayName: '合计件数',
        },
      ],
      query: {},
    });
    const input = {
      shipmentGroups: [{
        id: group.id,
        expectedMemberOrderIds: group.orders.map(({ id }) => id),
      }],
      orderTemplateId: orderTemplate.id,
      orderItemTemplateId: itemTemplate.id,
      shipmentGroupTemplateId: groupTemplate.id,
    };

    const preview = application.previewShipmentGroupExport(input);
    expect(preview).toMatchObject({
      shipmentGroupCount: 1,
      orderCount: 2,
      orderItemCount: 2,
      sheets: [
        { name: '订单总表', totalRowCount: 2 },
        { name: '订单商品明细表', totalRowCount: 2 },
        { name: '合并发货表', totalRowCount: 1 },
      ],
    });
    expect(preview.sheets[2].rows).toHaveLength(1);

    const destinationPath = join(dataDirectory, '三表导出.xlsx');
    await application.exportShipmentGroupsToWorkbook(input, destinationPath);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(destinationPath);
    expect(workbook.worksheets.map(({ name }) => name)).toEqual([
      '订单总表',
      '订单商品明细表',
      '合并发货表',
    ]);
    const groupSheet = workbook.getWorksheet('合并发货表');
    if (!groupSheet) throw new Error('缺少合并发货表');
    expect(groupSheet.rowCount).toBe(2);
    expect(groupSheet.getRow(1).values).toEqual([
      undefined,
      '订单集合',
      '最终收件人',
      '合并商品',
      '拣货区',
      '合计件数',
    ]);
    expect(groupSheet.getRow(2).values).toEqual([
      undefined,
      'XY-GROUP-0001；XY-GROUP-0002',
      '刘**',
      '白模鞋 · 05M ×4',
      '东区',
      4,
    ]);
  });

  it('收件人存在歧义且未确认最终值时禁止导出', async () => {
    const { application } = await openApplicationWithResults([
      recognition('XY-AMBIGUOUS-0001'),
      recognition('XY-AMBIGUOUS-0002', { recipient: '陈海棠' }),
    ]);
    const group = application.queryShipmentGroups().groups[0];

    expect(group).toMatchObject({ recipientConflict: true, selectedRecipientOrderId: null });
    expect(() => application.previewShipmentGroupExport({
      shipmentGroups: [{
        id: group.id,
        expectedMemberOrderIds: group.orders.map(({ id }) => id),
      }],
      orderTemplateId: null,
      orderItemTemplateId: null,
      shipmentGroupTemplateId: null,
    })).toThrow('请先确认最终收件人再导出');
  });

  it('预览后发货组增加成员时拒绝静默扩大导出范围', async () => {
    const { application, confirmNextOrder } = await openIncrementalApplication([
      recognition('XY-EXPORT-SCOPE-0001'),
      recognition('XY-EXPORT-SCOPE-0002'),
      recognition('XY-EXPORT-SCOPE-0003'),
    ]);
    await confirmNextOrder();
    await confirmNextOrder();
    const group = application.queryShipmentGroups().groups[0];
    const input = {
      shipmentGroups: [{
        id: group.id,
        expectedMemberOrderIds: group.orders.map(({ id }) => id),
      }],
      orderTemplateId: null,
      orderItemTemplateId: null,
      shipmentGroupTemplateId: null,
    };

    expect(application.previewShipmentGroupExport(input).orderCount).toBe(2);
    await confirmNextOrder();
    expect(application.queryShipmentGroups().groups[0]).toMatchObject({
      id: group.id,
      orderCount: 3,
    });
    expect(() => application.previewShipmentGroupExport(input))
      .toThrow('发货组成员已变化');
  });

  it('受控导出边界拒绝超过一万笔的嵌套成员快照', () => {
    expect(() => normalizeShipmentGroupExportInput({
      shipmentGroups: [
        {
          id: 'group-a',
          expectedMemberOrderIds: Array.from({ length: 5_001 }, (_, index) => `a-${index}`),
        },
        {
          id: 'group-b',
          expectedMemberOrderIds: Array.from({ length: 5_000 }, (_, index) => `b-${index}`),
        },
      ],
      orderTemplateId: null,
      orderItemTemplateId: null,
      shipmentGroupTemplateId: null,
    })).toThrow('一次最多导出 10000 笔发货组成员订单');
  });

  it('同一买家的新发货轮次不继承已完成组的自定义值', async () => {
    const { application, dataDirectory, confirmNextOrder } = await openIncrementalApplication([
      recognition('XY-GROUP-LIFECYCLE-0001'),
      recognition('XY-GROUP-LIFECYCLE-0002'),
    ]);
    await confirmNextOrder();
    const firstGroup = application.queryShipmentGroups().groups[0];
    const zone = application.createCustomFieldDefinition({
      name: '拣货区域',
      granularity: 'shipment_group',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    application.saveShipmentGroupCustomFieldValues({
      shipmentGroupId: firstGroup.id,
      expectedMemberOrderIds: firstGroup.orders.map(({ id }) => id),
      values: [{ definitionId: zone.id, value: '东区' }],
    });
    const allItems = firstGroup.orders.flatMap((order) => order.items.map((item) => ({
      orderId: order.id,
      orderItemId: item.id,
      quantity: item.quantity,
    })));
    application.confirmShipment({
      groupId: firstGroup.id,
      expectedRemainingItems: allItems,
      packages: [{
        shippingCarrier: '顺丰速运',
        trackingNumber: 'SF-GROUP-LIFECYCLE-1',
        items: allItems,
      }],
    });
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    try {
      const row = database.prepare(`
        SELECT COUNT(*) AS count
        FROM shipment_group_custom_field_values
        WHERE shipment_group_id = ?
      `).get(firstGroup.id) as { count: number };
      expect(row.count).toBe(0);
    } finally {
      database.close();
    }

    await confirmNextOrder();
    const secondGroup = application.queryShipmentGroups().groups[0];
    expect(secondGroup.id).not.toBe(firstGroup.id);
    expect(application.queryShipmentGroupWorkbench({}, [zone.id]).customFieldValues).toEqual([]);
  });

  it('拆分组与失效组字段清理在同一事务失败时全部回滚', async () => {
    const { application, dataDirectory } = await openApplication();
    const group = application.queryShipmentGroups().groups[0];
    const field = application.createCustomFieldDefinition({
      name: '分拣备注',
      granularity: 'shipment_group',
      type: 'text',
      required: false,
      defaultValue: null,
      options: [],
    });
    application.saveShipmentGroupCustomFieldValues({
      shipmentGroupId: group.id,
      expectedMemberOrderIds: group.orders.map(({ id }) => id),
      values: [{ definitionId: field.id, value: '保持事务一致' }],
    });
    const database = new DatabaseSync(join(dataDirectory, 'xianyu-order-manager.sqlite3'));
    database.exec(`
      CREATE TRIGGER test_reject_shipment_group_value_cleanup
      BEFORE DELETE ON shipment_group_custom_field_values
      BEGIN
        SELECT RAISE(ABORT, 'injected shipment group cleanup failure');
      END;
    `);
    try {
      expect(() => application.splitShipmentGroup({
        groupId: group.id,
        expectedMemberOrderIds: group.orders.map(({ id }) => id),
        splitOrderIds: [group.orders[0].id],
        reason: '测试原子回滚',
      })).toThrow('injected shipment group cleanup failure');
    } finally {
      database.exec('DROP TRIGGER test_reject_shipment_group_value_cleanup');
      database.close();
    }

    expect(application.listShipmentGroupAdjustmentEvents()).toEqual([]);
    expect(application.queryShipmentGroups().groups).toEqual([group]);
    expect(application.queryShipmentGroupWorkbench({}, [field.id]).customFieldValues)
      .toEqual([expect.objectContaining({
        shipmentGroupId: group.id,
        definitionId: field.id,
        value: '保持事务一致',
      })]);
  });

  it('跨地址手工组的脱敏地址使用最终收货信息所在地区', async () => {
    const { application } = await openApplicationWithResults([
      recognition('XY-GROUP-ADDRESS-0001'),
      recognition('XY-GROUP-ADDRESS-0002', {
        recipient: '周宁',
        phone: '13900000002',
        phoneNormalized: '13900000002',
        addressOriginal: '广东省深圳市福田区新风路2号',
        addressNormalized: '广东省深圳市福田区新风路2号',
        province: '广东省',
        city: '深圳市',
        district: '福田区',
      }),
    ]);
    const before = application.queryShipmentGroups();
    const selectedOrder = before.groups.find(({ addressOriginal }) => (
      addressOriginal.includes('福田区')
    ))?.orders[0];
    if (!selectedOrder) throw new Error('测试最终收货信息不存在');
    const merged = application.mergeShipmentGroups({
      groupIds: before.groups.map(({ id }) => id),
      expectedMemberOrderIds: before.groups.flatMap((group) => group.orders.map(({ id }) => id)),
      selectedRecipientOrderId: selectedOrder.id,
      reason: '合并打包',
    }).projection.groups[0];
    const template = application.createTableTemplate({
      name: '最终收货地址',
      granularity: 'shipment_group',
      columns: [{ field: { kind: 'builtin', key: 'address' }, displayName: '最终收货地址' }],
      query: {},
    });

    const preview = application.previewShipmentGroupExport({
      shipmentGroups: [{
        id: merged.id,
        expectedMemberOrderIds: merged.orders.map(({ id }) => id),
      }],
      orderTemplateId: null,
      orderItemTemplateId: null,
      shipmentGroupTemplateId: template.id,
    });
    expect(preview.sheets[2].rows).toEqual([['广东省深圳市福田区***']]);
  });
});
