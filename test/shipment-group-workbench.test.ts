import { describe, expect, it } from 'vitest';

import type { CustomFieldDefinition } from '../src/core/custom-fields';
import {
  buildShipmentGroupWorkbench,
  type OpenShipmentGroup,
  type ShipmentGroupCustomFieldValue,
} from '../src/core/shipment-groups';
import { projectShipmentGroupTableCell } from '../src/core/table-templates';

const zoneDefinition: CustomFieldDefinition = {
  id: 'field-zone',
  name: '拣货区域',
  granularity: 'shipment_group',
  type: 'single_select',
  required: false,
  defaultValue: null,
  options: ['东区', '西区'],
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
};

const noteDefinition: CustomFieldDefinition = {
  ...zoneDefinition,
  id: 'field-note',
  name: '打包备注',
  type: 'text',
  options: [],
};

const labelDefinition: CustomFieldDefinition = {
  ...zoneDefinition,
  id: 'field-labels',
  name: '打包标签',
  type: 'multi_select',
  options: ['易碎', '加急', '礼品'],
};

function group(input: {
  id: string;
  recipient: string;
  address: string;
  orderNumber: string;
  amountCents: number;
}): OpenShipmentGroup {
  return {
    id: input.id,
    formation: 'automatic',
    selectedRecipientOrderId: null,
    recipient: input.recipient,
    phone: '13800000001',
    phoneNormalized: '13800000001',
    addressOriginal: input.address,
    addressNormalized: input.address,
    recipients: [input.recipient],
    recipientConflict: false,
    orderCount: 1,
    totalQuantity: 2,
    totalAmountCents: input.amountCents,
    orders: [{
      id: `order-${input.id}`,
      orderNumber: input.orderNumber,
      sellerAccount: '主账号',
      buyerNickname: '买家',
      repurchaseRank: null,
      recipient: input.recipient,
      phone: '13800000001',
      phoneNormalized: '13800000001',
      addressOriginal: input.address,
      addressNormalized: input.address,
      amountCents: input.amountCents,
      items: [{
        id: `item-${input.id}`,
        sourceTitle: '白模鞋',
        sourceSpec: '05M',
        unitPriceCents: input.amountCents / 2,
        quantity: 2,
        subtotalCents: input.amountCents,
      }],
    }],
    items: [{
      title: '白模鞋',
      specification: '05M',
      quantity: 2,
      subtotalCents: input.amountCents,
      unitPricesCents: [input.amountCents / 2],
      orderIds: [`order-${input.id}`],
    }],
  };
}

describe('发货组工作台投影', () => {
  it('文本字段按包含筛选，多选字段按包含全部所选项筛选', () => {
    const target = group({
      id: 'group-filter-target',
      recipient: '刘环湘',
      address: '广东省惠州市惠城区水口街道1号',
      orderNumber: 'FILTER-001',
      amountCents: 1_200,
    });
    const values: ShipmentGroupCustomFieldValue[] = [
      { shipmentGroupId: target.id, definitionId: noteDefinition.id, value: '请使用加厚纸箱' },
      {
        shipmentGroupId: target.id,
        definitionId: labelDefinition.id,
        value: ['易碎', '加急'],
      },
    ];
    const projection = { groups: [target], attentionOrders: [] };

    expect(buildShipmentGroupWorkbench(
      projection,
      { customFieldFilter: { definitionId: noteDefinition.id, value: '加厚' } },
      [noteDefinition, labelDefinition],
      values,
    ).groups).toHaveLength(1);
    expect(buildShipmentGroupWorkbench(
      projection,
      { customFieldFilter: { definitionId: labelDefinition.id, value: ['易碎'] } },
      [noteDefinition, labelDefinition],
      values,
    ).groups).toHaveLength(1);
    expect(buildShipmentGroupWorkbench(
      projection,
      { customFieldFilter: { definitionId: labelDefinition.id, value: ['易碎', '礼品'] } },
      [noteDefinition, labelDefinition],
      values,
    ).groups).toEqual([]);
  });

  it('按成员订单与自定义字段筛选，并用发货组字段投影一行', () => {
    const east = group({
      id: 'group-east',
      recipient: '刘环湘',
      address: '广东省惠州市惠城区水口街道1号',
      orderNumber: 'A-002',
      amountCents: 1_200,
    });
    const west = group({
      id: 'group-west',
      recipient: '周宁',
      address: '广东省深圳市南山区2号',
      orderNumber: 'B-001',
      amountCents: 800,
    });
    const values: ShipmentGroupCustomFieldValue[] = [
      { shipmentGroupId: east.id, definitionId: zoneDefinition.id, value: '东区' },
      { shipmentGroupId: west.id, definitionId: zoneDefinition.id, value: '西区' },
    ];

    const result = buildShipmentGroupWorkbench(
      { groups: [west, east], attentionOrders: [] },
      {
        text: 'A-002',
        customFieldFilter: { definitionId: zoneDefinition.id, value: '东区' },
        sortField: 'total_amount',
        sortDirection: 'desc',
      },
      [zoneDefinition],
      values,
    );

    expect(result.allGroupCount).toBe(2);
    expect(result.groups.map(({ id }) => id)).toEqual(['group-east']);
    expect(result.customFieldValues).toEqual([values[0]]);
    expect(projectShipmentGroupTableCell(
      east,
      { kind: 'builtin', key: 'member_order_numbers' },
      values,
    )).toBe('A-002');
    expect(projectShipmentGroupTableCell(
      east,
      { kind: 'computed', key: 'shipment_group_total_amount' },
      values,
    )).toBe(1_200);
    expect(projectShipmentGroupTableCell(
      east,
      { kind: 'custom', definitionId: zoneDefinition.id },
      values,
    )).toBe('东区');
  });

  it('按受控汇总字段或组级自定义字段排序', () => {
    const east = group({
      id: 'group-east',
      recipient: '刘环湘',
      address: '广东省惠州市惠城区水口街道1号',
      orderNumber: 'A-002',
      amountCents: 1_200,
    });
    const west = group({
      id: 'group-west',
      recipient: '周宁',
      address: '广东省深圳市南山区2号',
      orderNumber: 'B-001',
      amountCents: 800,
    });
    const values: ShipmentGroupCustomFieldValue[] = [
      { shipmentGroupId: east.id, definitionId: zoneDefinition.id, value: '东区' },
      { shipmentGroupId: west.id, definitionId: zoneDefinition.id, value: '西区' },
    ];

    expect(buildShipmentGroupWorkbench(
      { groups: [west, east], attentionOrders: [] },
      { sortField: 'total_amount', sortDirection: 'desc' },
      [zoneDefinition],
      values,
    ).groups.map(({ id }) => id)).toEqual(['group-east', 'group-west']);
    expect(buildShipmentGroupWorkbench(
      { groups: [west, east], attentionOrders: [] },
      {
        customFieldSort: { definitionId: zoneDefinition.id, direction: 'asc' },
      },
      [zoneDefinition],
      values,
    ).groups.map(({ id }) => id)).toEqual(['group-east', 'group-west']);
  });
});
